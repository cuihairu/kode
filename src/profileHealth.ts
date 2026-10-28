/**
 * profile 健康状态汇总(IDE-PRJ-009):活动 profile(经 PRJ-010 稳定 ID
 * 解析)的四类健康问题——缺引擎/缺解释器/缺语言服务/根歧义——各自带
 * 具体定位入口(命令 id 或设置键),汇总命令逐条列出,选中即跳入口,
 * Esc 只看不跳。判定复用既有单一来源:引擎/解释器/根只做存在性与记录
 * 事实检查,语言服务走 PRJ-005 三态判定(collectPythonServiceFacts 同源
 * 采集)。没有活动 profile 如实说明;全部健康不打扰。
 */

import * as fs from 'fs';
import * as vscode from 'vscode';
import { resolveActiveProfile } from './activeProfile';
import type { ProjectProfile } from './projectProfiles';
import {
  classifyPythonService,
  collectPythonServiceFacts,
  type PythonServiceFacts
} from './pythonLanguageServiceStatus';

export type ProfileHealthIssueKind =
  | 'engine-missing'
  | 'interpreter-missing'
  | 'service-unavailable'
  | 'roots-ambiguous';

export const PROFILE_HEALTH_ISSUE_LABELS: Record<ProfileHealthIssueKind, string> = {
  'engine-missing': '缺引擎',
  'interpreter-missing': '缺解释器',
  'service-unavailable': '缺语言服务',
  'roots-ambiguous': '根歧义'
};

/** 定位入口:命令(executeCommand)或设置键(openSettings) */
export interface ProfileHealthEntry {
  kind: 'command' | 'setting';
  target: string;
  label: string;
}

export interface ProfileHealthIssue {
  kind: ProfileHealthIssueKind;
  message: string;
  entry: ProfileHealthEntry;
}

export interface ProfileHealthDeps {
  exists: (path: string) => boolean;
}

const IMPORT_ENTRY: ProfileHealthEntry = {
  kind: 'command',
  target: 'kbengine.project.import',
  label: '重新导入识别'
};

/**
 * 收集四类健康问题(顺序固定:根歧义→缺引擎→缺解释器→缺语言服务):
 * 根歧义 = assetsRoot 不在盘上(profile 的根定位失效);缺引擎 =
 * engineRoot 未记录或不在盘上;缺解释器 = 来源缺失或路径不在盘上;
 * 缺语言服务 = PRJ-005 判定非已激活(未启用/未安装都算不可用)。
 */
export function collectProfileHealth(
  profile: ProjectProfile,
  serviceFacts: PythonServiceFacts,
  deps: ProfileHealthDeps
): ProfileHealthIssue[] {
  const issues: ProfileHealthIssue[] = [];

  if (!deps.exists(profile.assetsRoot)) {
    issues.push({
      kind: 'roots-ambiguous',
      message: `资产根不在盘上: ${profile.assetsRoot}`,
      entry: IMPORT_ENTRY
    });
  }
  if (!profile.engineRoot) {
    issues.push({
      kind: 'engine-missing',
      message: '未记录引擎根(engine 面未识别)',
      entry: IMPORT_ENTRY
    });
  } else if (!deps.exists(profile.engineRoot)) {
    issues.push({
      kind: 'engine-missing',
      message: `引擎根不在盘上: ${profile.engineRoot}`,
      entry: IMPORT_ENTRY
    });
  }
  if (!profile.interpreterPath) {
    issues.push({
      kind: 'interpreter-missing',
      message: '未记录 Python 解释器',
      entry: {
        kind: 'setting',
        target: 'kbengine.python.interpreterPath',
        label: '在设置中指定解释器'
      }
    });
  } else if (profile.interpreterSource === 'missing' || !deps.exists(profile.interpreterPath)) {
    issues.push({
      kind: 'interpreter-missing',
      message: `解释器不在盘上: ${profile.interpreterPath}`,
      entry: {
        kind: 'setting',
        target: 'kbengine.python.interpreterPath',
        label: '在设置中指定解释器'
      }
    });
  }
  const service = classifyPythonService(serviceFacts);
  if (service.state !== 'active') {
    issues.push({
      kind: 'service-unavailable',
      message: `Python 语言服务${service.label}(${service.detail})`,
      entry: {
        kind: 'command',
        target: 'kbengine.python.serviceStatus',
        label: '查看语言服务状态'
      }
    });
  }
  return issues;
}

/** 汇总命令体的注入面(产品面走真实 fs 与默认导航) */
export interface ProfileHealthSummaryDeps {
  exists?: (path: string) => boolean;
  resolveServiceFacts?: () => PythonServiceFacts;
  navigate?: (entry: ProfileHealthEntry) => Promise<void>;
}

/**
 * 汇总命令体:解析活动 profile → 无选择如实说明(入口指向选择命令);
 * 收集问题 → 空则报健康零打扰;非空警告计数后 QuickPick 逐条列出
 * (标签=问题类别,description=判定事实,detail=定位入口),选中跳入口
 * (命令 executeCommand/设置 openSettings),Esc 只看不跳。
 */
export async function showProfileHealthSummary(
  context: {
    workspaceState?: vscode.Memento;
  },
  deps: ProfileHealthSummaryDeps = {}
): Promise<void> {
  const profile = resolveActiveProfile(context.workspaceState);
  if (!profile) {
    await vscode.window.showInformationMessage(
      '未选择活动 project profile(先运行 Select Active Project Profile 命令选择)'
    );
    return;
  }

  const serviceFacts = (deps.resolveServiceFacts ?? collectPythonServiceFacts)();
  const issues = collectProfileHealth(profile, serviceFacts, {
    exists: deps.exists ?? (candidate => fs.existsSync(candidate))
  });
  if (issues.length === 0) {
    await vscode.window.showInformationMessage(`活动 profile 健康: ${profile.displayName} (${profile.id})`);
    return;
  }

  await vscode.window.showWarningMessage(
    `活动 profile 健康问题 ${issues.length} 项(${profile.displayName})，选择一项跳到定位入口`
  );
  const picked = await vscode.window.showQuickPick(
    issues.map(issue => ({
      label: PROFILE_HEALTH_ISSUE_LABELS[issue.kind],
      description: issue.message,
      detail: `入口: ${issue.entry.label}(${issue.entry.target})`,
      issue
    })),
    { placeHolder: '健康问题——选择一项跳到定位入口，Esc 关闭' }
  );
  if (!picked) {
    return;
  }
  const navigate =
    deps.navigate ??
    (async (entry: ProfileHealthEntry): Promise<void> => {
      if (entry.kind === 'command') {
        await vscode.commands.executeCommand(entry.target);
      } else {
        await vscode.commands.executeCommand('workbench.action.openSettings', entry.target);
      }
    });
  await navigate(picked.issue.entry);
}
