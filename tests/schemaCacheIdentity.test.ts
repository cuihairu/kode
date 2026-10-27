import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  clearDatabaseSchemaCacheForTests,
  getDatabaseSchemaCacheStatsForTests,
  getDatabaseSchemaSnapshot
} from '../src/databaseSchema';
import { workspace } from './fake-vscode/workspaceState';

// IDE-SCH-002:schema 缓存带实体与根身份——缓存键 = 根+实体名,A/B 两个根的
// 同名实体各自一份表结构,不共用单例快照;条目按 SNP-006/010 双轴判过期
// (文件版本清单/根配置 generation),文件变了重建,不喂旧表。

const temporaryDirectories: string[] = [];

afterEach(() => {
  workspace.textDocuments = [];
  clearDatabaseSchemaCacheForTests();
  for (const dir of temporaryDirectories.splice(0)) { fs.rmSync(dir, { recursive: true, force: true }); }
});

function makeWorkspace(goldType: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-sch2-'));
  temporaryDirectories.push(root);
  fs.mkdirSync(path.join(root, 'scripts/entity_defs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts/entities.xml'), '<root>\n  <Gold/>\n</root>\n', 'utf8');
  fs.writeFileSync(path.join(root, 'scripts/entity_defs/Gold.def'), [
    '<root>',
    '  <Properties>',
    '    <gold>',
    `      <Type>${goldType}</Type>`,
    '      <Persistent>true</Persistent>',
    '    </gold>',
    '  </Properties>',
    '</root>'
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(root, 'scripts/entity_defs/types.xml'), '<root>\n</root>\n', 'utf8');
  return root;
}

const fieldNames = (root: string): string[] | null => {
  const snapshot = getDatabaseSchemaSnapshot('Gold', root);
  return snapshot ? snapshot.tables[0].fields.map(field => field.name) : null;
};

describe('IDE-SCH-002:schema 缓存的实体与根身份', () => {
  it('同根同实体:第二次命中缓存(不重建)', () => {
    const root = makeWorkspace('UINT32');
    clearDatabaseSchemaCacheForTests();
    const first = getDatabaseSchemaSnapshot('Gold', root);
    expect(first).not.toBeNull();
    expect(getDatabaseSchemaCacheStatsForTests().misses).toBe(1);

    const second = getDatabaseSchemaSnapshot('Gold', root);
    expect(second).not.toBeNull();
    expect(getDatabaseSchemaCacheStatsForTests().hits).toBe(1);
    expect(second).toBe(first); // 同一条目(命中返回同一快照对象)
  });

  it('A/B 同名实体各自表结构:根身份入键,不共用单例快照', () => {
    const rootA = makeWorkspace('UINT32');
    const rootB = makeWorkspace('STRING');
    clearDatabaseSchemaCacheForTests();

    const snapshotA = getDatabaseSchemaSnapshot('Gold', rootA);
    const snapshotB = getDatabaseSchemaSnapshot('Gold', rootB);

    expect(snapshotA).not.toBeNull();
    expect(snapshotB).not.toBeNull();
    expect(snapshotA).not.toBe(snapshotB);
    expect(snapshotB!.defFilePath).not.toBe(snapshotA!.defFilePath);
    expect(getDatabaseSchemaCacheStatsForTests().size).toBe(2);

    // 回读 A:A 的条目还在,B 不覆盖 A(无串线)
    const againA = getDatabaseSchemaSnapshot('Gold', rootA);
    expect(againA!.defFilePath).toBe(snapshotA!.defFilePath);
    expect(JSON.stringify(againA!.tables[0].fields)).toBe(JSON.stringify(snapshotA!.tables[0].fields));
  });

  it('文件变更后条目按输入清单判过期重建(不喂旧表)', () => {
    const root = makeWorkspace('UINT32');
    clearDatabaseSchemaCacheForTests();
    const before = getDatabaseSchemaSnapshot('Gold', root);
    expect(before).not.toBeNull();
    expect(JSON.stringify(before!.tables)).not.toContain('"gold2"');

    // 磁盘上新增一条持久属性:版本轴(source/version)漂移 → 过期 → 重建
    fs.writeFileSync(path.join(root, 'scripts/entity_defs/Gold.def'), [
      '<root>',
      '  <Properties>',
      '    <gold>',
      '      <Type>UINT32</Type>',
      '      <Persistent>true</Persistent>',
      '    </gold>',
      '    <gold2>',
      '      <Type>UINT32</Type>',
      '      <Persistent>true</Persistent>',
      '    </gold2>',
      '  </Properties>',
      '</root>'
    ].join('\n'), 'utf8');

    const after = getDatabaseSchemaSnapshot('Gold', root);
    expect(after).not.toBe(before); // 重建,不喂旧表
    expect(JSON.stringify(after!.tables)).toContain('"gold2"');
    expect(getDatabaseSchemaCacheStatsForTests().misses).toBe(2);
  });

  it('打开的脏文档:版本前进即过期(共享快照轴与缓存正交)', () => {
    const root = makeWorkspace('UINT32');
    clearDatabaseSchemaCacheForTests();
    expect(getDatabaseSchemaSnapshot('Gold', root)).not.toBeNull();

    const defPath = path.join(root, 'scripts/entity_defs/Gold.def');
    workspace.textDocuments = [
      { uri: { toString: () => `file://${defPath}`, fsPath: defPath }, version: 5,
        getText: () => '<root><Properties><dirty><Type>UINT32</Type><Persistent>true</Persistent></dirty></Properties></root>',
        fileName: defPath }
    ];

    const dirty = getDatabaseSchemaSnapshot('Gold', root);
    expect(dirty).not.toBeNull();
    expect(JSON.stringify(dirty!.tables)).toContain('"dirty"'); // 脏窗口内容进表
    workspace.textDocuments = [];
  });

  it('缓存有界:超出上限按插入序淘汰(防大工作区长拖)', () => {
    const root = makeWorkspace('UINT32');
    clearDatabaseSchemaCacheForTests();
    const capacity = getDatabaseSchemaCacheStatsForTests().capacity;
    expect(capacity).toBeGreaterThan(0);
    for (let i = 0; i < capacity + 4; i += 1) {
      fs.writeFileSync(path.join(root, 'scripts/entity_defs', `Gold${i}.def`), [
        '<root>',
        '  <Properties>',
        '    <gold>',
        '      <Type>UINT32</Type>',
        '      <Persistent>true</Persistent>',
        '    </gold>',
        '  </Properties>',
        '</root>'
      ].join('\n'), 'utf8');
    }
    for (let i = 0; i < capacity + 4; i += 1) {
      expect(getDatabaseSchemaSnapshot(`Gold${i}`, root)).not.toBeNull();
    }
    expect(getDatabaseSchemaCacheStatsForTests().size).toBeLessThanOrEqual(capacity);
    // 最早条目被淘汰后,重新查它是一次 miss + 重建(不喂错误对象)
    expect(getDatabaseSchemaSnapshot('Gold0', root)).not.toBeNull();
  });
});
