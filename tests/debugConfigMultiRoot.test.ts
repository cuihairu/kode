import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import type * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DebugConfigManager } from '../src/debugConfig';
import { resolveManagerWorkspaceRoot } from '../src/backend/debugConfigBootstrap';
import {
  RelativePattern,
  Uri,
  allFileSystemWatchers,
  memoryFileSystem,
  workspace as stubWorkspace,
  workspaceState
} from './helpers/vscodeStub';

// RUST-065(旧 BUILD-016):插件/缓存/临时文件路径兼容多工作区——debug.json
// 读写/watch、launch.json 写入、pathMappings 默认值、debugpy 预检根全部经既有
// 生效根链(KBENGINE_WORKSPACE > 文件 workspaceRoot > 首个工作区根)裁定,不再
// 散落「首个工作区根」硬编码;多根工作区或生效根在工作区外(KBENGINE_WORKSPACE
// 指向)时读写不落错根。文件面走 fake-vscode 内存 fs,路径语义真实。

interface MementoLike {
  get<T>(key: string, defaultValue?: T): T | undefined;
  update(key: string, value: unknown): Promise<void>;
  keys(): readonly string[];
  setKeysForSync(keys: readonly string[]): void;
}

const noopMemento: MementoLike = {
  get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue,
  update: async () => undefined,
  keys: () => [],
  setKeysForSync: () => undefined
};

type ManagerDeps = ConstructorParameters<typeof DebugConfigManager>[1];

const makeManager = (
  resolveWorkspaceRoot?: () => string | null,
  workspaceStateOverride?: MementoLike
): DebugConfigManager =>
  new DebugConfigManager(
    {
      subscriptions: [],
      workspaceState: workspaceStateOverride ?? noopMemento
    } as unknown as vscode.ExtensionContext,
    (resolveWorkspaceRoot ? { resolveWorkspaceRoot } : {}) as ManagerDeps
  );

interface FolderLike {
  fsPath: string;
  name?: string;
}

const setFolders = (fsPaths: readonly (string | FolderLike)[]): void => {
  stubWorkspace.workspaceFolders = fsPaths.map((item, index) => {
    const fsPath = typeof item === 'string' ? item : item.fsPath;
    const name = typeof item === 'string' ? `ws${index}` : (item.name ?? `ws${index}`);
    return { uri: Uri.file(fsPath), name, index };
  });
};

const flushAsync = () => new Promise<void>(resolve => setTimeout(resolve, 0));

const launchPath = (root: string): string => `${root}/.vscode/launch.json`;

const hasFile = (fsPath: string): boolean => memoryFileSystem.files.has(fsPath);

beforeEach(() => {
  workspaceState.reset();
  stubWorkspace.workspaceFolders = [];
  delete process.env.KBENGINE_WORKSPACE;
});

afterEach(() => {
  workspaceState.reset();
  stubWorkspace.workspaceFolders = [];
  delete process.env.KBENGINE_WORKSPACE;
});

describe('注入生效根:读/watch/写全落生效根', () => {
  it('loadConfig 读生效根的 debug.json,pathMappings 默认值同根', async () => {
    setFolders(['/ws-a']);
    memoryFileSystem.set(
      '/other/root/.kbengine/debug.json',
      JSON.stringify({ version: '1.0.0', debug: { components: { logger: { telnetPort: 34567 } } } })
    );
    const manager = makeManager(() => '/other/root');
    await flushAsync();

    // debug.json 从生效根(而非 folder[0])读入:logger 用户端口覆盖默认 34000
    expect(manager.getComponentConfig('logger').telnetPort).toBe(34567);
    // pathMappings 缺省值落生效根(旧硬编码会落 /ws-a)
    expect(manager.getComponentConfig('logger').pathMappings).toEqual([
      { localRoot: '/other/root', remoteRoot: '/other/root' }
    ]);
  }, 20_000);

  it('ensurePortLaunchConfig / updateLaunchJson 写生效根的 launch.json', async () => {
    setFolders(['/ws-a']);
    const manager = makeManager(() => '/other/root');
    await flushAsync();

    const ensured = await manager.ensurePortLaunchConfig('logger', '127.0.0.1', 40001);
    expect(ensured.ok).toBe(true);
    expect(hasFile(launchPath('/other/root'))).toBe(true);
    // 旧硬编码根不落文件
    expect(hasFile(launchPath('/ws-a'))).toBe(false);

    expect(await manager.updateLaunchJson([])).toBe(true);
    const launch = JSON.parse(
      Buffer.from(memoryFileSystem.files.get(launchPath('/other/root')) as Uint8Array).toString('utf8')
    );
    expect(Array.isArray(launch.configurations)).toBe(true);
    expect(launch.configurations.length).toBeGreaterThan(0);
  }, 20_000);

  it('createExampleConfig 落生效根托管目录(消息带目录名)', async () => {
    setFolders(['/ws-a']);
    const manager = makeManager(() => '/other/root');
    await flushAsync();

    expect(await manager.createExampleConfig()).toBe(true);
    const written = Buffer.from(
      memoryFileSystem.files.get('/other/root/.kbengine/debug.json') as Uint8Array
    ).toString('utf8');
    expect(JSON.parse(written).debug).toBeTruthy();
  }, 20_000);

  it('watchConfig:每个工作区根一个 watcher,生效根在工作区外时补盯', async () => {
    setFolders(['/ws-a', '/ws-b']);
    makeManager(() => '/other/root');
    await flushAsync();

    const patterns = allFileSystemWatchers.map(watcher => watcher.pattern).filter(
      (pattern): pattern is RelativePattern => pattern instanceof RelativePattern
    );
    const faces = patterns.map(pattern => [
      typeof pattern.base === 'string' ? pattern.base : (pattern.base as vscode.Uri).fsPath,
      pattern.pattern
    ]);
    expect(faces).toEqual([
      ['/ws-a', '.kbengine/debug.json'],
      ['/ws-b', '.kbengine/debug.json'],
      ['/other/root', '.kbengine/debug.json']
    ]);
  }, 20_000);

  it('生效根在工作区内时不再重复盯同一根', async () => {
    setFolders(['/ws-a', '/ws-b']);
    makeManager(() => '/ws-b');
    await flushAsync();

    const faces = allFileSystemWatchers
      .map(watcher => watcher.pattern)
      .filter((pattern): pattern is RelativePattern => pattern instanceof RelativePattern)
      .map(pattern => (typeof pattern.base === 'string' ? pattern.base : (pattern.base as vscode.Uri).fsPath));
    // Map 去重:两根各一个,生效根 /ws-b 已在集合内不补
    expect(faces).toEqual(['/ws-a', '/ws-b']);
  }, 20_000);
});

describe('缺省链(不注入):与激活期 ensureDebugConfig 同链', () => {
  it('KBENGINE_WORKSPACE 指根生效:读写落环境变量根', async () => {
    setFolders(['/ws-a']);
    process.env.KBENGINE_WORKSPACE = '/env-root';
    const manager = makeManager();
    await flushAsync();

    expect(await manager.updateLaunchJson([])).toBe(true);
    expect(hasFile(launchPath('/env-root'))).toBe(true);
    expect(hasFile(launchPath('/ws-a'))).toBe(false);
  }, 20_000);

  it('无 env 无 workspaceRoot:回落首个工作区根(单根行为不变)', async () => {
    setFolders(['/ws-a']);
    const manager = makeManager();
    await flushAsync();

    expect(await manager.updateLaunchJson([])).toBe(true);
    expect(hasFile(launchPath('/ws-a'))).toBe(true);
  }, 20_000);

  it('无工作区:updateLaunchJson 如实拒绝', async () => {
    setFolders([]);
    const manager = makeManager();
    await flushAsync();

    expect(await manager.updateLaunchJson([])).toBe(false);
    const ensured = await manager.ensurePortLaunchConfig('logger', '127.0.0.1', 40001);
    expect(ensured.ok).toBe(false);
    expect(ensured.detail).toContain('没有打开的工作区');
  }, 20_000);

  it('resolveManagerWorkspaceRoot:文件 workspaceRoot 指根(真实 fs 临时目录)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'kode-debug-root-'));
    try {
      mkdirSync(join(tmp, '.kbengine'), { recursive: true });
      writeFileSync(
        join(tmp, '.kbengine', 'debug.json'),
        JSON.stringify({ workspaceRoot: '/real-target' }),
        'utf8'
      );
      const resolved = resolveManagerWorkspaceRoot(
        [
          { name: 'ws0', fsPath: tmp },
          { name: 'ws1', fsPath: '/elsewhere' }
        ],
        '.kbengine'
      );
      expect(resolved?.root).toBe('/real-target');
      expect(resolved?.source).toBe('config');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('resolveManagerWorkspaceRoot:无工作区返回 null', () => {
    expect(resolveManagerWorkspaceRoot([], '.kbengine')).toBeNull();
  });
});
