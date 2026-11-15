import { ChildProcess, spawn } from 'child_process';
import { randomBytes } from 'crypto';

// kode2 Rust Core 统一 transport(BUILD-005 最小版,书 §3/§4/§15 PH1-02):
// spawn kode-server 二进制 + LSP stdio 帧读写 + initialize 握手 + 请求取消 +
// 崩溃重启(CORE-015 最小版)。PR-003 只交付 transport 本体;Provider 接线在
// PR-010 双轨切换时进行,不影响现有 TS 行为(2827 基线不回归)。

/** 默认重启策略:10s 窗口内最多 3 次崩溃重启,超出判定持续失败停止重启 */
const RESTART_WINDOW_MS_DEFAULT = 10_000;
const RESTART_MAX_DEFAULT = 3;

/** dispose 优雅关闭上限:shutdown 回包等待超过即判定服务器挂死,直接 SIGKILL(CORE-1) */
const DISPOSE_SHUTDOWN_TIMEOUT_MS_DEFAULT = 5_000;

/**
 * initialize 握手预算(KBUG-TIME-02):进程存活但不回 initialize 时 start()
 * 原本无限挂起,后续所有请求排队堆积。10s 供慢启动/排队;交互面另有更短
 * 端到端预算(如 localReturnType 面自行 race),此处是 transport 层兜底。
 */
const START_TIMEOUT_MS_DEFAULT = 10_000;

/**
 * RUST-008 判据①:自有协议版本化。TS 侧期望版本,与 Rust 侧
 * `crates/kode-protocol/src/lib.rs` 的 `PROTOCOL_VERSION` **钉死同步**(两侧
 * 同批改:RPC 形状漂移的任何一侧改动都必须同时推进两侧常量)。握手回包
 * serverInfo.version 不一致 = 两侧形状可能互不认识,拒绝以旧形状对讲。
 */
export const KODE_PROTOCOL_VERSION = '0.2.0';

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
  /**
   * initialize 握手预算(ms);默认 10000。超时 start() 以 TIMEOUT 拒绝,
   * pending/计时器照常清理(KBUG-TIME-02/05:存活不响应不得无限挂起)。
   */
  startTimeoutMs?: number;
  /** initialize 参数;不传用最小集 */
  initializeParams?: KodeCoreInitializeParams;
  /** 重启完成回调(测试/可观测用) */
  onRestart?: (generation: number) => void;
  /** stderr 诊断行回调(默认丢弃;CORE-016 可观察恢复原因的入口) */
  onStderr?: (line: string) => void;
  /** RUST-068-W 客户端追踪行回调(发送/响应/取消,带 span;默认丢弃) */
  onTrace?: (line: string) => void;
}

export interface KodeCoreInitializeParams {
  processId?: number;
  rootUri?: string;
  /** LSP 多工作区文件夹(KBUG-ROOT 根归属);缺省只落 rootUri。 */
  workspaceFolders?: { uri: string; name?: string }[];
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
  /** RUST-026 Core 进程资源快照;非 Linux/解析失败=null 诚实降级 */
  resources?: {
    rssBytes: number;
    threads: number;
    diskReadBytes: number;
    diskWriteBytes: number;
    /** 累计 CPU 时间 ms;两次采样差分得速率;0 是合法读数(年轻进程) */
    cpuTimeMs: number;
  } | null;
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
      | 'PROTOCOL_VERSION_MISMATCH'
  ) {
    super(message);
    this.name = 'KodeCoreTransportError';
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  method: string;
  /** RUST-068-W:请求 span(信封级透传 + 追踪行/取消行回捞) */
  span: string;
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

/** RUST-068-W:请求 span 生成(8 字节随机 hex;跨进程唯一,无语义不含敏感面) */
function newSpanId(): string {
  return randomBytes(8).toString('hex');
}

export class KodeCoreClient {
  private child: ChildProcess | null = null;
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private buffer: Buffer = Buffer.alloc(0);
  private disposed = false;
  private restartTimestamps: number[] = [];
  private initParams: KodeCoreInitializeParams;
  private stderrTail: string[] = [];
  // RUST-025 RPC 消息字节数(JSON body 双向累计,不含 LSP 帧头常量开销;
  // 跨重启累加,观测进程生命周期总量口径)
  private rpcBytesIn = 0;
  private rpcBytesOut = 0;

  /** 崩溃重启代数:每次意外退出+成功重启 +1(CORE-015 对账字段) */
  restartGeneration = 0;

  constructor(private readonly options: KodeCoreClientOptions) {
    this.initParams = options.initializeParams ?? { processId: process.pid, capabilities: {} };
  }

  /** 当前服务器子进程(测试/探针用;可能为 null) */
  get childProcess(): ChildProcess | null {
    return this.child;
  }

  /** 在途请求数(测试用;KBUG-TIME-05 清理验收读口) */
  pendingCountForTests(): number {
    return this.pending.size;
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

  /** RPC 消息字节流量(RUST-025;JSON body 双向,不含帧头) */
  get rpcTraffic(): { bytesIn: number; bytesOut: number } {
    return { bytesIn: this.rpcBytesIn, bytesOut: this.rpcBytesOut };
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
    // KBUG-TIME-02:握手带预算(存活不响应时 start() 以 TIMEOUT 拒绝,
    // 不无限挂起;重启路径的握手失败语义不变,走既有 catch 处理)
    const startTimeoutMs = this.options.startTimeoutMs ?? START_TIMEOUT_MS_DEFAULT;
    const result = (await this.request('initialize', params, {
      timeoutMs: startTimeoutMs
    })) as KodeCoreInitializeResult;
    // RUST-008 判据①:协议版本不一致 = 两侧 RPC 形状可能互不认识,拒绝对讲。
    // 杀掉子进程但保留 client 可再 spawn——版本对上(如用户原地换了二进制)
    // 后下一次 start() 自然恢复;gate 侧现有 catch 把本错误归入回落 TS 面。
    const serverVersion = result.serverInfo?.version;
    if (serverVersion !== KODE_PROTOCOL_VERSION) {
      this.child?.kill();
      this.child = null;
      throw new KodeCoreTransportError(
        `protocol version mismatch: extension expects ${KODE_PROTOCOL_VERSION}, ` +
        `kode-server reports ${serverVersion ?? 'unknown'}`,
        'PROTOCOL_VERSION_MISMATCH'
      );
    }
    return result;
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
    // RUST-068-W:信封级 span(`$/kode/rpc` 顶层 spanId;浅拷贝不碰调用方
    // 对象,内层 params 原样——worker handler 契约零感知)。其余 method 不注
    // 入(LSP 标准面零污染;追踪行仍带 span 供端到端对账)。
    const span = newSpanId();
    let wireParams = params;
    if (method === '$/kode/rpc') {
      wireParams =
        params !== null && typeof params === 'object' && !Array.isArray(params)
          ? { ...(params as Record<string, unknown>), spanId: span }
          : params;
    }
    this.trace(`request ${id} ${method} send (span=${span})`);
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
        span,
      });
      this.sendRaw({ jsonrpc: '2.0', id, method, params: wireParams });
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
    const span = this.pending.get(id)?.span;
    this.trace(`request ${id} cancel sent (span=${span ?? '-'})`);
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

  /**
   * RUST-069-W 根生命周期:新增根注册(幂等,同路径重复注册返回既有 id)。
   * 请求面带回执(根 id),装配/测试可断言根身份。
   */
  async addWorkspaceRoot(fsPath: string): Promise<{ root: number }> {
    return (await this.request('$/kode/workspace/rootAdded', { path: fsPath })) as {
      root: number;
    };
  }

  /**
   * RUST-069-W 根生命周期:根移除——服务端撤注册并扇出共享缓存清理
   * (镜像/符号/解析候选),已注册根回执带每消费面清除数(document-store /
   * hover-engine 按登记序);未知根 removed:false(不扇出)。
   */
  async removeWorkspaceRoot(fsPath: string): Promise<{
    removed: boolean;
    root?: number;
    invalidated?: Array<[string, number]>;
  }> {
    return (await this.request('$/kode/workspace/rootRemoved', { path: fsPath })) as {
      removed: boolean;
      root?: number;
      invalidated?: Array<[string, number]>;
    };
  }

  /**
   * RUST-074-W 暖门:首扫开始——server 侧 keyed 状态机入队(Warming)。
   * 进行中复用(同 scanId);失败/取消后重开 decision=recovered。
   */
  async beginBackgroundScan(total: number): Promise<{
    state: string;
    decision: string;
    scanId: number;
  }> {
    return (await this.request('$/kode/index/beginBackgroundScan', { total })) as {
      state: string;
      decision: string;
      scanId: number;
    };
  }

  /** RUST-074-W 暖门:首扫完成——泵至 Warm;无进行中首扫 -32602(迟到回执) */
  async scanComplete(done: number, failed: number): Promise<{
    state: string;
    done: number;
    failed: number;
  }> {
    return (await this.request('$/kode/index/scanComplete', { done, failed })) as {
      state: string;
      done: number;
      failed: number;
    };
  }

  /** RUST-074-W 暖门:首扫取消(镜像中断)——回 Idle 不留假 pending;幂等 */
  async scanCancel(): Promise<{ state: string }> {
    return (await this.request('$/kode/index/scanCancel')) as { state: string };
  }

  /** RUST-074-W 暖门:暖态观测(state/coldWhileWarming/done/failed/total) */
  async warmState(): Promise<{
    state: string;
    coldWhileWarming: number;
    done: number;
    failed: number;
    total: number | null;
  }> {
    return (await this.request('$/kode/index/warmState')) as {
      state: string;
      coldWhileWarming: number;
      done: number;
      failed: number;
      total: number | null;
    };
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
    const span = newSpanId();
    this.trace(`request ${id} ${method} send (span=${span})`);
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method, span });
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
      this.rpcBytesOut += body.length;
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
      this.rpcBytesIn += body.length;
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
      // RUST-068-W:错误面留痕(取消/服务错误都带同一 span)。
      this.trace(
        `request ${message.id} ${pending.method} failed ${message.error.code} (span=${pending.span})`
      );
      pending.reject(
        new KodeCoreTransportError(
          `${pending.method} failed (${message.error.code}): ${message.error.message}`,
          message.error.code === -32800 ? 'REQUEST_CANCELLED' : 'SERVER_ERROR'
        )
      );
    } else {
      this.trace(`request ${message.id} ${pending.method} done (span=${pending.span})`);
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

  /** RUST-068-W:客户端追踪行(onTrace 回调;默认丢弃) */
  private trace(line: string): void {
    this.options.onTrace?.(line);
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
