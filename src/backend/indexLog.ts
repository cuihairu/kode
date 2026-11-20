import * as vscode from 'vscode';

// 统一索引工作日志(WARM-VISIBILITY-004 刀 B,2026-11-20):
// 索引相关日志此前散落多个通道(jumpLog → 「KBEngine Navigation」默认关、
// Runtime/Compatibility/Console 各自独立),用户不知道看哪个,判断不了
// 「索引引擎在工作还是死了」。本模块 = 常开的「KBEngine Index」通道,
// 汇总五源关键事件:
//   - discovery    发现链(def 首扫起扫/完成/慢文件/失败重试)
//   - event-index  事件/方法索引(冷扫起扫/完成、缓存恢复)
//   - python-index python 类索引(全扫起扫/节流进度/完成/断点采纳/待补)
//   - cache        预热磁盘缓存(命中注入/恢复/预热完成)
//   - server       kode-server 进程生命周期(spawned/ready/exit/重启循环;
//                  FREEZE 刀3 心跳,仅 Rust 辅助进程真跑起来才有行)
// 每行带相对时间戳(首行 [+0.0s] 锚定)。
//
// 常开红线(用户教训:Navigation 通道因 jumpLog 默认 false 整个静默):
// 本通道无开关,关键事实行(起扫/完成/缓存/恢复)恒出。任务书「开关 off
// 不镜像」按「决策路径流量(jumpLog debug/决策行)不进本通道」实现——
// 镜像面只有两条既有事实行(def 全量索引完成 / def 解析慢文件),内容与
// Navigation 通道一对一;jumpLog 关闭时 Navigation 静默,本通道照出。
// 测试桩按通道名入账(windowState.channels),与 navigationLog 同一基建。

export type IndexLogSource = 'discovery' | 'event-index' | 'python-index' | 'cache' | 'server';

export const INDEX_LOG_CHANNEL_NAME = 'KBEngine Index';

const RECENT_LIMIT = 400;
const recentLines: string[] = [];

let channel: vscode.OutputChannel | undefined;
/** 相对时间锚(首行时刻);null = 还没发过行 */
let anchorMs: number | null = null;
/** 测试时钟注入(时间戳断言确定性) */
let testClock: (() => number) | null = null;

export function setIndexLogClockForTests(clock: (() => number) | null): void {
  testClock = clock;
}

const nowMs = (): number => (testClock ? testClock() : Date.now());

export function getIndexLogRecentLines(): readonly string[] {
  return recentLines;
}

export function clearIndexLogRecentLines(): void {
  recentLines.length = 0;
  // 测试便利:清环形缓冲同时重置时间锚,断言可从 [+0.0s] 重新数起
  anchorMs = null;
}

/**
 * 索引关键事件行。message 惰性形式与 jumpLog 同(未启用面零拼接开销——
 * 本通道常开,惰性主要为调用点统一风格;真正要省的是别把高频循环塞进来)。
 */
export function indexLog(source: IndexLogSource, message: string | (() => string)): void {
  const text = typeof message === 'function' ? message() : message;
  if (anchorMs === null) {
    anchorMs = nowMs();
  }
  const line = `[+${((nowMs() - anchorMs) / 1000).toFixed(1)}s][kode-index][${source}] ${text}`;
  recentLines.push(line);
  if (recentLines.length > RECENT_LIMIT) {
    recentLines.shift();
  }
  if (!channel) {
    channel = vscode.window.createOutputChannel(INDEX_LOG_CHANNEL_NAME);
  }
  channel.appendLine(line);
}
