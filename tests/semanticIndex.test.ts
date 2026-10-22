import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SemanticIndex,
  getSemanticIndex,
  isTypeRegistryFile,
  resetSemanticTypeRegistryForTests
} from '../src/semanticIndex';
import { SemanticDependencyGraph } from '../src/dependencyGraph';
import { EntityMappingManager } from '../src/entityMapping';
import { resolveEntityAnnotationType } from '../src/definitionWorkspace';
import { configurationOverrides, Uri, workspace } from './helpers/vscodeStub';

// PR4 统一语义查询(用户令 2026-10-23):
// - A4-1 查询 API 不暴露内部遍历:所有查询返回条目/拷贝,消费端不碰内部 Map;
// - A4-3 类型注册表快照:查询纯内存,失效只由更新事件驱动(依赖精确裁断);
// - A4-5 多资产根模型:规范化路径+稳定 rootId+显式查找序;同名实体冲突取证;
// - A4-6 现有查找顺序取证固化为测试(不改行为先锁):
//   ① 同名实体后注册者覆盖(既有 Map.set 口径);
//   ② Python 文件命中顺序:owner 归属精确匹配 > 实体名回落(大小写敏感,
//     既有 path.basename 口径);
//   ③ 类名回溯注册序首中(既有插入序扫描口径)。

const roots: string[] = [];

afterEach(() => {
  roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }));
  configurationOverrides.delete('kbengine');
  resetSemanticTypeRegistryForTests();
});

const makeTempRoot = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-semantic-'));
  roots.push(root);
  return root;
};

describe('SemanticIndex 根模型(A4-5:规范化路径+rootID+显式序)', () => {
  it('registerRoot 幂等:同一路径(不同写法/分隔符)返回同一稳定 rootId', () => {
    const index = new SemanticIndex();
    const rootId = index.registerRoot('/tmp/Proj_A');
    expect(rootId).toBe('/tmp/proj_a');
    expect(index.registerRoot('\\tmp\\proj_A')).toBe(rootId);
    expect(index.getRoots()).toHaveLength(1);
    expect(index.getRoots()[0].order).toBe(0);
  });

  it('多根显式序:order 按登记序分配,getRoots 升序,不依赖任何 Map 插入序', () => {
    const index = new SemanticIndex();
    const first = index.registerRoot('/roots/aaa');
    const second = index.registerRoot('/roots/bbb');
    expect(first).not.toBe(second);
    expect(index.getRoots().map(root => root.normalizedPath)).toEqual(['/roots/aaa', '/roots/bbb']);
    expect(index.getRoots().map(root => root.order)).toEqual([0, 1]);
  });

  it('文件归属根:最长前缀命中(嵌套根优先)', () => {
    const index = new SemanticIndex();
    index.registerRoot('/ws');
    index.registerRoot('/ws/assets');
    expect(index.resolveRootIdForPath('/ws/assets/scripts/entity_defs/Hero.def')).toBe('/ws/assets');
    expect(index.resolveRootIdForPath('/ws/scripts/entity_defs/Hero.def')).toBe('/ws');
    expect(index.resolveRootIdForPath('/elsewhere/x.def')).toBeNull();
  });
});

describe('同名实体冲突与查找顺序取证(A4-5/A4-6,先锁不改)', () => {
  const register = (
    index: SemanticIndex,
    rootId: string,
    entityName: string,
    defFile: string,
    pythonFiles: string[] = []
  ): void => {
    index.registerEntity({
      rootId,
      entityName,
      defFile,
      pythonFiles,
      owners: [{ kind: 'entity', name: entityName }]
    });
  };

  it('取证①:同名实体后注册者覆盖(既有 Map.set 口径),冲突清单保全双根条目', () => {
    const index = new SemanticIndex();
    index.registerRoot('/rootA');
    index.registerRoot('/rootB');
    register(index, '/roota', 'Hero', '/rootA/scripts/entity_defs/Hero.def');
    register(index, '/rootb', 'Hero', '/rootB/scripts/entity_defs/Hero.def');
    // 单一胜者 = 后注册者(与既有 mappingIndexes.set 覆盖一致)
    expect(index.getEntityDefFile('Hero')).toBe('/rootb/scripts/entity_defs/hero.def');
    // 冲突取证:全根清单两根都在,胜者排首
    const conflicts = index.findEntityConflicts('Hero');
    expect(conflicts).toHaveLength(2);
    expect(conflicts[0].rootId).toBe('/rootb');
    expect(conflicts[1].rootId).toBe('/roota');
    // 无冲突实体清单为空
    register(index, '/roota', 'Mage', '/rootA/scripts/entity_defs/Mage.def');
    expect(index.findEntityConflicts('Mage')).toHaveLength(1);
  });

  it('取证②:Python 文件命中顺序 owner 精确匹配优先于实体名回落', () => {
    const index = new SemanticIndex();
    index.registerRoot('/ws');
    // Warrior.def 的 owner 归属文件恰好叫 Hero.py(实体名回落会误中 Hero.def)
    register(index, '/ws', 'Warrior', '/ws/scripts/entity_defs/Warrior.def', [
      '/ws/scripts/base/Hero.py'
    ]);
    register(index, '/ws', 'Hero', '/ws/scripts/entity_defs/Hero.def');
    expect(index.findEntityByPythonFile('/ws/scripts/base/Hero.py')?.entityName).toBe('Warrior');
    // 实体名回落只在无 owner 归属时生效
    expect(index.findEntityByPythonFile('/ws/scripts/cell/Hero.py')?.entityName).toBe('Hero');
  });

  it('取证②b:实体名回落保持既有大小写敏感口径(path.basename 原样比对)', () => {
    const index = new SemanticIndex();
    index.registerRoot('/ws');
    register(index, '/ws', 'Hero', '/ws/scripts/entity_defs/Hero.def');
    expect(index.findEntityByPythonFile('/ws/scripts/base/Hero.py')?.entityName).toBe('Hero');
    // 大小写不符 → 不命中(旧 findIndexForPythonFile 同样 miss)
    expect(index.findEntityByPythonFile('/ws/scripts/base/hero.py')).toBeNull();
  });

  it('取证③:类名回溯注册序首中;owner(kind+名)回溯供接口/组件符号', () => {
    const index = new SemanticIndex();
    index.registerRoot('/ws');
    register(index, '/ws', 'First', '/ws/scripts/entity_defs/First.def');
    // Second 先携带 interface Shared 的 owner 归属(既有插入序扫描口径:首个命中)
    index.registerEntity({
      rootId: '/ws',
      entityName: 'Second',
      defFile: '/ws/scripts/entity_defs/Second.def',
      pythonFiles: ['/ws/scripts/interfaces/Shared.py'],
      owners: [
        { kind: 'entity', name: 'Second' },
        { kind: 'interface', name: 'Shared' }
      ]
    });
    // 后注册者带同名类不改归属(先到先得)
    index.registerEntity({
      rootId: '/ws',
      entityName: 'Third',
      defFile: '/ws/scripts/entity_defs/Third.def',
      pythonFiles: ['/ws/scripts/interfaces/Shared.py'],
      owners: [{ kind: 'interface', name: 'Shared' }]
    });
    expect(index.findEntityByClassName('Shared')?.entityName).toBe('Second');
    expect(index.findEntitiesByOwner('interface', 'Shared')[0]?.entityName).toBe('Second');
    expect(index.findEntitiesByOwner('entity', 'Shared')).toHaveLength(0);
  });

  it('removeEntityByDefFile 定向摘除:同名胜者回退与投影全清', () => {
    const index = new SemanticIndex();
    index.registerRoot('/rootA');
    index.registerRoot('/rootB');
    register(index, '/roota', 'Hero', '/rootA/scripts/entity_defs/Hero.def', [
      '/rootA/scripts/base/Hero.py'
    ]);
    register(index, '/rootb', 'Hero', '/rootB/scripts/entity_defs/Hero.def', [
      '/rootB/scripts/base/Hero.py'
    ]);
    expect(index.removeEntityByDefFile('/rootB/scripts/entity_defs/Hero.def')?.entityName).toBe('Hero');
    // 胜者被摘,同名清单只剩 rootA(实体名映射不自动回退——保持与既有
    // mappingIndexes.delete 同口径,补建靠重扫)
    expect(index.getEntityDefFile('Hero')).toBeNull();
    expect(index.findEntityConflicts('Hero')).toHaveLength(1);
    expect(index.findEntityByPythonFile('/rootB/scripts/base/Hero.py')).toBeNull();
    expect(index.findEntityByPythonFile('/rootA/scripts/base/Hero.py')?.entityName).toBe('Hero');
  });
});

describe('类型注册表快照(A4-3:查询纯内存,更新事件驱动重建)', () => {
  it('存取按 规范化根+开关 键控;命中不触盘,dependencies 规范化', () => {
    const index = new SemanticIndex();
    expect(index.getTypeRegistrySnapshot('/ws', true)).toBeUndefined();
    const stored = index.storeTypeRegistrySnapshot('/WS', true, [{ name: 'A' }], ['/WS/scripts/entity_defs/types.xml']);
    expect(stored.generation).toBe(1);
    expect(index.getTypeRegistrySnapshot('/ws', true)?.entries).toEqual([{ name: 'A' }]);
    // 开关是键的一部分:关闸读不到同一份
    expect(index.getTypeRegistrySnapshot('/ws', false)).toBeUndefined();
  });

  it('notifySemanticFilesChanged 按依赖精确裁断:无关文件不作废,命中即作废', () => {
    const index = new SemanticIndex();
    index.storeTypeRegistrySnapshot('/ws', true, [1], ['/ws/scripts/entity_defs/types.xml']);
    // 无关文件变更:快照原地不动
    expect(index.notifySemanticFilesChanged(['/ws/scripts/base/Hero.py'])).toBe(0);
    expect(index.getTypeRegistrySnapshot('/ws', true)).toBeDefined();
    // 依赖文件变更:精确作废
    expect(index.notifySemanticFilesChanged(['/WS/SCRIPTS/Entity_Defs/types.xml'])).toBe(1);
    expect(index.getTypeRegistrySnapshot('/ws', true)).toBeUndefined();
  });

  it('与 resolveEntityAnnotationType 集成:通知后重建,代际自增可观测', () => {
    const root = makeTempRoot();
    fs.mkdirSync(path.join(root, 'scripts', 'entity_defs'), { recursive: true });
    const typesXmlPath = path.join(root, 'scripts', 'entity_defs', 'types.xml');
    fs.writeFileSync(typesXmlPath, '<root>\n  <TIMESTAMP> UINT64 </TIMESTAMP>\n</root>', 'utf8');
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'semantic', index: 0 }];
    expect(resolveEntityAnnotationType(root, 'TIMESTAMP')).toBe('int');
    const shared = getSemanticIndex();
    const generationAfterBuild = shared.getTypeRegistryGeneration();
    expect(shared.getTypeRegistrySnapshotCount()).toBeGreaterThanOrEqual(1);
    // 事件 → 作废 → 下次查询重建(代际前进)
    shared.notifySemanticFilesChanged([typesXmlPath]);
    expect(resolveEntityAnnotationType(root, 'TIMESTAMP')).toBe('int');
    expect(shared.getTypeRegistryGeneration()).toBeGreaterThan(generationAfterBuild);
  });

  it('isTypeRegistryFile 判别:types/alias 命中,其余放行', () => {
    expect(isTypeRegistryFile('D:\\x\\scripts\\entity_defs\\types.xml')).toBe(true);
    expect(isTypeRegistryFile('/x/scripts/entity_defs/alias.xml')).toBe(true);
    expect(isTypeRegistryFile('/x/scripts/entity_defs/Hero.def')).toBe(false);
    expect(isTypeRegistryFile('/x/entities.xml')).toBe(false);
  });
});

describe('依赖失效图(A4-2:禁全仓重建,单文件变更精确裁断)', () => {
  const makeGraph = (): SemanticDependencyGraph => {
    const graph = new SemanticDependencyGraph();
    // Hero.def 解析读过 Parent.def 与 types.xml(真实依赖边)
    graph.recordDependencies('/ws/scripts/entity_defs/Hero.def', [
      '/ws/scripts/entity_defs/Parent.def',
      '/ws/scripts/entity_defs/types.xml'
    ]);
    return graph;
  };

  it('分类器:五类语义文件各归其位', () => {
    const graph = makeGraph();
    expect(graph.planInvalidation('/ws/scripts/entity_defs/Hero.def', 'change').changedKind).toBe('def');
    expect(graph.planInvalidation('/ws/entities.xml', 'change').changedKind).toBe('entities-xml');
    expect(graph.planInvalidation('/ws/scripts/entity_defs/types.xml', 'change').changedKind).toBe('types-xml');
    expect(graph.planInvalidation('/ws/scripts/entity_defs/alias.xml', 'change').changedKind).toBe('alias-xml');
    expect(graph.planInvalidation('/ws/scripts/base/Hero.py', 'change').changedKind).toBe('python');
  });

  it('单 .def 变更只失效自身(无依赖者时不波及他文件;恒不全仓重建)', () => {
    const graph = makeGraph();
    const plan = graph.planInvalidation('/ws/scripts/entity_defs/Avatar.def', 'change');
    expect(plan.invalidateFiles).toEqual(['/ws/scripts/entity_defs/avatar.def']);
    expect(plan.fullRebuild).toBe(false);
    expect(plan.typeRegistryInvalidation).toBe(false);
  });

  it('父链 .def 变更沿依赖闭包只带出子 .def,不带出无关实体', () => {
    const graph = makeGraph();
    const plan = graph.planInvalidation('/ws/scripts/entity_defs/Parent.def', 'change');
    expect(plan.invalidateFiles).toEqual(['/ws/scripts/entity_defs/hero.def', '/ws/scripts/entity_defs/parent.def']);
    expect(plan.fullRebuild).toBe(false);
  });

  it('types.xml 变更:置类型注册表失效位,失效集仍限于记录在案的依赖者', () => {
    const graph = makeGraph();
    const plan = graph.planInvalidation('/ws/scripts/entity_defs/types.xml', 'change');
    expect(plan.typeRegistryInvalidation).toBe(true);
    expect(plan.invalidateFiles).toEqual([
      '/ws/scripts/entity_defs/hero.def',
      '/ws/scripts/entity_defs/types.xml'
    ]);
    expect(plan.fullRebuild).toBe(false);
  });

  it('Python 变更只失效该文件;create 无派生物记录只失效自身', () => {
    const graph = makeGraph();
    expect(graph.planInvalidation('/ws/scripts/base/Hero.py', 'change').invalidateFiles)
      .toEqual(['/ws/scripts/base/hero.py']);
    expect(graph.planInvalidation('/ws/scripts/entity_defs/New.def', 'create').invalidateFiles)
      .toEqual(['/ws/scripts/entity_defs/new.def']);
  });

  it('removeFile 摘边:子 .def 离场后父变更不再带出它', () => {
    const graph = makeGraph();
    graph.removeFile('/ws/scripts/entity_defs/Hero.def');
    expect(graph.planInvalidation('/ws/scripts/entity_defs/Parent.def', 'change').invalidateFiles)
      .toEqual(['/ws/scripts/entity_defs/parent.def']);
  });

  it('recordDependencies 幂等替换出边:旧边摘除、新边生效', () => {
    const graph = makeGraph();
    graph.recordDependencies('/ws/scripts/entity_defs/Hero.def', ['/ws/scripts/entity_defs/Other.def']);
    expect(graph.getDependencies('/ws/scripts/entity_defs/Hero.def'))
      .toEqual(['/ws/scripts/entity_defs/other.def']);
    expect(graph.planInvalidation('/ws/scripts/entity_defs/Parent.def', 'change').invalidateFiles)
      .toEqual(['/ws/scripts/entity_defs/parent.def']);
    expect(graph.planInvalidation('/ws/scripts/entity_defs/Other.def', 'change').invalidateFiles)
      .toContain('/ws/scripts/entity_defs/hero.def');
  });
});

describe('EntityMappingManager 兼容层(A4-4:getMappingForPythonFile 系改走语义索引)', () => {
  const originalFindFiles = workspace.findFiles;

  afterEach(() => {
    workspace.findFiles = originalFindFiles;
  });

  it('owner 归属命中与实体名回落两条路径经语义索引,旧 API 行为不变', async () => {
    const root = makeTempRoot();
    const put = (relative: string, content: string): string => {
      const file = path.join(root, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, 'utf8');
      return file;
    };
    put('scripts/entity_defs/Hero.def', [
      '<root>',
      '  <Properties>',
      '    <hp> <Type>UINT32</Type> </hp>',
      '  </Properties>',
      '</root>'
    ].join('\n'));
    put('scripts/base/Hero.py', 'class Hero:\n    def start(self):\n        pass\n');
    const avatarDef = put('scripts/entity_defs/Avatar.def', '<root>\n</root>\n');
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'compat', index: 0 }];
    workspace.findFiles = async () => [Uri.file(avatarDef), Uri.file(path.join(root, 'scripts/entity_defs/Hero.def'))];

    const manager = new EntityMappingManager({ subscriptions: [] } as never);
    try {
      await manager.waitForInitialScan();
      // owner 归属命中:base/Hero.py → Hero
      const ownerHit = manager.getMappingForPythonFile(path.join(root, 'scripts', 'base', 'Hero.py'));
      expect(ownerHit?.name).toBe('Hero');
      expect(ownerHit?.properties.hp?.defFile).toBe(path.join(root, 'scripts', 'entity_defs', 'Hero.def'));
      // 实体名回落:无 owner 归属的同名脚本文件
      const fallbackHit = manager.getMappingForPythonFile(path.join(root, 'scripts', 'base', 'Avatar.py'));
      expect(fallbackHit?.name).toBe('Avatar');
      // owner 匹配大小写不敏感(既有 normalizeLookupPath 双侧口径)
      expect(manager.getMappingForPythonFile(path.join(root, 'scripts', 'base', 'HERO.py'))?.name).toBe('Hero');
      // 无 owner 归属 + 实体名大小写不符仍 miss(既有大小写敏感回落口径)
      expect(manager.getMappingForPythonFile(path.join(root, 'scripts', 'cell', 'hero.py'))).toBeUndefined();
      // 语义索引取证:根显式登记,实体条目挂扫描根 rootId
      const semantic = manager.getSemanticIndex();
      expect(semantic.getRoots().map(item => item.rootId)).toContain(root.toLowerCase().replace(/\\/g, '/'));
      expect(semantic.findEntityByName('Hero')?.defFile).toContain('hero.def');
    } finally {
      manager.dispose();
    }
  });

  it('def 单文件变更定向失效:变更实体重建,他实体索引原地不动(A4-2)', async () => {
    const root = makeTempRoot();
    const put = (relative: string, content: string): string => {
      const file = path.join(root, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, 'utf8');
      return file;
    };
    const heroDef = put('scripts/entity_defs/Hero.def', '<root>\n  <Properties>\n    <hp> <Type>UINT32</Type> </hp>\n  </Properties>\n</root>\n');
    const avatarDef = put('scripts/entity_defs/Avatar.def', '<root>\n  <Properties>\n    <mp> <Type>UINT8</Type> </mp>\n  </Properties>\n</root>\n');
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'scoped', index: 0 }];
    workspace.findFiles = async () => [Uri.file(heroDef), Uri.file(avatarDef)];

    // 记录型假 watcher:创建序 [types, def, python],按序取用
    const watchers: Array<{ fireChange(uri: Uri): void; fireCreate(uri: Uri): void; fireDelete(uri: Uri): void }> = [];
    const originalWatcher = workspace.createFileSystemWatcher;
    workspace.createFileSystemWatcher = () => {
      const change: Array<(uri: Uri) => void> = [];
      const create: Array<(uri: Uri) => void> = [];
      const remove: Array<(uri: Uri) => void> = [];
      const watcher = {
        fireChange: (uri: Uri) => change.forEach(fn => fn(uri)),
        fireCreate: (uri: Uri) => create.forEach(fn => fn(uri)),
        fireDelete: (uri: Uri) => remove.forEach(fn => fn(uri)),
        onDidChange(listener: (uri: Uri) => void) { change.push(listener); return { dispose: () => void 0 }; },
        onDidCreate(listener: (uri: Uri) => void) { create.push(listener); return { dispose: () => void 0 }; },
        onDidDelete(listener: (uri: Uri) => void) { remove.push(listener); return { dispose: () => void 0 }; },
        dispose: () => void 0
      };
      watchers.push(watcher);
      return watcher as never;
    };

    const manager = new EntityMappingManager({ subscriptions: [] } as never);
    try {
      await manager.waitForInitialScan();
      expect(manager.getAllMappings()).toHaveLength(2);
      const defWatcher = watchers[1];
      // Avatar.def 变更:定向重解析(Avatar 属性应更新),Hero 索引不动
      put('scripts/entity_defs/Avatar.def', '<root>\n  <Properties>\n    <mp2> <Type>UINT8</Type> </mp2>\n  </Properties>\n</root>\n');
      defWatcher.fireChange(Uri.file(avatarDef));
      await new Promise(resolve => setImmediate(resolve));
      await manager.waitForInitialScan();
      expect(manager.getMapping('Avatar')?.properties.mp2).toBeDefined();
      expect(manager.getMapping('Hero')?.properties.hp).toBeDefined();
      // 依赖图取证:两条 def 依赖边均在,变更计划只含自身
      const graph = manager.getDependencyGraph();
      expect(graph.planInvalidation(heroDef, 'change').invalidateFiles)
        .toEqual([path.join(root, 'scripts/entity_defs/Hero.def').replace(/\\/g, '/').toLowerCase()]);
      // 删除:仅该实体离场
      defWatcher.fireDelete(Uri.file(heroDef));
      await new Promise(resolve => setImmediate(resolve));
      expect(manager.getMapping('Hero')).toBeUndefined();
      expect(manager.getMapping('Avatar')).toBeDefined();
    } finally {
      workspace.createFileSystemWatcher = originalWatcher;
      manager.dispose();
    }
  });
});
