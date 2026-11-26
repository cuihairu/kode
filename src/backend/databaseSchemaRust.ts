// IDE-RUST-008: Rust-core table/column derivation wiring surface --
// `$/kode/databaseSchema/build`.
//
// Boundary (mirrors IDE-RUST-007 "input collection stays in TS, derivation
// belongs to Rust"): table/column derivation belongs to Rust; the inputs are
// the property descriptor tree already collected by TS (properties) plus the
// entity name / def file path / hasCell / table prefix. Property collection
// (walking the def closure + types.xml alias resolution + component module
// domains, fusing the snapshot version manifest) is still handled by
// databaseSchemaCore. When Rust is unavailable (no gate / call failure /
// shape mismatch / exception) this returns null and the caller falls back to
// the TS deriveDatabaseTables.

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
