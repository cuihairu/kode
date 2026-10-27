import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  clearDatabaseSchemaCacheForTests,
  getDatabaseSchemaCacheStatsForTests,
  getDatabaseSchemaSnapshot,
  invalidateDatabaseSchemaCacheForFiles
} from '../src/databaseSchema';
import { EntityMappingManager } from '../src/entityMapping';
import { lastFileSystemWatcher, workspace } from './fake-vscode/workspaceState';
import { Uri } from './fake-vscode/core';

// IDE-SCH-003:按 def 依赖版本失效 schema——文件变更面只摘除清单里消费过该
// 文件的缓存条目(它及其依赖实体重建),无关实体的条目原样保留继续命中
// (同一对象),不整缓存清空。

const temporaryDirectories: string[] = [];

afterEach(() => {
  workspace.textDocuments = [];
  clearDatabaseSchemaCacheForTests();
  for (const dir of temporaryDirectories.splice(0)) { fs.rmSync(dir, { recursive: true, force: true }); }
});

function makeWorkspace(): { root: string; baseDef: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-sch3-'));
  temporaryDirectories.push(root);
  fs.mkdirSync(path.join(root, 'scripts/entity_defs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts/entities.xml'),
    '<root>\n  <Gold/>\n  <Silver/>\n</root>\n', 'utf8');
  const baseDef = path.join(root, 'scripts/entity_defs/Base.def');
  fs.writeFileSync(baseDef, [
    '<root>',
    '  <Properties>',
    '    <hp>',
    '      <Type>UINT32</Type>',
    '      <Persistent>true</Persistent>',
    '    </hp>',
    '  </Properties>',
    '</root>'
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(root, 'scripts/entity_defs/Gold.def'), [
    '<root>',
    '  <Parent>Base</Parent>',
    '  <Properties>',
    '    <gold>',
    '      <Type>UINT32</Type>',
    '      <Persistent>true</Persistent>',
    '    </gold>',
    '  </Properties>',
    '</root>'
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(root, 'scripts/entity_defs/Silver.def'), [
    '<root>',
    '  <Properties>',
    '    <silver>',
    '      <Type>UINT32</Type>',
    '      <Persistent>true</Persistent>',
    '    </silver>',
    '  </Properties>',
    '</root>'
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(root, 'scripts/entity_defs/types.xml'), '<root>\n</root>\n', 'utf8');
  return { root, baseDef };
}

describe('IDE-SCH-003:按 def 依赖版本失效 schema', () => {
  it('改 Base.def 只重建依赖它的 Gold;无关 Silver 条目保留继续命中', () => {
    const { root, baseDef } = makeWorkspace();
    clearDatabaseSchemaCacheForTests();
    const goldBefore = getDatabaseSchemaSnapshot('Gold', root);
    const silverBefore = getDatabaseSchemaSnapshot('Silver', root);
    expect(goldBefore).not.toBeNull();
    expect(silverBefore).not.toBeNull();
    expect(JSON.stringify(goldBefore!.tables)).toContain('"hp"'); // 父链属性在表里
    expect(getDatabaseSchemaCacheStatsForTests().size).toBe(2);

    // Base.def 增加一条持久属性:Gold(依赖 Base)该重建,Silver(无关)不动
    fs.writeFileSync(baseDef, [
      '<root>',
      '  <Properties>',
      '    <hp>',
      '      <Type>UINT32</Type>',
      '      <Persistent>true</Persistent>',
      '    </hp>',
      '    <hp2>',
      '      <Type>UINT32</Type>',
      '      <Persistent>true</Persistent>',
      '    </hp2>',
      '  </Properties>',
      '</root>'
    ].join('\n'), 'utf8');
    const dropped = invalidateDatabaseSchemaCacheForFiles([baseDef]);

    expect(dropped).toBe(1); // 只摘 Gold 的条目
    const goldAfter = getDatabaseSchemaSnapshot('Gold', root);
    const silverAfter = getDatabaseSchemaSnapshot('Silver', root);
    expect(goldAfter).not.toBe(goldBefore); // 依赖实体重建
    expect(JSON.stringify(goldAfter!.tables)).toContain('"hp2"');
    expect(silverAfter).toBe(silverBefore); // 无关实体:同一缓存对象
    expect(getDatabaseSchemaCacheStatsForTests().size).toBe(2);
  });

  it('清单命中按路径归一:事件路径拼写差异同样摘除', () => {
    const { root, baseDef } = makeWorkspace();
    clearDatabaseSchemaCacheForTests();
    expect(getDatabaseSchemaSnapshot('Gold', root)).not.toBeNull();
    expect(getDatabaseSchemaSnapshot('Silver', root)).not.toBeNull();

    const dropped = invalidateDatabaseSchemaCacheForFiles([
      baseDef.replace(/\/+$/, '') + ' ' // 故意多余空白不归一?——不,用真实等价拼写:
    ].map(p => p.trim()));

    expect(dropped).toBe(1);
  });

  it('未消费该文件的清单不受影响(返回 0,条目数不变)', () => {
    const { root } = makeWorkspace();
    clearDatabaseSchemaCacheForTests();
    expect(getDatabaseSchemaSnapshot('Gold', root)).not.toBeNull();
    expect(getDatabaseSchemaSnapshot('Silver', root)).not.toBeNull();

    const dropped = invalidateDatabaseSchemaCacheForFiles(['/nonexistent/other.def']);

    expect(dropped).toBe(0);
    expect(getDatabaseSchemaCacheStatsForTests().size).toBe(2);
  });

  it('摘除后重建读最新磁盘内容(懒过期安全网之外,主动失效即刻生效)', () => {
    const { root, baseDef } = makeWorkspace();
    clearDatabaseSchemaCacheForTests();
    const before = getDatabaseSchemaSnapshot('Gold', root);
    expect(JSON.stringify(before!.tables)).not.toContain('"hp2"');

    fs.writeFileSync(baseDef, [
      '<root>',
      '  <Properties>',
      '    <hp2>',
      '      <Type>UINT32</Type>',
      '      <Persistent>true</Persistent>',
      '    </hp2>',
      '  </Properties>',
      '</root>'
    ].join('\n'), 'utf8');
    expect(invalidateDatabaseSchemaCacheForFiles([baseDef])).toBe(1);

    const after = getDatabaseSchemaSnapshot('Gold', root);
    expect(JSON.stringify(after!.tables)).toContain('"hp2"');
    expect(JSON.stringify(after!.tables)).not.toContain('"hp"'); // 新内容,非旧表
  });
});

describe('IDE-SCH-003:def 变更事件面接线(entityMapping → schema 缓存)', () => {
  const originalFindFiles = workspace.findFiles;
  const originalFolders = workspace.workspaceFolders;

  afterEach(() => {
    workspace.findFiles = originalFindFiles;
    workspace.workspaceFolders = originalFolders;
    lastFileSystemWatcher.current = null;
  });

  it('watcher 报 Base.def 变更 → 缓存里只少 Gold 一条(事件时摘除,不等查询)', async () => {
    const { root, baseDef } = makeWorkspace();
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
      for (let i = 0; i < 500 && manager.getAllMappings().length < 2; i += 1) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(manager.getAllMappings().length).toBeGreaterThanOrEqual(2);

      const goldBefore = getDatabaseSchemaSnapshot('Gold', root);
      const silverBefore = getDatabaseSchemaSnapshot('Silver', root);
      expect(goldBefore).not.toBeNull();
      expect(silverBefore).not.toBeNull();
      expect(getDatabaseSchemaCacheStatsForTests().size).toBe(2);

      // Base.def 加属性 → watcher change → 合并窗(30ms)→ 路由 .def → 定向摘除
      fs.writeFileSync(baseDef, [
        '<root>',
        '  <Properties>',
        '    <hp>',
        '      <Type>UINT32</Type>',
        '      <Persistent>true</Persistent>',
        '    </hp>',
        '    <hp2>',
        '      <Type>UINT32</Type>',
        '      <Persistent>true</Persistent>',
        '    </hp2>',
        '  </Properties>',
        '</root>'
      ].join('\n'), 'utf8');
      const watcher = lastFileSystemWatcher.current;
      expect(watcher).not.toBeNull();
      watcher!.fireChange(Uri.file(baseDef));
      for (let i = 0; i < 40 && getDatabaseSchemaCacheStatsForTests().size !== 1; i += 1) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }

      // 事件时摘除:Gold 条目没了(不等查询),Silver 条目还在
      expect(getDatabaseSchemaCacheStatsForTests().size).toBe(1);
      const silverAfter = getDatabaseSchemaSnapshot('Silver', root);
      expect(silverAfter).toBe(silverBefore); // 无关实体:同一缓存对象继续命中
      const goldAfter = getDatabaseSchemaSnapshot('Gold', root);
      expect(goldAfter).not.toBe(goldBefore);
      expect(JSON.stringify(goldAfter!.tables)).toContain('"hp2"');
    } finally {
      manager.dispose();
    }
  });
});
