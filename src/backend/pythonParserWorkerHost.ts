import * as fs from 'fs';
import * as path from 'path';
import { Worker } from 'worker_threads';
import { parsePythonFile, type ParsedPythonFile } from './pythonParser';

export const PYTHON_WORKER_PARSE_THRESHOLD = 256 * 1024;

/** IDE-RES-002 pending-byte ceiling: the upper bound on the source strings kept by
 *  undelivered (latest-to-be-dispatched) tasks. Once the ceiling is hit, new backlog
 *  requests stop holding their source strings indefinitely and are rejected with an
 *  explainable error; in-flight tasks and same-file merging (only the latest one kept
 *  per file) are unaffected. */
export const MAX_QUEUED_PARSE_BYTES = 8 * 1024 * 1024;

/** IDE-AUD-022: hard cap on the number of in-flight (dispatched, no reply yet) tasks.
 *  When the worker hangs without replying, posted no longer grows without bound; a
 *  first task over the cap switches to the pending queue (bounded by the byte budget),
 *  and after replies come back the global yield surface keeps dispatching the latest
 *  versions. */
export const MAX_POSTED_PARSE_JOBS = 16;

/** IDE-AUD-022: hard cap on in-flight source-string bytes (the host releases content on
 *  dispatch; this counts the source the worker holds or that is in transfer, the same
 *  accounting as MAX_QUEUED_PARSE_BYTES). */
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

/** One parse task (IDE-RES-001: there can be more than one waiter -- an old request
 *  merged by a newer version before it was dispatched settles on the merged task's
 *  result; callers compare revisions and drop, with semantics matching the old
 *  behaviour). */
interface HostedJob {
  id: number;
  filePath: string;
  content: string;
  /** Original source length (AUD-022): after dispatch the host releases content, and
   * in-flight bytes are written back off against this. */
  contentLength: number;
  revision: number;
  waiters: PendingParse[];
}

/** Same-file dispatch chain: one in flight + the latest pending one. On rapid commits
 *  v1/v2/v3, the old versions that have not run yet (not dispatched to the worker) are
 *  not each parsed -- only the first and the latest enter the worker, and the middle
 *  versions settle straight on the latest result with zero parsing. */
interface FileQueue {
  inFlight: HostedJob | null;
  pendingLatest: HostedJob | null;
}

let worker: Worker | null = null;
let nextId = 1;
const posted = new Map<number, HostedJob>();
const fileQueues = new Map<string, FileQueue>();
/** IDE-RES-002: total source-string bytes held by pending tasks (released once dispatched via postMessage) */
let queuedBytes = 0;
/** IDE-REV-030: queued-byte high-water mark within the session (monotonically non-decreasing; does not fall back on drain/cleanup) */
let peakQueuedBytes = 0;
/** IDE-REV-030: cumulative number of requests rejected for exceeding the budget (kept after reset, so an on-site report can recognise the backlog history) */
let budgetRejects = 0;
/** IDE-AUD-022: total source-string bytes in flight (dispatched, no reply yet; counted on dispatch, written back on reply/failure) */
let postedBytes = 0;

/** RUST-031: one degraded-ledger entry -- which file was rejected for exceeding the budget,
 *  the size of the most recently rejected source string, and the cumulative reject count. */
export interface PythonParseDegradedFile {
  filePath: string;
  bytes: number;
  rejects: number;
}

/** RUST-031: the over-budget degradation ledger (bounded within the session, keeping only
 *  the latest DEGRADED_LEDGER_LIMIT files; retained after reset so a status report can
 *  state plainly "which files are degraded in capability" -- budgetRejects is only a
 *  total and says nothing about which file). */
const DEGRADED_LEDGER_LIMIT = 20;
const degradedFiles = new Map<string, PythonParseDegradedFile>();

/** Record one over-budget rejection: increment the count and write the ledger (a known
 *  file only accumulates, a new file enters the table, and the oldest is evicted past
 *  the bound). */
function noteBudgetReject(filePath: string, bytes: number): void {
  budgetRejects += 1;
  const existing = degradedFiles.get(filePath);
  if (existing) {
    existing.rejects += 1;
    existing.bytes = bytes;
    return;
  }
  degradedFiles.set(filePath, { filePath, bytes, rejects: 1 });
  if (degradedFiles.size > DEGRADED_LEDGER_LIMIT) {
    const oldest = degradedFiles.keys().next().value;
    if (oldest !== undefined) { degradedFiles.delete(oldest); }
  }
}

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

/** IDE-REV-030: the measured view of the parse worker's queue and byte occupancy.
 *  On-site reports read this and do not substitute indexTasksQueued -- that is a queued
 *  count at the index-task layer, not the dispatch queue of the parse thread. The byte
 *  accounting is the same source as MAX_QUEUED_PARSE_BYTES: JS character length
 *  (code units of the source string), with no extra byte estimation. */
export interface PythonParserWorkerGauge {
  /** In-flight tasks already dispatched into the worker (posted; stays visible while the worker hangs without replying) */
  running: number;
  /** Undelivered pending tasks (at most the latest one kept per file) */
  queued: number;
  /** Source-string bytes held by pending tasks (the same budget accounting; released on dispatch) */
  queuedBytes: number;
  /** Byte budget ceiling (i.e. MAX_QUEUED_PARSE_BYTES) */
  maxQueuedBytes: number;
  /** Queued-byte high-water mark (within the session; retained after a drain to recognise the backlog history) */
  peakQueuedBytes: number;
  /** Cumulative number of requests rejected for exceeding the budget */
  budgetRejects: number;
  /** RUST-031: snapshot of the over-budget degradation ledger (bounded within the session, latest entries in the table; retained after reset) */
  degradedFiles: PythonParseDegradedFile[];
  /** Total source-string bytes in flight (dispatched, no reply yet) (AUD-022) */
  postedBytes: number;
  /** Hard cap on the number of in-flight tasks (i.e. MAX_POSTED_PARSE_JOBS) */
  maxPostedJobs: number;
  /** Hard cap on in-flight source-string bytes (i.e. MAX_POSTED_PARSE_BYTES) */
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
    degradedFiles: [...degradedFiles.values()],
    postedBytes,
    maxPostedJobs: MAX_POSTED_PARSE_JOBS,
    maxPostedBytes: MAX_POSTED_PARSE_BYTES
  };
}

/** For tests: clear the peak/reject counters and the degradation ledger (leaves the in-flight queues themselves alone) */
export function resetPythonParserWorkerGaugeCountersForTests(): void {
  peakQueuedBytes = 0;
  budgetRejects = 0;
  degradedFiles.clear();
}

/** For tests: the current number of fileQueues entries (the PAR-1/KR-AUD-07 reclaim acceptance face) */
export function fileQueueCountForTests(): number {
  return fileQueues.size;
}

/** AUD-022: whether an in-flight (dispatched) task can still take on new tasks -- twin
 *  hard caps on count and bytes; past either, stop posting directly and switch to the
 *  pending queue. */
function canPostNow(contentLength: number): boolean {
  return posted.size < MAX_POSTED_PARSE_JOBS && postedBytes + contentLength <= MAX_POSTED_PARSE_BYTES;
}

/** AUD-022: the global yield surface. After some task's reply/failure releases in-flight
 *  capacity, dispatch each file's pending latest, in file registration order, until the
 *  in-flight hard cap -- after a reset the latest versions can keep flowing, so updates
 *  are not lost to a first task stuck in flight. */
function drainAllQueues(): void {
  for (const queue of fileQueues.values()) {
    if (queue.inFlight !== null || !queue.pendingLatest) { continue; }
    if (!canPostNow(queue.pendingLatest.content.length)) { continue; }
    const next = queue.pendingLatest;
    queue.pendingLatest = null;
    queuedBytes -= next.content.length;
    dispatchJob(queue, next);
  }
  // PAR-1 (KR-AUD-07): drained file queues (nothing in flight, nothing pending) are no
  // longer kept -- reclaimed right after a reply/failure so the long-session map does not
  // grow linearly with the number of processed files. Collect first, then delete, to
  // avoid mutating the map mid-iteration.
  const drained: string[] = [];
  for (const [filePath, queue] of fileQueues) {
    if (queue.inFlight === null && queue.pendingLatest === null) {
      drained.push(filePath);
    }
  }
  for (const filePath of drained) {
    fileQueues.delete(filePath);
  }
}

function dispatchJob(queue: FileQueue, job: HostedJob): void {
  queue.inFlight = job;
  posted.set(job.id, job);
  postedBytes += job.contentLength;
  try {
    ensureWorker().postMessage({ id: job.id, content: job.content, filePath: job.filePath, revision: job.revision });
    // IDE-RES-002: release the host-side source-string copy on dispatch (the worker holds
    // its own copy, and the host no longer withholds the large string through a long
    // session)
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
    // IDE-RES-002: backlog byte accounting -- a same-file supersede releases the old version's
    // bytes before recording the new one; once the total exceeds the ceiling, stop holding
    // source strings and reject with an explainable error (the caller's loadFile registers a
    // bounded retry / onDocumentChanged leaves it to a natural retry on the next edit)
    const superseded = queue.pendingLatest;
    const freedBytes = superseded ? superseded.content.length : 0;
    if (queuedBytes - freedBytes + content.length > MAX_QUEUED_PARSE_BYTES) {
      noteBudgetReject(filePath, content.length);
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
    // Same file already in flight: the previous undelivered version is merged into this one
    // (its waiters settle on this version's result); the already-dispatched one cannot be
    // preempted, and this version chains onto the dispatch after its reply
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
  // AUD-022: even a first task must not bypass the in-flight hard caps -- when in flight is
  // full (count/bytes) it switches to the pending queue (bounded by the byte budget), and
  // after a reply the global yield surface keeps dispatching
  if (canPostNow(content.length)) {
    dispatchJob(queue, job);
  } else if (queuedBytes + content.length <= MAX_QUEUED_PARSE_BYTES) {
    queuedBytes += content.length;
    if (queuedBytes > peakQueuedBytes) { peakQueuedBytes = queuedBytes; }
    queue.pendingLatest = job;
  } else {
    noteBudgetReject(filePath, content.length);
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
  // terminate can reject (dead thread etc.): a rejection must never become an unhandled
  // rejection -- all waiters were settled in failPending, and there is no remediation face
  // for a failed terminate, so close this out silently.
  if (current) { void current.terminate().catch(() => undefined); }
}
