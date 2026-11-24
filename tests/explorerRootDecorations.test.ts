/**
 * 双根 Explorer 角标(2026-11-24 用户需求)+ 装配(fake-vscode 同形契约)。
 *
 * 契约钉子:两轴都未识别/根不在盘/路径不命中=零装饰输出(幽灵路径不标,
 * 如实);engine=K/蓝,assets=A/橙,同目录=KA/蓝;路径同一判定分隔符/
 * 尾分隔符归一,win32 整路小写;profile 切换与 kbengine.assetsRoot /
 * kbengine.engineRoot 设置变更触发刷新;无开关门(双根是事实标记恒开,
 * FOLDER-COLOR-001 双门不适用)。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import {
  configurationOverrides,
  workspace as vscodeWorkspace,
  workspaceEvents
} from './fake-vscode/workspaceState';
import { fileDecorationRegistrations } from './fake-vscode/windowState';
import {
  ExplorerRootDecorationProvider,
  resolveExplorerRootFace,
  sameExplorerRootPath,
  type ExplorerRootDecorationDeps
} from '../src/explorerRootDecorations';
import { activateExplorerRootDecorations } from '../src/activate/explorerRoots';
import { ProjectProfileStore } from '../src/projectProfiles';
import { setActiveProfile } from '../src/activeProfile';

const ENGINE_DIR = '/ws/engine/kbe';
const ASSETS_DIR = '/ws/assets';

const makeDeps = (overrides: Partial<ExplorerRootDecorationDeps> = {}): ExplorerRootDecorationDeps => ({
  engineRoot: () => ENGINE_DIR,
  assetsRoot: () => ASSETS_DIR,
  exists: fsPath => fsPath === ENGINE_DIR || fsPath === ASSETS_DIR,
  ...overrides
});

describe('sameExplorerRootPath(路径同一判定)', () => {
  it('同串相等', () => {
    expect(sameExplorerRootPath('/ws/assets', '/ws/assets')).toBe(true);
  });

  it('尾分隔符与反斜杠归一后相等', () => {
    expect(sameExplorerRootPath('/ws/assets/', '/ws/assets')).toBe(true);
    expect(sameExplorerRootPath('\\ws\\assets', '/ws/assets', 'win32')).toBe(true);
  });

  it('win32 整路小写(盘符/目录大小写差异不误分)', () => {
    expect(sameExplorerRootPath('C:/Ws/Assets', 'c:/ws/assets', 'win32')).toBe(true);
    // 非 win32 平台大小写敏感
    expect(sameExplorerRootPath('/WS/Assets', '/ws/assets', 'linux')).toBe(false);
  });

  it('空串永不相等(未识别轴不标)', () => {
    expect(sameExplorerRootPath('', '/ws/assets')).toBe(false);
    expect(sameExplorerRootPath('', '')).toBe(false);
  });

  it('不同路径不等;子目录不是根本身', () => {
    expect(sameExplorerRootPath('/ws/assets2', '/ws/assets')).toBe(false);
    expect(sameExplorerRootPath('/ws/assets/scripts', '/ws/assets')).toBe(false);
  });
});

describe('resolveExplorerRootFace(双根面孔纯核)', () => {
  it('两轴都未识别 → undefined', () => {
    expect(
      resolveExplorerRootFace(ENGINE_DIR, makeDeps({ engineRoot: () => '', assetsRoot: () => '' }))
    ).toBeUndefined();
  });

  it('engine 根命中 → K/蓝,tooltip 带引擎标签', () => {
    const face = resolveExplorerRootFace(ENGINE_DIR, makeDeps({ assetsRoot: () => '' }))!;
    expect(face.badge).toBe('K');
    expect(face.colorId).toBe('charts.blue');
    expect(face.tooltip).toContain('engine root');
    expect(face.tooltip).not.toContain('assets root');
  });

  it('assets 根命中 → A/橙,tooltip 带资产标签', () => {
    const face = resolveExplorerRootFace(ASSETS_DIR, makeDeps({ engineRoot: () => '' }))!;
    expect(face.badge).toBe('A');
    expect(face.colorId).toBe('charts.orange');
    expect(face.tooltip).toContain('assets root');
  });

  it('同一目录双轴命中 → KA/蓝,tooltip 两标签都带', () => {
    const face = resolveExplorerRootFace(ASSETS_DIR, makeDeps({ engineRoot: () => ASSETS_DIR }))!;
    expect(face.badge).toBe('KA');
    expect(face.colorId).toBe('charts.blue');
    expect(face.tooltip).toContain('engine root');
    expect(face.tooltip).toContain('assets root');
  });

  it('根不在盘上 → 不标(幽灵路径如实不装饰)', () => {
    expect(
      resolveExplorerRootFace(ENGINE_DIR, makeDeps({ exists: () => false }))
    ).toBeUndefined();
  });

  it('非根路径(兄弟目录/子目录)→ undefined', () => {
    expect(resolveExplorerRootFace('/ws/engine', makeDeps())).toBeUndefined();
    expect(resolveExplorerRootFace(`${ASSETS_DIR}/scripts`, makeDeps())).toBeUndefined();
  });
});

describe('ExplorerRootDecorationProvider(文件树角标)', () => {
  const decorate = (provider: ExplorerRootDecorationProvider, fsPath: string) =>
    provider.provideFileDecoration(vscode.Uri.file(fsPath), new vscode.CancellationToken());

  it('engine 根目录 → FileDecoration(badge/ThemeColor/tooltip)', () => {
    const provider = new ExplorerRootDecorationProvider(makeDeps());
    const decoration = decorate(provider, ENGINE_DIR)!;
    expect(decoration.badge).toBe('K');
    expect(decoration.color).toBeInstanceOf(vscode.ThemeColor);
    expect((decoration.color as vscode.ThemeColor).id).toBe('charts.blue');
    expect(decoration.tooltip).toContain('engine root');
  });

  it('非根路径 → 零装饰输出', () => {
    const provider = new ExplorerRootDecorationProvider(makeDeps());
    expect(decorate(provider, '/ws/README.md')).toBeUndefined();
  });

  it('refresh() 通知重渲染(onDidChangeFileDecorations 触发)', () => {
    const provider = new ExplorerRootDecorationProvider(makeDeps());
    const fired: unknown[] = [];
    provider.onDidChangeFileDecorations(value => fired.push(value));
    provider.refresh();
    expect(fired.length).toBe(1);
    provider.dispose();
  });
});

describe('activateExplorerRootDecorations(装配)', () => {
  let root = '';

  /** 内存 memento(databaseDriftCommand 同款);fake workspaceState 聚合体非 Memento */
  class MemoryMemento {
    private readonly map = new Map<string, unknown>();
    get<T>(key: string, defaultValue?: T): T | undefined {
      return this.map.has(key) ? (this.map.get(key) as T) : defaultValue;
    }
    update(key: string, value: unknown): Promise<void> {
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

  beforeEach(() => {
    vscodeWorkspace.workspaceFolders = [];
    configurationOverrides.clear();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-root-badge-'));
    fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const makeContext = () =>
    ({
      subscriptions: [],
      workspaceState: new MemoryMemento()
    }) as never;

  it('注册 provider 进 subscriptions(fileDecorationRegistrations 入账)', () => {
    const before = fileDecorationRegistrations.length;
    const context = makeContext();
    const provider = activateExplorerRootDecorations(context);
    expect(fileDecorationRegistrations.length).toBe(before + 1);
    expect((context as { subscriptions: unknown[] }).subscriptions.length).toBeGreaterThanOrEqual(4);
    expect(provider).toBeInstanceOf(ExplorerRootDecorationProvider);
  });

  it('profile 切换 → 刷新;assets 根目录出 A 角标(profile 字段直供)', async () => {
    const memento = new MemoryMemento();
    const context = { subscriptions: [], workspaceState: memento } as never;
    const provider = activateExplorerRootDecorations(context);
    const assets = path.join(root, 'assets');
    const store = new ProjectProfileStore(memento as never);
    const profile = await store.create({ displayName: 'P', assetsRoot: assets, engineRoot: '' });

    const fired: unknown[] = [];
    provider.onDidChangeFileDecorations(value => fired.push(value));
    await setActiveProfile(memento as never, profile.id);
    expect(fired.length).toBe(1);

    // provider 的 deps 读活动 profile:assets 根命中,即使工作区设置链为空
    expect(
      provider.provideFileDecoration(vscode.Uri.file(assets), new vscode.CancellationToken())!.badge
    ).toBe('A');
    expect(
      provider.provideFileDecoration(vscode.Uri.file(path.join(root, 'engine', 'kbe')), new vscode.CancellationToken())
    ).toBeUndefined();
  });

  it('kbengine.assetsRoot 设置变更 → 刷新;无关 section 不刷新', () => {
    const context = makeContext();
    const provider = activateExplorerRootDecorations(context);
    const fired: unknown[] = [];
    provider.onDidChangeFileDecorations(value => fired.push(value));

    workspaceEvents.configurationChanged.fire({ affectsConfiguration: s => s === 'kbengine.assetsRoot' });
    expect(fired.length).toBe(1);
    workspaceEvents.configurationChanged.fire({ affectsConfiguration: s => s === 'kbengine.folderColors' });
    expect(fired.length).toBe(1);
    workspaceEvents.configurationChanged.fire({
      affectsConfiguration: s => s === 'kbengine.engineRoot'
    });
    expect(fired.length).toBe(2);
  });

  it('空轴回退 kbengine.* 同名设置(设置链命中同样出角标)', () => {
    const context = makeContext();
    const provider = activateExplorerRootDecorations(context);
    configurationOverrides.set('kbengine', { assetsRoot: path.join(root, 'assets') });
    const decoration = provider.provideFileDecoration(
      vscode.Uri.file(path.join(root, 'assets')),
      new vscode.CancellationToken()
    )!;
    expect(decoration.badge).toBe('A');
  });
});
