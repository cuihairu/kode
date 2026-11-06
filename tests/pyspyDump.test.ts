import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import {
  PYSPY_PTRACE_GUIDANCE,
  defaultSpawnRunner,
  checkPyspyInstalled,
  ensurePyspyReady,
  installPyspy,
  resolvePyspyCommand,
  runPyspyDump,
  runPyspyRecord,
  runPyspySchedule,
  buildPyspyRecordArgs,
  type CommandRunResult,
  type PyspyUi,
  type SpawnRunner
} from '../src/pyspyDump';
import type { InterpreterResolution } from '../src/profileInterpreter';

// IDE-PDBG-003 py-spy 性能分析面:探测/一键安装/dump(--nonblocking,权限
// 失败拼 ptrace 指引)的纯函数行为 + ensurePyspyReady 编排(未装弹安装、
// 装失败如实报错不假成功)+ IDE-PYSPY-001 record 火焰图面(傻瓜化默认
// 参数/周期采集编排)+ package.json 清单锁(serverControl 树 inline 组里
// py-spy dump 图标紧排在 debug 附加图标后,$(pulse) 级,flamegraph 在其后)。

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** spawn 替身:按 (command,args) 序列回放结果,记录调用面 */
const makeRunner = (results: Array<{ match: (command: string, args: string[]) => boolean; result: CommandRunResult }>) => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const runner: SpawnRunner = async (command, args) => {
    calls.push({ command, args });
    const hit = results.find(entry => entry.match(command, args));
    if (!hit) {
      throw new Error(`runner 无回放: ${command} ${args.join(' ')}`);
    }
    return hit.result;
  };
  return { runner, calls };
};

const run = (stdout = '', stderr = '', exitCode: number | null = 0): CommandRunResult => ({ stdout, stderr, exitCode });

describe('defaultSpawnRunner 超时组杀(不留孙进程孤儿)', () => {
  it('挂起命令按截止被杀,如实返回 exitCode -1', async () => {
    // 真实 node 子进程:挂起 10s,但 runner 只等 300ms——超时组杀路径
    const started = Date.now();
    const result = await defaultSpawnRunner(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 10000)'],
      300
    );
    expect(result.exitCode).toBe(-1);
    // 截止附近返回(远小于挂起的 10s)
    expect(Date.now() - started).toBeLessThan(5000);
  }, 8000);
});

describe('checkPyspyInstalled', () => {
  it('版本走 stdout 也能走 stderr(py-spy 实际行为两种都有)', async () => {
    expect(await checkPyspyInstalled(async () => run('py-spy 0.3.14\n'))).toMatchObject({
      installed: true,
      version: '0.3.14'
    });
    expect(await checkPyspyInstalled(async () => run('', 'py-spy 0.3.11', 0))).toMatchObject({
      installed: true,
      version: '0.3.11'
    });
  });

  it('PATH 上没有 py-spy:未装,原因可定位', async () => {
    const presence = await checkPyspyInstalled(async () => run('', 'Error: spawn py-spy ENOENT', -1));
    expect(presence.installed).toBe(false);
    expect(presence.version).toBeNull();
    expect(presence.detail).toContain('没有 py-spy');
  });

  it('探测非零退出且无版本串:未装,带首行输出', async () => {
    const presence = await checkPyspyInstalled(async () => run('some other output', '', 1));
    expect(presence.installed).toBe(false);
    expect(presence.detail).toContain('py-spy 探测失败');
  });
});

describe('installPyspy', () => {
  const pipArgs = ['-m', 'pip', 'install', '-U', 'py-spy'];

  it('退出码 0:成功,带输出尾', async () => {
    const { runner, calls } = makeRunner([
      { match: (cmd, args) => cmd === '/usr/bin/python3' && args.join(' ') === pipArgs.join(' '), result: run('Successfully installed py-spy-0.3.14\n') }
    ]);
    const result = await installPyspy(runner, '/usr/bin/python3');
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('Successfully installed');
    expect(calls[0].args).toEqual(pipArgs);
  });

  it('非零退出:如实失败,带退出码与输出尾', async () => {
    const { runner } = makeRunner([
      { match: (cmd, args) => cmd === '/usr/bin/python3' && args.length === pipArgs.length, result: run('', 'ERROR: no network', 1) }
    ]);
    const result = await installPyspy(runner, '/usr/bin/python3');
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('pip 退出码 1');
    expect(result.detail).toContain('no network');
  });
});

describe('runPyspyDump', () => {
  it('成功:调用栈原样带回,命令带 --nonblocking 不暂停目标进程', async () => {
    const { runner, calls } = makeRunner([
      { match: cmd => cmd === 'py-spy', result: run('Thread 0x7f (active): "python" main (kbengine.py:120)\n') }
    ]);
    const result = await runPyspyDump(runner, 4321);
    expect(result.ok).toBe(true);
    expect(result.output).toContain('kbengine.py:120');
    expect(calls[0].args).toEqual(['dump', '--pid', '4321', '--nonblocking']);
  });

  it('传解释器旁命令:dump 跑在该命令上(PATH 无 py-spy 也能 dump)', async () => {
    const adjacent = '/proj/.venv/bin/py-spy';
    const { runner, calls } = makeRunner([
      { match: cmd => cmd === adjacent, result: run('Thread 0x7f (active): "python" main (a.py:1)\n') }
    ]);
    const result = await runPyspyDump(runner, 4321, adjacent);
    expect(result.ok).toBe(true);
    expect(calls[0].command).toBe(adjacent);
  });

  it('权限类失败:ptrace 指引拼在原因后', async () => {
    const { runner } = makeRunner([
      { match: cmd => cmd === 'py-spy', result: run('', 'Error: Failed to suspend target process: Operation not permitted (os error 13)', 1) }
    ]);
    const result = await runPyspyDump(runner, 4321);
    expect(result.ok).toBe(false);
    expect(result.output).toContain('Operation not permitted');
    expect(result.output).toContain(PYSPY_PTRACE_GUIDANCE);
    expect(result.output).toContain('ptrace_scope');
  });

  it('非权限失败:只带原因,不硬拼指引', async () => {
    const { runner } = makeRunner([
      { match: cmd => cmd === 'py-spy', result: run('', 'Error: No such process (pid 4321)', 1) }
    ]);
    const result = await runPyspyDump(runner, 4321);
    expect(result.ok).toBe(false);
    expect(result.output).toContain('No such process');
    expect(result.output).not.toContain(PYSPY_PTRACE_GUIDANCE);
  });
});

describe('resolvePyspyCommand(IDE-PDBG-006 解释器旁定位)', () => {
  const exe = process.platform === 'win32' ? 'py-spy.exe' : 'py-spy';

  it('解释器同目录有 py-spy:返回该绝对路径(venv bin 命中)', () => {
    expect(resolvePyspyCommand('/proj/.venv/bin/python3', candidate => candidate === `/proj/.venv/bin/${exe}`))
      .toBe(`/proj/.venv/bin/${exe}`);
  });

  it('同目录没有但 ~/.local/bin 有:pip --user 兜底命中', () => {
    expect(resolvePyspyCommand('/usr/bin/python3', candidate => candidate.endsWith(`.local/bin/${exe}`)))
      .toContain(`.local/bin/${exe}`);
  });

  it('相对名解释器(ssh 远端 python3)与缺位:回落 null(PATH 裸命令)', () => {
    expect(resolvePyspyCommand('python3', () => true)).toBeNull();
    expect(resolvePyspyCommand(null, () => true)).toBeNull();
    expect(resolvePyspyCommand(undefined, () => true)).toBeNull();
  });

  it('候选都不在:null', () => {
    expect(resolvePyspyCommand('/usr/bin/python3', () => false)).toBeNull();
  });
});

describe('checkPyspyInstalled(命令透传)', () => {
  it('传入解释器旁命令:探测跑在该命令上', async () => {
    const { runner, calls } = makeRunner([
      { match: (cmd, args) => cmd === '/proj/.venv/bin/py-spy' && args[0] === '--version', result: run('py-spy 0.3.14') }
    ]);
    const presence = await checkPyspyInstalled(runner, '/proj/.venv/bin/py-spy');
    expect(presence.installed).toBe(true);
    expect(calls[0].command).toBe('/proj/.venv/bin/py-spy');
  });
});

describe('ensurePyspyReady(未装弹安装编排)', () => {
  // 探测命令不锁死 'py-spy':ensurePyspyReady 会先按解释器旁定位(venv bin/
  // ~/.local/bin),锁裸命令会让用例依赖本机是否装过 py-spy
  const versionProbe = { match: (cmd: string, args: string[]) => args[0] === '--version' };
  const pipInstall = { match: (cmd: string, args: string[]) => args.includes('pip') };

  const makeUi = (warnPick: string | undefined) => {
    const face: { warn: string[]; info: string[]; error: string[] } = { warn: [], info: [], error: [] };
    const ui: PyspyUi = {
      warn: async (message) => {
        face.warn.push(message);
        return warnPick;
      },
      info: async (message) => {
        face.info.push(message);
        return undefined;
      },
      error: async (message) => {
        face.error.push(message);
        return undefined;
      }
    };
    return { ui, face };
  };
  const interpreter = (interpreterPath: string | null): InterpreterResolution =>
    ({ interpreterPath, source: 'settings' } as unknown as InterpreterResolution);

  it('已装:直接放行,零弹窗零安装调用', async () => {
    const { runner, calls } = makeRunner([{ match: versionProbe.match, result: run('py-spy 0.3.14') }]);
    const { ui, face } = makeUi(undefined);
    await expect(ensurePyspyReady(runner, ui, () => interpreter('/usr/bin/python3'))).resolves.toBe(true);
    expect(face.warn).toHaveLength(0);
    expect(calls).toHaveLength(1); // 只有探测,没有 pip
  });

  it('未装+选一键安装+装成功:安装跑在所选解释器上,放行', async () => {
    const { runner, calls } = makeRunner([
      { match: versionProbe.match, result: run('', 'spawn py-spy ENOENT', -1) },
      { match: pipInstall.match, result: run('Successfully installed py-spy') }
    ]);
    const { ui, face } = makeUi('一键安装 py-spy');
    await expect(ensurePyspyReady(runner, ui, () => interpreter('/usr/bin/python3'))).resolves.toBe(true);
    expect(face.warn[0]).toContain('未安装 py-spy');
    expect(calls[1].command).toBe('/usr/bin/python3');
    expect(face.info[0]).toContain('py-spy 安装完成');
  });

  it('未装+选一键安装+装失败:如实报错含原因,不放行不假成功', async () => {
    const { runner } = makeRunner([
      { match: versionProbe.match, result: run('', 'spawn py-spy ENOENT', -1) },
      { match: pipInstall.match, result: run('', 'ERROR: no network', 1) }
    ]);
    const { ui, face } = makeUi('一键安装 py-spy');
    await expect(ensurePyspyReady(runner, ui, () => interpreter('/usr/bin/python3'))).resolves.toBe(false);
    expect(face.error).toHaveLength(1);
    expect(face.error[0]).toContain('py-spy 安装失败');
    expect(face.error[0]).toContain('pip 退出码 1');
  });

  it('未装+取消:不安装不放行', async () => {
    const { runner, calls } = makeRunner([
      { match: versionProbe.match, result: run('', 'spawn py-spy ENOENT', -1) }
    ]);
    const { ui } = makeUi(undefined);
    await expect(ensurePyspyReady(runner, ui, () => interpreter('/usr/bin/python3'))).resolves.toBe(false);
    expect(calls).toHaveLength(1); // 没跑 pip
  });

  it('未装+无解释器:给设置键指引,不安装不放行', async () => {
    const { runner, calls } = makeRunner([
      { match: versionProbe.match, result: run('', 'spawn py-spy ENOENT', -1) }
    ]);
    const { ui, face } = makeUi('一键安装 py-spy');
    await expect(ensurePyspyReady(runner, ui, () => interpreter(null))).resolves.toBe(false);
    expect(face.error[0]).toContain('kbengine.python.interpreterPath');
    expect(calls).toHaveLength(1);
  });

  it('解释器旁已装(venv bin):零弹窗直接放行,探测跑在解释器旁命令上', async () => {
    // 真实临时目录立解释器与同级 py-spy 文件(存在性探测面),装完即清
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-pyspy-'));
    const interpreterPath = path.join(dir, 'bin', 'python3');
    const adjacent = path.join(dir, 'bin', process.platform === 'win32' ? 'py-spy.exe' : 'py-spy');
    fs.mkdirSync(path.dirname(interpreterPath), { recursive: true });
    fs.writeFileSync(adjacent, '#!/bin/sh\n', 'utf8');
    try {
      const { runner, calls } = makeRunner([
        { match: (cmd, args) => cmd === adjacent && args[0] === '--version', result: run('py-spy 0.3.14') }
      ]);
      const { ui, face } = makeUi(undefined);
      await expect(ensurePyspyReady(runner, ui, () => interpreter(interpreterPath))).resolves.toBe(true);
      expect(face.warn).toHaveLength(0); // 装了不弹安装框——2026-10-30 用户反馈的死循环面
      expect(calls[0].command).toBe(adjacent);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('package.json 清单锁(serverControl 树 py-spy 图标位次)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
    activationEvents?: string[];
    contributes: {
      commands: Array<{ command: string; title?: string; icon?: string; category?: string }>;
      menus: Record<string, Array<{ command: string; when?: string; group?: string }>>;
    };
  };

  const serverControlInline = (): string[] =>
    (pkg.contributes.menus['view/item/context'] ?? [])
      .filter(entry => entry.when === 'view == kbengine.serverControl' && entry.group === 'inline')
      .map(entry => entry.command);

  it('inline 组里 py-spy 图标紧排在 debug 附加图标后(位次锁)', () => {
    const order = serverControlInline();
    const attachIndex = order.indexOf('kbengine.debug.attach');
    const pyspyIndex = order.indexOf('kbengine.debug.pyspyDump');
    expect(attachIndex).toBeGreaterThanOrEqual(0);
    expect(pyspyIndex).toBe(attachIndex + 1);
  });

  it('命令贡献带 $(pulse) 图标并按需激活', () => {
    // KODE-I18N-001 起命令标题外置 package.nls*.json(%key% 占位),契约按解析后默认包文案断言
    const nls = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.nls.json'), 'utf8')) as Record<string, string>;
    const command = pkg.contributes.commands.find(entry => entry.command === 'kbengine.debug.pyspyDump');
    expect(command?.icon).toBe('$(pulse)');
    const title = (command?.title ?? '').replace(/^%([^%]+)%$/, (_m, key: string) => nls[key] ?? key);
    expect(title).toContain('py-spy');
    expect(pkg.activationEvents).toContain('onCommand:kbengine.debug.pyspyDump');
  });

  it('火焰图命令带 $(flame) 图标、标题与激活事件,dump 之后位次(IDE-PYSPY-001)', () => {
    const nls = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.nls.json'), 'utf8')) as Record<string, string>;
    const command = pkg.contributes.commands.find(entry => entry.command === 'kbengine.debug.pyspyFlamegraph');
    expect(command?.icon).toBe('$(flame)');
    const title = (command?.title ?? '').replace(/^%([^%]+)%$/, (_m, key: string) => nls[key] ?? key);
    expect(title).toContain('py-spy');
    expect(pkg.activationEvents).toContain('onCommand:kbengine.debug.pyspyFlamegraph');
    const order = serverControlInline();
    expect(order.indexOf('kbengine.debug.pyspyFlamegraph')).toBe(order.indexOf('kbengine.debug.pyspyDump') + 1);
  });
});

describe('buildPyspyRecordArgs(IDE-PYSPY-001)', () => {
  it('傻瓜化默认参数齐备:flamegraph/10s/100/s/非阻塞', () => {
    const args = buildPyspyRecordArgs(1234, '/tmp/out.svg');
    expect(args[0]).toBe('record');
    expect(args).toContain('--pid');
    expect(args[args.indexOf('--pid') + 1]).toBe('1234');
    expect(args[args.indexOf('--format') + 1]).toBe('flamegraph');
    expect(args[args.indexOf('--output') + 1]).toBe('/tmp/out.svg');
    expect(args[args.indexOf('--duration') + 1]).toBe('10');
    expect(args[args.indexOf('--rate') + 1]).toBe('100');
    expect(args).toContain('--nonblocking');
    expect(args).not.toContain('--native');
    expect(args).not.toContain('--threads');
  });

  it('覆盖项生效且开关只按需追加', () => {
    const args = buildPyspyRecordArgs(7, '/tmp/a.svg', {
      durationSec: 3,
      rateHz: 50,
      format: 'speedscope',
      nonblocking: false,
      native: true,
      threads: true
    });
    expect(args[args.indexOf('--duration') + 1]).toBe('3');
    expect(args[args.indexOf('--rate') + 1]).toBe('50');
    expect(args[args.indexOf('--format') + 1]).toBe('speedscope');
    expect(args).not.toContain('--nonblocking');
    expect(args).toContain('--native');
    expect(args).toContain('--threads');
  });
});

describe('runPyspyRecord(IDE-PYSPY-001)', () => {
  const fileDeps = (exists: boolean): { fileExistsNonEmpty: (p: string) => boolean } => ({
    fileExistsNonEmpty: () => exists
  });

  it('退出码 0 且输出文件存在非空 → 成功(output=文件路径)', async () => {
    const { runner } = makeRunner([{ match: (c, a) => c === 'py-spy' && a[0] === 'record', result: run('', '') }]);
    const result = await runPyspyRecord(runner, 42, '/tmp/x.svg', {}, null, fileDeps(true));
    expect(result.ok).toBe(true);
    expect(result.output).toBe('/tmp/x.svg');
  });

  it('退出码 0 但输出文件缺失(未落盘)→ 失败如实报', async () => {
    const { runner } = makeRunner([{ match: (c, a) => c === 'py-spy' && a[0] === 'record', result: run('', '') }]);
    const result = await runPyspyRecord(runner, 42, '/tmp/x.svg', {}, null, fileDeps(false));
    expect(result.ok).toBe(false);
    expect(result.output).toContain('退出码 0');
  });

  it('权限类失败拼 ptrace 指引(与 dump 同一段话)', async () => {
    const { runner } = makeRunner([
      { match: (c, a) => c === 'py-spy' && a[0] === 'record', result: run('', 'Operation not permitted') }
    ]);
    const result = await runPyspyRecord(runner, 42, '/tmp/x.svg', {}, null, fileDeps(false));
    expect(result.ok).toBe(false);
    expect(result.output).toContain('Operation not permitted');
    expect(result.output).toContain(PYSPY_PTRACE_GUIDANCE);
  });
});

describe('runPyspySchedule(IDE-PYSPY-001)', () => {
  const deps = (sleeps: number[], existing: Set<string>, now = 1000) => {
    const calls: string[] = [];
    return {
      deps: {
        fileExistsNonEmpty: (p: string) => existing.has(p),
        sleep: async (ms: number) => {
          calls.push(`sleep:${ms}`);
        },
        now: () => now
      },
      sleepCalls: calls
    };
  };

  it('按 X 次/间隔 N 秒采集,逐次独立文件,成功即续', async () => {
    const files = new Set(['/d/flame-1000-0.svg', '/d/flame-1000-1.svg', '/d/flame-1000-2.svg']);
    const { deps: sd, sleepCalls } = deps([], files);
    const { runner } = makeRunner([{ match: (c, a) => c === 'py-spy' && a[0] === 'record', result: run('', '') }]);
    const runs = await runPyspySchedule(runner, 9, {
      count: 3,
      intervalSec: 5,
      outDir: '/d',
      durationSec: 10,
      rateHz: 100,
      format: 'flamegraph',
      nonblocking: true
    }, null, sd);
    expect(runs).toHaveLength(3);
    expect(runs.map(r => r.file)).toEqual(['/d/flame-1000-0.svg', '/d/flame-1000-1.svg', '/d/flame-1000-2.svg']);
    expect(runs.every(r => r.ok)).toBe(true);
    expect(sleepCalls).toEqual(['sleep:5000', 'sleep:5000']);
  });

  it('某次失败即止,已成功文件保留,不再睡后续间隔', async () => {
    const files = new Set(['/d/flame-2000-0.svg']);
    const { deps: sd, sleepCalls } = deps([], files, 2000);
    const { runner } = makeRunner([{ match: (c, a) => c === 'py-spy' && a[0] === 'record', result: run('', 'record 中断') }]);
    const runs = await runPyspySchedule(runner, 9, {
      count: 4,
      intervalSec: 5,
      outDir: '/d',
      durationSec: 10,
      rateHz: 100,
      format: 'flamegraph',
      nonblocking: true
    }, null, sd);
    expect(runs).toHaveLength(2);
    expect(runs[0].ok).toBe(true);
    expect(runs[1].ok).toBe(false);
    expect(sleepCalls).toEqual(['sleep:5000']);
  });
});
