import * as fs from 'fs';
import * as path from 'path';
import { Worker } from 'worker_threads';
import { parsePythonFile, type ParsedPythonFile } from './pythonParser';

export const PYTHON_WORKER_PARSE_THRESHOLD = 256 * 1024;

/** IDE-RES-002 待处理字节量上限:未派发(待派发最新)任务保留的源码串
 *  总量上界。达到上限后新积压请求不再无限保留源码串,以可解释错误拒绝;
 *  已在途任务与同文件合并(每文件只留最新一份)不受影响。 */
export const MAX_QUEUED_PARSE_BYTES = 8 * 1024 * 1024;

interface ParseReply {
  id: number;
  revision: number;
  parsed?: ParsedPythonFile;
  error?: string;
}

interface PendingParse {
  resolve: (reply: { revision: number; parsed: ParsedPythonFile }) => void;
  reject: (error: Error) => void;
}

/** 一次解析任务(IDE-RES-001:waiters 可多于一个——未派发即被更新版本
 *  合并的旧请求,其等待者改跟合并后任务的结果结算;调用方按 revision
 *  比对丢弃,语义与旧行为一致)。 */
interface HostedJob {
  id: number;
  filePath: string;
  content: string;
  revision: number;
  waiters: PendingParse[];
}

/** 同文件派发链:在途一个 + 待派发最新一个。快速提交 v1/v2/v3 时,
 *  未运行的旧版本(尚未派发给 worker)不逐份解析——只有首份与最新份
 *  进 worker,中间版本零解析直接以最新结果结算。 */
interface FileQueue {
  inFlight: HostedJob | null;
  pendingLatest: HostedJob | null;
}

let worker: Worker | null = null;
let nextId = 1;
const posted = new Map<number, HostedJob>();
const fileQueues = new Map<string, FileQueue>();
/** IDE-RES-002:待派发任务保留的源码串字节总量(已派发的 postMessage 后即释放) */
let queuedBytes = 0;

function failPending(error: Error): void {
  for (const job of posted.values()) {
    for (const waiter of job.waiters) { waiter.reject(error); }
  }
  for (const queue of fileQueues.values()) {
    const latest = queue.pendingLatest;
    if (latest) {
      for (const waiter of latest.waiters) { waiter.reject(error); }
    }
  }
  posted.clear();
  fileQueues.clear();
  queuedBytes = 0;
}

/** 派发队列下一项:在途空且有待派发最新时接链 */
function drainQueue(queue: FileQueue): void {
  if (queue.inFlight || !queue.pendingLatest) { return; }
  const next = queue.pendingLatest;
  queue.pendingLatest = null;
  queuedBytes -= next.content.length;
  dispatchJob(queue, next);
}

function dispatchJob(queue: FileQueue, job: HostedJob): void {
  queue.inFlight = job;
  posted.set(job.id, job);
  try {
    ensureWorker().postMessage({ id: job.id, content: job.content, filePath: job.filePath, revision: job.revision });
    // IDE-RES-002:已派发即释放 host 侧源码串副本(worker 已持自有拷贝,
    // host 长会话不再扣着大字符串不放)
    job.content = '';
  } catch (error) {
    posted.delete(job.id);
    queue.inFlight = null;
    const failure = error instanceof Error ? error : new Error(String(error));
    for (const waiter of job.waiters) { waiter.reject(failure); }
    drainQueue(queue);
  }
}

function ensureWorker(): Worker {
  if (worker) { return worker; }
  const created = new Worker(path.join(__dirname, 'pythonParserWorker.js'));
  created.unref();
  created.on('message', (reply: ParseReply) => {
    const job = posted.get(reply.id);
    if (!job) { return; }
    posted.delete(reply.id);
    const queue = fileQueues.get(job.filePath);
    if (queue && queue.inFlight === job) { queue.inFlight = null; }
    if (reply.error || !reply.parsed) {
      const failure = new Error(reply.error ?? 'empty parser result');
      for (const waiter of job.waiters) { waiter.reject(failure); }
    } else {
      for (const waiter of job.waiters) {
        waiter.resolve({ revision: reply.revision, parsed: reply.parsed });
      }
    }
    if (queue) { drainQueue(queue); }
  });
  const failed = (error: Error): void => {
    if (worker !== created) { return; }
    worker = null;
    failPending(error);
  };
  created.on('error', failed);
  created.on('exit', code => failed(new Error(`Python parser worker exited (${code})`)));
  worker = created;
  return created;
}

/** Large parse jobs leave the extension host; callers must still compare revisions. */
export async function parsePythonFileResponsive(
  content: string,
  filePath: string,
  revision: number
): Promise<{ revision: number; parsed: ParsedPythonFile }> {
  const workerFile = path.join(__dirname, 'pythonParserWorker.js');
  if (content.length < PYTHON_WORKER_PARSE_THRESHOLD || !fs.existsSync(workerFile)) {
    return { revision, parsed: parsePythonFile(content, filePath) };
  }
  const queue = fileQueues.get(filePath) ?? { inFlight: null, pendingLatest: null };
  fileQueues.set(filePath, queue);
  if (queue.inFlight !== null || queue.pendingLatest !== null) {
    // IDE-RES-002:积压字节记账——同文件顶替先释放旧版字节再记新版;总量
    // 超上限不再保留源码串,以可解释错误拒绝(调用方 loadFile 登记有界重试/
    // onDocumentChanged 留待下次编辑自然重试)
    const superseded = queue.pendingLatest;
    const freedBytes = superseded ? superseded.content.length : 0;
    if (queuedBytes - freedBytes + content.length > MAX_QUEUED_PARSE_BYTES) {
      return Promise.reject(new Error(
        `Python parse backlog byte budget exceeded (${MAX_QUEUED_PARSE_BYTES} bytes queued)`
      ));
    }
    queuedBytes += content.length - freedBytes;
    const job: HostedJob = { id: nextId++, filePath, content, revision, waiters: [] };
    const promise = new Promise<{ revision: number; parsed: ParsedPythonFile }>((resolve, reject) => {
      job.waiters.push({ resolve, reject });
    });
    // 同文件在途:未派发的上一版被本版合并(等待者改跟本版结果);
    // 已在途的那份不可抢占,回包后本版接链派发
    if (superseded) {
      job.waiters.push(...superseded.waiters);
    }
    queue.pendingLatest = job;
    return promise;
  }
  const job: HostedJob = { id: nextId++, filePath, content, revision, waiters: [] };
  const promise = new Promise<{ revision: number; parsed: ParsedPythonFile }>((resolve, reject) => {
    job.waiters.push({ resolve, reject });
  });
  dispatchJob(queue, job);
  return promise;
}

export function disposePythonParserWorker(): void {
  const current = worker;
  worker = null;
  failPending(new Error('Python parser worker disposed'));
  if (current) { void current.terminate(); }
}
