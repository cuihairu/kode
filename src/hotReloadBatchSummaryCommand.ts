/**
 * 多目标热更批次聚合的展示入口(IDE-REV-025,原 IDE-HOT-006):台账全量按
 * 目标归并成批次文案——一成一败=partial 点名失败目标与原因,每个目标逐文
 * 件明细都渲染,不以最后一个结果覆盖整批(归并遍历台账全部目标,与最近
 * 一次发到谁无关);无记录如实「无投递记录」;成功只到发出面口径,
 * sent-unverified 不冒充 applied。
 */

import {
  batchHotReloadDetail,
  summarizeHotReloadBatch
} from './hotReloadBatchSummary';
import type { HotReloadTargetStateStore } from './hotReloadTargetState';

/** 批次文案渲染:归并结论在前,每个目标(不论成败)的逐文件明细随后 */
export function renderHotReloadBatchSummary(store: HotReloadTargetStateStore): string {
  const summary = summarizeHotReloadBatch(store);
  const blocks = [batchHotReloadDetail(summary)];
  for (const target of summary.targets) {
    blocks.push(`${target.keyId}(${target.outcome}):`);
    blocks.push(target.reason);
  }
  return blocks.join('\n');
}

/** 展示面注入:落日志块 + 打开通道;测试用假体同形 */
export interface HotReloadBatchSummaryView {
  logBlock(text: string): void;
  show(): void;
}

/** 命令体:渲染即展示,空台账也如实打开(无投递记录) */
export function runHotReloadBatchSummaryCommand(
  store: HotReloadTargetStateStore,
  view: HotReloadBatchSummaryView
): void {
  view.logBlock(renderHotReloadBatchSummary(store));
  view.show();
}
