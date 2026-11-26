import * as vscode from 'vscode';
import type { HotReloadTimerDeps } from './hotReload';
import { l10nText } from './nlsRuntime';

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
// 挂)。状态栏点击 = QuickPick(重启 Core / 切换轨道 ts|rust|shadow /
// 查看诊断详情);切换写配置面(kbengine.core.backend),既有配置事件链
// 即时重装配轨道,不重载窗口。不新增灯位:降级就亮在这盏灯上。

export const CORE_HEALTH_PANEL_COMMAND = 'kbengine.core.healthPanel';
export const CORE_HEALTH_PROBE_INTERVAL_MS = 10_000;
export const CORE_HEALTH_PROBE_TIMEOUT_MS = 2_000;

/** Shown only in the bypassed face (tooltip and panel): a late install still
 * needs a reload if bin/ events were missed during activation. */
export const CORE_RELOAD_WINDOW_HINT =
  'If the extension was just installed or updated, run Developer: Reload Window to let the activation chain discover the binary again.';

export type CoreHealthLightKind =
  | 'off'
  | 'bypassed'
  | 'unresponsive'
  | 'degraded'
  | 'ok'
  | 'idle';

/** 探针快照(最近一轮;null = 尚未探过)。reason=快速失败臂原错误词
 * (TIMEOUT/EXITED/spawn 原文);缺省=探针预算内未决(疑似挂死) */
export interface CoreHealthProbeResult {
  ok: boolean;
  latencyMs: number;
  reason?: string;
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

export interface CoreHealthLightFace {
  text: string;
  tooltip: string;
  errorBackground?: boolean;
}

/** 六态脸面文案键(英文源串;zh-cn 译文在 l10n/bundle.l10n.zh-cn.json) */
const CORE_HEALTH_FACE_TEXT: Record<CoreHealthLightKind, string> = {
  off: '$(circle-slash) Core: off',
  bypassed: '$(plug) Core: degraded (not attached)',
  unresponsive: '$(error) Core: no response',
  degraded: '$(warning) Core: degraded',
  ok: '$(check) Core: ok',
  idle: '$(pulse) Core: probing'
};

// 注意:键必须是单行完整字面量——categoryI18n 死键门按「源码里能找到键原文」
// 反向对账,跨行 '+' 拼接的键在源码里拼不出原文会被判死键(2026-11-24 判例)。
const CORE_HEALTH_FACE_TOOLTIP: Record<CoreHealthLightKind, string> = {
  off: 'kbengine.core.backend is ts (pure TS track); there is no Rust Core process to probe.',
  bypassed:
    'kbengine.core.backend is configured as rust/shadow but no kode-server binary was found (kbengine.core.serverPath is unset and auto-discovery came up empty); the extension is actually running the TS track. Click this item to switch tracks. If the extension was just installed or updated, run Developer: Reload Window to let the activation chain discover the binary again.',
  unresponsive:
    'kode-server health probe failed (process not started, exited, or hung). Index/jump/CodeLens will fall back to TS or stall.',
  degraded:
    'Core probe passed, but the command leg recently timed out (enough consecutive timeouts opens the circuit and routes commands to the TS fallback).',
  ok: 'kode-server health probe passed. Click this item for details.',
  idle: 'Core track configured; the health probe has not returned yet (normal during startup).'
};

/**
 * 六态脸面(运行时取词,故用函数而非模块级常量):英文系统返回源串,中文系统
 * 返回 zh-cn 包译文;缺 key 回落源串,不空串不裸键。
 */
export function coreHealthLightFaces(): Record<CoreHealthLightKind, CoreHealthLightFace> {
  const faces = {} as Record<CoreHealthLightKind, CoreHealthLightFace>;
  for (const kind of Object.keys(CORE_HEALTH_FACE_TEXT) as CoreHealthLightKind[]) {
    faces[kind] = {
      text: l10nText(CORE_HEALTH_FACE_TEXT[kind]),
      tooltip: l10nText(CORE_HEALTH_FACE_TOOLTIP[kind]),
      errorBackground: CORE_HEALTH_LIGHT_FACE_ERROR_BACKGROUND[kind]
    };
  }
  return faces;
}

/** 高危底色脸面(与六态脸面同表;bypassed/unresponsive 用 errorBackground 提示) */
const CORE_HEALTH_LIGHT_FACE_ERROR_BACKGROUND: Partial<
  Record<CoreHealthLightKind, boolean>
> = {
  bypassed: true,
  unresponsive: true
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

// 点击面板动作(2026-11-24 用户令:点击灯可切换 Core 轨道)。动作是语义项
// (restart/ts/rust/shadow),展示文案经 l10nText 取词;选中回查也走同一
// 取词——若直存中文字符串常量做映射,中文 locale 下选中项会被判成未识别。
export type CoreHealthPanelAction = 'restart' | 'ts' | 'rust' | 'shadow';

/** 动作文案键(英文源串;zh-cn 译文在 l10n/bundle.l10n.zh-cn.json) */
const CORE_HEALTH_ACTION_TEXT: Record<CoreHealthPanelAction, string> = {
  restart: 'Restart core service',
  ts: 'Switch to ts track',
  rust: 'Switch to rust track',
  shadow: 'Switch to shadow track'
};

/** 动作展示文案(英文系统=源串,中文系统=包译文) */
export function coreHealthActionLabel(action: CoreHealthPanelAction): string {
  return l10nText(CORE_HEALTH_ACTION_TEXT[action]);
}

/**
 * 点击面板动作列表(纯函数,可矩阵测):重启项只在有 Rust 进程可重启时出
 * (backend=ts 如实没有);切换项按当前轨道排除自身,能力面缺失(接线层未注入
 * 对应 dep)时不出——面板宁少一项,不谎报能做的事。
 */
export function resolveCoreHealthPanelActions(
  backendMode: 'ts' | 'rust' | 'shadow',
  canRestart: boolean,
  canSwitch: boolean
): CoreHealthPanelAction[] {
  const actions: CoreHealthPanelAction[] = [];
  if (canRestart && backendMode !== 'ts') {
    actions.push('restart');
  }
  if (canSwitch) {
    if (backendMode !== 'ts') {
      actions.push('ts');
    }
    if (backendMode !== 'rust') {
      actions.push('rust');
    }
    if (backendMode !== 'shadow') {
      actions.push('shadow');
    }
  }
  return actions;
}

/** 选中文案 → 动作(undefined/null=取消或未识别文案,调用方不做事) */
export function coreHealthActionFromLabel(
  label: string | undefined | null
): CoreHealthPanelAction | undefined {
  if (label === undefined || label === null) {
    return undefined;
  }
  return (Object.keys(CORE_HEALTH_ACTION_TEXT) as CoreHealthPanelAction[]).find(
    action => coreHealthActionLabel(action) === label
  );
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
  /** 轨道切换动作(接线层注 writeCoreBackendMode;缺省=面板不提供切换项) */
  readonly setBackend?: (mode: 'ts' | 'rust' | 'shadow') => void;
  /** Re-discover the packaged binary before a panel read; unset = no behavior. */
  readonly rerediscover?: () => void;
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
    const face = coreHealthLightFaces()[kind];
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

  /** 点击面板:诊断详情即时可得(当前态+探针账+配置);重启与切轨必须用户选择 */
  private showPanel(): void {
    // KODE-COREDISCOVER-001: the panel must show the live discovery result, not
    // the activation-time snapshot; a late bin/ landing must be picked up here.
    if (this.deps.rerediscover) {
      try {
        this.deps.rerediscover();
      } catch (error) {
        console.error('Core rediscovery failed; showing last known state', error);
      }
    }
    this.render();
    const snapshot = this.deps.snapshot();
    const kind = resolveCoreHealthLight({ ...snapshot, probe: this.lastProbe });
    const probeLine = this.lastProbe
      ? l10nText(
          this.lastProbe.ok
            ? 'Last probe: passed ({ms}ms)'
            : 'Last probe: failed ({ms}ms)',
          { ms: this.lastProbe.latencyMs }
        )
      : l10nText('Last probe: no result yet');
    const reasonLine =
      this.lastProbe && !this.lastProbe.ok
        ? this.lastProbe.reason
          ? l10nText('Failure reason: {reason}', { reason: this.lastProbe.reason })
          : l10nText('Failure reason: probe inconclusive within budget (likely hung)')
        : '';
    const circuit = snapshot.commandCircuit;
    const circuitLine = circuit.open
      ? l10nText(
          'Command circuit: open ({streak} consecutive timeouts; new commands fall back to TS immediately)',
          { streak: circuit.timeoutStreak }
        )
      : l10nText('Command circuit: closed ({streak} consecutive timeouts)', {
          streak: circuit.timeoutStreak
        });
    const backendLine =
      snapshot.backendMode === 'ts'
        ? l10nText('backend=ts (pure TS track)')
        : snapshot.serverPathPresent
          ? l10nText('backend={mode}, serverPath configured', { mode: snapshot.backendMode })
          : l10nText('backend={mode}, serverPath missing', { mode: snapshot.backendMode });
    // 剥图标与「Core:」前缀取纯状态词,避免详情行出现「Core health: Core: ok」重复
    const kindLabel = coreHealthLightFaces()[kind].text.replace(/^\$\([^)]+\)\s*Core:\s*/, '');
    const detail = [
      l10nText('Core health: {kind}', { kind: kindLabel }),
      backendLine,
      probeLine,
      ...(reasonLine ? [reasonLine] : []),
      circuitLine,
      ...(kind === 'bypassed' ? [l10nText(CORE_RELOAD_WINDOW_HINT)] : [])
    ].join('; ');
    this.deps.showMessage(detail);
    const actions = resolveCoreHealthPanelActions(
      snapshot.backendMode,
      Boolean(this.deps.restartCore),
      Boolean(this.deps.setBackend)
    );
    if (actions.length === 0) {
      return;
    }
    void this.deps.pickAction(actions.map(coreHealthActionLabel)).then(label => {
      this.applyPanelAction(coreHealthActionFromLabel(label));
    });
  }

  /** 面板选中项分派:重启走既有命令;切换项写配置面(实时切轨,不重载窗口) */
  private applyPanelAction(action: CoreHealthPanelAction | undefined): void {
    if (action === 'restart') {
      this.deps.restartCore?.();
      return;
    }
    if (action === 'ts' || action === 'rust' || action === 'shadow') {
      this.deps.setBackend?.(action);
    }
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
