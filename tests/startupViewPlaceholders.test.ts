import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import packageJson from '../package.json';
import { activate } from '../src/extension';
import { getOperationSummary, resetLanguageServiceMetrics } from '../src/languageServiceMetrics';
import {
  getActiveProfileScanRoot,
  resetScanRootCache,
  setActiveProfileScanRoot
} from '../src/scanRoots';
import { setActiveProfile } from '../src/activeProfile';
import { PythonClassIndex } from '../src/pythonClassIndex';
import { EntityMappingManager } from '../src/entityMapping';
import { getRootConfigGeneration } from '../src/rootConfigGeneration';
import { isExcludedScanPath, isPathWithin } from '../src/indexWatcherScope';
import {
  KBENGINE_SIDEBAR_VIEW_IDS,
  STARTUP_VIEW_PLACEHOLDER_MARKER,
  registerStartupViewPlaceholders
} from '../src/startupViewPlaceholders';
import { commandRegistry } from './fake-vscode/commandRegistry';
import { treeRegistrations, windowState } from './fake-vscode/windowState';
import {
  workspace,
  workspaceEvents,
  workspaceState,
  configurationOverrides
} from './fake-vscode/workspaceState';
import { Uri, type ExtensionContext } from './fake-vscode/core';

interface DeclaredPackageJson {
  contributes: {
    views: Record<string, Array<{ id: string }>>;
  };
}

const declaredViewIds: string[] = Object.values(
  (packageJson as unknown as DeclaredPackageJson).contributes.views
)
  .flat()
  .map(view => view.id)
  .sort();

const makeContext = (): ExtensionContext => ({
  subscriptions: [],
  extensionUri: Uri.file('/workspace/ext'),
  extensionPath: path.resolve(__dirname, '..'),
  extension: { extensionKind: 'workspace' }
});

const disposeAll = (context: ExtensionContext): void => {
  for (const disposable of context.subscriptions) {
    disposable.dispose();
  }
};

beforeEach(() => {
  commandRegistry.reset();
  resetLanguageServiceMetrics();
  windowState.reset();
  workspaceState.reset();
  workspace.workspaceFolders = [];
  workspace.findFiles = async () => [] as ReturnType<typeof Uri.file>[];
});

afterEach(() => {
  vi.restoreAllMocks();
});

// KODE-PERF 激活排查(用户现场:KBEngine Explorer 全部视图空,宿主提示
// 「There is no data provider registered that can provide view data」)——
// 该提示 = 视图 id 对应的数据提供者尚未注册(activate 同步体晚段才注册,
// 中途任何一步抛错/被重活拖死,视图就停在无提供者状态)。本面锁定:
// ① 占位注册面覆盖 package.json 声明的全部侧栏视图 id;
// ② 激活中途失败时十个视图也已先行注册(占位兜底,真 provider 随后接管);
// ③ 正常激活下每个视图恰两笔注册(占位 + 真 provider)。

describe('KODE-PERF 视图先行:侧栏视图占位注册', () => {
  it('占位注册面覆盖 package.json 声明的全部侧栏视图 id', () => {
    const registered: string[] = [];
    const registration = registerStartupViewPlaceholders({
      registerTreeDataProvider: (viewId, _provider) => {
        registered.push(viewId);
        return { dispose: () => undefined };
      }
    });
    registration.dispose();
    expect([...registered].sort()).toEqual(declaredViewIds);
    expect(registered).toHaveLength(KBENGINE_SIDEBAR_VIEW_IDS.length);
  });

  it('占位 provider 在真 provider 接管前 getChildren 返回空数组', () => {
    let placeholder: unknown;
    const registration = registerStartupViewPlaceholders({
      registerTreeDataProvider: (viewId, provider) => {
        if (viewId === 'kbengine.entityExplorer') { placeholder = provider; }
        return { dispose: () => undefined };
      }
    });
    const provider = placeholder as { getChildren(): unknown[] };
    expect(provider.getChildren()).toEqual([]);
    registration.dispose();
  });

  it('激活中途失败(watcher 创建抛错)时十个侧栏视图仍已注册(修前红)', () => {
    const context = makeContext();
    vi.spyOn(workspace, 'createFileSystemWatcher').mockImplementation(() => {
      throw new Error('injected watcher failure');
    });
    let activateError: unknown = null;
    try {
      activate(context);
    } catch (error) {
      activateError = error;
    }
    // 激活同步体确实在中途抛了错(故障注入成立)
    expect((activateError as Error | null)?.message).toBe('injected watcher failure');
    // 但视图占位注册已先行落位——宿主不再报「There is no data provider registered」
    expect([...new Set(treeRegistrations.map(item => item.viewId))].sort())
      .toEqual(declaredViewIds);
    disposeAll(context);
  });

  it('激活完成后每个视图 id 恰有两笔注册(占位先行 + 真 provider 接管)', () => {
    const context = makeContext();
    try {
      activate(context);
      const registrationsByView = new Map<string, Array<{ provider: unknown }>>();
      for (const entry of treeRegistrations) {
        const list = registrationsByView.get(entry.viewId) ?? [];
        list.push(entry);
        registrationsByView.set(entry.viewId, list);
      }
      const isPlaceholder = (provider: unknown): boolean =>
        Boolean((provider as Record<string, unknown>)?.[STARTUP_VIEW_PLACEHOLDER_MARKER]);
      for (const viewId of declaredViewIds) {
        const list = registrationsByView.get(viewId) ?? [];
        expect(list, `${viewId} 占位+接管两笔`).toHaveLength(2);
        // 首笔=占位(带标记),末笔=真 provider(无标记,且与占位不同对象)
        expect(isPlaceholder(list[0]?.provider), `${viewId} 首笔应为占位`).toBe(true);
        expect(isPlaceholder(list[1]?.provider), `${viewId} 末笔应为真接管者`).toBe(false);
        expect(list[1]?.provider).not.toBe(list[0]?.provider);
      }
    } finally {
      disposeAll(context);
    }
  });
});

describe('KODE-PERF 重复扫描抑制:watcher 同签名重建跳过 + 排除目录事件过滤', () => {
  it('无实质变化的工作区事件不再拆除重建整组 watcher(修前红)', () => {
    const context = makeContext();
    const originalCreate = workspace.createFileSystemWatcher;
    let createCalls = 0;
    vi.spyOn(workspace, 'createFileSystemWatcher').mockImplementation(((pattern: unknown) => {
      createCalls += 1;
      return originalCreate.call(workspace, pattern as never);
    }) as typeof originalCreate);
    try {
      workspace.workspaceFolders = [{ uri: Uri.file('/ws'), name: 'ws', index: 0 }];
      activate(context);
      const afterActivate = createCalls;
      expect(afterActivate).toBeGreaterThan(0);
      // 空变化事件(removed/added 皆空)→ 根集签名不变 → 不重建
      workspaceEvents.foldersChanged.fire({ added: [], removed: [] });
      expect(createCalls).toBe(afterActivate);
    } finally {
      disposeAll(context);
    }
  });

  it('排除目录(node_modules)下的文件事件不再流入 Python 索引消费面(修前红)', () => {
    const context = makeContext();
    const originalCreate = workspace.createFileSystemWatcher;
    const watchers: Array<{ fireCreate: (uri: ReturnType<typeof Uri.file>) => void }> = [];
    vi.spyOn(workspace, 'createFileSystemWatcher').mockImplementation(((pattern: unknown) => {
      const watcher = originalCreate.call(workspace, pattern as never);
      watchers.push(watcher as never);
      return watcher;
    }) as typeof originalCreate);
    // 三轮评审修复回归面:工作区自身祖先含排除名(out)——只查根以下段,
    // 根下业务脚本不受祖先连坐
    const outerBase = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-excl-outer-'));
    const wsUnderOut = path.join(outerBase, 'out', 'proj');
    fs.mkdirSync(wsUnderOut, { recursive: true });
    try {
      workspace.workspaceFolders = [{ uri: Uri.file(wsUnderOut), name: 'ws', index: 0 }];
      activate(context);
      const workspaceWatcher = watchers[0];
      expect(workspaceWatcher).toBeTruthy();
      const onFileChanged = vi.spyOn(PythonClassIndex.prototype, 'onFileChanged')
        .mockResolvedValue(undefined);
      workspaceWatcher.fireCreate(Uri.file(path.join(wsUnderOut, 'node_modules', 'pkg', 'lib.py')));
      expect(onFileChanged, '排除目录事件在 watcher 出口被丢弃').not.toHaveBeenCalled();
      // 根下同名排除段照旧丢弃;祖先含排除名不连坐(三轮评审修复)
      workspaceWatcher.fireCreate(Uri.file(path.join(wsUnderOut, 'out', 'lib.py')));
      expect(onFileChanged, '根下排除段仍丢弃').not.toHaveBeenCalled();
      workspaceWatcher.fireCreate(Uri.file(path.join(wsUnderOut, 'scripts', 'cell', 'Avatar.py')));
      expect(onFileChanged, '祖先含排除名不得连坐根下业务脚本')
        .toHaveBeenCalledWith(path.join(wsUnderOut, 'scripts', 'cell', 'Avatar.py'));
    } finally {
      disposeAll(context);
      vi.restoreAllMocks();
      fs.rmSync(outerBase, { recursive: true, force: true });
    }
  });

  describe('isExcludedScanPath(三轮评审修复:根作用域 + 大小写不敏感)', () => {
    it('只检查监视根以下的段:根祖先含排除名不连坐', () => {
      const roots = ['/home/user/out/proj', '/home/user/out/proj/assets'];
      expect(isExcludedScanPath('/home/user/out/proj/scripts/Avatar.py', roots)).toBe(false);
      expect(isExcludedScanPath('/home/user/out/proj/node_modules/lib.py', roots)).toBe(true);
      expect(isExcludedScanPath('/home/user/out/proj/assets/build/x.py', roots)).toBe(true);
    });

    it('大小写不敏感(Windows 口径,显式开启)且接受反斜杠路径', () => {
      const roots = ['C:\\Work\\Proj'];
      expect(isExcludedScanPath('c:\\work\\proj\\Node_Modules\\lib.py', roots, true)).toBe(true);
      expect(isExcludedScanPath('C:/WORK/PROJ/scripts/Avatar.py', roots, true)).toBe(false);
    });

    it('POSIX 大小写敏感:仅大小写不同的段不作排除命中(四轮评审修复)', () => {
      const roots = ['/ws'];
      expect(isExcludedScanPath('/ws/Node_Modules/lib.py', roots)).toBe(false);
      expect(isExcludedScanPath('/ws/node_modules/lib.py', roots)).toBe(true);
    });

    it('路径不在任何已知根下时退回整径段检查(旧口径兜底)', () => {
      expect(isExcludedScanPath('/elsewhere/node_modules/lib.py', ['/ws'])).toBe(true);
      expect(isExcludedScanPath('/elsewhere/scripts/Avatar.py', ['/ws'])).toBe(false);
    });
  });

  describe('isPathWithin(四轮评审修复:摘根保留子树的包含判定)', () => {
    it('相等与真包含为真,同前缀不同段为假', () => {
      expect(isPathWithin('/a/scripts', '/a')).toBe(true);
      expect(isPathWithin('/a', '/a')).toBe(true);
      expect(isPathWithin('/ab', '/a')).toBe(false);
      expect(isPathWithin('/a/scripts', '/a2')).toBe(false);
    });

    it('显式大小写不敏感(Windows 口径)', () => {
      expect(isPathWithin('/A/Scripts', '/a', true)).toBe(true);
      expect(isPathWithin('/A/Scripts', '/a')).toBe(false);
    });
  });

  it('重复的相同 assetsRoot 通知不再触发整库失效(修前红)', () => {
    const assets = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-dup-notify-'));
    const context = makeContext();
    configurationOverrides.set('kbengine', { assetsRoot: assets });
    const invalidate = vi.spyOn(PythonClassIndex.prototype, 'invalidate')
      .mockImplementation(() => undefined);
    try {
      workspace.workspaceFolders = [{ uri: Uri.file('/ws'), name: 'ws', index: 0 }];
      activate(context);
      const fireAssetsRootChanged = (): void => {
        workspaceEvents.configurationChanged.fire({
          affectsConfiguration: section =>
            section === 'kbengine' || section === 'kbengine.assetsRoot'
        });
      };
      // 两次相同配置通知(重复 fire):根集签名不变 → 零整库失效、零 watcher
      // 重建、零 generation 前进(三轮评审修复:重复 bump 会作废在途实体扫描)
      const generationBefore = getRootConfigGeneration();
      fireAssetsRootChanged();
      fireAssetsRootChanged();
      expect(invalidate, '重复通知不得整库失效').not.toHaveBeenCalled();
      expect(getRootConfigGeneration(), '重复通知不得前进 root generation')
        .toBe(generationBefore);
    } finally {
      disposeAll(context);
      invalidate.mockRestore();
      configurationOverrides.delete('kbengine');
      fs.rmSync(assets, { recursive: true, force: true });
    }
  });

  it('assetsRoot 真实切换仍触发一次失效与 watcher 重建(不误伤真变化)', () => {
    const assetsA = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-real-a-'));
    const assetsB = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-real-b-'));
    const context = makeContext();
    configurationOverrides.set('kbengine', { assetsRoot: assetsA });
    const invalidate = vi.spyOn(PythonClassIndex.prototype, 'invalidate')
      .mockImplementation(() => undefined);
    const removeRoot = vi.spyOn(EntityMappingManager.prototype, 'removeRoot')
      .mockImplementation(() => undefined);
    const originalCreate = workspace.createFileSystemWatcher;
    let createCalls = 0;
    vi.spyOn(workspace, 'createFileSystemWatcher').mockImplementation(((pattern: unknown) => {
      createCalls += 1;
      return originalCreate.call(workspace, pattern as never);
    }) as typeof originalCreate);
    try {
      workspace.workspaceFolders = [{ uri: Uri.file('/ws'), name: 'ws', index: 0 }];
      activate(context);
      const afterActivate = createCalls;
      const fireAssetsRootChanged = (): void => {
        workspaceEvents.configurationChanged.fire({
          affectsConfiguration: section =>
            section === 'kbengine' || section === 'kbengine.assetsRoot'
        });
      };
      const generationBefore = getRootConfigGeneration();
      configurationOverrides.set('kbengine', { assetsRoot: assetsB });
      fireAssetsRootChanged();
      expect(invalidate, '真实根切换整库失效恰好一次').toHaveBeenCalledTimes(1);
      expect(createCalls, '真实根切换重建 watcher 组').toBeGreaterThan(afterActivate);
      // 三轮评审修复回归面:旧根 A 定向摘除,新根 B 不摘(修前红:对照基线
      // 取现读根集,A→B 比出 B==B,旧根永不摘除);generation 恰前进一次。
      // 四轮评审修复:不相交根切换 keepSubtrees 为空(第二实参空数组)
      expect(removeRoot, '真实切换摘除旧根 A(无保留子树)').toHaveBeenCalledWith(assetsA, []);
      expect(removeRoot, '真实切换不得摘除新根 B').not.toHaveBeenCalledWith(assetsB);
      expect(getRootConfigGeneration(), '真实切换 generation 恰前进一次')
        .toBe(generationBefore + 1);
    } finally {
      disposeAll(context);
      invalidate.mockRestore();
      vi.restoreAllMocks();
      configurationOverrides.delete('kbengine');
      fs.rmSync(assetsA, { recursive: true, force: true });
      fs.rmSync(assetsB, { recursive: true, force: true });
    }
  });

  it('根切换到自身子目录:摘除收窄到保留子树之外,子根数据不连带摘掉(四轮评审修复,修前红)', async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-nest-parent-'));
    const child = path.join(parent, 'assets');
    fs.mkdirSync(path.join(child, 'entity_defs'), { recursive: true });
    fs.mkdirSync(path.join(parent, 'legacy'), { recursive: true });
    fs.writeFileSync(path.join(child, 'entity_defs', 'Avatar0.def'), '<root>\n</root>\n');
    fs.writeFileSync(path.join(parent, 'legacy', 'Old.def'), '<root>\n</root>\n');
    const context = makeContext();
    configurationOverrides.set('kbengine', { assetsRoot: parent });
    workspace.findFiles = (async () => [
      Uri.file(path.join(child, 'entity_defs', 'Avatar0.def')),
      Uri.file(path.join(parent, 'legacy', 'Old.def'))
    ]) as typeof workspace.findFiles;
    const removeRoot = vi.spyOn(EntityMappingManager.prototype, 'removeRoot');
    const managerRef: { current: EntityMappingManager | null } = { current: null };
    const originalEnsure = EntityMappingManager.prototype.ensureStartup;
    vi.spyOn(EntityMappingManager.prototype, 'ensureStartup').mockImplementation(
      function (this: EntityMappingManager) {
        managerRef.current = this;
        return originalEnsure.apply(this);
      }
    );
    const until = async (predicate: () => boolean): Promise<void> => {
      const deadline = Date.now() + 8000;
      while (!predicate()) {
        if (Date.now() > deadline) { throw new Error('condition not met before deadline'); }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    };
    try {
      workspace.workspaceFolders = [{ uri: Uri.file('/ws'), name: 'ws', index: 0 }];
      activate(context);
      await until(() => managerRef.current !== null);
      const manager = managerRef.current;
      expect(manager, '捕获 EntityMappingManager').not.toBeNull();
      await until(() => getOperationSummary('entity-mapping-scan') !== null);
      const semantic = manager!.getSemanticIndex();
      await until(() => semantic.findEntityByName('Avatar0') !== null);
      await until(() => semantic.findEntityByName('Old') !== null);
      configurationOverrides.set('kbengine', { assetsRoot: child });
      workspaceEvents.configurationChanged.fire({
        affectsConfiguration: section =>
          section === 'kbengine' || section === 'kbengine.assetsRoot'
      });
      // 修前红:removeRoot(parent) 整摘父根,把仍在根集内的子根 child 数据
      // 连带摘掉且无扫描接替;修后摘除按 keepSubtrees=[child] 收窄
      expect(removeRoot, '父根摘除携带保留子树 child')
        .toHaveBeenCalledWith(parent, [child]);
      expect(semantic.findEntityByName('Avatar0'), '保留子树内实体不得连带摘除')
        .not.toBeNull();
      expect(semantic.findEntityByName('Old'), '保留子树外的旧记录仍被摘除').toBeNull();
    } finally {
      disposeAll(context);
      vi.restoreAllMocks();
      configurationOverrides.delete('kbengine');
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it('watcher 组创建中途失败:签名不提交旧组保留,下次事件可重试(四轮评审修复,修前红)', () => {
    const assetsA = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-fail-a-'));
    const assetsB = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-fail-b-'));
    const context = makeContext();
    configurationOverrides.set('kbengine', { assetsRoot: assetsA });
    const invalidate = vi.spyOn(PythonClassIndex.prototype, 'invalidate')
      .mockImplementation(() => undefined);
    const originalCreate = workspace.createFileSystemWatcher;
    const fireAssetsRootChanged = (): void => {
      workspaceEvents.configurationChanged.fire({
        affectsConfiguration: section =>
          section === 'kbengine' || section === 'kbengine.assetsRoot'
      });
    };
    const spyCreate = vi.spyOn(workspace, 'createFileSystemWatcher').mockImplementation(
      ((pattern: unknown) => {
        if (JSON.stringify(pattern).includes(assetsB)) {
          throw new Error('watcher create boom');
        }
        return originalCreate.call(workspace, pattern as never);
      }) as typeof originalCreate
    );
    const removeRoot = vi.spyOn(EntityMappingManager.prototype, 'removeRoot');
    try {
      workspace.workspaceFolders = [{ uri: Uri.file('/ws'), name: 'ws', index: 0 }];
      activate(context);
      const generationBefore = getRootConfigGeneration();
      // 新根 B 的 watcher 创建中途抛错:整组装载失败,异常上抛(与旧实现一致),
      // 但签名/基线不得提交——旧组完整保留,同签名守卫不得挡死后续重试
      expect(() => {
        configurationOverrides.set('kbengine', { assetsRoot: assetsB });
        fireAssetsRootChanged();
      }).toThrow('watcher create boom');
      expect(invalidate, '装载失败不得进入失效序列').not.toHaveBeenCalled();
      // 五轮评审修复:装载先行——创建失败时根数据未摘、generation 未 bump
      // (修前红:先 bump+摘根再装载,失败后数据摘了但守卫挡死重建,旧根数据
      // 持续缺失)。旧根实体数据完整保留。
      expect(removeRoot, '装载失败不得摘除任何根').not.toHaveBeenCalled();
      expect(getRootConfigGeneration(), '装载失败不得推进 root generation')
        .toBe(generationBefore);
      // 四轮评审修复:创建失败不重置签名基线——失败后回到旧配置 A(签名从未
      // 离开 A)时同签名守卫挡下不必要的重建(修前红:置 null 会重建一次);
      // 摘根基线仍是「仍在装载的 A 组」,不误判根变化
      spyCreate.mockRestore();
      configurationOverrides.set('kbengine', { assetsRoot: assetsA });
      fireAssetsRootChanged();
      expect(removeRoot, '回设 A = 根集未变,零摘除').not.toHaveBeenCalled();
      expect(invalidate, '失败后回旧配置:签名未变,零整库失效(四轮评审修复)')
        .toHaveBeenCalledTimes(0);
      expect(getRootConfigGeneration(), '回设 A 不得推进 generation')
        .toBe(generationBefore);
      // 再次尝试新配置 B:签名 B≠A → 不被守卫挡死,重建成功并照常失效
      configurationOverrides.set('kbengine', { assetsRoot: assetsB });
      fireAssetsRootChanged();
      expect(invalidate, '再次尝试新配置照常整库失效恰好一次').toHaveBeenCalledTimes(1);
      expect(removeRoot, '再次尝试 B 时摘除旧根 A').toHaveBeenCalledWith(assetsA, []);
    } finally {
      disposeAll(context);
      invalidate.mockRestore();
      vi.restoreAllMocks();
      configurationOverrides.delete('kbengine');
      fs.rmSync(assetsA, { recursive: true, force: true });
      fs.rmSync(assetsB, { recursive: true, force: true });
    }
  });
});

describe('KODE-PERF 抑制③:重复通知不得摘除活索引数据(评审回归面)', () => {
  const until = async (predicate: () => boolean, timeoutMs = 8000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) {
        throw new Error('condition not met before deadline');
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };

  const makeAssets = (entityCount = 1): string => {
    const assets = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-suppress-assets-'));
    fs.mkdirSync(path.join(assets, 'entity_defs'), { recursive: true });
    fs.mkdirSync(path.join(assets, 'scripts', 'base'), { recursive: true });
    for (let i = 0; i < entityCount; i += 1) {
      fs.writeFileSync(
        path.join(assets, 'entity_defs', `Avatar${i}.def`),
        '<root>\n</root>\n'
      );
    }
    fs.writeFileSync(path.join(assets, 'scripts', 'base', 'Avatar.py'), 'class Avatar:\n    pass\n');
    return assets;
  };

  const stubFindFiles = (assets: string, entityCount = 1): void => {
    workspace.findFiles = (async (include: string) => {
      if (include.includes('*.def')) {
        return Array.from({ length: entityCount }, (_, i) =>
          Uri.file(path.join(assets, 'entity_defs', `Avatar${i}.def`)));
      }
      if (include.includes('*.py')) {
        return [Uri.file(path.join(assets, 'scripts', 'base', 'Avatar.py'))];
      }
      return [];
    }) as typeof workspace.findFiles;
  };

  /** 捕获 activate 内部构造的 EntityMappingManager(实体注册表自持在该实例) */
  const captureManager = (): Array<() => EntityMappingManager | null> => {
    let managerRef: EntityMappingManager | null = null;
    const originalEnsure = EntityMappingManager.prototype.ensureStartup;
    vi.spyOn(EntityMappingManager.prototype, 'ensureStartup').mockImplementation(
      function (this: EntityMappingManager) {
        // eslint-disable-next-line @typescript-eslint/no-this-alias -- 捕获 activate 内构造的实例
        managerRef = this;
        return originalEnsure.apply(this);
      }
    );
    // 还原交给 afterEach 的 vi.restoreAllMocks()
    return [() => managerRef, () => vi.restoreAllMocks()];
  };

  it('重复 assetsRoot 通知不丢失实体——含首扫在途时到达的通知(修前红)', async () => {
    const assets = makeAssets(24);
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-suppress-ws-'));
    configurationOverrides.set('kbengine', { assetsRoot: assets });
    stubFindFiles(assets, 24);
    const context = makeContext();
    const [getManager, restoreCapture] = captureManager();
    try {
      workspace.workspaceFolders = [{ uri: Uri.file(ws), name: 'ws', index: 0 }];
      activate(context);
      await until(() => getOperationSummary('entity-mapping-scan') !== null);
      const manager = getManager();
      expect(manager, '捕获激活内 EntityMappingManager').not.toBeNull();
      // 首扫在途即发相同配置重复通知×2(三轮评审修复回归面):根集未变 →
      // 不得 bump generation——代闸作废在途扫描批次且签名未变不重建 = 无新
      // 扫描接替,实体面数据丢失路径。首扫必须照常落地。
      const fire = (): void => {
        workspaceEvents.configurationChanged.fire({
          affectsConfiguration: section =>
            section === 'kbengine' || section === 'kbengine.assetsRoot'
        });
      };
      fire();
      fire();
      await until(() => manager!.getSemanticIndex().findEntityByName('Avatar0') !== null, 8000);
      await until(() => manager!.getSemanticIndex().findEntityByName('Avatar23') !== null, 8000);
      expect(manager!.getSemanticIndex().findEntityByName('Avatar0'), '重复通知不得摘除活实体')
        .not.toBeNull();
      expect(manager!.getSemanticIndex().findEntityByName('Avatar23'), '在途批次不得被作废')
        .not.toBeNull();
    } finally {
      restoreCapture();
      for (const disposable of context.subscriptions) { disposable.dispose(); }
      configurationOverrides.delete('kbengine');
      resetScanRootCache();
      setActiveProfileScanRoot(null);
      fs.rmSync(assets, { recursive: true, force: true });
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 12000);

  it('profile 切换父根→子根:摘除按 keepSubtrees 收窄,子树数据不连带摘掉(四轮评审修复,修前红)', async () => {
    // profile 的 assetsRoot 是 workspace 之外的外部扫描根,父根→子根切换
    // (dirParent → dirChild)时旧父根退出根集,但子根仍在根集内——
    // removeRoot(父) 不得把仍在根集内的子根数据连带摘掉(修前红:profile 路径
    // 直接 removeRoot(oldRoot) 整摘父根;修后按 keepSubtrees 口径收窄)。
    const dirParent = makeAssets();
    const dirChild = path.join(dirParent, 'assets');
    fs.mkdirSync(path.join(dirChild, 'entity_defs'), { recursive: true });
    fs.mkdirSync(path.join(dirParent, 'legacy'), { recursive: true });
    fs.writeFileSync(path.join(dirChild, 'entity_defs', 'Avatar0.def'), '<root>\n</root>\n');
    fs.writeFileSync(path.join(dirParent, 'legacy', 'Old.def'), '<root>\n</root>\n');
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-suppress-pn-'));
    const map = new Map<string, unknown>([
      ['kbengine.projectProfiles.v1', [
        { id: 'pParent', displayName: 'Parent', assetsRoot: dirParent, engineRoot: '', interpreterPath: null, interpreterSource: 'missing' },
        { id: 'pChild', displayName: 'Child', assetsRoot: dirChild, engineRoot: '', interpreterPath: null, interpreterSource: 'missing' }
      ]],
      ['kbengine.activeProfileId.v1', 'pParent']
    ]);
    const mementoLike = {
      get: <T,>(key: string, defaultValue?: T): T | undefined =>
        map.has(key) ? (map.get(key) as T) : defaultValue,
      update: (key: string, value: unknown): Promise<void> => {
        map.set(key, value);
        return Promise.resolve();
      }
    };
    workspace.findFiles = (async () => []) as typeof workspace.findFiles;
    const context = { ...makeContext(), workspaceState: mementoLike } as unknown as ReturnType<typeof makeContext>;
    const removeRoot = vi.spyOn(EntityMappingManager.prototype, 'removeRoot');
    try {
      workspace.workspaceFolders = [{ uri: Uri.file(ws), name: 'ws', index: 0 }];
      activate(context);
      expect(getActiveProfileScanRoot()).toBe(dirParent);
      // 真切到子根 profile:旧父根退出根集,子根仍在根集内 → 摘除按
      // keepSubtrees=[dirChild] 收窄(修前红:profile 路径直接 removeRoot(父),
      // 把仍在根集内的子根数据连带摘掉)。摘除在 profile 事件处理器内同步执行,
      // 不依赖首扫落地。
      await setActiveProfile(mementoLike, 'pChild');
      await new Promise(resolve => setTimeout(resolve, 60));
      expect(removeRoot, 'profile 父根摘除携带保留子树 dirChild')
        .toHaveBeenCalledWith(dirParent, [dirChild]);
      const removeCalls = (removeRoot.mock.calls as unknown[][]).map(call => call[0]);
      expect(removeCalls, '旧父根恰摘除一次').toEqual([dirParent]);
    } finally {
      for (const disposable of context.subscriptions) { disposable.dispose(); }
      removeRoot.mockRestore();
      resetScanRootCache();
      setActiveProfileScanRoot(null);
      resetLanguageServiceMetrics();
      fs.rmSync(dirParent, { recursive: true, force: true });
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 12000);

  it('profile 切换 watcher 创建失败:零摘除零 bump,回旧配置零失效,再试新配置恰一次失效(五轮评审修复,修前红)', async () => {
    // 五轮评审 P1 回归:assetsRoot 路径的失败一致性不覆盖 profile 事件路径。
    // profile 切换装载失败时:根数据未摘、generation 未 bump(修前红:先
    // bump+摘根再装载,失败后数据摘了但守卫挡死重建,旧根数据持续缺失);
    // 回旧配置命中签名守卫(零摘除零失效零 bump);再次尝试新配置恰一次失效。
    const dirA = makeAssets();
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-suppress-pfail-b-'));
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-suppress-pfail-ws-'));
    const map = new Map<string, unknown>([
      ['kbengine.projectProfiles.v1', [
        { id: 'pfA', displayName: 'A', assetsRoot: dirA, engineRoot: '', interpreterPath: null, interpreterSource: 'missing' },
        { id: 'pfB', displayName: 'B', assetsRoot: dirB, engineRoot: '', interpreterPath: null, interpreterSource: 'missing' }
      ]],
      ['kbengine.activeProfileId.v1', 'pfA']
    ]);
    const mementoLike = {
      get: <T,>(key: string, defaultValue?: T): T | undefined =>
        map.has(key) ? (map.get(key) as T) : defaultValue,
      update: (key: string, value: unknown): Promise<void> => {
        map.set(key, value);
        return Promise.resolve();
      }
    };
    workspace.findFiles = (async () => []) as typeof workspace.findFiles;
    const context = { ...makeContext(), workspaceState: mementoLike } as unknown as ReturnType<typeof makeContext>;
    const invalidate = vi.spyOn(PythonClassIndex.prototype, 'invalidate')
      .mockImplementation(() => undefined);
    const removeRoot = vi.spyOn(EntityMappingManager.prototype, 'removeRoot');
    const originalCreate = workspace.createFileSystemWatcher;
    const spyCreate = vi.spyOn(workspace, 'createFileSystemWatcher').mockImplementation(
      ((pattern: unknown) => {
        if (JSON.stringify(pattern).includes(dirB)) {
          throw new Error('profile watcher create boom');
        }
        return originalCreate.call(workspace, pattern as never);
      }) as typeof originalCreate
    );
    try {
      workspace.workspaceFolders = [{ uri: Uri.file(ws), name: 'ws', index: 0 }];
      activate(context);
      expect(getActiveProfileScanRoot()).toBe(dirA);
      const generationBefore = getRootConfigGeneration();
      // 切到 profile B:watcher 装载抛错 → 异常上抛,根未摘、generation 未 bump
      await expect(setActiveProfile(mementoLike, 'pfB'))
        .rejects.toThrow('profile watcher create boom');
      expect(removeRoot, 'profile 装载失败不得摘除任何根').not.toHaveBeenCalled();
      expect(invalidate, 'profile 装载失败不得进入失效序列').not.toHaveBeenCalled();
      expect(getRootConfigGeneration(), 'profile 装载失败不得推进 generation')
        .toBe(generationBefore);
      // 恢复创建能力后回旧配置 A:签名从未离开 A → 守卫挡下重建/失效
      spyCreate.mockRestore();
      await setActiveProfile(mementoLike, 'pfA');
      expect(removeRoot, '回旧配置零摘除').not.toHaveBeenCalled();
      expect(invalidate, '回旧配置零整库失效').not.toHaveBeenCalled();
      expect(getRootConfigGeneration(), '回旧配置不得推进 generation')
        .toBe(generationBefore);
      // 再次尝试新配置 B:签名 B≠A → 重建成功,恰一次失效 + 摘除旧根 A
      await setActiveProfile(mementoLike, 'pfB');
      expect(invalidate, '再次尝试新配置照常整库失效恰好一次').toHaveBeenCalledTimes(1);
      expect(removeRoot, '再次尝试 B 时摘除旧根 A').toHaveBeenCalledWith(dirA, []);
    } finally {
      for (const disposable of context.subscriptions) { disposable.dispose(); }
      removeRoot.mockRestore();
      invalidate.mockRestore();
      vi.restoreAllMocks();
      resetScanRootCache();
      setActiveProfileScanRoot(null);
      resetLanguageServiceMetrics();
      fs.rmSync(dirA, { recursive: true, force: true });
      fs.rmSync(dirB, { recursive: true, force: true });
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 12000);

  it('profile 事件指向同一 assetsRoot:实体保留;真切换:旧根摘除', async () => {
    const dirA = makeAssets();
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-suppress-pb-'));
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-suppress-pws-'));
    const map = new Map<string, unknown>([
      ['kbengine.projectProfiles.v1', [
        { id: 'pA', displayName: 'A', assetsRoot: dirA, engineRoot: '', interpreterPath: null, interpreterSource: 'missing' },
        { id: 'pB', displayName: 'B', assetsRoot: dirB, engineRoot: '', interpreterPath: null, interpreterSource: 'missing' }
      ]],
      ['kbengine.activeProfileId.v1', 'pA']
    ]);
    const mementoLike = {
      get: <T,>(key: string, defaultValue?: T): T | undefined =>
        map.has(key) ? (map.get(key) as T) : defaultValue,
      update: (key: string, value: unknown): Promise<void> => {
        map.set(key, value);
        return Promise.resolve();
      }
    };
    stubFindFiles(dirA);
    const context = { ...makeContext(), workspaceState: mementoLike } as unknown as ReturnType<typeof makeContext>;
    const [getManager, restoreCapture] = captureManager();
    try {
      workspace.workspaceFolders = [{ uri: Uri.file(ws), name: 'ws', index: 0 }];
      activate(context);
      expect(getActiveProfileScanRoot()).toBe(dirA);
      await until(() => getOperationSummary('entity-mapping-scan') !== null);
      const manager = getManager();
      expect(manager, '捕获激活内 EntityMappingManager').not.toBeNull();
      await until(() => manager!.getSemanticIndex().findEntityByName('Avatar0') !== null, 4000);
      // 同 assetsRoot 的 profile 事件(重复选择 pA):根集不变 → 实体保留
      await setActiveProfile(mementoLike, 'pA');
      await new Promise(resolve => setTimeout(resolve, 120));
      expect(manager!.getSemanticIndex().findEntityByName('Avatar0'), '同根 profile 事件不得摘除实体')
        .not.toBeNull();
      // 真切换 pB(空资产根):旧根 A 的实体摘除
      await setActiveProfile(mementoLike, 'pB');
      await new Promise(resolve => setTimeout(resolve, 120));
      expect(manager!.getSemanticIndex().findEntityByName('Avatar0'), '真切换后旧根实体摘除')
        .toBeNull();
    } finally {
      restoreCapture();
      for (const disposable of context.subscriptions) { disposable.dispose(); }
      resetScanRootCache();
      setActiveProfileScanRoot(null);
      resetLanguageServiceMetrics();
      fs.rmSync(dirA, { recursive: true, force: true });
      fs.rmSync(dirB, { recursive: true, force: true });
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 12000);
});
