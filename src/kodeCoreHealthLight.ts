import * as vscode from 'vscode';
import type { HotReloadTimerDeps } from './hotReload';

// Core 健康灯(2026-11-24 用户令「server 死了我怎么去判断,这个问题不解决,
// 这个插件根本没有办法使用」):状态栏常驻 kode-server 活性灯 + 定期探针。
// 病灶:server 楔死时此前无任何可见信号——索引/跳转/CodeLens 全链变慢或停
// 摆,用户无从分辨「慢」与「死」。灯面只观测不驱动回落(判活是观测面)。
//
// 六态(优先级从上到下,高者优先):
//   off          backend=ts,纯 TS 轨道,无 Core 可判 → 灯整体隐藏(零噪音)
//   bypassed     配了 rust/shadow 但 serverPath 落空,静默走 TS(自动发现
//                失败用户此前不可见,正是「配置了为什么没生效」的病灶)
//   unresponsive 探针失败:进程未启动/挂死/超时 → errorBackground
//   degraded     探针通过但命令腿熔断已开/有超时记录 → 部分功能走 TS 回落
//   ok           探针通过且命令腿干净
//   idle         Core 轨道就绪,探针尚未返回(启动窗口)
//
// 探针节奏:首探在装配时,之后自续(schedule→探→完→再 schedule)。单飞:
// 在途探针期间不叠加;每轮预算 2s(gate.probeHealth 内部竞速,探针永不悬
// 挂)。状态栏点击 = QuickPick(重启 Core / 查看诊断详情)。

export const CORE_HEALTH_PANEL_COMMAND = 'kbengine.core.healthPanel';
export const CORE_HEALTH_PROBE_INTERVAL_MS = 10_000;
export const CORE_HEALTH_PROBE_TIMEOUT_MS = 2_000;

export type CoreHealthLightKind =
  | 'off'
  | 'bypassed'
  | 'unresponsive'
  | 'degraded'
  | 'ok'
  | 'idle';

/** 探针快照(最近一轮;null = 尚未探过) */
export interface CoreHealthProbeResult {
  ok: boolean;
  latencyMs: number;
}

/** 门侧可观测快照(与 KodeCoreGate.state/commandCircuitState 同源形状) */
export interface CoreHealthGateSnapshot {
  backendMode: 'ts' | 'rust' | 'shadow';
  serverPathPresent: boolean;
  clientAlive: boolean;
  commandCircuit: { open: boolean; timeoutStreak: number };
}

export interface CoreHealthLightInputs extends CoreHealthGateSnapshot {
  probe: CoreHealthProbeResult | null;
}

/** 六态脸面;文案只描述已核实的事实 */
export const CORE_HEALTH_LIGHT_FACES: Record<
  CoreHealthLightKind,
  { text: string; tooltip: string; errorBackground?: boolean }
> = {
  off: {
    text: '$(circle-slash) Core: 关',
    tooltip: 'kbengine.core.backend=ts,纯 TS 轨道,无 Rust Core 进程。'
  },
  bypassed: {
    text: '$(plug) Core: 未接入',
    tooltip:
      'kbengine.core.backend 配置为 rust/shadow,但未找到 kode-server 二进制' +
      '(kbengine.core.serverPath 未配置且自动发现落空),当前静默走 TS 轨道。',
    errorBackground: true
  },
  unresponsive: {
    text: '$(error) Core: 无响应',
    tooltip:
      'kode-server 健康探针失败(进程未启动、已退出或挂死)。索引/跳转/CodeLens ' +
      '将退 TS 或停摆。建议点击本灯选择「重启核心服务」。',
    errorBackground: true
  },
  degraded: {
    text: '$(warning) Core: 降级',
    tooltip:
      'Core 探针通过,但命令腿最近出现超时(连续超时会熔断,命令级功能走 TS 回落)。' +
      '可点击本灯查看详情或重启。'
  },
  ok: {
    text: '$(check) Core: 正常',
    tooltip: 'kode-server 健康探针通过。点击本灯查看详情。'
  },
  idle: {
    text: '$(pulse) Core: 待探活',
    tooltip: 'Core 轨道已配置,健康探针尚未返回(启动窗口内属正常)。'
  }
};

/**
 * 六态仲裁(纯函数):优先级 off > bypassed > unresponsive > degraded > ok > idle。
 * off/bypassed 只看配置面;活性三态只看探针与熔断账,clientAlive 不参与仲裁
 * (门内 client 对象在 ≠ 进程活,判活以探针为准)。
 */
export function resolveCoreHealthLight(inputs: CoreHealthLightInputs): CoreHealthLightKind {
  if (inputs.backendMode === 'ts') {
    return 'off';
  }
  if (!inputs.serverPathPresent) {
    return 'bypassed';
  }
  if (inputs.probe === null) {
    return 'idle';
  }
  if (!inputs.probe.ok) {
    return 'unresponsive';
  }
  if (inputs.commandCircuit.open || inputs.commandCircuit.timeoutStreak > 0) {
    return 'degraded';
  }
  return 'ok';
}

/** 状态栏项最小面(与 hotReloadStatus.StatusBarItemLike 同形,另加背景色;
 * backgroundColor 走 unknown——真 vscode ThemeColor 结构随 d.ts 版本漂移,
 * 测试侧以 {id} 形状断言) */
export interface CoreHealthStatusBarItemLike {
  text: string;
  command: string | vscode.Command | undefined;
  tooltip?: string | vscode.MarkdownString | string;
  backgroundColor?: unknown;
  show(): void;
  hide(): void;
  dispose(): void;
}

export interface KodeCoreHealthLightDeps {
  createStatusBarItem(
    alignment: vscode.StatusBarAlignment,
    priority: number
  ): CoreHealthStatusBarItemLike;
  registerCommand(command: string, handler: () => void): { dispose(): void };
  timers: HotReloadTimerDeps;
  /** 门快照(mode/serverPath/clientAlive/命令熔断账) */
  snapshot(): CoreHealthGateSnapshot;
  /** 探针(gate.probeHealth;内部自带 2s 竞速预算,永不悬挂) */
  probe(): Promise<CoreHealthProbeResult>;
  /** 探针间隔毫秒(缺省 10s;测试注小值) */
  readonly probeIntervalMs?: number;
  /** 时间源(详情文案用);测试注固定值 */
  readonly now?: () => number;
  /** 诊断详情面(showInformationMessage 等;接线层注入) */
  showMessage(text: string): void;
  /** 动作选择面(QuickPick);返回选中 label,取消=undefined */
  pickAction(labels: readonly string[]): Promise<string | undefined>;
  /** 重启动作(接线层注既有 kbengine.core.restart 逻辑;缺省=面板不提供重启项) */
  readonly restartCore?: () => void;
}

export const CORE_ERROR_BACKGROUND_COLOR_ID = 'statusBarItem.errorBackground';

export class KodeCoreHealthLightController {
  private readonly deps: KodeCoreHealthLightDeps;
  private readonly bar: CoreHealthStatusBarItemLike;
  private lastProbe: CoreHealthProbeResult | null = null;
  private lastKind: CoreHealthLightKind = 'idle';
  private timerHandle: unknown;
  private disposed = false;
  private readonly commandRegistration: { dispose(): void };

  constructor(deps: KodeCoreHealthLightDeps) {
    this.deps = deps;
    // priority 91:既存灯带 100(explorer)/99(telnet)/98(热更)/97(解释器)/
    // 96(通道)/95(tail)/94(Core 对拍)/93(MCP)/92(语言服务)之下,不挤既有序
    this.bar = deps.createStatusBarItem(vscode.StatusBarAlignment.Right, 91);
    this.commandRegistration = deps.registerCommand(CORE_HEALTH_PANEL_COMMAND, () => {
      this.showPanel();
    });
    this.render();
    void this.probeOnce();
  }

  /** 状态栏当前脸面(测试断言用) */
  get kind(): CoreHealthLightKind {
    return this.lastKind;
  }

  /** 单轮探活→渲染→自续下一轮。在途重复调用直接返回(单飞)。 */
  private async probeOnce(): Promise<void> {
    if (this.disposed || this.timerHandle !== undefined) {
      return;
    }
    let probe: CoreHealthProbeResult;
    try {
      probe = await this.deps.probe();
    } catch {
      probe = { ok: false, latencyMs: -1 };
    }
    if (this.disposed) {
      return;
    }
    this.lastProbe = probe;
    this.render();
    this.scheduleNext();
  }

  private scheduleNext(): void {
    if (this.disposed) {
      return;
    }
    const intervalMs = this.deps.probeIntervalMs ?? CORE_HEALTH_PROBE_INTERVAL_MS;
    this.timerHandle = this.deps.timers.set(() => {
      this.timerHandle = undefined;
      void this.probeOnce();
    }, intervalMs);
  }

  /** 按最近快照渲染;off 态整灯隐藏(纯 TS 轨道零噪音) */
  render(): void {
    const snapshot = this.deps.snapshot();
    const kind = resolveCoreHealthLight({ ...snapshot, probe: this.lastProbe });
    this.lastKind = kind;
    const face = CORE_HEALTH_LIGHT_FACES[kind];
    this.bar.text = face.text;
    this.bar.tooltip = face.tooltip;
    this.bar.command = CORE_HEALTH_PANEL_COMMAND;
    this.bar.backgroundColor = face.errorBackground
      ? ({ id: CORE_ERROR_BACKGROUND_COLOR_ID } as unknown)
      : undefined;
    if (kind === 'off') {
      this.bar.hide();
      return;
    }
    this.bar.show();
  }

  /** 点击面板:诊断详情即时可得(当前态+探针账+配置);重启必须用户选择 */
  private showPanel(): void {
    const snapshot = this.deps.snapshot();
    const kind = resolveCoreHealthLight({ ...snapshot, probe: this.lastProbe });
    const probeLine = this.lastProbe
      ? `最近探针:${this.lastProbe.ok ? '通过' : '失败'}(${this.lastProbe.latencyMs}ms)`
      : '最近探针:尚未返回';
    const circuit = snapshot.commandCircuit;
    const circuitLine = circuit.open
      ? `命令腿熔断:已开放(连续超时 ${circuit.timeoutStreak} 次)`
      : `命令腿熔断:未开放(连续超时 ${circuit.timeoutStreak} 次)`;
    const backendLine =
      snapshot.backendMode === 'ts'
        ? 'backend=ts(纯 TS 轨道)'
        : `backend=${snapshot.backendMode},serverPath ${snapshot.serverPathPresent ? '已配置' : '未配置'}`;
    const kindLabel = CORE_HEALTH_LIGHT_FACES[kind].text.replace(/^\$\([^)]+\)\s*/, '');
    const detail = `Core 健康:${kindLabel};${backendLine};${probeLine};${circuitLine}`;
    this.deps.showMessage(detail);
    if (snapshot.backendMode === 'ts' || !this.deps.restartCore) {
      return;
    }
    void this.deps.pickAction(['重启核心服务']).then(label => {
      if (label === '重启核心服务') {
        this.deps.restartCore?.();
      }
    });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.timerHandle !== undefined) {
      this.deps.timers.clear(this.timerHandle);
      this.timerHandle = undefined;
    }
    this.commandRegistration.dispose();
    this.bar.dispose();
  }
}
