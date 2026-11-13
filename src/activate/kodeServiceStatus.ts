// SRC-001 抽象层:Kode 核心(LSP kode-server)与 Kode MCP 状态栏项装配
// (2026-11-10 用户令「如何提示 lsp 和 mcp 的状态是否开启呢」,选「状态栏
// 两项」;2026-11-13 用户令「内置 mcp,点击开启,默认开启」——MCP 项升级为
// 内建托管态+点击启停,注册面见 ../kodeMcpHost.ts)。
// 状态栏两项(右侧,核心 94 / MCP 93,不抢 100/99/98/97/96/95 既有位:
// 100 server/99 telnet/98 热更状态/97 解释器/96 热更通道/95 日志 tail)。
// - 核心:显示 kode-server 服务轨道(Rust/Rust 降级 TS/TS/Shadow 对拍),点击
//   开 kbengine.core.showShadowDiffLog(后端模式汇总 + 差异日志);
// - Kode MCP:内建 MCP 三可见态(已构建/未构建/已关闭,kbengine.mcp.enabled
//   默认 true),点击 = kbengine.mcp.toggle(翻转启用态;原生 MCP 服务器列表
//   经 kodeMcpHost 的 onDidChange 同步刷新)。
// 刷新:激活时一次 + kbengine.core.backend/serverPath 与 kbengine.mcp.enabled
// 配置变化重读(门状态只随配置变;kode-server 进程启停不改变「是否开启」
// 语义,不做轮询)。

import * as vscode from 'vscode';
import {
  coreStatusBarText,
  coreStatusBarTooltip,
  mcpStatusBarText,
  mcpStatusBarTooltip,
  type KodeCoreStateLite
} from '../backend/kodeServiceStatus';
import { KODE_MCP_ENABLED_SETTING, KODE_MCP_TOGGLE_COMMAND } from '../kodeMcpHost';

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
  mcpItem.command = KODE_MCP_TOGGLE_COMMAND;
  context.subscriptions.push(coreItem, mcpItem);

  const refresh = (): void => {
    const state = deps.getGateState();
    coreItem.text = coreStatusBarText(state);
    coreItem.tooltip = coreStatusBarTooltip(state);
    coreItem.show();
    const mcpFound = deps.probeMcpBinary() !== '';
    const mcpEnabled = vscode.workspace
      .getConfiguration('kbengine')
      .get<boolean>('mcp.enabled', true);
    mcpItem.text = mcpStatusBarText(mcpFound, mcpEnabled);
    mcpItem.tooltip = mcpStatusBarTooltip(mcpFound, mcpEnabled);
    mcpItem.show();
  };

  const configListener = vscode.workspace.onDidChangeConfiguration(event => {
    if (
      event.affectsConfiguration('kbengine.core.backend') ||
      event.affectsConfiguration('kbengine.core.serverPath') ||
      event.affectsConfiguration(KODE_MCP_ENABLED_SETTING)
    ) {
      refresh();
    }
  });
  context.subscriptions.push(configListener);

  refresh();
}
