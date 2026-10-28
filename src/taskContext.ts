/**
 * 保存可重复运行的任务上下文(IDE-TSK-006):测试面板首跑时把 profile
 * 四要素(profileId/assetsRoot/engineRoot/解释器+来源)整量快照进
 * workspaceState;重跑钉住快照——活动 profile 切换、profile 字段漂
 * 移只出提示不换根,盘上根/解释器消失如实拒绝;换根唯一显式入口
 * =跑一次 kbengine.tests.list 重新捕获。验收:重跑使用同一
 * profile/解释器/环境,不悄然换到另一个根。
 */

import * as path from 'path';
import type { ProjectProfile } from './projectProfiles';

/** 可重复运行的任务上下文(一次性快照,之后与 profile 记录解耦) */
export interface TaskRunContext {
  profileId: string;
  displayName: string;
  assetsRoot: string;
  engineRoot: string;
  interpreterPath: string | null;
  interpreterSource: string;
}

/** workspaceState 持久化键(JSON 字符串形态) */
export const TEST_TASK_CONTEXT_STORAGE_KEY = 'kbengine.testTaskContext';

/** 整量快照:之后改 profile 记录不影响已存上下文 */
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

/** 漂移清单:两快照不一致的字段逐条点名(空=一致) */
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
 * 重跑协议:有已存上下文则钉住它(重跑=同一 profile/解释器/环境);
 * 盘上根/解释器消失或存储损坏如实拒绝,不悄然换根。提示面(notes)
 * 只说明不拦截:活动 profile 换了/字段漂了,重跑仍用已存上下文,
 * 想换根先跑 kbengine.tests.list 显式重新捕获。
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

/** 上下文的执行面 cwd(scripts 根) */
export function taskContextScriptsRoot(context: TaskRunContext): string {
  return path.join(context.assetsRoot, 'scripts');
}
