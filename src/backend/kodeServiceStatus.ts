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
 * - Kode MCP(kode-mcp):**内建 MCP**(2026-11-13 用户令「内置 mcp,点击
 *   开启,默认开启」,推翻 2026-11-10「不托管」口径):扩展经 VS Code 原生
 *   MCP 扩展 API 注册服务器定义(kodeMcpHost.ts,默认 kbengine.mcp.enabled=
 *   true),状态栏项点击即启停;三可见态=已构建(二进制在位+开启)/未构建
 *   (开启但二进制缺)/已关闭(用户关)。
 * - 核心 tooltip 另带「引擎版本」行(RUST-136 增量⑤):引擎版本属环境事实,
 *   不是 hover 面(增量④ 已作废),故落状态栏;装配层传入 engineVersionDetect
 *   链的探测结果,null=未检出显式「未检测到」。
 */

import { l10nText } from '../nlsRuntime';
import { INDEX_CACHE_SCHEMA_VERSION } from './indexDiskCache';
import type { KodeMcpProbeResult } from '../kodeMcpHealthProbe';

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

/** 索引格式行(ENGINE-WORDING-006):kode 索引数据兼容键展示位,与 KBEngine 引擎版本分词 */
function indexFormatSchemaLine(): string {
  return l10nText(
    'Index format schema={version} (kode index data compat key, unrelated to the KBEngine engine version)',
    { version: INDEX_CACHE_SCHEMA_VERSION }
  );
}

/**
 * 引擎版本行(RUST-136 增量⑤):数据源=既有 engineVersionDetect 检测链
 * (findEngineRoot + readEngineVersionMarker,见 ../activate 装配)。null=
 * 未检出/探测失败,显式「未检测到」不猜;绝不回落 kbengine.engineVersion
 * 设置值(那是用户声明口径,不是引擎树里的标记事实)。
 */
export function engineVersionLine(engineVersion: string | null): string {
  return engineVersion
    ? l10nText('KBEngine engine version: {version}', { version: engineVersion })
    : l10nText('KBEngine engine version: not detected (no version marker readable in the engine tree)');
}

/** 核心 tooltip:当前服务轨道与依据(路径/降级原因)+ 引擎版本行 + 固定索引格式行 */
export function coreStatusBarTooltip(
  state: KodeCoreStateLite | null,
  engineVersion?: string | null
): string {
  return `${coreStatusBarTooltipBody(state)}\n${engineVersionLine(engineVersion ?? null)}\n${indexFormatSchemaLine()}`;
}

function coreStatusBarTooltipBody(state: KodeCoreStateLite | null): string {
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

/** MCP 活性探针面(2026-11-24 MCP 活性灯批;装配层维护的最近一轮快照):
 * probing=在途;last=null=尚未探过(激活窗口);last=最近一轮结果 */
export interface KodeMcpProbeFace {
  probing: boolean;
  last: KodeMcpProbeResult | null;
}

/**
 * MCP 状态栏文案:$(plug) built / not built / off(内建 MCP 三可见态)+
 * 活性两态(已构建+已开启时探针有账才翻脸):ok=探活通过;no reply=探活
 * 失败(进程拉不起来/握手无应答——「已构建」只说明二进制在位,不代表能
 * 拉起能应答)。
 */
export function mcpStatusBarText(
  binaryFound: boolean,
  enabled: boolean,
  probe?: KodeMcpProbeFace
): string {
  if (!enabled) {
    return l10nText('$(plug) Kode MCP: off');
  }
  if (!binaryFound) {
    return l10nText('$(plug) Kode MCP: not built');
  }
  if (probe?.last) {
    return probe.last.ok
      ? l10nText('$(plug) Kode MCP: ok')
      : l10nText('$(error) Kode MCP: no reply');
  }
  return l10nText('$(plug) Kode MCP: built');
}

/** 活性探针行(已构建+已开启才探;probing/未探/通过/失败四口吻如实) */
function mcpProbeLine(probe: KodeMcpProbeFace): string {
  if (probe.last?.ok) {
    return l10nText(
      'Liveness probe passed ({latency}ms): kode-mcp --probe answered the MCP handshake',
      { latency: probe.last.latencyMs }
    );
  }
  if (probe.last) {
    return probe.last.reason
      ? l10nText('Liveness probe failed: {reason}', { reason: probe.last.reason })
      : l10nText('Liveness probe failed: no answer within budget (suspected hang)');
  }
  return l10nText('Liveness probe: running (first probe after activation)');
}

/** MCP tooltip:内建托管事实 + 点击启停提示(点击=kbengine.mcp.toggle)+
 * 活性探针行(已构建+已开启时;结果=最近一轮,不做周期轮询) */
export function mcpStatusBarTooltip(
  binaryFound: boolean,
  enabled: boolean,
  probe?: KodeMcpProbeFace
): string {
  if (!enabled) {
    return l10nText('Kode MCP is disabled; click to enable the built-in MCP server');
  }
  if (!binaryFound) {
    return l10nText('kode-mcp not built (source in crates/kode-mcp); build the binary to enable the built-in MCP server; click toggles enable state');
  }
  const body = l10nText('kode-mcp binary present; built-in MCP server definition registered (VS Code native MCP); click to disable');
  if (!probe || (!probe.probing && !probe.last)) {
    return body;
  }
  return `${body}\n${mcpProbeLine(probe)}`;
}
