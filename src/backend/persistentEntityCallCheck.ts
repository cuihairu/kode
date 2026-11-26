import type { CustomTypeInfo } from '../definitionWorkspace';
import { KBENGINE_TYPES } from './kbengineMetadata';
import {
  getDirectChildElement,
  getDirectChildElements,
  getScalarChildValue,
  parseDefDocument,
  type DefElementNode
} from './defParser';

/**
 * .def property-persistence x ENTITYCALL silent-degradation check (the RUST-177/KBE-007
 * diagnostics face, a pure core with zero vscode): when a property explicitly declares
 * `<Persistent>true</Persistent>` and its type (including the types.xml alias-chain end)
 * resolves to ENTITYCALL, the engine, inside the PropertyDescription constructor, **silently
 * flips isPersistent back to false with no log** -- the user thinks the field will persist when
 * it will not; this is where the engine source of truth lands for the "non-serializable field"
 * sub-item.
 *
 * Engine source-of-truth anchors (verified line by line against the local kbengine kbe/src
 * tree):
 * - how the persistence declaration is read: in loadDefPropertys `bool isPersistent = false`
 *   is off by default, and the `<Persistent>` text must be == 'true' after tolower to turn it
 *   on (entitydef.cpp:1181-1187) -- this check uses the same accounting (tolower + identity).
 * - silent degradation: the PropertyDescription constructor's `if(isPersistent &&
 *   strcmp(dataType_->getName(), "ENTITYCALL") == 0) { isPersistent_ =
 *   false; }`, with no logging whatsoever (property.cpp:48-51). What is examined is the
 *   property's own dataType_ getName():
 *   - a literal ENTITYCALL -> hit;
 *   - a types.xml alias-chain end that is ENTITYCALL -> hit (the alias reuses the same
 *     DataType* instance, so getName() is still "ENTITYCALL"; datatypes.cpp:180 addDataType
 *     registers the same pointer + :194 rewrites aliasName);
 *   - an inline ARRAY property -> dataType_ is an array type and getName() is in the "ARRAY"
 *     form, **not a hit** -- an array element being ENTITYCALL does not trigger the engine's
 *     determination; this check uses the same accounting and does not widen it.
 * - the alias-chain consumption face is the same pattern as
 *   scalarAssignCheck.resolveEngineScalarTypeName (drilling down through
 *   CustomTypeInfo.aliasType level by level, with a visited bound; exact name matching, the
 *   same case-sensitive accounting as the engine's dataTypes_ table lookup).
 * - the same engine source of truth on the types.xml side (an FD field defaulting true + the
 *   ENTITYCALL silent degradation) landed in typesXmlStructureCheck (the fdEntityCallPersistent
 *   code) under the types.xml reading; the database schema face already models column pruning
 *   after the same source (databaseSchemaCore); this check is the diagnostics face, and the
 *   three are complementary without overlap.
 *
 * Honest boundary: an omitted `<Persistent>` is false, and values the engine does not recognize
 * such as false/1/yes never turn persistence on (no gap, nothing to report); a cyclic or broken
 * alias chain is treated as unresolvable (the engine already aborts loading on a cyclic chain
 * anyway -- that belongs to the typesXmlStructureCheck forward-reference code); a `<Persistent>`
 * value that is not exactly 'true' (after tolower) is never reported -- the engine simply does
 * not turn it on.
 */

export const PERSISTENT_ENTITY_CALL_DIAGNOSTIC_CODE = 'kbengine.persistentEntityCall';

export interface PersistentEntityCallFinding {
  /** 0-based character offset (anchored on the <Persistent> element -- that is where the user "believed it would persist") */
  offset: number;
  length: number;
  propertyName: string;
  /** The type's verbatim text in the .def (aliases not expanded) */
  declaredType: string;
  message: string;
}

/** Registry of the engine's built-in type names (same source as datatypes.cpp DataTypes::initialize) */
const BUILTIN_TYPE_NAMES: ReadonlySet<string> = new Set(KBENGINE_TYPES.map(item => item.name));

/** Alias-chain end resolution (drilling down through CustomTypeInfo.aliasType, with a visited bound; the engine's dataTypes_ table lookup is case-sensitive) */
function resolveAliasChainEnd(name: string, customTypes: readonly CustomTypeInfo[]): string | null {
  let current = name.trim();
  const visited = new Set<string>();
  while (current.length > 0 && !visited.has(current)) {
    visited.add(current);
    if (BUILTIN_TYPE_NAMES.has(current)) {
      return current;
    }
    const info = customTypes.find(candidate => candidate.name === current);
    if (!info) {
      return null;
    }
    current = info.aliasType;
  }
  return null;
}

/**
 * Full computation: findings for properties where `<Persistent>true</Persistent>` x the
 * type resolves to ENTITYCALL. A pure function (the def text + a snapshot of the types.xml
 * registry, the snapshot coming from the same source as the scalarAssign consumption face).
 */
export function computePersistentEntityCallFindings(
  defText: string,
  customTypes: readonly CustomTypeInfo[]
): PersistentEntityCallFinding[] {
  // The parser throws on malformed XML (assignNodePositions fails to locate); this face
  // only makes claims on parsable documents, and a parse failure = zero findings (the
  // structural face belongs to its own parse diagnostics, not repeated here)
  let document;
  try {
    document = parseDefDocument(defText);
  } catch {
    return [];
  }
  const root = document.root;
  if (!root) { return []; }
  const propertiesSection = getDirectChildElement(root, 'Properties');
  if (!propertiesSection) { return []; }
  const findings: PersistentEntityCallFinding[] = [];
  for (const propertyNode of getDirectChildElements(propertiesSection)) {
    // Engine accounting: persistence is only enabled when the text is exactly 'true' after tolower (entitydef.cpp:1181-1187)
    const persistentRaw = (getScalarChildValue(propertyNode, 'Persistent') ?? '').trim();
    if (persistentRaw.toLowerCase() !== 'true') { continue; }
    // The type directive = getValStr's full-text fold (the engine does not split tokens and looks the whole string up in the table; for the inline ARRAY
    // form getElementText directly takes the text, which is "ARRAY" -- see the header: an array property does not trigger the engine determination)
    const declaredType = (getScalarChildValue(propertyNode, 'Type') ?? '').replace(/\s+/g, ' ').trim();
    if (declaredType.length === 0) { continue; } // a missing/empty type belongs to the unknown-type lint; no claim here
    if (resolveAliasChainEnd(declaredType, customTypes) !== 'ENTITYCALL') { continue; }
    const persistentNode = getDirectChildElement(propertyNode, 'Persistent');
    const span = persistentSpan(propertyNode, persistentNode);
    findings.push({
      offset: span.offset,
      length: span.length,
      propertyName: propertyNode.name,
      declaredType,
      message: `属性「${propertyNode.name}」声明 <Persistent>true</Persistent> 但类型「${declaredType}」解析到 ENTITYCALL：引擎在 PropertyDescription 构造里无日志静默把 isPersistent 改回 false——以为在持久化其实不会持久化（property.cpp:48-51）`
    });
  }
  return findings;
}

/** The anchored <Persistent> element span (falls back to the property's opening tag when missing, a defensive position; the normal path never reaches it) */
function persistentSpan(propertyNode: DefElementNode, persistentNode: DefElementNode | null | undefined): { offset: number; length: number } {
  if (persistentNode) {
    return { offset: persistentNode.tagStart, length: Math.max(1, persistentNode.closeTagEnd - persistentNode.tagStart) };
  }
  return { offset: propertyNode.tagStart, length: Math.max(1, propertyNode.closeTagEnd - propertyNode.tagStart) };
}
