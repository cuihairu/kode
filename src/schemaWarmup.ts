// IDE-SCH-006:schema 重建后台任务面——首扫完成后逐实体把快照构建入队到
// 统一索引调度器(非交互优先级),冷 schema 计算发生在后台而不是首次悬停/
// 打开;交互任务优先级更高(编辑高峰让路),逐实体一条任务 = 天然分块,
// 取消/工作区演化即刻止步。交互查询路径本身不变(同步命中缓存),只是从
// 「首次交互付冷启动」变成「后台先付」。

import { IndexScheduler, IndexTaskPriority } from './indexScheduler';
import { getDatabaseSchemaSnapshot } from './databaseSchema';

export interface SchemaWarmupDeps {
  /** 每个实体构建前等待(测试闸:挂起以观察取消与分块;生产缺省直通) */
  beforeBuild?: (entityName: string) => Promise<void>;
}

export interface SchemaWarmupHandle {
  /** 全部任务终态后结算:resolve(已构建实体数)(取消也结算,不拒绝) */
  wait: Promise<number>;
  /** 取消尚未运行的任务;运行中的任务在构建前检查旗标,不再产出新快照 */
  cancel(reason?: string): void;
  /** 已构建实体数(实时观测面) */
  builtCount(): number;
}

/**
 * 逐实体入队 schema 快照后台构建。每个实体一条 non-interactive 任务
 * (调度器语义:交互任务入队/冷却窗口内不上主线程);已建/失效由
 * getDatabaseSchemaSnapshot 自身缓存口径裁断(命中即免建,SCH-002)。
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
          if (cancelled) { return; } // 闸门期间被取消:不再产出新快照
          const snapshot = getDatabaseSchemaSnapshot(entityName, workspaceRoot);
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
