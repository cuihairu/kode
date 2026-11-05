/**
 * pendingWork 排干口径(IDE-AUD-019):最终验收的「后台量排干」断言必须
 * 使用真实 pendingWork 返回类型逐项核对 queued/running——2026-10-30 深审
 * F17 反例:旧套件对 Object.values(pending) 逐个与 0 比较,而量规里有
 * 嵌套对象(caches/worker/annotationBuilds),`object === 0` 永假,排干
 * 断言在当前量规形态下不可能通过。
 *
 * 口径(预登记):
 * - 排干面(必须归零才算排干):diagnosticsQueued、diagnosticsInFlight、
 *   annotationUpdates、indexTasksQueued、schemaColdBuilds、
 *   worker.running、worker.queued、annotationBuilds.running/waiting/cancelled;
 * - 容量面(不要求归零,归零反而可疑):caches.parsedDocuments/
 *   databaseSchemas/annotationIndex 是缓存容量量规,worker.queuedBytes/
 *   peakQueuedBytes/budgetRejects 是字节与累计量规——只要在途任务数归零,
 *   容量留存就是正常承接(AUD-019 原文:不以 caches/worker 对象与零比较,
 *   也不要求缓存容量归零)。
 *
 * 本模块零依赖(不 import vscode/extension),纯函数,供真机套件
 * (finalMarks 等)与单测共用。
 */

export interface PendingWorkSnapshot {
  diagnosticsQueued: number;
  diagnosticsInFlight: number;
  annotationUpdates: number;
  caches: {
    parsedDocuments: number;
    databaseSchemas: number;
    annotationIndex: number;
  };
  worker: {
    running: number;
    queued: number;
    queuedBytes: number;
    maxQueuedBytes: number;
    peakQueuedBytes: number;
    budgetRejects: number;
    postedBytes: number;
    maxPostedJobs: number;
    maxPostedBytes: number;
  };
  annotationBuilds: { running: number; waiting: number; cancelled: number };
  indexTasksQueued: number;
  schemaColdBuilds: number;
}

/** 排干面:键=量规路径(嵌套用点),值=当前在途/排队计数;全空=已排干 */
export function drainablePendingWork(
  pending: PendingWorkSnapshot
): Record<string, number> {
  const busy: Record<string, number> = {};
  const count = (key: string, value: number): void => {
    if (value > 0) {
      busy[key] = value;
    }
  };
  count('diagnosticsQueued', pending.diagnosticsQueued);
  count('diagnosticsInFlight', pending.diagnosticsInFlight);
  count('annotationUpdates', pending.annotationUpdates);
  count('indexTasksQueued', pending.indexTasksQueued);
  count('schemaColdBuilds', pending.schemaColdBuilds);
  count('worker.running', pending.worker.running);
  count('worker.queued', pending.worker.queued);
  count('annotationBuilds.running', pending.annotationBuilds.running);
  count('annotationBuilds.waiting', pending.annotationBuilds.waiting);
  count('annotationBuilds.cancelled', pending.annotationBuilds.cancelled);
  return busy;
}
