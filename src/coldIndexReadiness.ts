/**
 * 冷索引就绪竞速共享核(RUST-004-W1/W2/W3):数据字典、SpaceData、事件
 * 索引三面同判据同预算。本模块不依赖 vscode(token 用结构兼容的最小形状),
 * provider 与索引实现两侧共同消费,判定逻辑只此一份。
 *
 * 三态:'ready'=初扫在预算内完成(快扫描路径与旧行为完全一致);
 * 'pending'=预算耗尽而初扫仍在飞——请求立即返回,消费面走 marked 查询拿
 * 已入索引的部分真实内容(partial-real,不装完整),初扫作为后台预热单独
 * 继续跑(完成后的下一次请求自然拿到全量);"cancelled"=取消先到(调用方
 * 停止后续查找工作)。无 token 的程序化调用仍等全量(离线语义:要完整
 * 数据,无请求预算可讲)。预算经 KODE_DATA_DICT_READY_BUDGET_MS 覆盖
 * (测试挂死初扫用),非法值诚实回缺省。
 */

/** 冷索引请求上下文(结构兼容 vscode.CancellationToken) */
export interface ColdIndexToken {
  readonly isCancellationRequested: boolean;
  onCancellationRequested?(listener: () => void): { dispose(): void };
}

export type ColdIndexReadiness = 'ready' | 'pending' | 'cancelled';

export const DATA_DICT_READY_DEFAULT_BUDGET_MS = 1500;

export function resolveColdIndexReadyBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.KODE_DATA_DICT_READY_BUDGET_MS;
  if (raw === undefined || raw === '') {
    return DATA_DICT_READY_DEFAULT_BUDGET_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DATA_DICT_READY_DEFAULT_BUDGET_MS;
}

/**
 * 冷索引就绪竞速共享核(W1/W2/W3 同判据):初扫完成 ready / 预算耗尽
 * pending(初扫继续后台跑,预热单独调度)/ 取消 cancelled。
 */
export async function raceColdIndexReadiness(
  starting: Promise<void>,
  token: ColdIndexToken,
  budgetMs: number
): Promise<ColdIndexReadiness> {
  let onDone: (() => void) | undefined;
  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  const clearBudgetTimer = (): void => {
    if (budgetTimer !== undefined) {
      clearTimeout(budgetTimer);
      budgetTimer = undefined;
    }
  };
  // 取消订阅面缺失(手写桩 token 只有旗标)→ 退化为预算竞速+收尾取消复检
  if (typeof token.onCancellationRequested !== 'function') {
    try {
      const winner = await Promise.race([
        starting.then(() => 'ready' as const),
        new Promise<'pending'>(resolve => {
          budgetTimer = setTimeout(() => resolve('pending'), budgetMs);
        })
      ]);
      if (winner === 'pending') {
        // 初扫继续后台跑(预热单独调度);其失败无人消费时会成 unhandled
        // rejection——挂 no-op 兜底(ensureStarted 失败自清 starting,下次
        // 请求会重试初扫,错误不被吞进静默成功)
        void starting.catch(() => undefined);
        return token.isCancellationRequested ? 'cancelled' : 'pending';
      }
      return token.isCancellationRequested ? 'cancelled' : 'ready';
    } finally {
      clearBudgetTimer();
    }
  }
  const cancelWins = new Promise<null>(resolve => {
    const d = token.onCancellationRequested!(() => resolve(null));
    onDone = () => d.dispose();
  });
  try {
    const winner = await Promise.race([
      starting.then(() => 'ready' as const),
      cancelWins,
      new Promise<'pending'>(resolve => {
        budgetTimer = setTimeout(() => resolve('pending'), budgetMs);
      })
    ]);
    if (winner === null) {
      return 'cancelled';
    }
    if (winner === 'pending') {
      // 同上:初扫继续后台跑,失败挂 no-op 兜底防 unhandled rejection
      void starting.catch(() => undefined);
    }
    clearBudgetTimer();
    if (winner === null) {
      return 'cancelled';
    }
    return winner === 'pending' && token.isCancellationRequested ? 'cancelled' : winner;
  } finally {
    onDone?.();
  }
}
