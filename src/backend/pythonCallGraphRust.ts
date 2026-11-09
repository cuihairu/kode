// C-20:Python 调用图/符号表的 Rust 权威实现接线面——`$/kode/python/callgraph`
// 与 `$/kode/python/symbols`。
//
// 边界(镜像 processTopologyRust/databaseSchemaRust「输入收集留 TS、分析归
// Rust」):文件集原文(路径+text)经 RPC 直传,Rust 解析 AST、提取调用边/符号表/
// 数据流并返回。Rust 不可用(无门/未配 serverPath/调用失败/形状不合规)返回
// null,调用方回退 TS 自建面(C-19 兜底)或零产出(面板静默)。无 TS 镜像——
// Rust 单一实现。
//
// 行号口径:Rust 0-based 原样透出;1-based 换算在消费点(C-19 entityMapping /
// 面板)做,与本文件无关。

import { getKodeCoreShadowGate } from '../kodeCoreShadowFaces';

/** Rust `$/kode/python/callgraph` 入参(镜像 CallgraphParams) */
export interface PythonCallGraphRustParams {
  /** 待分析文件集(路径 + 原文;可为空) */
  files: Array<{ path: string; text: string }>;
  /** `<root>/process_topology.xml` 原文(可选;进程角色归类用) */
  manifestXmlText?: string;
}

/** 调用图节点(方法/函数/模块伪节点) */
export interface PythonCallGraphNode {
  /** 方法 `Class.method` / 函数 `<stem>::func` / 模块 `<stem>` */
  id: string;
  /** "method" | "function" | "module" */
  kind: string;
  className?: string;
  name: string;
  filePath: string;
  /** 0-based */
  line: number;
  isAsync: boolean;
  params: string[];
}

/** 单条调用边 */
export interface PythonCallGraphEdge {
  callerId?: string;
  calleeId?: string;
  caller: string;
  callerClass?: string;
  /** 0-based */
  callerLine: number;
  callee: string;
  receiver?: string;
  /** EdgeKind 字面量(local/method/self-method/kbe-xxx/unknown) */
  kind: string;
  filePath: string;
}

/** 过程内 def-use 链(MVP) */
export interface PythonDefUseChain {
  var: string;
  defLine?: number;
  useLines: number[];
  isParam: boolean;
}

/** 单方法 def-use 结果 */
export interface PythonMethodDataflow {
  filePath: string;
  class?: string;
  method: string;
  chains: PythonDefUseChain[];
}

/** Rust 输出:调用图 + 统计 */
export interface PythonCallGraphRustResult {
  nodes: PythonCallGraphNode[];
  edges: PythonCallGraphEdge[];
  /** 被调方文件路径 → 调用方文件路径集 */
  reverseIndex: Record<string, string[]>;
  dataflow: PythonMethodDataflow[];
  processRoles: string[];
  stats: {
    fileCount: number;
    nodeCount: number;
    edgeCount: number;
    dataflowCount: number;
    errorCount: number;
    byKind: Record<string, number>;
  };
}

/** 每方法自身调用引用 */
export interface PythonSymbolCall {
  methodName: string;
  line: number;
  character: number;
}

/** 类方法符号 */
export interface PythonSymbolMethod {
  name: string;
  line: number;
  character: number;
  isAsync: boolean;
  decorators: string[];
  params: string[];
  endLine: number;
  calls: PythonSymbolCall[];
}

/** 类符号 */
export interface PythonSymbolClass {
  name: string;
  qualifiedName: string;
  bases: string[];
  startLine: number;
  endLine: number;
  decorators: string[];
  methods: PythonSymbolMethod[];
  attributes: Array<{ name: string; line: number; character: number }>;
}

/** 模块级函数符号 */
export interface PythonSymbolFunction {
  name: string;
  line: number;
  character: number;
  isAsync: boolean;
  decorators: string[];
  params: string[];
  endLine: number;
}

/** 单文件符号表(Rust `$/kode/python/symbols` 输出元素) */
export interface PythonSymbolsFile {
  filePath: string;
  lineCount: number;
  classes: PythonSymbolClass[];
  functions: PythonSymbolFunction[];
  imports: Array<{
    binding: string;
    module: string;
    symbol?: string;
    line: number;
    isFrom: boolean;
  }>;
  errors: string[];
}

export type PythonSymbolsRustResult = PythonSymbolsFile[];

/**
 * 调用图(经 Rust):文件集 → 节点/边/反索引/数据流;Rust 不可用/失败/形状
 * 不合规返回 null(面板降级:不可用徽标,不抛错)。
 */
/**
 * KR-AUD-89:Rust `file_stem` 只按 `/` 分割(python_callgraph.rs:161)——
 * Windows 面 `uri.fsPath` 是反斜杠,发送前在 RPC 边界统一归一;Rust 侧
 * analyze() 有 debug_assert 锁死该契约(上游归一化,非 Rust 容错)。
 */
export function normalizeCallGraphPath(path: string): string {
  return path.replace(/\\/g, '/');
}

export async function buildPythonCallGraphInRust(
  params: PythonCallGraphRustParams
): Promise<PythonCallGraphRustResult | null> {
  const gate = getKodeCoreShadowGate();
  if (!gate) {
    return null;
  }
  const response = await gate.runInRust<PythonCallGraphRustResult>(
    '$/kode/python/callgraph',
    {
      files: params.files.map(file => ({ ...file, path: normalizeCallGraphPath(file.path) })),
      manifestXmlText: params.manifestXmlText ?? ''
    }
  );
  if (!response.ok) {
    return null;
  }
  if (!shapeCheckPythonCallGraphResult(response.result)) {
    return null;
  }
  return response.result;
}

/**
 * 符号表(经 Rust):文件集 → 每文件 AST 符号表(含每方法自身调用);Rust 不可用/
 * 失败/形状不合规返回 null(C-19 回退 TS 自建)。
 */
export async function buildPythonSymbolsInRust(
  files: Array<{ path: string; text: string }>
): Promise<PythonSymbolsRustResult | null> {
  const gate = getKodeCoreShadowGate();
  if (!gate) {
    return null;
  }
  const response = await gate.runInRust<PythonSymbolsRustResult>(
    '$/kode/python/symbols',
    { files }
  );
  if (!response.ok) {
    return null;
  }
  if (!shapeCheckPythonSymbolsResult(response.result)) {
    return null;
  }
  return response.result;
}

function shapeCheckPythonCallGraphResult(value: unknown): value is PythonCallGraphRustResult {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const result = value as Record<string, unknown>;
  if (
    !Array.isArray(result.nodes) ||
    !Array.isArray(result.edges) ||
    typeof result.reverseIndex !== 'object' ||
    result.reverseIndex === null ||
    !Array.isArray(result.dataflow) ||
    !Array.isArray(result.processRoles) ||
    typeof result.stats !== 'object' ||
    result.stats === null
  ) {
    return false;
  }
  const nodesOk = result.nodes.every(node => {
    if (typeof node !== 'object' || node === null) {
      return false;
    }
    const item = node as Record<string, unknown>;
    return (
      typeof item.id === 'string' &&
      typeof item.kind === 'string' &&
      typeof item.name === 'string' &&
      typeof item.filePath === 'string' &&
      typeof item.line === 'number'
    );
  });
  const edgesOk = result.edges.every(edge => {
    if (typeof edge !== 'object' || edge === null) {
      return false;
    }
    const item = edge as Record<string, unknown>;
    return (
      typeof item.caller === 'string' &&
      typeof item.callerLine === 'number' &&
      typeof item.callee === 'string' &&
      typeof item.kind === 'string' &&
      typeof item.filePath === 'string'
    );
  });
  const stats = result.stats as Record<string, unknown>;
  const statsOk =
    typeof stats.fileCount === 'number' &&
    typeof stats.nodeCount === 'number' &&
    typeof stats.edgeCount === 'number' &&
    typeof stats.dataflowCount === 'number' &&
    typeof stats.errorCount === 'number' &&
    typeof stats.byKind === 'object' &&
    stats.byKind !== null;
  return nodesOk && edgesOk && statsOk;
}

function shapeCheckPythonSymbolsResult(value: unknown): value is PythonSymbolsRustResult {
  if (!Array.isArray(value)) {
    return false;
  }
  return value.every(file => {
    if (typeof file !== 'object' || file === null) {
      return false;
    }
    const item = file as Record<string, unknown>;
    return (
      typeof item.filePath === 'string' &&
      typeof item.lineCount === 'number' &&
      Array.isArray(item.classes) &&
      Array.isArray(item.functions) &&
      Array.isArray(item.imports) &&
      Array.isArray(item.errors)
    );
  });
}
