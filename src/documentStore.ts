// 统一文档快照与解析缓存(PR2,评审 docs/review/2026-10-22 §3.1):
// 以 VS Code 内存缓冲区为唯一文本事实源 —— 快照文本只来自 document.getText(),
// 全模块不碰 fs,磁盘旧内容没有任何路径能覆盖编辑中的缓冲区。
//
// 职责:
// - URI 规范化:同一文件的不同拼写(file:///a/b.def、file://c%3A/... 大小写/分隔
//   符差异)归并到同一个快照键;
// - 版本号 + 文本 + 行索引:同版本内复用按 \r?\n 拆好的行数组,消灭逐次
//   getText().split 全文拆行(hover/inlay/签名闸门等高频路径);
// - 解析态 + 最近成功解析版本:同版本只解析一次;解析进行中的重复请求合并到
//   同一 in-flight Promise;解析期间来了新编辑,旧版本解析结果绝不覆盖新版本。
//
// 版本不可知的文档(如测试里无 version 的替身)按「每次都可能变」处理:行索引
// 每次重建、解析不缓存 —— 行为与未接入快照前完全一致,不引入任何 staleness。
//
// 打点:document-parse 事件走 PR1 埋点(命中/未命中/耗时/版本),不记用户文本。

import { recordLanguageServiceOperation } from './languageServiceMetrics';
import { releaseParsedDocuments } from './defParser';
import { normalizeFileIdentity } from './pathIdentity';

/** 快照输入面:vscode.TextDocument 与测试替身的公共子集(不 import vscode) */
export interface DocumentStoreDocument {
  uri: { toString(): string; fsPath: string };
  /** 编辑序号;替身可能没有 → undefined(按不可缓存处理) */
  version?: number;
  getText(): string;
}

export type DocumentParseState = 'idle' | 'parsing' | 'parsed';

export interface DocumentSnapshot {
  /** 规范化快照键(非原始 URI 拼写) */
  key: string;
  fsPath: string;
  /** 建快照时的文档版本(替身为 undefined) */
  version: number | undefined;
  /** 内存缓冲区全文(非磁盘内容) */
  text: string;
  /** 行起始偏移表(含第 0 行),lines[i] 与 getText().split(/\r?\n/)[i] 一致 */
  lineStarts: number[];
  parseState: DocumentParseState;
  /** 最近一次成功解析对应的版本;无成功解析为 undefined */
  lastGoodParseVersion: number | undefined;
}

interface StoreEntry {
  snapshot: DocumentSnapshot;
  lines: readonly string[] | null;
  /** in-flight 解析(键:namespace + 版本;undefined 版本不进 map) */
  pending: Map<string, Promise<unknown>>;
  /** 同步解析缓存(键:namespace + 版本;undefined 版本不缓存) */
  syncParse: Map<string, unknown>;
}

/** URI → 快照键:file scheme 下按 fsPath 归一(分隔符/盘符大小写),其余原样 */
export function normalizeDocumentKey(uri: { toString(): string; fsPath: string }): string {
  const schemeMatch = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(uri.toString());
  const scheme = schemeMatch?.[1]?.toLowerCase() ?? '';
  if (scheme === 'file' || scheme === '') {
    return normalizeFileIdentity(uri.fsPath);
  }
  return uri.toString();
}

const entries = new Map<string, StoreEntry>();

function entryFor(key: string): StoreEntry {
  let entry = entries.get(key);
  if (!entry) {
    entry = {
      snapshot: {
        key,
        fsPath: '',
        version: undefined,
        text: '',
        lineStarts: [0],
        parseState: 'idle',
        lastGoodParseVersion: undefined
      },
      lines: null,
      pending: new Map(),
      syncParse: new Map()
    };
    entries.set(key, entry);
  }
  return entry;
}

function versionOf(document: DocumentStoreDocument): number | undefined {
  return typeof document.version === 'number' && Number.isFinite(document.version)
    ? document.version
    : undefined;
}

function keyOf(document: DocumentStoreDocument): string {
  return normalizeDocumentKey(document.uri);
}

function buildLines(text: string): { lineStarts: number[]; lines: string[] } {
  const lineStarts = [0];
  for (let offset = 0; offset < text.length; offset += 1) {
    const ch = text[offset];
    if (ch === '\n') {
      lineStarts.push(offset + 1);
    } else if (ch === '\r' && text[offset + 1] === '\n') {
      lineStarts.push(offset + 2);
      offset += 1;
    }
  }
  const lines: string[] = [];
  for (let index = 0; index < lineStarts.length; index += 1) {
    const start = lineStarts[index];
    const end = index + 1 < lineStarts.length ? lineStarts[index + 1] : text.length;
    // 行尾换行符不属于行内容(与 getText().split(/\r?\n/) 口径一致)
    lines.push(text.slice(start, end).replace(/\r?\n$/, ''));
  }
  return { lineStarts, lines };
}

/**
 * 内存优先更新:以 document.getText()(VS Code 缓冲区)刷新快照文本与版本。
 * 永不读磁盘 —— 「磁盘不得覆盖编辑中内容」由构造保证而非约定。
 * 同版本重复调用零成本(只对引用比较,不重拆行)。
 */
export function updateDocumentSnapshot(document: DocumentStoreDocument): DocumentSnapshot {
  const key = keyOf(document);
  const entry = entryFor(key);
  const version = versionOf(document);
  const text = document.getText();
  const snapshot = entry.snapshot;
  const unchanged =
    snapshot.version === version &&
    snapshot.text === text &&
    entry.lines !== null;
  if (!unchanged) {
    const built = buildLines(text);
    snapshot.version = version;
    snapshot.text = text;
    snapshot.lineStarts = built.lineStarts;
    entry.lines = built.lines;
    // 文本/版本变了:旧的解析结果全部作废(按版本记账,这里直接清)
    entry.syncParse.clear();
    entry.pending.clear();
    snapshot.parseState = 'idle';
    snapshot.fsPath = document.uri.fsPath;
  }
  return snapshot;
}

/**
 * 取当前版本的行数组。同版本复用快照行索引;无版本替身每次重建(等价旧行为)。
 * 未 updateDocumentSnapshot 过的文档首次调用会自动建档。
 */
export function getDocumentLines(document: DocumentStoreDocument): readonly string[] {
  const key = keyOf(document);
  const entry = entries.get(key);
  const version = versionOf(document);
  if (!entry) {
    return buildLines(document.getText()).lines;
  }
  const snapshot = entry.snapshot;
  if (snapshot.version !== version || entry.lines === null) {
    updateDocumentSnapshot(document);
    return entry.lines ?? [];
  }
  return entry.lines;
}

/** 只读快照面(不触发文本刷新;未建档返回 null) */
export function peekDocumentSnapshot(document: DocumentStoreDocument): DocumentSnapshot | null {
  return entries.get(keyOf(document))?.snapshot ?? null;
}

/** 解析缓存槽位键:不同解析函数(def AST / 未来 python 轻结构)互不串位 */
const parseSlot = (namespace: string, version: number): string => `${namespace}\u0000${version}`;

/**
 * 异步解析缓存:同版本只解析一次;解析中再调用合并到同一 Promise;
 * 解析完成时若文档已前进到新版本,旧结果不写入(返回值仍交给本次调用方,
 * 但快照的 lastGoodParseVersion/parseState 保持与新版本一致)。
 */
export async function getOrParseDocument<T>(
  document: DocumentStoreDocument,
  parse: (text: string) => T | Promise<T>,
  namespace = ''
): Promise<T> {
  const key = keyOf(document);
  const entry = entryFor(key);
  const snapshot = updateDocumentSnapshot(document);
  const version = snapshot.version;
  const startedAt = performance.now();
  if (version === undefined) {
    // 无版本替身:解析照跑,不缓存(不记录 document-parse,与旧行为同价)
    return await parse(snapshot.text);
  }
  const slot = parseSlot(namespace, version);
  if (snapshot.lastGoodParseVersion === version && entry.syncParse.has(slot)) {
    recordLanguageServiceOperation('document-parse', performance.now() - startedAt, {
      status: 'ok',
      cacheHits: 1,
      fileKind: fileKindOf(snapshot.fsPath),
      documentVersion: version
    });
    return entry.syncParse.get(slot) as T;
  }
  const pending = entry.pending.get(slot);
  if (pending) {
    recordLanguageServiceOperation('document-parse', performance.now() - startedAt, {
      status: 'ok',
      cacheHits: 1,
      fileKind: fileKindOf(snapshot.fsPath),
      documentVersion: version
    });
    return await pending as Promise<T>;
  }
  const task = (async (): Promise<T> => {
    const parseStartedAt = performance.now();
    const result = await parse(snapshot.text);
    // 版本令牌校验:解析期间文档前进 → 旧结果不覆盖新版本状态
    const stale = snapshot.version !== version;
    if (!stale) {
      entry.syncParse.set(slot, result);
      snapshot.parseState = 'parsed';
      snapshot.lastGoodParseVersion = version;
    }
    recordLanguageServiceOperation('document-parse', performance.now() - parseStartedAt, {
      status: 'ok',
      cacheMisses: 1,
      fileKind: fileKindOf(snapshot.fsPath),
      documentVersion: version
    });
    return result;
  })();
  entry.pending.set(slot, task);
  snapshot.parseState = 'parsing';
  try {
    return await task;
  } catch (error) {
    // 失败不入缓存:快照回到 idle,下一次调用重新解析(可恢复,不永久卡死)
    if (snapshot.version === version) {
      snapshot.parseState = 'idle';
    }
    entry.pending.delete(slot);
    recordLanguageServiceOperation('document-parse', performance.now() - startedAt, {
      status: 'error',
      fileKind: fileKindOf(snapshot.fsPath),
      documentVersion: version
    });
    throw error;
  } finally {
    const current = entry.pending.get(slot);
    if (current === task) {
      entry.pending.delete(slot);
    }
  }
}

/**
 * 同步解析缓存(诊断/def AST 面):同版本命中直接返回,未命中现解析并记账。
 * 无版本替身每次现解析(与旧行为同价)。返回结果 + 是否缓存命中。
 */
export function getOrParseDocumentSync<T>(
  document: DocumentStoreDocument,
  parse: (text: string) => T,
  namespace = ''
): { result: T; cacheHit: boolean } {
  const key = keyOf(document);
  const version = versionOf(document);
  if (version === undefined) {
    const result = parse(document.getText());
    recordLanguageServiceOperation('document-parse', 0, {
      status: 'ok',
      cacheMisses: 1,
      fileKind: fileKindOf(document.uri.fsPath),
      documentVersion: version
    });
    return { result, cacheHit: false };
  }
  const entry = entryFor(key);
  const snapshot = updateDocumentSnapshot(document);
  const startedAt = performance.now();
  const slot = parseSlot(namespace, version);
  if (entry.syncParse.has(slot)) {
    recordLanguageServiceOperation('document-parse', performance.now() - startedAt, {
      status: 'ok',
      cacheHits: 1,
      fileKind: fileKindOf(snapshot.fsPath),
      documentVersion: version
    });
    return { result: entry.syncParse.get(slot) as T, cacheHit: true };
  }
  const result = parse(snapshot.text);
  entry.syncParse.set(slot, result);
  snapshot.parseState = 'parsed';
  snapshot.lastGoodParseVersion = version;
  recordLanguageServiceOperation('document-parse', performance.now() - startedAt, {
    status: 'ok',
    cacheMisses: 1,
    fileKind: fileKindOf(snapshot.fsPath),
    documentVersion: version
  });
  return { result, cacheHit: false };
}

/** 关文档释放:快照/行索引/解析缓存整体删除(内存不泄漏) */
export function releaseDocument(document: DocumentStoreDocument | { uri: { toString(): string; fsPath: string } }): void {
  entries.delete(keyOf(document as DocumentStoreDocument));
}

/** 根移除释放(IDE-RES-008):该根下全部快照与解析缓存(源码文本/行索引/
 *  entities/def 解析结果)整体删除——移除根时其文档可能仍开着,不再被长会话
 *  持有;其余根原样保留。与 releaseDocument 同构:下次访问按空快照重建重解析。
 *  返回释放的快照数。 */
export function releaseDocumentsUnderRoot(rootPath: string): number {
  const normalized = normalizeFileIdentity(rootPath);
  const underRoot = (key: string): boolean =>
    key === normalized || key.startsWith(`${normalized}/`);
  let released = 0;
  const removedTexts: string[] = [];
  for (const key of [...entries.keys()]) {
    if (underRoot(key)) {
      const text = entries.get(key)?.snapshot.text;
      if (text) {
        removedTexts.push(text);
      }
      entries.delete(key);
      released += 1;
    }
  }
  // IDE-AUD-048/R2-F12:defParser 全局解析缓存是内容键,根移除时把该根已释放
  // 文档原文一并逐出,不以 8 条/8MiB LRU 预算当释放(预算只缓解,不等于释放)。
  if (removedTexts.length > 0) {
    releaseParsedDocuments(removedTexts);
  }
  return released;
}

/** 测试与停用用:清空全部快照 */
export function releaseAllDocumentSnapshots(): void {
  entries.clear();
}

/** 测试用:当前存活的快照数(泄漏断言面) */
export function getStoredSnapshotCount(): number {
  return entries.size;
}

function fileKindOf(fsPath: string): string {
  const lower = fsPath.toLowerCase();
  if (lower.endsWith('.py')) { return 'python'; }
  if (lower.endsWith('.def')) { return 'def'; }
  if (lower.endsWith('entities.xml')) { return 'entities'; }
  if (lower.endsWith('types.xml')) { return 'types'; }
  if (lower.endsWith('.xml')) { return 'xml'; }
  return 'other';
}

