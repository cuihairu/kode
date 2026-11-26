/**
 * KFLOW controlled-capture run face (FLOW-025): runs the verified collector
 * (scripts/trace/monitoring_capture.py, the sys.monitoring face) as a **child
 * process** under controlled parameters — an independent entry (invoked only
 * explicitly, with no implicit trigger of any kind), closable on timeout (kill when
 * timeoutMs is up), a bounded buffer (max-events passed through to the collector), and
 * the artifact goes through the FLOW-024 import face's red lines. Command-line
 * assembly and the child-process interaction face are injected (test stand-ins verify
 * assembly and failure paths without starting a real child; the real-capture
 * integration test uses skipIf based on interpreter capability).
 * FLOW-029: maxEvents/timeoutMs defaults to the pre-registered budgets (traceBudget,
 * the sole source of default values + hard caps); explicitly given values are also
 * bound by the hard caps.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { importMonitoringSession } from './traceImport';
import { resolveCaptureBudgets } from './traceBudget';
import type { TraceSession } from './traceEventModel';

export interface ControlledCaptureRequest {
  /** The interpreter (sys.monitoring requires >= 3.12; capability probing belongs to the caller) */
  pythonPath: string;
  /** The collector script (absolute or relative to cwd) */
  collectorScript: string;
  /** The capture target script (its whole main() = the controlled window) */
  targetScript: string;
  /** Bounded buffer passed through to the collector's --max-events (default / hard cap = the FLOW-029 pre-registered budget) */
  maxEvents?: number;
  /** Closable red line: kill on timeout (default / hard cap = the FLOW-029 pre-registered budget) */
  timeoutMs?: number;
  /** The capture cwd (frame files are converted to relative paths against it) */
  cwd: string;
  sessionId: string;
}

export interface ControlledCaptureRunResult {
  session: TraceSession;
  /** A tail of the collector's stderr (event-count lines etc.; on failure it carries error clues) */
  stderrTail: string;
  durationMs: number;
}

/** Collector command-line assembly (--key=value no-space token semantics, safe to pass through). */
export function buildCollectorArgs(request: ControlledCaptureRequest, outPath: string): string[] {
  const budget = resolveCaptureBudgets({ maxEvents: request.maxEvents, timeoutMs: request.timeoutMs });
  return [
    request.collectorScript,
    `--max-events=${budget.maxEvents}`,
    `--out=${outPath}`,
    request.targetScript
  ];
}

export interface CaptureSpawnDeps {
  spawn?: typeof nodeSpawn;
  now?: () => number;
}

interface SpawnableChild {
  stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): void };
  stderr: { on(event: 'data', listener: (chunk: Buffer | string) => void): void };
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): void;
  kill(signal?: string): boolean;
}

/** The controlled-capture entry: start the collector child process → await teardown → read the artifact → import through the protocol's red lines. */
export async function runControlledCapture(
  request: ControlledCaptureRequest,
  deps: CaptureSpawnDeps = {}
): Promise<ControlledCaptureRunResult> {
  const spawnFn = deps.spawn ?? nodeSpawn;
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const outDir = mkdtempSync(path.join(tmpdir(), 'kode-trace-'));
  const outPath = path.join(outDir, 'session.json');

  const args = buildCollectorArgs(request, outPath);
  const budget = resolveCaptureBudgets({ maxEvents: request.maxEvents, timeoutMs: request.timeoutMs });
  const child = spawnFn(request.pythonPath, args, { cwd: request.cwd }) as SpawnableChild;

  let stderr = '';
  child.stderr.on('data', (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });

  const exitPromise = new Promise<{ code: number | null; signal: string | null }>(resolve => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });

  // Closable red line: kill when the timeout is up; never leaves an unbounded capture port open.
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, budget.timeoutMs);

  let exit: { code: number | null; signal: string | null };
  try {
    exit = await exitPromise;
  } finally {
    clearTimeout(timer);
  }

  try {
    if (timedOut) {
      throw new Error(
        `受控采集超时关闭(${budget.timeoutMs}ms,已 kill);窗口完整性不可宣称,产物丢弃`
      );
    }
    if (exit.code !== 0) {
      const tail = stderr.trim().split(/\r?\n/).slice(-4).join('\n');
      throw new Error(`受控采集失败(exit=${exit.code}${exit.signal ? `,signal=${exit.signal}` : ''}):\n${tail}`);
    }
    const raw = JSON.parse(readFileSync(outPath, 'utf8')) as Parameters<
      typeof importMonitoringSession
    >[0];
    const session = importMonitoringSession(raw, request.sessionId);
    return {
      session,
      stderrTail: stderr.trim().split(/\r?\n/).slice(-4).join('\n'),
      durationMs: now() - startedAt
    };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}
