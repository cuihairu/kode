// SRC-001 抽象层:Kode 核心(LSP kode-server)与 Kode MCP 状态栏项装配
// (2026-11-10 用户令「如何提示 lsp 和 mcp 的状态是否开启呢」,选「状态栏
// 两项」)。
// 状态栏两项(右侧,核心 94 / MCP 93,不抢 100/99/98/97/96/95 既有位:
// 100 server/99 telnet/98 热更状态/97 解释器/96 热更通道/95 日志 tail)。
// - 核心:显示 kode-server 服务轨道(Rust/Rust 降级 TS/TS/Shadow 对拍),点击
//   开 kbengine.core.showShadowDiffLog(后端模式汇总 + 差异日志);
// - Kode MCP:二进制在位探测(已构建/未构建),扩展不托管 MCP(未集成见
//   tooltip),无点击动作——事实在 tooltip。
// 刷新:激活时一次 + kbengine.core.backend/serverPath 配置变化重读(门状态
// 只随配置变;kode-server 进程启停不改变「是否开启」语义,不做轮询)。

import * as vscode from 'vscode';
import {
  coreStatusBarText,
  coreStatusBarTooltip,
  mcpStatusBarText,
  mcpStatusBarTooltip,
  type KodeCoreStateLite
} from '../backend/kodeServiceStatus';

export const KODE_CORE_STATUS_PRIORITY = 94;
export const KODE_MCP_STATUS_PRIORITY = 93;

export interface KodeServiceStatusDeps {
  /** 当前核心门状态(mode/serverPath);未初始化返回 null */
  getGateState: () => KodeCoreStateLite | null;
  /** kode-mcp 二进制路径;'' = 未构建/未发现 */
  probeMcpBinary: () => string;
}

export function setupKodeServiceStatusBar(
  context: vscode.ExtensionContext,
  deps: KodeServiceStatusDeps
): void {
  const coreItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    KODE_CORE_STATUS_PRIORITY
  );
  const mcpItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    KODE_MCP_STATUS_PRIORITY
  );
  coreItem.command = 'kbengine.core.showShadowDiffLog';
  context.subscriptions.push(coreItem, mcpItem);

  const refresh = (): void => {
    const state = deps.getGateState();
    coreItem.text = coreStatusBarText(state);
    coreItem.tooltip = coreStatusBarTooltip(state);
    coreItem.show();
    const mcpFound = deps.probeMcpBinary() !== '';
    mcpItem.text = mcpStatusBarText(mcpFound);
    mcpItem.tooltip = mcpStatusBarTooltip(mcpFound);
    mcpItem.show();
  };

  const configListener = vscode.workspace.onDidChangeConfiguration(event => {
    if (
      event.affectsConfiguration('kbengine.core.backend') ||
      event.affectsConfiguration('kbengine.core.serverPath')
    ) {
      refresh();
    }
  });
  context.subscriptions.push(configListener);

  refresh();
}
