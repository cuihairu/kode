import { ChildProcess, spawn } from 'child_process';
import { randomBytes } from 'crypto';

import {
  CancellationTokenSource,
  createMessageConnection,
  Disposable,
  ResponseError,
  StreamMessageReader,
  WriteableStreamMessageWriter,
  type ContentTypeDecoder,
  type ContentTypeDecoderOptions,
  type ContentTypeEncoder,
  type ContentTypeEncoderOptions,
  type Message,
  type MessageConnection
} from 'vscode-jsonrpc/node';

import { FrameWriter } from './frameWriter';

// kode2 Rust Core unified transport (BUILD-005 minimal version, book
// §3/§4/§15 PH1-02):
// spawns the kode-server binary + LSP stdio frame read/write + initialize
// handshake + request cancellation + crash restart (CORE-015 minimal version).
// PR-003 delivers the transport itself only; Provider wiring happens at the
// PR-010 dual-track switchover and does not affect existing TS behavior (the
// 2827 baseline does not regress).

/** default restart policy: at most 3 crash restarts within a 10s window;
 * beyond that it is judged a persistent failure and restarting stops */
const RESTART_WINDOW_MS_DEFAULT = 10_000;
const RESTART_MAX_DEFAULT = 3;

/** graceful dispose limit: if waiting for the shutdown reply exceeds this, the
 * server is judged hung and gets SIGKILL'd directly (CORE-1) */
const DISPOSE_SHUTDOWN_TIMEOUT_MS_DEFAULT = 5_000;

/**
 * initialize handshake budget (KBUG-TIME-02): when the process is alive but
 * never answers initialize, start() used to hang forever and every later
 * request piled up in the queue. 10s covers slow starts / queueing; the
 * interactive surface has its own shorter end-to-end budget (e.g. the
 * localReturnType surface races on its own), and this is the transport-layer
 * backstop.
 */
const START_TIMEOUT_MS_DEFAULT = 10_000;

/**
 * request budget backstop (2026-11-24 on-machine wedging batch): when
 * request() is not given opts.timeoutMs, everything is capped at this value —
 * previously direct-call legs such as rootAdded/scanComplete/warmState/health
 * had no budget, so with a wedged server each one hung for 10s and the
 * index/jump/CodeLens chain stopped altogether with no way for the user to tell
 * why. Explicit budgets (1-5s on the interactive surface, 30s+ on the scan
 * surface) take priority; 0 or negative (explicitly passing
 * opts.timeoutMs <= 0) = giving up the budget deliberately (only for surfaces
 * known never to hang).
 */
export const DEFAULT_RPC_TIMEOUT_MS = 10_000;

/**
 * RUST-008 criterion (1): our own protocol is versioned. The TS-side expected
 * version must be **pinned in sync** with the Rust side's `PROTOCOL_VERSION` in
 * `crates/kode-protocol/src/lib.rs` (both sides change together: any one-sided
 * change that drifts the RPC shape must advance both constants at once). A
 * mismatching serverInfo.version in the handshake reply means the two sides
 * may not recognize each other's shape, so talking on the old shape is refused.
 */
export const KODE_PROTOCOL_VERSION = '0.2.0';

export interface KodeCoreClientOptions {
  /** path to the kode-server binary (a cargo build artifact) */
  binaryPath: string;
  /** extra arguments passed to the binary */
  args?: string[];
  env?: NodeJS.ProcessEnv;
  /** crash restart policy; defaults to the built-in one (10s window, 3 times) */
  restart?: { maxRestarts?: number; windowMs?: number };
  /** upper bound on waiting for the shutdown reply during dispose (ms); default
   * 5000 — beyond that the server is judged hung and SIGKILL'd (CORE-1) */
  shutdownTimeoutMs?: number;
  /**
   * initialize handshake budget (ms); default 10000. On timeout start() rejects
   * with TIMEOUT, and pending requests/timers are cleaned up as usual
   * (KBUG-TIME-02/05: being alive but unresponsive must not hang forever).
   */
  startTimeoutMs?: number;
  /** initialize parameters; the minimal set is used when omitted */
  initializeParams?: KodeCoreInitializeParams;
  /** restart-completed callback (for tests/observability) */
  onRestart?: (generation: number) => void;
  /** stderr diagnostic line callback (discarded by default; the entry point for
   * observing recovery reasons, CORE-016) */
  onStderr?: (line: string) => void;
  /** RUST-068-W client trace-line callback (send/response/cancel, carrying the
   * span; discarded by default) */
  onTrace?: (line: string) => void;
  /** lifecycle evidence-line callback (spawned/ready/exit/restart loop;
   * discarded by default; WARM-VISIBILITY-004 blade B) */
  onLifecycle?: (line: string) => void;
  /**
   * server notification callback (RUST-142 wiring: the PR-003 extension slot
   * becomes the consumer surface). Fired only when the notification carries
   * method+params; notifications and responses are distinguished by whether an id
   * is present, and this callback bypasses pending.
   */
  onNotification?: (notification: ServerNotificationMessage) => void;
}

/** server notification frame surface (no id; method + optional params). */
export interface ServerNotificationMessage {
  method: string;
  params?: unknown;
}

export interface KodeCoreInitializeParams {
  processId?: number;
  rootUri?: string;
  /** LSP multi workspace folders (KBUG-ROOT root attribution); when omitted only
   * rootUri is set. */
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
  /** RUST-026 Core process resource snapshot; non-Linux / parse failure = null
   * as an honest degradation */
  resources?: {
    rssBytes: number;
    threads: number;
    diskReadBytes: number;
    diskWriteBytes: number;
    /** cumulative CPU time in ms; a rate comes from differencing two samples;
     * 0 is a legal reading (young process) */
    cpuTimeMs: number;
  } | null;
  /** RUST-078-W: server-side residency maintenance observation (idle aging +
   * memory-pressure proactive reclaim); always present */
  maintenance: {
    agedTerminal: number;
    pressureReclaims: number;
    /** RSS from the most recent pressure sample; never sampled / non-Linux =
     * null as an honest degradation */
    lastRssBytes: number | null;
  };
  /** RUST-070/071/073: index refresh queue observation (the ingest pipeline's
   * ledger); always present */
  ingest: {
    /** entries currently queued */
    queued: number;
    /** cumulative enqueue count (yield re-enqueues are included) */
    enqueued: number;
    /** merges of the same file at the same version */
    merged: number;
    /** drops of stale versions */
    staleDropped: number;
    /** rejections because the queue is full */
    rejectedQueueFull: number;
    /** cumulative successful executions */
    executed: number;
    /** pending entries cleared by a root removal */
    purged: number;
    /** RUST-082: cumulative didChange events entering the storm buffer */
    stormSeen: number;
    /** events absorbed by same-file coalescing inside the storm buffer */
    stormMerged: number;
    /** entries still buffered right now */
    stormBuffered: number;
    /** handoffs of a whole batch when the window expires (max-latency promise
     * accounting) */
    stormDeadlineFlushes: number;
    /** forced flushes because the buffer exceeded its limit */
    stormForcedFlushes: number;
  };
}

/** transport-layer error: process exit / restart given up / corrupt protocol */
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
  /** RUST-068-W: request span (envelope-level passthrough + retrieval for trace
   * lines / cancel lines) */
  span: string;
  /**
   * cancellation handle the library turns into a $/cancelRequest notification
   * for the wire id it assigned. Cancelled after the response arrived it is a
   * no-op (the library already disposed its listener; CORE-2).
   */
  tokenSource: CancellationTokenSource;
}

/** request() return value: a plain promise plus a cancel() handle (the CORE-007
 * client entry point) */
export interface KodeCoreRequest extends Promise<unknown> {
  cancel: () => void;
}

/** builds an already-rejected KodeCoreRequest (cancel is a no-op) */
function rejectedRequest(error: KodeCoreTransportError): KodeCoreRequest {
  const promise = Promise.reject(error) as KodeCoreRequest;
  promise.cancel = () => undefined;
  return promise;
}

/** RUST-068-W: request span generation (8 random bytes in hex; unique across
 * processes, semantically meaningless and free of sensitive surfaces) */
function newSpanId(): string {
  return randomBytes(8).toString('hex');
}

/** the writable-stream face the library writer consumes (RAL.WritableStream;
 * aliased via the constructor so no extra type import is needed) */
type LibraryWritableStream = ConstructorParameters<typeof WriteableStreamMessageWriter>[0];

/** headerless-stream watchdog bound: raw bytes with no decodable frame header
 * past this bound trip the `illegal frame stream` diagnostic (the old
 * consumeStdout dropped the bytes at the same point) */
const ILLEGAL_STREAM_BYTES = 64 * 1024;

export class KodeCoreClient {
  private child: ChildProcess | null = null;
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private disposed = false;
  private restartTimestamps: number[] = [];
  private initParams: KodeCoreInitializeParams;
  private stderrTail: string[] = [];
  // RUST-025 RPC message byte counts (JSON body accumulated in both directions,
  // excluding the constant LSP frame-header overhead; accumulated across
  // restarts, so the observation is the process-lifetime total)
  private rpcBytesIn = 0;
  private rpcBytesOut = 0;

  /** crash restart generation: +1 per unexpected exit followed by a successful
   * restart (the CORE-015 reconciliation field) */
  restartGeneration = 0;

  /**
   * RUST-TRACK-FREEZE-007 blade 1: the handshake result is cached per
   * generation. The mirror flood (mirrorCorpusToRust calling start() per file)
   * and serveInRust's per-request start() each re-sent a full initialize
   * handshake before — thousands of def/xml mirrors = thousands of handshake
   * round trips stacked on the extension main thread's await chain (one of
   * the main causes behind the user report "switching to rust gets
   * progressively laggier"). A repeated start() on the surviving same-generation
   * process now returns the existing handshake result directly; a crash restart
   * increments the generation, the cache invalidates automatically, and the
   * restart re-handshake semantics (CORE-002/015) are unchanged.
   * initialize() writes the cache (start() and handleExit's restart path share
   * the same entry point).
   */
  private handshakeResult: KodeCoreInitializeResult | null = null;
  private handshakeGeneration = -1;
  private starting: { child: ChildProcess; result: Promise<KodeCoreInitializeResult> } | null = null;

  // One writer per pipe. Queued frames from an exited child must never reach its replacement.
  private frameWriter: FrameWriter | null = null;

  /**
   * one library connection per child (KODE-RPC-LIB-001: framing + JSON-RPC
   * dispatch are owned by vscode-jsonrpc's StreamMessageReader /
   * WriteableStreamMessageWriter / createMessageConnection; the client keeps
   * only trace/span/timer/cancel bookkeeping around it). Nulled and disposed
   * in clearProcess, so an exited child's connection can never dispatch into
   * its replacement's pending entries.
   */
  private connection: MessageConnection | null = null;

  // headerless-stream watchdog state (diagnostic only; see createStdoutWatchdog).
  // Reset per spawn and per decoded frame.
  private watchdogBytes = 0;
  private watchdogTail = '';
  private watchdogHeaderSeen = false;

  /** number of queued unwritten frames (the RESP-009 buffer-upper-bound
   * observation port; for tests/observability) */
  get writeQueueDepth(): number {
    return this.frameWriter?.pendingFrames ?? 0;
  }

  /** notification consumer surface (the PR-003 extension slot; defaults to
   * options.onNotification at construction and may be set later) */
  private notificationHandler: ((notification: ServerNotificationMessage) => void) | null;

  constructor(private readonly options: KodeCoreClientOptions) {
    this.initParams = options.initializeParams ?? { processId: process.pid, capabilities: {} };
    this.notificationHandler = options.onNotification ?? null;
  }

  /** late notification consumer surface (RUST-142 wiring: the gate wires it
   * lazily, so it can be set again once the client is built on demand). */
  setNotificationHandler(handler: ((notification: ServerNotificationMessage) => void) | null): void {
    this.notificationHandler = handler;
  }

  /** the current server child process (for tests/probes; may be null) */
  get childProcess(): ChildProcess | null {
    return this.child;
  }

  /** number of in-flight requests (for tests; the KBUG-TIME-05 cleanup
   * acceptance read port) */
  pendingCountForTests(): number {
    return this.pending.size;
  }

  /**
   * restart generation read port (E-2): downstream ledgers (such as the
   * switchover gate's corpus mirror ledger) use this to notice an automatic
   * restart — the new process has an empty corpus, so the old ledger must be
   * invalidated with the restart.
   */
  getRestartGeneration(): number {
    return this.restartGeneration;
  }

  /** recent stderr lines (crash-diagnostics trace, at most 50 lines) */
  get recentStderr(): readonly string[] {
    return this.stderrTail;
  }

  /** RPC message byte traffic (RUST-025; JSON body in both directions,
   * excluding frame headers) */
  get rpcTraffic(): { bytesIn: number; bytesOut: number } {
    return { bytesIn: this.rpcBytesIn, bytesOut: this.rpcBytesOut };
  }

  /** spawn + initialize handshake. If already started, idempotently returns the
   * existing handshake result (same-generation cache, zero RPC). */
  async start(): Promise<KodeCoreInitializeResult> {
    if (this.disposed) {
      throw new KodeCoreTransportError('client disposed', 'DISPOSED');
    }
    if (
      this.child &&
      this.handshakeGeneration === this.restartGeneration &&
      this.handshakeResult
    ) {
      return this.handshakeResult;
    }
    const child = this.child ?? this.spawnProcess();
    if (this.starting?.child === child) {
      return this.starting.result;
    }
    const result = this.initialize(child).catch(error => {
      if (!this.disposed && this.clearProcess(child, error)) {
        child.kill('SIGKILL');
      }
      throw error;
    }).finally(() => {
      if (this.starting?.child === child) {
        this.starting = null;
      }
    });
    this.starting = { child, result };
    return result;
  }

  private spawnProcess(): ChildProcess {
    const child = spawn(this.options.binaryPath, this.options.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this.options.env,
      windowsHide: true,
    });
    this.child = child;
    const stdin = child.stdin!;
    // KODE-RESP-009: the drain-aware FIFO writer stays as the write sink. The
    // library writes its own Content-Length header through the adapter below,
    // so backpressure (frame truly left the pipe) still gates notifyDrained
    // producers — no hand framing anywhere, bytes pass through untouched.
    this.frameWriter = new FrameWriter({
      write: frame => this.child !== child || !stdin.writable || stdin.destroyed || stdin.write(frame),
      // writableNeedDrain = the stream's own authoritative "a drain event is
      // pending" state; the writer consults this instead of a local flag so a
      // drain consumed between two writes cannot park the FIFO forever
      needDrain: () => this.child === child && stdin.writable && !stdin.destroyed && stdin.writableNeedDrain,
      once: (event, listener) => {
        if (stdin.destroyed) {
          queueMicrotask(listener);
        } else {
          stdin.once(event, listener);
        }
      },
      off: (event, listener) => { stdin.off(event, listener); },
    });
    const writer = new WriteableStreamMessageWriter(this.createDrainAwareWritable(stdin), {
      charset: 'utf-8',
      contentTypeEncoder: this.createBodyEncoder(),
    });
    // headerless-stream watchdog (diagnostic only; framing decisions stay
    // inside the library reader)
    const watchdog = this.createStdoutWatchdog();
    child.stdout!.on('data', (chunk: Buffer) => {
      if (this.child === child) { watchdog(chunk); }
    });
    const reader = new StreamMessageReader(child.stdout!, {
      charset: 'utf-8',
      contentTypeDecoder: this.createBodyDecoder(),
    });
    this.markFrameDecoded();
    const connection = createMessageConnection(reader, writer);
    this.connection = connection;
    connection.onNotification((method, params) => {
      if (this.child !== child) { return; }
      this.notificationHandler?.(params === undefined ? { method } : { method, params });
    });
    connection.listen();
    child.stderr!.on('data', (chunk: Buffer) => {
      if (this.child === child) { this.recordStderr(chunk); }
    });
    // stdin EPIPE (errno -32): there is a window between SIGKILL taking effect
    // and the exit event arriving, during which stdin.writable is still true and
    // a write into the dead pipe blows up the whole test process as an
    // unhandled 'error' event (recorded in CI #418). It must be swallowed here:
    // in-flight requests are rejected uniformly by the exit event's
    // rejectAll(EXITED), the waitFor probe retries naturally, and the
    // CORE-015/016 restart semantics are unchanged.
    child.stdin!.on('error', () => undefined);
    child.on('error', error => {
      const failure = new KodeCoreTransportError(`spawn failed: ${error.message}`, 'EXITED');
      if (this.clearProcess(child, failure)) {
        this.recordStderrLine(failure.message);
        this.emitLifecycle(failure.message);
      }
    });
    child.on('exit', (code, signal) => this.handleExit(child, code, signal));
    child.on('spawn', () => {
      if (this.child === child) { this.emitLifecycle(`spawned (pid ${child.pid ?? '?'})`); }
    });
    return child;
  }

  /**
   * KODE-RPC-LIB-001: RAL.WritableStream adapter over child.stdin that keeps
   * the RESP-009 drain-aware FIFO (FrameWriter) as the write sink. The library
   * hands each message here split into a header string ('ascii') and the
   * encoded body; both go through the FIFO in order and the returned promise
   * resolves only once the bytes truly left the pipe (drain waited when it
   * filled), so awaiting library writes = the old notifyDrained semantics.
   * No framing happens here — the library built the header.
   */
  private createDrainAwareWritable(stdin: NonNullable<ChildProcess['stdin']>): LibraryWritableStream {
    const frameWriter = (): FrameWriter => {
      // resolved lazily: clearProcess nulls the field on exit, and writes that
      // race the exit are dropped exactly like the old sendRaw did
      return this.frameWriter as FrameWriter;
    };
    return {
      onClose: listener => {
        if (stdin.destroyed) {
          queueMicrotask(listener);
          return Disposable.create(() => undefined);
        }
        stdin.once('close', listener);
        return Disposable.create(() => stdin.off('close', listener));
      },
      onError: listener => {
        stdin.once('error', listener);
        return Disposable.create(() => stdin.off('error', listener));
      },
      onEnd: listener => {
        stdin.once('end', listener);
        return Disposable.create(() => stdin.off('end', listener));
      },
      write: (data: Uint8Array | string, encoding?: 'ascii' | 'utf-8'): Promise<void> => {
        const frame =
          typeof data === 'string'
            ? Buffer.from(data, encoding ?? 'utf-8')
            : Buffer.isBuffer(data)
              ? data
              : Buffer.from(data);
        frameWriter()?.send(frame);
        return frameWriter()?.drained() ?? Promise.resolve();
      },
      end: () => {
        try {
          stdin.end();
        } catch {
          // already destroyed — nothing to end
        }
      },
    };
  }

  /**
   * JSON body codec handed to the library writer: serializes the message body
   * exactly as the old hand-rolled sendRaw did (compact JSON, utf-8) and
   * tallies outbound body bytes for rpcTraffic. The library owns the
   * Content-Length header; this codec never sees framing.
   */
  private createBodyEncoder(): ContentTypeEncoder {
    return {
      name: 'application/json',
      encode: (message: Message, options: ContentTypeEncoderOptions): Promise<Uint8Array> => {
        const body = Buffer.from(JSON.stringify(message), options.charset);
        this.rpcBytesOut += body.length;
        return Promise.resolve(body);
      },
    };
  }

  /**
   * JSON body codec handed to the library reader: tallies inbound body bytes
   * (same accounting as the old consumeStdout, before parse) and maps a
   * corrupt body to the historical `bad json frame body` diagnostic. The
   * channel stays alive: the library surfaces the parse failure via onError
   * without closing the connection.
   */
  private createBodyDecoder(): ContentTypeDecoder {
    return {
      name: 'application/json',
      decode: (buffer: Uint8Array, options: ContentTypeDecoderOptions): Promise<Message> => {
        const byteLength = buffer.byteLength;
        this.rpcBytesIn += byteLength;
        this.markFrameDecoded();
        const text = Buffer.from(buffer.buffer, buffer.byteOffset, byteLength).toString(options.charset);
        try {
          return Promise.resolve(JSON.parse(text) as Message);
        } catch {
          this.recordStderrLine(`bad json frame body: ${byteLength} bytes`);
          return Promise.reject(new Error(`bad json frame body: ${byteLength} bytes`));
        }
      },
    };
  }

  /**
   * Headerless-stream watchdog (KODE-RPC-LIB-001 parity): the old
   * consumeStdout dropped >64KB of bytes that never formed a parseable frame
   * header; the library reader never drops (it just keeps buffering — it is
   * designed for well-behaved peers). This tap only diagnoses: it counts raw
   * bytes since the last decodable frame, or since a `Content-Length:` sighting
   * (which proves a legal frame — possibly with a very large body — is in
   * flight), and records the `illegal frame stream` stderr line past the same
   * 64KB bound. No framing decisions are made here.
   */
  private createStdoutWatchdog(): (chunk: Buffer) => void {
    return (chunk: Buffer) => {
      if (this.watchdogHeaderSeen) {
        return;
      }
      this.watchdogBytes += chunk.length;
      this.watchdogTail = (this.watchdogTail + chunk.toString('latin1')).slice(-1024);
      if (/content-length:/i.test(this.watchdogTail)) {
        this.watchdogHeaderSeen = true;
        return;
      }
      if (this.watchdogBytes > ILLEGAL_STREAM_BYTES) {
        this.recordStderrLine(`illegal frame stream, ${this.watchdogBytes} bytes without a frame header`);
        this.watchdogBytes = 0;
      }
    };
  }

  /** watchdog progress signal: a framed body arrived (parse outcome irrelevant) */
  private markFrameDecoded(): void {
    this.watchdogBytes = 0;
    this.watchdogTail = '';
    this.watchdogHeaderSeen = false;
  }

  private clearProcess(child: ChildProcess, error: Error): boolean {
    if (this.child !== child) {
      return false;
    }
    this.child = null;
    this.starting = null;
    this.handshakeResult = null;
    this.frameWriter = null;
    const connection = this.connection;
    this.connection = null;
    if (connection) {
      try {
        connection.dispose();
      } catch {
        // already disposed/closed — nothing left to release
      }
    }
    this.rejectAll(error);
    return true;
  }

  /** LSP initialize handshake (CORE-002); restartGeneration is reconciled through
   * initializationOptions */
  private async initialize(child: ChildProcess): Promise<KodeCoreInitializeResult> {
    // RUST-TRACK-FREEZE-007 blade 1: take a generation snapshot — while the
    // handshake is in flight, if the process crashes and restarts, a late
    // old-generation handshake result must not be written into the new
    // generation's cache.
    const generation = this.restartGeneration;
    const params: KodeCoreInitializeParams = {
      ...this.initParams,
      initializationOptions: {
        ...(this.initParams.initializationOptions ?? {}),
        restartGeneration: this.restartGeneration,
      },
    };
    // KBUG-TIME-02: the handshake carries a budget (when alive but unresponsive,
    // start() rejects with TIMEOUT instead of hanging forever; the restart path's
    // handshake-failure semantics are unchanged and go through the existing
    // catch)
    const startTimeoutMs = this.options.startTimeoutMs ?? START_TIMEOUT_MS_DEFAULT;
    const result = (await this.request('initialize', params, {
      timeoutMs: startTimeoutMs
    })) as KodeCoreInitializeResult;
    // RUST-008 criterion (1): a protocol version mismatch means the two sides'
    // RPC shapes may not recognize each other, so the conversation is refused.
    // The child process is killed but the client is kept so it can spawn again —
    // once the versions line up (e.g. the user swapped the binary in place), the
    // next start() recovers naturally; the gate's existing catch classifies this
    // error into the TS fallback surface.
    const serverVersion = result.serverInfo?.version;
    if (serverVersion !== KODE_PROTOCOL_VERSION) {
      throw new KodeCoreTransportError(
        `protocol version mismatch: extension expects ${KODE_PROTOCOL_VERSION}, ` +
        `kode-server reports ${serverVersion ?? 'unknown'}`,
        'PROTOCOL_VERSION_MISMATCH'
      );
    }
    if (this.child === child && !this.disposed) {
      this.handshakeResult = result;
      this.handshakeGeneration = generation;
      this.emitLifecycle(`ready (generation ${generation}, server ${result.serverInfo?.version ?? '?'})`);
    }
    return result;
  }

  /** sends a request and waits for the response; on timeout it first sends
   * $/cancelRequest, then hard-times-out. An explicit opts.timeoutMs budget
   * takes priority; when omitted, DEFAULT_RPC_TIMEOUT_MS is the backstop
   * (2026-11-24 on-machine defect: in front of a wedged server, every
   * uncapped leg hangs — the direct-call legs rootAdded/scanComplete/
   * warmState and the like previously carried no budget, so with a wedged
   * server the whole index/jump chain ground to a halt). */
  request(method: string, params?: unknown, opts?: { timeoutMs?: number }): KodeCoreRequest {
    if (this.disposed) {
      return rejectedRequest(new KodeCoreTransportError('client disposed', 'DISPOSED'));
    }
    if (!this.child) {
      // restart given up / not started: fail immediately instead of letting the
      // request hang
      return rejectedRequest(
        new KodeCoreTransportError('server process not running', 'EXITED')
      );
    }
    const effectiveTimeoutMs = opts?.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
    const id = this.nextId++;
    // RUST-068-W: envelope-level span (the top-level spanId of `$/kode/rpc`;
    // a shallow copy that does not touch the caller's object, with inner params
    // passed as-is — zero awareness for the worker handler contract). Other
    // methods do not get it injected (the standard LSP surface stays
    // unpolluted; trace lines still carry the span for end-to-end
    // reconciliation).
    const span = newSpanId();
    let wireParams = params;
    if (method === '$/kode/rpc') {
      wireParams =
        params !== null && typeof params === 'object' && !Array.isArray(params)
          ? { ...(params as Record<string, unknown>), spanId: span }
          : params;
    }
    this.trace(`request ${id} ${method} send (span=${span})`);
    const tokenSource = new CancellationTokenSource();
    const promise = new Promise<unknown>((resolve, reject) => {
      // hard timeout: a backstop rejection for when the server still hasn't
      // answered after the cancel (hung)
      let hardTimer: NodeJS.Timeout | undefined;
      let cancelTimer: NodeJS.Timeout | undefined;
      if (effectiveTimeoutMs > 0) {
        cancelTimer = setTimeout(() => this.cancelRequest(id), effectiveTimeoutMs);
        hardTimer = setTimeout(() => {
          clearTimeout(cancelTimer);
          this.pending.delete(id);
          reject(new KodeCoreTransportError(`${method} timed out after ${effectiveTimeoutMs}ms`, 'TIMEOUT'));
        }, effectiveTimeoutMs + 2000);
      }
      this.pending.set(id, {
        resolve: value => {
          if (hardTimer) {
            clearTimeout(hardTimer);
          }
          // CORE-2: once the request completes normally, clear cancelTimer
          // as well, avoiding a late $/cancelRequest notification for an
          // already-completed id
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
        tokenSource,
      });
    }) as KodeCoreRequest;
    this.dispatchRequest(id, method, wireParams, tokenSource);
    // the cancel handle rides on the promise: callers never need to know the
    // internal numeric id
    promise.cancel = () => this.cancelRequest(id);
    return promise;
  }

  /**
   * KODE-RPC-LIB-001: hands the request to the library connection and routes
   * the outcome back into the pending entry. The library owns framing, wire
   * ids, response correlation and $/cancelRequest emission (via the
   * cancellation token); the entry carries only our trace id, span, timers and
   * the token handle. params shapes hit the wire byte-for-byte as the old
   * sendRaw did: omitted when undefined (no params argument), passed through
   * as-is when an object (ParameterStructures.auto leaves object literals
   * untouched).
   */
  private dispatchRequest(id: number, method: string, params: unknown, tokenSource: CancellationTokenSource): void {
    const entry = (): PendingRequest | undefined => this.pending.get(id);
    const connection = this.connection;
    if (!connection) {
      // exit race: the process died between the running-process guard and the
      // dispatch
      entry()?.reject(new KodeCoreTransportError(`server exited before ${method} was sent`, 'EXITED'));
      return;
    }
    let libPromise: Promise<unknown>;
    try {
      libPromise =
        params === undefined
          ? connection.sendRequest(method, tokenSource.token)
          : connection.sendRequest(method, params, tokenSource.token);
    } catch (error) {
      // connection already closed/disposed (exit race window): the library
      // throws synchronously instead of rejecting
      entry()?.reject(new KodeCoreTransportError(`${method} not sent: ${(error as Error).message}`, 'EXITED'));
      return;
    }
    libPromise.then(
      value => {
        // settle = leave the map, exactly as the old dispatchMessage did;
        // a late library settle after the hard timer finds no entry and is
        // ignored
        const pending = entry();
        this.pending.delete(id);
        if (pending) {
          this.trace(`request ${id} ${pending.method} done (span=${pending.span})`);
          pending.resolve(value);
        }
      },
      error => {
        const pending = entry();
        this.pending.delete(id);
        const code = error instanceof ResponseError ? error.code : undefined;
        if (pending) {
          // RUST-068-W: leave a trace on the error face (cancellations and
          // server errors both carry the same span)
          this.trace(`request ${id} ${pending.method} failed ${code ?? 'unknown'} (span=${pending.span})`);
          pending.reject(this.toTransportError(method, code, error));
        }
      }
    );
  }

  /** maps a library sendRequest rejection onto the transport error face
   * (REQUEST_CANCELLED for the JSON-RPC -32800 cancellation code) */
  private toTransportError(method: string, code: number | undefined, error: unknown): KodeCoreTransportError {
    const message = error instanceof Error ? error.message : String(error);
    if (code === -32800) {
      return new KodeCoreTransportError(`${method} failed (-32800): ${message}`, 'REQUEST_CANCELLED');
    }
    return new KodeCoreTransportError(
      `${method} failed (${code ?? 'unknown'}): ${message}`,
      'SERVER_ERROR'
    );
  }

  /** sends a notification (no response; failures do not throw) */
  notify(method: string, params?: unknown): void {
    if (this.disposed) {
      return;
    }
    this.sendNotificationNow(method, params);
  }

  /**
   * fire-and-forget notification that bypasses the disposed guard (the dispose
   * path sends `exit` after disposed=true, mirroring the old sendRaw which had
   * no disposed check either). Write failures (exit race EPIPE window) are
   * swallowed; failure semantics belong to the exit path's uniform rejection.
   */
  private sendNotificationNow(method: string, params?: unknown): void {
    const connection = this.connection;
    if (!connection) {
      return;
    }
    const send =
      params === undefined ? connection.sendNotification(method) : connection.sendNotification(method, params);
    send.catch(() => undefined);
  }

  /**
   * KODE-RESP-009: the notification is enqueued and awaited until this frame is
   * written (drain-aware) — awaiting it on the producer side is backpressure;
   * frame order stays FIFO (first enqueued, first written, without breaking
   * the relative order against requests).
   */
  private async notifyDrained(method: string, params?: unknown): Promise<void> {
    if (this.disposed) {
      return;
    }
    const connection = this.connection;
    if (!connection) {
      return;
    }
    try {
      // resolves once the library writer flushed the whole frame through the
      // drain-aware adapter (headers + body written, drain waited when the
      // pipe filled) — the RESP-009 backpressure face, unchanged
      await (params === undefined
        ? connection.sendNotification(method)
        : connection.sendNotification(method, params));
    } catch {
      // write failure (exit race EPIPE window): swallowed, like the old
      // FrameWriter chain; the exit path rejects in-flight requests uniformly
    }
  }

  /** cancels an in-flight request (CORE-007 minimal version: a
   * $/cancelRequest notification) */
  cancelRequest(id: number): void {
    const pending = this.pending.get(id);
    this.trace(`request ${id} cancel sent (span=${pending?.span ?? '-'})`);
    // the library turns the token into a $/cancelRequest notification for the
    // wire id it assigned; after the response arrived its listener is gone, so
    // a late cancel sends nothing (CORE-2)
    pending?.tokenSource.cancel();
  }

  /** health probe (CORE-016) */
  async health(): Promise<KodeCoreHealth> {
    return (await this.request('$/kode/health')) as KodeCoreHealth;
  }

  /**
   * KODE-RESP-009: the document notification is enqueued and only completes once
   * this frame is truly written (waiting for drain when needed) — awaiting each
   * frame on the corpus mirror producer side is rate-limited by pipe backpressure,
   * and the client buffer has a hard upper bound; the old fire-and-forget write
   * pushed frames without limit into Node's internal stream buffer on a slow
   * consumer. Callers that do not await (the editor stream's fire-and-forget
   * mirroring) keep their semantics unchanged (enqueue only).
   */
  openDocument(uri: string, languageId: string, version: number, text: string): Promise<void> {
    return this.notifyDrained('textDocument/didOpen', {
      textDocument: { uri, languageId, version, text },
    });
  }

  changeDocument(uri: string, version: number, text: string): Promise<void> {
    return this.notifyDrained('textDocument/didChange', {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
  }

  closeDocument(uri: string): Promise<void> {
    return this.notifyDrained('textDocument/didClose', { textDocument: { uri } });
  }

  /**
   * RUST-069-W root lifecycle: adds a root registration (idempotent —
   * re-registering the same path returns the existing id). The request surface
   * carries a receipt (the root id), so wiring/tests can assert root identity.
   */
  async addWorkspaceRoot(fsPath: string): Promise<{ root: number }> {
    return (await this.request('$/kode/workspace/rootAdded', { path: fsPath })) as {
      root: number;
    };
  }

  /**
   * RUST-069-W root lifecycle: root removal — the server side unregisters it and
   * fans out shared-cache cleanup (mirrors/symbols/parse candidates); for a
   * registered root the receipt carries each consumer surface's cleared count
   * (document-store / hover-engine, in registration order); an unknown root
   * yields removed:false (no fan-out).
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
   * RUST-074-W warm gate: first scan begins — the server-side keyed state
   * machine is enqueued (Warming). An in-progress scan is reused (same
   * scanId); after a failure/cancellation it reopens with decision=recovered.
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

  /** RUST-074-W warm gate: first scan finished — pumps to Warm; with no
   * in-progress first scan it answers -32602 (a late receipt) */
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

  /** RUST-074-W warm gate: first scan cancelled (a mirror interruption) — goes
   * back to Idle without leaving a false pending; idempotent */
  async scanCancel(): Promise<{ state: string }> {
    return (await this.request('$/kode/index/scanCancel')) as { state: string };
  }

  /** RUST-074-W warm gate: warm-state observation
   * (state/coldWhileWarming/done/failed/total) */
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

  /** graceful stop: shutdown -> exit -> SIGKILL after a grace period; in-flight
   * requests are rejected with DISPOSED */
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
    // CORE-1 hang path 1: the shutdown reply originally had no timeout, so with
    // a server alive but hung (handler infinite loop / backpressure) dispose
    // hung forever and the exit/KILL cleanup after it was never reached.
    // Wrapped in a timeout: timing out means hung, so SIGKILL directly; the
    // rawRequest promise itself keeps a catch attached, so a late rejectAll from
    // an exit race does not turn into an unhandled rejection.
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
      // continue to exit/kill even if the server is already dead; if hung,
      // SIGKILL immediately instead of waiting out the grace period
      if (shutdownTimedOut && child.exitCode === null) {
        child.kill('SIGKILL');
      }
    }
    this.sendNotificationNow('exit');
    const exited = new Promise<void>(resolve => {
      // CORE-1 hang path 2: if the child process exited on its own during the
      // shutdown wait (handleExit already consumed the exit event and set
      // child=null), once('exit') registered on a process whose event already
      // fired never triggers — complete directly via the exitCode/signalCode
      // guard, so the trailing `await exited` cannot hang forever (leaking an
      // orphaned child process).
      if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
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

  // -- internal --------------------------------------------------------------

  private rawRequest(method: string, params?: unknown): Promise<unknown> {
    // the dispose path bypasses the disposed check
    const id = this.nextId++;
    const span = newSpanId();
    this.trace(`request ${id} ${method} send (span=${span})`);
    const tokenSource = new CancellationTokenSource();
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method, span, tokenSource });
    });
    this.dispatchRequest(id, method, params, tokenSource);
    return promise;
  }

  private recordStderr(chunk: Buffer): void {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (line.trim()) {
        this.recordStderrLine(line);
      }
    }
  }

  /** RUST-068-W: client trace line (the onTrace callback; discarded by default) */
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

  /** lifecycle evidence line (WARM-VISIBILITY-004 blade B: the kode-server
   * liveness heartbeat goes into the unified channel) */
  private emitLifecycle(line: string): void {
    this.options.onLifecycle?.(line);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  /** unexpected exit: automatic respawn + re-handshake within the restart
   * window; beyond it, give up (CORE-015) */
  private handleExit(child: ChildProcess, code: number | null, signal: string | null): void {
    if (!this.clearProcess(child, new KodeCoreTransportError(`server exited (code=${code}, signal=${signal})`, 'EXITED'))) {
      return;
    }
    this.emitLifecycle(`exit (code=${code ?? '?'}, signal=${signal ?? '?'})`);
    if (this.disposed) {
      return;
    }
    const windowMs = this.options.restart?.windowMs ?? RESTART_WINDOW_MS_DEFAULT;
    const maxRestarts = this.options.restart?.maxRestarts ?? RESTART_MAX_DEFAULT;
    const now = Date.now();
    this.restartTimestamps = this.restartTimestamps.filter(ts => now - ts < windowMs);
    if (this.restartTimestamps.length >= maxRestarts) {
      this.recordStderrLine(`restart limit reached (${maxRestarts} in ${windowMs}ms), giving up`);
      this.emitLifecycle(`restart limit reached (${maxRestarts} in ${windowMs}ms), giving up`);
      return;
    }
    this.restartTimestamps.push(now);
    this.restartGeneration += 1;
    this.recordStderrLine(`restarting server (generation ${this.restartGeneration})`);
    this.emitLifecycle(`restarting server (generation ${this.restartGeneration})`);
    const generation = this.restartGeneration;
    this.start()
      .then(() => {
        if (this.restartGeneration === generation && !this.disposed) {
          this.options.onRestart?.(generation);
        }
      })
      .catch(error => {
        const message = `restart handshake failed: ${(error as Error).message}`;
        this.recordStderrLine(message);
        this.emitLifecycle(message);
      });
  }
}
