/**
 * Background warmup stage pipeline (the BG-WARM batch).
 *
 * Stage composition (all reuse existing chains; no second set of semantics):
 * 1. discovery      —— the discovery chain's initial scan (entityMappingManager.waitForInitialScan;
 *                      activate already ran ensureStartup, so this only waits for the same round, no restart);
 * 2. eventIndex     —— WorkspaceIndex's full initial .py event/method scan (ensureStarted
 *                      is idempotent, reusing the in-flight task);
 * 3. pythonClassIndex —— the python class index's full initial scan (waitForInitialScan is single-flight
 *                      idempotent; the 2026-11-23 user order "class index into the status bar");
 * 4. dependencyGraph —— the dependency graph, Rust first + TS fall back (same source as the panel's
 *                      on-the-fly computation; the 'dependencyGraph' artifact feeds the panel's read-only cache);
 * 5. definitionLayout —— preheat the definition workspace layout (the KR-AUD-36 hot path: the panel/hover
 *                      first query no longer pays the cold layout parse; timing moved, semantics unchanged);
 * 6. flowGraphs     —— per-entity architecture flow graphs (mapWithConcurrency bounded concurrency,
 *                      the KR-AUD-35 semantics; artifact 'flowGraph:<entity>').
 *
 * deps are fully injected: unit tests drive it with stand-ins; extension.ts wires the real implementations.
 */

import { mapWithConcurrency, WARMUP_SCAN_CONCURRENCY } from './backgroundWarmup';
import type { WarmupStageDef } from './backgroundWarmup';

/** Per-item macrotask yield inside a stage (same cadence as the controller's inter-stage yield: the setImmediate boundary) */
const yieldToHost = (): Promise<void> => new Promise(resolve => { setImmediate(resolve); });

/** Dependency-graph artifact: a Rust source or a TS fall-back source (the panel normalizes by kind; the rendering semantics are unchanged) */
export interface DependencyGraphSource {
  readonly kind: 'rust' | 'ts';
  readonly graph: unknown;
}

export interface WarmupStageDeps {
  /** Handle awaiting the discovery chain's initial scan (reuses the round already started by activate); onProgress = throttled
   * per-file progress inside the stage (WARM-VISIBILITY-004 cut A: def N/M pushed to the status-bar message) */
  waitForDiscovery(onProgress?: (detail: string) => void): Promise<void>;
  /** The event index's full initial scan (ensureStarted idempotent); onProgress as above (N/M files) */
  ensureEventIndex(onProgress?: (detail: string) => void): Promise<void>;
  /** The python class index's full initial scan (waitForInitialScan single-flight idempotent); onProgress as above */
  ensurePythonClassIndex(onProgress?: (detail: string) => void): Promise<void>;
  /** Dependency-graph computation (Rust first, TS falls back; same source as the panel's on-the-fly computation) */
  buildDependencyGraph(): Promise<DependencyGraphSource>;
  /** The registered entity list (input of the flow-graph stage) */
  listFlowEntities(): readonly string[];
  /** A single entity's architecture flow graph (same source as EntityFlowWebView.buildGraph; null when unregistered) */
  buildFlowGraph(entityName: string): unknown;
  /** Preheat the definition workspace layout (the KR-AUD-36 hot-path first query) */
  preheatDefinitionLayout(): void;
  /** Per-item progress inside a stage (status-bar message detail) */
  report?(detail: string): void;
}

export function createWarmupStages(deps: WarmupStageDeps): WarmupStageDef[] {
  return [
    {
      key: 'discovery',
      label: '实体发现链',
      run: async () => {
        await deps.waitForDiscovery(detail => { deps.report?.(detail); });
      }
    },
    {
      key: 'eventIndex',
      label: '事件/方法索引',
      run: async () => {
        await deps.ensureEventIndex(detail => { deps.report?.(detail); });
      }
    },
    {
      // Full python class index scan (the 2026-11-23 user order "class index into the status bar"): single-flight
      // idempotent; when the class index already started itself, this only waits for the same round and mirrors its N/M detail
      key: 'pythonClassIndex',
      label: 'python 类索引',
      run: async () => {
        await deps.ensurePythonClassIndex(detail => { deps.report?.(detail); });
      }
    },
    {
      key: 'dependencyGraph',
      label: '实体依赖图',
      run: async ctx => {
        const source = await deps.buildDependencyGraph();
        ctx.publish('dependencyGraph', source);
      },
      expectedArtifacts: ['dependencyGraph']
    },
    {
      key: 'definitionLayout',
      label: '定义布局预热',
      run: async () => {
        deps.preheatDefinitionLayout();
      }
    },
    {
      key: 'flowGraphs',
      label: '实体架构流程图',
      run: async ctx => {
        const entities = deps.listFlowEntities();
        // Declare the dynamic list first: all entity keys land on running before each is
        // computed — a panel opened mid-stage reads running (a progress page + reuse of the
        // in-flight Promise), not missing (which would spawn a separate on-the-fly computation).
        for (const entityName of entities) {
          ctx.declare(`flowGraph:${entityName}`);
        }
        let built = 0;
        await mapWithConcurrency(
          entities,
          ctx.concurrency,
          async entityName => {
            // Macrotask yield: graph building is synchronous CPU work; yield per item so the
            // host event loop takes a beat and long lists do not pin interaction; after the
            // yield the cancel flag is visible, so a cancel builds no new graphs.
            await yieldToHost();
            if (ctx.token.isCancellationRequested) {
              return;
            }
            const graph = await deps.buildFlowGraph(entityName);
            // Unregistered entities (null) also settle honestly as done:null — the key does
            // not dangle; the panel falls back to its own on-the-fly/hint path on "no value"
            // and never waits forever for an artifact that will never come.
            ctx.publish(`flowGraph:${entityName}`, graph ?? null);
            built += 1;
            deps.report?.(`流程图 ${built}/${entities.length}`);
          },
          { stop: () => ctx.token.isCancellationRequested }
        );
      }
    }
  ];
}

/** Per-entity flow-graph concurrency default (if the production wiring does not configure concurrency explicitly, WARMUP_SCAN_CONCURRENCY is used) */
export const WARMUP_FLOW_CONCURRENCY = WARMUP_SCAN_CONCURRENCY;
