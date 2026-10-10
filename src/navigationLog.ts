import * as vscode from 'vscode';

// 真机诊断日志(2026-10-10 用户令「你加 log 我看 log 分析告诉你」):
// 只在 F12 导航链上输出,体量 = 用户每点一次跳转一小段。真机进
// 「输出 → KBEngine Navigation」面板,测试桩按通道名入账(windowState
// .channels),真机找不到落点时把这段贴回来即可定位断在哪一级。
let channel: vscode.OutputChannel | undefined;

export function logNavigation(message: string): void {
  if (!channel) {
    channel = vscode.window.createOutputChannel('KBEngine Navigation');
  }
  channel.appendLine(message);
}
