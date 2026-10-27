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
  it('POSIX 大小写不同的根与 def 文件保持独立', () => {
    const index = new SemanticIndex();
    const upper = index.registerRoot('/project/A');
    const lower = index.registerRoot('/project/a');
    expect(upper).not.toBe(lower);
    for (const rootId of [upper, lower]) {
      index.registerEntity({ rootId, entityName: 'Hero', defFile: `${rootId}/Hero.def`, pythonFiles: [], owners: [] });
    }
    expect(index.getRoots()).toHaveLength(2);
    expect(index.findEntityConflicts('Hero').map(item => item.defFile).sort())
      .toEqual(['/project/A/Hero.def', '/project/a/Hero.def']);
    expect(index.resolveRootIdForPath('/project/A/Hero.def')).toBe(upper);
    expect(index.resolveRootIdForPath('/project/a/Hero.def')).toBe(lower);
  });
  it('Windows 路径大小写与分隔符变体合并，跨盘保持隔离', () => {
    const index = new SemanticIndex();
    const first = index.registerRoot('C:\\Project');
    expect(index.registerRoot('c:/PROJECT')).toBe(first);
    const second = index.registerRoot('D:\\Project');
    expect(second).not.toBe(first);
    index.registerEntity({ rootId: first, entityName: 'Hero', defFile: 'C:\\Project\\Hero.def', pythonFiles: [], owners: [] });
    index.registerEntity({ rootId: second, entityName: 'Hero', defFile: 'D:\\Project\\Hero.def', pythonFiles: [], owners: [] });
    expect(index.findEntityConflicts('Hero').map(item => item.defFile).sort())
      .toEqual(['c:/project/hero.def', 'd:/project/hero.def']);
    expect(index.resolveRootIdForPath('c:/PROJECT/HERO.def')).toBe(first);
    expect(index.resolveRootIdForPath('d:\\project\\HERO.def')).toBe(second);
  });
  it('registerRoot 幂等:同一路径(不同写法/分隔符)返回同一稳定 rootId', () => {
    const index = new SemanticIndex();
    const rootId = index.registerRoot('/tmp/Proj_A');
    expect(rootId).toBe('/tmp/Proj_A');
    expect(index.registerRoot('\\tmp\\Proj_A')).toBe(rootId);
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

  it('替换同一 def 注册时移除旧 Python owner', () => {
    const index = new SemanticIndex();
    register(index, '/ws', 'Hero', '/ws/Hero.def', ['/ws/Old.py']);
    register(index, '/ws', 'Hero', '/ws/Hero.def', ['/ws/New.py']);
    expect(index.findEntityByPythonFile('/ws/Old.py')).toBeNull();
    expect(index.findEntityByPythonFile('/ws/New.py')?.entityName).toBe('Hero');
  });

  it('共享 Python owner 反查返回全部实体，移除一个不影响另一个', () => {
    const index = new SemanticIndex();
    register(index, '/ws', 'A', '/ws/A.def', ['/ws/Shared.py']);
    register(index, '/ws', 'B', '/ws/B.def', ['/ws/Shared.py']);
    expect(index.findEntitiesByPythonOwner('/ws/Shared.py').map(entry => entry.entityName)).toEqual(['A', 'B']);
    expect(index.findEntityByPythonFile('/ws/Shared.py')?.entityName).toBe('A');
    index.removeEntityByDefFile('/ws/A.def');
    expect(index.findEntitiesByPythonOwner('/ws/Shared.py').map(entry => entry.entityName)).toEqual(['B']);
  });

  it('替换后删除实体会清理旧、新 owner 和所有反向记录', () => {
    const index = new SemanticIndex();
    const registerOwner = (file: string, owner: string) => index.registerEntity({
      rootId: '/ws', entityName: 'Hero', defFile: '/ws/Hero.def', pythonFiles: [file],
      owners: [{ kind: 'interface', name: owner }]
    });
    registerOwner('/ws/Old.py', 'OldOwner');
    registerOwner('/ws/New.py', 'NewOwner');
    index.removeEntityByDefFile('/ws/Hero.def');
    expect(index.findEntityByPythonFile('/ws/Old.py')).toBeNull();
    expect(index.findEntityByPythonFile('/ws/New.py')).toBeNull();
    expect(index.findEntityByClassName('OldOwner')).toBeNull();
    expect(index.findEntityByClassName('NewOwner')).toBeNull();
    expect(index.findEntitiesByOwner('interface', 'OldOwner')).toEqual([]);
    expect(index.findEntitiesByOwner('interface', 'NewOwner')).toEqual([]);
  });

  it('取证①:同名实体后注册者覆盖(既有 Map.set 口径),冲突清单保全双根条目', () => {
    const index = new SemanticIndex();
    index.registerRoot('/rootA');
    index.registerRoot('/rootB');
    register(index, '/roota', 'Hero', '/rootA/scripts/entity_defs/Hero.def');
    register(index, '/rootb', 'Hero', '/rootB/scripts/entity_defs/Hero.def');
    // 单一胜者 = 后注册者(与既有 mappingIndexes.set 覆盖一致)
    expect(index.getEntityDefFile('Hero')).toBe('/rootB/scripts/entity_defs/Hero.def');
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
    // 胜者被摘:名字槽重选到剩余同名的 rootA(IDE-IDX-008,不连坐其他根),
    // 同名清单只剩 rootA
    expect(index.getEntityDefFile('Hero')).toBe('/rootA/scripts/entity_defs/Hero.def');
    expect(index.findEntityConflicts('Hero')).toHaveLength(1);
    // rootB 的 Hero.py owner 记录已清;basename 回落(策略②)命中重选后的
    // 同名胜者 rootA——与既有 findIndexForPythonFile 两段式口径一致
    expect(index.findEntityByPythonFile('/rootB/scripts/base/Hero.py')?.defFile)
      .toBe('/rootA/scripts/entity_defs/Hero.def');
    expect(index.findEntityByPythonFile('/rootA/scripts/base/Hero.py')?.entityName).toBe('Hero');
  });
});

describe('类型注册表快照(A4-3:查询纯内存,更新事件驱动重建)', () => {
  it('存取按 规范化根+开关 键控;命中不触盘,dependencies 规范化', () => {
    const index = new SemanticIndex();
    expect(index.getTypeRegistrySnapshot('/ws', true)).toBeUndefined();
    const stored = index.storeTypeRegistrySnapshot('/WS', true, [{ name: 'A' }], ['/WS/scripts/entity_defs/types.xml']);
    expect(stored.generation).toBe(1);
    expect(index.getTypeRegistrySnapshot('/WS', true)?.entries).toEqual([{ name: 'A' }]);
    expect(index.getTypeRegistrySnapshot('/ws', true)).toBeUndefined();
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
    expect(index.notifySemanticFilesChanged(['/WS/SCRIPTS/Entity_Defs/types.xml'])).toBe(0);
    expect(index.notifySemanticFilesChanged(['/ws/scripts/entity_defs/types.xml'])).toBe(1);
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
    expect(plan.invalidateFiles).toEqual(['/ws/scripts/entity_defs/Avatar.def']);
    expect(plan.fullRebuild).toBe(false);
    expect(plan.typeRegistryInvalidation).toBe(false);
  });

  it('父链 .def 变更沿依赖闭包只带出子 .def,不带出无关实体', () => {
    const graph = makeGraph();
    const plan = graph.planInvalidation('/ws/scripts/entity_defs/Parent.def', 'change');
    expect(plan.invalidateFiles).toEqual(['/ws/scripts/entity_defs/Hero.def', '/ws/scripts/entity_defs/Parent.def']);
    expect(plan.fullRebuild).toBe(false);
  });

  it('types.xml 变更:置类型注册表失效位,失效集仍限于记录在案的依赖者', () => {
    const graph = makeGraph();
    const plan = graph.planInvalidation('/ws/scripts/entity_defs/types.xml', 'change');
    expect(plan.typeRegistryInvalidation).toBe(true);
    expect(plan.invalidateFiles).toEqual([
      '/ws/scripts/entity_defs/Hero.def',
      '/ws/scripts/entity_defs/types.xml'
    ]);
    expect(plan.fullRebuild).toBe(false);
  });

  it('Python 变更只失效该文件;create 无派生物记录只失效自身', () => {
    const graph = makeGraph();
    expect(graph.planInvalidation('/ws/scripts/base/Hero.py', 'change').invalidateFiles)
      .toEqual(['/ws/scripts/base/Hero.py']);
    expect(graph.planInvalidation('/ws/scripts/entity_defs/New.def', 'create').invalidateFiles)
      .toEqual(['/ws/scripts/entity_defs/New.def']);
  });

  it('removeFile 摘边:子 .def 离场后父变更不再带出它', () => {
    const graph = makeGraph();
    graph.removeFile('/ws/scripts/entity_defs/Hero.def');
    expect(graph.planInvalidation('/ws/scripts/entity_defs/Parent.def', 'change').invalidateFiles)
      .toEqual(['/ws/scripts/entity_defs/Parent.def']);
  });

  it('recordDependencies 幂等替换出边:旧边摘除、新边生效', () => {
    const graph = makeGraph();
    graph.recordDependencies('/ws/scripts/entity_defs/Hero.def', ['/ws/scripts/entity_defs/Other.def']);
    expect(graph.getDependencies('/ws/scripts/entity_defs/Hero.def'))
      .toEqual(['/ws/scripts/entity_defs/Other.def']);
    expect(graph.planInvalidation('/ws/scripts/entity_defs/Parent.def', 'change').invalidateFiles)
      .toEqual(['/ws/scripts/entity_defs/Parent.def']);
    expect(graph.planInvalidation('/ws/scripts/entity_defs/Other.def', 'change').invalidateFiles)
      .toContain('/ws/scripts/entity_defs/Hero.def');
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
      // POSIX owner 路径保留大小写，不将不同文件归为同一 owner。
      expect(manager.getMappingForPythonFile(path.join(root, 'scripts', 'base', 'HERO.py'))).toBeUndefined();
      // 无 owner 归属 + 实体名大小写不符仍 miss(既有大小写敏感回落口径)
      expect(manager.getMappingForPythonFile(path.join(root, 'scripts', 'cell', 'hero.py'))).toBeUndefined();
      // 语义索引取证:根显式登记,实体条目挂扫描根 rootId
      const semantic = manager.getSemanticIndex();
      expect(semantic.getRoots().map(item => item.rootId)).toContain(root.replace(/\\/g, '/'));
      expect(semantic.findEntityByName('Hero')?.defFile).toContain('Hero.def');
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
        .toEqual([path.join(root, 'scripts/entity_defs/Hero.def').replace(/\\/g, '/')]);
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

// PR6 A6-5:同名符号跨根稳定性测试集(接 PR5 版本轴)。策略①后注册覆盖
// 既是既有口径也是跨根同名符号的唯一裁决面 —— 本组锁定:注册/摘除/重注册
// 循环(版本轴上的反复重派生)下胜者与冲突清单零漂移,失效传播按根隔离。
describe('同名符号跨根稳定性(A6-5,接 PR5 版本轴)', () => {
  const register = (
    index: SemanticIndex,
    rootId: string,
    entityName: string,
    defFile: string
  ): void => {
    index.registerEntity({
      rootId,
      entityName,
      defFile,
      pythonFiles: [defFile.replace(/\.def$/, '.py')],
      owners: [{ kind: 'entity', name: entityName }]
    });
  };

  it('注册→摘除→重注册循环 50 轮:胜者与冲突清单逐轮稳定(无 Map 序漂移)', () => {
    const index = new SemanticIndex();
    index.registerRoot('/stable/rootA');
    index.registerRoot('/stable/rootB');
    const defA = '/stable/roota/scripts/entity_defs/Hero.def';
    const defB = '/stable/rootb/scripts/entity_defs/Hero.def';
    let firstWinner: string | null = null;
    let firstConflicts: readonly string[] | null = null;
    for (let round = 0; round < 50; round += 1) {
      register(index, '/stable/roota', 'Hero', defA);
      register(index, '/stable/rootb', 'Hero', defB);
      const winner = index.getEntityDefFile('Hero');
      const conflicts = index.findEntityConflicts('Hero').map(entry => entry.defFile);
      if (firstWinner === null) {
        firstWinner = winner;
        firstConflicts = conflicts;
      }
      // 每一轮结果与第一轮逐字节一致(版本轴重派生不引入漂移)
      expect(winner).toBe(firstWinner);
      expect(conflicts).toEqual(firstConflicts);
      expect(conflicts).toEqual([defB, defA]);
      // 摘除本轮胜者:名字槽重选到剩余的 rootA(IDE-IDX-008,不连坐),
      // 同名清单只剩 rootA 的 def 条目;下一轮重注册即恢复胜者 defB
      expect(index.removeEntityByDefFile(defB)?.rootId).toBe('/stable/rootb');
      expect(index.getEntityDefFile('Hero')).toBe(defA);
      expect(index.findEntityConflicts('Hero')).toHaveLength(1);
    }
  });

  it('冲突清单排序对注册节奏稳定:先A后B与先B后A的胜者切换都是确定性的', () => {
    const build = (order: 'AB' | 'BA'): { winner: string; conflicts: string[] } => {
      const index = new SemanticIndex();
      index.registerRoot('/ord/rootA');
      index.registerRoot('/ord/rootB');
      const sequence = order === 'AB'
        ? [['/ord/roota', '/ord/roota/scripts/entity_defs/mage.def'],
           ['/ord/rootb', '/ord/rootb/scripts/entity_defs/mage.def']]
        : [['/ord/rootb', '/ord/rootb/scripts/entity_defs/mage.def'],
           ['/ord/roota', '/ord/roota/scripts/entity_defs/mage.def']];
      for (const [rootId, defFile] of sequence) {
        register(index, rootId, 'Mage', defFile);
      }
      return {
        winner: index.getEntityDefFile('Mage') ?? '',
        conflicts: index.findEntityConflicts('Mage').map(entry => entry.defFile)
      };
    };
    const ab = build('AB');
    const ba = build('BA');
    expect(ab.winner).toBe('/ord/rootb/scripts/entity_defs/mage.def');
    expect(ba.winner).toBe('/ord/roota/scripts/entity_defs/mage.def');
    expect(ab.conflicts).toEqual(['/ord/rootb/scripts/entity_defs/mage.def', '/ord/roota/scripts/entity_defs/mage.def']);
    expect(ba.conflicts).toEqual(['/ord/roota/scripts/entity_defs/mage.def', '/ord/rootb/scripts/entity_defs/mage.def']);
  });

  it('失效按根隔离:rootB 类型源变更不作废 rootA 的类型注册表快照', () => {
    const index = new SemanticIndex();
    const rootA = index.registerRoot('/iso/rootA');
    const rootB = index.registerRoot('/iso/rootB');
    const typesA = '/iso/roota/scripts/types.xml';
    const typesB = '/iso/rootb/scripts/types.xml';
    index.storeTypeRegistrySnapshot('/iso/rootA', false, ['A-entry'], [typesA]);
    index.storeTypeRegistrySnapshot('/iso/rootB', false, ['B-entry'], [typesB]);
    expect(index.getTypeRegistrySnapshotCount()).toBe(2);
    // rootB 的 types.xml 变更:只作废 rootB 快照
    expect(index.notifySemanticFilesChanged([typesB])).toBe(1);
    expect(index.getTypeRegistrySnapshot(rootA, false)).toBeDefined();
    expect(index.getTypeRegistrySnapshot(rootB, false)).toBeUndefined();
    // 代际只随存快照前进(两次 store = 2):失效本身不推进,非全仓重建
    expect(index.getTypeRegistryGeneration()).toBe(2);
  });

  it('同名 def 文件跨根:documentStore 版本轴互不串位(快照按路径隔离)', async () => {
    const { updateDocumentSnapshot, peekDocumentSnapshot, releaseAllDocumentSnapshots }
      = await import('../src/documentStore');
    try {
      const docA = {
        uri: { toString: () => 'file:///ver/rootA/scripts/entity_defs/Hero.def', fsPath: '/ver/rootA/scripts/entity_defs/Hero.def' },
        version: 3,
        getText: () => '<root><Properties><fromRootA/></Properties></root>'
      };
      const docB = {
        uri: { toString: () => 'file:///ver/rootB/scripts/entity_defs/Hero.def', fsPath: '/ver/rootB/scripts/entity_defs/Hero.def' },
        version: 7,
        getText: () => '<root><Properties><fromRootB/></Properties></root>'
      };
      updateDocumentSnapshot(docA);
      updateDocumentSnapshot(docB);
      // 同名文件两根各自快照,版本与文本互不覆盖
      expect(peekDocumentSnapshot(docA)?.version).toBe(3);
      expect(peekDocumentSnapshot(docB)?.version).toBe(7);
      expect(peekDocumentSnapshot(docA)?.text).toContain('fromRootA');
      expect(peekDocumentSnapshot(docB)?.text).toContain('fromRootB');
      // rootA 版本轴前进不影响 rootB 快照
      updateDocumentSnapshot({ ...docA, version: 4 });
      expect(peekDocumentSnapshot(docB)?.version).toBe(7);
      expect(peekDocumentSnapshot(docA)?.version).toBe(4);
    } finally {
      releaseAllDocumentSnapshots();
    }
  });
});
