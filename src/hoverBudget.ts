import type { LogHubLike } from './logHub';

// 悬停/异步层预算闸(2026-10-22 用户令「hover 永转 loading 不出结果」):
// 异步链套总预算 race,超时 resolve null(不无限转圈),超时路径记
// LogHub(层名+耗时)便于定位真凶层。

/** 悬停异步链默认总预算(ms);配置键 kbengine.hover.asyncBudgetMs */
export const HOVER_ASYNC_BUDGET_MS_DEFAULT = 2500;

/** waitForInitialScan 调用点统一超时(ms),大树首扫可秒级+,不能拖死调用面 */
export const INITIAL_SCAN_TIMEOUT_MS = 5000;

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
  budgetMs: number
): Promise<T | null> {
  if (budgetMs <= 0) {
    return work;
  }
  const startedAt = Date.now();
  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<null>(resolve => {
    timer = setTimeout(() => {
      reportTimeout(layer, Date.now() - startedAt, budgetMs);
      resolve(null);
    }, budgetMs);
  });
  return Promise.race([work, budget]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
    void work.catch(() => undefined);
  });
}

/** waitForInitialScan 调用点统一包装:5s(默认)超时,超时放行(null)并记 LogHub */
export async function withInitialScanTimeout(
  scan: Promise<void>,
  timeoutMs: number = INITIAL_SCAN_TIMEOUT_MS
): Promise<void> {
  await raceWithBudget('initial-scan', scan, timeoutMs);
}

/** 各层耗时记账(LogHub info):与超时记录同通道,真机对时间线定位慢层 */
export function logLayerTiming(layer: string, elapsedMs: number, detail = ''): void {
  logHub?.info({
    source: 'collector',
    component: 'hover-budget',
    text: `[kode-hover][timing] layer=${layer} elapsed=${Math.round(elapsedMs)}ms${detail ? ` ${detail}` : ''}`
  });
}
