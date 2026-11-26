/**
 * Persist a re-runnable task context (IDE-TSK-006): on the test panel's first run,
 * snapshot the profile's four elements (profileId/assetsRoot/engineRoot/
 * interpreter + source) wholesale into workspaceState; re-runs pin the snapshot —
 * an active profile switch or profile field drift only produces a note and never
 * changes roots, and a root/interpreter that vanished from disk is honestly
 * refused; the only explicit entry to change roots is running kbengine.tests.list
 * once to re-capture. Acceptance: re-runs use the same profile/interpreter/
 * environment and never silently switch to another root.
 */

import * as path from 'path';
import type { ProjectProfile } from '../projectProfiles';

/** Re-runnable task context (a one-shot snapshot, decoupled afterwards from the profile record) */
export interface TaskRunContext {
  profileId: string;
  displayName: string;
  assetsRoot: string;
  engineRoot: string;
  interpreterPath: string | null;
  interpreterSource: string;
}

/** workspaceState persistence key (JSON string form) */
export const TEST_TASK_CONTEXT_STORAGE_KEY = 'kbengine.testTaskContext';

/** Wholesale snapshot: later edits to the profile record do not affect the stored context */
export function captureTaskRunContext(profile: ProjectProfile): TaskRunContext {
  return {
    profileId: profile.id,
    displayName: profile.displayName,
    assetsRoot: profile.assetsRoot,
    engineRoot: profile.engineRoot,
    interpreterPath: profile.interpreterPath,
    interpreterSource: profile.interpreterSource
  };
}

/** Drift list: names each field where the two snapshots disagree (empty = identical) */
export function compareTaskRunContexts(pinned: TaskRunContext, current: TaskRunContext): string[] {
  const drifts: string[] = [];
  if (pinned.assetsRoot !== current.assetsRoot) {
    drifts.push(`assets 根:${pinned.assetsRoot} → ${current.assetsRoot}`);
  }
  if (pinned.engineRoot !== current.engineRoot) {
    drifts.push(`引擎根:${pinned.engineRoot} → ${current.engineRoot}`);
  }
  if (pinned.interpreterPath !== current.interpreterPath) {
    drifts.push(`解释器:${pinned.interpreterPath ?? '(缺失)'} → ${current.interpreterPath ?? '(缺失)'}`);
  }
  return drifts;
}

export interface TaskContextDeps {
  exists(candidate: string): boolean;
}

export type PreparedTestRun =
  | { outcome: 'run'; context: TaskRunContext; notes: string[] }
  | { outcome: 'refuse'; message: string };

/**
 * Re-run protocol: with a stored context, pin it (a re-run = the same profile/
 * interpreter/environment); a root/interpreter that vanished from disk or a
 * corrupted store is honestly refused, never silently switching roots. The note
 * face (notes) only explains, it does not block: if the active profile changed or
 * drifted, the re-run still uses the stored context; to change roots, run
 * kbengine.tests.list first to re-capture explicitly.
 */
export function prepareTestRun(
  activeProfile: ProjectProfile | null,
  pinnedJson: string | undefined,
  deps: TaskContextDeps
): PreparedTestRun {
  if (pinnedJson === undefined) {
    if (!activeProfile) {
      return { outcome: 'refuse', message: '尚未选择活动 profile:先在 Profiles 里选一套 assets/engine 组合,再运行测试' };
    }
    return { outcome: 'run', context: captureTaskRunContext(activeProfile), notes: [] };
  }

  let pinned: TaskRunContext;
  try {
    const parsed = JSON.parse(pinnedJson) as Partial<TaskRunContext>;
    if (typeof parsed.profileId !== 'string' || typeof parsed.assetsRoot !== 'string') {
      throw new Error('shape');
    }
    pinned = {
      profileId: parsed.profileId,
      displayName: typeof parsed.displayName === 'string' ? parsed.displayName : parsed.profileId,
      assetsRoot: parsed.assetsRoot,
      engineRoot: typeof parsed.engineRoot === 'string' ? parsed.engineRoot : '',
      interpreterPath: typeof parsed.interpreterPath === 'string' ? parsed.interpreterPath : null,
      interpreterSource: typeof parsed.interpreterSource === 'string' ? parsed.interpreterSource : 'missing'
    };
  } catch {
    return { outcome: 'refuse', message: '已保存的任务上下文损坏(无法解析):跑一次「Tests: List Project Python Tests」重新捕获' };
  }

  if (!deps.exists(pinned.assetsRoot)) {
    return {
      outcome: 'refuse',
      message: `已保存的任务上下文指向的 assets 根 ${pinned.assetsRoot} 不再存在:请确认路径或跑一次「Tests: List Project Python Tests」重新捕获,不会悄然换到另一个根`
    };
  }
  if (pinned.interpreterPath !== null && !deps.exists(pinned.interpreterPath)) {
    return {
      outcome: 'refuse',
      message: `已保存的任务上下文的解释器 ${pinned.interpreterPath} 不再存在:请确认路径或跑一次「Tests: List Project Python Tests」重新捕获`
    };
  }

  const notes: string[] = [];
  if (!activeProfile) {
    notes.push(`重跑使用已保存的任务上下文(${pinned.displayName});活动 profile 已取消选择`);
  } else if (activeProfile.id !== pinned.profileId) {
    notes.push(
      `重跑使用已保存的任务上下文(${pinned.displayName},profile ${pinned.profileId});要切到 ${activeProfile.displayName} 先跑 kbengine.tests.list 重新捕获`
    );
  } else {
    const drifts = compareTaskRunContexts(pinned, captureTaskRunContext(activeProfile));
    if (drifts.length > 0) {
      notes.push(`profile 记录已变(${drifts.join(';')});重跑仍用已保存的任务上下文,要跟进先跑 kbengine.tests.list 重新捕获`);
    }
  }
  if (pinned.interpreterPath === null) {
    notes.push('已保存上下文无解释器:按构建任务同一回退规则用 PATH 上的 python3');
  }
  return { outcome: 'run', context: pinned, notes };
}

/** The execution-face cwd of the context (the scripts root) */
export function taskContextScriptsRoot(context: TaskRunContext): string {
  return path.join(context.assetsRoot, 'scripts');
}
