// IDE-SCH-006: the schema rebuild background task face — after the first scan
// completes, enqueue snapshot builds per entity into the unified index scheduler
// (non-interactive priority), so the cold schema computation happens in the
// background instead of on first hover/open; interactive tasks have higher
// priority (yielding at edit peaks), one task per entity = natural chunking, and
// cancellation/workspace evolution stops immediately. The interactive query path
// itself is unchanged (synchronously hits the cache); it just changes from "pay
// the cold start on first interaction" to "the background pays first".

import { IndexScheduler, IndexTaskPriority } from './indexScheduler';
import { buildDatabaseSchemaSnapshotAsync } from '../databaseSchema';

export interface SchemaWarmupDeps {
  /** Wait before each entity build (test gate: hang to observe cancellation and chunking; production defaults to passthrough) */
  beforeBuild?: (entityName: string) => Promise<void>;
}

export interface SchemaWarmupHandle {
  /** Settles after all tasks reach a terminal state: resolves with the number of built entities (cancellation also settles, does not reject) */
  wait: Promise<number>;
  /** Cancel tasks not yet running; a running task checks the flag before building and produces no new snapshot */
  cancel(reason?: string): void;
  /** Number of built entities (real-time observation face) */
  builtCount(): number;
}

/**
 * Enqueue background schema snapshot builds per entity. One non-interactive task
 * per entity (scheduler semantics: interactive tasks being queued / inside the
 * cooldown window keep off the main thread); built/invalid is decided by the cache
 * ruling (a hit skips the build, SCH-002). 2026-10-28 audit fix: the build goes
 * through the async stage gate face (buildDatabaseSchemaSnapshotAsync) — yields
 * to the host between stages, cancellation stops immediately mid-build; no longer
 * calls getDatabaseSchemaSnapshot synchronously for the whole stretch.
 */
export function scheduleBackgroundSchemaWarmup(
  scheduler: IndexScheduler,
  workspaceRoot: string,
  entityNames: readonly string[],
  deps: SchemaWarmupDeps = {}
): SchemaWarmupHandle {
  let cancelled = false;
  let built = 0;
  const handles: Array<{ cancel(reason?: string): void; wait: Promise<void> }> = [];

  for (const entityName of entityNames) {
    if (entityName) {
      handles.push(scheduler.enqueue({
        kind: 'non-interactive',
        priority: IndexTaskPriority.NonInteractive,
        run: async () => {
          if (cancelled) { return; }
          await deps.beforeBuild?.(entityName);
          if (cancelled) { return; } // cancelled during the gate: no new snapshot is produced
          const snapshot = await buildDatabaseSchemaSnapshotAsync(entityName, workspaceRoot, {
            gate: async () => {
              await new Promise<void>(resolve => { setImmediate(resolve); });
              return !cancelled; // cancelled mid-build: stop, do not publish
            }
          });
          if (snapshot) { built += 1; }
        }
      }));
    }
  }

  const wait = Promise.all(
    handles.map(handle => handle.wait.then(() => undefined, () => undefined))
  ).then(() => built);

  return {
    wait,
    cancel(reason = 'schema-warmup-cancelled'): void {
      if (cancelled) { return; }
      cancelled = true;
      for (const handle of handles) {
        handle.cancel(reason);
      }
    },
    builtCount(): number {
      return built;
    }
  };
}
