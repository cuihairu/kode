import * as fs from 'fs';
import * as path from 'path';
import { Worker } from 'worker_threads';
import { parseDefDocument, type DefDocument } from './defParser';

// IDE-REV-039: move def XML parsing out of the host thread (mirroring the
// pythonParserWorker pattern) -- async schema building hands single-file large
// defs (>=12k lines, 95-185ms) to the worker, yielding the host during the parse
// phase; the sync surface (direct parseDefDocument calls) is unchanged. Below
// the threshold or when the artifact is missing, parse synchronously (small defs
// are cheap anyway, no worker round trip); worker crashes / over-limit rejections
// are caught by the caller (the async driver) and fall back synchronously -- the
// schema build never blows up.

/** Only use the worker above this byte size (roughly 2000 lines): small defs parse synchronously, avoiding the worker round-trip cost */
export const DEF_PARSE_WORKER_MIN_BYTES = 64 * 1024;

/** Hard cap on in-flight (dispatched, not yet replied) jobs -- over the cap is rejected, and the caller falls back synchronously */
export const MAX_POSTED_PARSE_JOBS = 16;

/** Hard cap on in-flight source-string bytes -- over the cap is rejected, and the caller handles it by category (KODE-FULL-015) */
export const MAX_POSTED_PARSE_BYTES = 8 * 1024 * 1024;

/**
 * KODE-FULL-015: a distinguishable error for budget-class rejections (overload /
 * single item too large) -- callers use it to tell "queued and recoverable" apart
 * from "input out of shape", instead of unconditionally falling back to host
 * sync parsing.
 */
export class DefParserBudgetError extends Error {
  constructor(
    /** overload = in-flight job/byte budget full (recoverable after waiting); too-large = a single item exceeds the byte cap */
    readonly kind: 'overload' | 'too-large',
    message: string
  ) {
    super(message);
    this.name = 'DefParserBudgetError';
  }
}

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
  /** In-flight jobs already dispatched to the worker */
  running: number;
  /** Total bytes of in-flight source strings */
  postedBytes: number;
  /** Hard cap on in-flight job count */
  maxPostedJobs: number;
  /** Hard cap on in-flight source-string bytes */
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
  const created = new Worker(path.join(__dirname, '..', 'defParserWorker.js'));
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
 * IDE-REV-039: parse def text -- large text goes to the worker (out of the host
 * thread), small text / missing artifacts parse synchronously. The returned
 * DefDocument is the structured clone sent back by the worker (a plain object
 * graph; the parent/document back-references form cycles, and identity is
 * preserved after cloning). Failures (worker crash / single parse error /
 * in-flight over-limit) reject, and the caller falls back synchronously.
 */
export async function parseDefDocumentResponsive(
  text: string,
  label = 'def'
): Promise<DefDocument> {
  const workerFile = path.join(__dirname, '..', 'defParserWorker.js');
  if (text.length < DEF_PARSE_WORKER_MIN_BYTES || !fs.existsSync(workerFile)) {
    return parseDefDocument(text);
  }
  // KODE-FULL-015:预算拒绝分两类可恢复语义——
  // - overload:在途任务数或字节预算满,调用方可等待重试(排干后可恢复);
  // - too-large:单件自身超字节上限。too-large 且当前无任何在途任务时放行
  //   单飞(worker 本就是隔离边界,宿主绝不因超大输入回落同步解析——
  //   那正是把最大输入拉回 Extension Host 冻结 UI 的旧病灶)。
  if (posted.size >= MAX_POSTED_PARSE_JOBS) {
    throw new DefParserBudgetError(
      'overload',
      `Def parse ${label} in-flight job budget exceeded (${MAX_POSTED_PARSE_JOBS} jobs)`
    );
  }
  const soloOversize = text.length > MAX_POSTED_PARSE_BYTES && posted.size === 0 && postedBytes === 0;
  if (!soloOversize && postedBytes + text.length > MAX_POSTED_PARSE_BYTES) {
    throw new DefParserBudgetError(
      'too-large',
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
