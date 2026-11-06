import * as vscode from 'vscode';
import type { HotReloadTimerDeps } from './hotReload';
import { HOT_RELOAD_TOGGLE_COMMAND, toggleHotReloadEnabled } from './hotReloadToggle';

// 热更新状态栏反馈(KODE2 backlog HR-UI-001,docs/kode2/KODE_2_COMPLETE_TODO.md:572):
// 状态栏项区分 Watch Off → Ready → Sending → Sent(未确认) → Failed。
// 口径红线:动作完成且无错只记"已发送(未确认)",不校验业务回执、禁标
// 成功/Applied(回执校验属 HR-STATE 系列,本轮不做)。状态文案与日志同源。
// 用户令 2026-11-06:热更默认开启 → 状态栏点击 = 一键关/开(执行
// kbengine.hotReload.toggle,写回配置),开日志仍走 kbengine.hotReload.showLog
// 命令面;开与关的说明提示随开关出。状态变更经节流合并(HR-UI-007 同思路):
// 首个状态即时上屏,节流窗内的后续变更合并成一次尾沿渲染。
//
// HOT-VER(文件版本号):五种状态与版本号正交组合,不新增状态——单号=已同步
// (`热更: 就绪 v3`),双号=待同步(`热更: … v2→v3`,左=基线/上次发送版本,
// 右=盘上当前版本)。版本数据来自 HotReloadVersionSource(台账内版本簿,独立于
// watcher 开关);未注入=纯五态文案,既有断言不回归。点击状态栏先刷新版本再把
// 版本台账写进 OUTPUT。

export const HOT_RELOAD_SHOW_LOG_COMMAND = 'kbengine.hotReload.showLog';
export const HOT_RELOAD_LOG_CHANNEL_NAME = 'KBEngine 热更新';
export const HOT_RELOAD_STATUS_THROTTLE_MS = 200;

export type HotReloadStatusKind =
  | 'watch-off'
  | 'ready'
  | 'ready-with-error'
  | 'sending'
  | 'sent-unverified'
  | 'failed';

/** watch-off 的如实原因(§11.1:缺根与空 globs 绝不混为一谈) */
export type HotReloadWatchOffReason = 'disabled' | 'empty-globs';

/** 当前监视模式的来源(§11.1:显式配置 or 从 assetsRoot 派生) */
export type HotReloadGlobSource = 'explicit' | 'derived';

/** 各状态的状态栏脸面;文案只描述已核实的事实,未确认不称成功 */
const STATUS_FACES: Record<HotReloadStatusKind, { text: string; tooltip: string }> = {
  'watch-off': {
    text: '$(eye-closed) 热更: 关',
    tooltip: '热更新监视未开启。点击可一键开启,或运行 kbengine.hotReload.toggle'
  },
  ready: {
    text: '$(eye) 热更: 就绪',
    tooltip:
      '热更新监视就绪,保存 .py 将按去抖触发热更(未配动作名时发默认 hotfix 请求)。点击可一键关闭(kbengine.hotReload.toggle)'
  },
  'ready-with-error': {
    text: '$(warning) 热更: 就绪(未监视)',
    tooltip: '热更监视范围不可用(配置错误)'
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

/**
 * 单文件版本徽标(HOT-VER):baseline=基线/上次已核验同步版本,current=盘上
 * 当前版本。二者相等=已同步(单号),不等=待同步(双号,基线→盘上)。
 */
export interface HotReloadVersionBadgeView {
  readonly file: string;
  readonly baseline: number;
  readonly current: number;
}

/**
 * 版本数据源(状态栏与 OUTPUT 报告共用):badge/pending/report 同步读台账内
 * 版本簿,refresh 异步重采盘上 token 并结算 applied 基线追平,返回是否有变化。
 * 数据源独立于 watcher 开关——watcher 只是它的默认事件来源之一,手动触发路径
 * (showFileState/retryFailed/右键手动发一次热更)写同一份台账同一实现。
 */
export interface HotReloadVersionSource {
  /** 当前活动文档的版本;不在监视范围/未跟踪则回落最近变更文件;全无=undefined */
  badge(): HotReloadVersionBadgeView | undefined;
  /** 全部待同步文件(基线 ≠ 盘上当前),按文件路径排序 */
  pending(): HotReloadVersionBadgeView[];
  /** OUTPUT 版本台账行(当前文件/基线/盘上/每次版本跃迁与回执);无=空数组 */
  report(): string[];
  /** 重采盘上版本 + applied 基线追平;返回是否有变化(供补渲染收敛) */
  refresh(): Promise<boolean>;
}

/** 版本号后缀:单号=已同步,双号=基线→盘上(不暴露 mtime:size 原始 token) */
export const formatHotReloadVersionSuffix = (baseline: number, current: number): string =>
  baseline === current ? `v${current}` : `v${baseline}→v${current}`;

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
  /** 版本数据源(可选):注入即状态栏带文件版本徽标;不注入=纯五态文案 */
  readonly versions?: HotReloadVersionSource;
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
  private readonly commandRegistrations: Array<{ dispose(): void }>;
  private kind: HotReloadStatusKind = 'watch-off';
  /** 上次落账的变更日志行:内容没变的同态重复压掉,内容变了照记(§11.4) */
  private lastChangeLog: string | undefined;
  /** 状态附注(来源/glob/缺根补救等):只叠 tooltip,不改状态脸面 */
  private tooltipNote: string | undefined;
  private windowOpen = false;
  private pendingKind: HotReloadStatusKind | undefined;
  private windowHandle: unknown;
  /** 版本重采在飞标记:渲染触发的补渲染收敛为「变了才再渲染」,不空转 */
  private refreshInFlight = false;
  private disposedFlag = false;

  constructor(deps: HotReloadStatusDeps) {
    this.deps = deps;
    this.throttleMs = deps.throttleMs ?? HOT_RELOAD_STATUS_THROTTLE_MS;
    this.now = deps.now ?? (() => Date.now());
    this.bar = deps.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
    // 点击状态栏 = 一键关/开(用户令 2026-11-06);开日志命令仍单独注册
    this.bar.command = HOT_RELOAD_TOGGLE_COMMAND;
    this.channel = deps.createOutputChannel(HOT_RELOAD_LOG_CHANNEL_NAME);
    // 命令面并集:开关命令(HOT-VER 之前已有)与开日志命令都注册;
    // 开日志走带版本台账的入口(无版本数据源时退回纯开通道,原样)。
    this.commandRegistrations = [
      deps.registerCommand(HOT_RELOAD_SHOW_LOG_COMMAND, () => this.showLogWithVersions()),
      deps.registerCommand(HOT_RELOAD_TOGGLE_COMMAND, () => this.toggleEnabled())
    ];
    this.render('watch-off');
    this.bar.show();
  }

  /** 立即落日志行(带 time 前缀);不走节流 */
  log(text: string): void {
    this.channel.appendLine(`[${formatHotReloadTime(this.now())}] ${text}`);
  }

  /**
   * watch-off 按原因如实提示(§11.1):`disabled` 与 `empty-globs` 两种原因
   * 绝不混写;detail 带缺根/补救等上下文,tooltip 与日志同源。
   */
  setWatchOff(reason: HotReloadWatchOffReason = 'disabled', detail?: string): void {
    const base =
      reason === 'empty-globs'
        ? '未开启: kbengine.hotReload.globs 为空(用户显式清空,不派生、不回落全扫)'
        : '未开启: kbengine.hotReload.enabled=false';
    const note = detail ? `${base};${detail}` : base;
    this.setState('watch-off', note, note);
  }

  /**
   * 就绪:当前监视模式 + 来源一并上屏(§11.1 如实口径——用户要能看出
   * 看的是显式配置还是 assetsRoot 派生)。日志保留既有前缀(消费方 includes
   * 口径不变),来源与模式追加在后。
   */
  setReady(globs: readonly string[], source: HotReloadGlobSource, debounceMs: number): void {
    const modes = globs.join(', ');
    this.setState(
      'ready',
      `监视就绪: ${globs.length} 个模式, 去抖 ${debounceMs}ms | 来源=${source} | 模式=${modes}`,
      `监视模式: ${modes}(来源=${source})`
    );
  }

  /**
   * ready-with-error(§11.1):开着但监视范围解析不出来(缺 assetsRoot)——
   * 显式报错 + 补救指路,绝不静默回落裸全工作区扫。
   */
  setReadyError(detail: string): void {
    this.setState('ready-with-error', `监视范围不可用: ${detail}`, detail);
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

  /** 开日志通道(既有各命令面共用,只开通道不加工) */
  showLog(): void {
    this.channel.show();
  }

  /**
   * 一键关/开:状态栏点击与 kbengine.hotReload.toggle 命令同一条路——
   * 写回配置(不是内存开关),配置事件驱动 watcher 拆建;开关说明走非模态
   * 提示,写回失败如实进日志与错误提示,不改状态机脸面。
   */
  private toggleEnabled(): void {
    void toggleHotReloadEnabled()
      .then(next => {
        this.log(
          next
            ? '一键开启: kbengine.hotReload.enabled=true(保存 .py 即发默认热更请求)'
            : '一键关闭: kbengine.hotReload.enabled=false(不再自动发送)'
        );
        const message = next
          ? '自动热更已开启:保存 .py 即向 http://127.0.0.1:8090/hotfix?module_name=<模块名> 发送(query 与 body 各带一份)'
          : '自动热更已关闭(kbengine.hotReload.enabled=false);点击状态栏「热更」项或再运行 kbengine.hotReload.toggle 可开启';
        // 提示里保留开日志入口:状态栏点击已让位给一键关,日志面从这里走
        void Promise.resolve(
          vscode.window.showInformationMessage(message, '打开日志').then(choice => {
            if (choice === '打开日志') {
              this.showLog();
            }
          })
        ).catch(() => undefined);
      })
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        this.log(`一键开关写回配置失败: ${detail}`);
        void Promise.resolve(
          vscode.window.showErrorMessage(`热更开关写回配置失败: ${detail}`)
        ).catch(() => undefined);
      });
  }

  /**
   * 开日志命令(HOT-VER):先重采盘上版本,把版本台账(当前文件/基线/
   * 盘上/每次版本跃迁的时间与发送回执)落进 OUTPUT 再开通道;无版本数据源
   * =原样开通道。
   */
  showLogWithVersions(): void {
    const source = this.deps.versions;
    if (!source) {
      this.channel.show();
      return;
    }
    void Promise.resolve()
      .then(() => source.refresh())
      .catch(() => undefined)
      .then(() => {
        if (this.disposedFlag) {
          return;
        }
        for (const line of source.report()) {
          this.channel.appendLine(line);
        }
        this.channel.show();
        this.versionsChanged();
      });
  }

  /** 版本数据变化(采样/回执/活动文档切换)→ 走同一节流窗补渲染一次 */
  versionsChanged(): void {
    if (this.disposedFlag) {
      return;
    }
    this.render(this.kind);
  }

  dispose(): void {
    this.disposedFlag = true;
    if (this.windowHandle !== undefined) {
      this.deps.timers.clear(this.windowHandle);
      this.windowHandle = undefined;
    }
    this.pendingKind = undefined;
    this.windowOpen = false;
    for (const registration of this.commandRegistrations) {
      registration.dispose();
    }
    this.bar.dispose();
    this.channel.dispose();
  }

  /**
   * 状态转移 + 可选的变更日志(§11.4:来源/模式要「随状态栏与日志上屏」)。
   * 记账口径:换态必记;同态但**内容变了**(derived→explicit、模式增减、缺根
   * 补救出现)也记——否则 ready→ready 的来源切换只进 tooltip、日志留旧值;
   * 内容一字不差的重复仍压掉(防配置抖动刷屏)。
   */
  private setState(kind: HotReloadStatusKind, changeLog?: string, tooltipNote?: string): void {
    const changed = kind !== this.kind;
    const contentChanged = changeLog !== undefined && changeLog !== this.lastChangeLog;
    this.kind = kind;
    this.tooltipNote = tooltipNote;
    if (changeLog !== undefined) {
      this.lastChangeLog = changeLog;
    }
    if ((changed || contentChanged) && changeLog) {
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
    const source = this.deps.versions;
    const badge = source?.badge();
    const pending = source?.pending() ?? [];
    this.bar.text =
      badge === undefined ? face.text : `${face.text} ${formatHotReloadVersionSuffix(badge.baseline, badge.current)}`;
    // 状态 tooltip 的来源/模式附注(§11.4)与版本块叠在一起,两个口径都保留
    const base = this.tooltipNote ? `${face.tooltip};${this.tooltipNote}` : face.tooltip;
    this.bar.tooltip = this.buildTooltip(base, badge, pending);
    this.kickRefresh();
  }

  /** 状态 tooltip + 版本块:当前文件版本对 + 全部待同步文件版本对 */
  private buildTooltip(
    base: string,
    badge: HotReloadVersionBadgeView | undefined,
    pending: readonly HotReloadVersionBadgeView[]
  ): string {
    if (badge === undefined && pending.length === 0) {
      return base;
    }
    const lines = [base];
    if (badge !== undefined) {
      const sync = formatHotReloadVersionSuffix(badge.baseline, badge.current);
      lines.push(`当前文件 ${badge.file}: ${badge.baseline === badge.current ? `${sync}(已同步)` : `${sync}(待同步)`}`);
    }
    if (pending.length > 0) {
      lines.push(`待同步 ${pending.length} 个:`);
      for (const item of pending) {
        lines.push(`  ${item.file} ${formatHotReloadVersionSuffix(item.baseline, item.current)}`);
      }
    }
    return lines.join('\n');
  }

  /**
   * 渲染后异步重采盘上版本:任何路径(watcher 事件/回执/手动触发/活动文档切换)
   * 都经这一口收敛——采到变化才补渲染一次,没变化就地停,不空转。
   */
  private kickRefresh(): void {
    const source = this.deps.versions;
    if (!source || this.refreshInFlight || this.disposedFlag) {
      return;
    }
    this.refreshInFlight = true;
    void Promise.resolve()
      .then(() => source.refresh())
      .then(
        changed => {
          this.refreshInFlight = false;
          if (changed) {
            this.versionsChanged();
          }
        },
        () => {
          this.refreshInFlight = false;
        }
      );
  }
}
