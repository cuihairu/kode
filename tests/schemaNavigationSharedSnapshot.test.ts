import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { clearDatabaseSchemaCacheForTests } from '../src/databaseSchema';
import { KBEngineDatabaseSchemaProvider, createDatabaseSchemaUri } from '../src/databaseSchemaPresentation';
import { workspace } from './fake-vscode/workspaceState';
import { Uri } from './fake-vscode/core';

// IDE-SCH-010:schema 导航复用同一代派生结果——虚拟文档展示与字段反向
// 跳转的表名/行号来自同一份已发布渲染:展示后 def 再变,跳转定位仍对齐
// 屏上文本,不与「另起的最新快照」撕裂;重渲染后定位随新一代走。

const temporaryDirectories: string[] = [];
const originalFolders = workspace.workspaceFolders;

afterEach(() => {
  workspace.workspaceFolders = originalFolders;
  workspace.textDocuments = [];
  clearDatabaseSchemaCacheForTests();
  for (const dir of temporaryDirectories.splice(0)) { fs.rmSync(dir, { recursive: true, force: true }); }
});

function makeWorkspace(): { root: string; heroDef: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-sch10-'));
  temporaryDirectories.push(root);
  fs.mkdirSync(path.join(root, 'scripts/entity_defs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts/entities.xml'), '<root>\n  <Hero/>\n</root>\n', 'utf8');
  fs.writeFileSync(path.join(root, 'scripts/entity_defs/types.xml'),
    '<root>\n  <ITEM_ID> UINT16 </ITEM_ID>\n</root>\n', 'utf8');
  fs.writeFileSync(path.join(root, 'scripts/entity_defs/Hero.def'), [
    '<root>',
    '  <Properties>',
    '    <hp>',
    '      <Type>UINT32</Type>',
    '      <Persistent>true</Persistent>',
    '    </hp>',
    '  </Properties>',
    '</root>'
  ].join('\n'), 'utf8');
  return { root, heroDef: path.join(root, 'scripts/entity_defs/Hero.def') };
}

describe('IDE-SCH-010:schema 导航复用同一代派生结果', () => {
  it('展示后 def 再变:跳转定位对齐屏上文本(同代),不撕裂', () => {
    const { root, heroDef } = makeWorkspace();
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    clearDatabaseSchemaCacheForTests();

    const provider = new KBEngineDatabaseSchemaProvider();
    const uri = createDatabaseSchemaUri('Hero');
    const displayed = provider.provideTextDocumentContent(uri);
    expect(displayed).toContain('TABLE tbl_Hero');
    expect(displayed).toContain('sm_hp');

    // 展示之后 def 变了(加了第二个属性,行结构变化),不触发重渲染:
    // 定位必须仍出自「屏上这一代」——找到 sm_hp 在屏上文本的行
    fs.writeFileSync(heroDef, [
      '<root>',
      '  <Properties>',
      '    <mana>',
      '      <Type>UINT32</Type>',
      '      <Persistent>true</Persistent>',
      '    </mana>',
      '    <hp>',
      '      <Type>UINT32</Type>',
      '      <Persistent>true</Persistent>',
      '    </hp>',
      '  </Properties>',
      '</root>'
    ].join('\n'), 'utf8');

    const publishedLine = provider.locateInPublishedContent(uri, 'tbl_Hero', 'sm_hp');
    expect(publishedLine).not.toBeNull();
    const lines = displayed.split('\n');
    expect(lines[(publishedLine as number) - 1]).toContain('sm_hp'); // 对齐屏上文本

    // 反证:另起最新快照的旧口径此时已经换代(mana 在前,行结构不同)
    const freshLines = provider.provideTextDocumentContent(createDatabaseSchemaUri('Hero')).split('\n');
    const manaIndex = freshLines.findIndex(line => line.includes('sm_mana'));
    const freshHpIndex = freshLines.findIndex(line => line.includes('sm_hp'));
    expect(manaIndex).toBeGreaterThan(-1);
    expect(manaIndex).toBeLessThan(freshHpIndex); // 新代 sm_hp 行号 > 旧代

    // 重渲染后:定位随新一代走(sm_hp 落在新代位置)
    const reRendered = provider.provideTextDocumentContent(uri);
    expect(reRendered).toContain('sm_mana');
    const republishedLine = provider.locateInPublishedContent(uri, 'tbl_Hero', 'sm_hp');
    expect(republishedLine).not.toBe(publishedLine);
    expect(reRendered.split('\n')[(republishedLine as number) - 1]).toContain('sm_hp');
  });

  it('未发布过的 uri 定位返回 null,调用侧退回独立快照口径', () => {
    const { root } = makeWorkspace();
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    clearDatabaseSchemaCacheForTests();

    const provider = new KBEngineDatabaseSchemaProvider();
    const uri = createDatabaseSchemaUri('Hero');
    expect(provider.locateInPublishedContent(uri, 'tbl_Hero', 'sm_hp')).toBeNull();

    // 退路口径仍是可用面:发布后即可定位(独立快照口径由
    // databaseSchema.test.ts 的 locateDatabaseSchemaLine 用例覆盖)
    provider.provideTextDocumentContent(uri);
    expect(provider.locateInPublishedContent(uri, 'tbl_Hero', 'sm_hp')).not.toBeNull();
  });
});
