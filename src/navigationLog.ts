import * as vscode from 'vscode';

// 真机诊断日志(2026-10-10 用户令「你加 log 我看 log 分析告诉你」):
// 只在 F12 导航链上输出,体量 = 用户每点一次跳转一小段。真机进
// 「输出 → KBEngine Navigation」面板,测试桩按通道名入账(windowState
// .channels),真机找不到落点时把这段贴回来即可定位断在哪一级。
let channel: vscode.OutputChannel | undefined;

/**
 * 跳转决策路径日志(2026-10-16 用户令「把跳转决策路径全部打出来」;同日追加
 * 「开关做成配置项,默认关闭」):
 * - 开关 = `kbengine.jumpLog`(boolean,默认 false),extension 激活时读取、
 *   onDidChangeConfiguration 时刷新(setJumpLogEnabled);关闭时 jumpLog 第一行
 *   即返回——消息以 () => 形式惰性传入,零字符串拼接开销。
 * - 统一前缀 [kode-jump],级别 info(决策路径)/debug(细节)都随开关全量输出,
 *   靠前缀+级别标签在输出面板过滤。
 * - 通道「KBEngine Navigation」;最近 RECENT_LIMIT 行另存环形缓冲供测试/取证。
 */
export type JumpLogLevel = 'info' | 'debug';

const RECENT_LIMIT = 400;
const recentLines: string[] = [];
let jumpLogEnabled = false;

export function getRecentJumpLogs(): readonly string[] {
  return recentLines;
}

export function clearRecentJumpLogs(): void {
  recentLines.length = 0;
}

/** 开关注入点:extension 激活读配置、配置变更时刷新;测试直接置位 */
export function setJumpLogEnabled(enabled: boolean): void {
  jumpLogEnabled = enabled;
}

export function isJumpLogEnabled(): boolean {
  return jumpLogEnabled;
}

/**
 * 决策路径日志。message 用 () => 惰性形式:开关关闭时立即返回,不求值、
 * 不拼字符串(用户令「关闭时零开销」)。字符串入参仍兼容(测试便利)。
 */
export function jumpLog(level: JumpLogLevel, message: string | (() => string)): void {
  if (!jumpLogEnabled) {
    return;
  }
  const text = typeof message === 'function' ? message() : message;
  const line = `[kode-jump][${level}] ${text}`;
  recentLines.push(line);
  if (recentLines.length > RECENT_LIMIT) {
    recentLines.shift();
  }
  logNavigation(line);
}

/** 计时器:const done = jumpTimeStart(); ... done() → 毫秒数;关闭时零开销 */
export function jumpTimeStart(): () => number {
  if (!jumpLogEnabled) {
    return () => 0;
  }
  const started = Date.now();
  return () => Date.now() - started;
}

export function logNavigation(message: string): void {
  if (!channel) {
    channel = vscode.window.createOutputChannel('KBEngine Navigation');
  }
  channel.appendLine(message);
}
