/**
 * KFLOW 受控采集运行面(FLOW-025):把已验证采集器
 * (scripts/trace/monitoring_capture.py,sys.monitoring 面)作为**子进程**
 * 跑在受控参数下——独立入口(只被显式调用,无任何隐式触发)、超时可关闭
 * (timeoutMs 到点 kill)、有界缓冲(max-events 透传采集器)、产物经
 * FLOW-024 导入面过红线。命令行组装与子进程交互面注入(测试替身验证组装
 * 与失败路径,不起真子进程;真采集集成测试按解释器能力 skipIf)。
 * FLOW-029:maxEvents/timeoutMs 缺省走预登记预算(traceBudget,默认值+
 * 硬顶唯一出处),显式给值也受硬顶约束。
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { importMonitoringSession } from './traceImport';
import { resolveCaptureBudgets } from './traceBudget';
import type { TraceSession } from './traceEventModel';

export interface ControlledCaptureRequest {
  /** 解释器(须 ≥3.12 才有 sys.monitoring;能力探测归调用方) */
  pythonPath: string;
  /** 采集器脚本(绝对/相对 cwd 均可) */
  collectorScript: string;
  /** 采集目标脚本(其 main() 全程=受控窗口) */
  targetScript: string;
  /** 有界缓冲透传采集器 --max-events(缺省/硬顶=FLOW-029 预登记预算) */
  maxEvents?: number;
  /** 可关闭红线:超时 kill(缺省/硬顶=FLOW-029 预登记预算) */
  timeoutMs?: number;
  /** 采集 cwd(帧 file 以此为基准换相对路径) */
  cwd: string;
  sessionId: string;
}

export interface ControlledCaptureRunResult {
  session: TraceSession;
  /** 采集器 stderr 摘要(事件计数行等;失败时含错误线索) */
  stderrTail: string;
  durationMs: number;
}

/** 采集器命令行组装(--key=value 无空格 token 口径,透传安全)。 */
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

/** 受控采集入口:起采集器子进程 → 等收口 → 读产物 → 导入协议红线。 */
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

  // 可关闭红线:超时到点 kill,不留给无界采集口。
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
