import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { locateInterpreterOnPath } from '../src/profileInterpreter';
import type { DiscoveredVenv } from '../src/backend/venvDiscovery';
import type { InterpreterResolution } from '../src/profileInterpreter';
import {
  buildInterpreterPickItems,
  createVenvFlow,
  interpreterSourceBadge,
  interpreterStatusBarText,
  selectInterpreter,
  shouldShowInterpreterStatusBar,
  VENV_CREATE_ITEM_LABEL,
  probePythonVersion,
  runVenvModuleProcess
} from '../src/backend/venvInterpreterPicker';

// 解释器状态栏展示与选择(PY-ENV 二期):状态栏项显示当前解释器(venv 名/
// 版本/来源徽标 auto|configured|PATH),点击进 QuickPick——选中写入
// kbengine.python.interpreterPath 即刻生效(resolveProfileInterpreter 每次
// 读实时配置);列表尾「创建新 venv…」走创建流。全部交互面依赖注入,
// 单测用内存替身,不碰真实 vscode。

const venv = (rootPath: string, interpreterPath: string): DiscoveredVenv => ({
  rootPath,
  name: rootPath.split('/').pop() ?? rootPath,
  interpreterPath,
  envKind: 'venv',
  depth: 0
});

describe('source badge and status bar text (pure)', () => {
  it('maps each interpreter source to its badge', () => {
    expect(interpreterSourceBadge('setting')).toBe('configured');
    expect(interpreterSourceBadge('venv')).toBe('auto');
    expect(interpreterSourceBadge('path')).toBe('PATH');
    expect(interpreterSourceBadge('missing')).toBe('missing');
  });

  it('hides the interpreter status bar item when the python extension shows one (venv/Pylance dedup)', () => {
    // ms-python.python 激活 → 它在状态栏显示解释器选择器 → 本扩展项隐藏
    expect(shouldShowInterpreterStatusBar(true)).toBe(false);
    // Python 扩展未激活 → 本扩展项显示(不丢选择/创建 venv 入口)
    expect(shouldShowInterpreterStatusBar(false)).toBe(true);
  });

  it('status bar text carries venv name, version and badge', () => {
    const resolution: InterpreterResolution = {
      interpreterPath: '/ws/.venv/bin/python',
      interpreterSource: 'venv'
    };
    expect(interpreterStatusBarText(resolution, '3.12.13')).toBe(
      '$(python) .venv 3.12.13 (auto)'
    );
    // 版本探测失败(未装/超时)不放版本段,徽标仍在
    expect(interpreterStatusBarText(resolution)).toBe('$(python) .venv (auto)');
  });

  it('PATH interpreter shows the binary name with the PATH badge', () => {
    expect(
      interpreterStatusBarText({ interpreterPath: '/usr/bin/python3', interpreterSource: 'path' }, '3.11.9')
    ).toBe('$(python) python3 3.11.9 (PATH)');
  });

  it('configured interpreter keeps the configured badge', () => {
    expect(
      interpreterStatusBarText({ interpreterPath: '/opt/py/bin/python', interpreterSource: 'setting' })
    ).toBe('$(python) python (configured)');
  });

  it('a selected venv written into the setting still shows the env directory name', () => {
    // 来源变 configured,但路径是环境布局(bin|Scripts/python),状态栏仍显示
    // 环境目录名而不是退化成 python
    expect(
      interpreterStatusBarText({ interpreterPath: '/ws/.venv/bin/python', interpreterSource: 'setting' })
    ).toBe('$(python) .venv (configured)');
    expect(
      interpreterStatusBarText({ interpreterPath: 'C:\\ws\\.venv\\Scripts\\python.exe', interpreterSource: 'setting' })
    ).toBe('$(python) .venv (configured)');
  });

  it('missing interpreter says so instead of pretending', () => {
    expect(interpreterStatusBarText({ interpreterPath: null, interpreterSource: 'missing' })).toBe(
      '$(circle-slash) Python interpreter missing'
    );
  });
});

describe('QuickPick item composition (pure)', () => {
  it('lists current first, then discovered venvs, then PATH, with create last', () => {
    const items = buildInterpreterPickItems({
      current: { interpreterPath: '/ws/.venv/bin/python', interpreterSource: 'venv' },
      discovered: [
        venv('/ws/.venv', '/ws/.venv/bin/python'),
        venv('/ws/envs/team', '/ws/envs/team/bin/python')
      ],
      pathInterpreter: '/usr/bin/python3'
    });
    expect(items[0].current).toBe(true);
    expect(items[items.length - 1].create).toBe(true);
    expect(items[items.length - 1].label).toBe(VENV_CREATE_ITEM_LABEL);
    const venvItems = items.filter(item => item.venv);
    expect(venvItems).toHaveLength(2);
    expect(venvItems[0].description).toBe('/ws/.venv');
    expect(venvItems[0].interpreterPath).toBe('/ws/.venv/bin/python');
    const pathItem = items.find(item => item.pathEntry);
    expect(pathItem?.interpreterPath).toBe('/usr/bin/python3');
  });

  it('the currently active interpreter is exactly one item and marked', () => {
    const items = buildInterpreterPickItems({
      current: { interpreterPath: '/ws/.venv/bin/python', interpreterSource: 'venv' },
      discovered: [venv('/ws/.venv', '/ws/.venv/bin/python')],
      pathInterpreter: null
    });
    expect(items.filter(item => item.current)).toHaveLength(1);
    expect(items.filter(item => item.pathEntry)).toHaveLength(0);
  });
});

describe('selectInterpreter (injected ui + setting write)', () => {
  const baseDeps = (overrides: Partial<Parameters<typeof selectInterpreter>[0]> = {}) => ({
    current: (): InterpreterResolution => ({
      interpreterPath: '/usr/bin/python3',
      interpreterSource: 'path'
    }),
    discovered: (): DiscoveredVenv[] => [venv('/ws/.venv', '/ws/.venv/bin/python')],
    pathInterpreter: (): string | null => '/usr/bin/python3',
    picked: undefined as unknown,
    written: [] as Array<string | null>,
    showQuickPick: async function (this: { picked: unknown }) {
      return this.picked as undefined;
    },
    writeInterpreterSetting: async function (this: { written: Array<string | null> }, value: string | null) {
      this.written.push(value);
    },
    report: async () => undefined,
    createVenv: async () => null as 'created' | null,
    ...overrides
  });

  it('writing the picked venv into kbengine.python.interpreterPath takes effect at once', async () => {
    const deps: any = baseDeps();
    deps.picked = { create: false, interpreterPath: '/ws/.venv/bin/python', label: '.venv' };
    const result = await selectInterpreter(deps);
    expect(result).toBe('selected');
    expect(deps.written).toEqual(['/ws/.venv/bin/python']);
  });

  it('Esc writes nothing (zero side effect)', async () => {
    const deps: any = baseDeps();
    deps.picked = undefined;
    const result = await selectInterpreter(deps);
    expect(result).toBeNull();
    expect(deps.written).toEqual([]);
  });

  it('the create entry hands over to the creation flow', async () => {
    let created = false;
    const deps: any = baseDeps({
      createVenv: async () => {
        created = true;
        return 'created';
      }
    });
    deps.picked = { create: true };
    const result = await selectInterpreter(deps);
    expect(result).toBe('created');
    expect(created).toBe(true);
    expect(deps.written).toEqual([]);
  });
});

describe('createVenvFlow (mocked venv module run)', () => {
  const baseDeps = (overrides: Record<string, unknown> = {}) => {
    const state = {
      parent: '/ws' as string | null,
      base: '/usr/bin/python3' as string | null,
      verified: '/ws/.venv/bin/python' as string | null,
      runs: [] as Array<[string, string]>,
      written: [] as Array<string | null>,
      messages: [] as string[]
    };
    const deps = {
      workspaceRoot: '/ws',
      // 选放置 venv 的父目录(对话框只能选已存在目录);目标=父目录/.venv
      pickTargetParentDir: async () => state.parent,
      baseInterpreter: (): string | null => state.base,
      // WIN-3:产品用 path.join(parent, '.venv') 拼目标目录(win32 反斜杠),mock 同口径
      targetDirectoryExistsNonEmpty: (dir) => dir === join('/ws/occupied', '.venv'),
      runVenvModule: async function (_base: string, target: string) {
        state.runs.push([_base, target]);
        return { exitCode: 0, stderr: '' };
      },
      // 验真只认落盘目标目录本身:验真结果由 state.verified 控制
      // (验不过=null),且不对非 .venv 目标伪造通过
      verifyTarget: (dir: string): string | null => (dir.endsWith('.venv') ? state.verified : null),
      writeInterpreterSetting: async function (value: string | null) {
        state.written.push(value);
      },
      report: async (message: string) => {
        state.messages.push(message);
      },
      state,
      ...overrides
    };
    return deps;
  };

  it('runs python -m venv on <parent>/.venv and auto-selects the verified env', async () => {
    const deps: any = baseDeps();
    const result = await createVenvFlow(deps);
    expect(result).toBe('created');
    // WIN-3:target 由平台 join 生成,期望同步用 join(断言参数而非分隔符风格)
    expect(deps.state.runs).toEqual([['/usr/bin/python3', join('/ws', '.venv')]]);
    expect(deps.state.written).toEqual(['/ws/.venv/bin/python']);
    expect(deps.state.messages.join('\n')).toContain('/ws/.venv');
  });

  it('a target outside the scan scope is still verified directly and selected', async () => {
    // 深层/工作区外父目录:不走扫描,直接对目标验真
    const deps: any = baseDeps();
    deps.state.parent = '/ws/vendor/deep';
    deps.state.verified = '/ws/vendor/deep/.venv/bin/python';
    const result = await createVenvFlow(deps);
    expect(result).toBe('created');
    expect(deps.state.written).toEqual(['/ws/vendor/deep/.venv/bin/python']);
  });

  it('a missing base interpreter reports honestly and never spawns', async () => {
    const deps: any = baseDeps();
    deps.state.base = null;
    const result = await createVenvFlow(deps);
    expect(result).toBeNull();
    expect(deps.state.runs).toEqual([]);
    expect(deps.state.written).toEqual([]);
    expect(deps.state.messages.join('\n')).toContain('Missing a base Python interpreter');
    // 补救提示与实际行为一致:设置 kbengine.python.interpreterPath 是有效入口
    expect(deps.state.messages.join('\n')).toContain('kbengine.python.interpreterPath');
  });

  it('an occupied target directory aborts before any write', async () => {
    const deps: any = baseDeps();
    deps.state.parent = '/ws/occupied';
    const result = await createVenvFlow(deps);
    expect(result).toBeNull();
    expect(deps.state.runs).toEqual([]);
    expect(deps.state.messages.join('\n')).toContain(join('/ws/occupied', '.venv'));
  });

  it('a venv command failure surfaces stderr instead of faking success', async () => {
    const deps: any = baseDeps();
    deps.runVenvModule = async () => ({ exitCode: 1, stderr: 'No space left on device' });
    const result = await createVenvFlow(deps);
    expect(result).toBeNull();
    expect(deps.state.written).toEqual([]);
    expect(deps.state.messages.join('\n')).toContain('No space left on device');
  });

  it('a created directory that fails verification is reported, never selected', async () => {
    const deps: any = baseDeps();
    deps.state.verified = null;
    const result = await createVenvFlow(deps);
    expect(result).toBeNull();
    expect(deps.state.written).toEqual([]);
    expect(deps.state.messages.join('\n')).toContain('did not pass verification');
  });

  it('no workspace root refuses before any dialog', async () => {
    const deps: any = baseDeps({ workspaceRoot: undefined });
    const result = await createVenvFlow(deps);
    expect(result).toBeNull();
    expect(deps.state.runs).toEqual([]);
  });

describe('selectInterpreter 缺口臂与真实进程依赖面', () => {
  it('选中项缺 interpreterPath(非 create):零写入如实 null', async () => {
    const written: Array<string | null> = [];
    const deps = {
      current: (): InterpreterResolution => ({ interpreterPath: '/usr/bin/python3', interpreterSource: 'path' }),
      discovered: (): DiscoveredVenv[] => [],
      pathInterpreter: (): string | null => null,
      showQuickPick: async (): Promise<unknown> => ({ create: false, label: 'broken' }),
      writeInterpreterSetting: async (value: string | null): Promise<void> => {
        written.push(value);
      },
      report: async (): Promise<void> => undefined,
      createVenv: async (): Promise<'created' | null> => null
    };
    const result = await selectInterpreter(deps as Parameters<typeof selectInterpreter>[0]);
    expect(result).toBeNull();
    expect(written).toEqual([]);
  });

  it('runVenvModuleProcess:解释器不存在 → spawn error 如实 -1(真依赖面)', async () => {
    const result = await runVenvModuleProcess('kode-no-such-python-xyz', '/tmp/kode-venv-target-x');
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain('ENOENT');
  });

  it('runVenvModuleProcess:目标已是普通文件 → venv 快速失败,stderr 有尾', async () => {
    const interpreter = locateInterpreterOnPath(process.env.PATH ?? '', process.platform) ?? '/usr/bin/python3';
    const dir = mkdtempSync(join(tmpdir(), 'kode-venv-arming-'));
    const target = join(dir, 'not-a-dir');
    writeFileSync(target, 'x', 'utf8');
    try {
      const result = await runVenvModuleProcess(interpreter, target);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('probePythonVersion:真实解释器解析出版本;缺失解释器如实 null', async () => {
    const interpreter = locateInterpreterOnPath(process.env.PATH ?? '', process.platform) ?? '/usr/bin/python3';
    if (existsSync(interpreter)) {
      const version = await probePythonVersion(interpreter);
      expect(version).not.toBeNull();
      expect(version!.length).toBeGreaterThan(0);
    }
    expect(await probePythonVersion('kode-no-such-python-xyz')).toBeNull();
  });
});

});
