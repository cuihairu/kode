/**
 * RUST-398 (HR-HASH-011): types.xml custom type changes -> reverse-dependency
 * impact report over all affected .def files.
 *
 * Convention:
 * - Custom type declaration = every child element of the types.xml <root>
 *   (alias, ARRAY, FIXED_DICT are all named types; declaration name = element
 *   name; kind = the `type` attribute or the first token of the content).
 * - Type structural shape = canonical structural serialization of the
 *   declaring element (same discipline as hotReloadDefStructure's
 *   structuralNodeFingerprint: comments/whitespace stripped, children
 *   sorted). Shape change = structural change.
 * - Type dependency graph: type A references type B <=> B's name appears in
 *   A's subtree (as a <Type>/<of> token) and B itself is a declared custom
 *   type. Changes propagate along the dependency graph's **transitive
 *   closure**: type B changes -> the semantics of type A that depends on B
 *   change too -> .def files referencing A are affected.
 * - Custom type references of a .def = first token of the <Type>/<Arg>/<of>
 *   element text inside the document, filtered to the set of declared custom
 *   type names. Built-in types (UINT16/STRING/...) are not in the declared
 *   set and are naturally not counted (referencing an unregistered name =
 *   unregistered; there is a separate diagnostic face for that, and this
 *   module does not impersonate it).
 * - Severity: every affected .def is marked restartRequired -- a custom type
 *   shape change is a serialization/RPC shape change (same criterion as the
 *   RUST-397 gate) and is not auto-sent as a plain Python reload; types.xml
 *   itself must not be auto-applied by default per book §19.4, this module
 *   only produces the report.
 * - Added types do not affect existing .def files (existing documents cannot
 *   reference a type that does not exist yet); they are only honestly
 *   recorded in changedTypes; removals/changes propagate via the closure
 *   above.
 *
 * Pure logic with no vscode/fs dependency, unit tests drive it directly;
 * execution orchestration belongs to the hotReload pipeline caller.
 */

import { parseDefDocument, type DefElementNode } from './defParser';

export interface CustomTypeDecl {
  name: string;
  /** Canonical structural shape: changed = structural change (comments/whitespace stripped, children sorted) */
  shape: string;
  /** Directly referenced custom type names (subtree <Type>/<of> tokens ∩ declared set) */
  references: string[];
}

export type CustomTypeChangeKind = 'added' | 'removed' | 'changed';

export interface CustomTypeChange {
  name: string;
  change: CustomTypeChangeKind;
  /** Change description (shared source for echo/report) */
  reason: string;
}

export interface AffectedDef {
  name: string;
  /** Per-item impact (names the reference chain: direct reference vs propagated via type dependency) */
  reasons: string[];
}

export interface TypesImpactReport {
  /** types.xml custom type changes, one entry each (added/removed/shape changed) */
  readonly changedTypes: CustomTypeChange[];
  /** Affected .def files, one entry each (via direct or transitive-closure dependency) */
  readonly affectedDefs: AffectedDef[];
  readonly totalDefCount: number;
  readonly affectedDefCount: number;
  /** Any affected .def exists -> restart required, no automatic hot reload */
  readonly anyAffected: boolean;
}

/** Concatenates all text inside an element, trimmed (used for the <Type> text first token) */
const descendantTextTrimmed = (element: DefElementNode): string => {
  let text = '';
  for (const child of element.children) {
    if (child.kind === 'text') {
      text += child.text.trim();
    } else {
      text += descendantTextTrimmed(child);
    }
  }
  return text;
};

/**
 * Canonical structural serialization (same discipline as
 * hotReloadDefStructure.structuralNodeFingerprint): recursive element names +
 * text, comments/whitespace stripped, children sorted -- comments/whitespace/
 * reordering produce no difference; structural or text changes do.
 */
const structuralShape = (element: DefElementNode): string => {
  const parts: string[] = [];
  // Attributes enter the shape: `<JSONDATA type="UINT32"/>` carries its kind
  // in the type attribute; ignoring attributes would judge UINT32->INT32 as unchanged (the serialized shape did change).
  for (const [key, value] of Object.entries(element.attributes)) {
    parts.push(`${key}=${value}`);
  }
  for (const child of element.children) {
    if (child.kind === 'text') {
      const text = child.text.trim();
      if (text) {
        parts.push(text);
      }
    } else {
      parts.push(`${child.name}{${structuralShape(child)}}`);
    }
  }
  return parts.sort().join('|');
};

const childElements = (element: DefElementNode): DefElementNode[] =>
  element.children.filter((child): child is DefElementNode => child.kind === 'element');

const firstToken = (value: string): string => value.trim().split(/\s+/)[0];

/** All <Type>/<of>/<Arg> text tokens in the subtree (custom type candidates; the caller filters) */
const collectTypeTokens = (element: DefElementNode, into: Set<string>): void => {
  if (element.name === 'Type' || element.name === 'of' || element.name === 'Arg') {
    const token = firstToken(descendantTextTrimmed(element));
    if (token) {
      into.add(token);
    }
  }
  for (const child of childElements(element)) {
    collectTypeTokens(child, into);
  }
};

/**
 * Parses types.xml -> custom type declaration table (name -> declaration).
 * No parsable root = empty table (honest, no invented declarations); on
 * duplicate names the first occurrence wins (same convention as BTreeMap
 * entry/or_insert).
 */
export function parseCustomTypes(typesXml: string): Map<string, CustomTypeDecl> {
  const document = parseDefDocument(typesXml);
  const root = document.root;
  const table = new Map<string, CustomTypeDecl>();
  if (!root) {
    return table;
  }
  // First pass: the declared set (first occurrence wins on duplicates, and remember the declaring element for the second pass to collect tokens)
  const declaredElements = new Map<string, DefElementNode>();
  for (const child of childElements(root)) {
    if (!declaredElements.has(child.name)) {
      declaredElements.set(child.name, child);
      table.set(child.name, {
        name: child.name,
        shape: structuralShape(child),
        references: []
      });
    }
  }
  // Second pass: dependency references = subtree tokens ∩ declared set (the declared set is complete by now)
  const declaredNames = new Set(declaredElements.keys());
  for (const [name, element] of declaredElements) {
    const tokens = new Set<string>();
    collectTypeTokens(element, tokens);
    table.get(name)!.references = [...tokens].filter(token => declaredNames.has(token));
  }
  return table;
}

/**
 * Custom type names referenced by a .def document (direct references):
 * <Type>/<Arg>/<of> text tokens ∩ declared set. Not parsable = empty set
 * (parse failures have their own diagnostic face; this face does not
 * impersonate it).
 */
export function collectDefCustomTypeRefs(
  defText: string,
  declaredNames: ReadonlySet<string>
): Set<string> {
  const document = parseDefDocument(defText);
  const root = document.root;
  const refs = new Set<string>();
  if (!root) {
    return refs;
  }
  const tokens = new Set<string>();
  collectTypeTokens(root, tokens);
  for (const token of tokens) {
    if (declaredNames.has(token)) {
      refs.add(token);
    }
  }
  return refs;
}

/**
 * Transitive closure over the type dependency graph: from -> the set of
 * directly referenced custom type names.
 * reachable = itself ∪ direct references ∪ their references (iterated to a fixed point).
 */
function reachableTypes(from: string, decls: ReadonlyMap<string, CustomTypeDecl>): Set<string> {
  const reached = new Set<string>([from]);
  const queue = [from];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    const decl = decls.get(current);
    if (!decl) {
      continue;
    }
    for (const reference of decl.references) {
      if (!reached.has(reference)) {
        reached.add(reference);
        queue.push(reference);
      }
    }
  }
  return reached;
}

export interface TypesImpactInput {
  /** types.xml text before the change */
  readonly beforeTypesXml: string;
  /** types.xml text after the change */
  readonly afterTypesXml: string;
  /** All .def files in the workspace (name + text; the name is only for naming files in the report) */
  readonly defs: ReadonlyArray<{ name: string; text: string }>;
}

/**
 * types.xml custom type changes -> impact report over affected .def files
 * (HR-HASH-011). Change set = added/removed/shape changed; affected = .def
 * files that directly reference, or reach the change set through the type
 * dependency closure.
 */
export function analyzeTypesImpact(input: TypesImpactInput): TypesImpactReport {
  const before = parseCustomTypes(input.beforeTypesXml);
  const after = parseCustomTypes(input.afterTypesXml);
  const names = new Set<string>([...before.keys(), ...after.keys()]);

  const changedTypes: CustomTypeChange[] = [];
  for (const name of [...names].sort()) {
    const beforeDecl = before.get(name);
    const afterDecl = after.get(name);
    if (!beforeDecl) {
      changedTypes.push({ name, change: 'added', reason: `类型新增: ${name}(声明集新增)` });
    } else if (!afterDecl) {
      changedTypes.push({ name, change: 'removed', reason: `类型删除: ${name}(引用它的 .def 将无法解析)` });
    } else if (beforeDecl.shape !== afterDecl.shape) {
      changedTypes.push({
        name,
        change: 'changed',
        reason: `类型结构变化: ${name}(序列化形状 ${beforeDecl.shape} → ${afterDecl.shape})`
      });
    }
  }

  // Set of impacted custom type names: removals/shape changes (additions do not affect existing .def files)
  const impactful = new Set(
    changedTypes.filter(change => change.change !== 'added').map(change => change.name)
  );

  // Filter .def custom type references by the before∪after declared set: a type present before removal is
  // still custom (the def text is unchanged and still references it); the after set alone must not drop removal refs.
  const unionNames = new Set<string>([...before.keys(), ...after.keys()]);

  // Per .def: reference set ∩ change closure; closure = impacted types reachable from each type this def references (itself included)
  const affectedDefs: AffectedDef[] = [];
  for (const def of input.defs) {
    const refs = collectDefCustomTypeRefs(def.text, unionNames);
    if (refs.size === 0) {
      continue;
    }
    const reasons: string[] = [];
    for (const reference of refs) {
      const reached = reachableTypes(reference, after);
      for (const hit of [...impactful].sort()) {
        if (hit === reference) {
          reasons.push(`直接引用受影响类型: ${reference}`);
        } else if (reached.has(hit)) {
          reasons.push(`经类型依赖传播受影响: ${reference} 依赖 ${hit}`);
        }
      }
    }
    if (reasons.length > 0) {
      affectedDefs.push({ name: def.name, reasons: [...new Set(reasons)] });
    }
  }

  return {
    changedTypes,
    affectedDefs,
    totalDefCount: input.defs.length,
    affectedDefCount: affectedDefs.length,
    anyAffected: affectedDefs.length > 0
  };
}

/** Impact report echo line (shown directly in the detail face) */
export function formatTypesImpactReport(report: TypesImpactReport): string {
  if (report.changedTypes.length === 0) {
    return 'types.xml 无自定义类型结构变化,无影响';
  }
  const typeLine = report.changedTypes.map(change => change.reason).join(';');
  if (!report.anyAffected) {
    return `types.xml 变化: ${typeLine};无 .def 受影响`;
  }
  const defLines = report.affectedDefs
    .map(def => `${def.name}: ${def.reasons.join(';')}`)
    .join('|');
  return `types.xml 变化: ${typeLine};受影响 ${report.affectedDefCount}/${report.totalDefCount} 个 .def — ${defLines}(需重启,不作为普通 Python reload 自动发送)`;
}
