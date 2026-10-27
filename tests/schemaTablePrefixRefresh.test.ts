import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  KBEngineDatabaseSchemaProvider,
  createDatabaseSchemaUri,
  getDatabaseSchemaSnapshot
} from '../src/databaseSchema';
import {
  KBEngineDatabaseSimulationProvider,
  buildDatabaseSimulationText,
  createDatabaseSimulationUri
} from '../src/databaseSimulator';
import { configurationOverrides, workspace } from './fake-vscode/workspaceState';
import { Uri } from './fake-vscode/core';

// IDE-SCH-005:按表名前缀配置失效 schema——切换 kbengine.db.tablePrefix 后
// 打开中的 schema 预览/数据库模拟虚拟文档立即重取(新表名不等文件保存;
// 快照面由 SCH-002 的 tablePrefix 轴判过期,provider 每次渲染现读快照)。

const temporaryDirectories: string[] = [];
const originalFolders = workspace.workspaceFolders;

afterEach(() => {
  configurationOverrides.delete('kbengine');
  workspace.textDocuments = [];
  workspace.workspaceFolders = originalFolders;
  for (const dir of temporaryDirectories.splice(0)) { fs.rmSync(dir, { recursive: true, force: true }); }
});

function makeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-sch5-'));
  temporaryDirectories.push(root);
  fs.mkdirSync(path.join(root, 'scripts/entity_defs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts/entities.xml'), '<root>\n  <Gold/>\n</root>\n', 'utf8');
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
  return root;
}

const openVirtual = (uri: Uri): void => {
  workspace.textDocuments = [
    ...workspace.textDocuments,
    { uri, version: 1, getText: () => '', fileName: uri.toString() }
  ];
};

describe('IDE-SCH-005:表前缀切换即时换新表名', () => {
  it('schema 预览 provider.refresh() 无参 = 对全部打开中的 .schema 文档 fire 重取', () => {
    const provider = new KBEngineDatabaseSchemaProvider();
    try {
      const goldUri = createDatabaseSchemaUri('Gold');
      const heroUri = createDatabaseSchemaUri('Hero');
      openVirtual(goldUri);
      openVirtual(heroUri);
      const fired: string[] = [];
      provider.onDidChange(uri => { fired.push(uri.toString()); });

      provider.refresh(); // 无参:不再 no-op

      expect(fired).toEqual([goldUri.toString(), heroUri.toString()]);
    } finally {
      provider.dispose();
    }
  });

  it('模拟 provider.refresh() 对全部打开中的 .dbsim 文档 fire 重取', () => {
    const provider = new KBEngineDatabaseSimulationProvider();
    try {
      const goldUri = createDatabaseSimulationUri('Gold');
      openVirtual(goldUri);
      const fired: string[] = [];
      provider.onDidChange(uri => { fired.push(uri.toString()); });

      provider.refresh();

      expect(fired).toEqual([goldUri.toString()]);
    } finally {
      provider.dispose();
    }
  });

  it('切换前缀后渲染文本即刻用新表名(tbl_ → kb_,不等文件保存)', () => {
    const root = makeWorkspace();
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    const withDefaultPrefix = getDatabaseSchemaSnapshot('Gold', root);
    expect(withDefaultPrefix).not.toBeNull();
    expect(JSON.stringify(withDefaultPrefix!.tables)).toContain('tbl_Gold');

    configurationOverrides.set('kbengine', { 'db.tablePrefix': 'kb_' });
    const switched = getDatabaseSchemaSnapshot('Gold', root);
    expect(switched).not.toBe(withDefaultPrefix); // SCH-002 前缀轴:旧快照判过期
    expect(JSON.stringify(switched!.tables)).toContain('kb_Gold');
    expect(JSON.stringify(switched!.tables)).not.toContain('tbl_Gold');
    // 模拟文档渲染面同源换名(provider 每次渲染现读快照)
    const simulation = buildDatabaseSimulationText('Gold');
    expect(simulation).toContain('kb_Gold');
    expect(simulation).not.toContain('tbl_Gold');
    configurationOverrides.delete('kbengine');
  });
});
