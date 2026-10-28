/**
 * KBEngine 构建 TaskProvider(IDE-TSK-002):任务列表(Run Task)逐
 * profile 出一条脚本编译检查任务——Task 的 definition(name 之外唯一
 * 身份:{type:'kbengine.build', profileId})/名称/源/执行四要素全部
 * 来自 TSK-001 的 spec(所见即所跑同源)。resolveTask 反解 tasks.json
 * 里手写的 kbengine.build 条目:按 profileId 找回 profile,找不到如实
 * undefined 不猜。执行用 ProcessExecution:进程树由 VS Code 任务系统
 * 原生管理——任务面板上取消/终止任务即终止对应执行(kode 不自建进程
 * 管理,不重复造平台已有的轮子)。
 */

import * as vscode from 'vscode';
import {
  buildScriptCheckTaskSpec,
  type BuildTaskSpec,
  type BuildTaskSpecInput
} from './buildTaskSpec';

/** 任务源名(任务列表「源」列) */
export const BUILD_TASK_SOURCE = 'kode';

/** spec → Task(执行面=ProcessExecution,四要素原样映射) */
export function buildTaskFromSpec(spec: BuildTaskSpec): vscode.Task {
  const execution = new vscode.ProcessExecution(spec.command, [...spec.args], {
    cwd: spec.cwd,
    env: { ...spec.env }
  });
  return new vscode.Task(
    { type: spec.type, profileId: spec.profileId },
    vscode.TaskScope.Workspace,
    spec.name,
    BUILD_TASK_SOURCE,
    execution
    // problem matcher 留给 TSK-003(compileall 错误行→源码定位)
  );
}

export interface BuildTaskDeps {
  /** 装配层给:profile 存储的当前清单(每次 provide 拉新,建删即生效) */
  getProfiles(): BuildTaskSpecInput[];
}

export class KbengineBuildTaskProvider implements vscode.TaskProvider {
  constructor(private readonly deps: BuildTaskDeps) {}

  provideTasks(): vscode.Task[] {
    return this.deps.getProfiles().map(profile => buildTaskFromSpec(buildScriptCheckTaskSpec(profile)));
  }

  resolveTask(task: vscode.Task): vscode.Task | undefined {
    const profileId = task.definition.profileId;
    if (typeof profileId !== 'string') {
      return undefined;
    }
    const profile = this.deps.getProfiles().find(item => item.id === profileId);
    if (!profile) {
      return undefined;
    }
    return buildTaskFromSpec(buildScriptCheckTaskSpec(profile));
  }
}
