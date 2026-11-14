/**
 * KFLOW trace 导入面(FLOW-024):把已验证来源(sys.monitoring 采集器,
 * scripts/trace/monitoring_capture.py)的 JSON 会话导入 G3 协议
 * (traceEventModel)。验收原文:「先支持一个已验证来源的真实帧顺序、文件行
 * 和异常位置;字段缺失明示,栈展开可跳源码。」
 *
 * 导入职责与诚实边界:
 *   - 只收 meta.collector==='sys-monitoring' 的会话;别的来源不是「转换一下
 *     也能收」,而是直接拒(来源配对表是红线,不冒充);
 *   - return 事件在采集原始面不带 correspondsToCallSeq(sys.monitoring 只给
 *     PY_RETURN/PY_UNWIND),导入按**同线程括号对称**(LIFO)配对——每个
 *     PY_START 恰有一个配对返回;配不上=会话损坏,如实抛错,不猜;
 *   - 帧 file/line 保留采集口径:line 为 1 基 def 声明行(co_firstlineno,
 *     稳定跳源码锚),不做换算不猜语句行;
 *   - 字段缺失明示:entityId/className/enginePythonVersion/关联 ID 等本来源
 *     观察不到的字段保持 null,不以推导冒充;
 *   - seq 分配、同线程栈边校验、来源/采样面配对、丢失对账全部交给
 *     buildTraceSession(协议红线不绕过)。
 *
 * 纯导入面,零 vscode 依赖;UI/回放消费在 FLOW-028。
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

/** 采集器输出 JSON 形态(monitoring_capture.py payload,无 seq)。 */
export interface RawMonitoringSession {
  meta: {
    collector: string;
    monitoringToolId?: number;
    pythonVersion?: string;
    interpreter?: string;
    windowNote: string;
    clock: string;
    startedAtEpochMs?: number;
    /** 受控采集收口记账(FLOW-025 控制器面;最小采集器可不带) */
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

/** sys.monitoring 帧面的跳源码目标(1 基 def 声明行,保留采集口径)。 */
export function frameJumpTarget(frame: TraceFrame): { file: string; line: number } {
  return { file: frame.file, line: frame.line };
}

/** 把 sys.monitoring 会话导入 G3 协议;红线校验全部走 buildTraceSession。 */
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

  // 同线程括号对称配对:call 入栈,return 弹栈顶。seq 由 buildTraceSession
  // 按输入序分配,无丢弃占位,原始下标即最终 seq。
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

/** 导入面摘要(诚实声明来源与边界;UI/日志面直接引用)。 */
export function describeImportedSession(session: TraceSession): string {
  return [
    `session ${session.sessionId}`,
    `collector=${session.source.kind}`,
    `${describeSampleFace(session.source.sampleFace)}`,
    `events=${session.events.length}`,
    `dropped=${session.loss.totalDropped}`
  ].join('; ');
}
