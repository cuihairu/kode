import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import {
  PYSPY_PTRACE_GUIDANCE,
  checkPyspyInstalled,
  ensurePyspyReady,
  installPyspy,
  runPyspyDump,
  type CommandRunResult,
  type PyspyUi,
  type SpawnRunner
} from '../src/pyspyDump';
import type { InterpreterResolution } from '../src/profileInterpreter';

// IDE-PDBG-003 py-spy 性能分析面:探测/一键安装/dump(--nonblocking,权限
// 失败拼 ptrace 指引)的纯函数行为 + ensurePyspyReady 编排(未装弹安装、
// 装失败如实报错不假成功)+ package.json 清单锁(serverControl 树 inline
// 组里 py-spy 图标紧排在 debug 附加图标后,$(pulse) 级)。

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

describe('ensurePyspyReady(未装弹安装编排)', () => {
  const versionProbe = { match: (cmd: string, args: string[]) => cmd === 'py-spy' && args[0] === '--version' };
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
    const command = pkg.contributes.commands.find(entry => entry.command === 'kbengine.debug.pyspyDump');
    expect(command?.icon).toBe('$(pulse)');
    expect(command?.title).toContain('py-spy');
    expect(pkg.activationEvents).toContain('onCommand:kbengine.debug.pyspyDump');
  });
});
