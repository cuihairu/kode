// IDX-REL-001: reverse impact index — types.xml/alias.xml custom type
// entries -> the .def properties that reference them, transitively through
// the declaration graph.
//
// Engine fact: a FIXED_DICT field change is a wire/DB shape change for every
// def property whose type chain reaches that FIXED_DICT (datatype.cpp
// serializes the declared structure), so the impact view must list all such
// properties, not only direct references.
//
// Conventions (same discipline as hotReloadTypesImpact / RUST-398):
// - Custom type declarations come from getEntityCustomTypesSnapshot entries
//   (types.xml and alias.xml both, already canonical: alias.xml loses to
//   types.xml on duplicate names per definitionWorkspace). A declaration
//   references another custom type when the referenced name appears as the
//   first token of a <Type>/<of>/<Arg> element in its subtree or in one of
//   its parsed property structures. Builtin types never match (not in the
//   declared set).
// - Def edges are per-file: each .def contributes property rows
//   (entity = file basename, <Property> name / declaredType / ofRef / line).
//   Content dedupe: re-setting the same text is a no-op, so re-running the
//   panel after editing one types.xml file never reparses def files
//   (acceptance: incremental update, editing one file must not rescan).
// - impactOf(typeName): reverse closure over the declaration graph — the
//   affected set is typeName plus every declared type whose references reach
//   it; a def property row is affected when its declaredType (or its ARRAY
//   element type) is in that set. `via` records the intermediate custom
//   types on the chain from the property's direct token down to typeName
//   (direct hits carry []).
//
// Pure logic, no vscode/fs dependency (type-only import from
// definitionWorkspace, same contract as defFullType.ts).

import type { CustomTypeInfo } from '../definitionWorkspace';
import {
  getDirectChildElement,
  getDirectChildElementsByName,
  getElementText,
  getLineNumberAt,
  parseDefDocument,
  type DefElementNode,
  type DefDocument
} from './defParser';

export interface DefPropertyEdge {
  entity: string;
  filePath: string;
  property: string;
  /** First token of the property's <Type> text (ARRAY keeps the literal) */
  declaredType: string | null;
  /** ARRAY element type: <of> direct child of the property or of its <Type> */
  ofRef: string | null;
  /** <Property> tag line (1-based) */
  line: number;
}

export interface TypeImpactEntry {
  entity: string;
  filePath: string;
  property: string;
  line: number;
  /** Intermediate custom types between the property's direct token and the queried type (direct = []) */
  via: string[];
}

interface DeclEntry {
  /** Custom type names referenced by this declaration */
  references: Set<string>;
}

const firstToken = (value: string | null | undefined): string | null => {
  const head = (value ?? '').trim().split(/\s+/)[0];
  return head || null;
};

/** First token of the first descendant <of> element under a parent element */
const ofTokenUnder = (element: DefElementNode): string | null => {
  for (const child of element.children) {
    if (child.kind === 'element' && child.name === 'of') {
      const token = firstToken(getElementText(child));
      if (token) {
        return token;
      }
    }
  }
  return null;
};

/** Property rows of one .def document (top-level Properties section only) */
export function extractDefPropertyEdges(
  defText: string,
  entity: string,
  filePath: string
): DefPropertyEdge[] {
  const edges: DefPropertyEdge[] = [];
  const document: DefDocument = parseDefDocument(defText);
  const root = document.root;
  if (!root) {
    return edges;
  }
  const properties = getDirectChildElement(root, 'Properties');
  if (!properties) {
    return edges;
  }
  for (const property of getDirectChildElementsByName(properties, 'Property')) {
    const nameNode = getDirectChildElement(property, 'Name');
    const name = firstToken(getElementText(nameNode)) ?? firstToken(property.attributes['Name']);
    if (!name) {
      continue;
    }
    const typeNode = getDirectChildElement(property, 'Type');
    const declaredType = typeNode ? firstToken(getElementText(typeNode)) : null;
    const ofRef = ofTokenUnder(property) ?? (typeNode ? ofTokenUnder(typeNode) : null);
    edges.push({
      entity,
      filePath,
      property: name,
      declaredType,
      ofRef,
      line: getLineNumberAt(document, property.tagStart)
    });
  }
  return edges;
}

/** First tokens of <Type>/<of>/<Arg> elements anywhere in a structure subtree */
const collectStructureTokens = (node: { rawValue: string; children: Array<{ tag: string; value: { rawValue: string; children: unknown[] } }> }, into: Set<string>): void => {
  for (const child of node.children) {
    if (child.tag === 'Type' || child.tag === 'of' || child.tag === 'Arg') {
      const token = firstToken(child.value.rawValue);
      if (token) {
        into.add(token);
      }
    }
    collectStructureTokens(child.value as typeof node, into);
  }
};

/** Declaration reference graph from snapshot entries (declared names only) */
export function buildDeclReferenceGraph(
  entries: readonly CustomTypeInfo[]
): Map<string, DeclEntry> {
  const graph = new Map<string, DeclEntry>();
  for (const info of entries) {
    if (!graph.has(info.name)) {
      graph.set(info.name, { references: new Set() });
    }
  }
  const declared = new Set(graph.keys());
  for (const info of entries) {
    const entry = graph.get(info.name);
    if (!entry) {
      continue;
    }
    const tokens = new Set<string>();
    collectStructureTokens(info.structure as unknown as Parameters<typeof collectStructureTokens>[0], tokens);
    for (const property of info.properties) {
      const typeToken = firstToken(property.typeName);
      if (typeToken) {
        tokens.add(typeToken);
      }
      if (property.typeStructure) {
        collectStructureTokens(property.typeStructure as unknown as Parameters<typeof collectStructureTokens>[0], tokens);
      }
    }
    for (const token of tokens) {
      if (token !== info.name && declared.has(token)) {
        entry.references.add(token);
      }
    }
  }
  return graph;
}

/**
 * Reverse impact of one custom type. `parentOf[t]` = the affected seed that
 * pulled `t` in (`t` references `parentOf[t]`); it doubles as the via-chain
 * source. Returns def property rows sorted by file then line.
 */
export function impactOf(
  typeName: string,
  graph: Map<string, DeclEntry>,
  defEdges: ReadonlyMap<string, DefPropertyEdge[]>
): TypeImpactEntry[] {
  const affected = new Set<string>([typeName]);
  const parentOf = new Map<string, string>();
  // Fixpoint: any declared type referencing an affected type is affected.
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, entry] of graph) {
      if (affected.has(name)) {
        continue;
      }
      let seed: string | null = null;
      for (const reference of entry.references) {
        if (affected.has(reference)) {
          seed = reference;
          break;
        }
      }
      if (seed !== null) {
        affected.add(name);
        parentOf.set(name, seed);
        grew = true;
      }
    }
  }
  const viaOf = (token: string): string[] => {
    const chain: string[] = [];
    let current = token;
    while (current !== typeName && parentOf.has(current)) {
      chain.push(current);
      current = parentOf.get(current)!;
    }
    return chain;
  };
  const entries: TypeImpactEntry[] = [];
  for (const edges of defEdges.values()) {
    for (const edge of edges) {
      const direct = edge.ofRef && edge.declaredType === 'ARRAY' ? edge.ofRef : edge.declaredType;
      if (!direct || !affected.has(direct)) {
        continue;
      }
      entries.push({
        entity: edge.entity,
        filePath: edge.filePath,
        property: edge.property,
        line: edge.line,
        via: viaOf(direct)
      });
    }
  }
  entries.sort((left, right) =>
    left.filePath.localeCompare(right.filePath) ||
    left.line - right.line ||
    left.property.localeCompare(right.property)
  );
  return entries;
}

/**
 * Per-workspace incremental index: def edges are cached per file with
 * content identity (same text = no reparse), declaration snapshots are
 * replaced wholesale from the (watcher-maintained) workspace snapshot.
 */
export class TypeImpactIndex {
  private readonly defEdges = new Map<string, { text: string; edges: DefPropertyEdge[] }>();
  private graph: Map<string, DeclEntry> = new Map();

  /** Ingest one def file; returns true when the parse set changed */
  setDefFile(filePath: string, entity: string, text: string): boolean {
    const cached = this.defEdges.get(filePath);
    if (cached && cached.text === text) {
      return false;
    }
    this.defEdges.set(filePath, { text, edges: extractDefPropertyEdges(text, entity, filePath) });
    return true;
  }

  removeDefFile(filePath: string): void {
    this.defEdges.delete(filePath);
  }

  /** Drop cached edges for files no longer on disk (def file deleted) */
  retainDefFiles(keep: ReadonlySet<string>): void {
    for (const filePath of [...this.defEdges.keys()]) {
      if (!keep.has(filePath)) {
        this.defEdges.delete(filePath);
      }
    }
  }

  getDefFileCount(): number {
    return this.defEdges.size;
  }

  /** Replace the declaration snapshot (types.xml + alias.xml entries) */
  setCustomTypes(entries: readonly CustomTypeInfo[]): void {
    this.graph = buildDeclReferenceGraph(entries);
  }

  /** Def property rows affected by a custom type change, sorted by file/line */
  impactOf(typeName: string): TypeImpactEntry[] {
    const edges = new Map<string, DefPropertyEdge[]>();
    for (const [path, entry] of this.defEdges) {
      edges.set(path, entry.edges);
    }
    return impactOf(typeName, this.graph, edges);
  }
}
