/**
 * KFLOW 受控采集控制器(FLOW-025):单进程调用事件的独立采集入口核心面。
 * 验收原文:「独立可关闭的采集入口和有界缓冲,记录开始/结束/异常/丢弃;
 * 不默认开启高开销全量 trace。」
 *
 * 四条产品红线(每条都有构造期闸或测试钉):
 *   1. **默认关闭**:控制器构造后停在 idle,ingest 直接抛错——采集只因显式
 *      start() 发生,不存在隐式开启面(UI 接线在 FLOW-028,本面不注册任何
 *      自动触发);
 *   2. **有界缓冲**:maxEvents 必填>0,打满后事件不入缓冲只计丢弃
 *      (buffer-full),丢异数入 loss 对账——无界缓冲不交付;
 *   3. **开始/结束记账**:start 记 startedAtEpochMs 与窗口声明,stop/fail 记
 *      endedAtEpochMs 与 endReason(completed / collector-error)——窗口外
 *      发生了什么如实标「未知」,不冒充全程;
 *   4. **红线校验不绕过**:close 组装 RawMonitoringSession 后走
 *      importMonitoringSession(FLOW-024 面)——来源配对/同线程栈边/括号
 *      对称/丢失对账全部由协议层把关,控制器不自带一套宽松规则。
 *
 * 控制器绑定 sys.monitoring 采集面(事件形态=monitoring_capture.py 输出);
 * 采样面=complete-within-window(受控窗口内逐事件完整)。纯核心,零 vscode
 * 依赖;真实子进程入口见 traceCaptureRun。
 */

import { importMonitoringSession, type RawMonitoringSession } from './traceImport';
import type { TraceProcessRole, TraceSession } from './traceEventModel';

/** 采集原始事件形态(采集器输出;结构校验在 close 时的导入面做)。 */
export type RawTraceEvent = Record<string, unknown>;

export type TraceCaptureState = 'idle' | 'running' | 'stopped' | 'failed';

export type TraceCaptureEndReason = 'completed' | 'collector-error';

export interface TraceCaptureOptions {
  sessionId: string;
  /** 有界缓冲容量(必须 >0;打满即丢计入丢弃账) */
  maxEvents: number;
  processId: string;
  threadId: string;
  /** 采集进程角色;未知='unknown'(不猜) */
  processRole?: TraceProcessRole;
  processName?: string | null;
  /** 受控窗口声明(complete-within-window 面必填,导入面会校验) */
  windowNote: string;
  /** 会话起始墙钟(缺省=start() 时刻 Date.now();测试可注入) */
  startedAtEpochMs?: number;
}

export interface TraceCaptureAccounting {
  state: TraceCaptureState;
  startedAtEpochMs: number | null;
  endedAtEpochMs: number | null;
  endReason: TraceCaptureEndReason | null;
  /** 结束说明(fail 时=采集器错误原因) */
  endNote: string | null;
  bufferedEvents: number;
  /** 有界缓冲打满后被丢弃的事件数(只计真实溢出,不造假) */
  droppedBufferFull: number;
  calls: number;
  returns: number;
  exceptions: number;
}

export interface TraceCaptureResult {
  sessionId: string;
  /** 采集原始工件(与 monitoring_capture.py 输出同形态;可落盘复查) */
  raw: RawMonitoringSession;
  /** 协议会话(经 FLOW-024 导入面,红线全验) */
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

/** 受控采集控制器:默认关闭、显式启停、有界缓冲、开始/结束/异常/丢弃记账。 */
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

  /** 显式启动采集窗口;只有这一步之后 ingest 才收事件(默认关闭红线)。 */
  start(): void {
    if (this.stateValue !== 'idle') {
      throw new Error(`受控采集:start 只允许一次(当前状态 ${this.stateValue})`);
    }
    this.stateValue = 'running';
    this.startedAt = this.startedAtEpochMs ?? Date.now();
  }

  /** 采集器事件入账;非 running 抛错(默认关闭/窗口已关);打满只计丢弃。 */
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

  /** 显式关闭采集窗口(completed);随后组装会话并过协议红线校验。 */
  stop(): TraceCaptureResult {
    if (this.stateValue !== 'running') {
      throw new Error(`受控采集:stop 只在采集窗口内合法(当前状态 ${this.stateValue})`);
    }
    return this.close('completed', null);
  }

  /** 采集器侧失败收口(collector-error);已缓冲事件如实保留,失败原因入账。 */
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
