import * as fs from 'fs';
import * as path from 'path';
import { findPythonReceiverCalls, PYTHON_RECEIVER_BY_SECTION } from './backend/pythonLanguageUtils';
import type { PythonReceiverCall, PythonReceiverSection } from './backend/pythonLanguageUtils';
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

/** Exposed 方法入边的合成 client 源节点 id(唯一,纯来源,不进 BFS 前沿) */
const CLIENT_SOURCE_NODE_ID = 'client';

export function renderDefCallChainMermaid(chain: DefCallChain): string {
  const lines = ['flowchart TD'];
  for (const node of chain.nodes) {
    // client 源用 stadium 形状,与普通解析框(方角)/未解析框(也 stadium 但带
    // "(?)" 签名)视觉可辨。
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

/** Exposed 方法入边的合成 client 源节点:纯来源,不携带 def 方法语义 */
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

/** 普通 self.<name>( 调用:只认直接调用形,接收者关键字(cell/base/client)排除 */
const PLAIN_SELF_CALL_PATTERN = /\bself\.([A-Za-z_][A-Za-z0-9_]*)\(/g;
const RECEIVER_KEYWORDS = new Set<DefCallChainEdge['receiver']>(['cell', 'base', 'client']);

/**
 * 扫描普通 self.<name>( 调用(cell/base/client 排除)。这些调用归属封闭方法自身
 * 的 def 段:cell 脚本里 self.moveToPoint() → CellMethods,base 脚本 → BaseMethods,
 * client 脚本 → ClientMethods。接收者按 ownSection 反查表定。
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
  // KR-AUD-70:endLine 截尾——methodBlock.endLine 是缩进边界,缺它则把同文件
  // 后续兄弟方法体整个并进当前方法调用面(sibling 调用误归属)。
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
  // 记录每个已入链的解析方法节点 → def,供 Exposed 入边收尾(只对真 def 方法)。
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

  // Part A:Exposed 方法收 client 入边。client 源唯一(仅一个节点),每个 exposed
  // 方法一条入边;client 源纯来源,不进 BFS(不 push 到任何 frontier)。
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
