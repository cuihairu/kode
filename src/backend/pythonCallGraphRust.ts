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

import { getKodeCoreShadowGate } from './kodeCoreShadowFaces';

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
  /** RUST-077-W:分页元信息(仅被切片的维度携带;全量小结果缺席) */
  edgePage?: PythonCallGraphPageMeta;
  nodePage?: PythonCallGraphPageMeta;
  dataflowPage?: PythonCallGraphPageMeta;
  reversePage?: PythonCallGraphPageMeta;
}

/** RUST-077-W:单页元信息(CORE-012;nextOffset 缺席 = 到底) */
export interface PythonCallGraphPageMeta {
  offset: number;
  nextOffset?: number | null;
  oversizedAt?: number | null;
  cancelled?: boolean;
  bytesEstimate?: number;
  total?: number;
}

/**
 * RUST-077-W:分页续取上限(防御性;正常页数 = 总量/页额,远低于此)。
 */
const MAX_CALLGRAPH_PAGE_REQUESTS = 10_000;

/** 单维续取状态:开启维带 nextOffset 游标,终局维带 total(空尾页)。 */
interface CallGraphDimState<T> {
  acc: T[];
  /** 下一请求携带的游标:开启态 = nextOffset;终局 = total。 */
  cursor: number;
  done: boolean;
  /** 全量条目数(服务端 `*Page.total`;缺席时按已收编数计)。 */
  total: number;
}

function arrayDim<T>(): CallGraphDimState<T> {
  return { acc: [], cursor: 0, done: false, total: 0 };
}

function pageNext(meta: PythonCallGraphPageMeta | undefined): number | null {
  const raw = meta?.nextOffset;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

/**
 * 数组维步进。开启维:追加切片并推进游标;无 `*Page` 元信息 = 全量维整段
 * 收编即终局。终局维:只做幂等校验(空尾页),绝不重复入账。返回 false =
 * 协作取消半页/游标不前进(超大条目卡死)/终局维被服务端复活——外层放弃
 * 返回 null(C-19 降级 TS 兜底),绝不把半页冒充全量。
 */
function stepArrayDim<T>(
  dim: CallGraphDimState<T>,
  pageValue: T[] | undefined,
  meta: PythonCallGraphPageMeta | undefined,
  sent: number
): boolean {
  if (dim.done) {
    if (meta && (meta.cancelled === true || pageNext(meta) !== null)) {
      return false;
    }
    return true;
  }
  if (!meta) {
    dim.acc.length = 0;
    if (pageValue) {
      dim.acc.push(...pageValue);
    }
    dim.total = dim.acc.length;
    dim.cursor = dim.total;
    dim.done = true;
    return true;
  }
  if (pageValue) {
    dim.acc.push(...pageValue);
  }
  if (meta.cancelled === true) {
    return false;
  }
  const next = pageNext(meta);
  if (next === null) {
    dim.total = typeof meta.total === 'number' ? meta.total : dim.acc.length;
    dim.cursor = dim.total;
    dim.done = true;
    return true;
  }
  if (next <= sent) {
    return false;
  }
  dim.total = typeof meta.total === 'number' ? meta.total : dim.acc.length;
  dim.cursor = next;
  return true;
}

/** 反索引维状态(对象维;条目 = {callee: callers},键序由服务端 BTreeMap 定)。 */
interface CallGraphReverseState {
  index: Record<string, string[]>;
  cursor: number;
  done: boolean;
  total: number;
}

/**
 * 反索引维步进:语义与 stepArrayDim 一致,切片按键合并(跨页调用方去重)。
 */
function stepReverseDim(
  dim: CallGraphReverseState,
  pageValue: Record<string, string[]>,
  meta: PythonCallGraphPageMeta | undefined,
  sent: number
): boolean {
  if (dim.done) {
    if (meta && (meta.cancelled === true || pageNext(meta) !== null)) {
      return false;
    }
    return true;
  }
  if (!meta) {
    dim.index = pageValue;
    dim.total = Object.keys(pageValue).length;
    dim.cursor = dim.total;
    dim.done = true;
    return true;
  }
  for (const [callee, callers] of Object.entries(pageValue)) {
    const seen = dim.index[callee];
    if (seen) {
      for (const caller of callers) {
        if (!seen.includes(caller)) {
          seen.push(caller);
        }
      }
    } else {
      dim.index[callee] = [...callers];
    }
  }
  if (meta.cancelled === true) {
    return false;
  }
  const next = pageNext(meta);
  if (next === null) {
    dim.total = typeof meta.total === 'number' ? meta.total : Object.keys(dim.index).length;
    dim.cursor = dim.total;
    dim.done = true;
    return true;
  }
  if (next <= sent) {
    return false;
  }
  dim.total = typeof meta.total === 'number' ? meta.total : Object.keys(dim.index).length;
  dim.cursor = next;
  return true;
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
  const files = params.files.map(file => ({ ...file, path: normalizeCallGraphPath(file.path) }));
  const manifestXmlText = params.manifestXmlText ?? '';
  // RUST-077-W:四维分页续取。服务端无状态,每次响应都是全量分析的分页视图
  // ——首页不带游标;续取请求恒携带四游标:开启维带 `*Page.nextOffset`,
  // 终局维带 total(空尾页保持终局,防止服务端把已收完的维当新分页重新打
  // 开)。纯函数确定性:同输入同游标必得同页,续取恰好拼回全量。
  // processRoles/stats 与输入一一对应,取首页原样。任一维取消半页/游标不
  // 前进(超大条目卡死)/终局维被复活/请求数超限 → null(C-19 降级 TS 兜
  // 底),绝不把半页冒充全量。
  const nodes = arrayDim<PythonCallGraphNode>();
  const edges = arrayDim<PythonCallGraphEdge>();
  const dataflow = arrayDim<PythonMethodDataflow>();
  const reverse: CallGraphReverseState = { index: {}, cursor: 0, done: false, total: 0 };
  let base: PythonCallGraphRustResult | null = null;
  for (let request = 0; request < MAX_CALLGRAPH_PAGE_REQUESTS; request++) {
    const cursors: Record<string, number> | undefined =
      request === 0
        ? undefined
        : {
            edgeOffset: edges.cursor,
            nodeOffset: nodes.cursor,
            dataflowOffset: dataflow.cursor,
            reverseOffset: reverse.cursor
          };
    const response = await gate.runInRust<PythonCallGraphRustResult>(
      '$/kode/python/callgraph',
      {
        files,
        manifestXmlText,
        ...cursors
      }
    );
    if (!response.ok) {
      return null;
    }
    if (!shapeCheckPythonCallGraphResult(response.result)) {
      return null;
    }
    const page = response.result;
    if (!base) {
      base = page;
    }
    const stepsOk = [
      stepArrayDim(edges, page.edges, page.edgePage, cursors?.edgeOffset ?? 0),
      stepArrayDim(nodes, page.nodes, page.nodePage, cursors?.nodeOffset ?? 0),
      stepArrayDim(dataflow, page.dataflow, page.dataflowPage, cursors?.dataflowOffset ?? 0),
      stepReverseDim(reverse, page.reverseIndex, page.reversePage, cursors?.reverseOffset ?? 0)
    ];
    if (stepsOk.some(step => !step)) {
      return null;
    }
    if (edges.done && nodes.done && dataflow.done && reverse.done) {
      return {
        nodes: nodes.acc,
        edges: edges.acc,
        reverseIndex: reverse.index,
        dataflow: dataflow.acc,
        processRoles: base.processRoles,
        stats: base.stats
      };
    }
  }
  return null;
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
