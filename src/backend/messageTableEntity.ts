/**
 * Shared wiring face for single-entity messageTable construction (IDE-AUD-060):
 * preview (markdown) and export (JSON) share the same build inputs. The owning root's type
 * registry (types.xml) and the entitydefAliasID engine setting are injected here into both
 * build paths (the Rust core buildMessageTableInRust / the TS fallback
 * buildMessageTable), guaranteeing that the selected root's types.xml custom aliases (such
 * as MY_INT->UINT32) reach the type registry -- method parameters no longer misreport
 * unknown-arg-type; the alias switch honestly reflects the engine setting (off by default).
 * The wiring layer resolves the owning root for an entity, reads that root's types.xml and
 * reads the config; this module only injects and dispatches, staying unit-testable.
 */
import {
  buildMessageTable,
  buildMessageTableInRust,
  type DefTreeSource,
  type MessageTable,
  type MessageTableOptions
} from './messageTable';
import type { LocalDefinitionSemantics } from './definitionSemantics';

/** def sourcing: same input shape as the buildMessageTableInRust/buildMessageTable paths */
export interface EntityMessageTableSource {
  loadDefRaw(name: string, kind: 'entity' | 'interface' | 'component'): { content: string; filePath: string } | null;
  loadDef(name: string, kind: 'entity' | 'interface' | 'component'): LocalDefinitionSemantics | null;
}

/** Build context: the source of truth for the type registry and the alias setting (injected by the wiring layer) */
export interface EntityMessageTableContext {
  /** Full text of the entity's owning root's types.xml; returns null when absent/missing/unreadable (build with the default accounting) */
  readEntityTypesXml(entityName: string): string | null;
  /** entitydefAliasID engine setting (off by default); missing/invalid config counts as false */
  readAliasIdEnabled(): boolean;
}

export async function buildEntityMessageTableShared(
  entityName: string,
  source: EntityMessageTableSource,
  context: EntityMessageTableContext
): Promise<MessageTable | null> {
  const options: MessageTableOptions = {
    // missing/unreadable types.xml -> undefined: do not feed the registry, and the build
    // proceeds honestly with the no-custom-type accounting (unknown-arg-type etc. remain real
    // problems, not silently swallowed)
    typesXml: context.readEntityTypesXml(entityName) ?? undefined,
    aliasIdEnabled: context.readAliasIdEnabled()
  };
  const fromRust = await buildMessageTableInRust(entityName, {
    loadDefRaw: (name, kind) => source.loadDefRaw(name, kind)
  }, options);
  if (fromRust) {
    return fromRust;
  }
  const treeSource: DefTreeSource = {
    loadDef: (name, kind) => source.loadDef(name, kind)
  };
  return buildMessageTable(entityName, treeSource, options);
}
