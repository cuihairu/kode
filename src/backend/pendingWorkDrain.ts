/**
 * pendingWork drain accounting (IDE-AUD-019): the final-acceptance "background volume
 * drained" assertion must check queued/running item by item against the real pendingWork
 * return type -- 2026-10-30 deep-audit F17 counterexample: the old suite compared each
 * entry of Object.values(pending) against 0, but the gauges contain nested objects
 * (caches/worker/annotationBuilds), so `object === 0` is always false and the drain
 * assertion could never pass in the current gauge shape.
 *
 * Accounting (pre-registered):
 * - Drain surface (must reach zero to count as drained): diagnosticsQueued,
 *   diagnosticsInFlight, annotationUpdates, indexTasksQueued, schemaColdBuilds,
 *   worker.running, worker.queued, annotationBuilds.running/waiting/cancelled;
 * - Capacity surface (zero is not required, and zero would actually be suspicious):
 *   caches.parsedDocuments/databaseSchemas/annotationIndex are cache-capacity gauges,
 *   and worker.queuedBytes/peakQueuedBytes/budgetRejects are byte and cumulative gauges --
 *   as long as the in-flight task count reaches zero, the retained capacity is normal
 *   carry-over (AUD-019 verbatim: do not compare the caches/worker objects against zero,
 *   and do not require cache capacity to reach zero).
 *
 * This module has zero dependencies (no vscode/extension imports), pure functions, shared
 * by the real-machine suites (finalMarks etc.) and the unit tests.
 */

export interface PendingWorkSnapshot {
  diagnosticsQueued: number;
  diagnosticsInFlight: number;
  annotationUpdates: number;
  /**
   * Capacity gauges (outside the drain accounting): the field shapes match the real gauge
   * function returns -- parsedDocuments=getParsedDocumentCacheGauge(defParser),
   * databaseSchemas=getDatabaseSchemaCacheGauge(databaseSchema),
   * annotationIndex=getReturnAnnotationCacheGauge(pythonReturnTypeInference).
   * Found by audit: these were previously declared as number, which mismatched the type
   * as soon as a real pendingWork() was fed in.
   */
  caches: {
    parsedDocuments: { entries: number; maxEntries: number; bytes: number; maxBytes: number };
    databaseSchemas: { entries: number; capacity: number };
    annotationIndex: { entries: number; ttlMs: number };
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

/** Drain surface: key = gauge path (dotted for nesting), value = current in-flight/queued count; all empty = drained */
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
