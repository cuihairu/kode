import * as vscode from 'vscode';

// 自动热重载(功能差距盘点 G5,docs/reference-feature-gap.md):文件保存/监视 →
// 触发指定 quick action。门控默认关防误触;启用后才按 kbengine.hotReload.globs
// 建 watcher,事件去抖合并连发保存,配置变更联动拆建 watcher。

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
}

/**
 * 装配自动热重载。context.subscriptions 只挂一条复合 disposable:
 * 配置变更监听与 watcher 拆建随其一并释放。默认关时不建任何 watcher
 * (激活与既有装配断言不受影响),把配置改成开才按 globs 各建一个 watcher。
 */
export function setupHotReload(
  context: vscode.ExtensionContext,
  runAction: (actionName: string) => void | Promise<unknown>,
  options: SetupHotReloadOptions = {}
): void {
  const timers = options.timers ?? realHotReloadTimerDeps;
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
  const trigger = new HotReloadTrigger(() => {
    const settings = readHotReloadSettings(hotReloadSectionReader());
    if (settings.actionName.length === 0) {
      return;
    }
    // 无人值守通道:同步异常与异步拒绝都在事件边界收口,不能变成未处理拒绝。
    try {
      void Promise.resolve(runAction(settings.actionName)).catch(reportActionError);
    } catch (error) {
      reportActionError(error);
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
    const settings = readHotReloadSettings(hotReloadSectionReader());
    if (!settings.enabled || settings.globs.length === 0) {
      return;
    }
    // @types/vscode 只接受单个 GlobPattern,每个模式各建一个 watcher
    for (const glob of settings.globs) {
      const watcher = vscode.workspace.createFileSystemWatcher(glob);
      const schedule = (): void => trigger.schedule(settings.debounceMs);
      watcher.onDidChange(schedule);
      watcher.onDidCreate(schedule);
      watcher.onDidDelete(schedule);
      watchers.push(watcher);
    }
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
    }
  });
  apply();
}
