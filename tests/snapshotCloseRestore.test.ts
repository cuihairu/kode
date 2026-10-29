import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createDefinitionSemanticsLoader } from '../src/definitionSemantics';
import { resolveEntityAnnotationType } from '../src/definitionWorkspace';
import { getDatabaseSchemaSnapshot, invalidateDatabaseSchemaCacheForFiles } from '../src/databaseSchema';
import type { DatabaseSchemaSnapshot } from '../src/databaseSchema';
import { resetSemanticTypeRegistryForTests } from '../src/semanticIndex';
import { getStoredSnapshotCount, releaseDocument, updateDocumentSnapshot } from '../src/documentStore';
import { workspace } from './fake-vscode/workspaceState';

// IDE-SNP-005:关闭脏文档后恢复磁盘版本——丢弃未保存修改并关闭后,下一次
// 查询不再使用脏快照(语义 loader / 数据库 schema / 类型注册表 / 文档快照仓
// 四面同一流程锁;各面单点行为已分别由 SNP-002/003/004 锁,这里是跨面一致)。

const temporaryDirectories: string[] = [];

afterEach(() => {
  workspace.textDocuments = [];
  resetSemanticTypeRegistryForTests();
  for (const dir of temporaryDirectories.splice(0)) { fs.rmSync(dir, { recursive: true, force: true }); }
});

describe('IDE-SNP-005:关闭脏文档后恢复磁盘版本', () => {
  it('丢弃未保存修改并关闭:loader/schema/注册表下一次查询全部回到磁盘版本', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-snp5-'));
    temporaryDirectories.push(root);
    const defPath = path.join(root, 'scripts/entity_defs/Gold.def');
    const typesPath = path.join(root, 'scripts/entity_defs/types.xml');
    fs.mkdirSync(path.join(root, 'scripts/entity_defs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'scripts/entities.xml'), '<root>\n  <Gold hasBase="true"/>\n</root>\n', 'utf8');
    fs.writeFileSync(defPath, [
      '<root>',
      '  <Properties>',
      '    <hp>',
      '      <Type>UINT32</Type>',
      '      <Persistent>true</Persistent>',
      '    </hp>',
      '  </Properties>',
      '</root>'
    ].join('\n'), 'utf8');
    fs.writeFileSync(typesPath, '<root>\n</root>\n', 'utf8');

    const dirtyDef = [
      '<root>',
      '  <Properties>',
      '    <hp>',
      '      <Type>UINT32</Type>',
      '      <Persistent>true</Persistent>',
      '    </hp>',
      '    <gold>',
      '      <Type>GOLD_UID</Type>',
      '      <Persistent>true</Persistent>',
      '    </gold>',
      '  </Properties>',
      '</root>'
    ].join('\n');
    const dirtyTypes = '<root>\n  <GOLD_UID>UINT32</GOLD_UID>\n</root>\n';

    const openDocuments = (defText: string, typesText: string): void => {
      workspace.textDocuments = [
        { uri: { toString: () => `file://${defPath}`, fsPath: defPath }, version: 8, getText: () => defText },
        { uri: { toString: () => `file://${typesPath}`, fsPath: typesPath }, version: 2, getText: () => typesText }
      ];
    };

    const schemaFieldNames = (snapshot: DatabaseSchemaSnapshot | null): string[] =>
      (snapshot?.tables.find(table => table.kind === 'entity')?.fields ?? []).map(field => field.name);

    // 脏窗口:def + types.xml 同时带未保存修改,三面都读到脏版本
    openDocuments(dirtyDef, dirtyTypes);
    expect(createDefinitionSemanticsLoader(root)!.loadLocal('Gold', 'entity')
      ?.properties.map(property => property.name)).toEqual(['hp', 'gold']);
    expect(schemaFieldNames(getDatabaseSchemaSnapshot('Gold', root))).toContain('sm_gold');
    expect(resolveEntityAnnotationType(root, 'GOLD_UID')).toBe('int');

    // 丢弃未保存修改并关闭:事件面摘除(IDE-REV-011),下一次查询全部回到磁盘版本
    workspace.textDocuments = [];
    invalidateDatabaseSchemaCacheForFiles([defPath]);
    expect(createDefinitionSemanticsLoader(root)!.loadLocal('Gold', 'entity')
      ?.properties.map(property => property.name)).toEqual(['hp']);
    const diskSnapshot = getDatabaseSchemaSnapshot('Gold', root);
    expect(schemaFieldNames(diskSnapshot)).not.toContain('sm_gold');
    expect(resolveEntityAnnotationType(root, 'GOLD_UID')).toBe('Any');
  });

  it('文档快照仓:关闭即释放,脏快照不再可peek(生产 onDidClose → releaseDocument 接线面)', () => {
    const fsPath = '/kode-snp5-release/Gold.def';
    const document = {
      uri: { toString: () => `file://${fsPath}`, fsPath },
      version: 3,
      getText: () => '<root><Dirty/></root>'
    };
    const baseline = getStoredSnapshotCount();
    updateDocumentSnapshot(document);
    expect(getStoredSnapshotCount()).toBe(baseline + 1);
    releaseDocument(document);
    expect(getStoredSnapshotCount()).toBe(baseline);
  });
});
