import { describe, expect, it } from 'vitest';
import { buildDatabaseTablesInRust } from '../src/databaseSchemaRust';
import type { KodeCoreGate } from '../src/kodeCoreGate';
import { setKodeCoreShadowGate } from '../src/kodeCoreShadowFaces';
import type {
  DatabaseSchemaDerivationInput,
  TableSchemaDescriptor
} from '../src/databaseSchemaCore';

// IDE-RUST-008 数据库表/列推导 Rust 核心接线:buildDatabaseTablesInRust 主路径经
// 命令级 RPC($/kode/databaseSchema/build)调 Rust 核心;Rust 不可用(无 gate/
// 调用失败/形状不合规/异常)返回 null,调用方回落 TS deriveDatabaseTables。
// 契约:参数形状(entityName/defFilePath/properties/hasCellContent/tablePrefix)
// 与 tableIndex 对象→Map 转换是断言重点。

const source = (path: string) => ({
  filePath: '/defs/entity_defs/Gold.def',
  line: 3,
  path,
  category: 'entity' as const
});

const input = (overrides: Partial<DatabaseSchemaDerivationInput> = {}): DatabaseSchemaDerivationInput => ({
  entityName: 'Gold',
  defFilePath: '/defs/entity_defs/Gold.def',
  properties: [
    {
      name: 'gold',
      typeName: 'UINT32',
      persistent: true,
      identifier: false,
      scopes: ['base'],
      source: source('Gold')
    }
  ],
  hasCellContent: true,
  tablePrefix: 'tbl_',
  ...overrides
});

const cannedTable = (): TableSchemaDescriptor => ({
  name: 'tbl_Gold',
  kind: 'entity',
  title: 'Gold',
  source: source('Gold'),
  propertyPath: 'Gold',
  fields: [
    { name: 'id', typeLabel: 'bigint unsigned', sourcePath: 'id', source: source('Gold'), identifier: false, synthetic: true },
    { name: 'sm_gold', typeLabel: 'int unsigned', sourcePath: 'Gold', source: source('Gold'), identifier: false }
  ]
});

const cannedResult = () => ({
  tables: [cannedTable()],
  tableIndex: { tbl_Gold: cannedTable() }
});

describe('buildDatabaseTablesInRust(数据库表/列推导 Rust 主路径)', () => {
  it('Rust 核心在场:契约参数含 entityName/defFilePath/properties/hasCellContent/tablePrefix,返回结果', async () => {
    let calledMethod = '';
    let calledParams: unknown = null;
    const fakeGate = {
      runInRust: async (method: string, params: unknown) => {
        calledMethod = method;
        calledParams = params;
        return { ok: true, result: cannedResult() };
      }
    } as unknown as KodeCoreGate;
    setKodeCoreShadowGate(fakeGate);
    try {
      const result = await buildDatabaseTablesInRust(input());
      expect(result).not.toBeNull();
      expect(result?.tables).toHaveLength(1);
      expect(result?.tables[0].name).toBe('tbl_Gold');
      // tableIndex 对象 → Map
      expect(result?.tableIndex.get('tbl_Gold')?.kind).toBe('entity');

      expect(calledMethod).toBe('$/kode/databaseSchema/build');
      const params = calledParams as {
        entityName: string;
        defFilePath: string;
        properties: unknown[];
        hasCellContent: boolean;
        tablePrefix: string;
      };
      expect(params.entityName).toBe('Gold');
      expect(params.defFilePath).toContain('Gold.def');
      expect(params.properties).toHaveLength(1);
      expect((params.properties[0] as { typeName: string }).typeName).toBe('UINT32');
      expect(params.hasCellContent).toBe(true);
      expect(params.tablePrefix).toBe('tbl_');
    } finally {
      setKodeCoreShadowGate(null);
    }
  });

  it('Rust 不可用(无 gate)返回 null', async () => {
    setKodeCoreShadowGate(null);
    const result = await buildDatabaseTablesInRust(input());
    expect(result).toBeNull();
  });

  it('Rust 调用失败(!ok)返回 null', async () => {
    const fakeGate = {
      runInRust: async () => ({ ok: false, reason: 'no serverPath' })
    } as unknown as KodeCoreGate;
    setKodeCoreShadowGate(fakeGate);
    try {
      const result = await buildDatabaseTablesInRust(input());
      expect(result).toBeNull();
    } finally {
      setKodeCoreShadowGate(null);
    }
  });

  it('Rust 结果形状不合规返回 null', async () => {
    const malformed = {
      tables: [{ name: 'tbl_Gold', kind: 'entity', fields: [{ name: 'id' }] }], // 缺 typeLabel
      tableIndex: {}
    };
    const fakeGate = {
      runInRust: async () => ({ ok: true, result: malformed })
    } as unknown as KodeCoreGate;
    setKodeCoreShadowGate(fakeGate);
    try {
      const result = await buildDatabaseTablesInRust(input());
      expect(result).toBeNull();
    } finally {
      setKodeCoreShadowGate(null);
    }
  });

  it('Rust 结果缺 tableIndex 对象返回 null', async () => {
    const malformed = { tables: [cannedTable()] };
    const fakeGate = {
      runInRust: async () => ({ ok: true, result: malformed })
    } as unknown as KodeCoreGate;
    setKodeCoreShadowGate(fakeGate);
    try {
      const result = await buildDatabaseTablesInRust(input());
      expect(result).toBeNull();
    } finally {
      setKodeCoreShadowGate(null);
    }
  });
});
