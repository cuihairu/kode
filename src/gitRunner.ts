/**
 * IDE-GIT-003:可取消且有界的只读 Git 执行器。
 * 用户约束(2026-10-29):默认开启、按需查询——本执行器只在被启用门控的调用面
 * 进入时启动 Git 子进程,绝不轮询/预取;历史泳道(004 分页日志、006 版本 diff、
 * 007 重命名追踪)统一经此出口,保证:
 * - 参数数组 + 无 shell:空格/中文/引号等特殊文件名逐字传递,不会变成命令;
 * - 只读白名单:写子命令(commit/push/reset…)与外联执行选项(--ext-diff/
 *   --textconv/--upload-pack…)在任何进程启动前就拒绝;
 * - 明确 cwd 与路径边界:cwd 必填,`--` 之后的路径参数解析后必须仍在 cwd 内
 *   (`..` 越界、cwd 外绝对路径都拒绝);
 * - 有界:超时、取消、输出超限都以 SIGKILL 终止当前子进程、清除定时器并
 *   只结算一次(迟到的 close 不覆盖结果),资源即释放;
 * - 无阻塞:只用异步 spawn,禁同步式进程调用(源码锁测试钉住)。
 * 全部外部依赖(spawn/定时器)注入,测试用假子进程即可覆盖全部失败路径。
 */

import { spawn as nodeSpawn } from 'child_process';
import * as path from 'path';

/** 取消令牌(结构兼容 vscode.CancellationToken;缺省回调时仅结算点轮询)。 */
export interface GitCancellationToken {
  readonly isCancellationRequested: boolean;
  /** 取消时回调(注册返回解除函数);用于运行中即时终止子进程。 */
  onRequestCancel?(cb: () => void): { dispose(): void };
}

/** 执行器所需的子进程最小面(真实 ChildProcess 结构兼容)。 */
export interface GitChildProcess {
  stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): void };
  stderr: { on(event: 'data', listener: (chunk: Buffer | string) => void): void };
  kill(signal?: string): boolean;
  on(event: 'close', listener: (code: number | null, signal: string | null) => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
}

/** 执行器依赖注入面(默认实现包一层 nodeSpawn + 原生定时器)。 */
export interface GitExecutorDeps {
  spawn(command: string, args: readonly string[], options: { cwd: string }): GitChildProcess;
  setTimeout(handler: () => void, timeoutMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export function defaultGitExecutorDeps(): GitExecutorDeps {
  return {
    spawn: (command, args, options) =>
      nodeSpawn(command, [...args], { ...options, windowsHide: true }) as unknown as GitChildProcess,
    setTimeout: (handler, timeoutMs) => setTimeout(handler, timeoutMs),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

/**
 * 只读子命令白名单——写操作(提交/推送/重置/检出/分支…)一律不在表内,
 * 在任何进程启动前拒绝。覆盖历史泳道所需:004 分页 log/rev-list、006 版本
 * show/diff/cat-file、007 重命名追踪(log --follow / diff-tree)、定位
 * rev-parse/ls-files/status/blame/merge-base 等。
 */
export const READONLY_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'log',
  'show',
  'diff',
  'diff-tree',
  'cat-file',
  'rev-parse',
  'rev-list',
  'blame',
  'ls-files',
  'status',
  'describe',
  'name-rev',
  'name-status',
  'shortlog',
  'symbolic-ref',
  'for-each-ref',
  'merge-base',
  'version',
]);

/** 会外联执行/注入执行的选项——即使在只读子命令下也禁止。 */
const FORBIDDEN_OPTION_PATTERN = /^--(ext-diff|textconv|upload-pack|receive-pack|exec)(=.*)?$/;

/** 参数校验:通过返回 null,否则给出结构化拒绝原因(进程绝不启动)。 */
export function validateGitArgs(args: readonly string[], cwd: string): { reason: string } | null {
  if (!Array.isArray(args) || args.length === 0) {
    return { reason: 'args 为空:需要至少一个只读子命令' };
  }
  if (typeof cwd !== 'string' || cwd.trim() === '') {
    return { reason: 'cwd 未提供:执行 Git 需要明确的工作目录' };
  }
  const sub = args[0];
  if (!READONLY_GIT_SUBCOMMANDS.has(sub)) {
    return { reason: `非只读子命令被拒绝:${sub}(只读白名单外不放行)` };
  }
  const dashdash = args.indexOf('--');
  const head = dashdash === -1 ? args.slice(1) : args.slice(1, dashdash);
  const tail = dashdash === -1 ? [] : args.slice(dashdash + 1);
  for (const arg of head) {
    if (FORBIDDEN_OPTION_PATTERN.test(arg)) {
      return { reason: `禁止的选项(会外联执行外部命令):${arg}` };
    }
    if (arg === '-c' || arg.startsWith('-c=')) {
      return { reason: '禁止注入全局配置(-c)' };
    }
  }
  for (const p of tail) {
    if (p === '') {
      return { reason: '路径参数为空' };
    }
    const abs = path.resolve(cwd, p);
    if (abs !== cwd && !abs.startsWith(cwd + path.sep)) {
      return { reason: `路径越界(解析后逃出 cwd):${p}` };
    }
  }
  return null;
}

/** 单次执行结果:成功数据,或结构化失败(调用面据此映射用户文案)。 */
export type GitRunOutcome =
  | { kind: 'ok'; stdout: string; stderr: string }
  | { kind: 'exit'; exitCode: number | null; stderr: string }
  | { kind: 'timeout'; timeoutMs: number }
  | { kind: 'cancelled' }
  | { kind: 'output-limit'; limitBytes: number; receivedBytes: number }
  | { kind: 'spawn'; message: string }
  | { kind: 'invalid-args'; reason: string };

/** 回显进错误信息里的 stderr 上限(避免巨量输出进文案)。 */
const STDERR_MESSAGE_CAP = 2000;

function truncateForMessage(s: string): string {
  return s.length > STDERR_MESSAGE_CAP ? s.slice(0, STDERR_MESSAGE_CAP) + '…(截断)' : s;
}

export interface GitRunOptions {
  /** 明确的工作目录(必填;路径边界的基准)。 */
  cwd: string;
  /** 超时毫秒数(>0;到点 SIGKILL 子进程)。 */
  timeoutMs: number;
  /** 单流输出字节上限(>0;stdout 或 stderr 超限即终止)。 */
  maxOutputBytes: number;
  /** 取消令牌(预取消短路不启动;运行中取消即终止)。 */
  token?: GitCancellationToken;
}

/**
 * 以参数数组运行一条只读 Git 命令。
 * 校验失败/预取消不启动进程;超时、运行中取消、输出超限都以 SIGKILL 终止
 * 当前子进程、清除定时器并只结算一次;启动失败(如 git 不在 PATH)返回
 * 结构化 spawn 结果,由调用面映射可操作提示。
 */
export function runGitReadOnly(
  args: readonly string[],
  options: GitRunOptions,
  deps: GitExecutorDeps = defaultGitExecutorDeps()
): Promise<GitRunOutcome> {
  const invalid = validateGitArgs(args, options.cwd);
  if (invalid) {
    return Promise.resolve({ kind: 'invalid-args', reason: invalid.reason });
  }
  if (!(options.timeoutMs > 0)) {
    return Promise.resolve({ kind: 'invalid-args', reason: 'timeoutMs 必须为正数(有界执行不允许无限等待)' });
  }
  if (!(options.maxOutputBytes > 0)) {
    return Promise.resolve({ kind: 'invalid-args', reason: 'maxOutputBytes 必须为正数(有界执行不允许无限读)' });
  }
  const token = options.token;
  if (token?.isCancellationRequested) {
    return Promise.resolve({ kind: 'cancelled' });
  }

  return new Promise<GitRunOutcome>((resolve) => {
    let settled = false;
    // 定时器句柄经持有对象写回(finish 闭包在赋值前定义,const 句柄即可)
    const timer: { handle: unknown } = { handle: undefined };
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const child = deps.spawn('git', [...args], { cwd: options.cwd });

    const finish = (outcome: GitRunOutcome): void => {
      if (settled) return;
      settled = true;
      deps.clearTimeout(timer.handle);
      child.kill('SIGKILL');
      resolve(outcome);
    };

    timer.handle = deps.setTimeout(
      () => finish({ kind: 'timeout', timeoutMs: options.timeoutMs }),
      options.timeoutMs
    );

    const collect = (stream: GitChildProcess['stdout'], chunks: Buffer[], isStdout: boolean) => {
      stream.on('data', (chunk: Buffer | string) => {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
        chunks.push(buf);
        if (isStdout) {
          stdoutBytes += buf.length;
          if (stdoutBytes > options.maxOutputBytes) {
            finish({ kind: 'output-limit', limitBytes: options.maxOutputBytes, receivedBytes: stdoutBytes });
          }
        } else {
          stderrBytes += buf.length;
          if (stderrBytes > options.maxOutputBytes) {
            finish({ kind: 'output-limit', limitBytes: options.maxOutputBytes, receivedBytes: stderrBytes });
          }
        }
      });
    };
    collect(child.stdout, stdoutChunks, true);
    collect(child.stderr, stderrChunks, false);

    child.on('close', (code: number | null, _signal: string | null) => {
      if (settled) return; // 超时/取消/超限已结算,迟到的 close 不覆盖
      settled = true;
      deps.clearTimeout(timer.handle);
      if (code === 0) {
        resolve({
          kind: 'ok',
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
        });
      } else {
        resolve({
          kind: 'exit',
          exitCode: code,
          stderr: truncateForMessage(Buffer.concat(stderrChunks).toString('utf8')),
        });
      }
    });

    child.on('error', (err: Error) => {
      finish({ kind: 'spawn', message: `Git 进程启动失败:${err.message}` });
    });

    token?.onRequestCancel?.(() => finish({ kind: 'cancelled' }));
  });
}
