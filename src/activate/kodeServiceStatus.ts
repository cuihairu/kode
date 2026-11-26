// SRC-001 抽象层:Kode 核心(LSP kode-server)与 Kode MCP 状态栏项装配
// (2026-11-10 用户令「如何提示 lsp 和 mcp 的状态是否开启呢」,选「状态栏
// 两项」;2026-11-13 用户令「内置 mcp,点击开启,默认开启」——MCP 项升级为
// 内建托管态+点击启停,注册面见 ../kodeMcpHost.ts;2026-11-24 MCP 活性灯批
// ——MCP 项加活性探针:已构建≠能拉起能应答,kode-mcp --probe 毫秒级握手
// 判活,见 ../kodeMcpHealthProbe.ts)。
// 状态栏两项(右侧,核心 94 / MCP 93,不抢 100/99/98/97/96/95 既有位:
// 100 server/99 telnet/98 热更状态/97 解释器/96 热更通道/95 日志 tail)。
// - 核心:显示 kode-server 服务轨道(Rust/Rust 降级 TS/TS/Shadow 对拍),点击
//   开 kbengine.core.showShadowDiffLog(后端模式汇总 + 差异日志);
// - Kode MCP:内建 MCP 三可见态(已构建/未构建/已关闭,kbengine.mcp.enabled
//   默认 true)+ 活性两态(ok=探活通过/no reply=探活失败),点击 =
//   kbengine.mcp.toggle(翻转启用态;原生 MCP 服务器列表经 kodeMcpHost 的
//   onDidChange 同步刷新)。
// 刷新:激活时一次 + kbengine.core.backend/serverPath 与 kbengine.mcp.enabled
// 配置变化重读(门状态只随配置变;kode-server 进程启停不改变「是否开启」
// 语义,不做轮询)。引擎版本行(RUST-136 增量⑤)另随 kbengine.engineRoot
// 变化重探一次,其余刷新复用缓存。
// MCP 活性探针节奏:激活后一轮 + kbengine.mcp.enabled 等配置变化重探一轮;
// 不做周期轮询(结果=「最近一轮」如实展示,tooltip 注明)。探针自拉自收
// (kode-mcp --probe 子进程应答即杀,不留孤儿),与真实 MCP 服务进程互不相干。

import * as vscode from 'vscode';
import {
  coreStatusBarText,
  coreStatusBarTooltip,
  mcpStatusBarText,
  mcpStatusBarTooltip,
  type KodeCoreStateLite,
  type KodeMcpProbeFace
} from '../backend/kodeServiceStatus';
import type { KodeMcpProbeResult } from '../kodeMcpHealthProbe';
import { KODE_MCP_ENABLED_SETTING, KODE_MCP_TOGGLE_COMMAND } from '../kodeMcpHost';
import { registerCoreRediscoveryRefresh } from '../kodeCoreGateWiring';

export const KODE_CORE_STATUS_PRIORITY = 94;
export const KODE_MCP_STATUS_PRIORITY = 93;

export interface KodeServiceStatusDeps {
  /** 当前核心门状态(mode/serverPath);未初始化返回 null */
  getGateState: () => KodeCoreStateLite | null;
  /** kode-mcp 二进制路径;'' = 未构建/未发现 */
  probeMcpBinary: () => string;
  /**
   * bin/ 面找到了同名文件但镜像格式与当前平台不符时的用户可读原因
   * (:2999 魔数守门);不注入 = 零变化(向后兼容既有调用点)。
   */
  probeMcpBinaryReason?: () => string | null;
  /**
   * 引擎版本标记探测(engineVersionDetect 链)。null=未检出/探测失败,
   * 状态栏显式「未检测到」,绝不编造版本值。
   */
  detectEngineVersion: () => string | null;
  /**
   * MCP 活性探针一轮(kode-mcp --probe 握手;接线层解析二进制与资产根,
   * 内部自带预算竞速永不悬挂)。只在二进制在位+开启时被调。
   */
  probeMcpLiveness: () => Promise<KodeMcpProbeResult>;
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

  // RUST-136 增量⑤:引擎版本行数据=检测链探测结果,一次探测缓存,引擎根配置
  // 变化才重探(FS 读不随每次 refresh 反复执行)。
  let engineVersion: string | null = null;
  let engineVersionProbed = false;

  // MCP 活性探针账(最近一轮;单飞:在途不叠加)。
  let mcpProbe: KodeMcpProbeFace = { probing: false, last: null };
  let mcpProbeInFlight = false;

  const readMcpEnabled = (): boolean =>
    vscode.workspace.getConfiguration('kbengine').get<boolean>('mcp.enabled', true);

  const renderMcp = (): void => {
    const mcpFound = deps.probeMcpBinary() !== '';
    const mcpEnabled = readMcpEnabled();
    mcpItem.text = mcpStatusBarText(mcpFound, mcpEnabled, mcpProbe);
    // 错平台包直显(:2999):bin/ 面有同名文件但魔数不符时,发现链已按缺失
    // 处理,状态栏不能再呈现「未构建」的错因,把真实原因接在提示后面。
    const mismatchReason = !mcpFound ? deps.probeMcpBinaryReason?.() ?? null : null;
    const baseTooltip = mcpStatusBarTooltip(mcpFound, mcpEnabled, mcpProbe);
    mcpItem.tooltip = mismatchReason ? `${baseTooltip}\n${mismatchReason}` : baseTooltip;
    mcpItem.show();
  };

  const refresh = (): void => {
    const state = deps.getGateState();
    if (!engineVersionProbed) {
      engineVersion = deps.detectEngineVersion();
      engineVersionProbed = true;
    }
    coreItem.text = coreStatusBarText(state);
    coreItem.tooltip = coreStatusBarTooltip(state, engineVersion);
    coreItem.show();
    renderMcp();
  };

  /** 单轮探活:只对「已构建+已开启」探;在途不叠加;账到手回渲染。 */
  const runMcpProbeOnce = (): void => {
    if (mcpProbeInFlight || deps.probeMcpBinary() === '' || !readMcpEnabled()) {
      return;
    }
    mcpProbeInFlight = true;
    mcpProbe = { probing: true, last: mcpProbe.last };
    renderMcp();
    void deps
      .probeMcpLiveness()
      .then(result => {
        mcpProbe = { probing: false, last: result };
      })
      .catch(() => {
        // 探针永不炸装配面:抛异常按失败一轮记账(无 reason=如实缺省)
        mcpProbe = { probing: false, last: { ok: false, latencyMs: -1 } };
      })
      .finally(() => {
        mcpProbeInFlight = false;
        renderMcp();
      });
  };

  const configListener = vscode.workspace.onDidChangeConfiguration(event => {
    if (
      event.affectsConfiguration('kbengine.core.backend') ||
      event.affectsConfiguration('kbengine.core.serverPath') ||
      event.affectsConfiguration(KODE_MCP_ENABLED_SETTING)
    ) {
      refresh();
      // mcp.enabled 翻开(或伴随配置面变化)时重探一轮;关态/未构建由
      // runMcpProbeOnce 自守门拒绝。
      runMcpProbeOnce();
    }
    if (event.affectsConfiguration('kbengine.engineRoot')) {
      engineVersionProbed = false;
      refresh();
    }
  });
  context.subscriptions.push(configListener);

  // KODE-COREDISCOVER-001: when a bin/ file lands after activation the watcher
  // re-discovers and re-arms this status surface with the live serverPath.
  context.subscriptions.push(registerCoreRediscoveryRefresh(refresh));
  refresh();
  runMcpProbeOnce();
}
