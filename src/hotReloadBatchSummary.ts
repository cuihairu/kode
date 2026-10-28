/**
 * 按目标聚合热更投递结果(IDE-HOT-006):跨目标归并批次状态——两个目标
 * 一成一败显示 partial,各目标原因可查。目标级归并=名下任一文件记录
 * failed 即该目标 failed,否则任一 sent-unverified 即 sent-unverified,
 * 再否则任一 accepted 即 accepted,全 applied 才 applied(最差面胜出,
 * 不拿同目标的绿灯文件盖掉红灯文件)。批次=全部 failed→all-failed/有
 * 败有成→partial/无败→all-succeeded/无记录→no-targets。成功=发出面
 * 口径(HOT-002),sent-unverified 不冒充 applied——明细逐文件如实。
 */

import {
  buildHotReloadTargetKeyId,
  type HotReloadDeliveryOutcome,
  type HotReloadTargetKey,
  type HotReloadTargetStateStore
} from './hotReloadTargetState';

export type HotReloadBatchStatus = 'no-targets' | 'all-succeeded' | 'partial' | 'all-failed';

export interface HotReloadTargetFileView {
  /** 绝对路径 */
  file: string;
  outcome: HotReloadDeliveryOutcome;
  detail?: string;
}

export interface HotReloadTargetSummary {
  key: HotReloadTargetKey;
  /** 稳定串形(rootId::targetId,展示直用) */
  keyId: string;
  /** 目标级归并(名下最差面) */
  outcome: HotReloadDeliveryOutcome;
  /** 逐文件 `file → outcome(detail)` 换行串,各自原因可查 */
  reason: string;
  files: HotReloadTargetFileView[];
}

export interface HotReloadBatchSummary {
  status: HotReloadBatchStatus;
  /** 按 rootId、targetId 字典序稳定 */
  targets: HotReloadTargetSummary[];
}

/** 最差面胜出:failed > sent-unverified > accepted > applied */
const OUTCOME_RANK: Record<HotReloadDeliveryOutcome, number> = {
  failed: 3,
  'sent-unverified': 2,
  accepted: 1,
  applied: 0
};

const fileLine = (view: HotReloadTargetFileView): string =>
  `${view.file} → ${view.outcome}${view.detail !== undefined ? `(${view.detail})` : ''}`;

/**
 * 聚合台账记录:keys 缺省=台账全部目标;点名目标无记录(如已
 * clearTarget)不进聚合。
 */
export function summarizeHotReloadBatch(
  store: HotReloadTargetStateStore,
  options: { keys?: HotReloadTargetKey[] } = {}
): HotReloadBatchSummary {
  const keys = options.keys ?? store.targetsWithRecords();
  const targets: HotReloadTargetSummary[] = [];
  for (const key of keys) {
    const files: HotReloadTargetFileView[] = [];
    for (const file of store.files(key)) {
      const record = store.get(key, file);
      if (!record) {
        continue;
      }
      const view: HotReloadTargetFileView = { file, outcome: record.outcome };
      if (record.detail !== undefined) {
        view.detail = record.detail;
      }
      files.push(view);
    }
    if (files.length === 0) {
      continue;
    }
    const outcome = files.reduce(
      (worst, view) => (OUTCOME_RANK[view.outcome] > OUTCOME_RANK[worst] ? view.outcome : worst),
      'applied' as HotReloadDeliveryOutcome
    );
    targets.push({
      key,
      keyId: buildHotReloadTargetKeyId(key),
      outcome,
      reason: files.map(fileLine).join('\n'),
      files
    });
  }
  targets.sort((a, b) => a.keyId.localeCompare(b.keyId));
  let status: HotReloadBatchStatus;
  if (targets.length === 0) {
    status = 'no-targets';
  } else if (targets.every(target => target.outcome === 'failed')) {
    status = 'all-failed';
  } else if (targets.some(target => target.outcome === 'failed')) {
    status = 'partial';
  } else {
    status = 'all-succeeded';
  }
  return { status, targets };
}

/** 批次标注文案:partial 点名失败目标与原因;all-succeeded 提示看明细(不冒充 applied) */
export function batchHotReloadDetail(summary: HotReloadBatchSummary): string {
  if (summary.status === 'no-targets') {
    return '无投递记录';
  }
  const failedTargets = summary.targets.filter(target => target.outcome === 'failed');
  if (summary.status === 'all-failed') {
    return `全部失败(${summary.targets.length} 个目标):\n${failedTargets.map(t => `${t.keyId}\n${t.reason}`).join('\n')}`;
  }
  if (summary.status === 'partial') {
    return [
      `部分成功:${failedTargets.length}/${summary.targets.length} 个目标失败`,
      ...failedTargets.map(target => `${target.keyId}\n${target.reason}`),
      '(成功目标见各自明细,应用确认态以逐目标台账为准)'
    ].join('\n');
  }
  return `全部目标发出面成功(${summary.targets.length} 个);应用确认态(applied/accepted/未证实)见各目标明细,不以批次文案冒充`;
}
