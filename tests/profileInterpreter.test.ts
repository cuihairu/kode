import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import {
  interpreterSourceLabels,
  describeInterpreterState,
  locateInterpreterOnPath,
  locateVenvInterpreter,
  resolveInterpreterWith
} from '../src/profileInterpreter';
import { ProjectProfileStore, PROJECT_PROFILES_STATE_KEY } from '../src/projectProfiles';

// IDE-PRJ-004:按 profile 记录 Python 解释器来源。解析链:显式设置
// kbengine.python.interpreterPath(支持 ${workspaceFolder})→ PATH 里的
// python3/python → 都找不到记缺失状态;来源(setting/path/missing)随路径
// 一并落进 profile,旧记录无此字段读回时归一为缺失而不是被丢弃。

class MemoryMemento implements vscode.Memento {
  private readonly map = new Map<string, unknown>();

  get<T>(key: string, defaultValue?: T): T | undefined {
    return this.map.has(key) ? (this.map.get(key) as T) : defaultValue;
  }

  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) {
      this.map.delete(key);
    } else {
      this.map.set(key, value);
    }
    return Promise.resolve();
  }

  keys(): readonly string[] {
    return [...this.map.keys()];
  }

  setKeysForSync(_keys: readonly string[]): void {
    // 内存替身不参与云同步
  }
}

describe('interpreter resolution chain (IDE-PRJ-004)', () => {
  it('locates python3/python on a given PATH (linux and windows suffix rules)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-interp-'));
    fs.writeFileSync(path.join(dir, 'python3'), '', 'utf8');

    expect(locateInterpreterOnPath(`${dir}${path.delimiter}${os.tmpdir()}`)).toBe(
      path.join(dir, 'python3')
    );
    // windows 面按 .exe 后缀找
    const winDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-interp-win-'));
    fs.writeFileSync(path.join(winDir, 'python.exe'), '', 'utf8');
    expect(locateInterpreterOnPath(winDir, 'win32')).toBe(path.join(winDir, 'python.exe'));
    // 没有就 null,不猜
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-interp-empty-'));
    expect(locateInterpreterOnPath(empty)).toBeNull();

    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(winDir, { recursive: true, force: true });
    fs.rmSync(empty, { recursive: true, force: true });
  });

  it('prefers the explicit setting, expanding ${workspaceFolder}', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-interp-set-'));
    const interpreter = path.join(base, 'my-python');
    fs.writeFileSync(interpreter, '', 'utf8');

    const fromSetting = resolveInterpreterWith({
      interpreterSetting: '${workspaceFolder}/my-python',
      workspaceRoot: base,
      pathEnv: '',
      platform: 'linux'
    });
    // WIN-3:产品侧是纯文本 replace(${workspaceFolder}),win32 上产出混合分隔符——同走 normalize 断言
    expect(path.normalize(fromSetting.interpreterPath ?? '')).toBe(path.normalize(interpreter));
    expect(fromSetting.interpreterSource).toBe('setting');

    // 设置了但文件不存在:不采用,继续走解析链
    const ghostSetting = resolveInterpreterWith({
      interpreterSetting: path.join(base, 'ghost-python'),
      pathEnv: '',
      platform: 'linux'
    });
    expect(ghostSetting).toEqual({ interpreterPath: null, interpreterSource: 'missing' });

    fs.rmSync(base, { recursive: true, force: true });
  });

  it('falls back to PATH and records the source; nothing found is an explicit missing state', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-interp-path-'));
    fs.writeFileSync(path.join(dir, 'python3'), '', 'utf8');

    const fromPath = resolveInterpreterWith({ pathEnv: dir, platform: 'linux' });
    expect(fromPath).toEqual({
      interpreterPath: path.join(dir, 'python3'),
      interpreterSource: 'path'
    });

    const missing = resolveInterpreterWith({ pathEnv: '', platform: 'linux' });
    expect(missing).toEqual({ interpreterPath: null, interpreterSource: 'missing' });

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('workspace venv discovery in the interpreter chain (PY-ENV)', () => {
  const makeVenv = (root: string, name: string, platform: NodeJS.Platform = 'linux') => {
    const binDir = path.join(root, name, platform === 'win32' ? 'Scripts' : 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const exe = path.join(binDir, platform === 'win32' ? 'python.exe' : 'python');
    fs.writeFileSync(exe, '', 'utf8');
    // 二期验真口径:真实 venv 都带 pyvenv.cfg,夹具同构
    fs.writeFileSync(path.join(root, name, 'pyvenv.cfg'), 'home = /usr\n', 'utf8');
    return exe;
  };
  const rm = (dir: string) => fs.rmSync(dir, { recursive: true, force: true });

  it('recognizes .venv / venv / .kbenv each on its own without config', () => {
    for (const name of ['.venv', 'venv', '.kbenv']) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-venv-'));
      const exe = makeVenv(root, name);
      const result = resolveInterpreterWith({
        workspaceRoot: root,
        pathEnv: '',
        platform: 'linux'
      });
      expect(result).toEqual({ interpreterPath: exe, interpreterSource: 'venv' });
      rm(root);
    }
  });

  it('custom venvDirectoryNames are respected and the source is venv', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-venv-cfg-'));
    const exe = makeVenv(root, 'envs');
    const result = resolveInterpreterWith({
      workspaceRoot: root,
      venvDirectoryNames: ['envs', '.venv'],
      pathEnv: '',
      platform: 'linux'
    });
    expect(result).toEqual({ interpreterPath: exe, interpreterSource: 'venv' });
    expect(interpreterSourceLabels().venv).toBe('workspace venv');
    rm(root);
  });

  it('a workspace venv is preferred over a bare PATH python', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-venv-pref-'));
    const exe = makeVenv(root, '.venv');
    const pathDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-venv-path-'));
    fs.writeFileSync(path.join(pathDir, 'python3'), '', 'utf8');
    const result = resolveInterpreterWith({
      workspaceRoot: root,
      pathEnv: pathDir,
      platform: 'linux'
    });
    expect(result).toEqual({ interpreterPath: exe, interpreterSource: 'venv' });
    rm(root);
    rm(pathDir);
  });

  it('an explicit valid setting still beats a workspace venv', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-venv-set-'));
    makeVenv(root, '.venv');
    const interp = path.join(root, 'my-python');
    fs.writeFileSync(interp, '', 'utf8');
    const result = resolveInterpreterWith({
      interpreterSetting: interp,
      workspaceRoot: root,
      pathEnv: '',
      platform: 'linux'
    });
    expect(result).toEqual({ interpreterPath: interp, interpreterSource: 'setting' });
    rm(root);
  });

  it('a ghost setting falls through to the workspace venv', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-venv-ghost-'));
    const exe = makeVenv(root, '.kbenv');
    const result = resolveInterpreterWith({
      interpreterSetting: path.join(root, 'ghost-python'),
      workspaceRoot: root,
      pathEnv: '',
      platform: 'linux'
    });
    expect(result).toEqual({ interpreterPath: exe, interpreterSource: 'venv' });
    rm(root);
  });

  it('does not probe a venv without a workspace root (falls to PATH/missing)', () => {
    const result = resolveInterpreterWith({ pathEnv: '', platform: 'linux' });
    expect(result).toEqual({ interpreterPath: null, interpreterSource: 'missing' });
  });

  it('windows uses Scripts/python.exe for venv discovery', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-venv-win-'));
    const exe = makeVenv(root, '.venv', 'win32');
    expect(locateVenvInterpreter(root, ['.venv', 'venv', '.kbenv'], 'win32')).toBe(exe);
    rm(root);
  });

  it('a venv directory without a python binary is not claimed', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-venv-nobin-'));
    fs.mkdirSync(path.join(root, '.venv', 'bin'), { recursive: true });
    const result = resolveInterpreterWith({ workspaceRoot: root, pathEnv: '', platform: 'linux' });
    expect(result).toEqual({ interpreterPath: null, interpreterSource: 'missing' });
    rm(root);
  });
});

describe('deep workspace discovery in the interpreter chain (PY-ENV 二期)', () => {
  const rm = (dir: string) => fs.rmSync(dir, { recursive: true, force: true });
  const makeVerifiedVenv = (dir: string, platform: NodeJS.Platform = 'linux') => {
    const binDir = path.join(dir, platform === 'win32' ? 'Scripts' : 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const exe = path.join(binDir, platform === 'win32' ? 'python.exe' : 'python');
    fs.writeFileSync(exe, '', 'utf8');
    fs.writeFileSync(path.join(dir, 'pyvenv.cfg'), 'home = /usr\n', 'utf8');
    return exe;
  };

  it('discovers a nested verified venv (pyvenv.cfg + python) beyond root-level names', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-venv-deep-'));
    const nested = path.join(root, 'envs', 'team');
    const exe = makeVerifiedVenv(nested);
    const result = resolveInterpreterWith({ workspaceRoot: root, pathEnv: '', platform: 'linux' });
    expect(result).toEqual({ interpreterPath: exe, interpreterSource: 'venv' });
    rm(root);
  });

  it('a broken nested env (marker without python) falls through to PATH', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-venv-deep-broken-'));
    const broken = path.join(root, 'envs', 'broken');
    fs.mkdirSync(path.join(broken, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(broken, 'pyvenv.cfg'), 'home = /usr\n', 'utf8');
    const pathDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-venv-deep-path-'));
    fs.writeFileSync(path.join(pathDir, 'python3'), '', 'utf8');
    const result = resolveInterpreterWith({
      workspaceRoot: root,
      pathEnv: pathDir,
      platform: 'linux'
    });
    expect(result).toEqual({
      interpreterPath: path.join(pathDir, 'python3'),
      interpreterSource: 'path'
    });
    rm(root);
    rm(pathDir);
  });

  it('a root-level venv still outranks a deeper one (configured > workspace > PATH unchanged)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-venv-deep-prio-'));
    const rootExe = makeVerifiedVenv(path.join(root, '.venv'));
    makeVerifiedVenv(path.join(root, 'envs', 'deep'));
    const result = resolveInterpreterWith({ workspaceRoot: root, pathEnv: '', platform: 'linux' });
    expect(result).toEqual({ interpreterPath: rootExe, interpreterSource: 'venv' });
    rm(root);
  });
});

describe('profile interpreter recording (IDE-PRJ-004)', () => {
  it('saves the interpreter with its source and reads it back', async () => {
    const store = new ProjectProfileStore(new MemoryMemento());
    const profile = await store.create({
      displayName: '主线',
      assetsRoot: '/ws/assets',
      engineRoot: '/ws/kbe'
    });
    // 未记录时是缺失状态
    expect(profile.interpreterPath).toBeNull();
    expect(profile.interpreterSource).toBe('missing');

    const saved = await store.saveInterpreter(profile.id, {
      interpreterPath: '/usr/bin/python3',
      interpreterSource: 'path'
    });
    expect(saved).toMatchObject({
      id: profile.id,
      interpreterPath: '/usr/bin/python3',
      interpreterSource: 'path'
    });
    // 同一持久层重开 store 读回同样字段
    expect(store.get(profile.id)).toMatchObject({
      interpreterPath: '/usr/bin/python3',
      interpreterSource: 'path'
    });
  });

  it('shows the missing state explicitly in the display text', () => {
    expect(
      describeInterpreterState({ interpreterPath: '/usr/bin/python3', interpreterSource: 'path' })
    ).toBe(`Python interpreter: /usr/bin/python3 (source: ${interpreterSourceLabels().path})`);
    expect(describeInterpreterState({ interpreterPath: null, interpreterSource: 'missing' })).toBe(
      'Python interpreter: missing (no python3/python found; set kbengine.python.interpreterPath, or create a venv in the workspace via kbengine.python.venvDirectories, defaults .venv/venv/.kbenv)'
    );
  });

  it('normalizes old records without interpreter fields instead of dropping them', async () => {
    const memento = new MemoryMemento();
    await memento.update(PROJECT_PROFILES_STATE_KEY, [
      { id: 'p1', displayName: '旧记录', assetsRoot: '/ws/a', engineRoot: '/ws/e' }
    ]);

    const store = new ProjectProfileStore(memento);
    const profiles = store.list();
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({
      id: 'p1',
      interpreterPath: null,
      interpreterSource: 'missing'
    });
  });
});
