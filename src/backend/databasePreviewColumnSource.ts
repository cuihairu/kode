/**
 * Preview column-source wiring (IDE-REV-018): connects the three-state column
 * sources from databaseColumnSource to the table preview output channel -- the
 * preview table name is looked up against the workspace virtual schema (per
 * registered entity, including ARRAY/component sub-tables); once a descriptor
 * is found, each column renders as derived (declaration site as filePath:line,
 * clickable in the output panel to jump to the def/type line) / synthetic
 * (engine-synthesized column, no declaration site) / unknown (honestly
 * unknown); when the table is outside the derivation surface, the whole
 * section says so honestly rather than guessing a neighboring table. The
 * lookup surface is fully injected: the assembly layer supplies the real
 * registry and schema snapshot.
 */

import type { TableSchemaDescriptor } from './databaseSchemaCore';
import { formatColumnSourceDetail, linkResultColumnsToSources } from './databaseColumnSource';

/** Lookup dependencies: the assembly layer injects the real registry/snapshot surface (test stubs injected) */
export interface ColumnSourceResolverDeps {
  /** List the entity inventory per workspace root (registration order) */
  listEntityRoots(): Array<{ rootPath: string; entityName: string }>;
  getSnapshot(
    entityName: string,
    rootPath: string
  ): { tableIndex: Map<string, TableSchemaDescriptor> } | null;
}

/**
 * Table name -> virtual schema descriptor. IDE-AUD-011: the lookup is
 * constrained by the current connection's scope root (scopeRootPath = the
 * connection's asset root) -- only entity declarations inside that root are
 * recognized; when the scope root is null/unspecified, null is returned
 * honestly (no matching root shows unknown), never falling back to a first
 * match across workspace roots (a same-named table in two projects no longer
 * jumps to the neighboring project's declaration).
 */
export type ColumnSourceTableResolver = (
  tableName: string,
  scopeRootPath: string | null
) => TableSchemaDescriptor | null;

/** Table name -> virtual schema descriptor: look up per registered entity inside the scope root's registry; miss = null */
export function createPreviewColumnSourceTableResolver(
  deps: ColumnSourceResolverDeps
): ColumnSourceTableResolver {
  return (tableName, scopeRootPath) => {
    if (!scopeRootPath) {
      // No scope root (no active profile/asset root): honestly unknown, no workspace first-match
      return null;
    }
    for (const { rootPath, entityName } of deps.listEntityRoots()) {
      if (rootPath !== scopeRootPath) {
        continue; // only honor the current connection's asset root
      }
      const snapshot = deps.getSnapshot(entityName, rootPath);
      const descriptor = snapshot?.tableIndex.get(tableName);
      if (descriptor) {
        return descriptor;
      }
    }
    return null;
  };
}

/** Column-source section: derived rows carry filePath:line (click-to-navigate surface in the output panel); a trailing blank line separates sections */
export function renderColumnSourceSection(
  columns: Array<{ name: string }>,
  table: string,
  descriptor: TableSchemaDescriptor | null
): string[] {
  if (!descriptor) {
    return [`列来源:表 ${table} 不在工作区虚拟 schema 推导面内——各列来源未知(如实,不猜邻居表)`, ''];
  }
  const links = linkResultColumnsToSources(columns, descriptor);
  return [
    `列来源:${descriptor.title}(derived=点击 filePath:line 定位 def/type 声明行;合成列无声明处)`,
    ...links.map(link => `  ${formatColumnSourceDetail(link)}`),
    ''
  ];
}
