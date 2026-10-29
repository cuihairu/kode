import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TypesXmlCodeLensProvider } from '../src/languageProviders';
import { registerTypeStorageIndexWatchers } from '../src/typeStorageIndexWatchers';
import {
  clearDatabaseSchemaCacheForTests,
  flushTypeStorageUsageColdBuildForTests,
  getDatabaseSchemaCacheStatsForTests,
  invalidateTypeStorageUsageIndex
} from '../src/databaseSchema';
import { allFileSystemWatchers, workspace, workspaceState } from './fake-vscode/workspaceState';
import { Uri } from './fake-vscode/core';
import { makeTextDocument } from './helpers/vscodeStub';
import type { MinimalTextDocument } from './helpers/vscodeStub';

// IDE-SCH-009:types.xml CodeLens 只读反查快照——聚合已发布后,渲染
// 纯读(零快照探测:hits/misses 双零增长),新鲜度由 watcher 事件面承担
// (def→按实体替换/SCH-008,types.xml→整表置空后冷重建)。

const temporaryDirectories: string[] = [];
const originalFolders = workspace.workspaceFolders;

afterEach(async () => {
  workspace.workspaceFolders = originalFolders;
  workspace.textDocuments = [];
  await flushTypeStorageUsageColdBuildForTests();
  invalidateTypeStorageUsageIndex();
  clearDatabaseSchemaCacheForTests();
  workspaceState.reset();
  for (const dir of temporaryDirectories.splice(0)) { fs.rmSync(dir, { recursive: true, force: true }); }
});

function makeWorkspace(): { root: string; goldDef: string; typesXml: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-sch9-'));
  temporaryDirectories.push(root);
  fs.mkdirSync(path.join(root, 'scripts/entity_defs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts/entities.xml'),
    '<root>\n  <Gold/>\n</root>\n', 'utf8');
  fs.writeFileSync(path.join(root, 'scripts/entity_defs/types.xml'),
    '<root>\n  <ITEM_ID> UINT16 </ITEM_ID>\n</root>\n', 'utf8');
  fs.writeFileSync(path.join(root, 'scripts/entity_defs/Gold.def'), [
    '<root>',
    '  <Properties>',
    '    <coin>',
    '      <Type>ITEM_ID</Type>',
    '      <Persistent>true</Persistent>',
    '    </coin>',
    '  </Properties>',
    '</root>'
  ].join('\n'), 'utf8');
  return {
    root,
    goldDef: path.join(root, 'scripts/entity_defs/Gold.def'),
    typesXml: path.join(root, 'scripts/entity_defs/types.xml')
  };
}

const lensTitles = (provider: TypesXmlCodeLensProvider, doc: MinimalTextDocument): string[] =>
  (provider.provideCodeLenses(doc) as Array<{ command?: { title?: string } }>)
    .map(lens => lens.command?.title ?? '');

describe('IDE-SCH-009:types.xml CodeLens 只读反查快照', () => {
  it('暖渲染零快照探测,新鲜度走事件面', async () => {
    const { root, goldDef, typesXml } = makeWorkspace();
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    invalidateTypeStorageUsageIndex();
    clearDatabaseSchemaCacheForTests();

    const provider = new TypesXmlCodeLensProvider();
    const wiring = registerTypeStorageIndexWatchers(() => provider.fireConfigurationChanged());
    try {
      const doc = (): MinimalTextDocument => makeTextDocument(
        fs.readFileSync(typesXml, 'utf8'),
        { fileName: typesXml, languageId: 'xml' }
      );

      // 冷渲染:不整仓构建——空镜返回,交互线程零快照探测(2026-10-28 整改:
      // 冷构建派发后台,完成后经 onTypeStorageUsageIndexPublished 重渲染)
      const baseline = getDatabaseSchemaCacheStatsForTests();
      const cold = lensTitles(provider, doc());
      expect(cold.some(title => title.includes('Gold.coin'))).toBe(false);
      const statsAfterColdRender = getDatabaseSchemaCacheStatsForTests();
      expect(statsAfterColdRender.misses).toBe(baseline.misses);

      // 后台构建排干后重渲染:内容到位
      await flushTypeStorageUsageColdBuildForTests();
      const built = lensTitles(provider, doc());
      expect(built.some(title => title.includes('Gold.coin'))).toBe(true);
      const statsAfterCold = getDatabaseSchemaCacheStatsForTests();

      // 暖渲染:改 Gold.def 但不发事件 → 纯读,零快照探测(hits/misses 双零增长)
      fs.writeFileSync(goldDef, [
        '<root>',
        '  <Properties>',
        '    <coin>',
        '      <Type>ITEM_ID</Type>',
        '      <Persistent>true</Persistent>',
        '    </coin>',
        '    <gem>',
        '      <Type>ITEM_ID</Type>',
        '      <Persistent>true</Persistent>',
        '    </gem>',
        '  </Properties>',
        '</root>'
      ].join('\n'), 'utf8');
      const warm = lensTitles(provider, doc());
      expect(warm.some(title => title.includes('Gold.coin'))).toBe(true);
      const statsAfterWarm = getDatabaseSchemaCacheStatsForTests();
      expect(statsAfterWarm.hits).toBe(statsAfterCold.hits); // 不逐实体探快照
      expect(statsAfterWarm.misses).toBe(statsAfterCold.misses);

      // 事件面:def 变更发布新记录,下一次渲染读到新用法(仅重建 Gold)
      allFileSystemWatchers[0].fireChange(Uri.file(goldDef));
      const afterEvent = lensTitles(provider, doc());
      expect(afterEvent.some(title => title.includes('Gold.gem'))).toBe(true);
      expect(getDatabaseSchemaCacheStatsForTests().misses).toBe(statsAfterCold.misses + 1);
      // 事件后再次渲染:仍是纯读
      const statsAfterEvent = getDatabaseSchemaCacheStatsForTests();
      lensTitles(provider, doc());
      expect(getDatabaseSchemaCacheStatsForTests().hits).toBe(statsAfterEvent.hits);
      expect(getDatabaseSchemaCacheStatsForTests().misses).toBe(statsAfterEvent.misses);
    } finally {
      wiring.dispose();
      provider.dispose();
    }
  });
});
