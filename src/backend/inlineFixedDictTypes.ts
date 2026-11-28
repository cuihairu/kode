// IDX-REL-004: inline FIXED_DICT synthesis — a .def property whose <Type>
// carries FIXED_DICT with a nested <Properties> section declares its fields
// inline (never through types.xml). The engine treats it as an anonymous
// FIXED_DICT; this module lifts it into the custom-type registry as a
// synthetic entry so the existing FD faces (member drill, subscript,
// completion, hover, inlay) key on the same registry as types.xml types.
//
// Naming contract: the synthetic name is the flattened `<entity>_<property>`
// identifier (non-identifier characters map to '_'). It must be a legal
// Python identifier because the annotation face emits the registry name
// verbatim (FIXED_DICT annotations reference the TypedDict class emitted by
// kbe_types.pyi) and every registry lookup compares that one form — a dotted
// path name would force a second naming layer onto every face. Collisions
// with a declared type name are resolved at the registry merge
// (definitionWorkspace.getCustomTypeInfos): the synthetic entry is dropped
// honestly rather than shadowing the declared type.
//
// def-side metadata贯通: the outer property's Flags / Persistent /
// Identifier children travel on the synthetic entry (CustomTypeInfo
// extension) — previously only the DB descriptor face saw them.
//
// Pure logic, no vscode/fs dependency (same contract as
// definitionWorkspaceXml, whose property parser this module reuses).

import type { CustomTypeInfo } from '../definitionWorkspace';
import {
  getDirectChildElement,
  getDirectChildElements,
  getElementText,
  getLineNumberAt,
  getScalarChildValue,
  parseDefDocument,
  type DefElementNode,
  type DefDocument
} from './defParser';
import { getInnerXml, parseCustomTypeProperties, parseCustomTypeStructure } from './definitionWorkspaceXml';
import { FIXED_DICT_TYPE_NAME } from './kbengineMetadata';

/**
 * Synthetic registry name of an inline FIXED_DICT on `entity`'s property:
 * `<entity>_<property>` flattened to a legal Python identifier (see the
 * naming contract in the module header).
 */
export function inlineFixedDictSyntheticName(entity: string, propertyName: string): string {
  return `${entity}.${propertyName}`.replace(/[^A-Za-z0-9_]/g, '_');
}

/** First token of the property's <Type> text ('' when absent) */
const firstTypeToken = (property: DefElementNode): string => {
  const typeNode = getDirectChildElement(property, 'Type');
  const text = typeNode ? getElementText(typeNode) : '';
  return text.trim().split(/\s+/)[0] ?? '';
};

/**
 * True when the property declares its type inline as FIXED_DICT with a
 * nested <Properties> section (the synthesis trigger shape).
 */
export function isInlineFixedDictProperty(property: DefElementNode): boolean {
  if (firstTypeToken(property) !== FIXED_DICT_TYPE_NAME) {
    return false;
  }
  const typeNode = getDirectChildElement(property, 'Type');
  return Boolean(typeNode && getDirectChildElement(typeNode, 'Properties'));
}

/** Inline <Properties> node of an inline-FD property's <Type> (or null) */
export function inlineFixedDictPropertiesNode(property: DefElementNode): DefElementNode | null {
  const typeNode = getDirectChildElement(property, 'Type');
  return typeNode ? getDirectChildElement(typeNode, 'Properties') ?? null : null;
}

/** Synthetic CustomTypeInfo entries for one .def document's inline FDs */
export function extractInlineFixedDictTypes(
  defText: string,
  entity: string,
  filePath: string
): CustomTypeInfo[] {
  const entries: CustomTypeInfo[] = [];
  // Synthetic extraction enumerates every .def file; some are deliberately
  // broken (mismatched tags) and the rest of the def pipeline tolerates them
  // via try/catch. An unparseable def yields no synthetic types — skip
  // honestly instead of throwing through getCustomTypeInfos.
  let document: DefDocument;
  try {
    document = parseDefDocument(defText);
  } catch {
    return entries;
  }
  const root = document.root;
  if (!root) {
    return entries;
  }
  const properties = getDirectChildElement(root, 'Properties');
  if (!properties) {
    return entries;
  }
  // Canonical .def shape tags each property by name directly under
  // <Properties> (engine loadDefPropertys reads the tag name), so iterate
  // ALL direct children — the FIXED_DICT gate below does the filtering.
  for (const property of getDirectChildElements(properties)) {
    const name = getElementText(getDirectChildElement(property, 'Name')).trim() ||
      (property.attributes['Name'] ?? '').trim() ||
      property.name.trim();
    if (!name || !isInlineFixedDictProperty(property)) {
      continue;
    }
    const typeNode = getDirectChildElement(property, 'Type')!;
    const line = getLineNumberAt(document, property.tagStart);
    const flags = getScalarChildValue(property, 'Flags')?.trim();
    entries.push({
      name: inlineFixedDictSyntheticName(entity, name),
      filePath,
      line,
      implementedByLine: line,
      startOffset: property.tagStart,
      endOffset: property.closeTagEnd,
      aliasType: FIXED_DICT_TYPE_NAME,
      rawValue: FIXED_DICT_TYPE_NAME,
      structure: parseCustomTypeStructure(getInnerXml(typeNode)),
      properties: parseCustomTypeProperties(document, typeNode),
      synthetic: true,
      flags: flags || undefined,
      persistent: getScalarChildValue(property, 'Persistent')?.trim().toLowerCase() === 'true',
      identifier: getScalarChildValue(property, 'Identifier')?.trim().toLowerCase() === 'true'
    });
  }
  return entries;
}
