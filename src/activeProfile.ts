/**
 * 活动 profile 选择(IDE-PRJ-010):项目模型的活动面。选择按稳定 ID 持久
 * 化(workspaceState 键 kbengine.activeProfileId.v1)——显示名只是可变字段,
 * 改名不丢选择;每次真实切换(新 ID ≠ 旧 ID)恰发一次事件,重选同条不算
 * 切换不发;未知 ID 拒绝(不落盘不发事件);读路径经 store 按 ID 解析,
 * 选择对应的记录已被删除时如实 null(陈旧选择不伪装成有效)。
 */

import * as vscode from 'vscode';
import { ProjectProfileStore, type ProjectProfile } from './projectProfiles';

export const ACTIVE_PROFILE_STATE_KEY = 'kbengine.activeProfileId.v1';

const activeProfileChangeEmitter = new vscode.EventEmitter<string>();

/** 订阅活动 profile 切换(每次真实切换恰一次,载荷为新的稳定 ID) */
export const onDidChangeActiveProfile = activeProfileChangeEmitter.event;

/** 真实切换累计数(IDE-PRJ-013):长交互面(生成预览)用它检测打开期间的选择变化 */
let activeProfileSwitchCountValue = 0;

/** 当前真实切换累计数(重选同条/拒绝写入不计) */
export function activeProfileSwitchCount(): number {
  return activeProfileSwitchCountValue;
}

/** 当前选择的稳定 ID(极简装配无 workspaceState:无选择) */
export function readActiveProfileId(memento?: vscode.Memento): string | null {
  if (!memento) {
    return null;
  }
  const value = memento.get<string>(ACTIVE_PROFILE_STATE_KEY);
  return typeof value === 'string' && value ? value : null;
}

/** 按稳定 ID 解析当前活动 profile;记录已删/无选择如实 null */
export function resolveActiveProfile(memento?: vscode.Memento): ProjectProfile | null {
  const id = readActiveProfileId(memento);
  if (!id) {
    return null;
  }
  return new ProjectProfileStore(memento).get(id);
}

/**
 * 写入选择:未知 ID 返 null(不落盘不发事件);新 ID = 旧 ID 不算切换
 * (直接返回,不发事件);真实切换先持久化再恰发一次事件。
 */
export async function setActiveProfile(
  memento: vscode.Memento | undefined,
  profileId: string
): Promise<string | null> {
  const store = new ProjectProfileStore(memento);
  if (!store.get(profileId)) {
    return null;
  }
  const previous = readActiveProfileId(memento);
  if (previous === profileId) {
    return profileId;
  }
  if (memento) {
    await memento.update(ACTIVE_PROFILE_STATE_KEY, profileId);
  }
  activeProfileSwitchCountValue += 1;
  activeProfileChangeEmitter.fire(profileId);
  return profileId;
}

/**
 * 选择命令体:QuickPick 列出全部 profile(显示名 + 稳定 ID 各就各位),
 * 选中走 setActiveProfile(持久化 + 切换事件);Esc 零写入。没有 profile
 * 时如实说明并跳过选择器,不打扰。
 */
export async function selectActiveProfile(context: {
  workspaceState?: vscode.Memento;
}): Promise<void> {
  const store = new ProjectProfileStore(context.workspaceState);
  const profiles = store.list();
  if (profiles.length === 0) {
    await vscode.window.showInformationMessage('没有可选择的 project profile，先导入或创建一个项目');
    return;
  }
  const picked = await vscode.window.showQuickPick(
    profiles.map(profile => ({
      label: profile.displayName,
      description: profile.id,
      profile
    })),
    { placeHolder: '选择活动 project profile(按稳定 ID 记忆，改名不影响)' }
  );
  if (!picked) {
    return;
  }
  const activeId = await setActiveProfile(context.workspaceState, picked.profile.id);
  if (activeId) {
    await vscode.window.showInformationMessage(`活动 profile: ${picked.label} (${activeId})`);
  }
}
