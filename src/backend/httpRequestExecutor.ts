/**
 * 通用 HTTP 请求执行器(HR-PR-03,书 §19.5):
 * - HR-HTTP-001 单一执行路径:HTTP 快捷请求(HttpRequestService)与默认热更
 *   (sendDefaultHotfix)共用同一执行+分类核心,禁止各写一套传输分支
 *   (与 HR-MOD-005「禁止复制两套字符串处理」同族纪律);通用 HTTP 功能
 *   语义不变——服务层分支仍按传输面原始 ok 布尔,分类是附加数据不改行为;
 * - HR-HTTP-010 结构化 outcome:invalid-url / unsupported-protocol / timeout /
 *   network-error / non-2xx / ok 六类 + 错误细类(连接拒绝/DNS/重置/超时...),
 *   传输事实决定分类,推不出细类如实 unknown,不猜;
 * - HR-HTTP-014 每次执行生成 correlation id,贯穿 outcome;id 进请求头
 *   「贯穿到服务端」是线路字节变更,默认不做(与模板不做 URL 编码同边界),
 *   线路贯穿待接收端契约解冻(HR-AUDIT-009)后以显式开关交付;
 * - 交换状态机(HR-PR-03 块「状态机」面):idle→in-flight→settled 单向,
 *   非法迁移显式拒绝——双发送/重复沉降不成形;供后续 watch 队列
 *   (HR-PR-04)复用为逐文件交换守卫。
 */

import { randomUUID } from 'crypto';
import {
  defaultTransport,
  type HttpExecutionResult,
  type HttpTransport,
  type OutgoingHttpRequest
} from './httpRequestService';

/** 单次交换生命周期状态:单向推进,无回退 */
export type HttpExchangeState = 'idle' | 'in-flight' | 'settled';

/** 交换事件:send 发起传输;settle 传输结果已回收(成败皆算沉降) */
export type HttpExchangeEvent = 'send' | 'settle';

/** 迁移表:settled 是终态,任何事件不得再推进 */
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

/** 交换状态机:非法迁移拒绝并带原因,绝不静默跳态 */
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

/** HR-HTTP-010 结果六分类(传输事实决定,不猜) */
export type HttpOutcomeKind =
  | 'ok'
  | 'non-2xx'
  | 'timeout'
  | 'network-error'
  | 'invalid-url'
  | 'unsupported-protocol';

/** 错误细类(对齐 HR-STATE-010 可操作原因面;推不出=unknown) */
export type HttpErrorCategory =
  | 'connection-refused'
  | 'dns'
  | 'connection-reset'
  | 'timeout'
  | 'invalid-url'
  | 'unsupported-protocol'
  | 'http-status'
  | 'unknown';

export interface HttpRequestOutcome {
  /** HR-HTTP-014:本次执行关联 id(crypto UUID) */
  readonly correlationId: string;
  readonly kind: HttpOutcomeKind;
  /** 传输面原始 ok 布尔:服务层分支语义以此为准(分类不改变行为) */
  readonly transportOk: boolean;
  readonly status: number;
  readonly durationMs: number;
  readonly body: string;
  readonly errorCategory?: HttpErrorCategory;
  readonly errorMessage?: string;
}

/** 每次执行的关联 id:UUID v4(crypto 随机,无时间戳可猜性) */
export function newCorrelationId(): string {
  return randomUUID();
}

/**
 * 传输失败错误信息 → (kind, 细类)。只认自有 transport 的确定性标记
 * (「请求超」前缀/「URL 无法解析」/「不支持的协议」)与 node 网络错误码
 * (ECONNREFUSED/ENOTFOUND/EAI_AGAIN/ECONNRESET);其余如实 unknown。
 */
const classifyTransportError = (error?: string): {
  kind: HttpOutcomeKind;
  category: HttpErrorCategory;
} => {
  const message = error ?? '';
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

/** 传输结果 → 结构化 outcome(HR-HTTP-010 分类面,纯函数) */
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
    ...(ok ? {} : { errorCategory: 'http-status' as const })
  };
}

export interface HttpExecuteDeps {
  /** 缺省用默认 node 传输面;测试注入脚本化应答 */
  readonly transport?: HttpTransport;
  /** 外部给定关联 id(调用方串自己的链路);缺省本函数生成 */
  readonly correlationId?: string;
}

/**
 * 单次执行:生成关联 id → 交换机 send → 传输 → 沉降 → 分类。
 * 状态机由本函数独占推进,send/settle 拒绝即实现 bug(显式抛,不静默);
 * 传输一次一发,不重试(HR-HTTP-009 默认不自动重试状态未知的非幂等更新)。
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
  const result = await transport({
    url: request.url,
    method: request.method,
    headers: request.headers,
    body: request.body,
    timeoutMs: request.timeoutMs
  });
  const settle = machine.advance('settle');
  if (!settle.ok) {
    throw new Error(`执行器状态机拒绝 settle: ${settle.reason}`);
  }
  return classifyExecution(result, correlationId);
}
