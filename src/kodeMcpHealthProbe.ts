// kode-mcp 活性探针(2026-11-24 MCP 活性灯批,MCP 面「已构建」≠「能拉起
// 能应答」):真 spawn kode-mcp --probe,换行分隔 JSON-RPC 握手(initialize
// → initialized → tools/list),拿到 tools/list 应答即判活通过并收掉子进程。
// Rust --probe 模式跳过语料装载(空库直服务握手面),毫秒级应答(crates/
// kode-mcp/tests/probe_mode.rs 钉合同);探针整体与预算竞速,预算臂 reason
// 缺省=未决(疑似挂死),与 Core probeHealth 同约定。探针只观测不托管:
// VS Code 原生 MCP 的真实服务进程生命周期仍归宿主,本探针自拉自收不留进程。
// 纯 node 模块(零 vscode 依赖),单测直接导入。

import { spawn } from 'child_process';

export const KODE_MCP_PROBE_BUDGET_MS = 3_000;

/** 探针结果:reason=快速失败臂原错误词(spawn 失败/进程提前退出);缺省=
 * 预算臂未决(疑似挂死)。与 CoreHealthProbeResult 同形状 */
export interface KodeMcpProbeResult {
  ok: boolean;
  latencyMs: number;
  reason?: string;
}

/** 子进程最小面(真 ChildProcess 结构兼容;测试注脚本化假进程) */
export interface KodeMcpProbeProcess {
  stdin: { write(chunk: string): void; end(): void };
  stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): void };
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'exit', listener: (code: number | null) => void): void;
  kill(): unknown;
}

export interface KodeMcpProbeDeps {
  spawn(command: string, args: readonly string[]): KodeMcpProbeProcess;
  /** 探针总预算毫秒(缺省 3s;测试注小值) */
  readonly budgetMs?: number;
  /** 时间源(测试注固定值) */
  readonly now?: () => number;
}

const initializeRequest = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'kode-mcp-health-probe', version: '0.0.0' }
  }
});
const initializedNotification = JSON.stringify({
  jsonrpc: '2.0',
  method: 'notifications/initialized'
});
const toolsListRequest = JSON.stringify({
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/list',
  params: {}
});

/** 真依赖:stderr 直弃(stdio ignore,防服务端日志写满管道壁反咬探针) */
export function realKodeMcpProbeDeps(): KodeMcpProbeDeps {
  return {
    spawn: (command, args) =>
      spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'] }) as unknown as KodeMcpProbeProcess
  };
}

/**
 * 单轮探活。整轮(含 spawn)与预算竞速:预算先到=未决臂(reason 缺省);
 * 握手完成=通过;spawn 失败/进程提前退出=快速失败臂(带原错误词)。
 * 收尾无条件 kill 子进程(通过/失败/预算三臂都不留进程)。
 */
export async function probeKodeMcpHealth(
  deps: KodeMcpProbeDeps,
  binaryPath: string,
  assetsRoot: string
): Promise<KodeMcpProbeResult> {
  const now = deps.now ?? (() => Date.now());
  const budgetMs = deps.budgetMs ?? KODE_MCP_PROBE_BUDGET_MS;
  const started = now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<KodeMcpProbeResult>(resolve => {
    timer = setTimeout(() => resolve({ ok: false, latencyMs: now() - started }), budgetMs);
  });

  // holder 结构(直存 let 变量跨闭包会被 TS 收窄成 never——属性访问不被跟踪)
  const holder: { proc: KodeMcpProbeProcess | null } = { proc: null };
  const outcome = (async (): Promise<KodeMcpProbeResult> => {
    const proc = deps.spawn(binaryPath, ['--probe', assetsRoot]);
    holder.proc = proc;
    return await new Promise<KodeMcpProbeResult>((resolve, reject) => {
      let buffer = '';
      proc.stdout.on('data', chunk => {
        buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        for (;;) {
          const newlineAt = buffer.indexOf('\n');
          if (newlineAt < 0) {
            break;
          }
          const line = buffer.slice(0, newlineAt).trim();
          buffer = buffer.slice(newlineAt + 1);
          if (!line) {
            continue;
          }
          let message: { id?: number };
          try {
            message = JSON.parse(line) as { id?: number };
          } catch {
            continue;
          }
          if (message.id === 1) {
            // initialize 应答到手才发 initialized + tools/list(MCP 规矩:
            // initialized 通知必须在 initialize 应答之后)
            proc.stdin.write(`${initializedNotification}\n`);
            proc.stdin.write(`${toolsListRequest}\n`);
          } else if (message.id === 2) {
            resolve({ ok: true, latencyMs: now() - started });
          }
        }
      });
      proc.on('error', error => reject(new Error(`kode-mcp probe spawn failed: ${error.message}`)));
      proc.on('exit', code =>
        reject(new Error(`kode-mcp probe process exited before answering (code ${code ?? 'signal'})`))
      );
      proc.stdin.write(`${initializeRequest}\n`);
    });
  })();

  try {
    return await Promise.race([
      outcome.then(
        result => result,
        (error: unknown) => ({
          ok: false as const,
          latencyMs: now() - started,
          reason: String((error as Error | undefined)?.message ?? error).slice(0, 160)
        })
      ),
      budget
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    // 三臂统一收尾:通过臂(应答即收)/失败臂/预算臂(在途 promise 自行了
    // 结,进程在这里收,绝不留孤儿)。
    holder.proc?.kill();
    void outcome.catch(() => undefined);
  }
}
