import * as fs from 'fs';
import * as path from 'path';
import { Worker } from 'worker_threads';
import { parsePythonFile, type ParsedPythonFile } from './pythonParser';

export const PYTHON_WORKER_PARSE_THRESHOLD = 256 * 1024;

/** IDE-RES-002 待处理字节量上限:未派发(待派发最新)任务保留的源码串
 *  总量上界。达到上限后新积压请求不再无限保留源码串,以可解释错误拒绝;
 *  已在途任务与同文件合并(每文件只留最新一份)不受影响。 */
export const MAX_QUEUED_PARSE_BYTES = 8 * 1024 * 1024;

/** IDE-AUD-022:在途(已派发未回包)任务数硬上限。worker 挂起不回包时
 *  posted 不再无限增长;超限的首份任务转为待派发排队(受字节预算约束),
 *  回包后按全局让路面继续派发最新版本。 */
export const MAX_POSTED_PARSE_JOBS = 16;

/** IDE-AUD-022:在途源码串字节硬上限(已派发即 host 释放,此处计 worker
 *  持有/传输中的源码量,与 MAX_QUEUED_PARSE_BYTES 同口径)。 */
export const MAX_POSTED_PARSE_BYTES = 8 * 1024 * 1024;

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
  /** 原始源码长度(AUD-022):派发后 host 释放 content,在途字节据此冲销。 */
  contentLength: number;
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
/** IDE-REV-030:排队字节峰值(会话内高水位,单调不降;排干/清理不回落) */
let peakQueuedBytes = 0;
/** IDE-REV-030:因超预算被拒的请求累计数(恢复后保留,供现场报告辨认积压史) */
let budgetRejects = 0;
/** IDE-AUD-022:在途(已派发未回包)源码串字节总量(派发时计,回包/失败冲销) */
let postedBytes = 0;

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
  postedBytes = 0;
}

/** IDE-REV-030:解析 worker 队列与字节占用的实测面。现场报告读这里,
 * 不用 indexTasksQueued 代替——那是索引任务层的排队计数,不是解析线程
 * 的派发队列。字节口径与 MAX_QUEUED_PARSE_BYTES 同源:JS 字符 length
 * (源码串码元计),不做额外字节估算。 */
export interface PythonParserWorkerGauge {
  /** 已派发进 worker 的在途任务数(posted;worker 挂起不回包时持续可见) */
  running: number;
  /** 未派发的待派发任务数(每文件最多保留最新一份) */
  queued: number;
  /** 待派发任务保留的源码串字节量(同预算口径;已派发即释放) */
  queuedBytes: number;
  /** 字节预算上限(即 MAX_QUEUED_PARSE_BYTES) */
  maxQueuedBytes: number;
  /** 排队字节峰值(会话内高水位;排干后保留供辨认积压史) */
  peakQueuedBytes: number;
  /** 因超预算被拒的请求累计数 */
  budgetRejects: number;
  /** 在途(已派发未回包)源码串字节总量(AUD-022) */
  postedBytes: number;
  /** 在途任务数硬上限(即 MAX_POSTED_PARSE_JOBS) */
  maxPostedJobs: number;
  /** 在途源码串字节硬上限(即 MAX_POSTED_PARSE_BYTES) */
  maxPostedBytes: number;
}

export function getPythonParserWorkerGauge(): PythonParserWorkerGauge {
  let queued = 0;
  for (const queue of fileQueues.values()) {
    if (queue.pendingLatest) { queued += 1; }
  }
  return {
    running: posted.size,
    queued,
    queuedBytes,
    maxQueuedBytes: MAX_QUEUED_PARSE_BYTES,
    peakQueuedBytes,
    budgetRejects,
    postedBytes,
    maxPostedJobs: MAX_POSTED_PARSE_JOBS,
    maxPostedBytes: MAX_POSTED_PARSE_BYTES
  };
}

/** 测试用:清峰值/拒绝计数(不影响在途队列本身) */
export function resetPythonParserWorkerGaugeCountersForTests(): void {
  peakQueuedBytes = 0;
  budgetRejects = 0;
}

/** AUD-022:在途(已派发)任务是否还可接新任务——数量与字节双硬上限,
 *  任一超限即不再直接 post,改走待派发排队。 */
function canPostNow(contentLength: number): boolean {
  return posted.size < MAX_POSTED_PARSE_JOBS && postedBytes + contentLength <= MAX_POSTED_PARSE_BYTES;
}

/** AUD-022:全局让路面。某任务回包/失败释放在途容量后,按文件登记序
 *  派发各文件待派发最新,直至在途硬上限——恢复后最新版本可继续,
 *  不因首份任务积压而丢更新。 */
function drainAllQueues(): void {
  for (const queue of fileQueues.values()) {
    if (queue.inFlight !== null || !queue.pendingLatest) { continue; }
    if (!canPostNow(queue.pendingLatest.content.length)) { continue; }
    const next = queue.pendingLatest;
    queue.pendingLatest = null;
    queuedBytes -= next.content.length;
    dispatchJob(queue, next);
  }
}

function dispatchJob(queue: FileQueue, job: HostedJob): void {
  queue.inFlight = job;
  posted.set(job.id, job);
  postedBytes += job.contentLength;
  try {
    ensureWorker().postMessage({ id: job.id, content: job.content, filePath: job.filePath, revision: job.revision });
    // IDE-RES-002:已派发即释放 host 侧源码串副本(worker 已持自有拷贝,
    // host 长会话不再扣着大字符串不放)
    job.content = '';
  } catch (error) {
    posted.delete(job.id);
    postedBytes -= job.contentLength;
    queue.inFlight = null;
    const failure = error instanceof Error ? error : new Error(String(error));
    for (const waiter of job.waiters) { waiter.reject(failure); }
    drainAllQueues();
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
    postedBytes -= job.contentLength;
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
    drainAllQueues();
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
      budgetRejects += 1;
      return Promise.reject(new Error(
        `Python parse backlog byte budget exceeded (${MAX_QUEUED_PARSE_BYTES} bytes queued)`
      ));
    }
    queuedBytes += content.length - freedBytes;
    if (queuedBytes > peakQueuedBytes) { peakQueuedBytes = queuedBytes; }
    const job: HostedJob = { id: nextId++, filePath, content, contentLength: content.length, revision, waiters: [] };
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
  const job: HostedJob = { id: nextId++, filePath, content, contentLength: content.length, revision, waiters: [] };
  const promise = new Promise<{ revision: number; parsed: ParsedPythonFile }>((resolve, reject) => {
    job.waiters.push({ resolve, reject });
  });
  // AUD-022:首份任务也不能绕过在途硬上限——在途满(数量/字节)时转为
  // 待派发排队(受字节预算约束),回包后全局让路面继续派发
  if (canPostNow(content.length)) {
    dispatchJob(queue, job);
  } else if (queuedBytes + content.length <= MAX_QUEUED_PARSE_BYTES) {
    queuedBytes += content.length;
    if (queuedBytes > peakQueuedBytes) { peakQueuedBytes = queuedBytes; }
    queue.pendingLatest = job;
  } else {
    budgetRejects += 1;
    return Promise.reject(new Error(
      `Python parse backlog byte budget exceeded (${MAX_QUEUED_PARSE_BYTES} bytes queued)`
    ));
  }
  return promise;
}

export function disposePythonParserWorker(): void {
  const current = worker;
  worker = null;
  failPending(new Error('Python parser worker disposed'));
  // terminate 可能 reject(线程已死等):拒绝也不许变 unhandled rejection——
  // 等待者已全部在 failPending 结清,终止失败无补救面,静默收口。
  if (current) { void current.terminate().catch(() => undefined); }
}
