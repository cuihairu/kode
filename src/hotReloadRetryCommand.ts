/**
 * 失败目标重试的操作入口(IDE-REV-026,原 IDE-HOT-007):批次台账里只挑
 * outcome=failed 的目标经真实动作入口重新发送——已确认成功侧(applied/
 * accepted/sent-unverified,均已发出)不重发,发送次数不增加(重发=重复
 * 投递);每跳发起前探取消令牌,取消后未发起目标不再发送。重发落账与
 * fire 路径同走 HOT-002..004 既有面:无响应面记 sent-unverified/failed,
 * HTTP 响应按传输事实分类(2xx=未确认送达/非 2xx=failed),2xx 回包逐级
 * 尝试 accepted/applied 升格并排核验窗口结算——重发成功后台账如实翻面,
 * 不留在 failed 旧账上冒充仍未恢复。
 */

import { createHash } from 'crypto';

import { retryFailedHotReloadTargets, type HotReloadRetryAction, type HotReloadSendResult } from './hotReloadRetry';
import { summarizeHotReloadBatch } from './hotReloadBatchSummary';
import {
  HOT_RELOAD_APPLIED_SETTLE_MS,
  type HotReloadHttpResponse,
  type HotReloadSendOptions,
  type HotReloadTargetStateWiring,
  type HotReloadTimerDeps
} from './hotReload';
import type { HotReloadTargetKey, HotReloadTargetStateStore } from './hotReloadTargetState';
import { recordHttpDelivery } from './hotReloadDelivery';
import { applyAcceptedReceipt } from './hotReloadReceipt';
import { settleAppliedStatus, verifyAppliedReceipt } from './hotReloadAppliedCheck';

export interface HotReloadResendDeps {
  /** 实际动作入口(真装配=quickActionManager.runByName 无人值守通道) */
  runAction(actionName: string, sendOptions?: HotReloadSendOptions): void | Promise<unknown>;
  /** targetId → 动作名反查(真装配扫 quick action 树;解不到=null,该目标如实不重发) */
  resolveActionNameForTarget(targetId: string): string | null | Promise<string | null>;
  /** 台账接线(与 fire 路径同一注入面);不注入则重发不落账 */
  readonly targetState?: HotReloadTargetStateWiring;
  /** IDE-REV-027 引擎 digest 证据口:重发回包体喂证据册(与 fire 路径同款) */
  readonly noteEngineDigest?: (
    key: { rootId: string; targetId: string },
    file: string,
    body: string | undefined
  ) => void;
  readonly timers: HotReloadTimerDeps;
  /** applied 核验窗口结算句柄集,随命令释放清(与 fire 路径同口径) */
  readonly settleHandles: Set<unknown>;
  /** 时钟注入口(测试用);缺省真 Date.now */
  readonly now?: () => number;
  /**
   * def 结构闸(RT-3 / IDE-HOT-005):与 fire 路径共用同一实例与同一会话基线
   * 册(hotReloadDefGate)。注入即重发前过闸——结构性 def 变更/无基线/不可读
   * 一律不发送(拦下是保守拦截不是投递失败,不落账),非结构 def 与纯
   * Python 批照常重发。不注入则不设防(与既有装配兼容,真装配必须注入)。
   * F1:闸的 commit 口在重试放行即真实重发时前滚基线(可选,缺省不滚)。
   */
  readonly defGate?: {
    check(files: readonly string[]): Promise<string[]>;
    commit?(files: readonly string[]): Promise<void>;
  };
  /** 结构闸拦下通知(接线方把文件标进状态机 RESTART_REQUIRED 呈现面) */
  readonly onRestartRequired?: (
    targetId: string,
    files: readonly string[],
    reasons: readonly string[]
  ) => void;
}

/** 注解只给仍未确认的记录追加阻塞/超时原因,不动 accepted/applied/failed(与 fire 路径同款);IDE-AUD-005:绑定所属发送代际,旧代注解被拒 */
const noteStillUnverified = (
  wiring: HotReloadTargetStateWiring,
  key: HotReloadTargetKey,
  file: string,
  reason: string,
  attempt: number
): void => {
  const current = wiring.store.get(key, file);
  if (!current || current.outcome !== 'sent-unverified' || (current.detail ?? '').includes(reason)) {
    return;
  }
  wiring.store.record(key, file, 'sent-unverified', {
    detail: [current.detail, reason].filter(Boolean).join(' | '),
    now: current.recordedAt,
    attempt
  });
};

/**
 * 对单一失败目标发起一次真实重发并按既有面落账:文件面=该目标名下全部
 * 有记录文件(动作以实例为接收方,重发整单元投递);响应面语义与 fire
 * 路径逐字对齐。动作反查不到/动作抛错都如实返回 ok=false,不冒充已发。
 */
export async function resendHotReloadTarget(
  store: HotReloadTargetStateStore,
  key: HotReloadTargetKey,
  deps: HotReloadResendDeps
): Promise<HotReloadSendResult> {
  const files = store.files(key);
  // RT-3(IDE-HOT-005):重发前过 def 结构闸,与 fire 路径同一判定、同一会话
  // 基线册。结构性 def 变更/无基线/不可读一律不发普通 reload(拦下是保守拦
  // 截不是投递失败:不落账,台账保留 failed 旧账原样),并发需重启通知。
  if (deps.defGate) {
    const reasons = await deps.defGate.check(files);
    if (reasons.length > 0) {
      deps.onRestartRequired?.(key.targetId, files, reasons);
      const first = reasons[0] ?? 'def 结构待核';
      return {
        ok: false,
        detail: `结构性 def 变更需要重启,重试不发普通 reload:${first}${reasons.length > 1 ? ` 等 ${reasons.length} 项` : ''}`
      };
    }
    // F1:重试放行即真实重发——基线前滚到本次所发内容(与 fire 路径同口
    // 径);被拦批次不走这里,基线保持引擎已加载版本,重复重试持续拦截。
    try {
      await deps.defGate.commit?.(files);
    } catch {
      // 前滚失败不阻塞重发(下次判定按旧基线保守拦)
    }
  }
  const actionName = await deps.resolveActionNameForTarget(key.targetId);
  if (actionName === null) {
    return { ok: false, detail: `找不到以 ${key.targetId} 为接收方的动作,无法重发` };
  }
  const wiring = deps.targetState;
  const now = deps.now ?? Date.now;
  const sentAt = now();
  // IDE-AUD-006:发送前冻结内容核验基准——runAction 之前读一次所发内容算
  // sha256,响应后核验全用它并带进台账 sentDigest;绝不响应后再读文件当前
  // 内容冒充所发版本。读取失败=无基准(如实 undefined,核验面注解阻塞)。
  const baselineReader = wiring?.readFileContent;
  const baselineReads = new Map<string, Promise<string | undefined>>();
  if (baselineReader) {
    for (const file of files) {
      baselineReads.set(
        file,
        Promise.resolve(baselineReader(file))
          .then(content =>
            content === null
              ? undefined
              : createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex')
          )
          .catch(() => undefined)
      );
    }
  }
  let responseSeen = false;
  const handleResponse = (response: HotReloadHttpResponse): void => {
    responseSeen = true;
    if (!wiring) {
      return;
    }
    for (const file of files) {
      // IDE-REV-027:重发回包体喂引擎 digest 证据册(册内判协议与归属)
      deps.noteEngineDigest?.(key, file, response.body);
      // 观察者只在响应到达时触发 → 传输已成功,分类按 status 走
      const record = recordHttpDelivery(wiring.store, key, file, { ok: true, status: response.status }, {});
      // IDE-AUD-005:重发代际——回执/注解/核验结算绑定它,旧代异步结果不改新代记录
      const attempt = record.attempt;
      if (record.outcome === 'sent-unverified' && typeof response.body === 'string' && response.body.length > 0) {
        applyAcceptedReceipt(wiring.store, key, file, response.body, { attempt });
        if (!baselineReader) {
          noteStillUnverified(wiring, key, file, 'applied 核验阻塞:无内容读取通道,digest 无基准', attempt);
        } else {
          void baselineReads.get(file)!.then(sentDigest => {
            if (sentDigest === undefined) {
              noteStillUnverified(
                wiring,
                key,
                file,
                'applied 核验阻塞:发送时点内容基准不可读,digest 无基准',
                attempt
              );
              return;
            }
            // IDE-AUD-006:发送时点冻结的基准带进台账(可审计);代际守卫下
            // 只在当前代写(换代则拒,旧代基准不污染新代记录),且不改写
            // 已升格的 outcome(accepted/applied 原样保留)
            const currentAtWrite = wiring.store.get(key, file);
            if (currentAtWrite) {
              wiring.store.record(key, file, currentAtWrite.outcome, { sentDigest, attempt });
            }
            const verdict = verifyAppliedReceipt(wiring.store, key, file, response.body as string, {
              sentDigest,
              attempt
            });
            if (verdict.kind === 'not-applied') {
              noteStillUnverified(wiring, key, file, `applied 核验阻塞:${verdict.reason}`, attempt);
            }
          });
        }
        // 核验窗口到点结算:仍未确认只注解超时,不冒充任何终态;代际不符则不动
        const handle = deps.timers.set(() => {
          deps.settleHandles.delete(handle);
          const current = wiring.store.get(key, file);
          if (!current || current.attempt !== attempt) {
            return;
          }
          const verdict = settleAppliedStatus(current, {
            deadlineMs: sentAt + HOT_RELOAD_APPLIED_SETTLE_MS,
            now
          });
          if (verdict === 'unconfirmed-timeout') {
            noteStillUnverified(
              wiring,
              key,
              file,
              `applied 核验超时(${Math.round(HOT_RELOAD_APPLIED_SETTLE_MS / 1000)}s 窗口):保持未确认`,
              attempt
            );
          }
        }, HOT_RELOAD_APPLIED_SETTLE_MS);
        deps.settleHandles.add(handle);
      }
    }
  };
  const sendOptions: HotReloadSendOptions | undefined = wiring ? { onHttpResponse: handleResponse } : undefined;
  try {
    // AUD-053:quick action 通道 false=未执行/失败且 resolve 不 reject——旧
    // 实现 await 后直接记 sent-unverified 并返回 ok:true,false 被冒充成重发
    // 成功;必须如实 ok=false+落 failed。
    const echoed = await Promise.resolve(deps.runAction(actionName, sendOptions));
    if (echoed === false) {
      const message = 'quick action 回执 false:未执行/失败';
      if (!responseSeen && wiring) {
        for (const file of files) {
          wiring.store.record(key, file, 'failed', { detail: message });
        }
      }
      return { ok: false, detail: message };
    }
    if (!responseSeen && wiring) {
      // 无响应面(脚本/命令动作):传输/执行成功≠应用成功,只记未确认
      for (const file of files) {
        wiring.store.record(key, file, 'sent-unverified', {});
      }
    }
    return {
      ok: true,
      detail: responseSeen ? '已重新发送(响应已按传输事实落账)' : '已重新发送(未确认——无回执面)'
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!responseSeen && wiring) {
      for (const file of files) {
        wiring.store.record(key, file, 'failed', { detail: message });
      }
    }
    return { ok: false, detail: message };
  }
}

const ACTION_LABELS: Record<HotReloadRetryAction['action'], string> = {
  resent: '已重发',
  'skipped-confirmed': '不重发(已确认侧,重发=重复投递)',
  'skipped-cancelled': '跳过(已取消,未发起不冒充已发)'
};

/** 重试报告:头部计数 + 逐目标动作行(含重发结果透传,失败如实呈现) */
export function renderHotReloadRetryReport(actions: HotReloadRetryAction[]): string {
  if (actions.length === 0) {
    return '无投递记录,没有可重试的目标';
  }
  const count = (kind: HotReloadRetryAction['action']): number => actions.filter(a => a.action === kind).length;
  const lines = [
    `失败目标重试:重发 ${count('resent')} 个,不重发(已确认侧) ${count('skipped-confirmed')} 个,取消跳过 ${count('skipped-cancelled')} 个`
  ];
  for (const action of actions) {
    lines.push(`${action.keyId} → ${ACTION_LABELS[action.action]}`);
    if (action.detail !== undefined) {
      lines.push(`  ${action.detail}`);
    }
    if (action.action === 'resent' && action.result) {
      lines.push(`  重发结果: ${action.result.ok ? '已发送' : '失败'}${action.result.detail !== undefined ? `:${action.result.detail}` : ''}`);
    }
  }
  return lines.join('\n');
}

/** 展示面注入:落日志块 + 打开通道;测试用假体同形 */
export interface HotReloadRetryView {
  logBlock(text: string): void;
  show(): void;
}

export interface HotReloadRetryCommandDeps extends HotReloadResendDeps {
  /** 取消探针:每跳发起前探一次,真装配=withProgress 进度通知令牌 */
  isCancelled(): boolean;
}

/** 命令体:聚合台账→只重试失败目标→报告落「KBEngine 热更新」通道;空台账如实无可重试 */
export async function runHotReloadRetryCommand(
  store: HotReloadTargetStateStore,
  deps: HotReloadRetryCommandDeps,
  view: HotReloadRetryView
): Promise<void> {
  const summary = summarizeHotReloadBatch(store);
  if (summary.status === 'no-targets') {
    view.logBlock(renderHotReloadRetryReport([]));
    view.show();
    return;
  }
  const actions = await retryFailedHotReloadTargets(summary, {
    send: key => resendHotReloadTarget(store, key, deps),
    isCancelled: () => deps.isCancelled()
  });
  view.logBlock(renderHotReloadRetryReport(actions));
  view.show();
}
