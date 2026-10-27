import * as fs from 'fs';
import * as path from 'path';
import { Worker } from 'worker_threads';
import { parsePythonFile, type ParsedPythonFile } from './pythonParser';

export const PYTHON_WORKER_PARSE_THRESHOLD = 256 * 1024;

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

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, PendingParse>();

function failPending(error: Error): void {
  for (const job of pending.values()) { job.reject(error); }
  pending.clear();
}

function ensureWorker(): Worker {
  if (worker) { return worker; }
  const created = new Worker(path.join(__dirname, 'pythonParserWorker.js'));
  created.unref();
  created.on('message', (reply: ParseReply) => {
    const job = pending.get(reply.id);
    if (!job) { return; }
    pending.delete(reply.id);
    if (reply.error || !reply.parsed) { job.reject(new Error(reply.error ?? 'empty parser result')); }
    else { job.resolve({ revision: reply.revision, parsed: reply.parsed }); }
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
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try { ensureWorker().postMessage({ id, content, filePath, revision }); }
    catch (error) {
      pending.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export function disposePythonParserWorker(): void {
  const current = worker;
  worker = null;
  failPending(new Error('Python parser worker disposed'));
  if (current) { void current.terminate(); }
}
