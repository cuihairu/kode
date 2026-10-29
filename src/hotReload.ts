import * as vscode from 'vscode';
import { HotReloadStatusController } from './hotReloadStatus';
import {
  HotReloadTargetStateStore,
  type HotReloadDeliveryOutcome
} from './hotReloadTargetState';
import { recordHttpDelivery } from './hotReloadDelivery';
import { applyAcceptedReceipt } from './hotReloadReceipt';

// 自动热重载(功能差距盘点 G5,docs/reference-feature-gap.md):文件保存/监视 →
// 触发指定 quick action。门控默认关防误触;启用后才按 kbengine.hotReload.globs
// 建 watcher,事件去抖合并连发保存,配置变更联动拆建 watcher。
// 状态栏反馈(HR-UI-001):装配内建状态机控制器,Watch Off/Ready/Sending/
// Sent(未确认)/Failed 上屏;动作完成且无错只记未确认,不校验业务回执。
// IDE-REV-021:注入 targetState 即按「rootId × targetId」双维台账逐发送
// 记账(同文件发不同实例各落各的,切目标不复用上一目标状态);动作完成
// 无回执仍记 sent-unverified——传输成功≠应用成功,不宣称热更成功。

export const HOT_RELOAD_DEFAULT_GLOBS = ['**/*.py'] as const;
export const HOT_RELOAD_DEFAULT_DEBOUNCE_MS = 500;

export interface HotReloadSettings {
  readonly enabled: boolean;
  readonly actionName: string;
  readonly globs: string[];
  readonly debounceMs: number;
}

/** 配置读取口:与 vscode.ConfigurationShape 同形,测试用内存替身驱动 */
export interface ConfigReader {
  get: <T>(key: string, defaultValue: T) => T;
}

/** 只留非空字符串;剔空则回落默认,保证调用方永远拿到可用的匹配模式 */
const readGlobs = (raw: unknown): string[] => {
  if (!Array.isArray(raw)) {
    return [...HOT_RELOAD_DEFAULT_GLOBS];
  }
  const kept = raw
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim())
    .filter(item => item.length > 0);
  return kept.length > 0 ? kept : [...HOT_RELOAD_DEFAULT_GLOBS];
};

/** 容忍式读取:类型不符或负去抖一律回落默认,配置写坏也不会拖垮装配 */
export function readHotReloadSettings(reader: ConfigReader): HotReloadSettings {
  const enabled = reader.get<boolean>('enabled', false);
  const actionName = reader.get<string>('actionName', '');
  const debounceMs = reader.get<number>('debounceMs', HOT_RELOAD_DEFAULT_DEBOUNCE_MS);
  return {
    enabled: typeof enabled === 'boolean' ? enabled : false,
    actionName: typeof actionName === 'string' ? actionName : '',
    globs: readGlobs(reader.get<unknown>('globs', undefined)),
    debounceMs:
      typeof debounceMs === 'number' && debounceMs >= 0 ? debounceMs : HOT_RELOAD_DEFAULT_DEBOUNCE_MS
  };
}

/** 定时器注入口:装配默认真 setTimeout,测试用确定性的内存计时器 */
export interface HotReloadTimerDeps {
  set: (callback: () => void, delayMs: number) => unknown;
  clear: (handle: unknown) => void;
}

export const realHotReloadTimerDeps: HotReloadTimerDeps = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

/** 去抖触发器:同一时刻只保留最后一次,连续保存合并成一次触发 */
export class HotReloadTrigger {
  private readonly fire: () => void;
  private readonly timers: HotReloadTimerDeps;
  private handle: unknown;

  constructor(fire: () => void, timers: HotReloadTimerDeps) {
    this.fire = fire;
    this.timers = timers;
  }

  schedule(debounceMs: number): void {
    if (this.handle !== undefined) {
      this.timers.clear(this.handle);
    }
    this.handle = this.timers.set(
      () => {
        this.handle = undefined;
        this.fire();
      },
      debounceMs
    );
  }

  cancel(): void {
    this.timers.clear(this.handle);
    this.handle = undefined;
  }

  dispose(): void {
    this.cancel();
  }
}

/** 读 kbengine.hotReload 段:覆写表按段存扁平键,段内嵌套对象由本仓自己解开 */
const hotReloadSectionReader = (): ConfigReader => {
  const section = vscode.workspace
    .getConfiguration('kbengine')
    .get<Record<string, unknown> | undefined>('hotReload', undefined);
  return {
    get: <T>(key: string, defaultValue: T): T => {
      const value = section === undefined ? undefined : section[key];
      return (value === undefined ? defaultValue : value) as T;
    }
  };
};

export interface SetupHotReloadOptions {
  /** 注入定时器(测试用);缺省走真 setTimeout */
  readonly timers?: HotReloadTimerDeps;
  /** 动作自身未收口的同步/异步异常报告口;默认提示 VS Code 用户 */
  readonly onActionError?: (error: unknown) => void;
  /** 状态机控制器注入(测试用);缺省建真实状态栏项+专用 OUTPUT 通道 */
  readonly status?: HotReloadStatusController;
  /** IDE-REV-021 目标状态台账接线:注入即逐发送按 rootId × targetId 记账 */
  readonly targetState?: HotReloadTargetStateWiring;
}

/**
 * 双维记账注入面(IDE-REV-021):resolveTargetId 把动作名解成服务实例标
 * 识(解不到=null,该次发送如实不落目标态,不虚构实例);resolveRootId
 * 把文件解成归属扫描根(解不到=null,该文件不落)。两个解析器都注入,
 * 台账才有可能落记录;记录语义(同文件跨目标隔离/重发覆盖)归台账模块。
 */
export interface HotReloadTargetStateWiring {
  readonly store: HotReloadTargetStateStore;
  resolveTargetId(actionName: string): string | null | Promise<string | null>;
  resolveRootId(file: string): string | null;
}

/**
 * IDE-REV-022 真实 HTTP 响应面:HTTP 状态 + 回包 body。观察者只在响应真
 * 正到达时触发(传输已成功),故分类按 status 走;脚本/命令动作没有此
 * 面,onHttpResponse 不触发,回落原有记账。
 */
export interface HotReloadHttpResponse {
  readonly status: number;
  readonly body?: string;
}

/** 传给 runAction 的发送选项:onHttpResponse 在真实 HTTP 响应到达时回调 */
export interface HotReloadSendOptions {
  readonly onHttpResponse?: (response: HotReloadHttpResponse) => void;
}

/**
 * 装配自动热重载。context.subscriptions 只挂一条复合 disposable:
 * 配置变更监听、watcher 拆建与状态栏项随其一并释放。默认关时不建任何
 * watcher(激活与既有装配断言不受影响),把配置改成开才按 globs 各建一个
 * watcher。状态栏节流走真 setTimeout(与注入的测试计时器隔离,不污染
 * 去抖 pending 计数);点击状态栏项开「KBEngine 热更」日志通道。
 */
export function setupHotReload(
  context: vscode.ExtensionContext,
  runAction: (actionName: string, sendOptions?: HotReloadSendOptions) => void | Promise<unknown>,
  options: SetupHotReloadOptions = {}
): void {
  const timers = options.timers ?? realHotReloadTimerDeps;
  const status =
    options.status ??
    new HotReloadStatusController({
      createStatusBarItem: (alignment, priority) =>
        vscode.window.createStatusBarItem(alignment, priority),
      createOutputChannel: name => vscode.window.createOutputChannel(name),
      registerCommand: (command, handler) =>
        vscode.commands.registerCommand(command, handler),
      timers: realHotReloadTimerDeps
    });
  const reportActionError = (error: unknown): void => {
    if (options.onActionError) {
      try {
        options.onActionError(error);
      } catch {
        // 异常报告器也位于 watcher 事件边界内,不能制造新的未处理异常。
      }
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    try {
      void Promise.resolve(vscode.window.showErrorMessage(`自动热重载动作失败: ${message}`))
        .catch(() => undefined);
    } catch {
      // VS Code 关闭期间提示 API 可能不可用,仍保持 watcher 回调安全。
    }
  };
  // 去抖期间攒到的触发文件:fire 时一次性结账进状态与日志(连发保存合并)
  const pendingTriggers = new Set<string>();
  const trigger = new HotReloadTrigger(() => {
    const settings = readHotReloadSettings(hotReloadSectionReader());
    const triggers = [...pendingTriggers];
    pendingTriggers.clear();
    if (settings.actionName.length === 0) {
      // 到点但无动作名:状态回落就绪,跳过仍记日志,不能悬在 Sending
      status.setSkippedNoAction(triggers);
      return;
    }
    status.setSending(triggers, settings.debounceMs);
    const fail = (error: unknown): void => {
      status.setFailed(error instanceof Error ? error.message : String(error));
      reportActionError(error);
    };
    // IDE-REV-021:该次发送逐文件落双维台账——targetId/rootId 解不到的
    // 维度如实不落;结果仍只有 sent-unverified/failed 两态(无回执管道,
    // 传输/执行成功≠应用成功,绝不记成功态)
    const recordOutcomes = (targetId: string | null, outcome: HotReloadDeliveryOutcome, detail?: string): void => {
      const wiring = options.targetState;
      if (!wiring || targetId === null) {
        return;
      }
      for (const file of triggers) {
        const rootId = wiring.resolveRootId(file);
        if (rootId === null) {
          continue;
        }
        wiring.store.record({ rootId, targetId }, file, outcome, detail !== undefined ? { detail } : {});
      }
    };
    const start = (targetId: string | null): void => {
      // IDE-REV-022:真实 HTTP 响应到达即回执面——recordHttpDelivery 按传输
      // 事实落账(2xx=未确认送达/非 2xx=failed),2xx 且有回包才尝试 accepted
      // 升格(applyAcceptedReceipt 只认协议逐字段符合,未知响应保持未确认);
      // 脚本/命令动作无响应面,回落 recordOutcomes 的 sent-unverified/failed。
      let responseSeen = false;
      const handleResponse = (response: HotReloadHttpResponse): void => {
        responseSeen = true;
        const wiring = options.targetState;
        if (!wiring || targetId === null) {
          return;
        }
        for (const file of triggers) {
          const rootId = wiring.resolveRootId(file);
          if (rootId === null) {
            continue;
          }
          const key = { rootId, targetId };
          // 观察者只在响应到达时触发 → 传输已成功,分类按 status 走
          const record = recordHttpDelivery(wiring.store, key, file, { ok: true, status: response.status }, {});
          if (record.outcome === 'sent-unverified' && typeof response.body === 'string' && response.body.length > 0) {
            applyAcceptedReceipt(wiring.store, key, file, response.body, {});
          }
        }
      };
      const sendOptions: HotReloadSendOptions | undefined = options.targetState
        ? { onHttpResponse: handleResponse }
        : undefined;
      // 无人值守通道:同步异常与异步拒绝都在事件边界收口,不能变成未处理拒绝。
      try {
        void Promise.resolve(runAction(settings.actionName, sendOptions)).then(
          // 无业务回执可校验:只记未确认,禁标成功(HR-STATE 系列另立项);
          // 有响应面则 handleResponse 已按传输事实落账,不再覆盖
          () => {
            if (!responseSeen) {
              recordOutcomes(targetId, 'sent-unverified');
            }
            status.setSentUnverified();
          },
          error => {
            if (!responseSeen) {
              recordOutcomes(targetId, 'failed', error instanceof Error ? error.message : String(error));
            }
            fail(error);
          }
        );
      } catch (error) {
        if (!responseSeen) {
          recordOutcomes(targetId, 'failed', error instanceof Error ? error.message : String(error));
        }
        fail(error);
      }
    };
    if (options.targetState) {
      // 目标解析本身失败/拒绝:如实按无目标发送(不落台账),动作照常执行
      void Promise.resolve(options.targetState.resolveTargetId(settings.actionName)).then(start, () => start(null));
    } else {
      start(null);
    }
  }, timers);

  const watchers: vscode.FileSystemWatcher[] = [];
  const disposeWatchers = (): void => {
    for (const watcher of watchers) {
      watcher.dispose();
    }
    watchers.length = 0;
  };

  const apply = (): void => {
    disposeWatchers();
    trigger.cancel();
    pendingTriggers.clear();
    const settings = readHotReloadSettings(hotReloadSectionReader());
    if (!settings.enabled || settings.globs.length === 0) {
      status.setWatchOff();
      return;
    }
    // @types/vscode 只接受单个 GlobPattern,每个模式各建一个 watcher
    for (const glob of settings.globs) {
      const watcher = vscode.workspace.createFileSystemWatcher(glob);
      const schedule = (uri?: vscode.Uri): void => {
        if (uri) {
          pendingTriggers.add(uri.fsPath);
        }
        trigger.schedule(settings.debounceMs);
      };
      watcher.onDidChange(schedule);
      watcher.onDidCreate(schedule);
      watcher.onDidDelete(schedule);
      watchers.push(watcher);
    }
    status.setReady(settings.globs.length, settings.debounceMs);
  };

  const subscription = vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('kbengine')) {
      apply();
    }
  });
  context.subscriptions.push({
    dispose: (): void => {
      subscription.dispose();
      trigger.dispose();
      disposeWatchers();
      status.dispose();
    }
  });
  apply();
}
