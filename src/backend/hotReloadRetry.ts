/**
 * Hot reload that only retries failed targets (IDE-HOT-007): walks the
 * targets of the batch aggregation (HOT-006) and re-sends only the ones with
 * outcome=failed -- the confirmed-success side (applied/accepted/
 * sent-unverified, all already dispatched) is not re-sent, since re-sending
 * means duplicately delivering the same file; a cancel probe runs before
 * each hop starts, and once cancelled the remaining sends stop: completed
 * actions are kept, ones never started are marked skipped-cancelled rather
 * than masquerading as sent. The sender is injected (deps.send) and this
 * module never touches the ledger -- recording post-resend results goes
 * through the existing HOT-002..004 surfaces.
 */

import type { HotReloadTargetKey } from './hotReloadTargetState';
import type { HotReloadBatchSummary } from './hotReloadBatchSummary';

export interface HotReloadSendResult {
  ok: boolean;
  detail?: string;
}

export interface HotReloadRetryDeps {
  send(key: HotReloadTargetKey): HotReloadSendResult | Promise<HotReloadSendResult>;
  /** Probe before each hop starts: true = cancelled (nothing further is started) */
  isCancelled(): boolean;
}

export type HotReloadRetryActionKind = 'resent' | 'skipped-confirmed' | 'skipped-cancelled';

export interface HotReloadRetryAction {
  key: HotReloadTargetKey;
  keyId: string;
  action: HotReloadRetryActionKind;
  /** skipped-confirmed = why it was not sent (original state); skipped-cancelled = cancellation explanation; resent may optionally carry a resend explanation */
  detail?: string;
  /** resent only: the resend result passed through as-is (ok=false is shown honestly) */
  result?: HotReloadSendResult;
}

/** Retry failed targets only: the success side is skipped, cancellation stops the rest, and action order follows the batch target order */
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
