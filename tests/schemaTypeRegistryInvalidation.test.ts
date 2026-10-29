import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  clearDatabaseSchemaCacheForTests,
  getDatabaseSchemaCacheStatsForTests,
  getDatabaseSchemaSnapshot,
  invalidateDatabaseSchemaCacheForTypeRegistry
} from '../src/databaseSchema';
import { EntityMappingManager } from '../src/entityMapping';
import { lastFileSystemWatcher, workspace } from './fake-vscode/workspaceState';
import { Uri } from './fake-vscode/core';

// IDE-SCH-004:按 types.xml 依赖版本失效 schema——改一个引用类型(别名)只
// 重建消费该别名的实体,无关实体(不消费它)缓存条目保留继续命中(同一
// 对象),不整缓存清空;事件面 invalidateDatabaseSchemaCacheForTypeRegistry
// 与懒过期双轨同口径。

const temporaryDirectories: string[] = [];

afterEach(() => {
  workspace.textDocuments = [];
  clearDatabaseSchemaCacheForTests();
  for (const dir of temporaryDirectories.splice(0)) { fs.rmSync(dir, { recursive: true, force: true }); }
});

function writeTypes(root: string, itemIdType: string): void {
  fs.writeFileSync(path.join(root, 'scripts/entity_defs/types.xml'), [
    '<root>',
    `  <ITEM_ID>${itemIdType}</ITEM_ID>`,
    '  <SCORE>UINT32</SCORE>',
    '</root>'
  ].join('\n'), 'utf8');
}

function makeWorkspace(): { root: string; typesPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-sch4-'));
  temporaryDirectories.push(root);
  fs.mkdirSync(path.join(root, 'scripts/entity_defs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts/entities.xml'),
    '<root>\n  <Gold/>\n  <Silver/>\n  <Bronze/>\n</root>\n', 'utf8');
  // Gold 消费 ITEM_ID;Silver 消费 SCORE;Bronze 不用别名(纯内建类型)
  const def = (type: string) => [
    '<root>',
    '  <Properties>',
    '    <value>',
    `      <Type>${type}</Type>`,
    '      <Persistent>true</Persistent>',
    '    </value>',
    '  </Properties>',
    '</root>'
  ].join('\n');
  fs.writeFileSync(path.join(root, 'scripts/entity_defs/Gold.def'), def('ITEM_ID'), 'utf8');
  fs.writeFileSync(path.join(root, 'scripts/entity_defs/Silver.def'), def('SCORE'), 'utf8');
  fs.writeFileSync(path.join(root, 'scripts/entity_defs/Bronze.def'), def('UINT32'), 'utf8');
  writeTypes(root, 'UINT16');
  return { root, typesPath: path.join(root, 'scripts/entity_defs/types.xml') };
}

const valueField = (snapshot: ReturnType<typeof getDatabaseSchemaSnapshot>): string | undefined =>
  snapshot?.tables[0].fields.find(field => field.sourcePath === 'value')?.typeLabel;

describe('IDE-SCH-004:按 types.xml 依赖版本失效 schema', () => {
  const originalFindFiles = workspace.findFiles;
  const originalFolders = workspace.workspaceFolders;

  afterEach(() => {
    workspace.findFiles = originalFindFiles;
    workspace.workspaceFolders = originalFolders;
    lastFileSystemWatcher.current = null;
  });

  it('改 ITEM_ID 只重建消费它的 Gold;Silver/Bronze 继续命中同一对象(IDE-REV-011:失效走事件面)', () => {
    const { root, typesPath } = makeWorkspace();
    clearDatabaseSchemaCacheForTests();
    const goldBefore = getDatabaseSchemaSnapshot('Gold', root);
    const silverBefore = getDatabaseSchemaSnapshot('Silver', root);
    const bronzeBefore = getDatabaseSchemaSnapshot('Bronze', root);
    expect(goldBefore).not.toBeNull();
    expect(silverBefore).not.toBeNull();
    expect(bronzeBefore).not.toBeNull();
    expect(valueField(goldBefore)).toContain('smallint'); // 别名解析进列型(UINT16→smallint)
    expect(getDatabaseSchemaCacheStatsForTests().size).toBe(3);

    // types.xml 变更:ITEM_ID UINT16 → UINT8(只动这一个别名)。
    // IDE-REV-011:查询热命中不再懒重读输入文件,盘上变更经事件面失效
    // (entityMapping watcher 路由到 invalidateDatabaseSchemaCacheForTypeRegistry)
    writeTypes(root, 'UINT8');
    expect(invalidateDatabaseSchemaCacheForTypeRegistry(typesPath)).toBe(1);

    const goldAfter = getDatabaseSchemaSnapshot('Gold', root);
    const silverAfter = getDatabaseSchemaSnapshot('Silver', root);
    const bronzeAfter = getDatabaseSchemaSnapshot('Bronze', root);
    expect(goldAfter).not.toBe(goldBefore); // 消费方重建
    expect(valueField(goldAfter)).toContain('tinyint'); // 相关列更新(ITEM_ID→UINT8→tinyint)
    expect(valueField(goldAfter)).not.toContain('smallint');
    expect(silverAfter).toBe(silverBefore); // 无关实体:同一缓存对象
    expect(bronzeAfter).toBe(bronzeBefore); // 不用别名的实体:同一缓存对象
  });

  it('事件面 API:invalidateDatabaseSchemaCacheForTypeRegistry 只摘消费方条目', () => {
    const { root, typesPath } = makeWorkspace();
    clearDatabaseSchemaCacheForTests();
    const goldBefore = getDatabaseSchemaSnapshot('Gold', root);
    const silverBefore = getDatabaseSchemaSnapshot('Silver', root);
    const bronzeBefore = getDatabaseSchemaSnapshot('Bronze', root);

    writeTypes(root, 'UINT8');
    const dropped = invalidateDatabaseSchemaCacheForTypeRegistry(typesPath);

    expect(dropped).toBe(1); // 只摘 Gold
    expect(getDatabaseSchemaCacheStatsForTests().size).toBe(2);
    const silverAfter = getDatabaseSchemaSnapshot('Silver', root);
    const bronzeAfter = getDatabaseSchemaSnapshot('Bronze', root);
    expect(silverAfter).toBe(silverBefore);
    expect(bronzeAfter).toBe(bronzeBefore);
  });

  it('SCORE 变更摘 Silver 不摘 Gold(方向对称)', () => {
    const { root, typesPath } = makeWorkspace();
    clearDatabaseSchemaCacheForTests();
    const goldBefore = getDatabaseSchemaSnapshot('Gold', root);
    expect(getDatabaseSchemaSnapshot('Silver', root)).not.toBeNull();

    fs.writeFileSync(typesPath, [
      '<root>',
      '  <ITEM_ID>UINT16</ITEM_ID>',
      '  <SCORE>INT64</SCORE>',
      '</root>'
    ].join('\n'), 'utf8');
    const dropped = invalidateDatabaseSchemaCacheForTypeRegistry(typesPath);

    expect(dropped).toBe(1); // 这次摘的是 Silver
    const goldAfter = getDatabaseSchemaSnapshot('Gold', root);
    expect(goldAfter).toBe(goldBefore); // Gold 不受 SCORE 变更影响
  });

  it('FIXED_DICT 结构变更同样按消费失效', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-sch4d-'));
    temporaryDirectories.push(root);
    fs.mkdirSync(path.join(root, 'scripts/entity_defs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'scripts/entities.xml'), '<root>\n  <Gold/>\n  <Silver/>\n</root>\n', 'utf8');
    fs.writeFileSync(path.join(root, 'scripts/entity_defs/Gold.def'), [
      '<root>',
      '  <Properties>',
      '    <value>',
      '      <Type>ITEM_BAG</Type>',
      '      <Persistent>true</Persistent>',
      '    </value>',
      '  </Properties>',
      '</root>'
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(root, 'scripts/entity_defs/Silver.def'), [
      '<root>',
      '  <Properties>',
      '    <value>',
      '      <Type>UINT32</Type>',
      '      <Persistent>true</Persistent>',
      '    </value>',
      '  </Properties>',
      '</root>'
    ].join('\n'), 'utf8');
    const typesPath = path.join(root, 'scripts/entity_defs/types.xml');
    fs.writeFileSync(typesPath, [
      '<root>',
      '  <ITEM_BAG>',
      '    FIXED_DICT',
      '    <Properties>',
      '      <count>',
      '        <Type>UINT16</Type>',
      '      </count>',
      '    </Properties>',
      '  </ITEM_BAG>',
      '</root>'
    ].join('\n'), 'utf8');

    clearDatabaseSchemaCacheForTests();
    const goldBefore = getDatabaseSchemaSnapshot('Gold', root);
    const silverBefore = getDatabaseSchemaSnapshot('Silver', root);
    expect(goldBefore).not.toBeNull();
    expect(silverBefore).not.toBeNull();
    const beforeJson = JSON.stringify(goldBefore!.tables.map(table => table.fields.map(f => f.name)));

    // 字典加一个字段:结构定义变了 → 消费方 Gold 重建
    fs.writeFileSync(typesPath, [
      '<root>',
      '  <ITEM_BAG>',
      '    FIXED_DICT',
      '    <Properties>',
      '      <count>',
      '        <Type>UINT16</Type>',
      '      </count>',
      '      <level>',
      '        <Type>UINT8</Type>',
      '      </level>',
      '    </Properties>',
      '  </ITEM_BAG>',
      '</root>'
    ].join('\n'), 'utf8');
    const dropped = invalidateDatabaseSchemaCacheForTypeRegistry(typesPath);

    expect(dropped).toBe(1);
    const goldAfter = getDatabaseSchemaSnapshot('Gold', root);
    expect(goldAfter).not.toBe(goldBefore);
    expect(JSON.stringify(goldAfter!.tables.map(table => table.fields.map(f => f.name))))
      .not.toBe(beforeJson);
    expect(getDatabaseSchemaSnapshot('Silver', root)).toBe(silverBefore);
  });

  it('types.xml 删除:消费方条目全部过期(注册表没了)', () => {
    const { root, typesPath } = makeWorkspace();
    clearDatabaseSchemaCacheForTests();
    expect(getDatabaseSchemaSnapshot('Gold', root)).not.toBeNull();
    expect(getDatabaseSchemaSnapshot('Silver', root)).not.toBeNull();
    expect(getDatabaseSchemaSnapshot('Bronze', root)).not.toBeNull();

    fs.unlinkSync(typesPath);
    const dropped = invalidateDatabaseSchemaCacheForTypeRegistry(typesPath);

    expect(dropped).toBe(2); // Gold(ITEM_ID) 与 Silver(SCORE) 都消费;Bronze 只用内建名,不依赖注册表
    expect(getDatabaseSchemaCacheStatsForTests().size).toBe(1);
  });

  it('接线:watcher 报 types.xml 变更 → 缓存里只少消费方一条(事件时摘除)', async () => {
    const { root, typesPath } = makeWorkspace();
    clearDatabaseSchemaCacheForTests();
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    workspace.findFiles = async () => {
      const results: Array<ReturnType<typeof Uri.file>> = [];
      const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) { walk(full); } else if (entry.name.endsWith('.def')) {
            results.push(Uri.file(full));
          }
        }
      };
      walk(root);
      return results;
    };
    const manager = new EntityMappingManager({ subscriptions: [] } as never);
    try {
      for (let i = 0; i < 500 && manager.getAllMappings().length < 3; i += 1) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(manager.getAllMappings().length).toBeGreaterThanOrEqual(3);

      const goldBefore = getDatabaseSchemaSnapshot('Gold', root);
      const silverBefore = getDatabaseSchemaSnapshot('Silver', root);
      expect(goldBefore).not.toBeNull();
      expect(silverBefore).not.toBeNull();
      expect(getDatabaseSchemaCacheStatsForTests().size).toBeGreaterThanOrEqual(2);

      const beforeSize = getDatabaseSchemaCacheStatsForTests().size; // 发炮前记数(合并窗领先沿同步派发)
      writeTypes(root, 'UINT8'); // 只动 ITEM_ID
      const watcher = lastFileSystemWatcher.current;
      expect(watcher).not.toBeNull();
      watcher!.fireChange(Uri.file(typesPath));
      for (let i = 0; i < 40 && getDatabaseSchemaCacheStatsForTests().size !== beforeSize - 1; i += 1) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }

      expect(getDatabaseSchemaCacheStatsForTests().size).toBe(beforeSize - 1); // 只少 Gold
      expect(getDatabaseSchemaSnapshot('Silver', root)).toBe(silverBefore); // Silver 继续命中
      expect(valueField(getDatabaseSchemaSnapshot('Gold', root))).toContain('tinyint');
    } finally {
      manager.dispose();
    }
  });
});
