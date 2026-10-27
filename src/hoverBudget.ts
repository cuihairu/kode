import type { LogHubLike } from './logHub';
import type * as vscode from 'vscode';

// 悬停/异步层预算闸(2026-10-22 用户令「hover 永转 loading 不出结果」):
// 异步链套总预算 race,超时 resolve null(不无限转圈),超时路径记
// LogHub(层名+耗时)便于定位真凶层。

/** 悬停异步链默认总预算(ms);配置键 kbengine.hover.asyncBudgetMs */
export const HOVER_ASYNC_BUDGET_MS_DEFAULT = 2500;

/** waitForInitialScan 调用点统一超时(ms),大树首扫可秒级+,不能拖死调用面 */
export const INITIAL_SCAN_TIMEOUT_MS = 5000;

/** Cold navigation may wait briefly for shared indexes; later requests reuse them. */
export const INTERACTIVE_INDEX_WAIT_MS = 1000;

export interface HoverTimeoutRecord {
  layer: string;
  elapsedMs: number;
  budgetMs: number;
  timestamp: number;
}

const RECENT_LIMIT = 100;
const recentTimeouts: HoverTimeoutRecord[] = [];
let logHub: LogHubLike | null = null;

/** LogHub 注入点:extension 激活时接线(serverManager.logHub);测试置 null 复位 */
export function setHoverBudgetLogHub(hub: LogHubLike | null): void {
  logHub = hub;
}

/** 最近超时记录环形缓冲(测试/取证,与 getRecentJumpLogs 同款口径) */
export function getRecentHoverTimeouts(): readonly HoverTimeoutRecord[] {
  return recentTimeouts;
}

export function clearRecentHoverTimeouts(): void {
  recentTimeouts.length = 0;
}

function reportTimeout(layer: string, elapsedMs: number, budgetMs: number): void {
  recentTimeouts.push({ layer, elapsedMs, budgetMs, timestamp: Date.now() });
  if (recentTimeouts.length > RECENT_LIMIT) {
    recentTimeouts.shift();
  }
  logHub?.warning({
    source: 'collector',
    component: 'hover-budget',
    text: `[kode-hover][timeout] layer=${layer} elapsed=${elapsedMs}ms budget=${budgetMs}ms`
  });
}

/**
 * 总预算 race:budgetMs<=0 时不设闸(既有行为原样透传);超时 resolve null
 * 并记 LogHub(层名+耗时)。底层 promise 胜出时清掉定时器,不挂事件循环;
 * 预算先到时底层稍后仍可能 reject,统一吞掉避免 unhandled rejection。
 */
export function raceWithBudget<T>(
  layer: string,
  work: Promise<T>,
  budgetMs: number,
  token?: vscode.CancellationToken,
  onStop?: () => void
): Promise<T | null> {
  if (token?.isCancellationRequested) {
    onStop?.();
    void work.catch(() => undefined);
    return Promise.resolve(null);
  }
  if (budgetMs <= 0 && !token) {
    return work;
  }
  const startedAt = Date.now();
  let timer: NodeJS.Timeout | undefined;
  let cancellationListener: vscode.Disposable | undefined;
  const stopped = new Promise<null>(resolve => {
    if (budgetMs > 0) {
      timer = setTimeout(() => {
        reportTimeout(layer, Date.now() - startedAt, budgetMs);
        onStop?.();
        resolve(null);
      }, budgetMs);
    }
    cancellationListener = token?.onCancellationRequested?.(() => { onStop?.(); resolve(null); });
    if (token?.isCancellationRequested) { onStop?.(); resolve(null); }
  });
  return Promise.race([work, stopped]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
    cancellationListener?.dispose();
    void work.catch(() => undefined);
  });
}

/**
 * IDE-BUD-001:hover 请求统一截止时间上下文。一次请求一个 deadline:绝对
 * 时刻 + 链接 token(父取消即取消),全分支共享——各层用 remainingMs() 作
 * 本层预算(而非各起满额预算窗),deadline 语义唯一;预算由层闸强制(层
 * 计时器到点记账),本体不自动取消 token(取消传播进请求独占工作是
 * IDE-BUD-002 的面)。同步路径只在段口协作检查(isExpired/token),不得被
 * 宣称已可抢占。
 */
export interface HoverRequestDeadline {
  /** 链接 token:父 token 取消即取消(预算到期不自动取消,见上) */
  readonly token: vscode.CancellationToken;
  readonly startedAt: number;
  readonly budgetMs: number;
  /** 剩余预算(ms);budgetMs<=0(关闸)恒 0,与 raceWithBudget 不设闸口径一致 */
  remainingMs(): number;
  /** 是否已到期;budgetMs<=0(关闸)恒 false */
  isExpired(): boolean;
  /** 请求落定即释放:清父监听(不取消 token 本身) */
  dispose(): void;
}

export function createHoverRequestDeadline(
  parentToken: vscode.CancellationToken | undefined,
  budgetMs: number
): HoverRequestDeadline {
  const startedAt = Date.now();
  const linked = createLinkedCancellationToken(parentToken);
  return {
    token: linked.token,
    startedAt,
    budgetMs,
    remainingMs(): number {
      return budgetMs > 0 ? budgetMs - (Date.now() - startedAt) : 0;
    },
    isExpired(): boolean {
      return budgetMs > 0 && this.remainingMs() <= 0;
    },
    dispose(): void {
      linked.dispose();
    }
  };
}

/** A request-owned token that also stops when its local budget expires. */
export function createLinkedCancellationToken(parent: vscode.CancellationToken | undefined): {
  token: vscode.CancellationToken;
  cancel: () => void;
  dispose: () => void;
} {
  let cancelled = parent?.isCancellationRequested ?? false;
  const listeners = new Set<(event: unknown) => unknown>();
  const cancel = (): void => {
    if (cancelled) { return; }
    cancelled = true;
    for (const listener of listeners) { listener(undefined); }
    listeners.clear();
  };
  const parentListener = parent?.onCancellationRequested?.(cancel);
  const token: vscode.CancellationToken = {
    get isCancellationRequested() { return cancelled; },
    onCancellationRequested(listener) {
      if (cancelled) { listener(undefined); return { dispose: () => undefined }; }
      listeners.add(listener);
      return { dispose: () => { listeners.delete(listener); } };
    }
  };
  return { token, cancel, dispose: () => { parentListener?.dispose(); listeners.clear(); } };
}

/** waitForInitialScan 调用点统一包装:5s(默认)超时,超时放行(null)并记 LogHub */
export async function withInitialScanTimeout(
  scan: Promise<void>,
  timeoutMs: number = INITIAL_SCAN_TIMEOUT_MS,
  token?: vscode.CancellationToken
): Promise<void> {
  await raceWithBudget('initial-scan', scan, timeoutMs, token);
}

/** 各层耗时记账(LogHub info):与超时记录同通道,真机对时间线定位慢层 */
export function logLayerTiming(layer: string, elapsedMs: number, detail = ''): void {
  logHub?.info({
    source: 'collector',
    component: 'hover-budget',
    text: `[kode-hover][timing] layer=${layer} elapsed=${Math.round(elapsedMs)}ms${detail ? ` ${detail}` : ''}`
  });
}
