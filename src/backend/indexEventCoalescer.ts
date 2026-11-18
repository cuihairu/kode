/**
 * INDEX-DISCIPLINE-001 ①:索引重扫事件合并器——TS 薄壳(Rust 主路径 +
 * TS 回退,模式照 ruffLint 先例)。
 *
 * 用户令(2026-11-18):「频繁修改的文件要合并队列,最近修改的合并放队尾,
 * 同一文件反复建索引不对」+「必须文件保存落盘了之后才放到队列」。
 *
 * 架构分工(用户令:合并器核心逻辑落 Rust,TS 只做 vscode 事件接线薄壳):
 * - **决策核在 Rust** `$/kode/events/coalesce`(kode-server
 *   event_coalesce.rs,纯函数):窗口到期判定 / dirty 尾随顺延 / flush
 *   按「最近修改的最后出」排序;
 * - **状态+定时器在 TS 本壳**(vscode 事件层属性):pending Map(latest-wins
 *   同文件并一)+ 300ms 轮询钟 + isDirty 采样 + 重扫描入队;
 * - **TS 回退**:Rust 无门/失败时用镜像决策核 `decideCoalesceFlush`(语义
 *   与 Rust 同构,vitest 契约用例锁两面一致)。
 *
 * 消费面纪律:push 的只能是「已落盘」的变更信号(onDidSave / watcher 外部
 * 写盘);编辑事件(didChange)绝不 push(②只认落盘——那是
 * pythonClassIndex.onDocumentChanged 的标脏登记路径,与本壳无关)。
 *
 * 零 vscode import(定时器/脏采样/入队全注入;单测用假钟+假回调驱动)。
 */

import { getKodeCoreShadowGate } from './kodeCoreShadowFaces';

/** 合并窗口(毫秒);与 Rust DEFAULT_COALESCE_WINDOW_MS 同值。 */
export const INDEX_COALESCE_WINDOW_MS = 300;

/** dirty 顺延总上限(毫秒);与 Rust DEFAULT_COALESCE_MAX_DEFER_MS 同值。 */
export const INDEX_COALESCE_MAX_DEFER_MS = 5000;

/** pending 条目(喂给决策核的形状;`first/lastPushedAtMs` 为单调时钟)。 */
export interface CoalescePendingEntry {
  file: string;
  firstPushedAtMs: number;
  lastPushedAtMs: number;
}

/** 决策结果:`flush` 按最后推送时刻升序(最近修改的落队尾)。 */
export interface CoalesceDecision {
  flush: string[];
  defer: string[];
  hold: number;
}

/**
 * TS 镜像决策核:与 Rust `decide_coalesce` 同构(窗口 hold → dirty 顺延 →
 * flush 按 last 升序)。Rust 不可用时的回退;测试面锁两面语义一致。
 */
export function decideCoalesceFlush(
  pending: readonly CoalescePendingEntry[],
  dirtyFiles: readonly string[],
  nowMs: number,
  windowMs: number = INDEX_COALESCE_WINDOW_MS,
  maxDeferMs: number = INDEX_COALESCE_MAX_DEFER_MS
): CoalesceDecision {
  const dirty = new Set(dirtyFiles);
  const flushWithTime: Array<{ at: number; file: string }> = [];
  const defer: string[] = [];
  let hold = 0;
  for (const entry of pending) {
    const age = Math.max(0, nowMs - entry.lastPushedAtMs);
    if (age < windowMs) {
      hold += 1;
    } else if (dirty.has(entry.file) && Math.max(0, nowMs - entry.firstPushedAtMs) < maxDeferMs) {
      defer.push(entry.file);
    } else {
      flushWithTime.push({ at: entry.lastPushedAtMs, file: entry.file });
    }
  }
  flushWithTime.sort((a, b) => a.at - b.at);
  return { flush: flushWithTime.map(item => item.file), defer, hold };
}

/** Rust 决策核调用:无门/失败/应答畸形 → null(调用方走 TS 回退)。 */
async function decideViaRust(
  pending: readonly CoalescePendingEntry[],
  dirtyFiles: readonly string[],
  nowMs: number,
  windowMs: number,
  maxDeferMs: number
): Promise<CoalesceDecision | null> {
  const gate = getKodeCoreShadowGate();
  if (!gate) { return null; }
  try {
    const response = await gate.runInRust('$/kode/events/coalesce', {
      nowMs,
      windowMs,
      maxDeferMs,
      pending: pending.map(entry => ({
        file: entry.file,
        firstPushedAtMs: entry.firstPushedAtMs,
        lastPushedAtMs: entry.lastPushedAtMs
      })),
      dirtyFiles: [...dirtyFiles]
    });
    if (!response.ok) { return null; }
    const record = response.result as Partial<CoalesceDecision> | null;
    if (!record || typeof record !== 'object' ||
        !Array.isArray(record.flush) || !Array.isArray(record.defer) ||
        typeof record.hold !== 'number') {
      return null;
    }
    return { flush: record.flush as string[], defer: record.defer as string[], hold: record.hold };
  } catch {
    return null;
  }
}

export interface IndexEventCoalescerDeps {
  /** 单调时钟(默认 Date.now;测试注入假钟)。 */
  now?(): number;
  /** 文件当前是否编辑中(未保存)——flush 时的 dirty 采样。 */
  isDirty(file: string): boolean;
  /** 重扫描入队面(盘真相消费面,即 pythonClassIndex.onFileChanged)。 */
  enqueueReindex(file: string): void;
  /** 决策核注入(默认 Rust 主路径+TS 回退;测试可直钉镜像核)。 */
  decide?(pending: readonly CoalescePendingEntry[], dirtyFiles: readonly string[], nowMs: number): Promise<CoalesceDecision | null>;
  windowMs?: number;
  maxDeferMs?: number;
}

export interface IndexEventCoalescer {
  /** 已落盘变更入列(同文件 N 次 → Map 并一,最新覆盖)。 */
  push(file: string): void;
  dispose(): void;
  /** 待合并条数(状态栏 tooltip 观测面)。 */
  getPendingCount(): number;
  /** 测试观测面:累计入列/入队/当前顺延数。 */
  getStatsForTests(): { pushed: number; flushed: number; deferred: number };
}

/**
 * 合并器壳:pending 非空时才有轮询钟(空转零定时器);轮询节奏=窗口时长。
 * flush 按决策序逐个入队(最近修改的最后出=队尾);dirty 顺延件留在
 * pending 等下一窗;async 决策期间不重入。
 */
export function createIndexEventCoalescer(deps: IndexEventCoalescerDeps): IndexEventCoalescer {
  const windowMs = deps.windowMs ?? INDEX_COALESCE_WINDOW_MS;
  const maxDeferMs = deps.maxDeferMs ?? INDEX_COALESCE_MAX_DEFER_MS;
  const pendingEntries = new Map<string, CoalescePendingEntry>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let polling = false;
  let pushed = 0;
  let flushed = 0;
  let deferred = 0;

  // 默认决策链:Rust 主路径,无门/失败 → TS 镜像核兜底(ruffLint 先例的
  // 「行为不变降级」口径:门永远有答案,壳绝不因决策核缺席而卡死队列)。
  const decide = deps.decide ??
    (async (entries: readonly CoalescePendingEntry[], dirtyFiles: readonly string[], nowMs: number) =>
      (await decideViaRust(entries, dirtyFiles, nowMs, windowMs, maxDeferMs)) ??
      decideCoalesceFlush(entries, dirtyFiles, nowMs, windowMs, maxDeferMs));

  const stopTimer = (): void => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  const tick = (): void => {
    if (polling) { return; }
    if (pendingEntries.size === 0) {
      stopTimer();
      return;
    }
    polling = true;
    void (async () => {
      try {
        const now = deps.now?.() ?? Date.now();
        const entries = [...pendingEntries.values()];
        const dirtyFiles = entries.map(entry => entry.file).filter(file => deps.isDirty(file));
        const decision = await decide(entries, dirtyFiles, now);
        deferred = decision ? decision.defer.length : 0;
        for (const file of decision ? decision.flush : []) {
          if (pendingEntries.delete(file)) {
            flushed += 1;
            deps.enqueueReindex(file);
          }
        }
        if (pendingEntries.size === 0) {
          stopTimer();
        }
      } finally {
        polling = false;
      }
    })();
  };

  return {
    push(file: string): void {
      const now = deps.now?.() ?? Date.now();
      const existing = pendingEntries.get(file);
      if (existing) {
        existing.lastPushedAtMs = now;
      } else {
        pendingEntries.set(file, { file, firstPushedAtMs: now, lastPushedAtMs: now });
      }
      pushed += 1;
      if (timer === undefined) {
        timer = setInterval(tick, windowMs);
      }
    },
    dispose(): void {
      stopTimer();
      pendingEntries.clear();
    },
    getPendingCount(): number {
      return pendingEntries.size;
    },
    getStatsForTests(): { pushed: number; flushed: number; deferred: number } {
      return { pushed, flushed, deferred };
    }
  };
}
