/**
 * 按状态过滤命令(IDE-HOT-100 §3.4):「看哪些改了还没重载」= DIRTY ∪ SENT
 * 的过滤视图。遍历已知键(台账有记录 ∪ 会话基线册 ∪ 被拦集),逐键经
 * filesByState 只筛注意力集,报告落「KBEngine 热更新」通道。FAILED/
 * RESTART_REQUIRED 各有专项面,不混进这个过滤。
 */

import type { HotReloadTargetStateStore } from './hotReloadTargetState';
import {
  HOT_RELOAD_ATTENTION_STATES,
  type HotReloadFileStateMachine,
  type HotReloadFileStateView
} from './hotReloadFileState';
import { formatHotReloadTime } from '../hotReloadStatus';

/** 注意力报告渲染:头部计数 + 逐文件 状态/基线前 12 位/明细;空=如实无 */
export function renderHotReloadAttentionReport(views: HotReloadFileStateView[]): string {
  if (views.length === 0) {
    return '无「已修改未重载/已发送待回执」文件(全部已生效或未跟踪)';
  }
  const lines = [`热更待处理(改动未重载): ${views.length} 个文件`];
  for (const view of views) {
    const parts = [`${view.file} → ${view.state}`];
    if (view.baselineDigest !== undefined) {
      parts.push(`基线 ${view.baselineDigest.slice(0, 12)}…`);
    }
    if (view.updatedAt !== undefined) {
      parts.push(`上次 ${formatHotReloadTime(view.updatedAt)}`);
    }
    const tail = view.reason ?? view.annotation ?? view.detail;
    if (tail !== undefined) {
      parts.push(tail);
    }
    lines.push(parts.join(' | '));
  }
  return lines.join('\n');
}

/** 展示面注入:落日志块 + 打开通道;测试用假体同形 */
export interface HotReloadFileStateFilterView {
  logBlock(text: string): void;
  show(): void;
}

export interface HotReloadFileStateFilterDeps {
  readonly stateMachine: HotReloadFileStateMachine;
  readonly ledger: HotReloadTargetStateStore;
  /** 文件当前内容读取(读不到=undefined) */
  readFileContent(file: string): string | undefined | Promise<string | undefined>;
}

/** 命令体:遍历已知键筛注意力集,报告落通道;无已知键如实无待处理 */
export async function runHotReloadFileStateFilterCommand(
  deps: HotReloadFileStateFilterDeps,
  view: HotReloadFileStateFilterView
): Promise<void> {
  const keys = deps.stateMachine.knownKeys(deps.ledger);
  const all: HotReloadFileStateView[] = [];
  for (const key of keys) {
    const views = await deps.stateMachine.filesByState(
      deps.ledger,
      key,
      HOT_RELOAD_ATTENTION_STATES,
      deps.readFileContent
    );
    all.push(...views);
  }
  view.logBlock(renderHotReloadAttentionReport(all));
  view.show();
}

/** 单文件状态明细渲染:逐目标一行(跨目标同文件各自状态,不合并);无目标如实无 */
export function renderHotReloadFileStateDetail(file: string, views: HotReloadFileStateView[]): string {
  if (views.length === 0) {
    return `文件无热更状态(无目标关联): ${file}`;
  }
  const lines = [`热更状态(${file}): ${views.length} 个目标`];
  for (const view of views) {
    const parts = [`${view.state}`];
    if (view.baselineDigest !== undefined) {
      parts.push(`基线 ${view.baselineDigest.slice(0, 12)}…`);
    }
    if (view.updatedAt !== undefined) {
      parts.push(`上次 ${formatHotReloadTime(view.updatedAt)}`);
    }
    if (view.attempt !== undefined) {
      parts.push(`发送 #${view.attempt}`);
    }
    const tail = view.reason ?? view.annotation ?? view.detail;
    if (tail !== undefined) {
      parts.push(tail);
    }
    lines.push(parts.join(' | '));
  }
  return lines.join('\n');
}

/** 状态点点击:落单文件跨目标状态明细;文件不在工作区根/无目标如实说明 */
export async function runShowHotReloadFileStateCommand(
  deps: HotReloadFileStateFilterDeps & {
    resolveRootId(file: string): string | null;
    targetsForRoot(rootId: string): string[] | Promise<string[]>;
  },
  view: HotReloadFileStateFilterView,
  file: string
): Promise<void> {
  const rootId = deps.resolveRootId(file);
  if (rootId === null) {
    view.logBlock(`文件不在工作区根内,无热更状态: ${file}`);
    view.show();
    return;
  }
  const targets = await deps.targetsForRoot(rootId);
  const content = await deps.readFileContent(file);
  const states: HotReloadFileStateView[] = [];
  for (const targetId of targets) {
    states.push(deps.stateMachine.derive(deps.ledger, { rootId, targetId }, file, content));
  }
  view.logBlock(renderHotReloadFileStateDetail(file, states));
  view.show();
}
