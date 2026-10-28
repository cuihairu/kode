import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getDatabaseSchemaSnapshot } from '../src/databaseSchema';
import {
  deriveDatabaseTables,
  type DatabaseSchemaDerivationInput,
  type PersistentPropertyDescriptor
} from '../src/databaseSchemaCore';
import { configurationOverrides } from './fake-vscode/workspaceState';

// IDE-SCH-001:拆出不访问 VS Code 的 schema 推导函数——deriveDatabaseTables
// 只吃显式输入(实体名/def 路径/属性集/hasCell/表前缀),相同输入恒同表/列;
// 内部不读配置、不读文件、不碰 VS Code(输入收集仍由快照面负责)。

const temporaryDirectories: string[] = [];

afterEach(() => {
  configurationOverrides.delete('kbengine');
  for (const dir of temporaryDirectories.splice(0)) { fs.rmSync(dir, { recursive: true, force: true }); }
});

function makeWorkspace(): { root: string; defPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-sch1-'));
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
  return { root, defPath: path.join(root, 'scripts/entity_defs/Gold.def') };
}

const property = (name: string, typeName = 'UINT32'): PersistentPropertyDescriptor => ({
  name,
  typeName,
  persistent: true,
  identifier: false,
  scopes: ['base'],
  source: {
    filePath: '/ws/entity_defs/Gold.def',
    line: 3,
    path: 'Gold',
    category: 'entity'
  }
});

const derivationInput = (overrides: Partial<DatabaseSchemaDerivationInput> = {}): DatabaseSchemaDerivationInput => ({
  entityName: 'Gold',
  defFilePath: '/ws/entity_defs/Gold.def',
  properties: [property('gold'), property('hp', 'INT32')],
  hasCellContent: true,
  tablePrefix: 'kb_',
  ...overrides
});

describe('IDE-SCH-001:deriveDatabaseTables 纯推导面', () => {
  it('相同显式输入恒同表/列(逐结构 deep-equal)', () => {
    const first = deriveDatabaseTables(derivationInput());
    const second = deriveDatabaseTables(derivationInput());
    expect(second.tables).toEqual(first.tables);
    expect([...second.tableIndex.keys()]).toEqual([...first.tableIndex.keys()]);
    // 主表名与列由输入决定:前缀+实体名,hasCell 六列在场
    expect(first.tableIndex.get('kb_Gold')).toBeDefined();
    expect(first.tables[0].fields.map(field => field.name)).toContain('sm_0_position');
    expect(first.tables[0].fields.map(field => field.name)).toContain('sm_0_direction');
  });

  it('输入变化即结果变化:前缀/hasCell/属性集都是显式输入', () => {
    const base = deriveDatabaseTables(derivationInput());
    const prefixed = deriveDatabaseTables(derivationInput({ tablePrefix: 'zz_' }));
    expect(prefixed.tableIndex.has('kb_Gold')).toBe(false);
    expect(prefixed.tableIndex.has('zz_Gold')).toBe(true);

    const noCell = deriveDatabaseTables(derivationInput({ hasCellContent: false }));
    expect(noCell.tables[0].fields.map(field => field.name)).not.toContain('sm_0_position');

    const renamed = deriveDatabaseTables(derivationInput({ properties: [property('gold')] }));
    expect(JSON.stringify(renamed)).not.toContain('"hp"');
  });

  it('内部不读配置:表前缀只认显式输入,配置覆盖不影响结果', () => {
    configurationOverrides.set('kbengine', { 'db.tablePrefix': 'configshouldnotappear_' });
    const result = deriveDatabaseTables(derivationInput({ tablePrefix: 'explicit_' }));
    expect(result.tableIndex.has('explicit_Gold')).toBe(true);
    expect([...result.tableIndex.keys()].some(name => name.includes('configshouldnotappear')))
      .toBe(false);
  });

  it('内部不读文件:两次调用之间磁盘内容/配置全变,同输入结果不变', () => {
    const { root, defPath } = makeWorkspace();
    const input = derivationInput({
      defFilePath: path.join(path.basename(root), 'scripts/entity_defs/Gold.def')
    });
    const before = deriveDatabaseTables(input);

    // 磁盘与配置全部翻转(纯函数不应感知)
    fs.writeFileSync(defPath, '<root><Properties><hacked><Type>BLOB</Type></hacked></Properties></root>', 'utf8');
    configurationOverrides.set('kbengine', { 'db.tablePrefix': 'flipped_' });

    const after = deriveDatabaseTables(input);
    expect(after.tables).toEqual(before.tables);
  });

  it('快照面接线:生产链路产出的表与显式输入推导一致(重构不换口径)', () => {
    const { root } = makeWorkspace();
    const snapshot = getDatabaseSchemaSnapshot('Gold', root);
    expect(snapshot).not.toBeNull();

    const derived = deriveDatabaseTables(derivationInput({
      defFilePath: snapshot!.defFilePath!,
      properties: [
        { ...property('gold'), filePath: snapshot!.defFilePath!, definitionName: 'Gold' }
      ],
      hasCellContent: snapshot!.tables.some(table =>
        table.fields.some(field => field.name === 'sm_0_position')
      ),
      tablePrefix: 'tbl_'
    }));
    // 主表结构与列序一致(同一推导核心,收集面只负责喂输入)
    expect(derived.tables[0].name).toBe(snapshot!.tables[0].name);
    expect(derived.tables[0].fields.map(field => field.name))
      .toEqual(snapshot!.tables[0].fields.map(field => field.name));
  });
});
