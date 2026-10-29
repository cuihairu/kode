import * as vscode from 'vscode';
import type { HotReloadTimerDeps } from './hotReload';

// 热更新状态栏反馈(KODE2 backlog HR-UI-001,docs/kode2/KODE_2_COMPLETE_TODO.md:572):
// 状态栏项区分 Watch Off → Ready → Sending → Sent(未确认) → Failed。
// 口径红线:动作完成且无错只记"已发送(未确认)",不校验业务回执、禁标
// 成功/Applied(回执校验属 HR-STATE 系列,本轮不做)。状态文案与日志同源,
// 点击状态栏项打开专用 OUTPUT 通道。状态变更经节流合并(HR-UI-007 同思路):
// 首个状态即时上屏,节流窗内的后续变更合并成一次尾沿渲染。

export const HOT_RELOAD_SHOW_LOG_COMMAND = 'kbengine.hotReload.showLog';
export const HOT_RELOAD_LOG_CHANNEL_NAME = 'KBEngine 热更新';
export const HOT_RELOAD_STATUS_THROTTLE_MS = 200;

export type HotReloadStatusKind =
  | 'watch-off'
  | 'ready'
  | 'sending'
  | 'sent-unverified'
  | 'failed';

/** 各状态的状态栏脸面;文案只描述已核实的事实,未确认不称成功 */
const STATUS_FACES: Record<HotReloadStatusKind, { text: string; tooltip: string }> = {
  'watch-off': {
    text: '$(eye-closed) 热更: 关',
    tooltip: '热更新监视未开启(kbengine.hotReload.enabled=false 或 globs 为空)'
  },
  ready: {
    text: '$(eye) 热更: 就绪',
    tooltip: '热更新监视就绪,文件改动将按去抖触发动作'
  },
  sending: {
    text: '$(sync~spin) 热更: 发送中',
    tooltip: '热更动作已触发,等待执行完成'
  },
  'sent-unverified': {
    text: '$(cloud-upload) 热更: 已发送(未确认)',
    tooltip: '热更动作已执行且无错;未校验业务回执,不确认已生效'
  },
  failed: {
    text: '$(error) 热更: 失败',
    tooltip: '最近一次热更动作失败'
  }
};

/** 状态栏项最小面:真 vscode.StatusBarItem 的结构子集,测试用假体同形 */
export interface StatusBarItemLike {
  text: string;
  command: string | vscode.Command | undefined;
  tooltip?: string | vscode.MarkdownString | string;
  show(): void;
  hide(): void;
  dispose(): void;
}

/** 输出通道最小面:appendLine/show/dispose,测试用假体同形 */
export interface OutputChannelLike {
  appendLine(line: string): void;
  show(): void;
  dispose(): void;
}

export interface HotReloadStatusDeps {
  createStatusBarItem(alignment: vscode.StatusBarAlignment, priority: number): StatusBarItemLike;
  createOutputChannel(name: string): OutputChannelLike;
  registerCommand(command: string, handler: () => void): { dispose(): void };
  timers: HotReloadTimerDeps;
  /** 节流窗毫秒;0 仍开窗(同刻变更合并到尾沿) */
  readonly throttleMs?: number;
  /** 时间源(日志行前缀);测试注固定值,缺省真时钟 */
  readonly now?: () => number;
}

/** 本地时间 HH:MM:SS;纯函数便于直测 */
export const formatHotReloadTime = (epochMs: number): string => {
  const date = new Date(epochMs);
  const pad = (value: number): string => `${value < 10 ? '0' : ''}${value}`;
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

/**
 * 状态机控制器:状态栏渲染(节流合并)+ OUTPUT 日志(即时落账)。
 * 日志不受节流影响——它是审计面,每条触发/结果都必须在账上;
 * 节流只合并状态栏文字的渲染频次。
 */
export class HotReloadStatusController {
  private readonly deps: HotReloadStatusDeps;
  private readonly throttleMs: number;
  private readonly now: () => number;
  private readonly bar: StatusBarItemLike;
  private readonly channel: OutputChannelLike;
  private readonly commandRegistration: { dispose(): void };
  private kind: HotReloadStatusKind = 'watch-off';
  private windowOpen = false;
  private pendingKind: HotReloadStatusKind | undefined;
  private windowHandle: unknown;

  constructor(deps: HotReloadStatusDeps) {
    this.deps = deps;
    this.throttleMs = deps.throttleMs ?? HOT_RELOAD_STATUS_THROTTLE_MS;
    this.now = deps.now ?? (() => Date.now());
    this.bar = deps.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
    this.bar.command = HOT_RELOAD_SHOW_LOG_COMMAND;
    this.channel = deps.createOutputChannel(HOT_RELOAD_LOG_CHANNEL_NAME);
    this.commandRegistration = deps.registerCommand(HOT_RELOAD_SHOW_LOG_COMMAND, () => this.showLog());
    this.render('watch-off');
    this.bar.show();
  }

  /** 立即落日志行(带 time 前缀);不走节流 */
  log(text: string): void {
    this.channel.appendLine(`[${formatHotReloadTime(this.now())}] ${text}`);
  }

  setWatchOff(): void {
    this.setState('watch-off', '监视未开启(kbengine.hotReload.enabled=false 或 globs 为空)');
  }

  setReady(globCount: number, debounceMs: number): void {
    this.setState(
      'ready',
      `监视就绪: ${globCount} 个模式, 去抖 ${debounceMs}ms`
    );
  }

  /** 触发到点、动作发起;triggers=去抖合并到的文件,debounceMs=实际去抖值 */
  setSending(triggers: string[], debounceMs: number): void {
    this.setState('sending');
    const triggerText = triggers.length > 0 ? triggers.join(', ') : '(无文件路径)';
    this.log(`触发: ${triggerText} (去抖 ${debounceMs}ms 到点)`);
  }

  /** 动作完成且无错;无业务回执,只记未确认,禁称成功 */
  setSentUnverified(): void {
    this.setState('sent-unverified');
    this.log('结果: 已发送(未确认)——未校验业务回执');
  }

  setFailed(detail: string): void {
    this.setState('failed');
    this.log(`结果: 失败: ${detail}`);
  }

  /** 触发到点但未配动作名:状态回落就绪,动作跳过仍记账 */
  setSkippedNoAction(triggers: string[]): void {
    this.setState('ready');
    const triggerText = triggers.length > 0 ? triggers.join(', ') : '(无文件路径)';
    this.log(`触发到点但未配动作名(kbengine.hotReload.actionName), 跳过: ${triggerText}`);
  }

  /** IDE-REV-024 结构性 def 变更:整批不发普通 reload,状态回落就绪(不是失败),日志记需重启原因 */
  setRestartRequired(reasons: string[], triggers: string[]): void {
    this.setState('ready');
    const triggerText = triggers.length > 0 ? triggers.join(', ') : '(无文件路径)';
    this.log(`结构性 def 变更需重启,不作为普通 reload 发送: ${reasons.join(';')} | 触发: ${triggerText}`);
  }

  showLog(): void {
    this.channel.show();
  }

  dispose(): void {
    if (this.windowHandle !== undefined) {
      this.deps.timers.clear(this.windowHandle);
      this.windowHandle = undefined;
    }
    this.pendingKind = undefined;
    this.windowOpen = false;
    this.commandRegistration.dispose();
    this.bar.dispose();
    this.channel.dispose();
  }

  /** 状态转移 + 可选的变更日志(同类不重复记,防配置抖动刷屏) */
  private setState(kind: HotReloadStatusKind, changeLog?: string): void {
    const changed = kind !== this.kind;
    this.kind = kind;
    if (changed && changeLog) {
      this.log(changeLog);
    }
    this.render(kind);
  }

  /**
   * 节流渲染:窗关着 → 即时上屏并开窗;窗开着 → 只留最新,尾沿一次渲染。
   * 尾沿渲染后再开窗,窗内无后续变更则计时器空放一次后归零。
   */
  private render(kind: HotReloadStatusKind): void {
    if (this.windowOpen) {
      this.pendingKind = kind;
      return;
    }
    this.apply(kind);
    this.windowOpen = true;
    this.windowHandle = this.deps.timers.set(() => {
      this.windowHandle = undefined;
      this.windowOpen = false;
      if (this.pendingKind !== undefined) {
        const next = this.pendingKind;
        this.pendingKind = undefined;
        this.render(next);
      }
    }, this.throttleMs);
  }

  private apply(kind: HotReloadStatusKind): void {
    const face = STATUS_FACES[kind];
    this.bar.text = face.text;
    this.bar.tooltip = face.tooltip;
  }
}
