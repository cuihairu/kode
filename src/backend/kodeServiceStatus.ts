/**
 * Kode 语言服务(MCP/LSP)状态栏标签纯面(2026-11-10 用户令「如何提示 lsp 和
 * mcp 的状态是否开启」):核心(LSP kode-server 服务轨道)与 Kode MCP 二进制
 * 在位面的状态栏文案/tooltip 纯函数。事实采集与状态栏装配在
 * ../activate/kodeServiceStatus.ts(依赖 vscode 宿主);本模块零 vscode 依赖,
 * 单测直接导入。源串全英文(l10n 约定),zh-cn 译文在 l10n/bundle.
 * l10n.zh-cn.json。
 *
 * 状态定义(如实):
 * - 核心(kode-server):backend=rust 且 serverPath 命中 → Rust 服务轨道;
 *   backend=rust 但二进制未找到 → Rust 降级 TS(自动发现落空,服务回落);
 *   backend=ts → 纯 TS;backend=shadow → 双轨影子对拍。
 * - Kode MCP(kode-mcp):扩展**不托管** MCP(无 mcp 贡献,不启动),状态栏只
 *   做二进制在位探测:已构建/未构建;「未集成」以 tooltip 说明(扩展不托管,
 *   由外部 MCP 客户端注册),不作第三可见态——扩展从不集成 MCP,恒显示
 *   「未集成」会误导读状态而非事实。
 */

import { l10nText } from '../nlsRuntime';

export interface KodeCoreStateLite {
  mode: 'ts' | 'rust' | 'shadow';
  /** kode-server 二进制路径;空 = 自动发现落空(Rust 不可用) */
  serverPath: string;
}

/** 核心状态栏文案:$(circuit-board)=运行/$(warning)=降级/$(beaker)=影子对拍 */
export function coreStatusBarText(state: KodeCoreStateLite | null): string {
  if (!state) {
    return l10nText('$(circuit-board) Kode LSP: not initialized');
  }
  if (state.mode === 'shadow') {
    return l10nText('$(beaker) Kode LSP: Shadow parity');
  }
  if (state.mode === 'rust') {
    return state.serverPath
      ? l10nText('$(circuit-board) Kode LSP: Rust')
      : l10nText('$(warning) Kode LSP: Rust fallback TS');
  }
  return l10nText('$(circuit-board) Kode LSP: TS');
}

/** 核心 tooltip:当前服务轨道与依据(路径/降级原因) */
export function coreStatusBarTooltip(state: KodeCoreStateLite | null): string {
  if (!state) {
    return l10nText('Kode core not initialized');
  }
  if (state.mode === 'shadow') {
    return l10nText('kode-server dual-track shadow comparison (shadow mode)');
  }
  if (state.mode === 'rust') {
    return state.serverPath
      ? l10nText('Rust kode-server service track: {path}', { path: state.serverPath })
      : l10nText('kbengine.core.backend=rust but kode-server binary not found (auto-discovery missed), falling back to TS');
  }
  return l10nText('kbengine.core.backend=ts (pure TS service)');
}

/** MCP 状态栏文案:$(plug) built / not built(二进制在位探测) */
export function mcpStatusBarText(binaryFound: boolean): string {
  return binaryFound
    ? l10nText('$(plug) Kode MCP: built')
    : l10nText('$(plug) Kode MCP: not built');
}

/** MCP tooltip:二进制在位 + 未集成说明(扩展不托管,外部客户端注册) */
export function mcpStatusBarTooltip(binaryFound: boolean): string {
  return binaryFound
    ? l10nText('kode-mcp binary present; the extension does not host it, register this path in an external MCP client (not integrated)')
    : l10nText('kode-mcp not built (source in crates/kode-mcp); the extension does not host it, register it in an external MCP client');
}
