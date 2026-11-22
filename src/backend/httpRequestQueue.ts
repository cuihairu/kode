/**
 * HR-HTTP-007(RUST-349)按目标有界并发队列:
 * - 同目标(以相同 targetKey 入队)默认串行——FIFO,前一任务结算后下一个才起
 *   (热更同端点请求不互相乱序,旧版本后定稿不先到引擎);
 * - 不同目标相互独立并发,互不排队;
 * - 全局在途上限(globalConcurrency)兜底整层并发,防多目标同时把宿主压爆。
 * 纯逻辑,与传输面解耦:task 是任意返回 Promise 的闭包,队列只负责排序与限流,
 * 任务结果/拒绝如实透传给调用方(拒绝不吞、不停摆,队列照常推进后续任务)。
 * 目标数通常极少(单端点/单通道),出队用顺序扫描即可,不引入堆/复杂调度器
 * (与 HR-HTTP-001 单一执行路径口径一致,不另造并行抽象)。
 */

export interface HttpTargetQueueOptions {
  /** 同目标并发上限;缺省 1(串行) */
  readonly perTargetConcurrency?: number;
  /** 全局在途上限;缺省 4 */
  readonly globalConcurrency?: number;
}

export interface HttpTargetQueue {
  /**
   * 入队执行:按 targetKey 维护 FIFO,返回该任务结果(拒绝如实透传给调用方)。
   * 调用方 await 即获得与该任务自身执行相同的结算语义,只是发起时刻被排队。
   */
  run<T>(targetKey: string, task: () => Promise<T>): Promise<T>;
  /**
   * HR-QA-016 soak 自省:当前内部状态(目标键数/全局在途/排队数)。
   * 全部任务结算后应全零——目标态在 idle 时自删(perTarget.delete),
   * 结算不清=连接泄漏(soak 以此为不变式)。
   */
  stats(): HttpTargetQueueStats;
}

/** HR-QA-016 soak 自省形状:结算后全零=无残留(无连接泄漏) */
export interface HttpTargetQueueStats {
  /** 仍有状态的目标键数(结算完=0) */
  readonly targets: number;
  /** 全局在途(未结算)任务数 */
  readonly inFlight: number;
  /** 排队(已入队未起跑)任务数 */
  readonly pending: number;
}

interface TargetState {
  active: number;
  pending: Array<() => void>;
}

const clampPositive = (value: number | undefined, fallback: number): number =>
  value === undefined || !Number.isInteger(value) || value < 1 ? fallback : value;

export function createHttpTargetQueue(options: HttpTargetQueueOptions = {}): HttpTargetQueue {
  const perTargetConcurrency = clampPositive(options.perTargetConcurrency, 1);
  const globalConcurrency = clampPositive(options.globalConcurrency, 4);
  const perTarget = new Map<string, TargetState>();
  let globalActive = 0;

  const pump = (): void => {
    // 有全局槽且某目标有等待且该目标未达其并发上限 → 出队一个起跑。
    // 目标集极小,顺序扫描足够;扫描一轮后若仍未起任何任务即停(等结算再泵)。
    for (const state of perTarget.values()) {
      if (globalActive >= globalConcurrency) {
        return;
      }
      if (state.active >= perTargetConcurrency || state.pending.length === 0) {
        continue;
      }
      const next = state.pending.shift()!;
      state.active += 1;
      globalActive += 1;
      next();
    }
  };

  const run = <T>(targetKey: string, task: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const start = (): void => {
        // 任务经微任务边界起跑:start 只在 pump 内同步被调,微任务让 task
        // 抛错也落拒绝分支,不在队列内部裸抛。
        void Promise.resolve()
          .then(task)
          .then(
            value => {
              settle();
              resolve(value);
            },
            error => {
              settle();
              reject(error);
            }
          );
      };
      const settle = (): void => {
        const state = perTarget.get(targetKey);
        if (state) {
          state.active = Math.max(0, state.active - 1);
          if (state.active === 0 && state.pending.length === 0) {
            perTarget.delete(targetKey);
          }
        }
        globalActive = Math.max(0, globalActive - 1);
        pump();
      };
      let state = perTarget.get(targetKey);
      if (!state) {
        state = { active: 0, pending: [] };
        perTarget.set(targetKey, state);
      }
      state.pending.push(start);
      pump();
    });

  const stats = (): HttpTargetQueueStats => {
    let pending = 0;
    for (const state of perTarget.values()) {
      pending += state.pending.length;
    }
    return { targets: perTarget.size, inFlight: globalActive, pending };
  };

  return { run, stats };
}
