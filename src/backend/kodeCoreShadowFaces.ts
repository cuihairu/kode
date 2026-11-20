import type { KodeCoreGate } from './kodeCoreGate';

// kode2 Phase2 首片:definition + diagnostics 双轨面对拍接线(书 §17
// PH7-02 / docs/kode2/phase2-slice-a.md)。职责边界:
//   1. 持有 KodeCoreGate 引用(setupKodeCoreGate 装配时注入;默认 null =
//      全部入口零开销直通,与 PR-012 默认 ts 零可见变化同款);
//   2. 把 TS 面(vscode.Location / vscode.Diagnostic[])适配成与 kode-server
//      响应同形的 LSP 面,经 gate.compare() 影子对拍 —— 恒返回/不影响 TS
//      结果,Rust 结果只进差异日志(不切流铁律同 PR-012);
//   3. shadow 会话内把语料文档(.def + types/entities/alias.xml)的
//      open/change 镜像给 Rust,关闭时撤镜像(语料同步腿;失败静默,verdict
//      口径归 compare 自己的失败分类)。
// 结构化适配全部走形状类型,不 import vscode(单测用 fake-vscode 同形)。

let shadowGate: KodeCoreGate | null = null;

/** 装配点注入(传 null 即拆除;扩展停用时调用) */
export function setKodeCoreShadowGate(gate: KodeCoreGate | null): void {
  shadowGate = gate;
}

/** 测试/诊断读取当前门(不建进程) */
export function getKodeCoreShadowGate(): KodeCoreGate | null {
  return shadowGate;
}

// ---- 形状类型(vscode.Location / vscode.Diagnostic 的结构子集) ------------

interface PositionLike {
  line: number;
  character: number;
}

interface RangeLike {
  start: PositionLike;
  end: PositionLike;
}

interface LocationLike {
  uri: { fsPath: string };
  range: RangeLike;
}

interface DiagnosticLike {
  range: RangeLike;
  /** vscode.DiagnosticSeverity:Error=0/Warning=1/Information=2/Hint=3 */
  severity: number;
  message: string;
}

interface DocumentLike {
  uri: { fsPath: string };
  languageId: string;
  version: number;
  getText(): string;
}

// ---- LSP 面(与 kode-server 响应同形;对拍面见 phase2-slice-a.md) --------

export interface LspLocationFace {
  uri: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

export interface LspDiagnosticReportFace {
  kind: 'full';
  items: { range: RangeLike; severity: number; message: string }[];
}

/** LSP 位置面(kode-server LspPosition 同形;行 0 基、列 UTF-16 code unit) */
export interface LspPositionFace {
  line: number;
  character: number;
}

/** LSP 区间面(kode-server LspRange 同形) */
export interface LspRangeFace {
  start: LspPositionFace;
  end: LspPositionFace;
}

/**
 * 文档符号面(kode-server document_symbols::DocumentSymbolFace 同形)。
 * kind 是符号种类字符串面(与 TS vscode.SymbolKind 枚举名同形;协议数值
 * 映射归 provider 投影细节)。
 */
export interface LspDocumentSymbolFace {
  name: string;
  detail: string;
  kind: 'Struct' | 'Class' | 'Field' | 'Method';
  range: LspRangeFace;
  selectionRange: LspRangeFace;
  children: LspDocumentSymbolFace[];
}

/** kode-server textDocument/completion 应答面(to_lsp_items 投影) */
export interface LspCompletionReportFace {
  isIncomplete: boolean;
  items: {
    label: string;
    /** LSP CompletionItemKind 数值(method=2/type/entity/alias=7/property=10) */
    kind: number;
    detail?: string;
    /** RUST-135:条目序锁(响应序 = 声明序/链序,零填充序列) */
    sortText?: string;
    /** RUST-135:键入过滤面(= label) */
    filterText?: string;
    /** RUST-135:snippet 插入文本(py 方法/函数面 `name($0)`) */
    insertText?: string;
    /** RUST-135:插入格式(2 = snippet) */
    insertTextFormat?: number;
    /** RUST-135:completionItem/resolve 往返载荷(来源面判别) */
    data?: Record<string, unknown>;
  }[];
}

/** completionItem/resolve 应答面:文档面(markdown)与可选 detail 更新 */
export interface LspCompletionResolveFace {
  documentation?: { kind: string; value: string };
  detail?: string;
}

/**
 * resolve 延迟补详情 rust 服务(RUST-135):服务轨道下请求 kode-server
 * completionItem/resolve(params = completion 出条目的 {label,detail,data}
 * 子集)。Rust 复算出文档面返回之;载荷不可判/语料缺位/任何失败返回
 * null —— 调用方保持条目既有面(不装空文档)。零镜像(resolve 无文档
 * 上下文,语料在 completion 时已由镜像腿入库)。
 */
export async function serveCompletionResolveFromRust(
  item: { label: string; detail?: string; data?: Record<string, unknown> }
): Promise<LspCompletionResolveFace | null> {
  const gate = shadowGate;
  if (!gate || !gate.serveFromRust() || !item.data) {
    return null;
  }
  const result = await awaitWithInteractiveBudget(
    async opts =>
      gate.serveInRust<unknown>('completionItem/resolve', item, null, opts),
    INTERACTIVE_SERVE_BUDGET_MS
  );
  if (!result || typeof result !== 'object') {
    return null;
  }
  const face = result as { documentation?: { kind?: unknown; value?: unknown } };
  if (
    face.documentation &&
    typeof face.documentation === 'object' &&
    typeof face.documentation.value === 'string'
  ) {
    return face as LspCompletionResolveFace;
  }
  return null;
}

/** vscode.Location(单/数组)→ LSP Location 面;null/落空 → null */
export function locationToLspFace(location: unknown): LspLocationFace | null {
  const first = Array.isArray(location) ? location[0] : location;
  if (!first || typeof first !== 'object') {
    return null;
  }
  const candidate = first as Partial<LocationLike>;
  if (!candidate.uri || typeof candidate.uri.fsPath !== 'string' || !candidate.range) {
    return null;
  }
  const { start, end } = candidate.range;
  if (
    typeof start?.line !== 'number' ||
    typeof start?.character !== 'number' ||
    typeof end?.line !== 'number' ||
    typeof end?.character !== 'number'
  ) {
    return null;
  }
  return {
    uri: candidate.uri.fsPath,
    range: {
      start: { line: start.line, character: start.character },
      end: { line: end.line, character: end.character },
    },
  };
}

/** vscode.DiagnosticSeverity → LSP 严重级(+1;Error 0→1 …) */
const toLspSeverity = (severity: number): number => {
  if (typeof severity !== 'number' || severity < 0 || severity > 3) {
    return 1;
  }
  return severity + 1;
};

/** vscode.Diagnostic[] → LSP pull 报告面(kode-server 同形 {kind, items}) */
export function diagnosticsToLspFace(diagnostics: readonly DiagnosticLike[]): LspDiagnosticReportFace {
  return {
    kind: 'full',
    items: (diagnostics ?? []).map(diagnostic => ({
      range: diagnostic.range,
      severity: toLspSeverity(diagnostic.severity),
      message: diagnostic.message
    }))
  };
}

// ---- 入口(provider/validate 面调用;非 shadow 或未装配时零开销) ----------

/**
 * 交互 serving 面端到端预算(KBUG-TIME-02):语料四面(definition/completion/
 * hover/diagnostic)从发起(含 mirror 的 client.start/排队/响应)到回落的
 * 总时长。后台命令面不经此预算。transport 层硬超时(+2000ms)在预算外
 * 显式计入清理窗口,pending/计时器照常回收(KBUG-TIME-05)。
 */
export const INTERACTIVE_SERVE_BUDGET_MS = 2000;

/** 取消探测周期(ms) */
const CANCEL_POLL_MS = 50;

/**
 * 交互等待壳:预算计时 + 取消探测,任一先到即放弃 Rust 等待(返回 null,
 * 调用方走 TS 降级)。败方 promise 挂 catch 吞迟到结算——不产生未处理
 * rejection,迟到响应不改变已定结果(KBUG-TIME-03/04)。work 收到与预算
 * 同值的 timeoutMs,transport 层同步发 $/cancelRequest + 硬超时清理。
 */
export async function awaitWithInteractiveBudget<T>(
  work: (opts: { timeoutMs: number }) => Promise<T>,
  budgetMs: number,
  isCancelled?: () => boolean
): Promise<T | null> {
  if (isCancelled?.()) {
    return null;
  }
  let budgetTimer: NodeJS.Timeout | undefined;
  let pollTimer: NodeJS.Timeout | undefined;
  const rustPromise = work({ timeoutMs: budgetMs });
  rustPromise.catch(() => undefined);
  const budget = new Promise<null>(resolve => {
    budgetTimer = setTimeout(() => resolve(null), budgetMs);
  });
  const cancelled = new Promise<null>(resolve => {
    pollTimer = setInterval(() => {
      if (isCancelled?.()) {
        resolve(null);
      }
    }, CANCEL_POLL_MS);
  });
  try {
    return await Promise.race([rustPromise, budget, cancelled]);
  } catch {
    return null;
  } finally {
    clearTimeout(budgetTimer);
    clearInterval(pollTimer);
  }
}

const isDefDocument = (document: DocumentLike): boolean =>
  document.languageId === 'kbengine-def' ||
  document.uri.fsPath.toLowerCase().endsWith('.def');

/** 语料 XML 后缀(与 kode-server file_kind_of_uri 口径同源,决定 Rust 解析视图) */
const CORPUS_XML_SUFFIXES = ['entities.xml', 'types.xml', 'alias.xml'];

/**
 * 语料文档(.def + 三类 XML):Rust 侧类型环境(custom types / 注册项)只由
 * 这些文档的 didOpen/didChange 入库,缺一类就会出现「已注册却报未注册」
 * 的假诊断。
 */
const isCorpusDocument = (document: DocumentLike): boolean =>
  isDefDocument(document) ||
  CORPUS_XML_SUFFIXES.some(suffix => document.uri.fsPath.endsWith(suffix));

/**
 * 补全面 Rust 文档门(RUST-134):语料文档之外,.py 也在补全面候选
 * (self. 实体成员面 + KBEngine./kbe. 模块别名面均由 Rust 共享查询接管)。
 * 仅补全 serve 路径使用;definition/hover 等其余面维持 isCorpusDocument
 * 口径(Python 悬停/定义落点不在 Rust 面)。
 */
const isCompletionRustDocument = (document: DocumentLike): boolean =>
  isCorpusDocument(document) || document.uri.fsPath.toLowerCase().endsWith('.py');

/** ProviderResult 是否 thenable(映射管理器方法跳转返回 Promise 的路径) */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return value !== null && typeof value === 'object' && typeof (value as { then?: unknown }).then === 'function';
}

/**
 * ProviderResult 结算(E-3):同步 Location/Location[] 原样返回;thenable 解析
 * 完成才产出对拍面(未解析时直接适配会得到 null,把异步落点误记成分歧)。
 * 拒绝路径返回 unsettled —— 无 TS 真相可对拍,不产出对拍也不产生未处理拒绝
 * (provider 的返回语义由调用方原样透传,这里只读不接管)。
 */
export async function settleProviderResult(
  result: unknown
): Promise<{ settled: true; value: unknown } | { settled: false }> {
  if (!isThenable(result)) {
    return { settled: true, value: result };
  }
  try {
    return { settled: true, value: await result };
  } catch {
    return { settled: false };
  }
}

/**
 * 定义面 rust 服务(2026-11-08 用户令「直接切到 rust」):服务轨道下先镜像
 * 语料文档(Rust 侧要有本文件 buffer 才可能应答),再请求 kode-server
 * textDocument/definition。Rust 有落点返回 LSP face(uri 为规范路径,与
 * shadow locationToLspFace 同形);无落点(词未知/语料环境缺/Python/schema
 * 不在本面=Rust 恒 null)或任何失败返回 null —— 调用方回 TS。非服务轨道/
 * 未装配门零开销返回 null。Rust 落点优先于 TS 落点(直接切语义)。
 */
export async function serveDefinitionFromRust(
  document: DocumentLike,
  position: PositionLike
): Promise<LspLocationFace | null> {
  const gate = shadowGate;
  if (!gate || !gate.serveFromRust()) {
    return null;
  }
  // Rust 面 = 语料声明落点(definition.rs:113 file_kind_of_uri Other → None);
  // schema/python 不在本面,零请求直通 TS。
  if (!isCorpusDocument(document)) {
    return null;
  }
  const uri = document.uri.fsPath;
  const params = {
    textDocument: { uri },
    position: { line: position.line, character: position.character }
  };
  const result = await awaitWithInteractiveBudget(
    async opts => {
      await gate
        .mirrorDocument(uri, document.languageId, document.version, document.getText())
        .catch(() => undefined);
      return gate.serveInRust<unknown>('textDocument/definition', params, null, opts);
    },
    INTERACTIVE_SERVE_BUDGET_MS
  );
  if (!result || typeof result !== 'object') {
    return null;
  }
  const face = result as Partial<LspLocationFace>;
  if (typeof face.uri !== 'string' || !face.range) {
    return null;
  }
  return face as LspLocationFace;
}

/**
 * 补全面 rust 服务(2026-11-08 用户令「直接切到 rust」):服务轨道下先镜像
 * 文档(Rust 侧要有本文件 buffer 才可能应答),再请求 kode-server
 * textDocument/completion。Rust 判定出上下文且条目集非空时返回条目集;
 * 未判定上下文(接口段/属性子标签/def 顶层/无归属的 py)、任何失败、或
 * 「空条目集+isIncomplete:false」(语料缺位与真无候选不可区分,RUST-021
 * 关闭面修订)返回 null —— 调用方回 TS。Rust 条目集优先于 TS(直接切语义),
 * 但空集不装权威结果。
 */
export async function serveCompletionFromRust(
  document: DocumentLike,
  position: PositionLike
): Promise<LspCompletionReportFace | null> {
  const gate = shadowGate;
  if (!gate || !gate.serveFromRust()) {
    return null;
  }
  // Rust 面 = 语料文档 + py(补全专用门:RUST-134 self./模块别名面;
  // 其余文档零请求直通 TS)。
  if (!isCompletionRustDocument(document)) {
    return null;
  }
  const uri = document.uri.fsPath;
  const params = {
    textDocument: { uri },
    position: { line: position.line, character: position.character }
  };
  const result = await awaitWithInteractiveBudget(
    async opts => {
      await gate
        .mirrorDocument(uri, document.languageId, document.version, document.getText())
        .catch(() => undefined);
      return gate.serveInRust<unknown>('textDocument/completion', params, null, opts);
    },
    INTERACTIVE_SERVE_BUDGET_MS
  );
  if (!result || typeof result !== 'object') {
    return null;
  }
  const face = result as Partial<LspCompletionReportFace>;
  if (typeof face.isIncomplete !== 'boolean' || !Array.isArray(face.items)) {
    return null;
  }
  // 空条目集不权威(RUST-021 关闭面修订):语料缺位也会产「判定上下文+
  // 零条目」,与「真无候选」不可区分 —— 非空响应壳里的空集一律回 TS,
  // 不把「语料缺位」装成「无候选」。
  if (face.items.length === 0 && face.isIncomplete === false) {
    return null;
  }
  return face as LspCompletionReportFace;
}

/**
 * 悬停面 rust 服务(2026-11-08 用户令「直接切到 rust」):服务轨道下先镜像
 * 语料文档(未保存修订以编辑器内容为准),再请求 kode-server
 * textDocument/hover。Rust 命中返回 markdown 文本;未命中(词未知/文档不在
 * 语料面=Python/schema 恒 null)或任何失败返回 null —— 调用方回 TS 既有链。
 * 非服务轨道/未装配门零开销。Rust 内容优先于 TS(直接切语义)。
 */
export async function serveHoverFromRust(
  document: DocumentLike,
  position: PositionLike
): Promise<string | null> {
  const gate = shadowGate;
  if (!gate || !gate.serveFromRust()) {
    return null;
  }
  // Rust 面 = 语料文档(def + 三类 XML);非语料零请求直通 TS。
  if (!isCorpusDocument(document)) {
    return null;
  }
  const uri = document.uri.fsPath;
  const params = {
    textDocument: { uri },
    position: { line: position.line, character: position.character }
  };
  const result = await awaitWithInteractiveBudget(
    async opts => {
      await gate
        .mirrorDocument(uri, document.languageId, document.version, document.getText())
        .catch(() => undefined);
      return gate.serveInRust<unknown>('textDocument/hover', params, null, opts);
    },
    INTERACTIVE_SERVE_BUDGET_MS
  );
  if (!result || typeof result !== 'object') {
    return null;
  }
  const contents = (result as { contents?: { value?: unknown } }).contents;
  if (!contents || typeof contents.value !== 'string') {
    return null;
  }
  return contents.value;
}

/**
 * 诊断面 rust 服务(2026-11-08 用户令「直接切到 rust」,诊断面最后一片):
 * 服务轨道下先镜像 .def 文档(未保存修订以编辑器内容为准),再请求
 * kode-server textDocument/diagnostic(LSP pull 全量面 {kind:'full',items})。
 * Rust 面只覆盖语料可复刻的 validateDocument 子集(标量三码 + 结构重复/
 * 缺字段;missingPythonFile 盘上探测分支不在面);entities/types/alias 专项
 * 诊断也不在本片 —— 非 .def 直通 null,TS 现产面保留。畸形应答整面作废
 * (任一条目缺区间/级别/文案)返回 null,不做部分采用 —— 调用方保留 TS 集。
 * 非服务轨道/未装配门零开销。
 */
export async function serveDiagnosticsFromRust(
  document: DocumentLike
): Promise<LspDiagnosticReportFace | null> {
  const gate = shadowGate;
  if (!gate || !gate.serveFromRust()) {
    return null;
  }
  if (!isDefDocument(document)) {
    return null;
  }
  const uri = document.uri.fsPath;
  const result = await awaitWithInteractiveBudget(
    async opts => {
      await gate
        .mirrorDocument(uri, document.languageId, document.version, document.getText())
        .catch(() => undefined);
      return gate.serveInRust<unknown>('textDocument/diagnostic', { textDocument: { uri } }, null, opts);
    },
    INTERACTIVE_SERVE_BUDGET_MS
  );
  if (!result || typeof result !== 'object') {
    return null;
  }
  const face = result as Partial<LspDiagnosticReportFace>;
  if (face.kind !== 'full' || !Array.isArray(face.items)) {
    return null;
  }
  for (const item of face.items) {
    if (
      !item ||
      typeof item.message !== 'string' ||
      typeof item.severity !== 'number' ||
      !item.range ||
      typeof item.range.start?.line !== 'number' ||
      typeof item.range.start?.character !== 'number' ||
      typeof item.range.end?.line !== 'number' ||
      typeof item.range.end?.character !== 'number'
    ) {
      return null;
    }
  }
  return face as LspDiagnosticReportFace;
}

const isLspPositionFace = (value: unknown): value is LspPositionFace => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const face = value as Record<string, unknown>;
  return typeof face.line === 'number' && typeof face.character === 'number';
};

const isLspRangeFace = (value: unknown): value is LspRangeFace =>
  !!value &&
  typeof value === 'object' &&
  isLspPositionFace((value as Record<string, unknown>).start) &&
  isLspPositionFace((value as Record<string, unknown>).end);

/** 递归校验符号面:任意一层畸形 → 整面作废(不做部分采用) */
const isLspDocumentSymbolFace = (value: unknown): value is LspDocumentSymbolFace => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const face = value as Record<string, unknown>;
  if (typeof face.name !== 'string' || typeof face.detail !== 'string') {
    return false;
  }
  if (
    face.kind !== 'Struct' &&
    face.kind !== 'Class' &&
    face.kind !== 'Field' &&
    face.kind !== 'Method'
  ) {
    return false;
  }
  if (!isLspRangeFace(face.range) || !isLspRangeFace(face.selectionRange)) {
    return false;
  }
  return Array.isArray(face.children) && face.children.every(isLspDocumentSymbolFace);
};

/**
 * 文档符号面 rust 服务(RUST-139 批 3 接线;2026-11-08 用户令「直接切到
 * rust」):服务轨道下先镜像 .def 文档(未保存修订以编辑器内容为准),再请求
 * kode-server textDocument/documentSymbol。Rust 段符号面 = Properties/三方法
 * 段的容器符号+直接成员符号(核 document_symbols.rs,与 TS IDE-NAV-005 逐点
 * 同构);解析无根/文档未打开/任何失败/应答畸形 → null,调用方回 TS 既有
 * 实现(不部分采用)。
 * 诚实边界:Rust 面不含进程段面包屑合成根(跨文件对端跳是 TS 投影层职责),
 * provider 侧保留面包屑装配。
 */
export async function serveDocumentSymbolsFromRust(
  document: DocumentLike,
  isCancelled?: () => boolean
): Promise<LspDocumentSymbolFace[] | null> {
  const gate = shadowGate;
  if (!gate || !gate.serveFromRust() || !isDefDocument(document)) {
    return null;
  }
  const uri = document.uri.fsPath;
  const result = await awaitWithInteractiveBudget(
    async opts => {
      await gate
        .mirrorDocument(uri, document.languageId, document.version, document.getText())
        .catch(() => undefined);
      return gate.serveInRust<unknown>(
        'textDocument/documentSymbol',
        { textDocument: { uri } },
        null,
        opts
      );
    },
    INTERACTIVE_SERVE_BUDGET_MS,
    isCancelled
  );
  if (!Array.isArray(result) || !result.every(isLspDocumentSymbolFace)) {
    return null;
  }
  return result;
}

const isLspLocationFace = (value: unknown): value is LspLocationFace => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const face = value as Record<string, unknown>;
  return typeof face.uri === 'string' && isLspRangeFace(face.range);
};

/**
 * 引用位面 rust 服务(RUST-138 批 3 接线):服务轨道下先镜像语料文档,再请求
 * kode-server textDocument/references。Rust 面 = 语料面引用:def 文档出
 * 自定义类型/实体 Parent/接口名三类目标的声明位(includeDeclaration 时前置)
 * + 全语料站点位;types.xml 文档出该类型名全语料引用位(无声明位)。Python
 * 文档(属性 self 访问/调用点面归 entityMapping 运行时)、entities/alias、
 * 未知符号、空结果、任何失败、应答畸形(任一条目缺 uri/区间)→ null,调用方
 * 回 TS 既有实现(不部分采用)。非服务轨道/未装配门零开销。
 */
export async function serveReferencesFromRust(
  document: DocumentLike,
  position: PositionLike,
  includeDeclaration: boolean,
  isCancelled?: () => boolean
): Promise<LspLocationFace[] | null> {
  const gate = shadowGate;
  if (!gate || !gate.serveFromRust() || !isCorpusDocument(document)) {
    return null;
  }
  const uri = document.uri.fsPath;
  const params = {
    textDocument: { uri },
    position: { line: position.line, character: position.character },
    context: { includeDeclaration }
  };
  const result = await awaitWithInteractiveBudget(
    async opts => {
      await gate
        .mirrorDocument(uri, document.languageId, document.version, document.getText())
        .catch(() => undefined);
      return gate.serveInRust<unknown>('textDocument/references', params, null, opts);
    },
    INTERACTIVE_SERVE_BUDGET_MS,
    isCancelled
  );
  if (!Array.isArray(result) || !result.every(isLspLocationFace)) {
    return null;
  }
  return result;
}

/**
 * .def 定义跳转影子对拍:结算 ProviderResult(可能是 thenable)后适配成
 * TS Location 面再镜像给 gate。fire-and-forget,不改 provider 返回值
 * (铁律:Rust 结果只进差异日志)。
 */
export function shadowCompareDefinition(
  document: DocumentLike,
  position: PositionLike,
  tsLocation: unknown
): void {
  const gate = shadowGate;
  if (!gate) {
    return;
  }
  const uri = document.uri.fsPath;
  const params = {
    textDocument: { uri },
    position: { line: position.line, character: position.character }
  };
  void settleProviderResult(tsLocation)
    .then(settled => {
      if (!settled.settled) {
        return undefined;
      }
      return gate.compare('textDocument/definition', params, locationToLspFace(settled.value), uri);
    })
    .catch(() => undefined);
}

/**
 * 语料镜像腿(E-1):.def/types.xml/entities.xml/alias.xml 的 open/change 同步
 * 给 Rust server。由文档快照更新驱动(开档/改动即镜像),不经
 * validateDocument —— 诊断开关关闭时语料同步不受影响,definition 与
 * 注册类型诊断才有同输入。best-effort:非 shadow/未配 serverPath 零开销。
 */
export function shadowMirrorCorpusDocument(document: DocumentLike): void {
  const gate = shadowGate;
  if (!gate || !isCorpusDocument(document)) {
    return;
  }
  const uri = document.uri.fsPath;
  void gate
    .mirrorDocument(uri, document.languageId, document.version, document.getText())
    .catch(() => undefined);
}

/**
 * 关文档清理腿(E-4):与镜像腿对称 —— 文档关闭/丢弃未保存修订后撤 Rust 侧
 * overlay 与版本账,连续开合不积累已关闭的文档。非 shadow/未装配门零开销。
 */
export function shadowReleaseCorpusDocument(document: DocumentLike): void {
  const gate = shadowGate;
  if (!gate || !isCorpusDocument(document)) {
    return;
  }
  gate.closeMirroredDocument(document.uri.fsPath);
}

/**
 * .def 诊断影子对拍:validateDocument 算完诊断后调用。先镜像文档
 * (诊断面刷新腿,与 shadowMirrorCorpusDocument 同账本;同版本重入不重发),
 * 再把 TS 诊断面镜像给 gate.compare('textDocument/diagnostic')。
 * fire-and-forget。
 */
export function shadowObserveDefDocument(
  document: DocumentLike,
  diagnostics: readonly DiagnosticLike[]
): void {
  const gate = shadowGate;
  if (!gate) {
    return;
  }
  if (!isDefDocument(document)) {
    return;
  }
  const uri = document.uri.fsPath;
  void gate
    .mirrorDocument(uri, document.languageId, document.version, document.getText())
    .catch(() => undefined);
  const params = { textDocument: { uri } };
  void gate
    .compare('textDocument/diagnostic', params, diagnosticsToLspFace(diagnostics), uri)
    .catch(() => undefined);
}
