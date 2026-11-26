import * as vscode from 'vscode';
import { normalizeDocumentKey } from './documentStore';
import { normalizeFileIdentity } from './pathIdentity';
import { readFileSyncUtf8Recorded } from './fileReadMetrics';
import { getSharedFileTextCache } from './sharedFileTextCache';
import { findPythonReceiverCalls, PYTHON_RECEIVER_BY_SECTION } from './pythonLanguageUtils';
import type { PythonReceiverCall, PythonReceiverSection } from './pythonLanguageUtils';
import {
  parsePythonMethodBlocks,
  sameIdentity,
  type EntityMappingIndex,
  type IndexedMethodDefinition,
  type IndexedPythonMethodLocation
} from '../entityMapping';

export interface DefCallChainNode {
  id: string;
  entity: string;
  methodName: string;
  section: PythonReceiverSection;
  signature: string;
  resolved: boolean;
}

export interface DefCallChainEdge {
  from: string;
  to: string;
  receiver: 'base' | 'cell' | 'client';
}

export interface DefCallChain {
  root: DefCallChainNode;
  nodes: DefCallChainNode[];
  edges: DefCallChainEdge[];
}

export interface DefCallChainStart {
  filePath: string;
  line: number;
  methodName: string;
}

export interface DefCallChainOptions {
  depth?: number;
  readPythonFile?: (filePath: string) => string | null;
}

const RECEIVER_SECTION_TO_METHOD_SECTION: Record<
  DefCallChainEdge['receiver'],
  PythonReceiverSection
> = {
  base: 'BaseMethods',
  cell: 'CellMethods',
  client: 'ClientMethods'
};

/** Synthetic client source node id for Exposed method in-edges (unique, a pure source, not part of the BFS frontier) */
const CLIENT_SOURCE_NODE_ID = 'client';

export function renderDefCallChainMermaid(chain: DefCallChain): string {
  const lines = ['flowchart TD'];
  for (const node of chain.nodes) {
    // The client source uses a stadium shape so it stays visually distinct
    // from resolved boxes (square corners) and unresolved boxes (also stadium,
    // but carrying a "(?)" signature).
    const shape = node.id === CLIENT_SOURCE_NODE_ID
      ? `(["${node.signature}"])`
      : node.resolved ? `["${node.signature}"]` : `(["${node.signature}"])`;
    lines.push(`    ${node.id}${shape}`);
  }
  for (const edge of chain.edges) {
    lines.push(`    ${edge.from} -->|${edge.receiver}| ${edge.to}`);
  }
  return lines.join('\n');
}

function normalizeFilePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').toLowerCase();
}

function methodSignature(method: IndexedMethodDefinition): string {
  const args = method.declaredArgs?.length
    ? method.declaredArgs.join(', ')
    : '';
  return `${method.section}.${method.identity.symbolName}(${args})`;
}

function methodNode(
  method: IndexedMethodDefinition
): DefCallChainNode {
  return {
    id: `${method.identity.ownerName}:${method.section}:${method.identity.symbolName}`,
    entity: method.identity.ownerName,
    methodName: method.identity.symbolName,
    section: method.section,
    signature: methodSignature(method),
    resolved: true
  };
}

function unresolvedNode(
  entity: string,
  methodName: string,
  receiver: DefCallChainEdge['receiver']
): DefCallChainNode {
  const section = RECEIVER_SECTION_TO_METHOD_SECTION[receiver];
  return {
    id: `${entity}:${section}:${methodName}:unresolved`,
    entity,
    methodName,
    section,
    signature: `${section}.${methodName}(?)`,
    resolved: false
  };
}

/** Synthetic client source node for Exposed method in-edges: a pure source, carrying no def method semantics */
function clientSourceNode(): DefCallChainNode {
  return {
    id: CLIENT_SOURCE_NODE_ID,
    entity: 'client',
    methodName: '',
    section: 'ClientMethods',
    signature: 'client',
    resolved: true
  };
}

function findBoundMethod(
  index: EntityMappingIndex,
  definition: IndexedMethodDefinition
): IndexedPythonMethodLocation | undefined {
  return index.pythonMethods.find(method =>
    normalizeFilePath(method.filePath) === normalizeFilePath(definition.defFile) &&
    method.methodName === definition.identity.symbolName
  ) ?? index.pythonMethods.find(method =>
    method.binding && sameIdentity(method.binding.identity, definition.identity)
  );
}

/** Plain self.<name>( calls: only the direct call shape is recognized; receiver keywords (cell/base/client) are excluded */
const PLAIN_SELF_CALL_PATTERN = /\bself\.([A-Za-z_][A-Za-z0-9_]*)\(/g;
const RECEIVER_KEYWORDS = new Set<DefCallChainEdge['receiver']>(['cell', 'base', 'client']);

/**
 * Scan for plain self.<name>( calls (cell/base/client excluded). These calls
 * belong to the def section of the enclosing method: in a cell script
 * self.moveToPoint() goes to CellMethods, in a base script to BaseMethods,
 * in a client script to ClientMethods. The receiver is resolved through the
 * ownSection lookup table.
 */
function findPlainSelfCalls(
  text: string,
  ownSection: PythonReceiverSection
): PythonReceiverCall[] {
  const calls: PythonReceiverCall[] = [];
  const lines = text.split(/\r?\n/);
  const receiver = PYTHON_RECEIVER_BY_SECTION[ownSection];
  for (let index = 0; index < lines.length; index += 1) {
    const regex = new RegExp(PLAIN_SELF_CALL_PATTERN.source, 'g');
    let match: RegExpExecArray | null;
    while ((match = regex.exec(lines[index])) !== null) {
      const methodName = match[1];
      if (RECEIVER_KEYWORDS.has(methodName as DefCallChainEdge['receiver'])) {
        continue;
      }
      calls.push({
        line: index,
        character: match.index + match[0].length - methodName.length,
        receiver,
        section: ownSection,
        methodName
      });
    }
  }
  return calls;
}

function receiverCallsInMethod(
  boundMethod: IndexedPythonMethodLocation,
  ownSection: PythonReceiverSection,
  readPythonFile: (filePath: string) => string | null
): PythonReceiverCall[] {
  const content = readPythonFile(boundMethod.filePath);
  if (content === null) {
    return [];
  }
  const lines = content.split(/\r?\n/);
  const parsedMethods = parsePythonMethodBlocks(content, boundMethod.filePath);
  const methodBlock = parsedMethods.find(method => method.methodName === boundMethod.methodName);
  if (!methodBlock) {
    return [];
  }
  const bodyStart = methodBlock.line;
  // KR-AUD-70: endLine truncation -- methodBlock.endLine is the indentation
  // boundary; without it the bodies of later sibling methods in the same file
  // would be folded into the current method's call surface (sibling calls
  // mis-attributed).
  const bodyText = lines.slice(bodyStart, methodBlock.endLine).join('\n');
  return [
    ...findPythonReceiverCalls(bodyText),
    ...findPlainSelfCalls(bodyText, ownSection)
  ].map(call => ({ ...call, line: call.line + bodyStart }));
}

export function findDefMethodByStart(
  index: EntityMappingIndex,
  start: DefCallChainStart
): IndexedMethodDefinition | undefined {
  const filePath = normalizeFilePath(start.filePath);
  const candidates = index.methodDefinitions.filter(method =>
    method.identity.symbolName === start.methodName
  );
  if (filePath && candidates.length > 1) {
    const sameFile = candidates.filter(method =>
      normalizeFilePath(method.defFile) === filePath
    );
    if (sameFile.length > 0) {
      candidates.length = 0;
      candidates.push(...sameFile);
    }
  }
  const sameLine = candidates.filter(method => method.line === start.line);
  return (sameLine.length > 0 ? sameLine : candidates)[0];
}

export function buildDefCallChain(
  index: EntityMappingIndex,
  start: DefCallChainStart,
  options: DefCallChainOptions = {}
): DefCallChain | null {
  const rootDefinition = findDefMethodByStart(index, start);
  if (!rootDefinition) {
    return null;
  }

  const depth = Math.max(0, options.depth ?? 3);
  const rootNode = methodNode(rootDefinition);
  const nodes = new Map<string, DefCallChainNode>([[rootNode.id, rootNode]]);
  const edges = new Map<string, DefCallChainEdge>();
  const visited = new Set<string>();
  // Record each resolved method node already in the chain -> def, for closing
  // out Exposed in-edges later (only for real def methods).
  const nodeDefinitions = new Map<string, IndexedMethodDefinition>([
    [rootNode.id, rootDefinition]
  ]);
  let frontier: Array<{ node: DefCallChainNode; definition: IndexedMethodDefinition }> = [{
    node: rootNode,
    definition: rootDefinition
  }];

  for (let currentDepth = 0; currentDepth < depth && frontier.length > 0; currentDepth += 1) {
    const nextFrontier: typeof frontier = [];
    for (const { node, definition } of frontier) {
      // The visited dedup has no triggering input -- a node only enters
      // nextFrontier when `!nodes.has(targetNode.id)` (the push arm below);
      // nodes grows monotonically, so each node enters the frontier at most
      // once, and visited never contains the current node (self-loops and
      // mutual calls are both gated by nodes.has, so nothing is re-queued).
      /* istanbul ignore start */
      if (visited.has(node.id)) {
        continue;
      }
      /* istanbul ignore stop */
      visited.add(node.id);

      const boundMethod = findBoundMethod(index, definition);
      if (!boundMethod) {
        continue;
      }

      const receiverCalls = receiverCallsInMethod(
        boundMethod,
        definition.section,
        options.readPythonFile ?? readPythonFileWithMtimeCache
      );
      for (const call of receiverCalls) {
        const targets = index.methodDefinitions.filter(candidate =>
          candidate.section === call.section &&
          candidate.identity.symbolName === call.methodName
        );
        const target = targets.find(candidate =>
          candidate.identity.ownerName === index.rootName
        ) ?? targets[0];
        const targetNode = target
          ? methodNode(target)
          : unresolvedNode(index.rootName, call.methodName, call.receiver);
        if (!nodes.has(targetNode.id)) {
          nodes.set(targetNode.id, targetNode);
          if (target) {
            nodeDefinitions.set(targetNode.id, target);
            nextFrontier.push({ node: targetNode, definition: target });
          }
        }
        const edgeKey = `${node.id}->${targetNode.id}`;
        if (!edges.has(edgeKey)) {
          edges.set(edgeKey, { from: node.id, to: targetNode.id, receiver: call.receiver });
        }
      }
    }
    frontier = nextFrontier;
  }

  // Part A: Exposed methods get a client in-edge. The client source is unique
  // (a single node); each exposed method gets one in-edge. The client source is
  // a pure source and does not enter the BFS (never pushed to any frontier).
  const exposedNodeIds = [...nodeDefinitions.entries()]
    .filter(([, method]) => method.exposed)
    .map(([nodeId]) => nodeId);
  let finalNodes = nodes;
  if (exposedNodeIds.length > 0) {
    finalNodes = new Map<string, DefCallChainNode>();
    finalNodes.set(CLIENT_SOURCE_NODE_ID, clientSourceNode());
    for (const [nodeId, node] of nodes) {
      finalNodes.set(nodeId, node);
    }
    for (const nodeId of exposedNodeIds) {
      const edgeKey = `${CLIENT_SOURCE_NODE_ID}->${nodeId}`;
      if (!edges.has(edgeKey)) {
        edges.set(edgeKey, { from: CLIENT_SOURCE_NODE_ID, to: nodeId, receiver: 'client' });
      }
    }
  }

  return {
    root: rootNode,
    nodes: [...finalNodes.values()],
    edges: [...edges.values()]
  };
}

/**
 * 2026-11-24 batch E: the Python source text is now held by the shared source
 * text cache (see readDiskPythonFile), so this hook was downgraded from
 * "clear this surface's private cache wholesale" to "invalidate precisely by
 * path". The shared cache's stat(mtimeMs+size) dual-key check remains the
 * freshness fallback; path-less call sites no longer need clearing -- entries
 * are re-read on demand by the stat check, so no external table wipe is needed.
 */
export function clearDefCallChainFileCache(pythonPath?: string): void {
  if (pythonPath !== undefined) {
    getSharedFileTextCache().invalidate(pythonPath);
  }
}

/**
 * RUST-003 criterion (2), "opened files come from memory first": an already
 * opened .py is taken from the editor buffer -- no disk read and **no disk
 * cache entry** -- because mtime/size do not change with unsaved edits, and
 * caching would let a stale disk read permanently mask buffer changes. Only
 * when the file is not open do we fall back to disk.
 *
 * The identity key is the canonical identity (`normalizeFileIdentity`, which
 * folds `..` lexically and applies drive-letter/UNC case rules), not
 * `path.normalize`: the latter neither folds `..` nor applies drive-letter
 * rules, so different spellings of the same file would form two entries,
 * distorting both hit rate and invalidation judgement.
 */
function readPythonFileWithMtimeCache(filePath: string): string | null {
  const identity = normalizeFileIdentity(filePath);
  for (const document of vscode.workspace.textDocuments) {
    if (normalizeDocumentKey(document.uri) !== identity) {
      continue;
    }
    return document.getText();
  }
  // Filesystem access still uses the original spelling filePath -- identity
  // has folded `..`/`.` segments, so it is not necessarily an on-disk path;
  // identity serves only as the buffer-matching key.
  return readDiskPythonFile(filePath);
}

function readDiskPythonFile(filePath: string): string | null {
  try {
    // Shared source text cache accounting entry point (2026-11-24 batch E):
    // same stat(mtimeMs+size) dual-key check, 64MiB LRU bounded, shared across
    // surfaces -- replaces this surface's former unbounded private cache.
    return readFileSyncUtf8Recorded(filePath);
  } catch {
    return null;
  }
}
