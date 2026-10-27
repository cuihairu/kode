import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  clearDatabaseSchemaCacheForTests,
  findTypeStorageUsages,
  getDatabaseSchemaCacheStatsForTests,
  invalidateTypeStorageUsageIndex,
  replaceTypeStorageUsageForEntity
} from '../src/databaseSchema';
import { workspace } from './fake-vscode/workspaceState';
import { allFileSystemWatchers, workspaceState } from './fake-vscode/workspaceState';
import { Uri } from './fake-vscode/core';
import { TypesXmlCodeLensProvider } from '../src/languageProviders';

// IDE-SCH-008:按实体增量维护类型落库反查——修改一个实体只替换它贡献的
// usage 记录,无关实体的记录对象原样保留(不整仓重建);事件面
// replaceTypeStorageUsageForEntity 与查询时懒自愈双轨。

const temporaryDirectories: string[] = [];
const originalFolders = workspace.workspaceFolders;

afterEach(() => {
  workspace.workspaceFolders = originalFolders;
  workspace.textDocuments = [];
  invalidateTypeStorageUsageIndex();
  clearDatabaseSchemaCacheForTests();
  workspaceState.reset();
  for (const dir of temporaryDirectories.splice(0)) { fs.rmSync(dir, { recursive: true, force: true }); }
});

function makeWorkspace(): { root: string; goldDef: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-sch8-'));
  temporaryDirectories.push(root);
  fs.mkdirSync(path.join(root, 'scripts/entity_defs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts/entities.xml'),
    '<root>\n  <Gold/>\n  <Silver/>\n</root>\n', 'utf8');
  fs.writeFileSync(path.join(root, 'scripts/entity_defs/types.xml'),
    '<root>\n  <ITEM_ID> UINT16 </ITEM_ID>\n</root>\n', 'utf8');
  const def = (propName: string) => [
    '<root>',
    '  <Properties>',
    `    <${propName}>`,
    '      <Type>ITEM_ID</Type>',
    '      <Persistent>true</Persistent>',
    `    </${propName}>`,
    '  </Properties>',
    '</root>'
  ].join('\n');
  fs.writeFileSync(path.join(root, 'scripts/entity_defs/Gold.def'), def('coin'), 'utf8');
  fs.writeFileSync(path.join(root, 'scripts/entity_defs/Silver.def'), def('medal'), 'utf8');
  return { root, goldDef: path.join(root, 'scripts/entity_defs/Gold.def') };
}

describe('IDE-SCH-008:按实体增量维护类型落库反查', () => {
  it('事件面:改 Gold 只替换 Gold 的 usage 记录,Silver 记录对象原样保留', () => {
    const { root, goldDef } = makeWorkspace();
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    invalidateTypeStorageUsageIndex();
    clearDatabaseSchemaCacheForTests();
    const before = findTypeStorageUsages(root, 'ITEM_ID');
    expect(before.map(usage => usage.entity).sort()).toEqual(['Gold', 'Silver']);
    const silverBefore = before.find(usage => usage.entity === 'Silver');

    // Gold 加第二条 ITEM_ID 属性 → Gold 贡献翻倍,Silver 不动
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
    replaceTypeStorageUsageForEntity(root, 'Gold');

    const after = findTypeStorageUsages(root, 'ITEM_ID');
    expect(after.filter(usage => usage.entity === 'Gold').map(usage => usage.property).sort())
      .toEqual(['coin', 'gem']);
    const silverAfter = after.find(usage => usage.entity === 'Silver');
    expect(silverAfter).toBe(silverBefore); // 无关实体:同一记录对象,未重建
  });

  it('查询时懒自愈:不调事件面,改 Gold 后下一次反查同样只重建 Gold', () => {
    const { root, goldDef } = makeWorkspace();
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    invalidateTypeStorageUsageIndex();
    clearDatabaseSchemaCacheForTests();
    const before = findTypeStorageUsages(root, 'ITEM_ID');
    const silverBefore = before.find(usage => usage.entity === 'Silver');
    const goldBefore = before.find(usage => usage.entity === 'Gold');
    const missesAfterFirst = getDatabaseSchemaCacheStatsForTests().misses;

    // 改 Gold(不加事件面调用):反查按快照身份自愈
    fs.writeFileSync(goldDef, [
      '<root>',
      '  <Properties>',
      '    <coin>',
      '      <Type>UINT32</Type>',
      '      <Persistent>true</Persistent>',
      '    </coin>',
      '  </Properties>',
      '</root>'
    ].join('\n'), 'utf8');
    const after = findTypeStorageUsages(root, 'ITEM_ID');

    expect(after.map(usage => usage.entity)).toEqual(['Silver']); // Gold 不再用 ITEM_ID
    expect(after[0]).toBe(silverBefore); // Silver 记录对象未重建
    expect(getDatabaseSchemaCacheStatsForTests().misses).toBe(missesAfterFirst + 1); // 只重建 Gold 快照
    expect(goldBefore).toBeDefined();
  });

  it('装配线:CodeLens watcher 对 def 变更走按实体替换,types.xml 变更仍整表清空', () => {
    const { root, goldDef } = makeWorkspace();
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    invalidateTypeStorageUsageIndex();
    clearDatabaseSchemaCacheForTests();

    let lensFired = 0;
    const provider = new TypesXmlCodeLensProvider();
    try {
      provider.onDidChangeCodeLenses(() => { lensFired += 1; });
      // 构造顺序:['**/*.def', '**/types.xml', '**/entities.xml']
      const defWatcher = allFileSystemWatchers[0];
      const typesWatcher = allFileSystemWatchers[1];
      expect(defWatcher && typesWatcher).toBeTruthy();

      const before = findTypeStorageUsages(root, 'ITEM_ID');
      const silverBefore = before.find(usage => usage.entity === 'Silver');
      const missesAfterFirst = getDatabaseSchemaCacheStatsForTests().misses;

      // def 变更:只替换该实体(Gold)的记录,Silver 记录对象原样保留
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
      defWatcher.fireChange(Uri.file(goldDef));
      expect(lensFired).toBe(1);
      const afterDef = findTypeStorageUsages(root, 'ITEM_ID');
      expect(afterDef.filter(usage => usage.entity === 'Gold')).toHaveLength(2);
      expect(afterDef.find(usage => usage.entity === 'Silver')).toBe(silverBefore);
      expect(getDatabaseSchemaCacheStatsForTests().misses).toBe(missesAfterFirst + 1); // 只重建 Gold

      // types.xml 变更:整表清空,全部记录对象重建(值等价但非同对象)
      typesWatcher.fireChange(Uri.file(path.join(root, 'scripts/entity_defs/types.xml')));
      const afterTypes = findTypeStorageUsages(root, 'ITEM_ID');
      expect(afterTypes).toHaveLength(3);
      expect(afterTypes.find(usage => usage.entity === 'Silver')).not.toBe(silverBefore);
      expect(lensFired).toBe(2);
    } finally {
      provider.dispose();
    }
  });
});
