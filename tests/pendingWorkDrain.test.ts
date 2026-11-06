import { describe, expect, it } from 'vitest';

import {
  drainablePendingWork,
  type PendingWorkSnapshot
} from '../src/pendingWorkDrain';

// IDE-AUD-019:排干断言必须用真实 pendingWork 返回类型逐项核对 queued/running
// ——2026-10-30 深审 F17 反例:旧套件对 Object.values(pending) 逐个 `=== 0`,
// 而 caches/worker/annotationBuilds 是嵌套对象,与 0 比较永假,排干断言在当前
// 量规形态下不可能通过(真机 --final 实际红过)。缓存容量(caches.*)是容量
// 量规不是在途任务,不要求归零;worker.queuedBytes/peakQueuedBytes/budgetRejects
// 是字节/累计量规,同样不进排干口径。

const snapshot = (overrides: Partial<PendingWorkSnapshot> = {}): PendingWorkSnapshot => ({
  diagnosticsQueued: 0,
  diagnosticsInFlight: 0,
  annotationUpdates: 0,
  caches: {
    // 审核发现修复:字段形态对齐真实量规(容量对象而非 number)。
    parsedDocuments: { entries: 12, maxEntries: 64, bytes: 4096, maxBytes: 8192 },
    databaseSchemas: { entries: 3, capacity: 16 },
    annotationIndex: { entries: 5, ttlMs: 60000 }
  },
  worker: {
    running: 0,
    queued: 0,
    queuedBytes: 0,
    maxQueuedBytes: 4_000_000,
    peakQueuedBytes: 1_234,
    budgetRejects: 0,
    postedBytes: 0,
    maxPostedJobs: 8,
    maxPostedBytes: 8_000_000
  },
  annotationBuilds: { running: 0, waiting: 0, cancelled: 0 },
  indexTasksQueued: 0,
  schemaColdBuilds: 0,
  ...overrides
});

describe('IDE-AUD-019 排干口径:真实 pendingWork 结构逐项核对 queued/running', () => {
  it('全排干态:caches 有容量、worker 有高水位也不算忙(旧 `===0` 口径会误判)', () => {
    const pending = snapshot();
    // 旧断言形态对照:对嵌套对象与 0 比较永假——这正是 F17 反例
    expect(Object.values(pending).every(count => count === 0)).toBe(false);
    // 新口径:缓存容量 12/3/5、峰值字节 1234 都在场,但排干面全零
    expect(drainablePendingWork(pending)).toEqual({});
  });

  it('任一队列/在途字段非零都被逐项点名', () => {
    const pending = snapshot({
      diagnosticsQueued: 2,
      worker: {
        running: 1,
        queued: 3,
        queuedBytes: 500,
        maxQueuedBytes: 4_000_000,
        peakQueuedBytes: 500,
        budgetRejects: 0,
        postedBytes: 500,
        maxPostedJobs: 8,
        maxPostedBytes: 8_000_000
      },
      annotationBuilds: { running: 1, waiting: 2, cancelled: 0 }
    });
    expect(drainablePendingWork(pending)).toEqual({
      diagnosticsQueued: 2,
      'worker.running': 1,
      'worker.queued': 3,
      'annotationBuilds.running': 1,
      'annotationBuilds.waiting': 2
    });
  });

  it('缓存容量与字节/峰值/预算拒绝量规不进排干口径', () => {
    const pending = snapshot({
      caches: { parsedDocuments: 999, databaseSchemas: 40, annotationIndex: 77 },
      worker: {
        running: 0,
        queued: 0,
        queuedBytes: 8_000,
        maxQueuedBytes: 4_000_000,
        peakQueuedBytes: 90_000,
        budgetRejects: 6,
        postedBytes: 0,
        maxPostedJobs: 8,
        maxPostedBytes: 8_000_000
      }
    });
    expect(drainablePendingWork(pending)).toEqual({});
  });

  it('shared 量规(indexTasksQueued/schemaColdBuilds)也在排干口径内', () => {
    const pending = snapshot({ indexTasksQueued: 4, schemaColdBuilds: 1 });
    expect(drainablePendingWork(pending)).toEqual({
      indexTasksQueued: 4,
      schemaColdBuilds: 1
    });
  });
});
