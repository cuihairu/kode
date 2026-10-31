// IDE-RUST-008:Rust 核心表/列推导接线面——`$/kode/databaseSchema/build`。
//
// 边界(镜像 IDE-RUST-007「输入收集留 TS、推导归 Rust」):表/列推导归 Rust,
// 入参是 TS 已收集的属性描述符树(properties)+实体名/def 路径/hasCell/表前缀;
// 属性收集(走查 def 闭包 + types.xml 别名解析 + 组件模块域,熔合快照版本清单)
// 仍由 databaseSchemaCore 承担。Rust 不可用(无 gate/调用失败/形状不合规/异常)
// 返回 null,调用方回落到 TS deriveDatabaseTables。

import { getKodeCoreShadowGate } from './kodeCoreShadowFaces';
import type {
  DatabaseSchemaDerivationInput,
  DatabaseSchemaDerivationResult,
  TableSchemaDescriptor
} from './databaseSchemaCore';

interface DatabaseSchemaRustResult {
  tables: TableSchemaDescriptor[];
  tableIndex: Record<string, TableSchemaDescriptor>;
}

export async function buildDatabaseTablesInRust(
  input: DatabaseSchemaDerivationInput
): Promise<DatabaseSchemaDerivationResult | null> {
  const gate = getKodeCoreShadowGate();
  if (!gate) {
    return null;
  }
  const response = await gate.runInRust<DatabaseSchemaRustResult>('$/kode/databaseSchema/build', {
    entityName: input.entityName,
    defFilePath: input.defFilePath,
    properties: input.properties,
    hasCellContent: input.hasCellContent,
    tablePrefix: input.tablePrefix
  });
  if (!response.ok) {
    return null;
  }
  if (!shapeCheckDatabaseTables(response.result)) {
    return null;
  }
  return {
    tables: response.result.tables,
    tableIndex: new Map<string, TableSchemaDescriptor>(Object.entries(response.result.tableIndex))
  };
}

function shapeCheckDatabaseTables(value: unknown): value is DatabaseSchemaRustResult {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const result = value as Record<string, unknown>;
  if (!Array.isArray(result.tables)) {
    return false;
  }
  const tableIndex = result.tableIndex as Record<string, unknown> | undefined;
  if (typeof tableIndex !== 'object' || tableIndex === null) {
    return false;
  }
  for (const table of result.tables as unknown[]) {
    const t = table as Record<string, unknown>;
    if (typeof t.name !== 'string' || typeof t.kind !== 'string' || !Array.isArray(t.fields)) {
      return false;
    }
    for (const field of t.fields as unknown[]) {
      const f = field as Record<string, unknown>;
      if (typeof f.name !== 'string' || typeof f.typeLabel !== 'string') {
        return false;
      }
    }
  }
  return true;
}
