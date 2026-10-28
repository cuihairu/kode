import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import {
  INTERPRETER_SOURCE_LABELS,
  describeInterpreterState,
  locateInterpreterOnPath,
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
    expect(fromSetting).toEqual({ interpreterPath: interpreter, interpreterSource: 'setting' });

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
    ).toBe(`Python 解释器: /usr/bin/python3(来源: ${INTERPRETER_SOURCE_LABELS.path})`);
    expect(describeInterpreterState({ interpreterPath: null, interpreterSource: 'missing' })).toBe(
      'Python 解释器: 缺失(未找到 python3/python,可在设置 kbengine.python.interpreterPath 指定)'
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
