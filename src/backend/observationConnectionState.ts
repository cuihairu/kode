/**
 * Recovery state for observation disconnects (IDE-LIV-006): streaming polling keeps a
 * live/stale pair of states for each target (stable identity, see observationIdentity) --
 * after a round's query fails (disconnect) that target's old value is marked "stale", and
 * the panel keeps showing the last reading but must carry the stale marker; only a later
 * successful round (reconnect) restores "live". Recovery follows a real success and never
 * auto-promotes with the passage of time; the clock is injectable (tests push time, the real
 * machine uses the real clock).
 */

import type { ObservationTarget } from './observationIdentity';

export type ObservationFreshnessState = 'live' | 'stale';

export interface ObservationFreshness {
  targetKey: string;
  state: ObservationFreshnessState;
  /** Moment of the most recent successful reading (once stale, this is when the "old value" was taken) */
  lastSuccessAt?: string;
  /** Moment of the most recent failure (the disconnect start point) */
  lastFailureAt?: string;
  consecutiveFailures: number;
}

export type ObservationClock = () => string;

export function createObservationFreshnessTracker(clock: ObservationClock = () => new Date().toISOString()) {
  const byTarget = new Map<string, ObservationFreshness>();

  return {
    /** Settle one round of readings: success = back to live (a real success counts), failure = mark stale */
    recordRound(target: ObservationTarget, ok: boolean): ObservationFreshness {
      const previous = byTarget.get(target.targetKey);
      const next: ObservationFreshness = ok
        ? {
            targetKey: target.targetKey,
            state: 'live',
            lastSuccessAt: clock(),
            consecutiveFailures: 0
          }
        : {
            targetKey: target.targetKey,
            state: 'stale',
            // A disconnect does not clear the last success moment: the old value's capture time has to be kept as evidence
            lastSuccessAt: previous?.lastSuccessAt,
            lastFailureAt: clock(),
            consecutiveFailures: (previous?.consecutiveFailures ?? 0) + 1
          };
      byTarget.set(target.targetKey, next);
      return next;
    },

    view(targetKey: string): ObservationFreshness | undefined {
      return byTarget.get(targetKey);
    },

    reset(targetKey?: string): void {
      if (targetKey === undefined) {
        byTarget.clear();
      } else {
        byTarget.delete(targetKey);
      }
    }
  };
}

export type ObservationFreshnessTracker = ReturnType<typeof createObservationFreshnessTracker>;

/** Panel/evidence wording: stale must name the old-value moment and the disconnect moment, live must name the success moment */
export function describeObservationFreshness(freshness: ObservationFreshness): string {
  if (freshness.state === 'stale') {
    const parts = [`过期(断连于 ${freshness.lastFailureAt ?? '?'},连续失败 ${freshness.consecutiveFailures} 轮)`];
    if (freshness.lastSuccessAt) {
      parts.push(`当前显示 ${freshness.lastSuccessAt} 的旧值,重连成功前不转实时`);
    } else {
      parts.push('尚无成功读数,无旧值可显示');
    }
    return parts.join(';');
  }
  return `实时(最近成功读数 ${freshness.lastSuccessAt ?? '?'})`;
}

/** Cross-target summary: any stale target makes the whole thing non-live (the panel's overall state reflects this honestly) */
export function summarizeObservationFreshness(freshness: ObservationFreshness[]): {
  allLive: boolean;
  staleTargets: string[];
} {
  const staleTargets = freshness.filter(item => item.state === 'stale').map(item => item.targetKey);
  return { allLive: staleTargets.length === 0, staleTargets };
}
