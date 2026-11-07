/**
 * 空工程脚手架提示(DEMO-GAME-006):用户打开一个空目录时主动提出
 * 「从 demo 游戏模板创建第一个 KBEngine 项目」。
 *
 * 触发条件从严:恰好一个工作区文件夹,且根下没有任何非点入口(只剩
 * .git/.vscode 之类视为空)——已有内容的工作区绝不打扰。提示面失败
 * (窗口 API 异常)静默吞掉,不扰动激活。
 *
 * 为覆盖「打开空目录」这一时机,扩展需要 onStartupFinished 激活事件
 * (workspaceContains 表达不了"空");判定本身只做一次 readdir,空工程
 * 下索引/扫描面本来就无事可做,常驻激活的额外成本可忽略。
 */

import * as fs from 'fs';
import * as vscode from 'vscode';

/** 判定依赖(注入以便测试;产品面走真实 fs) */
export interface EmptyWorkspaceCheckDeps {
  readdirSync: (dirPath: string) => string[];
}

const realDeps: EmptyWorkspaceCheckDeps = {
  readdirSync: dirPath => fs.readdirSync(dirPath)
};

/** 单根是否"空":读不到(权限/不存在)视为不空,不打扰 */
export function isEmptyWorkspaceRoot(root: string | undefined, deps: EmptyWorkspaceCheckDeps = realDeps): boolean {
  if (!root) {
    return false;
  }
  let names: string[];
  try {
    names = deps.readdirSync(root);
  } catch {
    return false;
  }
  return names.every(name => name.startsWith('.'));
}

/** 提示条件:恰好一个工作区文件夹,且该根为空 */
export function shouldOfferDemoGameScaffold(
  workspaceFolders: readonly { uri: { fsPath: string } }[] | undefined,
  deps: EmptyWorkspaceCheckDeps = realDeps
): boolean {
  if (!workspaceFolders || workspaceFolders.length !== 1) {
    return false;
  }
  return isEmptyWorkspaceRoot(workspaceFolders[0].uri.fsPath, deps);
}

/** 提示面依赖(注入以便测试;产品面走 vscode) */
export interface ScaffoldPromptDeps extends EmptyWorkspaceCheckDeps {
  workspaceFolders: readonly { uri: { fsPath: string } }[] | undefined;
  showInformationMessage: (message: string, ...items: string[]) => Thenable<string | undefined>;
  executeCommand: (command: string) => Thenable<unknown>;
}

const DEMO_GAME_SCAFFOLD_BUTTON = '创建 demo 游戏';

/**
 * 激活期接线(extension.ts):条件满足时弹一次提示,点按钮即走
 * kbengine.project.createDemoGame(与命令面板同一条保护流)。
 */
export async function maybeOfferDemoGameScaffold(deps: ScaffoldPromptDeps): Promise<void> {
  try {
    if (!shouldOfferDemoGameScaffold(deps.workspaceFolders, deps)) {
      return;
    }
    const picked = await deps.showInformationMessage(
      '检测到空工程:从 demo 游戏模板创建第一个 KBEngine 项目?(迷你 ARPG:登录建角 / 刷怪 / 战斗 / 重生)',
      DEMO_GAME_SCAFFOLD_BUTTON
    );
    if (picked === DEMO_GAME_SCAFFOLD_BUTTON) {
      await deps.executeCommand('kbengine.project.createDemoGame');
    }
  } catch {
    // 提示面失败不扰动激活
  }
}

/**
 * 提示延迟(毫秒):激活完成后稍候再弹——真窗口里等首帧渲染安定,测试
 * 面(fake activate + 空临时工作区)的同步断言先走完,不被提示打搅
 * (延迟回调落在恢复后的替身上时由 maybeOffer 内部 catch 吞掉)。
 */
export const SCAFFOLD_PROMPT_DELAY_MS = 2000;

/** 产品面装配(从 vscode 取工作区/窗口/命令;延迟见 SCAFFOLD_PROMPT_DELAY_MS) */
export function offerDemoGameScaffoldFromVscode(): void {
  const deps = {
    readdirSync: (dirPath: string) => fs.readdirSync(dirPath),
    workspaceFolders: vscode.workspace.workspaceFolders,
    showInformationMessage: (message: string, ...items: string[]) =>
      vscode.window.showInformationMessage(message, ...items),
    executeCommand: (command: string) => vscode.commands.executeCommand(command)
  };
  setTimeout(() => {
    void maybeOfferDemoGameScaffold(deps);
  }, SCAFFOLD_PROMPT_DELAY_MS);
}
