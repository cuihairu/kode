/**
 * KFLOW controlled-capture controller (FLOW-025): the pure core of a standalone
 * capture entry for single-process call events. Acceptance wording: "an
 * independently closable capture entry with a bounded buffer, recording
 * start/end/exceptions/drops; never enables high-overhead full tracing by
 * default."
 *
 * Four product red lines (each pinned by a construction-time gate or a test):
 *   1. **Off by default**: after construction the controller stays idle and
 *      ingest throws directly — capture happens only via an explicit start();
 *      there is no implicitly-enabled face (the capture command UI is not wired,
 *      separate project; this face registers no automatic triggers);
 *   2. **Bounded buffer**: maxEvents is required >0; when full, events do not
 *      enter the buffer and are only counted as drops (buffer-full), the drop
 *      count enters the loss reconciliation — an unbounded buffer does not ship;
 *   3. **Start/end accounting**: start records startedAtEpochMs and the window
 *      declaration, stop/fail record endedAtEpochMs and endReason (completed /
 *      collector-error) — whatever happened outside the window is honestly
 *      marked "unknown", never posed as the whole run;
 *   4. **Red-line validation is not bypassed**: close assembles a
 *      RawMonitoringSession and goes through importMonitoringSession (the
 *      FLOW-024 face) — source pairing / same-thread stack edges / bracket
 *      symmetry / loss reconciliation are all enforced by the protocol layer;
 *      the controller carries no looser rules of its own.
 *
 * The controller binds the sys.monitoring capture face (event shape =
 * monitoring_capture.py output); the sampling face = complete-within-window
 * (complete per event within the controlled window). Pure core, zero vscode
 * dependencies; see traceCaptureRun for the real subprocess entry.
 */

import { importMonitoringSession, type RawMonitoringSession } from './traceImport';
import type { TraceProcessRole, TraceSession } from './traceEventModel';

/** Raw captured event shape (collector output; structural validation happens in the import face at close time). */
export type RawTraceEvent = Record<string, unknown>;

export type TraceCaptureState = 'idle' | 'running' | 'stopped' | 'failed';

export type TraceCaptureEndReason = 'completed' | 'collector-error';

export interface TraceCaptureOptions {
  sessionId: string;
  /** Bounded buffer capacity (must be >0; when full, events are dropped and counted in the drop account) */
  maxEvents: number;
  processId: string;
  threadId: string;
  /** Captured process role; unknown='unknown' (no guessing) */
  processRole?: TraceProcessRole;
  processName?: string | null;
  /** Controlled window declaration (required by the complete-within-window face; the import face validates it) */
  windowNote: string;
  /** Session start wall clock (defaults to Date.now() at start(); tests may inject) */
  startedAtEpochMs?: number;
}

export interface TraceCaptureAccounting {
  state: TraceCaptureState;
  startedAtEpochMs: number | null;
  endedAtEpochMs: number | null;
  endReason: TraceCaptureEndReason | null;
  /** End note (on fail = the collector error reason) */
  endNote: string | null;
  bufferedEvents: number;
  /** Number of events dropped once the bounded buffer filled (counts only real overflow, never fabricated) */
  droppedBufferFull: number;
  calls: number;
  returns: number;
  exceptions: number;
}

export interface TraceCaptureResult {
  sessionId: string;
  /** Raw capture artifact (same shape as monitoring_capture.py output; can be persisted for review) */
  raw: RawMonitoringSession;
  /** Protocol session (via the FLOW-024 import face, all red lines validated) */
  session: TraceSession;
  accounting: TraceCaptureAccounting;
}

export interface IngestOutcome {
  accepted: boolean;
  buffered: number;
  dropped: number;
}

const KNOWN_ROLES: ReadonlySet<string> = new Set([
  'client',
  'base',
  'cell',
  'bridge:loginapp',
  'bridge:dbmgr',
  'bridge:interfaces',
  'bridge:other',
  'unknown'
]);

/** Controlled-capture controller: off by default, explicit start/stop, bounded buffer, start/end/exception/drop accounting. */
export class TraceCaptureController {
  readonly sessionId: string;
  private readonly maxEvents: number;
  private readonly processId: string;
  private readonly threadId: string;
  private readonly processRole: TraceProcessRole;
  private readonly processName: string | null;
  private readonly windowNote: string;
  private readonly startedAtEpochMs: number | null;

  private stateValue: TraceCaptureState = 'idle';
  private startedAt: number | null = null;
  private endedAt: number | null = null;
  private endReasonValue: TraceCaptureEndReason | null = null;
  private endNoteValue: string | null = null;
  private buffered: RawTraceEvent[] = [];
  private dropped = 0;

  constructor(options: TraceCaptureOptions) {
    if (!(Number.isInteger(options.maxEvents) && options.maxEvents > 0)) {
      throw new Error('受控采集必须有界:maxEvents 必须是正整数(无界缓冲不交付)');
    }
    if (typeof options.windowNote !== 'string' || options.windowNote.length === 0) {
      throw new Error('受控采集必须声明窗口 windowNote(complete-within-window 面不得缺窗口说明)');
    }
    if (!KNOWN_ROLES.has(options.processRole ?? 'unknown')) {
      throw new Error(`受控采集:未知进程角色 ${String(options.processRole)}(不猜角色)`);
    }
    this.sessionId = options.sessionId;
    this.maxEvents = options.maxEvents;
    this.processId = options.processId;
    this.threadId = options.threadId;
    this.processRole = options.processRole ?? 'unknown';
    this.processName = options.processName ?? null;
    this.windowNote = options.windowNote;
    this.startedAtEpochMs = options.startedAtEpochMs ?? null;
  }

  get state(): TraceCaptureState {
    return this.stateValue;
  }

  /** Explicitly start the capture window; only after this step does ingest accept events (off-by-default red line). */
  start(): void {
    if (this.stateValue !== 'idle') {
      throw new Error(`受控采集:start 只允许一次(当前状态 ${this.stateValue})`);
    }
    this.stateValue = 'running';
    this.startedAt = this.startedAtEpochMs ?? Date.now();
  }

  /** Account one collector event; throws when not running (off by default / window closed); when full, only counts drops. */
  ingest(event: RawTraceEvent): IngestOutcome {
    if (this.stateValue !== 'running') {
      throw new Error(
        `受控采集:控制器未在采集窗口内(状态 ${this.stateValue});不默认开启,显式 start() 后才收事件`
      );
    }
    if (this.buffered.length >= this.maxEvents) {
      this.dropped += 1;
      return { accepted: false, buffered: this.buffered.length, dropped: this.dropped };
    }
    this.buffered.push(event);
    return { accepted: true, buffered: this.buffered.length, dropped: this.dropped };
  }

  /** Explicitly close the capture window (completed); then assembles the session and passes protocol red-line validation. */
  stop(): TraceCaptureResult {
    if (this.stateValue !== 'running') {
      throw new Error(`受控采集:stop 只在采集窗口内合法(当前状态 ${this.stateValue})`);
    }
    return this.close('completed', null);
  }

  /** Collector-side failure closure (collector-error); buffered events are honestly kept, the failure reason recorded. */
  fail(reason: string): TraceCaptureResult {
    if (this.stateValue !== 'running') {
      throw new Error(`受控采集:fail 只在采集窗口内合法(当前状态 ${this.stateValue})`);
    }
    return this.close('collector-error', reason);
  }

  accounting(): TraceCaptureAccounting {
    return {
      state: this.stateValue,
      startedAtEpochMs: this.startedAt,
      endedAtEpochMs: this.endedAt,
      endReason: this.endReasonValue,
      endNote: this.endNoteValue,
      bufferedEvents: this.buffered.length,
      droppedBufferFull: this.dropped,
      calls: this.buffered.filter(event => event['kind'] === 'call').length,
      returns: this.buffered.filter(event => event['kind'] === 'return').length,
      exceptions: this.buffered.filter(event => event['kind'] === 'exception').length
    };
  }

  private close(reason: TraceCaptureEndReason, note: string | null): TraceCaptureResult {
    this.stateValue = reason === 'completed' ? 'stopped' : 'failed';
    const endedAtMs = Date.now();
    this.endedAt = endedAtMs;
    this.endReasonValue = reason;
    this.endNoteValue = note;

    const drops =
      this.dropped > 0
        ? [
            {
              processId: null,
              reason: 'buffer-full' as const,
              count: this.dropped,
              note: `max-events=${this.maxEvents} 打满后丢弃(受控有界缓冲;窗口内打满即丢,窗口外未知)`
            }
          ]
        : [];

    const raw: RawMonitoringSession = {
      meta: {
        collector: 'sys-monitoring',
        windowNote: this.windowNote,
        clock: 'process-mono',
        ...(this.startedAtEpochMs !== null ? { startedAtEpochMs: this.startedAtEpochMs } : {}),
        stoppedAtEpochMs: endedAtMs,
        endReason: reason,
        ...(note !== null ? { endNote: note } : {})
      },
      processes: [
        {
          processId: this.processId,
          role: this.processRole,
          name: this.processName,
          enginePythonVersion: null
        }
      ],
      threads: [{ threadId: this.threadId, processId: this.processId, name: this.threadId }],
      events: this.buffered,
      drops
    };
    const session = importMonitoringSession(raw, this.sessionId);
    return { sessionId: this.sessionId, raw, session, accounting: this.accounting() };
  }
}
