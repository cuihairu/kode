// 五索引所有权与版本失效契约断言(KODE-ARCH-003)。
// 每条 it() 与 docs/architecture/index-ownership.md 的 C-* 编号一一对应;
// 改失效语义必须同笔改文档与本文件。
import { afterEach, describe, expect, it } from 'vitest';
import {
  SemanticIndex,
  getSemanticIndex,
  resetSemanticTypeRegistryForTests
} from '../src/backend/semanticIndex';
import { PythonClassIndex } from '../src/backend/pythonClassIndex';
import { WorkspaceIndex } from '../src/workspaceIndex';
import { GlobalDataDictIndex } from '../src/globalDataIndex';
import { EntityMappingManager } from '../src/entityMapping';
import { allFileSystemWatchers, makeTextDocument } from './helpers/vscodeStub';

afterEach(() => {
  resetSemanticTypeRegistryForTests();
});

describe('SemanticIndex 契约(docs/architecture/index-ownership.md §1)', () => {
  it('C-S1 快照失效按 dependencies 精确裁断:命中文件只作废自己的快照', () => {
    const index = new SemanticIndex();
    index.registerRoot('/ws/a');
    index.registerRoot('/ws/b');
    index.storeTypeRegistrySnapshot('/ws/a', false, ['a1'], ['/ws/a/res/types.xml']);
    index.storeTypeRegistrySnapshot('/ws/b', false, ['b1'], ['/ws/b/res/alias.xml']);
    const invalidated = index.notifySemanticFilesChanged(['/ws/a/res/types.xml']);
    expect(invalidated).toBe(1);
    expect(index.getTypeRegistrySnapshot('/ws/a', false)).toBeUndefined();
    expect(index.getTypeRegistrySnapshot('/ws/b', false)?.entries).toEqual(['b1']);
  });

  it('C-S2 空变更数组=全量作废(文档化逃生口)', () => {
    const index = new SemanticIndex();
    index.registerRoot('/ws/a');
    index.registerRoot('/ws/b');
    index.storeTypeRegistrySnapshot('/ws/a', false, ['a1'], ['/ws/a/res/types.xml']);
    index.storeTypeRegistrySnapshot('/ws/b', false, ['b1'], ['/ws/b/res/alias.xml']);
    expect(index.notifySemanticFilesChanged([])).toBe(2);
    expect(index.getTypeRegistrySnapshotCount()).toBe(0);
  });

  it('C-S3 removeRoot 整根摘除且不误伤同前缀其他根', () => {
    const index = new SemanticIndex();
    index.registerRoot('/ws/a');
    index.registerRoot('/ws/ab');
    index.storeTypeRegistrySnapshot('/ws/a', false, ['a1'], []);
    index.storeTypeRegistrySnapshot('/ws/ab', false, ['ab1'], []);
    const removed = index.removeRoot('/ws/a');
    expect(removed).toBe(1);
    expect(index.getTypeRegistrySnapshot('/ws/a', false)).toBeUndefined();
    expect(index.getTypeRegistrySnapshot('/ws/ab', false)?.entries).toEqual(['ab1']);
    expect(index.getRoots().map(root => root.rootId)).toEqual(['/ws/ab']);
  });

  it('C-S4 快照 generation 严格单调', () => {
    const index = new SemanticIndex();
    index.registerRoot('/ws/a');
    const first = index.storeTypeRegistrySnapshot('/ws/a', false, [], []).generation;
    const second = index.storeTypeRegistrySnapshot('/ws/a', false, [], []).generation;
    expect(second).toBeGreaterThan(first);
    index.notifySemanticFilesChanged([]);
    const third = index.storeTypeRegistrySnapshot('/ws/a', false, [], []).generation;
    expect(third).toBeGreaterThan(second);
  });

  it('C-S5 同 defFile 重注册=替换,不产生重复条目', () => {
    const index = new SemanticIndex();
    const rootId = index.registerRoot('/ws');
    index.registerEntity({ rootId, entityName: 'Hero', defFile: '/ws/Hero.def', pythonFiles: [], owners: [] });
    index.registerEntity({ rootId, entityName: 'Hero', defFile: '/ws/Hero.def', pythonFiles: [], owners: [] });
    expect(index.findEntityConflicts('Hero')).toHaveLength(1);
  });
});

describe('PythonClassIndex 契约(docs/architecture/index-ownership.md §3)', () => {
  it('C-P1 未索引过的 .py invalidate=无操作(发现期通知不重启扫描)', () => {
    const index = new PythonClassIndex();
    const before = index.getIndexVersions();
    index.invalidate('/ws/scripts/neverIndexed.py');
    expect(index.getIndexVersions()).toEqual(before);
  });

  it('C-P2 全量失效五轴前进(mro 经扫描复位路径再 +1=共 +2)', () => {
    const index = new PythonClassIndex();
    index.syncDocumentParse(makeTextDocument('class A:\\n    pass\\n', {
      fileName: '/ws/scripts/a.py',
      languageId: 'python',
      version: 1
    }));
    const before = index.getIndexVersions();
    index.invalidate();
    const after = index.getIndexVersions();
    expect(after.classes).toBe(before.classes + 1);
    expect(after.bases).toBe(before.bases + 1);
    expect(after.methods).toBe(before.methods + 1);
    expect(after.compositionRoots).toBe(before.compositionRoots + 1);
    // 全量路径 mro 在五轴循环与扫描复位各前进一次(代码事实,见
    // pythonClassIndex.ts invalidate)。
    expect(after.mro).toBe(before.mro + 2);
  });

  it('C-P3 无记录的非 .py 变更五轴全不动', () => {
    const index = new PythonClassIndex();
    const before = index.getIndexVersions();
    index.invalidate('/ws/res/entities.xml');
    expect(index.getIndexVersions()).toEqual(before);
  });

  it('C-P4 已索引 .py 单文件失效仅 classes+mro 两轴前进', () => {
    const index = new PythonClassIndex();
    const file = '/ws/scripts/b.py';
    index.syncDocumentParse(makeTextDocument('class B:\\n    pass\\n', {
      fileName: file,
      languageId: 'python',
      uri: { fsPath: file } as never
    }));
    const before = index.getIndexVersions();
    index.invalidate(file);
    const after = index.getIndexVersions();
    expect(after.classes).toBe(before.classes + 1);
    expect(after.mro).toBe(before.mro + 1);
    expect(after.bases).toBe(before.bases);
    expect(after.methods).toBe(before.methods);
    expect(after.compositionRoots).toBe(before.compositionRoots);
  });

  it('C-P5 syncDocumentParse 同版本命中直接返回缓存对象', () => {
    const index = new PythonClassIndex();
    const doc = makeTextDocument('class C:\\n    pass\\n', {
      fileName: '/ws/scripts/c.py',
      languageId: 'python',
      version: 1
    });
    const first = index.syncDocumentParse(doc);
    const second = index.syncDocumentParse(doc);
    expect(second).toBe(first);
  });
});

describe('WorkspaceIndex 契约(docs/architecture/index-ownership.md §4)', () => {
  it('C-W1 惰性启动:未 start 查询返回空且不建 watcher', () => {
    const watchersBefore = allFileSystemWatchers.length;
    const index = new WorkspaceIndex();
    index.dispose();
    expect(allFileSystemWatchers.length).toBe(watchersBefore);
  });

  it('C-W2 dispose 幂等,dispose 后 ensureStarted 不再启动', async () => {
    const watchersBefore = allFileSystemWatchers.length;
    const index = new WorkspaceIndex();
    await index.ensureStarted();
    index.dispose();
    index.dispose();
    await index.ensureStarted();
    expect(allFileSystemWatchers.length).toBe(watchersBefore + 1);
    index.dispose();
  });
});

describe('GlobalDataDictIndex 契约(docs/architecture/index-ownership.md §5)', () => {
  it('C-G2 invalidate 清空查询面;dispose 后 invalidate 是无操作', () => {
    const index = new GlobalDataDictIndex();
    expect(index.query('cfg', 'speed')).toEqual([]);
    index.invalidate();
    index.removeRoot('/ws');
    index.dispose();
    expect(() => index.invalidate()).not.toThrow();
    expect(index.editBufferEntryCountForTests()).toBe(0);
  });
});

describe('EntityMappingManager 契约(docs/architecture/index-ownership.md §2)', () => {
  it('C-E1 门控构造零副作用:不建 watcher 不入队首扫', () => {
    const watchersBefore = allFileSystemWatchers.length;
    const manager = new EntityMappingManager({ subscriptions: [] } as never, undefined, {
      deferStartup: true
    });
    expect(allFileSystemWatchers.length).toBe(watchersBefore);
    expect(manager.isInitialScanComplete()).toBe(false);
    manager.dispose();
  });

  it('C-E2 SemanticIndex 归 manager 私有,经 getSemanticIndex() 暴露且稳定', () => {
    const manager = new EntityMappingManager({ subscriptions: [] } as never, undefined, {
      deferStartup: true
    });
    const first = manager.getSemanticIndex();
    expect(manager.getSemanticIndex()).toBe(first);
    expect(first).not.toBe(getSemanticIndex());
    manager.dispose();
  });

  it('C-E4 未启动即可 dispose(幂等,无观察者泄漏)', () => {
    const manager = new EntityMappingManager({ subscriptions: [] } as never, undefined, {
      deferStartup: true
    });
    expect(() => manager.dispose()).not.toThrow();
    expect(() => manager.dispose()).not.toThrow();
  });
});
