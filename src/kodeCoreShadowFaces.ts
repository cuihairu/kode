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
async function settleProviderResult(
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
