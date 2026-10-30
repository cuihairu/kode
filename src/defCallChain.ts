import * as fs from 'fs';
import * as path from 'path';
import { findPythonReceiverCalls } from './pythonLanguageUtils';
import type { PythonReceiverSection } from './pythonLanguageUtils';
import {
  parsePythonMethodBlocks,
  sameIdentity,
  type EntityMappingIndex,
  type IndexedMethodDefinition,
  type IndexedPythonMethodLocation
} from './entityMapping';

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

export function renderDefCallChainMermaid(chain: DefCallChain): string {
  const lines = ['flowchart TD'];
  for (const node of chain.nodes) {
    const shape = node.resolved ? `["${node.signature}"]` : `(["${node.signature}"])`;
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

function receiverCallsInMethod(
  boundMethod: IndexedPythonMethodLocation,
  readPythonFile: (filePath: string) => string | null
) {
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
  return findPythonReceiverCalls(lines.slice(bodyStart).join('\n'))
    .map(call => ({ ...call, line: call.line + bodyStart }));
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
  let frontier: Array<{ node: DefCallChainNode; definition: IndexedMethodDefinition }> = [{
    node: rootNode,
    definition: rootDefinition
  }];

  for (let currentDepth = 0; currentDepth < depth && frontier.length > 0; currentDepth += 1) {
    const nextFrontier: typeof frontier = [];
    for (const { node, definition } of frontier) {
      // visited 去重无触发输入——节点只在 `!nodes.has(targetNode.id)` 时才入
      // nextFrontier(下方 push 臂),nodes 单调增长故每节点最多入 frontier 一次,
      // visited 恒未含当前节点(自环/互调均被 nodes.has 闸住,不重入队)。
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
          if (target) nextFrontier.push({ node: targetNode, definition: target });
        }
        const edgeKey = `${node.id}->${targetNode.id}`;
        if (!edges.has(edgeKey)) {
          edges.set(edgeKey, { from: node.id, to: targetNode.id, receiver: call.receiver });
        }
      }
    }
    frontier = nextFrontier;
  }

  return {
    root: rootNode,
    nodes: [...nodes.values()],
    edges: [...edges.values()]
  };
}

interface PythonFileCacheEntry {
  mtimeMs: number;
  size: number;
  content: string | null;
}

const pythonFileCache = new Map<string, PythonFileCacheEntry>();

export function clearDefCallChainFileCache(): void {
  pythonFileCache.clear();
}

function readPythonFileWithMtimeCache(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath);
    const cacheKey = path.normalize(filePath);
    const cached = pythonFileCache.get(cacheKey);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.content;
    }

    const content = fs.readFileSync(filePath, 'utf8');
    pythonFileCache.set(cacheKey, { mtimeMs: stat.mtimeMs, size: stat.size, content });
    return content;
  } catch {
    pythonFileCache.delete(path.normalize(filePath));
    return null;
  }
}
