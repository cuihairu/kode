import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { deriveDatabaseTables } from '../src/databaseSchemaCore';

// IDE-ARC-004 schema 三面拆分:①纯 schema 推导(databaseSchemaCore)——
// deriveDatabaseTables 全管线(类型/解析/合并/建表)不 import vscode;
// ②VS Code 适配/快照面(databaseSchema)——工作区/配置收集+缓存+渲染;
// ③虚拟文档 provider(databaseSchemaPresentation)——只装配展示,不含推导。
// 既有行为不变:同输入恒同表列(SCH-001 口径在core模块上继续成立)。

const root = join(__dirname, '..');

describe('schema 三面拆分(IDE-ARC-004)', () => {
  it('纯推导面:deriveDatabaseTables 同输入恒同表列(行为在 core 模块上保持)', () => {
    const input = {
      entityName: 'Hero',
      defFilePath: '/ws/scripts/entity_defs/Hero.def',
      properties: [
        {
          name: 'level',
          typeName: 'UINT32',
          persistent: true,
          identifier: false,
          scopes: ['base' as const],
          source: { filePath: '/ws/scripts/entity_defs/Hero.def', line: 3, path: 'Hero', category: 'entity' as const }
        }
      ],
      hasCellContent: false,
      tablePrefix: 'tbl_'
    };
    const first = deriveDatabaseTables(input);
    const second = deriveDatabaseTables(input);
    expect(first.tables.map(table => table.name)).toEqual(second.tables.map(table => table.name));
    expect(first.tableIndex.size).toBe(second.tableIndex.size);
    expect(first.tables.map(table => table.fields.map(field => field.name))).toEqual(
      second.tables.map(table => table.fields.map(field => field.name))
    );
  });

  it('core 模块不 import vscode(纯推导零 vscode 依赖)', () => {
    const core = readFileSync(join(root, 'src/databaseSchemaCore.ts'), 'utf8');
    expect(core.includes("from 'vscode'"), 'core 不得 import vscode').toBe(false);
    expect(core.includes('vscode.')).toBe(false);
  });

  it('虚拟文档 provider 只装配展示:presentation 模块不含推导面', () => {
    const presentation = readFileSync(join(root, 'src/databaseSchemaPresentation.ts'), 'utf8');
    expect(presentation.includes('class KBEngineDatabaseSchemaProvider')).toBe(true);
    for (const derivationFace of ['deriveDatabaseTables', 'buildMysqlTableSchemas', 'appendPropertyToTable', 'parsePropertySection']) {
      expect(presentation.includes(derivationFace), `provider 模块不应含推导面 ${derivationFace}`).toBe(false);
    }
  });

  it('databaseSchema 不再定义推导/发布面(单一事实源在 core 与 presentation)', () => {
    const adapter = readFileSync(join(root, 'src/databaseSchema.ts'), 'utf8');
    expect(adapter.includes('export function deriveDatabaseTables')).toBe(false);
    expect(adapter.includes('export class KBEngineDatabaseSchemaProvider')).toBe(false);
    expect(adapter.includes('export function createDatabaseSchemaUri')).toBe(false);
    expect(adapter.includes("from './databaseSchemaCore'")).toBe(true);
  });
});
