import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { KBEngineHoverProvider } from '../src/languageProviders';
import {
  clearDatabaseSchemaCacheForTests,
  describePropertyDatabaseStorage,
  getDatabaseSchemaCacheStatsForTests
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

describe('IDE-SCH-007:属性 hover 查询已发布字段结果', () => {
  it('连续悬停同实体不同属性:完整 schema 只构建一次,后续命中同一份快照', () => {
    // 第一个属性:一次完整构建(miss=1)
    const hpHover = hoverWord('hp', 2, 5);
    expect(hpHover).toContain('数据库存储');
    expect(hpHover).toContain('sm_hp');
    expect(getDatabaseSchemaCacheStatsForTests().misses).toBe(1);

    // 第二个属性:命中已发布快照(miss 不增,hit+1),不重复构建
    const walletHover = hoverWord('wallet', 6, 5);
    expect(walletHover).toContain('数据库存储');
    expect(walletHover).toContain('sm_wallet');
    expect(getDatabaseSchemaCacheStatsForTests().misses).toBe(1);
    expect(getDatabaseSchemaCacheStatsForTests().hits).toBe(1);
    expect(getDatabaseSchemaCacheStatsForTests().size).toBe(1);
  });

  it('字段结果与快照表对象同源(查询已发布结果,非旁路重推导)', () => {
    const first = describePropertyDatabaseStorage('Gold', 'hp');
    const second = describePropertyDatabaseStorage('Gold', 'wallet');
    expect(first?.targets[0].tableName).toBe('tbl_Gold');
    expect(second?.targets[0].tableName).toBe('tbl_Gold');
    // 两次查询取到同一张表对象(同一缓存快照的组成部分)
    expect(second?.targets[0].table).toBe(first?.targets[0].table);
    expect(getDatabaseSchemaCacheStatsForTests().misses).toBe(1); // 仍然零重建
  });
});
