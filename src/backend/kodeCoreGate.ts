import {
  KodeCoreClient,
  KodeCoreTransportError,
  type KodeCoreInitializeParams,
  type ServerNotificationMessage
} from './kodeCoreClient';
import { KODE_FILE_CHANGED_METHOD } from './fileChangeBypass';
import {
  noteInteractiveStartupFailure,
  resetInteractiveCircuit,
  resetInteractiveCircuitForManualRestart
} from './kodeCoreShadowFaces';
import { indexLog } from './indexLog';

// kode2 PR-012: dual-track switchover gate (kill-switch / shadow / diff log).
// 2026-11-08 user order "switch straight to rust": the serving gate is lifted
// and the rust literal takes effect as the serving track (serveFromRust=true),
// with the TS implementation retained as the failure/missing-binary fallback.
// This module does only three things:
//   1. parse the kbengine.core.backend switch (ts|rust|shadow, default rust;
//      any illegal value falls back to ts — the kill-switch is always
//      recoverable);
//   2. rust literal = serving track: serveFromRust() returns true once
//      serverPath is configured, and the provider takes gate.serveInRust() for
//      the Rust result, falling back to TS on failure; when serverPath is not
//      configured (including a discovery miss) it falls back to ts, leaving a
//      notice on record;
//   3. in shadow mode compare() mirrors the same-param request to the Rust
//      server for a short-timeout comparison; any Rust-side failure only
//      records a diff log entry, and compare always returns the TS result
//      as-is (shadow comparison only in shadow mode; the rust serving track
//      does not go through compare).

export type KodeBackendMode = 'ts' | 'rust' | 'shadow';

/** shadow comparison verdict: the three failure kinds beyond match/diff all
 * belong to the rust side and never change serving */
export type ShadowVerdict = 'match' | 'diff' | 'rust-error' | 'rust-timeout' | 'rust-unavailable';

/** Single diff-log entry: seq increments monotonically; verdict tallying is
 * documented on ShadowVerdict */
export interface ShadowDiffEntry {
  seq: number;
  timestamp: string;
  method: string;
  uri?: string;
  verdict: ShadowVerdict;
  /** diff case: first divergent path plus both sides' truncated values; on
   * failure: an error summary */
  detail?: string;
}

export interface KodeCoreGateConfig {
  /** raw kbengine.core.backend string (possibly illegal) */
  backend: string;
  /** path to the kode-server binary; empty = rust unavailable */
  serverPath: string;
  /** shadow mirror request timeout in milliseconds (default 2000) */
  shadowTimeoutMs: number;
}

export const DEFAULT_CORE_GATE_CONFIG: KodeCoreGateConfig = {
  // 2026-11-08 user order: the default serving track switches straight to rust
  // (falls back to ts when serverPath is unconfigured, so a missing binary
  // does no harm). kill-switch = backend:ts.
  backend: 'rust',
  serverPath: '',
  shadowTimeoutMs: 2000,
};

/** spawn-failure retry cooldown (milliseconds): stops high-frequency provider
 * queries from turning a failure into a storm */
const SPAWN_COOLDOWN_MS = 30_000;

/**
 * command-level RPC default timeout (2026-11-24 on-machine defect): runInRust
 * previously passed no timeout, so the transport layer started no timer and
 * waited forever — with the server wedged/slow, each def first-scan entity's
 * $/kode/python/symbols call burned ~10s, and 21 entities stretched to 241s.
 * Every command-level RPC is now capped; callers that genuinely need a longer
 * or shorter budget pass timeoutMs explicitly.
 */
export const COMMAND_RPC_TIMEOUT_MS_DEFAULT = 10_000;
/**
 * command-leg circuit-breaker threshold: once consecutive timeouts (with no
 * successes in between) hit this point, the circuit opens and later runInRust
 * calls pass through ok:false for the caller to fall back to TS (same judging
 * as the interactive leg: a timeout = server wedged signal, retrying won't
 * help; non-timeout failures are not counted — spawn/exit hard failures fall
 * back quickly anyway, and explicit user commands should not be blocked
 * permanently). Reset = process replacement (stopClient/restartCore/
 * automatic-restart reconciliation); a new process is a new chance for
 * success.
 */
export const COMMAND_TRIP_THRESHOLD = 3;

/**
 * kill-switch parsing: only the 'shadow' and 'rust' literals change the mode;
 * anything else (including undefined/empty/misspelled) falls back to 'ts' —
 * when the switch misbehaves, the safe side is TS truth.
 * 'rust' = serving track (2026-11-08 user order "switch straight", serving
 * gate lifted); rustServingGated is retained as an observation field and is
 * now permanently false (the gate is off).
 */
export function resolveBackendMode(rawBackend: string | undefined): {
  mode: KodeBackendMode;
  rustServingGated: boolean;
} {
  if (rawBackend === 'shadow') {
    return { mode: 'shadow', rustServingGated: false };
  }
  if (rawBackend === 'rust') {
    return { mode: 'rust', rustServingGated: false };
  }
  return { mode: 'ts', rustServingGated: false };
}

/** probeHealth outcome: reason = the original error word from the fast-failure
 * arm; the budget-exhausted arm (suspected hang) leaves it absent */
export interface CoreHealthProbeOutcome {
  ok: boolean;
  latencyMs: number;
  reason?: string;
}

/** Canonicalize: objects are compared with keys sorted (arrays keep their
 * order), masking away serialization key-order differences */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0
    );
    const out: Record<string, unknown> = {};
    for (const [key, item] of entries) {
      out[key] = canonicalize(item);
    }
    return out;
  }
  return value;
}

function truncate(text: string, max = 80): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** Whether a mirror-ledger key falls under the withdrawn root (the key may be
 * an fsPath or a file:// URI; prefix judgment, the same semantics as the
 * server-side root_for longest-prefix; /ws must not touch /wsX) */
export function uriUnderRoot(uri: string, fsPath: string): boolean {
  const plain = uri.startsWith('file://') ? uri.slice('file://'.length) : uri;
  return plain === fsPath || plain.startsWith(`${fsPath}/`);
}

function preview(value: unknown): string {
  try {
    return truncate(JSON.stringify(value) ?? String(value));
  } catch {
    return truncate(String(value));
  }
}

/** First divergent path ('$' is the root; objects take keys, arrays take
 * indexes); returns null when the two values agree */
export function firstDiffPath(tsValue: unknown, rustValue: unknown, path = '$'): string | null {
  const canonicalTs = canonicalize(tsValue);
  const canonicalRust = canonicalize(rustValue);
  if (canonicalTs === canonicalRust) {
    return null;
  }
  const walk = (a: unknown, b: unknown, p: string): string | null => {
    if (a === b) {
      return null;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) {
        return `${p}.length(${a.length}≠${b.length})`;
      }
      for (let i = 0; i < a.length; i += 1) {
        const found = walk(a[i], b[i], `${p}[${i}]`);
        if (found) {
          return found;
        }
      }
      return null;
    }
    if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
      const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
      for (const key of keys) {
        const found = walk(
          (a as Record<string, unknown>)[key],
          (b as Record<string, unknown>)[key],
          `${p}.${key}`
        );
        if (found) {
          return found;
        }
      }
      return null;
    }
    return p;
  };
  return walk(canonicalTs, canonicalRust, path);
}

/** Diff log: bounded ring (default 500 entries), subscribable (consumed by
 * the output channel) */
export class ShadowDiffLog {
  private seq = 0;
  private readonly items: ShadowDiffEntry[] = [];
  private readonly listeners = new Set<(entry: ShadowDiffEntry) => void>();

  constructor(private readonly limit = 500) {}

  record(entry: Omit<ShadowDiffEntry, 'seq' | 'timestamp'>, now = new Date()): ShadowDiffEntry {
    this.seq += 1;
    const full: ShadowDiffEntry = { ...entry, seq: this.seq, timestamp: now.toISOString() };
    this.items.push(full);
    if (this.items.length > this.limit) {
      this.items.splice(0, this.items.length - this.limit);
    }
    for (const listener of this.listeners) {
      listener(full);
    }
    return full;
  }

  entries(): readonly ShadowDiffEntry[] {
    return this.items;
  }

  summary(): { total: number; match: number; diff: number; failure: number } {
    let match = 0;
    let diff = 0;
    let failure = 0;
    for (const item of this.items) {
      if (item.verdict === 'match') {
        match += 1;
      } else if (item.verdict === 'diff') {
        diff += 1;
      } else {
        failure += 1;
      }
    }
    return { total: this.items.length, match, diff, failure };
  }

  clear(): void {
    this.items.length = 0;
  }

  subscribe(listener: (entry: ShadowDiffEntry) => void): { dispose(): void } {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }
}

/** the client surface compare() needs (a KodeCoreClient subset; tests may
 * inject a stand-in) */
export interface ShadowClientLike {
  start(): Promise<unknown>;
  request(
    method: string,
    params?: unknown,
    opts?: { timeoutMs?: number }
  ): Promise<unknown>;
  dispose(): Promise<void>;
  /** corpus mirror leg (Phase2 first slice): document open/change/close,
   * notify semantics with no reply. KODE-RESP-009: the return value may be a
   * Promise (it completes only when the frame is truly written and drained) —
   * awaiting it on the mirroring producer side is write backpressure; a
   * synchronous implementation (test stand-in) satisfies it the same way
   * (no waiting). */
  openDocument?(uri: string, languageId: string, version: number, text: string): void | Promise<void>;
  changeDocument?(uri: string, version: number, text: string): void | Promise<void>;
  closeDocument?(uri: string): void | Promise<void>;
  /** restart-generation read port (E-2; optional): after an automatic
   * restart the gate resets the mirror ledger and replays snapshots */
  getRestartGeneration?(): number;
  /** notification surface (optional per §11.3): one-way notifications, no
   * reply; same-named method on KodeCoreClient */
  notify?(method: string, params?: unknown): void;
  /** root lifecycle (RUST-069-W, optional): add/remove workspace roots, the
   * request surface carries a receipt */
  addWorkspaceRoot?(fsPath: string): Promise<unknown>;
  removeWorkspaceRoot?(fsPath: string): Promise<unknown>;
  /** warm gate (RUST-074-W, optional): first-scan state machine
   * begin/complete/cancel, the request surface carries a receipt */
  beginBackgroundScan?(total: number): Promise<unknown>;
  scanComplete?(done: number, failed: number): Promise<unknown>;
  scanCancel?(): Promise<unknown>;
  /** server-notification consumer surface (RUST-142, optional): the gate wires
   * it lazily, so it can be set again after the client is built on demand */
  setNotificationHandler?(
    handler: ((notification: ServerNotificationMessage) => void) | null
  ): void;
}

export interface KodeCoreGateOptions {
  /** defaults to new KodeCoreClient({ binaryPath: serverPath }) */
  clientFactory?: (serverPath: string) => ShadowClientLike;
  diffLog?: ShadowDiffLog;
  now?: () => number;
}

/** gate state snapshot (read for observability / fallback drill criteria) */
export interface KodeCoreGateState {
  mode: KodeBackendMode;
  /** effective serving track: 'rust' on the rust serving track
   * (serveFromRust); 'shadow' in shadow mode; 'ts' otherwise */
  servingMode: 'ts' | 'shadow' | 'rust';
  rustServingGated: boolean;
  serverPath: string;
  clientAlive: boolean;
  notices: readonly string[];
}

export class KodeCoreGate {
  readonly diffLog: ShadowDiffLog;
  private config: KodeCoreGateConfig = { ...DEFAULT_CORE_GATE_CONFIG };
  private client: ShadowClientLike | null = null;
  private clientServerPath = '';
  /** initialize handshake parameters (KBUG-ROOT: multi workspace folder root
   * attribution); unset = default parameters */
  private initializeParams: KodeCoreInitializeParams | undefined;
  /** server-notification consumer surface (RUST-142 wiring): passed through when
   * the client is built lazily; if the client already exists (late wiring after
   * ensureClient) it is re-attached immediately; null = no consumer
   * (notifications dropped). */
  private notificationHandler: ((notification: ServerNotificationMessage) => void) | null = null;
  private nextAttemptAt = 0;
  /** corpus mirror ledger: uri -> mirrored version (within the shadow session;
   * cleared by the kill-switch) */
  private mirroredVersions = new Map<string, number>();
  /** corpus snapshots: uri -> most recently mirrored content (the basis for
   * restart replay; dropped when the document closes; cleared by kill-switch) */
  private mirrorSnapshots = new Map<
    string,
    { languageId: string; version: number; text: string }
  >();
  /** registered-root ledger (RUST-069-W): the fsPath set — the basis for
   * re-registration during restart replay; cleared by the kill-switch */
  private registeredRoots = new Set<string>();
  /** last observed restart generation (null = not yet reconciled; a change
   * means an automatic restart) */
  private lastRestartGeneration: number | null = null;
  /** command-leg circuit ledger: consecutive timeout count (cleared on any
   * success) and the open flag (reset on process replacement) */
  private commandTimeoutStreak = 0;
  private commandCircuitOpen = false;
  private readonly notices: string[] = [];
  private readonly now: () => number;
  private readonly options: KodeCoreGateOptions;

  constructor(options: KodeCoreGateOptions = {}) {
    this.diffLog = options.diffLog ?? new ShadowDiffLog();
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  /** applies a new config; leaving the mirror track (ts kill-switch) or
   * swapping the binary stops the Rust process */
  /**
   * initialize handshake parameters (KBUG-ROOT root attribution): stored only;
   * client instances created afterwards carry them in their handshake (the same
   * holds when an automatic restart rebuilds them). The wiring path calls this
   * before the first ensureClient; an already-live client is not restarted
   * because of it.
   */
  setInitializeParams(params: KodeCoreInitializeParams): void {
    this.initializeParams = params;
  }

  /** server-notification consumer surface (RUST-142): store first, attach
   * second (re-attach immediately if the client already exists; pass through
   * when it is built lazily). */
  setNotificationHandler(
    handler: ((notification: ServerNotificationMessage) => void) | null
  ): void {
    this.notificationHandler = handler;
    this.client?.setNotificationHandler?.(handler);
  }

  setConfig(config: KodeCoreGateConfig): void {
    const previous = this.config;
    this.config = { ...config };
    const stillMirroring = this.shouldMirrorCorpus();
    if (!stillMirroring || previous.serverPath !== config.serverPath) {
      this.stopClient();
    }
    if (this.mode === 'rust' && !this.config.serverPath) {
      this.noticeOnce(
        'kbengine.core.backend=rust 但 kbengine.core.serverPath 未配置(自动发现未命中 kode-server 二进制),服务轨道回落 ts'
      );
    }
  }

  /** resolved mode (the rust literal keeps its original value for observation) */
  get mode(): KodeBackendMode {
    return resolveBackendMode(this.config.backend).mode;
  }

  /** effective serving track: 'rust' on the rust serving track (serveFromRust);
   * 'shadow' in shadow mode; 'ts' otherwise */
  get servingMode(): 'ts' | 'shadow' | 'rust' {
    if (this.mode === 'shadow') {
      return 'shadow';
    }
    return this.serveFromRust() ? 'rust' : 'ts';
  }

  /** whether corpus mirroring is needed: both shadow comparison and the rust
   * serving track require the Rust side to hold the corpus */
  private shouldMirrorCorpus(): boolean {
    return this.mode === 'shadow' || this.serveFromRust();
  }

  get rustServingGated(): boolean {
    return resolveBackendMode(this.config.backend).rustServingGated;
  }

  get state(): KodeCoreGateState {
    return {
      mode: this.mode,
      servingMode: this.servingMode,
      rustServingGated: this.rustServingGated,
      serverPath: this.config.serverPath,
      clientAlive: this.client !== null,
      notices: [...this.notices],
    };
  }

  /**
   * serving pass-through (2026-11-08 user order "switch straight to rust"): the
   * rust literal with serverPath configured (a discovery miss/blank = fall back
   * to ts, so a missing binary does no harm). kill-switch = backend:ts, and
   * switching back stops the Rust process (an invisible rollback for the user).
   */
  serveFromRust(): boolean {
    return this.mode === 'rust' && this.config.serverPath !== '';
  }

  /**
   * `$/kode/fileChanged` notification (hot-reload bypass surface, §11.3):
   * forwards non-py file changes to rust parsing on demand. It **does not
   * spawn a process to send a notification** — only an already-live client sends;
   * unstarted/unavailable always degrades silently to false (no error, no
   * blocking of hot reload), matching LSP's forward-compatibility stance of
   * "silently dropping unknown notifications".
   */
  notifyFileChanged(params: unknown): boolean {
    const client = this.client;
    if (!client?.notify) {
      return false;
    }
    try {
      client.notify(KODE_FILE_CHANGED_METHOD, params);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * RUST-131-W: production file events (workspace/didRenameFiles, workspace/
   * didDeleteFiles) go straight to rust — invalidating the old URI's symbol/
   * parse caches and pending refreshes (the no-resurrecting-late-stale-tasks
   * rule), and re-reading the rename side's new URI from disk at execution time.
   * Moves/deletes of not-opened dependents are covered by this surface
   * (didOpen/didClose only cover open buffers). Same stance as notifyFileChanged:
   * only an already-live client sends; unstarted/unavailable return false
   * silently (no process is spawned just to send a notification).
   */
  notifyWorkspaceFileEvent(
    method: 'workspace/didRenameFiles' | 'workspace/didDeleteFiles',
    params: unknown
  ): boolean {
    const client = this.client;
    if (!client?.notify) {
      return false;
    }
    try {
      client.notify(method, params);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * command-level Rust invocation (user-initiated commands such as generation /
   * message tables / lint): brings the client up on demand, wraps the request
   * as a single `$/kode/rpc { method, params }` call, returns ok:true on
   * success, and ok:false (with a reason) on any failure so the caller falls
   * back to the TS path.
   * Orthogonal to the serving surface: it does not touch serveFromRust (which
   * is still permanently false), does not depend on shadow mode, and does not
   * depend on mirrored corpus (params are passed straight by the caller). Process
   * lifetime is left to teardown (kill-switch/config-change stopClient);
   * consecutive commands reuse the same process and do not re-spawn.
   */
  async runInRust<T = unknown>(
    method: string,
    params?: unknown,
    opts?: { timeoutMs?: number }
  ): Promise<{ ok: true; result: T } | { ok: false, reason: string }> {
    // circuit open: pass through to fallback (the caller takes TS) instead of
    // spawning a process to burn budget for nothing
    if (this.commandCircuitOpen) {
      return {
        ok: false,
        reason: 'rust command circuit open: consecutive timeouts (server wedging?), ts fallback'
      };
    }
    if (!this.config.serverPath) {
      return { ok: false, reason: 'no serverPath' };
    }
    const client = this.ensureClient();
    if (!client) {
      return { ok: false, reason: 'client unavailable' };
    }
    try {
      await client.start();
      const timeoutMs = opts?.timeoutMs ?? COMMAND_RPC_TIMEOUT_MS_DEFAULT;
      const result = (await client.request('$/kode/rpc', { method, params }, { timeoutMs })) as T;
      this.commandTimeoutStreak = 0;
      return { ok: true, result };
    } catch (error) {
      if ((error as { code?: string }).code === 'TIMEOUT') {
        this.commandTimeoutStreak += 1;
        if (this.commandTimeoutStreak >= COMMAND_TRIP_THRESHOLD) {
          this.commandCircuitOpen = true;
          this.noticeOnce(
            `rust 命令级 RPC 连续超时 ${this.commandTimeoutStreak} 次,熔断开放(本进程周期内命令走 TS 回落;重启 Core 复位)`
          );
        }
      }
      return { ok: false, reason: (error as Error).message };
    }
  }

  /** current state of the command-leg circuit (for diagnostics/tests) */
  commandCircuitState(): { open: boolean; timeoutStreak: number } {
    return { open: this.commandCircuitOpen, timeoutStreak: this.commandTimeoutStreak };
  }

  /**
   * health probe (2026-11-24 health-light batch): ensureClient -> start ->
   * `$/kode/health`, with the whole probe body racing against the timeoutMs
   * budget — when the server process is wedged, start() itself can hang
   * (START_TIMEOUT_MS is on the order of 10s), so the probe must answer on
   * time unconditionally. Any failure reports ok:false honestly. Passive read
   * port: it does not count toward the circuit streak and raises no notice
   * (liveness judgment is an observation surface, not a failure surface, and
   * drives no fallback decision). reason = the original error word from the
   * fast-failure arm (TIMEOUT/EXITED/raw spawn message); on the
   * budget-exhausted arm reason is absent = undecided within the budget
   * (suspected hang).
   */
  async probeHealth(timeoutMs = 2_000): Promise<CoreHealthProbeOutcome> {
    if (this.mode === 'ts' || !this.config.serverPath) {
      return { ok: false, latencyMs: 0 };
    }
    const now = this.options.now ?? (() => Date.now());
    const started = now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<CoreHealthProbeOutcome>(resolve => {
      timer = setTimeout(() => resolve({ ok: false, latencyMs: now() - started }), timeoutMs);
    });
    const outcome = (async () => {
      const client = this.ensureClient();
      if (!client) {
        throw new Error('client unavailable');
      }
      await client.start();
      await client.request('$/kode/health', undefined, { timeoutMs });
    })();
    try {
      return await Promise.race([
        outcome.then(
          () => ({ ok: true, latencyMs: now() - started }),
          (error: unknown) => ({
            ok: false as const,
            latencyMs: now() - started,
            reason: String((error as Error | undefined)?.message ?? error).slice(0, 160),
          })
        ),
        budget,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * serving surface (2026-11-08 user order "switch straight"): on the Rust
   * serving track, LSP methods (textDocument/definition and the like) go
   * straight to kode-server and the Rust result is returned; any Rust-side
   * failure (missing serverPath/start failure/request failure/timeout) returns
   * the fallback — the provider uses it to take the TS implementation, so the
   * user-visible behavior matches ts mode (iron rule: a Rust failure must never
   * harm serving). Off the serving track it passes straight through to the
   * fallback at zero cost. Command-level $/kode/rpc uses runInRust; this
   * surface is exclusively for LSP serving methods.
   */
  async serveInRust<T>(
    method: string,
    params: unknown,
    fallback: T,
    opts?: { timeoutMs?: number }
  ): Promise<T> {
    if (!this.serveFromRust()) {
      return fallback;
    }
    const client = this.ensureClient();
    if (!client) {
      this.noticeOnce(`rust 服务不可用(${method}): client 创建失败,回落 ts`);
      return fallback;
    }
    // P1-4: the start leg is accounted for independently. A start failure was
    // previously bucketed with request failures and turned into an ordinary
    // fallback — the budget wrapper (awaitWithInteractiveBudget) logged it as
    // a success, so a start failure could never trip the circuit. Now it is
    // recorded honestly as a transport-level hard failure (still falling back to
    // ts, without harming serving).
    try {
      await client.start();
    } catch (error) {
      // P1 (review 2026-11-24): a start failure is only recorded for the current
      // client. A pending old client rejects only after a restart/config change,
      // so its failure belongs to a dead session — accounting for it
      // unconditionally would open the new session's circuit and make the next
      // interaction pass straight through as null.
      if (this.client === client) {
        noteInteractiveStartupFailure();
        this.noticeOnce(`rust 服务启动失败(${method}): ${(error as Error).message},回落 ts`);
      }
      return fallback;
    }
    // Same window: the client was replaced while start was pending (restart /
    // serverPath change), so this frame must not drive the old client any more
    // (syncRestartGeneration would roll the circuit generation back to the old
    // one, and the request would hit an already-disposed process).
    if (this.client !== client) {
      return fallback;
    }
    try {
      this.syncRestartGeneration(client);
      return (await client.request(method, params, opts)) as T;
    } catch (error) {
      this.noticeOnce(`rust 服务失败(${method}): ${(error as Error).message},回落 ts`);
      return fallback;
    }
  }

  private noticeOnce(text: string): void {
    if (!this.notices.includes(text)) {
      this.notices.push(text);
      if (this.notices.length > 20) {
        this.notices.shift();
      }
    }
  }

  private ensureClient(): ShadowClientLike | null {
    if (this.client && this.clientServerPath === this.config.serverPath) {
      return this.client;
    }
    this.stopClient();
    try {
      this.client =
        this.options.clientFactory?.(this.config.serverPath) ??
        new KodeCoreClient({
          binaryPath: this.config.serverPath,
          initializeParams: this.initializeParams,
          // WARM-VISIBILITY-004 blade B (FREEZE blade 3): kode-server liveness
          // heartbeat / restart-loop evidence goes into the unified "KBEngine
          // Index" channel.
          onLifecycle: line => { indexLog('server', line); },
        });
      // RUST-142: the notification consumer surface is passed through (if the
      // handler was set before the client was wired, re-attach it; late wiring
      // on a lazily built client goes through setNotificationHandler's client
      // re-attach).
      this.client.setNotificationHandler?.(this.notificationHandler);
      this.clientServerPath = this.config.serverPath;
      return this.client;
    } catch (error) {
      this.client = null;
      this.clientServerPath = '';
      this.noticeOnce(`shadow client 创建失败: ${(error as Error).message}`);
      return null;
    }
  }

  /** kill-switch / binary swap: stop the Rust process and clear the cooldown,
   * mirror ledger and snapshots (asynchronous, does not block the config path) */
  private stopClient(): void {
    const client = this.client;
    this.client = null;
    this.clientServerPath = '';
    this.mirroredVersions.clear();
    this.mirrorSnapshots.clear();
    this.registeredRoots.clear();
    this.lastRestartGeneration = null;
    // process replacement (kill-switch / binary swap / manual restart share this
    // path): reset the command-leg circuit — a new process is a new chance for
    // success (the same judging as the interactive leg's manual reset)
    this.commandCircuitOpen = false;
    this.commandTimeoutStreak = 0;
    if (client) {
      void client.dispose().catch(() => undefined);
    }
  }

  /**
   * restart reconciliation (E-2): after the client auto-restarts, the new
   * process has an empty corpus, so the old version ledger must become invalid —
   * the version ledger is cleared and the snapshots are fully replayed as
   * didOpen (the new ledger is rebuilt by the replay), otherwise didChange would
   * be ignored by the new process because the document is not open. Call site:
   * after every start() handshake (mirrorDocument and compare share the same
   * entry, whoever arrives first replays).
   */
  private syncRestartGeneration(client: ShadowClientLike): void {
    const generation = client.getRestartGeneration?.();
    if (typeof generation !== 'number') {
      return;
    }
    if (this.lastRestartGeneration === null) {
      this.lastRestartGeneration = generation;
      return;
    }
    if (generation === this.lastRestartGeneration) {
      return;
    }
    this.lastRestartGeneration = generation;
    this.mirroredVersions.clear();
    // circuit reset: a new process is a new chance for success (server-runtime
    // problems die with the old process).
    resetInteractiveCircuit(generation);
    // the command-leg circuit resets under the same rule (the automatic-restart
    // reconciliation point; together with stopClient's manual path this covers
    // both)
    this.commandCircuitOpen = false;
    this.commandTimeoutStreak = 0;
    // RUST-069-W: the new process's root registry is empty (the handshake only
    // carries workspaceFolders) — re-register the roots registered at runtime
    // (external assetsRoot / folders added at runtime) before replaying the
    // corpus snapshots (a file's root attribution depends on the root being
    // registered, so the order must not be inverted).
    for (const fsPath of this.registeredRoots) {
      const sent = client.addWorkspaceRoot?.(fsPath);
      if (sent) {
        sent.catch(() => undefined);
      }
    }
    for (const [uri, snapshot] of this.mirrorSnapshots) {
      client.openDocument?.(uri, snapshot.languageId, snapshot.version, snapshot.text);
      this.mirroredVersions.set(uri, snapshot.version);
    }
  }

  /**
   * root lifecycle (RUST-069-W): registers a workspace root (a folder added at
   * runtime / an external assetsRoot) into Rust's single root registry. The
   * request surface carries a receipt (the root id); the ledger dedupes so it
   * does not resend (the server side is idempotent as a backstop). Off the
   * serving track / with serverPath unconfigured it passes straight through to
   * null at zero cost; failures are silent (best effort, without harming
   * serving) and the ledger entry is kept — restart replay re-registers it.
   */
  async registerRoot(fsPath: string): Promise<{ root: number } | null> {
    if (!this.shouldMirrorCorpus() || !this.config.serverPath) {
      return null;
    }
    const client = this.ensureClient();
    if (!client) {
      return null;
    }
    try {
      await client.start();
      this.syncRestartGeneration(client);
    } catch {
      return null;
    }
    if (this.registeredRoots.has(fsPath)) {
      return null;
    }
    this.registeredRoots.add(fsPath);
    if (!client.addWorkspaceRoot) {
      return null;
    }
    try {
      return (await client.addWorkspaceRoot(fsPath)) as { root: number };
    } catch {
      return null;
    }
  }

  /**
   * root lifecycle (RUST-069-W): removes a workspace root — the Rust side
   * unregisters it and fans out shared-cache cleanup (mirrors/symbols/parse
   * candidates), and the receipt carries removed. The mirror ledger drops that
   * root's entries in sync: the server side is already clean, so if the ledger
   * kept them, the corpus re-mirror after re-adding the root would skip didOpen
   * as "already mirrored" and the new incarnation's empty corpus would never be
   * filled (remove -> re-add would be a silent degradation). A root never
   * registered is still sent (the server is idempotent: an unknown root yields
   * removed:false with no fan-out). Off the serving track it passes straight
   * through to null at zero cost.
   */
  async removeRoot(fsPath: string): Promise<{ removed: boolean } | null> {
    if (!this.shouldMirrorCorpus() || !this.config.serverPath) {
      return null;
    }
    this.registeredRoots.delete(fsPath);
    for (const uri of [...this.mirroredVersions.keys()]) {
      if (uriUnderRoot(uri, fsPath)) {
        this.mirroredVersions.delete(uri);
        this.mirrorSnapshots.delete(uri);
      }
    }
    const client = this.ensureClient();
    if (!client) {
      return null;
    }
    try {
      await client.start();
      this.syncRestartGeneration(client);
    } catch {
      return null;
    }
    if (!client.removeWorkspaceRoot) {
      return null;
    }
    try {
      return (await client.removeWorkspaceRoot(fsPath)) as { removed: boolean };
    } catch {
      return null;
    }
  }

  /**
   * warm gate (RUST-074-W): first scan begins — the server-side keyed state
   * machine is enqueued (Warming). The production first scan is the whole corpus
   * mirror (see kodeCoreCorpusMirror); begin carries the mirror total for
   * observational reconciliation. Best effort: off the mirror track / with
   * serverPath unconfigured it passes straight through to null at zero cost,
   * and failures are silent (without harming serving).
   */
  async beginBackgroundScan(total: number): Promise<{ state: string } | null> {
    if (!this.shouldMirrorCorpus() || !this.config.serverPath) {
      return null;
    }
    const client = this.ensureClient();
    if (!client) {
      return null;
    }
    try {
      await client.start();
      this.syncRestartGeneration(client);
    } catch {
      return null;
    }
    if (!client.beginBackgroundScan) {
      return null;
    }
    try {
      return (await client.beginBackgroundScan(total)) as { state: string };
    } catch {
      return null;
    }
  }

  /**
   * warm gate (RUST-074-W): first scan finished — the whole mirror pass is over,
   * the server pumps to Warm and records the done/failed counts. For a late /
   * no in-progress first scan the server side honestly refuses with -32602, and
   * here that stays silent (best effort); off the mirror track it passes straight
   * through to null at zero cost.
   */
  async scanComplete(done: number, failed: number): Promise<{ state: string } | null> {
    if (!this.shouldMirrorCorpus() || !this.config.serverPath) {
      return null;
    }
    const client = this.ensureClient();
    if (!client) {
      return null;
    }
    try {
      await client.start();
      this.syncRestartGeneration(client);
    } catch {
      return null;
    }
    if (!client.scanComplete) {
      return null;
    }
    try {
      return (await client.scanComplete(done, failed)) as { state: string };
    } catch {
      return null;
    }
  }

  /**
   * warm gate (RUST-074-W): first scan cancelled — on a mirror interruption
   * (the track switched away / enumeration failed) it goes back to Idle and
   * leaves no false pending. Idempotent: outside Warming the server returns its
   * current real state; off the mirror track it passes straight through to null
   * at zero cost, and failures are silent.
   */
  async scanCancel(): Promise<{ state: string } | null> {
    if (!this.shouldMirrorCorpus() || !this.config.serverPath) {
      return null;
    }
    const client = this.ensureClient();
    if (!client) {
      return null;
    }
    try {
      await client.start();
      this.syncRestartGeneration(client);
    } catch {
      return null;
    }
    if (!client.scanCancel) {
      return null;
    }
    try {
      return (await client.scanCancel()) as { state: string };
    } catch {
      return null;
    }
  }

  /**
   * corpus mirror leg (Phase2 first slice): syncs document open/change to the
   * Rust server, so definition/diagnostics shadow comparison shares the same
   * input. Best effort: any failure is silent (the verdict tally belongs to
   * compare's own failure classification; mirroring does not spam the diff log);
   * off shadow or with serverPath unconfigured it passes straight through at zero
   * cost. The version ledger is monotonic within a session: forward moves take
   * didChange, a rewind (reopen) takes close+open, and versions are never
   * fabricated; after an automatic restart the ledger is reset and snapshots are
   * replayed.
   *
   * KODE-RESP-007: disk corpus and editor overlay lifecycles are separate —
   * callers passing the corpus flag (the full corpus mirror's disk reads /
   * enumeration snapshots) are background snapshots and may only fill in
   * (fill-only): if the ledger already holds this document (the editor stream
   * mirrored it, or this pass already filled it) it is skipped, never driving a
   * change or a degrading close+open; a late disk snapshot at v1 must not pull a
   * live document back from v2 to stale content; only an absence is filled in as
   * didOpen and recorded (sharing the ledger with the editor stream, with the
   * same stance for restart replay / close cleanup). Editor-stream calls without
   * the corpus flag keep their original semantics (forward takes didChange, a
   * lower-version reopen takes close+open to cover the missed-close edge, and
   * versions are never fabricated).
   */
  async mirrorDocument(
    uri: string,
    languageId: string,
    version: number,
    text: string,
    options?: { readonly corpus?: boolean }
  ): Promise<void> {
    if (!this.shouldMirrorCorpus() || !this.config.serverPath) {
      return;
    }
    const client = this.ensureClient();
    if (!client) {
      return;
    }
    await client.start();
    this.syncRestartGeneration(client);
    const mirrored = this.mirroredVersions.get(uri);
    // RESP-009: the ledger update comes first; the await only bears the frame
    // write-backpressure wait (waiting for drain when needed, since the corpus
    // mirror producer is rate-limited by the pipe and the client buffer has a hard
    // upper bound). The placeholder is set before the await, so concurrent
    // re-entry (the editor leg and the corpus snapshot leg each filling once in
    // the same frame) sends didOpen only once; a throw while sending rolls the
    // ledger back and the next call re-fills (best effort, failures silent).
    const priorVersion = mirrored;
    const priorSnapshot = this.mirrorSnapshots.get(uri);
    const rollback = (): void => {
      if (priorVersion === undefined) {
        this.mirroredVersions.delete(uri);
        this.mirrorSnapshots.delete(uri);
      } else {
        this.mirroredVersions.set(uri, priorVersion);
        if (priorSnapshot) {
          this.mirrorSnapshots.set(uri, priorSnapshot);
        }
      }
    };
    if (options?.corpus) {
      // background snapshot fill-in: present means skip (no resend, no
      // downgrade); only an absence fills in an openDocument.
      if (mirrored !== undefined) {
        return;
      }
      this.mirroredVersions.set(uri, version);
      this.mirrorSnapshots.set(uri, { languageId, version, text });
      try {
        await client.openDocument?.(uri, languageId, version, text);
      } catch {
        rollback();
      }
      return;
    }
    if (mirrored === undefined) {
      this.mirroredVersions.set(uri, version);
      this.mirrorSnapshots.set(uri, { languageId, version, text });
      try {
        await client.openDocument?.(uri, languageId, version, text);
      } catch {
        rollback();
      }
      return;
    }
    if (version > mirrored) {
      this.mirroredVersions.set(uri, version);
      this.mirrorSnapshots.set(uri, { languageId, version, text });
      try {
        await client.changeDocument?.(uri, version, text);
      } catch {
        rollback();
      }
      return;
    }
    if (version < mirrored) {
      this.mirroredVersions.set(uri, version);
      this.mirrorSnapshots.set(uri, { languageId, version, text });
      try {
        await client.closeDocument?.(uri);
        await client.openDocument?.(uri, languageId, version, text);
      } catch {
        rollback();
      }
      return;
    }
    // same version = same content (VS Code bumps the version on every content
    // change): a mirror-leg re-entry does not resend.
  }

  /**
   * close-document cleanup (E-4): drops the version ledger entry and snapshot
   * and notifies Rust with didClose — after a close/abandoned unsaved revision
   * the Rust side no longer holds the old overlay (memory does not grow), and
   * reopening a lower-version document takes the normal didOpen path. It does
   * not spawn a process in reverse: only an existing client is handled (off
   * shadow or unwired, only the ledger is cleared); idempotent, a repeated close
   * sends no notification.
   */
  closeMirroredDocument(uri: string): void {
    const hadSnapshot = this.mirrorSnapshots.delete(uri);
    this.mirroredVersions.delete(uri);
    if (!hadSnapshot) {
      return;
    }
    if (!this.shouldMirrorCorpus()) {
      return;
    }
    this.client?.closeDocument?.(uri);
  }

  /**
   * shadow mirror comparison: always returns tsResult as-is and never throws.
   * The Rust result only goes into the diff log; any Rust-side failure
   * (start/request/timeout/unavailable) only records a verdict and is not
   * surfaced. Off shadow mode it passes straight through at zero cost (no
   * process is built, no log is written).
   */
  async compare<T>(method: string, params: unknown, tsResult: T, uri?: string): Promise<T> {
    // shadow comparison happens only in shadow mode; neither the rust serving
    // track nor the ts track goes through compare.
    if (this.mode !== 'shadow') {
      return tsResult;
    }
    const fail = (verdict: ShadowVerdict, detail?: string): void => {
      this.diffLog.record({ method, uri, verdict, detail });
    };
    if (!this.config.serverPath) {
      fail('rust-unavailable', 'kbengine.core.serverPath 未配置,影子比对不可用');
      return tsResult;
    }
    if (this.now() < this.nextAttemptAt) {
      fail('rust-unavailable', 'spawn 冷却中(上次启动失败 30s 内不重试)');
      return tsResult;
    }
    const client = this.ensureClient();
    if (!client) {
      this.nextAttemptAt = this.now() + SPAWN_COOLDOWN_MS;
      fail('rust-unavailable', 'shadow client 创建失败');
      return tsResult;
    }
    try {
      await client.start();
    } catch (error) {
      this.nextAttemptAt = this.now() + SPAWN_COOLDOWN_MS;
      fail('rust-unavailable', `rust server 启动失败: ${truncate((error as Error).message, 120)}`);
      return tsResult;
    }
    // after an automatic restart, replay the corpus snapshots first, otherwise
    // this comparison would hit an empty corpus (E-2)
    this.syncRestartGeneration(client);
    try {
      const rustResult = await client.request(method, params, {
        timeoutMs: this.config.shadowTimeoutMs,
      });
      const diffAt = firstDiffPath(tsResult, rustResult);
      if (diffAt === null) {
        this.diffLog.record({ method, uri, verdict: 'match' });
      } else {
        this.diffLog.record({
          method,
          uri,
          verdict: 'diff',
          detail: `${diffAt} ts=${preview(tsResult)} rust=${preview(rustResult)}`,
        });
      }
    } catch (error) {
      if (
        error instanceof KodeCoreTransportError &&
        (error.code === 'TIMEOUT' || error.code === 'REQUEST_CANCELLED')
      ) {
        // TIMEOUT = the hard-timeout backstop; REQUEST_CANCELLED = the
        // $/cancelRequest sent first by the timeout gate coming back as -32800
        // — both are shadow timeouts and belong to the rust side
        fail('rust-timeout', `${method} 超时(${this.config.shadowTimeoutMs}ms)`);
      } else {
        fail('rust-error', truncate((error as Error).message, 160));
      }
    }
    return tsResult;
  }

  /** stops the Rust process; the diff log is kept (fallback drills read it) */
  async dispose(): Promise<void> {
    this.stopClient();
  }

  /**
   * RUST-221 user-initiated explicit Core restart: stops the current Rust
   * process and clears the cooldown, mirror ledger and snapshots, and the next
   * semantic request rebuilds per the current config (the same path as an
   * automatic restart after a serverPath change). With backend=ts there is no
   * process to stop, so this is harmlessly idempotent; the diff log is kept
   * (the same stance as dispose).
   */
  restartCore(): void {
    this.stopClient();
    // P1-4: a manual restart is an unconditional reset window. If the new
    // process fails to start afterwards, the handshake reconciliation
    // (syncRestartGeneration -> resetInteractiveCircuit) never runs, so the
    // circuit must be reset by the restart action itself; otherwise later
    // requests stay blocked by the circuit and the restart is a no-op.
    resetInteractiveCircuitForManualRestart();
  }
}
