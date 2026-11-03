import { createHash } from 'crypto';

import * as vscode from 'vscode';
import { HotReloadStatusController } from './hotReloadStatus';
import {
  HotReloadTargetStateStore,
  type HotReloadDeliveryOutcome
} from './hotReloadTargetState';
import { recordHttpDelivery } from './hotReloadDelivery';
import { applyAcceptedReceipt } from './hotReloadReceipt';
import { settleAppliedStatus, verifyAppliedReceipt } from './hotReloadAppliedCheck';
import { classifyDefChange } from './hotReloadDefStructure';
import type { ReloadTransport } from './hotReloadTransport';

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
/** IDE-REV-023 applied 核验窗口:到点仍未确认只注解超时,不冒充任何终态 */
export const HOT_RELOAD_APPLIED_SETTLE_MS = 10_000;

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
  /**
   * IDE-REV-027 引擎 digest 证据口:真实 HTTP 回包体喂给证据册(册内自
   * 行判协议:非空 digest+逐字回显该文件才入册,归属不猜)。注入即逐文
   * 件上报,不注入则证据面无运行时来源。
   */
  readonly noteEngineDigest?: (
    key: { rootId: string; targetId: string },
    file: string,
    body: string | undefined
  ) => void;
  /**
   * IDE-HOT-100 结构性 def 拦下通知:def 结构闸把批拦下时回调(动作名/
   * 文件/原因),接线方把它标进文件状态机的 RESTART_REQUIRED 呈现面。
   * 注入即回调;不注入则状态机无从知拦下(拦下本身仍照常发生)。
   */
  readonly onRestartRequired?: (actionName: string, files: string[], reasons: string[]) => void;
  /** 时钟注入口(测试用);缺省真 Date.now,用于 applied 核验窗口结算 */
  readonly now?: () => number;
  /**
   * IDE-HOT-102 部署通道接线:返回本 profile 配置的 ReloadTransport 与目标
   * 标识(经 resolveReloadTransport 解出;未配返回 null)。注入即该次发送走
   * 部署通道(回执流直喂台账),不注入则回落既有 actionName 通道。
   * targetId 是通道目标的服务标识(如 profile id / 通道 kind),用于台账键。
   */
  readonly resolveChannelTransport?: () => { transport: ReloadTransport; targetId: string } | null;
  /** IDE-HOT-102 审计「触发源」(谁):默认 'watcher-auto' 自动监视 */
  readonly auditSource?: string;
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
  /** IDE-REV-023 所发内容读取口:applied 回执 digest 比对基准;缺省不核验 */
  readFileContent?(file: string): Promise<string | null>;
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
  const now = options.now ?? Date.now;
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
    // IDE-HOT-102:审计五要素(谁/何时/文件/通道/结果)的「谁」与日志行——
    // 触发源缺省 watcher-auto(自动监视);通道面、actionName 回落面与 def 闸
    // 拦下面共用同一行式(「何时」由 OUTPUT 通道行前缀时间承担)。
    const channelAuditSource = options.auditSource ?? 'watcher-auto';
    const auditLine = (channelLabel: string, files: readonly string[], resultText: string): void => {
      status.log(`审计: 触发源=${channelAuditSource} | 文件=${files.length} 个 | 通道=${channelLabel} | 结果=${resultText}`);
    };
    const proceed = (): void => {
      const fail = (error: unknown): void => {
        status.setFailed(error instanceof Error ? error.message : String(error));
        reportActionError(error);
      };
      // IDE-REV-021:该次发送逐文件落双维台账——targetId/rootId 解不到的
      // 维度如实不落;结果仍只有 sent-unverified/failed 两态(无回执管道,
      // 传输/执行成功≠应用成功,绝不记成功态)。
      // IDE-HOT-102:actionName 回落通道的台账记录带触发源与通道
      // (actionName:<名>),与通道发送面共用审计五要素语义。
      const fallbackChannel = `actionName:${settings.actionName}`;
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
          wiring.store.record(
            { rootId, targetId },
            file,
            outcome,
            detail !== undefined
              ? { detail, source: channelAuditSource, channel: fallbackChannel }
              : { source: channelAuditSource, channel: fallbackChannel }
          );
        }
        auditLine(fallbackChannel, triggers, outcome === 'failed' ? '失败' : '已发送(未校验业务回执)');
      };
      // IDE-REV-023:applied 核验接线。注解口只给仍未确认(sent-unverified)的
      // 记录追加阻塞/超时原因——绝不动 accepted/applied/failed,recordedAt 原样
      // 保留(注解不是新发送);同因去重防重复追注。
      const noteStillUnverified = (
        wiring: HotReloadTargetStateWiring,
        key: { rootId: string; targetId: string },
        file: string,
        reason: string,
        attempt: number
      ): void => {
        const current = wiring.store.get(key, file);
        if (!current || current.outcome !== 'sent-unverified' || (current.detail ?? '').includes(reason)) {
          return;
        }
        wiring.store.record(key, file, 'sent-unverified', {
          detail: `${current.detail} | ${reason}`,
          now: current.recordedAt,
          attempt
        });
      };
      // 核验窗口到点结算:仍未确认只注解超时(不冒充失败也不冒充 applied);
      // IDE-AUD-005:结算绑定所属发送代际,记录已换代(更新的发送在途)则不动
      const scheduleAppliedSettle = (
        wiring: HotReloadTargetStateWiring,
        key: { rootId: string; targetId: string },
        file: string,
        sentAt: number,
        attempt: number
      ): void => {
        const handle = timers.set(() => {
          settleHandles.delete(handle);
          const current = wiring.store.get(key, file);
          if (!current || current.attempt !== attempt) {
            return;
          }
          const verdict = settleAppliedStatus(current, {
            deadlineMs: sentAt + HOT_RELOAD_APPLIED_SETTLE_MS,
            now
          });
          if (verdict === 'unconfirmed-timeout') {
            noteStillUnverified(
              wiring,
              key,
              file,
              `applied 核验超时(${Math.round(HOT_RELOAD_APPLIED_SETTLE_MS / 1000)}s 窗口):保持未确认`,
              attempt
            );
          }
        }, HOT_RELOAD_APPLIED_SETTLE_MS);
        settleHandles.add(handle);
      };
      // IDE-HOT-102:部署通道发送——配置了 hotReload 通道时整批走通道回执流
      // (transport.send 逐条回执直接喂台账),不回落 actionName 通道;无 wiring
      // 解不到 root 的文件仍发送(单组 '' 键)但不落台账。
      const sendViaChannel = (transport: ReloadTransport, channelTargetId: string): void => {
        const wiring = options.targetState;
        const channelLabel = transport.kind;
        const groups = new Map<string, string[]>();
        for (const file of triggers) {
          const rootId = wiring ? (wiring.resolveRootId(file) ?? '') : '';
          const list = groups.get(rootId) ?? [];
          list.push(file);
          groups.set(rootId, list);
        }
        const recordOutcome = (
          rootId: string,
          file: string,
          outcome: HotReloadDeliveryOutcome,
          detail?: string
        ): void => {
          if (!wiring || rootId === '') {
            return;
          }
          wiring.store.record({ rootId, targetId: channelTargetId }, file, outcome, {
            ...(detail !== undefined ? { detail } : {}),
            source: channelAuditSource,
            channel: channelLabel
          });
        };
        let sentCount = 0;
        let failedCount = 0;
        const allGroups = [...groups.entries()];
        const runAll = Promise.all(
          allGroups.map(([rootId, files]) =>
            Promise.resolve(
              transport.send({ rootId, targetId: channelTargetId }, files, receipt => {
                const receiptFiles = receipt.file !== undefined ? [receipt.file] : files;
                for (const file of receiptFiles) {
                  switch (receipt.status) {
                    case 'applied':
                      recordOutcome(rootId, file, 'applied');
                      break;
                    case 'accepted':
                      recordOutcome(rootId, file, 'accepted');
                      break;
                    case 'failed':
                      failedCount += 1;
                      recordOutcome(rootId, file, 'failed', receipt.reason);
                      break;
                    case 'sent':
                    default:
                      sentCount += 1;
                      recordOutcome(rootId, file, 'sent-unverified', receipt.detail);
                      break;
                  }
                }
              })
            ).catch((error: unknown) => {
              // 单组失败:整组按 failed 落账(不冒充未确认),错误如实上报
              failedCount += files.length;
              for (const file of files) {
                recordOutcome(rootId, file, 'failed', error instanceof Error ? error.message : String(error));
              }
            })
          )
        );
        void runAll.then(
          () => {
            const result =
              failedCount > 0 && sentCount === 0
                ? `失败(${failedCount})`
                : failedCount > 0
                  ? `部分失败(${failedCount} 失败/${sentCount} 已发)`
                  : `已发送(${sentCount})——未校验业务回执`;
            auditLine(channelLabel, triggers, result);
            if (failedCount > 0 && sentCount === 0) {
              status.setFailed(`通道 ${channelLabel} 全部失败(${failedCount})`);
            } else {
              status.setSentUnverified();
            }
            // 组内错误已在 catch 落账 failed,这里按汇总如实上报一次(部分
            // 失败也上报,动作名回落面的 fail() 同口径:失败即报)。
            if (failedCount > 0) {
              reportActionError(new Error(`通道 ${channelLabel} 发送失败:${failedCount} 个文件未送达`));
            }
          },
          (error: unknown) => {
            status.setFailed(error instanceof Error ? error.message : String(error));
            reportActionError(error);
          }
        );
      };
      const start = (targetId: string | null): void => {
        // IDE-HOT-102:配置了部署通道则整批走通道(回执流直喂台账),不回落
        // actionName 通道;未配(resolveChannelTransport 返回 null/未注入)走
        // 既有 actionName 路径,行为与现状一致。
        const channelHandle = options.resolveChannelTransport?.() ?? null;
        if (channelHandle) {
          sendViaChannel(channelHandle.transport, channelHandle.targetId);
          return;
        }
        // IDE-REV-022:真实 HTTP 响应到达即回执面——recordHttpDelivery 按传输
        // 事实落账(2xx=未确认送达/非 2xx=failed),2xx 且有回包才尝试 accepted
        // 升格(applyAcceptedReceipt 只认协议逐字段符合,未知响应保持未确认);
        // 脚本/命令动作无响应面,回落 recordOutcomes 的 sent-unverified/failed。
        // IDE-AUD-006:发送前冻结内容核验基准——runAction 之前读一次所发内容算
        // sha256(每次 start 各自的基准,后续发送不串),响应后核验全用它并带进
        // 台账 sentDigest;绝不响应后再读文件当前内容冒充所发版本(响应后文件
        // 已变不影响判定)。读取失败=无基准(如实 undefined,核验面注解阻塞)。
        const baselineReader = options.targetState?.readFileContent;
        const baselineReads = new Map<string, Promise<string | undefined>>();
        if (baselineReader) {
          for (const file of triggers) {
            baselineReads.set(
              file,
              Promise.resolve(baselineReader(file))
                .then(content =>
                  content === null
                    ? undefined
                    : createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex')
                )
                .catch(() => undefined)
            );
          }
        }
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
            // IDE-REV-027:回包体喂引擎 digest 证据册(册内判协议与归属)
            options.noteEngineDigest?.(key, file, response.body);
            // 观察者只在响应到达时触发 → 传输已成功,分类按 status 走
            const record = recordHttpDelivery(wiring.store, key, file, { ok: true, status: response.status }, {});
            // IDE-AUD-005:该次发送的代际——回执/注解/核验结算全绑定它,旧代
            // 异步结果绝不改新代记录(晚到的第一次核验不翻第二次的失败)
            const attempt = record.attempt;
            if (record.outcome === 'sent-unverified' && typeof response.body === 'string' && response.body.length > 0) {
              applyAcceptedReceipt(wiring.store, key, file, response.body, { attempt });
              // IDE-REV-023:applied 双证核验(可信 digest+已验证回执)——以发送
              // 时点冻结的基准比对(IDE-AUD-006),对得上才升格 applied;无读取
              // 通道/基准不可读/回执不合规/digest 不符一律不升格,阻塞原因如实
              // 注解进仍未确认的记录
              if (!baselineReader) {
                noteStillUnverified(wiring, key, file, 'applied 核验阻塞:无内容读取通道,digest 无基准', attempt);
              } else {
                void baselineReads.get(file)!.then(sentDigest => {
                  if (sentDigest === undefined) {
                    noteStillUnverified(
                      wiring,
                      key,
                      file,
                      'applied 核验阻塞:发送时点内容基准不可读,digest 无基准',
                      attempt
                    );
                    return;
                  }
                  // IDE-AUD-006:发送时点冻结的基准带进台账(可审计);代际守卫下
                  // 只在当前代写(换代则拒,旧代基准不污染新代记录),且不改写
                  // 已升格的 outcome(accepted/applied 原样保留)
                  const currentAtWrite = wiring.store.get(key, file);
                  if (currentAtWrite) {
                    wiring.store.record(key, file, currentAtWrite.outcome, { sentDigest, attempt });
                  }
                  const verdict = verifyAppliedReceipt(wiring.store, key, file, response.body as string, {
                    sentDigest,
                    attempt
                  });
                  if (verdict.kind === 'not-applied') {
                    noteStillUnverified(wiring, key, file, `applied 核验阻塞:${verdict.reason}`, attempt);
                  }
                });
              }
              scheduleAppliedSettle(wiring, key, file, now(), attempt);
            }
          }
        };
        const sendOptions: HotReloadSendOptions | undefined = options.targetState
          ? { onHttpResponse: handleResponse }
          : undefined;
        // 无人值守通道:同步异常与异步拒绝都在事件边界收口,不能变成未处理拒绝。
        try {
          void Promise.resolve(runAction(settings.actionName, sendOptions)).then(
            // AUD-053:quick action 通道以 false=未执行/失败(runByName 找不
            // 到动作/根目录缺失)且 resolve 不 reject——旧实现成功回调里仍
            // 记 sent-unverified,false 必须如实记 failed。true/void 等其余
            // 无业务回执可校验:只记未确认,禁标成功(HR-STATE 系列另立项);
            // 有响应面则 handleResponse 已按传输事实落账,不再覆盖
            echoed => {
              if (echoed === false) {
                if (!responseSeen) {
                  recordOutcomes(targetId, 'failed', 'quick action 回执 false:未执行/失败');
                }
                fail(new Error('quick action 回执 false:未执行/失败'));
                return;
              }
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
    };
    // IDE-REV-024:def 结构闸——批内 .def 文件先做结构指纹对比:结构性变化
    // (序列化/RPC 参数面)整批不发普通 reload,状态回落就绪(不是失败)并提
    // 示需重启;无基线/内容不可读/无读取通道证明不了无结构变化,一律保守不
    // 发;非结构 def(注释/空白/顺序)与纯 Python 批照常发送。基线逐次滚动。
    const warnRestart = (text: string): void => {
      try {
        void Promise.resolve(vscode.window.showWarningMessage(text)).catch(() => undefined);
      } catch {
        // VS Code 关闭期间提示 API 可能不可用,闸门决策不受影响
      }
    };
    const gateDefChanges = (): void => {
      const defFiles = triggers.filter(file => file.toLowerCase().endsWith('.def'));
      if (defFiles.length === 0) {
        proceed();
        return;
      }
      const block = (reasons: string[]): void => {
        status.setRestartRequired(reasons, triggers);
        // IDE-HOT-100:拦下通知状态机标 RESTART_REQUIRED 呈现(与日志同源);
        // 拦下本身是 HOT-005 的既有面,这里只多一个呈现通知。
        options.onRestartRequired?.(settings.actionName, triggers, reasons);
        const first = reasons[0] ?? 'def 结构待核';
        // IDE-HOT-102:def 闸拦下的重载也进审计——通道记为「拦截:需重启」,
        // 结果=拦截原因,与通道发送/actionName 回落共用五要素语义(谁/何时/
        // 文件/通道/结果);「何时」由 OUTPUT 通道行前缀时间承担。
        auditLine('拦截:需重启', triggers, `未发送——${first}${reasons.length > 1 ? ` 等 ${reasons.length} 项` : ''}`);
        warnRestart(`结构性 def 变更需要重启,本次不发普通 reload: ${first}${reasons.length > 1 ? ` 等 ${reasons.length} 项` : ''}`);
      };
      const reader = options.targetState?.readFileContent;
      if (!reader) {
        block(['def 无内容读取通道,证明不了无结构变化(保守不发)']);
        return;
      }
      void Promise.all(defFiles.map(file => Promise.resolve(reader(file)).catch(() => null)))
        .then(contents => {
          const reasons: string[] = [];
          defFiles.forEach((file, index) => {
            const after = contents[index];
            if (after === null) {
              reasons.push(`${file}: 内容不可读(保守按结构性,不发)`);
              return;
            }
            const baseline = defBaselines.get(file);
            if (baseline === undefined) {
              reasons.push(`${file}: 无基线(本次会话首次见到,证明不了无结构变化)`);
            } else {
              const verdict = classifyDefChange(baseline, after);
              if (verdict.structural) {
                reasons.push(`${file}: ${verdict.reasons.join(';')}`);
              }
            }
            defBaselines.set(file, after);
          });
          if (reasons.length > 0) {
            block(reasons);
            return;
          }
          proceed();
        }, () => block(['def 内容读取失败(保守不发)']));
    };
    gateDefChanges();
  }, timers);

  const watchers: vscode.FileSystemWatcher[] = [];
  // IDE-REV-023 applied 核验窗口的结算定时器:随装配释放一并清掉
  const settleHandles = new Set<unknown>();
  // IDE-REV-024 def 结构基线:上次闸门见到的 .def 内容(会话内存,逐次滚动)
  const defBaselines = new Map<string, string>();
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
      for (const handle of settleHandles) {
        timers.clear(handle);
      }
      settleHandles.clear();
      disposeWatchers();
      status.dispose();
    }
  });
  apply();
}
