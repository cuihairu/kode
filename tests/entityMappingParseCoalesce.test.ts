/**
 * .def 解析在途合并(2026-11-24 Navigation 刷屏修复):解析缓存只在解析
 * 完成后落账,同时到达的定向请求(激活期开档风暴的预热+悬停/CodeLens 并发)
 * 会对同一 .def 重复全量解析。并发两请求必须只解析一次(misses 恰 +1),
 * 顺序重放走 mtime 缓存(hits +1,misses 不再涨)。
 * 夹具=首扫空清单后注入新 def(保证首扫不预填缓存,并发真落到解析层)。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { EntityMappingManager } from '../src/entityMapping';
import { Uri, workspace } from './helpers/vscodeStub';
import { patternGlob } from './helpers/findPattern';

describe('parseDefFile 在途合并(同 .def 并发只解析一次)', () => {
  const originalFolders = workspace.workspaceFolders;
  const originalFindFiles = workspace.findFiles;
  const managers: EntityMappingManager[] = [];
  const roots: string[] = [];

  afterEach(() => {
    managers.splice(0).forEach(manager => manager.dispose());
    roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }));
    workspace.workspaceFolders = originalFolders;
    workspace.findFiles = originalFindFiles;
  });

  it('并发两请求只解析一次(misses +1),顺序重放走 mtime 缓存(hits +1)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-coalesce-'));
    roots.push(root);
    const put = (relative: string, content: string) => {
      const file = path.join(root, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, 'utf8');
      return file;
    };
    // 盘上先有文件,但 findFiles 初始返回空 → 首扫零预填,缓存留给并发轮
    const defFile = put('scripts/entity_defs/Monster.def', [
      '<root>',
      '  <BaseMethods>',
      '    <onLate/>',
      '  </BaseMethods>',
      '</root>'
    ].join('\n'));
    const pythonFile = put('scripts/base/Monster.py', [
      'class Monster(object):',
      '    def onLate(self):',
      '        pass'
    ].join('\n'));
    const defFiles: ReturnType<typeof Uri.file>[] = [];
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'coalesce', index: 0 }];
    workspace.findFiles = async (raw?: unknown) => {
      const glob = patternGlob(raw);
      if (!glob || !glob.endsWith('.def')) { return []; }
      return [...defFiles];
    };

    const manager = new EntityMappingManager({ subscriptions: [] });
    managers.push(manager);
    await manager.waitForInitialScan();
    const before = manager.getDefParseCacheStats();

    // 首扫后注入:def 进入 findFiles 视野,两请求同时到达同一 .def
    defFiles.push(Uri.file(defFile));
    const [first, second] = await Promise.all([
      manager.resolveMethodDefinition(pythonFile, 'onLate'),
      manager.resolveMethodDefinition(pythonFile, 'onLate')
    ]);
    expect(first).toMatchObject({ defFile, line: 3, section: 'BaseMethods' });
    expect(second).toMatchObject({ defFile, line: 3, section: 'BaseMethods' });
    const afterConcurrent = manager.getDefParseCacheStats();
    expect(afterConcurrent.misses).toBe(before.misses + 1);

    // 顺序重放:同一 .def 未变更,走 mtime 缓存(不再新增 miss)。
    // 公开 API 在索引热时短路不进 parseDefFile(悬停快路径既有语义),
    // 先模拟 watcher 整表失效(不动解析缓存)再重放,与 hoverBudget 同款。
    const internals = manager as unknown as {
      mappingIndexes: Map<string, unknown>;
      mappingIndexesByRoot: Map<string, unknown>;
      missingOwnerPaths: Set<string>;
      missingClassNames: Set<string>;
    };
    internals.mappingIndexes.clear();
    internals.mappingIndexesByRoot.clear();
    internals.missingOwnerPaths.clear();
    internals.missingClassNames.clear();
    const replay = await manager.resolveMethodDefinition(pythonFile, 'onLate');
    expect(replay).toMatchObject({ defFile, line: 3 });
    const afterReplay = manager.getDefParseCacheStats();
    expect(afterReplay.misses).toBe(afterConcurrent.misses);
    expect(afterReplay.hits).toBeGreaterThan(afterConcurrent.hits);
  });
});
