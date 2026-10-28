/**
 * 工作台目标调试状态板(IDE-DBG-008):把三份事实合成逐目标一行的
 * 四态板——①进程在册面(serverManager,只有运行中的目标有行);
 * ②注入结果面(autoDebugpy 的 report 回调/等待模式播种:listening|
 * failed);③会话挂链面(DBG-005 注册表)。四态归因:已附加(有在挂
 * 会话,一票定音)> 注入结果(listening=监听,failed=失败)> 未注入
 * (无注入事实)。纯合板:三份输入全部注入,与 buildDebugTargetBoard
 * (进程×会话)同族,叠加注入维度。
 */

import type { RunningTargetLike, DebugSessionRegistry } from './debugSessionRegistry';

export type TargetDebugPhase = 'not-injected' | 'listening' | 'attached' | 'failed';

/** 注入结果面条目(extensions 层喂:autoDebugpy report / 等待模式播种) */
export interface DebugInjectionEntry {
  outcome: 'listening' | 'failed';
  /** 监听端口(listening 时带,树/定位命令消费) */
  port?: number;
  /** 失败细节(failed 时带,如实展示) */
  detail?: string;
}

export interface DebugStatusRow {
  serverKey: string;
  component: string;
  targetId: string;
  /** 进程状态原文(serverManager 在册面) */
  processStatus: string;
  phase: TargetDebugPhase;
  port?: number;
  attachedSessions: number;
  detail?: string;
}

/**
 * 四态归因:在挂会话>0 一票「已附加」(压过监听/失败——会话在,注入
 * 必然曾成功);否则看注入结果;无事实=未注入(默认关 autoDebugpy 的
 * 用户看到的常态)。
 */
export function resolveTargetDebugPhase(
  attachedSessions: number,
  injection: DebugInjectionEntry | undefined
): TargetDebugPhase {
  if (attachedSessions > 0) {
    return 'attached';
  }
  if (injection) {
    return injection.outcome;
  }
  return 'not-injected';
}

/**
 * 会话×注入×进程合板:逐运行目标一行(进程停了行即消失——残留注入
 * 事实不产行),带四态/端口/在挂会话数/失败细节。
 */
export function buildDebugStatusRows(
  running: Map<string, RunningTargetLike>,
  injections: ReadonlyMap<string, DebugInjectionEntry>,
  registry: Pick<DebugSessionRegistry, 'linksFor'>
): DebugStatusRow[] {
  return [...running.entries()].map(([serverKey, target]) => {
    const injection = injections.get(serverKey);
    const attachedSessions = registry.linksFor(serverKey).length;
    const phase = resolveTargetDebugPhase(attachedSessions, injection);
    return {
      serverKey,
      component: target.component,
      targetId: target.targetId,
      processStatus: target.status,
      phase,
      port: phase === 'failed' ? undefined : injection?.port,
      attachedSessions,
      detail: injection?.detail
    };
  });
}
