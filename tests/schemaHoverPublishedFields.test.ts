import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { KBEngineHoverProvider } from '../src/languageProviders';
import {
  clearDatabaseSchemaCacheForTests,
  describePropertyDatabaseStoragePublished,
  getDatabaseSchemaCacheStatsForTests,
  scheduleDatabaseSchemaSnapshotBuild
} from '../src/databaseSchema';
import { Position, Uri, makeTextDocument, workspace as stubWorkspace } from './helpers/vscodeStub';
import type { MinimalTextDocument } from './helpers/vscodeStub';

// IDE-SCH-007:属性 hover 查询已发布字段结果——同实体连续悬停不同属性,
// 完整 schema 只构建一次(首个属性 miss),后续属性全部命中同一份已发布
// 快照(表/列对象同源),不重复构建。

let root = '';

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-sch7-'));
  fs.mkdirSync(path.join(root, 'scripts/entity_defs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts/entities.xml'), '<root>\n  <Gold/>\n</root>\n', 'utf8');
  fs.writeFileSync(path.join(root, 'scripts/entity_defs/types.xml'),
    '<root>\n  <ITEM_ID> UINT16 </ITEM_ID>\n</root>\n', 'utf8');
  fs.writeFileSync(path.join(root, 'scripts/entity_defs/Gold.def'), [
    '<root>',
    '  <Properties>',
    '    <hp>',
    '      <Type>UINT32</Type>',
    '      <Persistent>true</Persistent>',
    '    </hp>',
    '    <wallet>',
    '      <Type>ITEM_ID</Type>',
    '      <Persistent>true</Persistent>',
    '    </wallet>',
    '  </Properties>',
    '</root>'
  ].join('\n'), 'utf8');
  stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
  clearDatabaseSchemaCacheForTests();
});

afterAll(() => {
  stubWorkspace.workspaceFolders = [];
  clearDatabaseSchemaCacheForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

const provider = new KBEngineHoverProvider();

const hoverWord = (word: string, line: number, character: number): string => {
  const document: MinimalTextDocument = makeTextDocument(
    fs.readFileSync(path.join(root, 'scripts/entity_defs/Gold.def'), 'utf8'),
    { fileName: path.join(root, 'scripts/entity_defs/Gold.def'), languageId: 'xml' }
  );
  const hover = provider.provideHover(document, new Position(line, character));
  expect(hover).toBeTruthy();
  const contents = (hover as { contents: unknown }).contents;
  const list = Array.isArray(contents) ? contents : [contents];
  return list.map(part => (part as { value?: string }).value ?? String(part)).join('\n');
};

describe('IDE-SCH-007:属性 hover 查询已发布字段结果(IDE-REV-012 冷查询只读已发布)', () => {
  it('冷悬停无存储行且不同步构建;发布后连续悬停同实体不同属性命中同一份快照', async () => {
    // 冷悬停:只读已发布——无同步构建,本悬停不出存储行(miss 来自调度到的后台构建)
    const coldHover = hoverWord('hp', 2, 5);
    expect(coldHover).not.toContain('数据库存储');
    expect(getDatabaseSchemaCacheStatsForTests().size).toBe(0);
    expect(getDatabaseSchemaCacheStatsForTests().misses).toBe(1); // 后台构建登记,未发布

    // 等后台构建发布(在飞则复用同一 Promise)
    await scheduleDatabaseSchemaSnapshotBuild('Gold', root);
    expect(getDatabaseSchemaCacheStatsForTests().size).toBe(1);

    // 发布后:悬停读已发布快照(hit),不重复构建(miss 不增)
    const hpHover = hoverWord('hp', 2, 5);
    expect(hpHover).toContain('数据库存储');
    expect(hpHover).toContain('sm_hp');
    expect(getDatabaseSchemaCacheStatsForTests().misses).toBe(1);

    // 第二个属性:命中同一份快照(hit+1),不重复构建
    const walletHover = hoverWord('wallet', 6, 5);
    expect(walletHover).toContain('数据库存储');
    expect(walletHover).toContain('sm_wallet');
    expect(getDatabaseSchemaCacheStatsForTests().misses).toBe(1);
    expect(getDatabaseSchemaCacheStatsForTests().hits).toBe(2);
    expect(getDatabaseSchemaCacheStatsForTests().size).toBe(1);
  });

  it('字段结果与快照表对象同源(查询已发布结果,非旁路重推导)', () => {
    const first = describePropertyDatabaseStoragePublished('Gold', 'hp');
    const second = describePropertyDatabaseStoragePublished('Gold', 'wallet');
    expect(first?.targets[0].tableName).toBe('tbl_Gold');
    expect(second?.targets[0].tableName).toBe('tbl_Gold');
    // 两次查询取到同一张表对象(同一缓存快照的组成部分)
    expect(second?.targets[0].table).toBe(first?.targets[0].table);
    expect(getDatabaseSchemaCacheStatsForTests().misses).toBe(1); // 仍然零重建
  });
});
