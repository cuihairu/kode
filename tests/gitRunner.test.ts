import { describe, expect, it, vi } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'child_process';
import { tmpdir } from 'node:os';
import {
  defaultGitExecutorDeps,
  READONLY_GIT_SUBCOMMANDS,
  runGitReadOnly,
  validateGitArgs,
  type GitCancellationToken,
  type GitChildProcess,
  type GitExecutorDeps,
} from '../src/gitRunner';

/**
 * IDE-GIT-003:可取消且有界的只读 Git 执行器。
 * 验收:参数数组 + 明确 cwd + 路径边界(空格/中文/特殊文件名不变成命令);
 * 超时/取消/输出超限均终止子进程并释放资源;无阻塞式进程调用。
 *
 * 测试替身:内存假子进程(stdout/stderr 数据、close 码、error、kill 记录)+
 * 注入式定时器(记录超时回调与清除),另用真实 git 做两个冒烟(version /
 * 中文+空格文件名 ls-files 往返)。
 */

// ---------- 假子进程与假流 ----------

interface FakeStream {
  emit(chunk: Buffer | string): void;
  close(): void;
  on(event: string, listener: (chunk: Buffer | string) => void): void;
}

function makeStream(): FakeStream {
  const listeners: Array<(chunk: Buffer | string) => void> = [];
  return {
    on(_event: string, listener: (chunk: Buffer | string) => void) {
      listeners.push(listener);
    },
    emit(chunk: Buffer | string) {
      for (const l of listeners) l(chunk);
    },
    close() {
      for (const l of listeners) l(null as unknown as Buffer);
    },
  };
}

interface FakeChildOptions {
  stdoutData?: string;
  stderrData?: string;
  exitCode?: number | null;
  exitSignal?: string | null;
  autoClose?: boolean; // spawn 后下一拍发 close(code/signal)
  error?: Error;
}

function makeChild(opts: FakeChildOptions) {
  const stdout = makeStream();
  const stderr = makeStream();
  const closeListeners: Array<(code: number | null, signal: string | null) => void> = [];
  const errorListeners: Array<(err: Error) => void> = [];
  const child: GitChildProcess = {
    stdout,
    stderr,
    kill: vi.fn((_signal?: string) => true),
    on(event: string, listener: unknown) {
      if (event === 'close') closeListeners.push(listener as (code: number | null, signal: string | null) => void);
      if (event === 'error') errorListeners.push(listener as (err: Error) => void);
    },
  };
  // spawn 之后下一拍再发事件(模拟真实子进程异步性)
  setTimeout(() => {
    if (opts.error) {
      for (const l of errorListeners) l(opts.error);
      return;
    }
    if (opts.stdoutData) stdout.emit(opts.stdoutData);
    if (opts.stderrData) stderr.emit(opts.stderrData);
    if (opts.autoClose) for (const l of closeListeners) l(opts.exitCode ?? 0, opts.exitSignal ?? null);
  }, 0);
  return { child, stdout, stderr, close: (code: number | null, signal: string | null) => { for (const l of closeListeners) l(code, signal); } };
}

function makeDeps(child: GitChildProcess) {
  const timeouts: Array<() => void> = [];
  const cleared: unknown[] = [];
  const deps: GitExecutorDeps = {
    spawn: vi.fn(() => child),
    setTimeout: vi.fn((handler: () => void) => {
      timeouts.push(handler);
      return timeouts.length;
    }),
    clearTimeout: vi.fn((handle: unknown) => cleared.push(handle)),
  };
  return { deps, spawn: deps.spawn as ReturnType<typeof vi.fn>, timeouts, cleared };
}

const BASE_OPTS = { cwd: '/repo', timeoutMs: 5000, maxOutputBytes: 65536 };

// ---------- 参数数组 / 无 shell / 明确 cwd ----------

describe('IDE-GIT-003 参数数组与明确 cwd', () => {
  it('参数数组原样传递,无 shell,显式 cwd', async () => {
    const { child } = makeChild({ stdoutData: 'a\nb\n', autoClose: true, exitCode: 0 });
    const { deps, spawn } = makeDeps(child);
    const r = await runGitReadOnly(['log', '--', 'src/a.py'], BASE_OPTS, deps);
    expect(r).toEqual({ kind: 'ok', stdout: 'a\nb\n', stderr: '' });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith('git', ['log', '--', 'src/a.py'], { cwd: '/repo' });
    expect(spawn.mock.calls[0][2]).not.toHaveProperty('shell');
  });

  it('空格/中文/引号文件名逐字传递,不拆成命令', async () => {
    const odd = ['文件 名 (1).py', "it's a \"quoted\".py", 'a;b|c&d.py'];
    const { child } = makeChild({ autoClose: true, exitCode: 0 });
    const { deps, spawn } = makeDeps(child);
    const r = await runGitReadOnly(['log', '--', ...odd], BASE_OPTS, deps);
    expect(r.kind).toBe('ok');
    expect(spawn.mock.calls[0][1]).toEqual(['log', '--', ...odd]);
  });
});

// ---------- 只读白名单 ----------

describe('IDE-GIT-003 只读白名单', () => {
  it('拒绝写子命令(commit/push/reset/checkout),不启动进程', async () => {
    const { child } = makeChild({ autoClose: true, exitCode: 0 });
    const { deps, spawn } = makeDeps(child);
    for (const bad of ['commit', 'push', 'reset', 'checkout', 'branch', 'rebase']) {
      const r = await runGitReadOnly([bad, '--', 'x'], BASE_OPTS, deps);
      expect(r.kind).toBe('invalid-args');
      expect((r as { reason: string }).reason).toContain(bad);
    }
    expect(spawn).not.toHaveBeenCalled();
  });

  it('全局选项不得占据子命令位', async () => {
    const { child } = makeChild({ autoClose: true, exitCode: 0 });
    const { deps, spawn } = makeDeps(child);
    const r = await runGitReadOnly(['-c', 'core.fsmonitor=x', 'log'], BASE_OPTS, deps);
    expect(r.kind).toBe('invalid-args');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('外联执行选项被禁止(--ext-diff/--textconv/--upload-pack)', async () => {
    const { child } = makeChild({ autoClose: true, exitCode: 0 });
    const { deps, spawn } = makeDeps(child);
    for (const flag of ['--ext-diff', '--textconv', '--upload-pack=git@evil', '--receive-pack=x']) {
      const r = await runGitReadOnly(['log', flag], BASE_OPTS, deps);
      expect(r.kind).toBe('invalid-args');
    }
    expect(spawn).not.toHaveBeenCalled();
  });
});

// ---------- 路径边界 ----------

describe('IDE-GIT-003 路径边界', () => {
  it('`..` 越界逃出 cwd 的路径被拒,不启动进程', async () => {
    const { child } = makeChild({ autoClose: true, exitCode: 0 });
    const { deps, spawn } = makeDeps(child);
    const r = await runGitReadOnly(['log', '--', '../outside.py'], BASE_OPTS, deps);
    expect(r.kind).toBe('invalid-args');
    expect((r as { reason: string }).reason).toContain('越界');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('cwd 之外的绝对路径被拒', async () => {
    const { child } = makeChild({ autoClose: true, exitCode: 0 });
    const { deps, spawn } = makeDeps(child);
    const r = await runGitReadOnly(['diff', '--', '/etc/passwd'], BASE_OPTS, deps);
    expect(r.kind).toBe('invalid-args');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('cwd 内的绝对路径放行', async () => {
    const { child } = makeChild({ autoClose: true, exitCode: 0 });
    const { deps, spawn } = makeDeps(child);
    const r = await runGitReadOnly(['log', '--', join('/repo', 'in.py')], BASE_OPTS, deps);
    expect(r.kind).toBe('ok');
    expect(spawn).toHaveBeenCalledWith('git', ['log', '--', join('/repo', 'in.py')], { cwd: '/repo' });
  });
});

// ---------- 超时 / 取消 / 输出超限 ----------

describe('IDE-GIT-003 有界与取消', () => {
  it('超时终止子进程并释放定时器', async () => {
    const { child } = makeChild({}); // 永不 exit
    const { deps, timeouts, cleared } = makeDeps(child);
    const p = runGitReadOnly(['log'], { cwd: '/repo', timeoutMs: 25, maxOutputBytes: 65536 }, deps);
    // 手动触发注入的超时回调
    await new Promise<void>((res) => setImmediate(res));
    expect(timeouts.length).toBe(1);
    timeouts[0]();
    const r = await p;
    expect(r).toEqual({ kind: 'timeout', timeoutMs: 25 });
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(cleared.length).toBe(1);
  });

  it('预取消:不启动进程', async () => {
    const { child } = makeChild({ autoClose: true, exitCode: 0 });
    const { deps, spawn } = makeDeps(child);
    const token: GitCancellationToken = { isCancellationRequested: true };
    const r = await runGitReadOnly(['log'], { ...BASE_OPTS, token }, deps);
    expect(r).toEqual({ kind: 'cancelled' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('运行中取消:终止子进程', async () => {
    const { child } = makeChild({}); // 永不 exit
    const { deps, spawn } = makeDeps(child);
    let fire: (() => void) | undefined;
    const token: GitCancellationToken = {
      isCancellationRequested: false,
      onRequestCancel(cb: () => void) {
        fire = cb;
        return { dispose() {} };
      },
    };
    const p = runGitReadOnly(['log'], { ...BASE_OPTS, token }, deps);
    await new Promise<void>((res) => setImmediate(res));
    expect(spawn).toHaveBeenCalled();
    fire!();
    const r = await p;
    expect(r).toEqual({ kind: 'cancelled' });
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('输出超限终止子进程', async () => {
    const { child, stdout } = makeChild({}); // 不 exit,持续吐数据
    const { deps, spawn } = makeDeps(child);
    const p = runGitReadOnly(['log'], { cwd: '/repo', timeoutMs: 5000, maxOutputBytes: 16 }, deps);
    await new Promise<void>((res) => setImmediate(res));
    stdout.emit(Buffer.from('x'.repeat(32)));
    const r = await p;
    expect(r).toEqual({ kind: 'output-limit', limitBytes: 16, receivedBytes: 32 });
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });
});

// ---------- 退出与启动失败 ----------

describe('IDE-GIT-003 退出与启动失败', () => {
  it('非零退出:结构化 exit', async () => {
    const { child } = makeChild({ stderrData: 'fatal: not a repo\n', autoClose: true, exitCode: 128 });
    const { deps } = makeDeps(child);
    const r = await runGitReadOnly(['log'], BASE_OPTS, deps);
    expect(r).toEqual({ kind: 'exit', exitCode: 128, stderr: 'fatal: not a repo\n' });
  });

  it('启动失败(ENOENT):结构化 spawn', async () => {
    const { child } = makeChild({ error: new Error('spawn git ENOENT') });
    const { deps } = makeDeps(child);
    const r = await runGitReadOnly(['log'], BASE_OPTS, deps);
    expect(r.kind).toBe('spawn');
    expect((r as { message: string }).message).toContain('ENOENT');
  });

  it('超时后的迟到 close 不覆盖结果(只结算一次)', async () => {
    const { child, close } = makeChild({});
    const { deps, timeouts } = makeDeps(child);
    const p = runGitReadOnly(['log'], { cwd: '/repo', timeoutMs: 25, maxOutputBytes: 65536 }, deps);
    await new Promise<void>((res) => setImmediate(res));
    timeouts[0]();
    const r1 = await p;
    expect(r1).toEqual({ kind: 'timeout', timeoutMs: 25 });
    close(0, null); // 迟到
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });
});

// ---------- 校验函数与源锁 ----------

describe('IDE-GIT-003 校验与源锁', () => {
  it('空 args / 空 cwd / 非正限值均拒绝', () => {
    expect(validateGitArgs([], '/repo')).not.toBeNull();
    expect(validateGitArgs(['log'], '')).not.toBeNull();
    expect(validateGitArgs(['log'], '   ')).not.toBeNull();
  });

  it('白名单含历史泳道所需子命令', () => {
    for (const sub of ['log', 'show', 'diff', 'cat-file', 'rev-parse', 'blame', 'ls-files', 'rev-list']) {
      expect(READONLY_GIT_SUBCOMMANDS.has(sub)).toBe(true);
    }
  });

  it('源锁:无阻塞式同步进程调用,无 shell 拼接', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'gitRunner.ts'), 'utf8');
    expect(src).not.toMatch(/spawnSync\s*\(|execSync\s*\(|execFileSync\s*\(/);
    expect(src).not.toMatch(/shell\s*:\s*true/);
  });
});

// ---------- 真实 git 冒烟 ----------

describe('IDE-GIT-003 真实 git 冒烟', () => {
  it('git version 可跑通(default deps)', async () => {
    const r = await runGitReadOnly(['version'], { cwd: join(__dirname, '..'), timeoutMs: 10000, maxOutputBytes: 65536 });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.stdout.trim()).toMatch(/^git version /);
  });

  it('中文+空格文件名经 ls-files 逐字往返(真实临时仓库)', () => {
    const repo = mkdtempSync(join(tmpdir(), 'kode-git-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    mkdirSync(join(repo, 'src'), { recursive: true });
    const file = join(repo, 'src', '文件 名 with space.py');
    writeFileSync(file, 'x = 1\n');
    execFileSync('git', ['add', '--', 'src/文件 名 with space.py'], { cwd: repo });
    // -z:以 NUL 分隔、不转义(默认 core.quotePath 会把非 ASCII 输出成八进制
    // 引号串,那是显示转义而非命令拼接;此处证明的是参数逐字往返)
    const r = runGitReadOnly(['ls-files', '-z', '--', 'src/文件 名 with space.py'], {
      cwd: repo,
      timeoutMs: 10000,
      maxOutputBytes: 65536,
    });
    return r.then((res) => {
      expect(res.kind).toBe('ok');
      if (res.kind === 'ok') expect(res.stdout.split('\u0000')[0]).toBe('src/文件 名 with space.py');
    });
  });
});
