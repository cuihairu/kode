import { ChildProcess, spawn } from 'child_process';

// kode2 Rust Core 统一 transport(BUILD-005 最小版,书 §3/§4/§15 PH1-02):
// spawn kode-server 二进制 + LSP stdio 帧读写 + initialize 握手 + 请求取消 +
// 崩溃重启(CORE-015 最小版)。PR-003 只交付 transport 本体;Provider 接线在
// PR-010 双轨切换时进行,不影响现有 TS 行为(2827 基线不回归)。

/** 默认重启策略:10s 窗口内最多 3 次崩溃重启,超出判定持续失败停止重启 */
const RESTART_WINDOW_MS_DEFAULT = 10_000;
const RESTART_MAX_DEFAULT = 3;

/** dispose 优雅关闭上限:shutdown 回包等待超过即判定服务器挂死,直接 SIGKILL(CORE-1) */
const DISPOSE_SHUTDOWN_TIMEOUT_MS_DEFAULT = 5_000;

export interface KodeCoreClientOptions {
  /** kode-server 二进制路径(cargo build 产物) */
  binaryPath: string;
  /** 传给二进制的额外参数 */
  args?: string[];
  env?: NodeJS.ProcessEnv;
  /** 崩溃重启策略;不传用默认(10s 窗口 3 次) */
  restart?: { maxRestarts?: number; windowMs?: number };
  /** dispose 时 shutdown 回包等待上限(ms);默认 5000,超时判定挂死并 SIGKILL(CORE-1) */
  shutdownTimeoutMs?: number;
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

  /**
   * 重启代数读口(E-2):下游账本(如切流门的语料镜像账)据此感知自动重启,
   * 新进程是空库,旧账本必须随重启失效。
   */
  getRestartGeneration(): number {
    return this.restartGeneration;
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
    // stdin EPIPE (errno -32): SIGKILL 生效到 exit 事件到达之间存在窗口，
    // 此时 stdin.writable 仍为 true，sendRaw 往死管道 write 会以未处理
    // 'error' 事件炸掉整个测试进程（CI #418 实录）。这里必须吞掉：
    // in-flight 请求由 exit 事件的 rejectAll(EXITED) 统一拒绝，waitFor
    // 探针自然重试，CORE-015/016 重启语义不变。
    this.child.stdin!.on('error', () => undefined);
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
      let cancelTimer: NodeJS.Timeout | undefined;
      if (opts?.timeoutMs) {
        cancelTimer = setTimeout(() => this.cancelRequest(id), opts.timeoutMs);
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
          // CORE-2:请求正常完成后同时清理 cancelTimer,避免对已完成 id
          // 发送迟到的 $/cancelRequest 通知
          if (cancelTimer) {
            clearTimeout(cancelTimer);
          }
          resolve(value);
        },
        reject: error => {
          if (hardTimer) {
            clearTimeout(hardTimer);
          }
          if (cancelTimer) {
            clearTimeout(cancelTimer);
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
    // CORE-1 挂起路径 1:shutdown 回包原本无超时,server 存活但挂死(handler
    // 死循环/背压)时 dispose 永久挂起,后面的 exit/KILL 清理永远走不到。
    // 包一层超时:超时判定挂死,直接 SIGKILL;rawRequest promise 自身保持
    // 挂 catch,避免 exit 竞态迟到的 rejectAll 变成 unhandled rejection。
    const shutdownTimeoutMs = this.options.shutdownTimeoutMs ?? DISPOSE_SHUTDOWN_TIMEOUT_MS_DEFAULT;
    let shutdownTimedOut = false;
    try {
      await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          shutdownTimedOut = true;
          reject(new KodeCoreTransportError(`shutdown timed out after ${shutdownTimeoutMs}ms`, 'TIMEOUT'));
        }, shutdownTimeoutMs);
        this.rawRequest('shutdown', undefined).then(
          value => {
            clearTimeout(timer);
            resolve(value);
          },
          error => {
            clearTimeout(timer);
            reject(error);
          }
        );
      });
    } catch {
      // 服务器已死也继续走 exit/kill;挂死则立即 SIGKILL,不再等宽限
      if (shutdownTimedOut && child.exitCode === null) {
        child.kill('SIGKILL');
      }
    }
    this.sendRaw({ jsonrpc: '2.0', method: 'exit' });
    const exited = new Promise<void>(resolve => {
      // CORE-1 挂起路径 2:shutdown 等待期间子进程已自行退出时(handleExit
      // 已消费 exit 事件并置 child=null),once('exit') 注册在已发事件的进程
      // 上永不触发——用 exitCode/signalCode 守卫直接完成,避免末尾
      // `await exited` 永久挂起(子进程孤儿泄漏)。
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      child.once('exit', () => resolve());
    });
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
    try {
      stdin.write(
        Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body])
      );
    } catch {
      // exit 竞态窗口的同步写失败同上吞掉：响应已不可能，拒绝走 exit 路径
    }
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
        const message = `restart handshake failed: ${(error as Error).message}`;
        this.recordStderrLine(message);
        // CORE-3:respawn 后握手失败的进程处于未初始化态,继续接单只会让
        // 后续请求得到误导性 SERVER_ERROR(Rust 侧 -32002 SERVER_NOT_INITIALIZED)。
        // 杀掉子进程并置 child=null,让请求走 EXITED 路径(服务不可用语义)。
        // 摘掉 exit 监听再杀,避免触发 handleExit 无意义的二次 respawn。
        const child = this.child;
        this.child = null;
        if (child) {
          child.removeAllListeners('exit');
          child.kill('SIGKILL');
        }
        this.rejectAll(new KodeCoreTransportError(message, 'EXITED'));
      });
  }
}
