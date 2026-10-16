import * as vscode from 'vscode';

// 真机诊断日志(2026-10-10 用户令「你加 log 我看 log 分析告诉你」):
// 只在 F12 导航链上输出,体量 = 用户每点一次跳转一小段。真机进
// 「输出 → KBEngine Navigation」面板,测试桩按通道名入账(windowState
// .channels),真机找不到落点时把这段贴回来即可定位断在哪一级。
let channel: vscode.OutputChannel | undefined;

/**
 * 跳转决策路径分级日志(用户 2026-10-16 主动要求「把跳转决策路径全部打出来」)。
 * 统一前缀 [kode-jump],info=决策路径(默认开),debug=细节;KODE_JUMP_LOG
 * 可调:off 关闭、info 只留决策路径、其它=debug(默认)。同一输出通道
 * 「KBEngine Navigation」,最近 RECENT_LIMIT 行另存环形缓冲供测试/取证。
 */
export type JumpLogLevel = 'info' | 'debug';

const RECENT_LIMIT = 400;
const recentLines: string[] = [];

export function getRecentJumpLogs(): readonly string[] {
  return recentLines;
}

export function clearRecentJumpLogs(): void {
  recentLines.length = 0;
}

function jumpLogLevelEnv(): 'off' | 'info' | 'debug' {
  const raw = (process.env.KODE_JUMP_LOG || '').toLowerCase();
  return raw === 'off' ? 'off' : raw === 'info' ? 'info' : 'debug';
}

export function jumpLog(level: JumpLogLevel, message: string): void {
  const current = jumpLogLevelEnv();
  if (current === 'off' || (current === 'info' && level === 'debug')) {
    return;
  }
  const line = `[kode-jump][${level}] ${message}`;
  recentLines.push(line);
  if (recentLines.length > RECENT_LIMIT) {
    recentLines.shift();
  }
  logNavigation(line);
}

/** 计时器:const done = jumpTimeStart(); ... done() → 毫秒数 */
export function jumpTimeStart(): () => number {
  const started = Date.now();
  return () => Date.now() - started;
}

export function logNavigation(message: string): void {
  if (!channel) {
    channel = vscode.window.createOutputChannel('KBEngine Navigation');
  }
  channel.appendLine(message);
}
