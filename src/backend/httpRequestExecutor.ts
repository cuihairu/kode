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
import type { HttpTargetQueue } from './httpRequestQueue';

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

/** HR-HTTP-010 结果分类(传输事实决定,不猜);HR-HTTP-008 增取消类 */
export type HttpOutcomeKind =
  | 'ok'
  | 'non-2xx'
  | 'timeout'
  | 'network-error'
  | 'invalid-url'
  | 'unsupported-protocol'
  | 'cancelled';

/** 错误细类(对齐 HR-STATE-010 可操作原因面;推不出=unknown) */
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
  /** HR-HTTP-014:本次执行关联 id(crypto UUID) */
  readonly correlationId: string;
  readonly kind: HttpOutcomeKind;
  /** 传输面原始 ok 布尔:服务层分支语义以此为准(分类不改变行为) */
  readonly transportOk: boolean;
  readonly status: number;
  readonly durationMs: number;
  readonly body: string;
  readonly bodyTruncated?: true;
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
    ...(result.bodyTruncated ? { bodyTruncated: result.bodyTruncated } : {}),
    ...(ok ? {} : { errorCategory: 'http-status' as const })
  };
}

export interface HttpExecuteDeps {
  /** 缺省用默认 node 传输面;测试注入脚本化应答 */
  readonly transport?: HttpTransport;
  /** 外部给定关联 id(调用方串自己的链路);缺省本函数生成 */
  readonly correlationId?: string;
  /**
   * HR-HTTP-007(RUST-349)按目标有界并发队列(注入才限流:同目标串行、
   * 不同目标独立并发、全局上限兜底)。缺省不套队列——自动热更 fire 路径
   * 有既有钉死的「重叠波次在途+代际守卫」契约(HR-WATCH-011,旧响应不得
   * 冒充新版本,tests/hotReloadRevisionGate),全局强串行会废掉该守卫的
   * 实路径并拖慢新版发送(旧请求挂到超时,新版本排队等满额预算);谁要
   * 有界并发谁注入(快捷请求面已接),不在执行器层替全体调用方定死。
   */
  readonly queue?: HttpTargetQueue;
  /**
   * HR-HTTP-008(RUST-350)取消信号透传给传输面:中止在途请求,结算
   * kind='cancelled'(取消≠远端撤销,调用方按 uncertain 口径展示)。
   * 缺省无信号=不可取消(既有行为不变)。
   */
  readonly signal?: AbortSignal;
}

/** 队列目标键:URL origin(协议+主机+端口);URL 无法解析时按原样键(分组不靠猜) */
const targetKeyOf = (url: string): string => {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
};

/**
 * 单次执行:生成关联 id → 交换机 send → (注入队列则按目标有界并发)→ 传输 → 沉降 → 分类。
 * 状态机由本函数独占推进,send/settle 拒绝即实现 bug(显式抛,不静默);
 * 传输一次一发,不重试(HR-HTTP-009 默认不自动重试状态未知的非幂等更新;
 * 取消/超时/连接拒绝/未知状态一律恰一次,不自动重发——重发对非幂等更新
 * 是重复投递,状态未知时冒充恢复即谎报)。
 * 重试开启仅剩一条门:服务端提供 idempotency key(接收端契约)→有界退避
 * 重试。该门当前无端点满足——engine 热更端点无幂等契约,而 Idempotency-Key
 * 请求头=线路字节变更,与 HR-HTTP-014 请求头贯穿同界(HR-AUDIT-009 接收端
 * 契约解冻后以显式开关交付)。故本层零自动重试是当前唯一真实路径,不建
 * 闲置重试抽象(「只收编残差,不建抽象」口径);
 * 队列只约束发起时刻,不改传输语义——排队等待不计入请求超时预算。
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
