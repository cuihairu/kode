import { ChildProcess, spawn } from 'child_process';

// kode2 Rust Core 统一 transport(BUILD-005 最小版,书 §3/§4/§15 PH1-02):
// spawn kode-server 二进制 + LSP stdio 帧读写 + initialize 握手 + 请求取消 +
// 崩溃重启(CORE-015 最小版)。PR-003 只交付 transport 本体;Provider 接线在
// PR-010 双轨切换时进行,不影响现有 TS 行为(2827 基线不回归)。

/** 默认重启策略:10s 窗口内最多 3 次崩溃重启,超出判定持续失败停止重启 */
const RESTART_WINDOW_MS_DEFAULT = 10_000;
const RESTART_MAX_DEFAULT = 3;

export interface KodeCoreClientOptions {
  /** kode-server 二进制路径(cargo build 产物) */
  binaryPath: string;
  /** 传给二进制的额外参数 */
  args?: string[];
  env?: NodeJS.ProcessEnv;
  /** 崩溃重启策略;不传用默认(10s 窗口 3 次) */
  restart?: { maxRestarts?: number; windowMs?: number };
  /** initialize 参数;不传用最小集 */
  initializeParams?: KodeCoreInitializeParams;
  /** 重启完成回调(测试/可观测用) */
  onRestart?: (generation: number) => void;
  /** stderr 诊断行回调(默认丢弃;CORE-016 可观察恢复原因的入口) */
  onStderr?: (line: string) => void;
}

export interface KodeCoreInitializeParams {
  processId?: number;
  rootUri?: string;
  capabilities?: Record<string, unknown>;
  initializationOptions?: Record<string, unknown>;
}

export interface KodeCoreServerInfo {
  name: string;
  version: string;
}

export interface KodeCoreInitializeResult {
  capabilities: { textDocumentSync: { openClose: boolean; change: number } };
  serverInfo: KodeCoreServerInfo;
}

export interface KodeCoreHealth {
  status: string;
  pid: number;
  serverVersion: string;
  uptimeMs: number;
  initialized: boolean;
  shutdownRequested: boolean;
  restartGeneration: number;
  documents: { uri: string; version: number }[];
}

/** transport 层错误:进程退出/重启放弃/协议损坏 */
export class KodeCoreTransportError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'EXITED'
      | 'RESTART_GAVE_UP'
      | 'BAD_FRAME'
      | 'DISPOSED'
      | 'TIMEOUT'
      | 'REQUEST_CANCELLED'
      | 'SERVER_ERROR'
  ) {
    super(message);
    this.name = 'KodeCoreTransportError';
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  method: string;
}

/** request() 返回值:普通 promise + cancel() 句柄(CORE-007 客户端入口) */
export interface KodeCoreRequest extends Promise<unknown> {
  cancel: () => void;
}

/** 构造已失败的 KodeCoreRequest(cancel 为 no-op) */
function rejectedRequest(error: KodeCoreTransportError): KodeCoreRequest {
  const promise = Promise.reject(error) as KodeCoreRequest;
  promise.cancel = () => undefined;
  return promise;
}

/** 帧头:Content-Length 值 */
const HEADER_PATTERN = /^Content-Length: (\d+)\r\n\r\n/;

export class KodeCoreClient {
  private child: ChildProcess | null = null;
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private buffer: Buffer = Buffer.alloc(0);
  private disposed = false;
  private restartTimestamps: number[] = [];
  private initParams: KodeCoreInitializeParams;
  private stderrTail: string[] = [];

  /** 崩溃重启代数:每次意外退出+成功重启 +1(CORE-015 对账字段) */
  restartGeneration = 0;

  constructor(private readonly options: KodeCoreClientOptions) {
    this.initParams = options.initializeParams ?? { processId: process.pid, capabilities: {} };
  }

  /** 当前服务器子进程(测试/探针用;可能为 null) */
  get childProcess(): ChildProcess | null {
    return this.child;
  }

  /** 最近 stderr 行(崩溃诊断留痕,最多 50 行) */
  get recentStderr(): readonly string[] {
    return this.stderrTail;
  }

  /** spawn + initialize 握手。已启动则幂等返回既有握手结果。 */
  async start(): Promise<KodeCoreInitializeResult> {
    if (!this.child) {
      this.spawnProcess();
    }
    return this.initialize();
  }

  private spawnProcess(): void {
    this.child = spawn(this.options.binaryPath, this.options.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this.options.env,
    });
    this.child.stdout!.on('data', (chunk: Buffer) => this.consumeStdout(chunk));
    this.child.stderr!.on('data', (chunk: Buffer) => this.recordStderr(chunk));
    this.child.on('error', error => this.rejectAll(new KodeCoreTransportError(`spawn failed: ${error.message}`, 'EXITED')));
    this.child.on('exit', (_code, signal) => this.handleExit(_code, signal));
  }

  /** LSP initialize 握手(CORE-002);restartGeneration 经 initializationOptions 对账 */
  private async initialize(): Promise<KodeCoreInitializeResult> {
    const params: KodeCoreInitializeParams = {
      ...this.initParams,
      initializationOptions: {
        ...(this.initParams.initializationOptions ?? {}),
        restartGeneration: this.restartGeneration,
      },
    };
    return (await this.request('initialize', params)) as KodeCoreInitializeResult;
  }

  /** 发送请求并等待响应;opts.timeoutMs 超时先发 $/cancelRequest 再硬超时 */
  request(method: string, params?: unknown, opts?: { timeoutMs?: number }): KodeCoreRequest {
    if (this.disposed) {
      return rejectedRequest(new KodeCoreTransportError('client disposed', 'DISPOSED'));
    }
    if (!this.child) {
      // 重启放弃/未启动:立即失败,不让请求悬挂
      return rejectedRequest(
        new KodeCoreTransportError('server process not running', 'EXITED')
      );
    }
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      // 硬超时:cancel 之后服务器仍不回(挂死)时兜底拒绝
      let hardTimer: NodeJS.Timeout | undefined;
      if (opts?.timeoutMs) {
        const cancelTimer = setTimeout(() => this.cancelRequest(id), opts.timeoutMs);
        hardTimer = setTimeout(() => {
          clearTimeout(cancelTimer);
          this.pending.delete(id);
          reject(new KodeCoreTransportError(`${method} timed out after ${opts.timeoutMs}ms`, 'TIMEOUT'));
        }, opts.timeoutMs + 2000);
      }
      this.pending.set(id, {
        resolve: value => {
          if (hardTimer) {
            clearTimeout(hardTimer);
          }
          resolve(value);
        },
        reject: error => {
          if (hardTimer) {
            clearTimeout(hardTimer);
          }
          reject(error);
        },
        method,
      });
      this.sendRaw({ jsonrpc: '2.0', id, method, params });
    }) as KodeCoreRequest;
    // 取消句柄挂在 promise 上:调用方无需知道内部数字 id
    promise.cancel = () => this.cancelRequest(id);
    return promise;
  }

  /** 发送通知(无响应,失败不抛) */
  notify(method: string, params?: unknown): void {
    if (this.disposed) {
      return;
    }
    this.sendRaw({ jsonrpc: '2.0', method, params });
  }

  /** 取消进行中的请求(CORE-007 最小版:$ /cancelRequest 通知) */
  cancelRequest(id: number): void {
    this.notify('$/cancelRequest', { id });
  }

  /** 健康探针(CORE-016) */
  async health(): Promise<KodeCoreHealth> {
    return (await this.request('$/kode/health')) as KodeCoreHealth;
  }

  openDocument(uri: string, languageId: string, version: number, text: string): void {
    this.notify('textDocument/didOpen', {
      textDocument: { uri, languageId, version, text },
    });
  }

  changeDocument(uri: string, version: number, text: string): void {
    this.notify('textDocument/didChange', {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
  }

  closeDocument(uri: string): void {
    this.notify('textDocument/didClose', { textDocument: { uri } });
  }

  /** 优雅停止:shutdown → exit → 宽限后 SIGKILL;in-flight 请求以 DISPOSED 拒绝 */
  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const child = this.child;
    if (!child) {
      this.rejectAll(new KodeCoreTransportError('client disposed', 'DISPOSED'));
      return;
    }
    this.rejectAll(new KodeCoreTransportError('client disposed', 'DISPOSED'));
    try {
      await this.rawRequest('shutdown', undefined);
    } catch {
      // 服务器已死也继续走 exit/kill
    }
    this.sendRaw({ jsonrpc: '2.0', method: 'exit' });
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    const timeout = new Promise<void>(resolve => setTimeout(resolve, 1500));
    await Promise.race([exited, timeout]);
    if (!child.killed && child.exitCode === null) {
      child.kill('SIGKILL');
    }
    await exited;
    this.child = null;
  }

  // -- 内部 ------------------------------------------------------------------

  private rawRequest(method: string, params?: unknown): Promise<unknown> {
    // dispose 路径绕过 disposed 检查
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
    });
    this.sendRaw({ jsonrpc: '2.0', id, method, params });
    return promise;
  }

  private sendRaw(payload: Record<string, unknown>): void {
    const child = this.child;
    const stdin = child?.stdin;
    if (!child || !stdin || !stdin.writable) {
      return;
    }
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]));
  }

  private consumeStdout(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerMatch = HEADER_PATTERN.exec(this.buffer.toString('ascii', 0, Math.min(this.buffer.length, 512)));
      if (!headerMatch) {
        if (this.buffer.length > 64 * 1024) {
          // 非法流:丢弃并记录(BAD_FRAME)
          this.recordStderrLine(`illegal frame stream, dropped ${this.buffer.length} bytes`);
          this.buffer = Buffer.alloc(0);
        }
        return;
      }
      const headerEnd = headerMatch[0].length;
      const bodyLength = Number(headerMatch[1]);
      if (this.buffer.length < headerEnd + bodyLength) {
        return; // 短读:等下一个 chunk
      }
      const body = this.buffer.subarray(headerEnd, headerEnd + bodyLength);
      this.buffer = Buffer.from(this.buffer.subarray(headerEnd + bodyLength));
      this.dispatchMessage(body);
    }
  }

  private dispatchMessage(body: Buffer): void {
    let message: { id?: number | string | null; result?: unknown; error?: { code: number; message: string } };
    try {
      message = JSON.parse(body.toString('utf8'));
    } catch {
      this.recordStderrLine(`bad json frame body: ${body.length} bytes`);
      return;
    }
    if (message.id === undefined || message.id === null) {
      return; // 服务器通知:PR-003 暂无消费者,留 onNotification 扩展位
    }
    const pending = this.pending.get(Number(message.id));
    if (!pending) {
      return;
    }
    this.pending.delete(Number(message.id));
    if (message.error) {
      pending.reject(
        new KodeCoreTransportError(
          `${pending.method} failed (${message.error.code}): ${message.error.message}`,
          message.error.code === -32800 ? 'REQUEST_CANCELLED' : 'SERVER_ERROR'
        )
      );
    } else {
      pending.resolve(message.result);
    }
  }

  private recordStderr(chunk: Buffer): void {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (line.trim()) {
        this.recordStderrLine(line);
      }
    }
  }

  private recordStderrLine(line: string): void {
    this.stderrTail.push(line);
    if (this.stderrTail.length > 50) {
      this.stderrTail.shift();
    }
    this.options.onStderr?.(line);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  /** 意外退出:重启窗口内自动 respawn + 重握手;超出放弃(CORE-015) */
  private handleExit(_code: number | null, signal: string | null): void {
    this.rejectAll(new KodeCoreTransportError(`server exited (signal=${signal})`, 'EXITED'));
    this.buffer = Buffer.alloc(0);
    this.child = null;
    if (this.disposed) {
      return;
    }
    const windowMs = this.options.restart?.windowMs ?? RESTART_WINDOW_MS_DEFAULT;
    const maxRestarts = this.options.restart?.maxRestarts ?? RESTART_MAX_DEFAULT;
    const now = Date.now();
    this.restartTimestamps = this.restartTimestamps.filter(ts => now - ts < windowMs);
    if (this.restartTimestamps.length >= maxRestarts) {
      this.recordStderrLine(`restart limit reached (${maxRestarts} in ${windowMs}ms), giving up`);
      return;
    }
    this.restartTimestamps.push(now);
    this.restartGeneration += 1;
    this.recordStderrLine(`restarting server (generation ${this.restartGeneration})`);
    this.spawnProcess();
    this.initialize()
      .then(() => this.options.onRestart?.(this.restartGeneration))
      .catch(error => {
        this.recordStderrLine(`restart handshake failed: ${(error as Error).message}`);
      });
  }
}
