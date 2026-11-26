/**
 * KFLOW trace import face (FLOW-024): imports the JSON session of a verified source
 * (the sys.monitoring collector, scripts/trace/monitoring_capture.py) into the G3
 * protocol (traceEventModel). Acceptance wording: "support one verified source's real
 * frame order, file lines, and exception positions first; state missing fields
 * plainly, and let stack unwinding jump to source."
 *
 * Import responsibilities and honest boundaries:
 *   - Only sessions with meta.collector==='sys-monitoring' are accepted; other
 *     sources are not "convertible and acceptable" but rejected outright (the source
 *     pairing table is a red line, no posing);
 *   - return events do not carry correspondsToCallSeq in the raw capture face
 *     (sys.monitoring only gives PY_RETURN/PY_UNWIND); the import pairs them by
 *     **same-thread bracket symmetry** (LIFO) — each PY_START has exactly one paired
 *     return; an unpaired one = a corrupted session, throw honestly, no guessing;
 *   - frame file/line keep the capture semantics: line is the 1-based def declaration
 *     line (co_firstlineno, a stable source-jump anchor), no conversion, no guessing
 *     at statement lines;
 *   - missing fields are stated plainly: fields this source cannot observe
 *     (entityId/className/enginePythonVersion/correlation IDs and the like) stay
 *     null, never replaced by inference;
 *   - seq assignment, same-thread stack-edge validation, source/sample-face pairing,
 *     and loss reconciliation are all delegated to buildTraceSession (protocol red
 *     lines are never bypassed).
 *
 * Pure import face, zero vscode dependencies; the UI/replay consumers are FLOW-028.
 */

import {
  buildTraceSession,
  describeSampleFace,
  type TraceEventInput,
  type TraceFrame,
  type TraceProcessRole,
  type TraceSession,
  type TraceSessionInput
} from './traceEventModel';

/** The collector's output JSON shape (the monitoring_capture.py payload, no seq). */
export interface RawMonitoringSession {
  meta: {
    collector: string;
    monitoringToolId?: number;
    pythonVersion?: string;
    interpreter?: string;
    windowNote: string;
    clock: string;
    startedAtEpochMs?: number;
    /** Controlled-capture teardown ledger (the FLOW-025 controller face; the minimal collector may omit it) */
    stoppedAtEpochMs?: number;
    endReason?: string;
    endNote?: string;
  };
  processes: Array<{
    processId: string;
    role: string;
    name: string | null;
    enginePythonVersion: string | null;
  }>;
  threads: Array<{ threadId: string; processId: string; name: string | null }>;
  events: Array<Record<string, unknown>>;
  drops?: Array<{
    timestamp?: number;
    processId: string | null;
    reason: string;
    count: number;
    note: string | null;
  }>;
}

const KNOWN_ROLES: ReadonlySet<TraceProcessRole> = new Set<TraceProcessRole>([
  'client',
  'base',
  'cell',
  'bridge:loginapp',
  'bridge:dbmgr',
  'bridge:interfaces',
  'bridge:other',
  'unknown'
]);

function expectObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`trace 导入失败:${what} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function expectString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`trace 导入失败:${what} 必须是非空字符串`);
  }
  return value;
}

function optString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function optNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The sys.monitoring frame face's source-jump target (a 1-based def declaration line, keeping the capture semantics). */
export function frameJumpTarget(frame: TraceFrame): { file: string; line: number } {
  return { file: frame.file, line: frame.line };
}

/** Import a sys.monitoring session into the G3 protocol; all red-line validation goes through buildTraceSession. */
export function importMonitoringSession(raw: RawMonitoringSession, sessionId: string): TraceSession {
  if (raw.meta.collector !== 'sys-monitoring') {
    throw new Error(
      `trace 导入失败:本导入面只收 sys-monitoring 会话,收到 collector=${raw.meta.collector}(来源配对是红线,不冒充)`
    );
  }
  if (typeof raw.meta.windowNote !== 'string' || raw.meta.windowNote.length === 0) {
    throw new Error('trace 导入失败:sys-monitoring 是 complete-within-window 面,缺 windowNote 即无法如实声明窗口');
  }

  const processes = raw.processes.map(entry => {
    const role = entry.role as TraceProcessRole;
    if (!KNOWN_ROLES.has(role)) {
      throw new Error(`trace 导入失败:未知进程角色 ${String(entry.role)}(不猜角色)`);
    }
    return {
      processId: expectString(entry.processId, 'processId'),
      role,
      name: entry.name ?? null,
      enginePythonVersion: entry.enginePythonVersion ?? null
    };
  });
  const threads = raw.threads.map(entry => ({
    threadId: expectString(entry.threadId, 'threadId'),
    processId: expectString(entry.processId, 'thread.processId'),
    name: entry.name ?? null
  }));

  // Same-thread bracket-symmetry pairing: a call pushes, a return pops the stack top.
  // buildTraceSession assigns seq by input order with no dropped placeholders, so the
  // raw index is the final seq.
  const openCalls = new Map<string, number[]>();
  const events: TraceEventInput[] = raw.events.map((rawEvent, index) => {
    const kind = expectString(rawEvent.kind, `events[${index}].kind`);
    const processId = expectString(rawEvent.processId, `events[${index}].processId`);
    const threadId = expectString(rawEvent.threadId, `events[${index}].threadId`);
    const timestamp = typeof rawEvent.timestamp === 'number' ? rawEvent.timestamp : Number.NaN;
    const entityId = optString(rawEvent.entityId);
    const clockKey = `${processId}\u001f${threadId}`;

    if (kind === 'call') {
      const frameRaw = expectObject(rawEvent.frame, `events[${index}].frame`);
      const frame: TraceFrame = {
        file: expectString(frameRaw.file, `events[${index}].frame.file`),
        line: typeof frameRaw.line === 'number' ? frameRaw.line : Number.NaN,
        function: expectString(frameRaw.function, `events[${index}].frame.function`),
        className: optString(frameRaw.className)
      };
      const parentRaw = rawEvent.parentSeq;
      const parentSeq = parentRaw === null || parentRaw === undefined ? null : (parentRaw as number);
      const stack = openCalls.get(clockKey) ?? [];
      stack.push(index);
      openCalls.set(clockKey, stack);
      return {
        kind: 'call' as const,
        timestamp,
        processId,
        threadId,
        entityId,
        frame,
        parentSeq
      };
    }

    if (kind === 'return') {
      const stack = openCalls.get(clockKey);
      if (!stack || stack.length === 0) {
        throw new Error(
          `trace 导入失败:events[${index}] return 在线程 ${threadId} 无未闭合 call(括号对称破坏,会话损坏;不猜配对)`
        );
      }
      const callSeq = stack.pop() as number;
      const unwound = rawEvent.unwound === true;
      return {
        kind: 'return' as const,
        timestamp,
        processId,
        threadId,
        entityId,
        correspondsToCallSeq: callSeq,
        returnValueNote: unwound ? 'unwound by exception (PY_UNWIND)' : null
      };
    }

    if (kind === 'exception') {
      const atRaw = rawEvent.atSeq;
      return {
        kind: 'exception' as const,
        timestamp,
        processId,
        threadId,
        entityId,
        atSeq: atRaw === null || atRaw === undefined ? null : (atRaw as number),
        exceptionType: optString(rawEvent.exceptionType),
        message: optString(rawEvent.message),
        propagated: typeof rawEvent.propagated === 'boolean' ? rawEvent.propagated : null
      };
    }

    throw new Error(
      `trace 导入失败:events[${index}] 形态 ${kind} 不属于 sys-monitoring 采集面(只收 call/return/exception;消息事件来自带关联 ID 的来源)`
    );
  });

  const input: TraceSessionInput = {
    sessionId,
    source: {
      kind: 'sys-monitoring',
      collectorVersion: optString(raw.meta.pythonVersion),
      sampleFace: 'complete-within-window',
      samplingHz: null,
      windowNote: raw.meta.windowNote
    },
    clock: {
      basis: raw.meta.clock === 'process-mono' ? 'process-mono' : 'unknown',
      note: raw.meta.clock === 'process-mono' ? 'monotonic ms 自会话起点(采集器 t0)' : null
    },
    processes,
    threads,
    events,
    drops: (raw.drops ?? []).map(drop => {
      const timestamp = optNumber(drop.timestamp);
      return {
        ...(timestamp !== null ? { timestamp } : {}),
        processId: drop.processId ?? null,
        reason: drop.reason as 'buffer-full',
        count: drop.count,
        note: drop.note ?? null
      };
    })
  };
  return buildTraceSession(input);
}

/** Import-face summary (an honest statement of source and boundaries; cited directly by the UI/log face). */
export function describeImportedSession(session: TraceSession): string {
  return [
    `session ${session.sessionId}`,
    `collector=${session.source.kind}`,
    `${describeSampleFace(session.source.sampleFace)}`,
    `events=${session.events.length}`,
    `dropped=${session.loss.totalDropped}`
  ].join('; ');
}
