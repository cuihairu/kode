import * as fs from 'fs';
import * as path from 'path';
import { Worker } from 'worker_threads';
import { parseDefDocument, type DefDocument } from './defParser';

// IDE-REV-039:def XML 解析移出宿主线程(镜像 pythonParserWorker 模式)——异步
// schema 构建把单文件大 def(≥12k 行,95-185ms)解析交给 worker,宿主在解析段
// 让出;同步面(parseDefDocument 直调)行为不变。低于阈值或产物缺失直接同步
// 解析(小 def 本就廉价,不付 worker 往返);worker 崩溃/超限拒绝由调用方
// (异步驱动)捕获后同步兜底,绝不炸 schema 构建。

/** 超过此字节量(约 2000 行)才走 worker:小 def 同步解析,避免 worker 往返开销 */
export const DEF_PARSE_WORKER_MIN_BYTES = 64 * 1024;

/** 在途(已派发未回包)任务数硬上限——超限拒绝,调用方同步兜底 */
export const MAX_POSTED_PARSE_JOBS = 16;

/** 在途源码串字节硬上限——超限拒绝,调用方同步兜底 */
export const MAX_POSTED_PARSE_BYTES = 8 * 1024 * 1024;

interface DefParseReply {
  id: number;
  document?: DefDocument;
  error?: string;
}

interface PendingParse {
  resolve: (document: DefDocument) => void;
  reject: (error: Error) => void;
  contentLength: number;
}

let worker: Worker | null = null;
let nextId = 1;
const posted = new Map<number, PendingParse>();
let postedBytes = 0;

export interface DefParserWorkerGauge {
  /** 已派发进 worker 的在途任务数 */
  running: number;
  /** 在途源码串字节总量 */
  postedBytes: number;
  /** 在途任务数硬上限 */
  maxPostedJobs: number;
  /** 在途源码串字节硬上限 */
  maxPostedBytes: number;
}

export function getDefParserWorkerGauge(): DefParserWorkerGauge {
  return {
    running: posted.size,
    postedBytes,
    maxPostedJobs: MAX_POSTED_PARSE_JOBS,
    maxPostedBytes: MAX_POSTED_PARSE_BYTES
  };
}

function failAllPending(error: Error): void {
  for (const pending of posted.values()) { pending.reject(error); }
  posted.clear();
  postedBytes = 0;
}

function ensureWorker(): Worker {
  if (worker) { return worker; }
  const created = new Worker(path.join(__dirname, 'defParserWorker.js'));
  created.unref();
  created.on('message', (reply: DefParseReply) => {
    const pending = posted.get(reply.id);
    if (!pending) { return; }
    posted.delete(reply.id);
    postedBytes -= pending.contentLength;
    if (reply.error || !reply.document) {
      pending.reject(new Error(reply.error ?? 'empty def parser result'));
    } else {
      pending.resolve(reply.document);
    }
  });
  const failed = (error: Error): void => {
    if (worker !== created) { return; }
    worker = null;
    failAllPending(error);
  };
  created.on('error', failed);
  created.on('exit', code => failed(new Error(`Def parser worker exited (${code})`)));
  worker = created;
  return created;
}

/**
 * IDE-REV-039:解析 def 文本——大文本走 worker(移出宿主线程),小文本/产物
 * 缺失直接同步解析。返回的 DefDocument 是 worker 回传的 structured clone
 * (plain object 图,parent/document 回引成环,内部同一性克隆后保持)。
 * 失败(worker 崩溃/单次解析错误/在途超限)reject,由调用方同步兜底。
 */
export async function parseDefDocumentResponsive(
  text: string,
  label = 'def'
): Promise<DefDocument> {
  const workerFile = path.join(__dirname, 'defParserWorker.js');
  if (text.length < DEF_PARSE_WORKER_MIN_BYTES || !fs.existsSync(workerFile)) {
    return parseDefDocument(text);
  }
  if (posted.size >= MAX_POSTED_PARSE_JOBS || postedBytes + text.length > MAX_POSTED_PARSE_BYTES) {
    throw new Error(
      `Def parse ${label} backlog byte budget exceeded (${MAX_POSTED_PARSE_BYTES} bytes in flight)`
    );
  }
  const id = nextId++;
  const promise = new Promise<DefDocument>((resolve, reject) => {
    posted.set(id, { resolve, reject, contentLength: text.length });
  });
  postedBytes += text.length;
  try {
    ensureWorker().postMessage({ id, text });
  } catch (error) {
    posted.delete(id);
    postedBytes -= text.length;
    throw error instanceof Error ? error : new Error(String(error));
  }
  return promise;
}

export function disposeDefParserWorker(): void {
  const current = worker;
  worker = null;
  failAllPending(new Error('Def parser worker disposed'));
  if (current) { void current.terminate().catch(() => undefined); }
}
