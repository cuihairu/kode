/**
 * 将 HTTP 发送成功记为未确认(IDE-HOT-002):投递分类器只认传输事实
 * ——2xx=已送达(sent-unverified,绿色但明示应用层未证实),非 2xx/
 * 传输失败=failed 点名原因;回包 body 一律不作为应用证据(自称
 * applied/ok 也不升格——回执解读是 HOT-003+ 的事,本级不猜)。
 * 分类结果直接落 HOT-001 的双维隔离台账。
 */

import type { HotReloadDeliveryRecord, HotReloadTargetKey, HotReloadTargetStateStore } from './hotReloadTargetState';

/** 分类输入:与 httpRequestService.HttpExecutionResult 的传输面同形 */
export interface HttpDeliveryLike {
  ok: boolean;
  status: number;
  error?: string;
}

export interface HttpDeliveryVerdict {
  outcome: 'sent-unverified' | 'failed';
  detail: string;
}

/** 只认传输事实:2xx→未确认送达;其余一律 failed,body 不读 */
export function classifyHttpDelivery(result: HttpDeliveryLike): HttpDeliveryVerdict {
  if (!result.ok) {
    return { outcome: 'failed', detail: `HTTP 发送失败:${result.error ?? '未知错误'}` };
  }
  if (result.status >= 200 && result.status <= 299) {
    return {
      outcome: 'sent-unverified',
      detail: `HTTP ${result.status}:已送达,应用层未证实(回执不在此级解读)`
    };
  }
  return { outcome: 'failed', detail: `HTTP 状态 ${result.status}:非 2xx 不算送达` };
}

/** 分类即入账:结果连同 detail 落到 (rootId,targetId,file) 键上 */
export function recordHttpDelivery(
  store: HotReloadTargetStateStore,
  key: HotReloadTargetKey,
  file: string,
  result: HttpDeliveryLike,
  options: { now?: number } = {}
): HotReloadDeliveryRecord {
  const { outcome, detail } = classifyHttpDelivery(result);
  return store.record(key, file, outcome, { detail, now: options.now });
}
