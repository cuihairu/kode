/**
 * Generic HTTP request executor (HR-PR-03, book §19.5):
 * - HR-HTTP-001 single execution path: HTTP shortcut requests
 *   (HttpRequestService) and default hot reload (sendDefaultHotfix) share one
 *   execute + classify core; writing a separate transport branch per caller is
 *   forbidden (same family of discipline as HR-MOD-005 "do not duplicate two
 *   string-handling paths"); generic HTTP feature semantics are unchanged --
 *   the service layer still branches on the raw transport ok boolean,
 *   classification is attached data that does not change behavior;
 * - HR-HTTP-010 structured outcome: invalid-url / unsupported-protocol /
 *   timeout / network-error / non-2xx / ok, six kinds + error subcategories
 *   (connection refused/DNS/reset/timeout...); the transport facts decide the
 *   classification, an unknown subcategory is honestly unknown when it cannot
 *   be derived -- no guessing;
 * - HR-HTTP-014 every execution generates a correlation id carried through the
 *   outcome; putting the id into request headers ("carry through to the
 *   server") is a wire-byte change and is not done by default (same boundary
 *   as not URL-encoding in templates); wire carry-through ships behind an
 *   explicit switch once the receiving side's contract is unfrozen
 *   (HR-AUDIT-009);
 * - exchange state machine (the "state machine" face of the HR-PR-03 block):
 *   idle->in-flight->settled, one-way, illegal transitions explicitly refused
 *   -- no double send / no double settle can take shape; reused later by the
 *   watch queue (HR-PR-04) as a per-file exchange guard.
 */

import { randomUUID } from 'crypto';
import {
  defaultTransport,
  type HttpExecutionResult,
  type HttpTransport,
  type OutgoingHttpRequest
} from './httpRequestService';
import type { HttpTargetQueue } from './httpRequestQueue';

/** Lifecycle state of a single exchange: one-way progression, no rollback */
export type HttpExchangeState = 'idle' | 'in-flight' | 'settled';

/** Exchange events: send starts the transport; settle means the transport result is collected (success or failure both settle) */
export type HttpExchangeEvent = 'send' | 'settle';

/** Transition table: settled is a terminal state, no event may advance it further */
export const HTTP_EXCHANGE_TRANSITIONS: Readonly<
  Record<HttpExchangeState, Readonly<Partial<Record<HttpExchangeEvent, HttpExchangeState>>>>
> = {
  idle: { send: 'in-flight' },
  'in-flight': { settle: 'settled' },
  settled: {}
};

export interface HttpExchangeAdvanceOk {
  readonly ok: true;
  readonly from: HttpExchangeState;
  readonly next: HttpExchangeState;
}

export interface HttpExchangeAdvanceRefused {
  readonly ok: false;
  readonly from: HttpExchangeState;
  readonly event: HttpExchangeEvent;
  readonly reason: string;
}

export type HttpExchangeAdvance =
  | HttpExchangeAdvanceOk
  | HttpExchangeAdvanceRefused;

export interface HttpExchangeMachine {
  readonly state: HttpExchangeState;
  canAdvance(event: HttpExchangeEvent): boolean;
  advance(event: HttpExchangeEvent): HttpExchangeAdvance;
}

/** Exchange state machine: illegal transitions are refused with a reason, never silently skipped */
export function createHttpExchangeMachine(): HttpExchangeMachine {
  let state: HttpExchangeState = 'idle';
  return {
    get state() {
      return state;
    },
    canAdvance(event: HttpExchangeEvent): boolean {
      return HTTP_EXCHANGE_TRANSITIONS[state][event] !== undefined;
    },
    advance(event: HttpExchangeEvent): HttpExchangeAdvance {
      const next = HTTP_EXCHANGE_TRANSITIONS[state][event];
      if (next === undefined) {
        return {
          ok: false,
          from: state,
          event,
          reason:
            state === 'settled'
              ? `交换已沉降(${state}),事件 ${event} 不得再推进`
              : `状态 ${state} 不接受事件 ${event}`
        };
      }
      const from = state;
      state = next;
      return { ok: true, from, next };
    }
  };
}

/** HR-HTTP-010 result classification (decided by transport facts, not guessed); HR-HTTP-008 adds the cancelled kind */
export type HttpOutcomeKind =
  | 'ok'
  | 'non-2xx'
  | 'timeout'
  | 'network-error'
  | 'invalid-url'
  | 'unsupported-protocol'
  | 'cancelled';

/** Error subcategories (aligned with the HR-STATE-010 actionable-reason face; undeterminable = unknown) */
export type HttpErrorCategory =
  | 'connection-refused'
  | 'dns'
  | 'connection-reset'
  | 'timeout'
  | 'invalid-url'
  | 'unsupported-protocol'
  | 'http-status'
  | 'cancelled'
  | 'unknown';

export interface HttpRequestOutcome {
  /** HR-HTTP-014: correlation id for this execution (crypto UUID) */
  readonly correlationId: string;
  readonly kind: HttpOutcomeKind;
  /** Raw transport-face ok boolean: service-layer branch semantics follow this (classification does not change behavior) */
  readonly transportOk: boolean;
  readonly status: number;
  readonly durationMs: number;
  readonly body: string;
  readonly bodyTruncated?: true;
  readonly errorCategory?: HttpErrorCategory;
  readonly errorMessage?: string;
}

/** Correlation id per execution: UUID v4 (crypto random, no timestamp to guess from) */
export function newCorrelationId(): string {
  return randomUUID();
}

/**
 * Transport failure error message -> (kind, subcategory). Only recognizes the
 * deterministic markers of our own transport (the "request timed out" prefix
 * / "URL could not be parsed" / "unsupported protocol") and node network
 * error codes (ECONNREFUSED/ENOTFOUND/EAI_AGAIN/ECONNRESET); anything else is
 * honestly unknown.
 */
const classifyTransportError = (error?: string): {
  kind: HttpOutcomeKind;
  category: HttpErrorCategory;
} => {
  const message = error ?? '';
  if (message.includes('请求已取消(')) {
    return { kind: 'cancelled', category: 'cancelled' };
  }
  if (message.includes('请求超时(')) {
    return { kind: 'timeout', category: 'timeout' };
  }
  if (message.includes('URL 无法解析')) {
    return { kind: 'invalid-url', category: 'invalid-url' };
  }
  if (message.includes('不支持的协议')) {
    return { kind: 'unsupported-protocol', category: 'unsupported-protocol' };
  }
  if (/ECONNREFUSED/.test(message)) {
    return { kind: 'network-error', category: 'connection-refused' };
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/.test(message)) {
    return { kind: 'network-error', category: 'dns' };
  }
  if (/ECONNRESET|socket hang up|aborted/.test(message)) {
    return { kind: 'network-error', category: 'connection-reset' };
  }
  return { kind: 'network-error', category: 'unknown' };
};

/** Transport result -> structured outcome (HR-HTTP-010 classification face, pure function) */
export function classifyExecution(
  result: HttpExecutionResult,
  correlationId: string
): HttpRequestOutcome {
  if (!result.ok) {
    const { kind, category } = classifyTransportError(result.error);
    return {
      correlationId,
      kind,
      transportOk: false,
      status: result.status,
      durationMs: result.durationMs,
      body: result.body,
      errorCategory: category,
      ...(result.error !== undefined ? { errorMessage: result.error } : {})
    };
  }
  const ok = result.status >= 200 && result.status <= 299;
  return {
    correlationId,
    kind: ok ? 'ok' : 'non-2xx',
    transportOk: true,
    status: result.status,
    durationMs: result.durationMs,
    body: result.body,
    ...(result.bodyTruncated ? { bodyTruncated: result.bodyTruncated } : {}),
    ...(ok ? {} : { errorCategory: 'http-status' as const })
  };
}

export interface HttpExecuteDeps {
  /** Defaults to the default node transport face; tests inject scripted responses */
  readonly transport?: HttpTransport;
  /** Caller-supplied correlation id (the caller threads its own chain); generated here when absent */
  readonly correlationId?: string;
  /**
   * HR-HTTP-007 (RUST-349) per-target bounded concurrency queue (limiting only
   * applies when injected: same target serialized, different targets
   * independently concurrent, global cap as backstop). No queue by default --
   * the automatic hot reload fire path has an existing pinned
   * "overlapping waves in flight + generation guard" contract
   * (HR-WATCH-011, an old response must not impersonate a new version,
   * tests/hotReloadRevisionGate); globally forcing serialization would void
   * that guard's real path and slow down sending the new version (old
   * requests hang until timeout while the new version queues for the full
   * budget). Whoever wants bounded concurrency injects it (the shortcut
   * request face already does); the executor layer does not fix this for all
   * callers.
   */
  readonly queue?: HttpTargetQueue;
  /**
   * HR-HTTP-008 (RUST-350) cancellation signal passed through to the transport
   * face: aborts the in-flight request, settling kind='cancelled'
   * (cancellation is not a remote revocation; callers display it with the
   * uncertain convention). No signal by default = not cancellable (existing
   * behavior unchanged).
   */
  readonly signal?: AbortSignal;
}

/** Queue target key: URL origin (protocol+host+port); an unparseable URL is keyed as-is (grouping does not guess) */
const targetKeyOf = (url: string): string => {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
};

/**
 * Single execution: generate correlation id -> machine send -> (per-target
 * bounded concurrency when a queue is injected) -> transport -> settle ->
 * classify. This function exclusively advances the state machine; a refused
 * send/settle is an implementation bug (thrown explicitly, never silently).
 * The transport fires once, no retry (HR-HTTP-009: by default no automatic
 * retry of a non-idempotent update with unknown status; cancellation/timeout/
 * connection refusal/unknown status are all exactly-once, never auto-resent --
 * resending a non-idempotent update is duplicate delivery, and claiming
 * recovery while the status is unknown is a false report).
 * Only one gate remains for enabling retries: the server provides an
 * idempotency key (receiving-side contract) -> bounded backoff retry. No
 * endpoint currently satisfies that gate -- the engine hot reload endpoint
 * has no idempotency contract, and an Idempotency-Key request header is a
 * wire-byte change on the same boundary as HR-HTTP-014 header carry-through
 * (shipped behind an explicit switch once the HR-AUDIT-009 receiving-side
 * contract is unfrozen). Hence zero automatic retry at this layer is the only
 * true path today; no idle retry abstraction is built (the "absorb only the
 * residue, do not build abstractions" convention).
 * The queue only constrains the initiation moment, not transport semantics --
 * queue wait does not count against the request timeout budget.
 */
export async function executeHttpRequest(
  request: OutgoingHttpRequest,
  deps: HttpExecuteDeps = {}
): Promise<HttpRequestOutcome> {
  const transport = deps.transport ?? defaultTransport;
  const correlationId = deps.correlationId ?? newCorrelationId();
  const machine = createHttpExchangeMachine();
  const send = machine.advance('send');
  if (!send.ok) {
    throw new Error(`执行器状态机拒绝 send: ${send.reason}`);
  }
  const sendOnce = (): Promise<HttpExecutionResult> =>
    transport({
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: request.body,
      timeoutMs: request.timeoutMs,
      ...(request.maxResponseBytes !== undefined ? { maxResponseBytes: request.maxResponseBytes } : {}),
      ...(deps.signal !== undefined ? { signal: deps.signal } : {})
    });
  const result = deps.queue
    ? await deps.queue.run(targetKeyOf(request.url), sendOnce)
    : await sendOnce();
  const settle = machine.advance('settle');
  if (!settle.ok) {
    throw new Error(`执行器状态机拒绝 settle: ${settle.reason}`);
  }
  return classifyExecution(result, correlationId);
}
