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
import { getRecentFileReads, resetFileReadMetrics, setFileReadVerbose } from '../src/fileReadMetrics';
import { workspace } from './fake-vscode/workspaceState';

// IDE-REV-011(原项 IDE-SCH-007):schema 热命中校验不读取输入文件内容——
// 预热后的重复属性查询返回同代快照,监测 .def/types.xml 的同步读取为零;
// 文件漂移的失效职责在事件面(watcher 定向摘除 + 编辑/关闭事件接线),
// 不再在查询路径逐条目懒重读(原安全网降级为 isDatabaseSchemaSnapshotInputStale 对账面)。

const temporaryDirectories: string[] = [];

afterEach(() => {
  workspace.textDocuments = [];
  setFileReadVerbose(false);
  clearDatabaseSchemaCacheForTests();
  for (const dir of temporaryDirectories.splice(0)) { fs.rmSync(dir, { recursive: true, force: true }); }
});

function makeWorkspace(): { root: string; defPath: string; typesPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-rev11-'));
  temporaryDirectories.push(root);
  fs.mkdirSync(path.join(root, 'scripts/entity_defs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts/entities.xml'), '<root>\n  <Gold hasBase="true"/>\n</root>\n', 'utf8');
  fs.writeFileSync(path.join(root, 'scripts/entity_defs/Gold.def'), [
    '<root>',
    '  <Properties>',
    '    <gold>',
    '      <Type>UINT32</Type>',
    '      <Persistent>true</Persistent>',
    '    </gold>',
    '  </Properties>',
    '</root>'
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(root, 'scripts/entity_defs/types.xml'), '<root>\n</root>\n', 'utf8');
  return {
    root,
    defPath: path.join(root, 'scripts/entity_defs/Gold.def'),
    typesPath: path.join(root, 'scripts/entity_defs/types.xml')
  };
}

function openDocument(fsPath: string, version: number, text: string): void {
  workspace.textDocuments = [
    ...workspace.textDocuments,
    { uri: { toString: () => `file://${fsPath}`, fsPath }, version, getText: () => text }
  ];
}

const schemaInputReads = (): string[] =>
  getRecentFileReads()
    .map(record => record.path)
    .filter(p => p.endsWith('.def') || p.endsWith('types.xml'));

describe('IDE-REV-011:schema 热命中校验零文件读取', () => {
  it('预热后重复查询返回同代快照,零 .def/types.xml 同步读取', () => {
    const { root, defPath, typesPath } = makeWorkspace();
    openDocument(defPath, 8, fs.readFileSync(defPath, 'utf8'));
    openDocument(typesPath, 2, '<root>\n</root>\n');

    const warmed = getDatabaseSchemaSnapshot('Gold', root);
    expect(warmed).not.toBeNull();
    expect(getDatabaseSchemaCacheStatsForTests().misses).toBe(1);

    // 关闭编辑器(内容与盘上一致,无事件):热命中不得为校验而重读输入文件
    workspace.textDocuments = [];
    setFileReadVerbose(true);
    resetFileReadMetrics();
    const first = getDatabaseSchemaSnapshot('Gold', root);
    const second = getDatabaseSchemaSnapshot('Gold', root);
    const third = getDatabaseSchemaSnapshot('Gold', root);

    expect(first).toBe(warmed);
    expect(second).toBe(warmed);
    expect(third).toBe(warmed);
    expect(getDatabaseSchemaCacheStatsForTests().hits).toBe(3);
    expect(schemaInputReads()).toEqual([]);
  });

  it('编辑事件面失效:脏 def 版本前进后定向摘除,下次查询按新缓冲重建', () => {
    const { root, defPath, typesPath } = makeWorkspace();
    openDocument(defPath, 8, fs.readFileSync(defPath, 'utf8'));
    openDocument(typesPath, 2, '<root>\n</root>\n');
    const warmed = getDatabaseSchemaSnapshot('Gold', root);
    expect(warmed).not.toBeNull();

    // 编辑:新版本缓冲加一个属性(事件面在 extension 接线,这里直接调失效面)
    workspace.textDocuments = [];
    openDocument(defPath, 9, [
      '<root>',
      '  <Properties>',
      '    <gold>',
      '      <Type>UINT32</Type>',
      '      <Persistent>true</Persistent>',
      '    </gold>',
      '    <extra>',
      '      <Type>UINT32</Type>',
      '      <Persistent>true</Persistent>',
      '    </extra>',
      '  </Properties>',
      '</root>'
    ].join('\n'));
    expect(invalidateDatabaseSchemaCacheForFiles([defPath])).toBe(1);

    resetFileReadMetrics();
    const rebuilt = getDatabaseSchemaSnapshot('Gold', root);
    expect(rebuilt).not.toBe(warmed);
    expect(rebuilt!.tables.some(table => table.fields.some(field => field.name === 'sm_extra'))).toBe(true);

    // 重建后的热命中同样零读取
    setFileReadVerbose(true);
    resetFileReadMetrics();
    expect(getDatabaseSchemaSnapshot('Gold', root)).toBe(rebuilt);
    expect(schemaInputReads()).toEqual([]);
  });

  it('关闭脏文档(事件面失效)后重建走磁盘域,重复查询仍零读取', () => {
    const { root, defPath, typesPath } = makeWorkspace();
    openDocument(defPath, 8, fs.readFileSync(defPath, 'utf8'));
    openDocument(typesPath, 2, '<root>\n</root>\n');
    const warmed = getDatabaseSchemaSnapshot('Gold', root);

    // 关闭脏文档 = document 域输入消失 → 事件面摘除(磁盘内容与缓冲可能不一致)
    workspace.textDocuments = [];
    expect(invalidateDatabaseSchemaCacheForFiles([defPath])).toBe(1);

    const rebuilt = getDatabaseSchemaSnapshot('Gold', root);
    expect(rebuilt).not.toBeNull();
    expect(rebuilt!.inputVersions?.[defPath]).toEqual({
      source: 'disk',
      version: fs.statSync(defPath).mtimeMs
    });

    setFileReadVerbose(true);
    resetFileReadMetrics();
    expect(getDatabaseSchemaSnapshot('Gold', root)).toBe(rebuilt);
    expect(schemaInputReads()).toEqual([]);
    void warmed;
  });
});
