/**
 * 观测断连的恢复状态(IDE-LIV-006):流式轮询对每个目标(稳定身份,
 * 见 observationIdentity)维护 live/stale 两态——某轮查询失败(断连)
 * 后该目标旧值标「过期」,面板继续展示最后一次读数但必须带过期标记;
 * 之后任一轮查询成功(重连)才恢复「实时」。恢复以真实成功为准,不因
 * 时间流逝自动转正;时钟可注入(测试推时刻,真机用真实时钟)。
 */

import type { ObservationTarget } from './observationIdentity';

export type ObservationFreshnessState = 'live' | 'stale';

export interface ObservationFreshness {
  targetKey: string;
  state: ObservationFreshnessState;
  /** 最近一次成功读数的时刻(过期后它就是「旧值」的取值时刻) */
  lastSuccessAt?: string;
  /** 最近一次失败的时刻(断连起点) */
  lastFailureAt?: string;
  consecutiveFailures: number;
}

export type ObservationClock = () => string;

export function createObservationFreshnessTracker(clock: ObservationClock = () => new Date().toISOString()) {
  const byTarget = new Map<string, ObservationFreshness>();

  return {
    /** 一轮读数结算:成功=恢复实时(以真实成功为准),失败=标过期 */
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
            // 断连不清空上次成功时刻:旧值的取值时刻要留 evidences
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

/** 面板/证据文案:过期必须点名旧值时刻与断连时刻,实时必须点名成功时刻 */
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

/** 跨目标汇总:任一目标过期即整体不实时(面板总状态如实反映) */
export function summarizeObservationFreshness(freshness: ObservationFreshness[]): {
  allLive: boolean;
  staleTargets: string[];
} {
  const staleTargets = freshness.filter(item => item.state === 'stale').map(item => item.targetKey);
  return { allLive: staleTargets.length === 0, staleTargets };
}
