/**
 * 只重试失败目标的热更新(IDE-HOT-007):遍历批次聚合(HOT-006)的目
 * 标,只对 outcome=failed 的目标重新发送——已确认成功侧(applied/
 * accepted/sent-unverified,均已发出)不重复发送,重发=重复投递同文
 * 件;每跳发起前探针取消,取消后停止后续发送:已完成的动作保留,未
 * 发起的标 skipped-cancelled 不冒充已发。发送器注入(deps.send),本
 * 模块不碰台账——重发后的结果落账走 HOT-002..004 既有面。
 */

import type { HotReloadTargetKey } from './hotReloadTargetState';
import type { HotReloadBatchSummary } from './hotReloadBatchSummary';

export interface HotReloadSendResult {
  ok: boolean;
  detail?: string;
}

export interface HotReloadRetryDeps {
  send(key: HotReloadTargetKey): HotReloadSendResult | Promise<HotReloadSendResult>;
  /** 每跳发起前探针:true=取消(后续全部不再发起) */
  isCancelled(): boolean;
}

export type HotReloadRetryActionKind = 'resent' | 'skipped-confirmed' | 'skipped-cancelled';

export interface HotReloadRetryAction {
  key: HotReloadTargetKey;
  keyId: string;
  action: HotReloadRetryActionKind;
  /** skipped-confirmed=为什么不发(原状态);skipped-cancelled=取消说明;resent 可选带重发说明 */
  detail?: string;
  /** 仅 resent:重发结果透传(ok=false 如实呈现) */
  result?: HotReloadSendResult;
}

/** 只重试失败目标:成功侧跳过、取消停止后续、动作序跟随批次目标序 */
export async function retryFailedHotReloadTargets(
  summary: HotReloadBatchSummary,
  deps: HotReloadRetryDeps
): Promise<HotReloadRetryAction[]> {
  const actions: HotReloadRetryAction[] = [];
  for (const target of summary.targets) {
    if (target.outcome !== 'failed') {
      actions.push({
        key: target.key,
        keyId: target.keyId,
        action: 'skipped-confirmed',
        detail: `目标状态 ${target.outcome} 非失败:不重复发送(重发=重复投递)`
      });
      continue;
    }
    if (deps.isCancelled()) {
      actions.push({ key: target.key, keyId: target.keyId, action: 'skipped-cancelled', detail: '已取消:停止后续发送(未发起的不冒充已发)' });
      continue;
    }
    const result = await deps.send(target.key);
    const action: HotReloadRetryAction = { key: target.key, keyId: target.keyId, action: 'resent' };
    if (result.detail !== undefined) {
      action.detail = result.detail;
    }
    action.result = result;
    actions.push(action);
  }
  return actions;
}
