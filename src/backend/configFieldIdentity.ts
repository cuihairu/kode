/**
 * KSEM-CFG-03 unified config field identity (pure core, zero vscode dependency).
 *
 * Acceptance contract (todo.md SEM-033, formerly KSEM-CFG-03): locate a field by
 * config root / hierarchical path / project / version; distinguish map dynamic
 * keys from fixed object fields.
 *
 * Four axes of field identity (a locating layer above the CFG-02 contract record):
 *  - root: config root ('defaults' engine defaults / 'custom' project override
 *    file / 'final' synthesized final config);
 *  - path: dot-separated hierarchical path (with the <root> wrapper stripped,
 *    same contract as serverConfigCatalog keys);
 *  - project: project identifier (asset-root fingerprint supplied by the caller;
 *    null = pure engine defaults);
 *  - version: engine snapshot anchor (the 942-line baseline, same source as CFG-02).
 *
 * Dynamic key distinction (does not conflict with CFG-02's dynamicKeys — that is
 * the behavioral surface of "does the engine iterate unknown child nodes", not
 * recorded without evidence; this module is the **structural observation surface**):
 *  - fixed: the field name is enumerable in the engine defaults snapshot;
 *  - dynamic-extension: the field only appears in the project custom tree
 *    (structurally provable: no same-name sibling exists in defaults); the
 *    segment name is marked inside the identity string, so locating still works.
 *
 * Pure logic module: input is a parsed tree (parseConfigXml output) plus locating
 * axes; output is the identity string / provenance classification; no file reads,
 * no config reads, no vscode import.
 */
import type { ConfigXmlNode } from '../serverConfigMerge';

export type ConfigRootKind = 'defaults' | 'custom' | 'final';

export interface ConfigFieldLocator {
  root: ConfigRootKind;
  path: string;
  /** Project identifier (asset-root fingerprint/path; null = pure engine defaults) */
  project: string | null;
  /** Engine snapshot anchor (e.g. 'kbengine-defaults-942') */
  version: string;
}

export interface ParsedConfigFieldIdentity {
  root: ConfigRootKind;
  project: string | null;
  version: string;
  path: string;
  /** Names of path segments belonging to dynamic extension segments (custom-only), in order */
  dynamicSegments: readonly string[];
}

/**
 * Compose the field identity string (parseable round-trip):
 * `{root}://{project}@{version}/{path}`; dynamic segments get a `~` marker
 * appended to the segment name:
 * `final://proj-a@kbengine-defaults-942/myservice~.host` — `myservice~`
 * means that segment is a project dynamic extension segment, not a fixed
 * engine object field.
 */
export function configFieldIdentity(
  locator: ConfigFieldLocator,
  dynamicSegments: readonly string[] = [],
): string {
  const markedPath = markDynamicSegments(locator.path, dynamicSegments);
  const project = locator.project ?? '';
  return `${locator.root}://${project}@${locator.version}/${markedPath}`;
}

/** Append the dynamic marker to segment names (the hierarchical segments matching dynamicSegments); returns unchanged if absent */
function markDynamicSegments(path: string, dynamicSegments: readonly string[]): string {
  if (dynamicSegments.length === 0) {
    return path;
  }
  const segments = path.split('.');
  const dynamicSet = new Set(dynamicSegments);
  return segments.map((segment) => (dynamicSet.has(segment) ? `${segment}~` : segment)).join('.');
}

const ROOT_KINDS: readonly ConfigRootKind[] = ['defaults', 'custom', 'final'];

/** Parse the identity string (round-trip); returns null when not well-formed — no guessing. */
export function parseConfigFieldIdentity(id: string): ParsedConfigFieldIdentity | null {
  // version does not allow '@' (when project contains '@' the whole thing fails to match — round-trip integrity takes priority)
  const schemeMatch = id.match(/^(defaults|custom|final):\/\/([^@/]*)@([^/@]+)\/(.+)$/);
  if (!schemeMatch) {
    return null;
  }
  const [, rootKind, project, version, markedPath] = schemeMatch;
  if (!ROOT_KINDS.includes(rootKind as ConfigRootKind) || markedPath.length === 0) {
    return null;
  }
  const dynamicSegments: string[] = [];
  const path = markedPath
    .split('.')
    .map((segment) => {
      if (segment.endsWith('~')) {
        const name = segment.slice(0, -1);
        if (name.length === 0) {
          return null;
        }
        dynamicSegments.push(name);
        return name;
      }
      return segment;
    })
    .join('.');
  if (path.includes('~') || markedPath.startsWith('.') || markedPath.endsWith('.')) {
    return null;
  }
  return {
    root: rootKind as ConfigRootKind,
    project: project.length > 0 ? project : null,
    version,
    path,
    dynamicSegments,
  };
}

export type ConfigFieldIdentityKind = 'fixed' | 'dynamic-extension' | 'dynamic-segment-child';

export interface ConfigFieldProvenance {
  path: string;
  /** Definition layer: the path is present in the defaults snapshot / in the custom project tree */
  definedInDefaults: boolean;
  definedInCustom: boolean;
  /** custom overrides the same-named field from defaults (both defaults+custom present) */
  overriddenByCustom: boolean;
  kind: ConfigFieldIdentityKind;
  /** For dynamic-extension/segment-child: segment names in the path that do not exist in defaults (in order) */
  dynamicSegments: readonly string[];
}

function childByName(node: ConfigXmlNode, name: string): ConfigXmlNode | undefined {
  return node.children.find((child) => child.name === name);
}

/**
 * parseConfigXml output is a synthetic document node with an empty name (the real
 * <root> is its child) — normalize down to the <root> node; if the caller passes
 * the <root> node directly it is returned unchanged.
 */
export function normalizeRootNode(tree: ConfigXmlNode): ConfigXmlNode {
  if (tree.name === '') {
    const rootChild = childByName(tree, 'root');
    if (rootChild !== undefined) {
      return rootChild;
    }
  }
  return tree;
}

/** Descend the tree segment by segment; returns the node when reaching the end, undefined when any segment is missing */
function descend(node: ConfigXmlNode, segments: string[]): ConfigXmlNode | undefined {
  let current: ConfigXmlNode | undefined = node;
  for (const segment of segments) {
    if (current === undefined) {
      return undefined;
    }
    current = childByName(current, segment);
  }
  return current;
}

function segmentsOf(path: string): string[] {
  return path.split('.').filter((segment) => segment.length > 0);
}

/**
 * Provenance classification for a single field. A dynamic segment is the
 * **first** segment in the path that is missing from the defaults snapshot
 * (later descendant segments are not registered again — they are child fields
 * of the dynamic segment, not new dynamic segments).
 */
export function classifyConfigField(
  defaultsTree: ConfigXmlNode,
  customTree: ConfigXmlNode | null,
  path: string,
): ConfigFieldProvenance {
  const defaultsRoot = normalizeRootNode(defaultsTree);
  const segments = segmentsOf(path);
  const dynamicSegments: string[] = [];
  let defaultsCursor: ConfigXmlNode | undefined = defaultsRoot;
  let defaultsLost = false;
  let lostAtIndex = -1;
  segments.forEach((segment, index) => {
    if (defaultsLost) {
      return;
    }
    const next = defaultsCursor === undefined ? undefined : childByName(defaultsCursor, segment);
    if (next === undefined) {
      dynamicSegments.push(segment);
      defaultsLost = true;
      lostAtIndex = index;
      defaultsCursor = undefined;
    } else {
      defaultsCursor = next;
    }
  });
  const definedInDefaults = dynamicSegments.length === 0;
  const customNode = customTree === null ? undefined : descend(normalizeRootNode(customTree), segments);
  const definedInCustom = customNode !== undefined;
  // the dynamic segment is not the tail of the path → its child field: a child field of that segment (not a new dynamic segment)
  const parentDynamic = dynamicSegments.length > 0 && lostAtIndex < segments.length - 1;
  const kind: ConfigFieldIdentityKind = parentDynamic
    ? 'dynamic-segment-child'
    : dynamicSegments.length > 0
      ? 'dynamic-extension'
      : 'fixed';
  return {
    path,
    definedInDefaults,
    definedInCustom,
    overriddenByCustom: definedInDefaults && definedInCustom,
    kind,
    dynamicSegments,
  };
}

/** All leaf + container paths of the tree (dot-separated; skips <root> and the synthetic document wrapper; an item list counts as a container). */
export function collectConfigTreePaths(node: ConfigXmlNode, prefix = ''): string[] {
  const rootNode = prefix === '' ? normalizeRootNode(node) : node;
  const paths: string[] = [];
  for (const child of rootNode.children) {
    const childPath = prefix.length > 0 ? `${prefix}.${child.name}` : child.name;
    if (child.children.length === 0) {
      paths.push(childPath);
    } else if (child.children.every((grandchild) => grandchild.name === 'item')) {
      // <item> list: the container itself is the field (same contract as CFG-02 list records)
      paths.push(childPath);
    } else {
      paths.push(childPath, ...collectConfigTreePaths(child, childPath));
    }
  }
  return paths;
}

export interface ConfigFieldIdentityScan {
  fields: readonly ConfigFieldProvenance[];
  fixed: number;
  dynamicExtension: number;
  dynamicSegmentChild: number;
  overridden: number;
}

/** Full cross-scan of both trees: merge defaults' enumerable fields with custom-only fields, tracing provenance for each. */
export function scanConfigFieldIdentities(
  defaultsTree: ConfigXmlNode,
  customTree: ConfigXmlNode | null,
): ConfigFieldIdentityScan {
  const pathSet = new Set<string>(collectConfigTreePaths(normalizeRootNode(defaultsTree)));
  if (customTree !== null) {
    for (const path of collectConfigTreePaths(normalizeRootNode(customTree))) {
      pathSet.add(path);
    }
  }
  const fields = [...pathSet]
    .sort()
    .map((path) => classifyConfigField(defaultsTree, customTree, path));
  return {
    fields,
    fixed: fields.filter((f) => f.kind === 'fixed').length,
    dynamicExtension: fields.filter((f) => f.kind === 'dynamic-extension').length,
    dynamicSegmentChild: fields.filter((f) => f.kind === 'dynamic-segment-child').length,
    overridden: fields.filter((f) => f.overriddenByCustom).length,
  };
}
