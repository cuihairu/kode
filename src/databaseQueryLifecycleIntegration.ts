/**
 * 查询生命周期接线(IDE-REV-017):把 databaseQueryLifecycle 的超时/取消
 * 落到真实数据库入口——建连与每条只读查询都走同一套轮询探针。命令层经
 * withProgress 拿用户取消令牌、经 kbengine.databaseQueryTimeoutMs 拿单条
 * 时限;超时/取消立即以带原因的异常返回,连接等底层结算(有上限)后
 * close/destroy 恰一次;建连在命令退出后才落地也兜底关掉,不漏连接。
 */

import {
  runReadOnlyQueryLifecycle,
  type QueryLifecycleOptions
} from './databaseQueryLifecycle';
import type { DriftConnectionFactory, DriftQueryExecutor } from './databaseDrift';

/** 单条查询/建连超时:命令层据此展示「超时并已释放」的原因 */
export class QueryTimeoutError extends Error {
  /** 结构面终态标记:命令层不导入本模块也能识别(连接已在释放) */
  readonly lifecycleTerminal = true as const;
  constructor(
    public readonly what: string,
    public readonly elapsedMs: number,
    public readonly timeoutMs: number
  ) {
    super(`查询超时(${elapsedMs}ms 超过 ${timeoutMs}ms 上限),连接已释放:${what}`);
  }
}

/** 用户取消:命令层据此展示「已取消并已释放」的原因 */
export class QueryCancelledError extends Error {
  readonly lifecycleTerminal = true as const;
  constructor(
    public readonly what: string,
    public readonly elapsedMs: number
  ) {
    super(`查询已取消(用户取消,${elapsedMs}ms 后),连接已释放:${what}`);
  }
}

/** 命令层注入的守卫面:时限 + 取消探针(生产 = withProgress 的令牌) */
export interface QueryGuard {
  timeoutMs: number;
  isCancelled(): boolean;
  now?(): number;
  sleep?(ms: number): Promise<void>;
  releaseDeadlineMs?: number;
  pollMs?: number;
}

const defaultNow = (): number => Date.now();
const defaultSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const lifecycleOptions = (guard: QueryGuard): QueryLifecycleOptions => ({
  timeoutMs: guard.timeoutMs,
  isCancelled: guard.isCancelled,
  now: guard.now ?? defaultNow,
  sleep: guard.sleep ?? defaultSleep,
  releaseDeadlineMs: guard.releaseDeadlineMs,
  pollMs: guard.pollMs
});

/**
 * 查询面守卫:每条 runQuery 过生命周期轮询;completed/failed 原样透传
 * (连接留给下一条/命令收尾),timeout/cancelled 立即抛带原因异常并把
 * 释放挂到后台——等底层结算(超限走 destroy 强制销毁)后 close 恰一次;
 * 终态后面不再收新查询,close() 会先等在途释放完成。
 */
export function guardExecutorWithQueryLifecycle(
  executor: DriftQueryExecutor,
  guard: QueryGuard
): DriftQueryExecutor {
  let dead = false; // 终态标记:超时/取消后不再收新查询
  let releasedDone = false; // close/destroy 恰一次
  let releaseTail: Promise<void> | null = null;
  const closeOnce = async (): Promise<void> => {
    if (releasedDone) {
      return;
    }
    releasedDone = true;
    await executor.close();
  };
  const destroyOnce = async (): Promise<void> => {
    if (releasedDone) {
      return;
    }
    releasedDone = true;
    if (executor.destroy) {
      await executor.destroy();
      return;
    }
    await executor.close();
  };
  return {
    runQuery: async sql => {
      if (dead) {
        throw new Error(`查询未执行:连接已被上一条查询的超时/取消释放:${sql}`);
      }
      const outcome = await runReadOnlyQueryLifecycle(
        () => executor.runQuery(sql),
        () => undefined,
        { ...lifecycleOptions(guard), destroy: destroyOnce }
      );
      if (outcome.kind === 'completed') {
        return outcome.result;
      }
      if (outcome.kind === 'failed') {
        throw outcome.error;
      }
      dead = true;
      // 释放走后台:released 等底层结算(永不结算到 releaseDeadlineMs 走
      // destroyOnce),结算了再补 closeOnce——两条路径合计恰一次
      releaseTail = outcome.released.then(() => closeOnce(), () => closeOnce());
      throw outcome.kind === 'timeout'
        ? new QueryTimeoutError(sql, outcome.elapsedMs, guard.timeoutMs)
        : new QueryCancelledError(sql, outcome.elapsedMs);
    },
    close: async () => {
      if (releaseTail) {
        await releaseTail;
        return;
      }
      await closeOnce();
    }
  };
}

/**
 * 连接工厂守卫:建连本身也过生命周期(挂住的握手同样到点返回);超时/
 * 取消立即抛带原因异常,建连稍后才落地时由在途 promise 兜底关掉,不漏。
 */
export function guardConnectionFactoryWithQueryLifecycle(
  inner: DriftConnectionFactory,
  guard: QueryGuard
): DriftConnectionFactory {
  return async database => {
    let landed: DriftQueryExecutor | null = null;
    let wantClose = false;
    // 命令已退出而建连刚落地:关掉刚拿到的连接(恰一次,置空防重复)
    const closeIfAsked = async (): Promise<void> => {
      if (!wantClose || !landed) {
        return;
      }
      const executor = landed;
      landed = null;
      await executor.close();
    };
    const connecting = (async () => {
      landed = await inner(database);
      await closeIfAsked();
    })();
    const outcome = await runReadOnlyQueryLifecycle(
      () => connecting,
      () => undefined,
      lifecycleOptions(guard)
    );
    if (outcome.kind === 'completed') {
      return guardExecutorWithQueryLifecycle(landed!, guard);
    }
    if (outcome.kind === 'failed') {
      throw outcome.error;
    }
    // 超时/取消:已落地的立刻关;还在途的等一段(有上限)再兜一次,
    // 更晚落地的由 connecting 自己的 closeIfAsked 收尾
    wantClose = true;
    await closeIfAsked();
    await outcome.released;
    await closeIfAsked();
    throw outcome.kind === 'timeout'
      ? new QueryTimeoutError('建连', outcome.elapsedMs, guard.timeoutMs)
      : new QueryCancelledError('建连', outcome.elapsedMs);
  };
}
