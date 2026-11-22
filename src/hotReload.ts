import { createHash } from 'crypto';

import * as vscode from 'vscode';
import {
  formatHotReloadTime,
  HotReloadStatusController,
  type HotReloadGlobSource,
  type HotReloadWatchOffReason
} from './hotReloadStatus';
import {
  HotReloadDiagnosticsPanel,
  HOT_RELOAD_DIAGNOSTICS_CHANNEL_NAME,
  HOT_RELOAD_SHOW_DIAGNOSTICS_COMMAND
} from './backend/hotReloadDiagnostics';
import { createSharedFileEventMerger, type SharedFileEvent } from './backend/sharedFileEvents';
import {
  buildNonPythonChangeEvent,
  createFileChangeRouter,
  type FileChangeKind,
  type FileChangeRouter
} from './backend/fileChangeBypass';
import { resolveAssetsRootForWorkspace } from './scanRoots';
import {
  HotReloadTargetStateStore,
  type HotReloadDeliveryOutcome
} from './backend/hotReloadTargetState';
import { recordHttpDelivery } from './backend/hotReloadDelivery';
import { applyAcceptedReceipt } from './backend/hotReloadReceipt';
import { HOT_RELOAD_APPLIED_SETTLE_MS, settleAppliedStatus, verifyAppliedReceipt } from './backend/hotReloadAppliedCheck';
import { createDefStructuralGate, type DefStructuralGate } from './backend/hotReloadDefGate';
import { checkHotReloadConfigFiles, isHotReloadConfigFile } from './backend/hotReloadConfigGate';
import { analyzeTypesImpact, formatTypesImpactReport } from './backend/hotReloadTypesImpact';
import { FingerprintStats } from './backend/hotReloadFingerprintStats';
import {
  analyzeEntitiesImpact,
  formatEntitiesImpactReport
} from './backend/hotReloadEntitiesImpact';
import { sendFilesViaReloadChannel } from './backend/hotReloadChannelSend';
import { sendDefaultHotfix } from './backend/hotReloadDefaultHotfix';
import { showHotReloadFirstRunNotice, HOT_RELOAD_NOTICE_KEY } from './backend/hotReloadNotice';
import { writeHotReloadEnabled } from './hotReloadToggle';
import { formatFileChangeMeta, type FileChangeMetaResolver } from './backend/fileChangeMeta';
import { normalizeFileIdentity } from './backend/pathIdentity';
import type { ReloadTransport } from './backend/hotReloadTransport';
import type { HttpTransport } from './backend/httpRequestService';
import type { PackageDirProbe } from './backend/httpRequests';
import {
  HotReloadSavePipeline,
  isStaleResponse,
  type SavePipelineQueueSnapshot
} from './backend/hotReloadSavePipeline';
import type { FileSnapshot, SyntaxCheck } from './backend/hotReloadSavePipeline';
import {
  createHotReloadProviderHost,
  createHttpHotfixSendProvider,
  type HotReloadProviderHost
} from './backend/hotReloadProviderAssembly';
import {
  buildEngineProfile,
  type HotReloadProvider,
  type HotReloadResolvedLifecycle
} from './backend/hotReloadPluginApi';
import { createPythonSyntaxGate } from './backend/hotReloadSyntaxGate';
import { createPythonExecService } from './backend/pythonExecService';
import { createExecServiceCompile } from './backend/pythonExecSyntaxCompile';
import { resolveProfileInterpreter } from './profileInterpreter';
import {
  HotReloadDiskWatchController,
  type DiskWatchDiagnostic,
  type DiskWatcherFactory
} from './backend/hotReloadDiskWatch';
import { matchesHotReloadGlob } from './backend/hotReloadFileVersion';
import { canonicalizeScriptFilePath } from './backend/hotReloadModuleIdentity';

export { HOT_RELOAD_TOGGLE_COMMAND } from './hotReloadToggle';

// 自动热重载(功能差距盘点 G5,docs/reference-feature-gap.md):文件保存/监视 →
// 触发指定 quick action。用户令 2026-11-06:门控默认开启(配置缺失也开,
// 显式写死 false 仍关);启用后监视范围**默认从 assetsRoot 派生**(设计 §11.1:
// 未写 globs → `<assetsRoot>/**/*.py`,拿不到有效 assetsRoot 显式报错,绝不回落
// 裸 `**/*.py` 全扫),显式 globs 原样生效;事件去抖合并连发保存,配置/派生值
// 变更联动重建 watcher(§11.4)。未配动作名时保存即按默认热更请求 POST
// http://127.0.0.1:8090/hotfix?module_name=<模块名>(body 同带 module_name=<模块名>,
// 两处都带是兼容不同服务端读参口径,同值重复无害),一键关 = 状态栏点击 /
// kbengine.hotReload.toggle(写回配置)。
// 非 py 变化走旁路通道(§11.2):事件照捕、当前不处理(零投递零状态跃迁),
// 按消费者注册表按需通知 rust 解析(§11.3,`$/kode/fileChanged`,rust 不可用
// 静默降级)。
// 状态栏反馈(HR-UI-001):装配内建状态机控制器,Watch Off/Ready/
// Ready(配置错)/Sending/Sent(未确认)/Failed 上屏;动作完成且无错只记未确认,
// 不校验业务回执。
// IDE-REV-021:注入 targetState 即按「rootId × targetId」双维台账逐发送
// 记账(同文件发不同实例各落各的,切目标不复用上一目标状态);动作完成
// 无回执仍记 sent-unverified——传输成功≠应用成功,不宣称热更成功。

export const HOT_RELOAD_DEFAULT_DEBOUNCE_MS = 500;

/**
 * RUST-398:批内 types.xml 判定(KBEngine 类型表文件名,任意目录;与
 * isHotReloadConfigFile 同路径形状口径,不猜项目布局)。
 */
const isTypesXmlBasename = (file: string): boolean => {
  const norm = file.replace(/\\/g, '/');
  return norm.slice(norm.lastIndexOf('/') + 1).toLowerCase() === 'types.xml';
};

/**
 * RUST-399:批内 entities.xml 判定(KBEngine 实体注册文件,任意目录;与
 * isHotReloadConfigFile 同路径形状口径,不猜项目布局)。
 */
const isEntitiesXmlBasename = (file: string): boolean => {
  const norm = file.replace(/\\/g, '/');
  return norm.slice(norm.lastIndexOf('/') + 1).toLowerCase() === 'entities.xml';
};
/** 派生 glob 的尾段:热更只处理 .py(非 py 走旁路,不进投递) */
export const HOT_RELOAD_DERIVED_GLOB_SUFFIX = '**/*.py';
/** 缺根补救指路(状态栏 tooltip 与诊断日志同源,不静默全扫) */
export const HOT_RELOAD_ASSETS_ROOT_REMEDY =
  '未配 kbengine.assetsRoot,无法派生监视范围;补救:配置 kbengine.assetsRoot,或把工作区设为资产根目录的父目录';
/** IDE-REV-023 applied 核验窗口:到点仍未确认只注解超时,不冒充任何终态 */
export { HOT_RELOAD_APPLIED_SETTLE_MS } from './backend/hotReloadAppliedCheck';

/** 显式配置的 globs 来源;`unset` = 没写(或类型写坏)→ 交给 assetsRoot 派生 */
export type HotReloadGlobsSpec = 'explicit' | 'unset';

export interface HotReloadSettings {
  readonly enabled: boolean;
  readonly actionName: string;
  /** 显式 globs(未写 = 空表;语义由 globsSpec 区分,空表不等于没写) */
  readonly globs: string[];
  readonly globsSpec: HotReloadGlobsSpec;
  readonly debounceMs: number;
  /** HR-WATCH-001 触发源模式:onSave(默认推荐,watcher 写盘事件)/
   *  onDiskChange(另建按根磁盘监视,外部改动/生成/Git checkout 进同一链) */
  readonly triggerMode: HotReloadTriggerMode;
  /** HR-WATCH-007 写入稳定窗(两拍快照一致才发);0=不做稳定等待(缺省) */
  readonly stabilityWindowMs: number;
  /** HR-WATCH-012 语法闸(解释器 compile 全量检查);false=不检查如实放行 */
  readonly syntaxGate: boolean;
  /** HR-WATCH-013 波次冲口(同窗定稿归集成批);0=定稿即汇合并池(缺省) */
  readonly batchFlushMs: number;
  /** HR-WATCH-016 批量预览阈值(波批文件数超此值只滞留预览,命令放行) */
  readonly batchPreviewThreshold: number;
  /** HR-PR-08 发送 provider 插槽:开=true 时无动作名发送先问注册表
   *  (应答者胜),无人应答回落既有默认热更面;false=默认,面不进链 */
  readonly sendViaProviders: boolean;
  /** HR-MOD-008 根下单层回退:开=true 根直下 Foo.py 解析裸短名;
   *  false=默认拒(书 §19.1),零配置行为不变 */
  readonly allowRootLevelStem: boolean;
  /** HR-UI-013 通知模式:silent=全程无弹窗(成功/失败/摘要都不弹,信息
   *  照旧落审计/状态栏/历史不丢)/errors=失败弹窗+成功静默(缺省,保持
   *  既有动作失败与 def 拦截警告弹窗,发送失败每批一条)/summary=每批
   *  完成弹一条批量结果摘要(成功也弹,含失败明细)。防风暴=每批一条,
   *  不逐文件刷屏。 */
  readonly notify: HotReloadNotifyMode;
}

/** HR-UI-013 通知模式(与 package.json kbengine.hotReload.notify 枚举锁同步) */
export type HotReloadNotifyMode = 'silent' | 'errors' | 'summary';

export const HOT_RELOAD_DEFAULT_NOTIFY: HotReloadNotifyMode = 'errors';

/** HR-WATCH-001 触发源模式(与 package.json kbengine.hotReload.triggerMode 枚举锁同步) */
export type HotReloadTriggerMode = 'onSave' | 'onDiskChange';

export const HOT_RELOAD_DEFAULT_TRIGGER_MODE: HotReloadTriggerMode = 'onSave';

/** HR-WATCH-016 批量预览阈值缺省(与流水线纯核缺省同值) */
export const HOT_RELOAD_DEFAULT_BATCH_PREVIEW_THRESHOLD = 50;

/** 配置读取口:与 vscode.ConfigurationShape 同形,测试用内存替身驱动 */
export interface ConfigReader {
  get: <T>(key: string, defaultValue: T) => T;
}

/**
 * globs 读取(§11.1):只有**数组**算用户写过(spec=explicit,空数组也是显式
 * 「不监视任何模式」→ watch-off);没写/类型写坏一律 spec=unset 交给 assetsRoot
 * 派生——绝不回落裸全工作区扫(设计 §11.1 点名的错误回落)。
 */
const readGlobs = (raw: unknown): { globs: string[]; globsSpec: HotReloadGlobsSpec } => {
  if (!Array.isArray(raw)) {
    return { globs: [], globsSpec: 'unset' };
  }
  const kept = raw
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim())
    .filter(item => item.length > 0);
  return { globs: kept, globsSpec: 'explicit' };
};

/** 容忍式读取:类型不符或负去抖一律回落默认,配置写坏也不会拖垮装配。
 * enabled 缺省/类型错一律回落「开」(用户令 2026-11-06 默认开启),显式
 * 写死 false 原样读出仍关——用户显式关要生效。 */
export function readHotReloadSettings(reader: ConfigReader): HotReloadSettings {
  const enabled = reader.get<boolean>('enabled', true);
  const actionName = reader.get<string>('actionName', '');
  const debounceMs = reader.get<number>('debounceMs', HOT_RELOAD_DEFAULT_DEBOUNCE_MS);
  const triggerMode = reader.get<string>('triggerMode', HOT_RELOAD_DEFAULT_TRIGGER_MODE);
  const stabilityWindowMs = reader.get<number>('stabilityWindowMs', 0);
  const syntaxGate = reader.get<boolean>('syntaxGate', false);
  const batchFlushMs = reader.get<number>('batchFlushMs', 0);
  const batchPreviewThreshold = reader.get<number>(
    'batchPreviewThreshold',
    HOT_RELOAD_DEFAULT_BATCH_PREVIEW_THRESHOLD
  );
  const sendViaProviders = reader.get<boolean>('sendViaProviders', false);
  const allowRootLevelStem = reader.get<boolean>('allowRootLevelStem', false);
  const notify = reader.get<string>('notify', HOT_RELOAD_DEFAULT_NOTIFY);
  const { globs, globsSpec } = readGlobs(reader.get<unknown>('globs', undefined));
  return {
    enabled: typeof enabled === 'boolean' ? enabled : true,
    actionName: typeof actionName === 'string' ? actionName : '',
    globs,
    globsSpec,
    debounceMs:
      typeof debounceMs === 'number' && debounceMs >= 0 ? debounceMs : HOT_RELOAD_DEFAULT_DEBOUNCE_MS,
    // 容忍式:枚举外的写法(含写坏类型)一律回落默认 onSave,不猜半态
    triggerMode: triggerMode === 'onDiskChange' ? 'onDiskChange' : HOT_RELOAD_DEFAULT_TRIGGER_MODE,
    // 容忍式数值面:类型写坏/负值一律回落默认,配置写坏不拖垮装配
    stabilityWindowMs:
      typeof stabilityWindowMs === 'number' && stabilityWindowMs >= 0 ? stabilityWindowMs : 0,
    syntaxGate: typeof syntaxGate === 'boolean' ? syntaxGate : false,
    batchFlushMs: typeof batchFlushMs === 'number' && batchFlushMs >= 0 ? batchFlushMs : 0,
    batchPreviewThreshold:
      typeof batchPreviewThreshold === 'number' && batchPreviewThreshold >= 0
        ? batchPreviewThreshold
        : HOT_RELOAD_DEFAULT_BATCH_PREVIEW_THRESHOLD,
    sendViaProviders: typeof sendViaProviders === 'boolean' ? sendViaProviders : false,
    // HR-MOD-008 同一布尔容忍口径:非布尔一律回落 false=默认拒,零配置不变
    allowRootLevelStem: typeof allowRootLevelStem === 'boolean' ? allowRootLevelStem : false,
    // HR-UI-013 容忍式:枚举外的写法(含写坏类型)一律回落默认 errors
    // (失败提示),不猜半态;silent/summary 原样读出
    notify: notify === 'silent' || notify === 'summary' ? notify : HOT_RELOAD_DEFAULT_NOTIFY
  };
}

/** HR-WATCH-007 稳定窗快照读(真实现):workspace.fs 读全文+sha256;读不到
 *  (已删除/不可读)如实 null,核按删失丢弃,不猜内容 */
const readScriptSnapshot = async (file: string): Promise<FileSnapshot | null> => {
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(file));
    const content = Buffer.from(bytes).toString('utf8');
    return { hash: createHash('sha256').update(content).digest('hex'), content };
  } catch {
    return null;
  }
};

/** 路径归一成 glob 用正斜杠并去尾斜杠(Windows 反斜杠一并归一) */
const normalizePathForGlob = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '');

/**
 * 从 assetsRoot 派生热更监视模式(§11.1):
 * - assetsRoot 在工作区内 → `${workspaceFolder}/<相对路径>` + 尾段的形态;
 * - 在工作区外 → 绝对路径(正斜杠);
 * - assetsRoot 为空 → 空串(调用方按缺根显式报错,不回落全扫)。
 * 恒以 HOT_RELOAD_DERIVED_GLOB_SUFFIX(`**\/*.py`)结尾:热更只处理 .py。
 */
export function deriveHotReloadGlob(assetsRoot: string, workspaceRoot: string): string {
  const root = normalizePathForGlob((assetsRoot ?? '').trim());
  if (!root) {
    return '';
  }
  const workspace = normalizePathForGlob((workspaceRoot ?? '').trim());
  if (workspace && (root === workspace || root.startsWith(`${workspace}/`))) {
    const relative = root === workspace ? '' : `${root.slice(workspace.length + 1)}/`;
    return `\${workspaceFolder}/${relative}${HOT_RELOAD_DERIVED_GLOB_SUFFIX}`;
  }
  return `${root}/${HOT_RELOAD_DERIVED_GLOB_SUFFIX}`;
}

/**
 * 监视注册形态(§11.1 + IDE-ACC-011):派生 glob 的 `${workspaceFolder}` 变量
 * 在 API 层不展开(vscode GlobPattern 无变量替换),故注册时按 RelativePattern
 * 落地——工作区内锚工作区根(相对子路径),工作区外锚资产根本身,监视范围与
 * 派生 glob 逐字等价。suffix 如 `**\/*.py`(热更面)/`**\/*`(旁路面)。
 */
export function deriveWatcherPattern(
  assetsRoot: string,
  workspaceRoot: string,
  suffix: string
): { base: string; pattern: string } {
  const root = normalizePathForGlob((assetsRoot ?? '').trim());
  const workspace = normalizePathForGlob((workspaceRoot ?? '').trim());
  if (workspace && (root === workspace || root.startsWith(`${workspace}/`))) {
    const relative = root === workspace ? '' : root.slice(workspace.length + 1);
    return { base: workspace, pattern: relative ? `${relative}/${suffix}` : suffix };
  }
  return { base: root, pattern: suffix };
}

/** §11.1 决策失败:拿不到有效 assetsRoot(显式报错,绝不静默全扫) */
export interface HotReloadWatchPlanError {
  readonly code: 'assets-root-missing';
  readonly message: string;
}

/** §11.1 监视计划:三态(显式/派生/关)+ 错误与关因,装配按它建 watcher 与状态 */
export interface HotReloadWatchPlan {
  readonly globs: readonly string[];
  readonly source: HotReloadGlobSource | 'none';
  readonly watchOff: HotReloadWatchOffReason | null;
  readonly error: HotReloadWatchPlanError | null;
}

export interface HotReloadWatchPlanInput {
  readonly enabled: boolean;
  /** 显式 globs(globsSpec=unset 时忽略) */
  readonly globs: readonly string[];
  readonly globsSpec: HotReloadGlobsSpec;
  readonly assetsRoot: string;
  readonly workspaceRoot: string;
}

/**
 * §11.1 决策表(纯函数,便于直测):
 * 关着 → watch-off(disabled);开着且写了 globs → 显式原样(空数组 = watch-off
 * empty-globs);开着没写 globs → 从 assetsRoot 派生,派生不到 → 显式报错。
 */
export function planHotReloadWatch(input: HotReloadWatchPlanInput): HotReloadWatchPlan {
  if (!input.enabled) {
    return { globs: [], source: 'none', watchOff: 'disabled', error: null };
  }
  if (input.globsSpec === 'explicit') {
    return input.globs.length > 0
      ? { globs: [...input.globs], source: 'explicit', watchOff: null, error: null }
      : { globs: [], source: 'none', watchOff: 'empty-globs', error: null };
  }
  const derived = deriveHotReloadGlob(input.assetsRoot, input.workspaceRoot);
  if (!derived) {
    return {
      globs: [],
      source: 'none',
      watchOff: null,
      error: { code: 'assets-root-missing', message: HOT_RELOAD_ASSETS_ROOT_REMEDY }
    };
  }
  return { globs: [derived], source: 'derived', watchOff: null, error: null };
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

/** 去抖触发器:同一时刻只保留最后一次,连续保存合并成一次触发。
 *  HR-PR-04 接线后作为装配级合并窗保留:流水线逐文件定稿汇入 pendingOut,
 *  由本类合成一批交给发送编排(def 结构闸「整批拦下」契约依赖同批共见,
 *  逐文件直发会让混批里的 py 绕过闸——hotReloadDefGateWiring 钉死此契约)。 */
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

  /** 合并窗是否已有在途计时(HR-PR-04 两级形态:进料级定稿 emit 只在无在途
   *  合并计时才补排——offer 时已排的合并窗照旧走,fire 时机保持「末次事件
   *  +窗」不后移;在途窗已 fire 而定稿晚到(稳定窗/封顶延迟)时才由 emit 补排) */
  pending(): boolean {
    return this.handle !== undefined;
  }

  dispose(): void {
    this.cancel();
  }
}

/** 读 kbengine.hotReload 段:覆写表按段存扁平键,段内嵌套对象由本仓自己解开。
 *  HOT-VER:导出给装配面复用——版本徽标的监视范围判定读同一份 globs 配置,
 *  与 watcher 建/拆的口径同源,不另开第二套配置读取。 */
export const hotReloadSectionReader = (): ConfigReader => {
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
  /**
   * HR-HTTP-005(RUST-347)工作区信任探针:自动热更发送前逐次读取,
   * 未信任(返回 false)禁止任何自动 HTTP/通道发送并如实落日志(用户可
   * 审查的阻止事件);缺省不注入=视为可信(零配置不回归)。装配注入
   * `() => vscode.workspace.isTrusted`;fire 时读而非装配时读——信任
   * 状态可随用户「信任工作区」变化,以发送时刻为准。
   */
  readonly isWorkspaceTrusted?: () => boolean;
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
   * HR-PR-04 流水线注入面替身(测试用):稳定窗快照读与语法闸的真实现
   * (workspace.fs 读/解释器 compile)在这里被替身顶替;不注入=真实现。
   * 对应配置键开关面照常生效(窗 0/闸关=不注入任何面,替身也不进)。
   */
  readonly pipelineFaces?: {
    /** HR-WATCH-007 快照读替身(真实现=workspace.fs 读+sha256) */
    readonly readSnapshot?: (file: string) => Promise<FileSnapshot | null>;
    /** HR-WATCH-012 语法闸替身(真实现=解释器 compile 门,fail-open) */
    readonly syntaxCheck?: SyntaxCheck;
  };
  /**
   * HR-UI-004 实时队列面:装配方(热更历史面板)经此句柄读流水线三队列
   * (pending/previewHeld/wave)自省快照。setupHotReload 在流水线上线时置为
   * 读当前实例的闭锁(闭锁 `let pipeline` 变量,随 apply 重建仍指当前实例,
   * 与 HR-WATCH-016 预览放行命令同口径);不注入=面板如实显示空队列。
   */
  readonly pipelineQueue?: { current: (() => SavePipelineQueueSnapshot) | null };
  readonly onPipelineQueueChanged?: () => void;
  /**
   * HR-PR-08 fork 侧发送 provider 实现(注册时机=装配时,应答序=注入序
   * 先到先应答,注入实现排在内置实现之前):重复 id/apiVersion 不符的
   * 注册被如实拒并上日志,不静默替换。默认无注入=注册表只有内置实现。
   */
  readonly hotReloadProviders?: readonly HotReloadProvider[];
  /**
   * 默认热更请求注入面(用户令 2026-11-06):未配 actionName 时保存即发
   * `POST http://127.0.0.1:8090/hotfix?module_name=<模块名>`(body 同带
   * module_name=<模块名>,双带兼容不同服务端实现)。
   * 三件均可缺省——transport 缺省走真 node http,包探针/脚本根由装配注入。
   */
  readonly defaultHotfix?: {
    /** 传输通道(测试注入脚本化应答);缺省 httpRequestService 的真传输 */
    readonly transport?: HttpTransport;
    /** ${module} 包边界探针(目录含 __init__.py 判定) */
    readonly isPackageDir?: PackageDirProbe;
    /** 双名称解析的脚本资源根(kbengine.hotReload.tempEdit.scriptRoot) */
    readonly resolveScriptRoot?: () => string;
    /** HR-MOD-008 根下单层回退开关(kbengine.hotReload.allowRootLevelStem;缺省关) */
    readonly resolveAllowRootLevelStem?: () => boolean;
  };

  /**
   * HOT-VER 监视事件外发:watcher 每条热更域事件把文件交给版本簿采样
   * (建档/跳号)。这是版本簿的默认事件来源,不是它的前提——手动触发路径
   * 不经过这里,写同一份台账同一实现。注入即回调;不注入则版本簿只经
   * 手动/回执路径采样。
   */
  readonly onWatchedFileChange?: (file: string) => void;
  /**
   * IDE-HOT-102 部署通道接线:返回本 profile 配置的 ReloadTransport 与目标
   * 标识(经 resolveReloadTransport 解出;未配返回 null)。注入即该次发送走
   * 部署通道(回执流直喂台账),不注入则回落既有 actionName 通道。
   * targetId 是通道目标的服务标识(如 profile id / 通道 kind),用于台账键。
   * configuredOnly 为 true 时只查询活动 profile，保留无显式目标时的 provider 回落。
   */
  readonly resolveChannelTransport?: (configuredOnly?: boolean) => { transport: ReloadTransport; targetId: string } | null;
  /** IDE-HOT-102 审计「触发源」(谁):默认 'watcher-auto' 自动监视 */
  readonly auditSource?: string;
  /**
   * 文件变化元信息解析器(方案 B,src/fileChangeMeta.ts):注入即在审计行后
   * 逐文件补一行元信息(module/process/sha256/version,与 python 索引日志
   * 同一格式);不注入则审计行保持原样(未接线场景零 IO)。解析是懒异步的,
   * 不阻塞发送,失败静默(审计缺行好过拖垮发送)。
   */
  readonly fileChangeMeta?: FileChangeMetaResolver;
  /**
   * def 结构闸注入(RT-3):与失败目标重试共用同一闸实例与同一会话基线册,
   * 两路径判定逐字一致。不注入则本装配自建(基线册私有,重试侧拿不到)。
   */
  readonly defGate?: DefStructuralGate;
  /**
   * §11.2 旁路通道注入:装配方持有它即可注册消费者(按扩展名/路径前缀路由,
   * 默认无消费者 = 只记录)与订阅 `onPublish` 事件。不注入则本装配自建一个
   * 无消费者的私有路由。
   */
  readonly fileChangeRouter?: FileChangeRouter;
  /**
   * HR-PR-05 磁盘侧接线(HR-WATCH-003/005/015):注入 watcher 工厂才建磁盘
   * 监视面——按已声明根建 watcher(HR-WATCH-004,每根派生「根下递归全部
   * .py」模式,过滤层再拦排除目录/备份名),change/create 经规范化后以
   * 'disk-change' 进同一流水线(与 save 的重叠在纯核归并记 disk-save-overlap,
   * 不双发),建后即 arm(HR-WATCH-015 基线窗,启动绝不把既有文件当变更),
   * rebuild/dispose 绑定本装配生命周期(§11.4 配置/根变更 apply 重跑即重建,
   * 释放全清)。范围与热更域同口径(显式 globs=相对路径命中;派生=assetsRoot
   * 前缀),绝不比既有 watcher 面宽。不注入=不建(既有装配与测试行为不变)。
   */
  readonly diskWatch?: {
    readonly createWatcher: DiskWatcherFactory;
    readonly onDiagnostic?: (diagnostic: DiskWatchDiagnostic) => void;
  };
  /**
   * RUST-398(HR-HASH-011):types.xml 变化影响报告用的 .def 收集口。注入即
   * 在批内 types.xml 变化时对「变更前/后内容」做 reverse-dependency 影响
   * 分析(analyzeTypesImpact),报告并入需重启理由——受影响 .def 按 RUST-397
   * 同判据需重启,不作为普通 Python reload 自动发送;types.xml 本身属配置,
   * 永不自动应用。收集器返回工作区内全部 .def(名+原文);不注入 = 如实跳过
   * 分析(报告点名「未收集 .def,影响面未知」)。
   */
  readonly collectDefsForTypesImpact?: () => Promise<ReadonlyArray<{ name: string; text: string }>>;
  /**
   * RUST-403 指纹增量统计:types.xml 变化的 reverse-dependency 闭包命中数
   * 记进 affectedDependencyNodes(依赖图节点面;不注入 = 不记账)。
   */
  readonly fingerprintStats?: FingerprintStats;
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
 * 配置变更监听、watcher 拆建、预览放行命令与状态栏项随其一并释放。默认关时不建任何
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
  // RUST-341:八型诊断事件的用户可审查呈现面——「KBEngine 热更诊断」通道
  // 全量落账(呈现即全量,不聚合不筛除,被拦下的事件同样可见),
  // kbengine.hotReload.showDiagnostics 命令打开通道。面板随 setupHotReload
  // 建一次,pipeline 随配置重建仍写同一面板(闭包引用,不随 apply 换)。
  const diagnosticsPanel = new HotReloadDiagnosticsPanel({
    channel: vscode.window.createOutputChannel(HOT_RELOAD_DIAGNOSTICS_CHANNEL_NAME),
    formatTime: formatHotReloadTime
  });
  // RUST-386(HR-UI-013)通知模式:配置在弹窗发生点即时读(与 noticeState
  // 同法,不闭包进 apply)。silent=全静默(成功/失败/摘要都不弹,信息照旧
  // 落审计/状态栏/历史不丢);errors(缺省)=失败弹窗+成功静默;summary=
  // 每批完成一条批量结果摘要(成功也弹,含失败明细)。防风暴=发送完成点
  // 各报一次,绝不逐文件刷屏;同一完成不双弹(actionName 失败面只走
  // reportActionError,其余路径只走 notifyBatchResult)。
  const notifyMode = (): HotReloadNotifyMode =>
    readHotReloadSettings(hotReloadSectionReader()).notify;
  const notifyBatchResult = (text: string, failed: boolean): void => {
    const mode = notifyMode();
    if (mode === 'silent' || (mode === 'errors' && !failed)) {
      return;
    }
    try {
      void Promise.resolve(
        failed
          ? vscode.window.showErrorMessage(text)
          : vscode.window.showInformationMessage(text)
      ).catch(() => undefined);
    } catch {
      // VS Code 关闭期间提示 API 可能不可用,不制造新的未处理异常。
    }
  };
  const reportActionError = (error: unknown): void => {
    if (options.onActionError) {
      try {
        options.onActionError(error);
      } catch {
        // 异常报告器也位于 watcher 事件边界内,不能制造新的未处理异常。
      }
      return;
    }
    if (notifyMode() === 'silent') {
      // HR-UI-013:silent 全静默;失败事实照旧落审计/状态栏/历史,不丢。
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
  // HR-PR-08 装配:发送 provider 宿主(注册时机=装配时;fork 侧注入实现
  // 在前、内置 HTTP hotfix 实现在后=应答序 fork 专属优先;重复 id/apiVersion
  // 不符如实拒并上日志,不静默收编;dispose 随复合释放清册)
  const providerHost: HotReloadProviderHost = createHotReloadProviderHost({
    providers: [
      ...(options.hotReloadProviders ?? []),
      ...(options.defaultHotfix
        ? [
            createHttpHotfixSendProvider({
              transport: options.defaultHotfix.transport,
              scriptRoot: options.defaultHotfix.resolveScriptRoot?.(),
              isPackageDir: options.defaultHotfix.isPackageDir,
              allowRootLevelStem: options.defaultHotfix.resolveAllowRootLevelStem?.()
            })
          ]
        : [])
    ],
    onRejection: rejection => {
      status.log(`热更 provider 注册被拒: ${rejection.providerId} (${rejection.reason})`);
    },
    onProviderError: providerError => {
      // RUST-426 崩溃隔离:插件崩溃如实落审计(不静默吞),核心/主线程不被打断
      const message =
        providerError.error instanceof Error ? providerError.error.message : String(providerError.error);
      status.log(`热更 provider 崩溃已隔离: ${providerError.providerId} (${message})`);
    }
  });
  // HR-PR-04 接线:发送编排入口由「全局去抖 fire」改为「保存流水线波次出口」
  // ——定稿文件清单作为参数进来,状态/审计/闸/通道面编排逐字保留。
  let latestBatch = 0;
  const runFire = (triggers: string[]): void => {
    const settings = readHotReloadSettings(hotReloadSectionReader());
    // HR-HTTP-005(RUST-347):工作区未信任时自动热更发送一律禁止——热更会
    // 把脚本推到引擎内存(写引擎动作),未信任工作区里的代码不可执行,故
    // 任何自动发送(通道投递/默认热更)都必须先过信任闸。fire 时读取信任
    // 状态(用户可能在本窗内点过「信任工作区」),false=阻止并落用户可
    // 审查的阻止日志,不动状态栏(不进入「发送中」假象);缺省未注入=
    // 视为可信(零配置不回归)。
    if (options.isWorkspaceTrusted?.() === false) {
      status.log(
        `工作区未信任,自动热更发送已阻止(${triggers.length} 个文件: ${triggers.join(', ')})`
      );
      return;
    }
    const batch = ++latestBatch;
    status.setSending(triggers, settings.debounceMs);
    // HR-WATCH-011 响应面:发送时刻的版本快照——响应落地时该文件已又定稿
    // 新版本(isStaleResponse 真)则旧响应如实注解,绝不作为新版本的成功依据。
    // 「末版本必被请求」由链路自身保证:再定稿必再进合并窗再 fire
    // (tests/hotReloadRevisionGate 钉);此处只补「旧响应不冒充新版本成功」。
    // 发送代际的实例快照:响应面比对锚定发起发送的那个流水线实例(apply
    // 重建后新实例版本簿重置,旧响应只对旧代版本负责,不与新代混淆)
    const pipelineAtFire = pipeline;
    const sentRevisions = new Map<string, number>(
      pipelineAtFire ? triggers.map(file => [file, pipelineAtFire.revisionOf(file)]) : []
    );
    const STALE_RESPONSE_NOTE = '响应过期(发送后该文件又有新版本定稿,本响应不作为新版本的成功依据)';
    const staleSinceFire = (file: string): boolean => {
      const sent = sentRevisions.get(file);
      return (
        sent !== undefined &&
        pipelineAtFire !== undefined &&
        isStaleResponse(sent, pipelineAtFire.revisionOf(file))
      );
    };
    const updateStatus = (update: () => void): void => {
      if (batch === latestBatch && pipeline === pipelineAtFire) {
        update();
      }
    };
    const annotateStaleResponses = (files: readonly string[]): void => {
      const stale = files.filter(staleSinceFire);
      if (stale.length === 0) {
        return;
      }
      status.log(
        `响应过期: ${stale.length} 个文件发送后又有新版本定稿,本响应不作为新版本的成功依据(${stale.join(', ')})`
      );
    };
    // HR-WATCH-008:投递失败撤回去重指纹——同内容变更照发,不因一次失败
    // 永久跳过。指纹在批次交发送面那一刻记(核面),撤回只发生在如实失败的
    // 发送代际(成功代际不撤,去重仍有效)
    const forgetSentFailed = (file: string): void => {
      const revision = sentRevisions.get(file);
      if (revision !== undefined) {
        pipelineAtFire?.forgetSent(file, revision);
      }
    };
    // 默认热更请求(用户令 2026-11-06):未配动作名时保存即 POST
    // http://127.0.0.1:8090/hotfix?module_name=<模块名>,body 同带
    // module_name=<模块名>(双带);成败按传输
    // 事实——引擎没起(ECONNREFUSED)如实 failed,2xx 也只到「已发送(未确认)」。
    const runDefaultHotfix = (): void => {
      const injected = options.defaultHotfix ?? {};
      void sendDefaultHotfix([...triggers], {
        transport: injected.transport,
        isPackageDir: injected.isPackageDir,
        scriptRoot: injected.resolveScriptRoot?.() ?? '',
        allowRootLevelStem: injected.resolveAllowRootLevelStem?.() ?? false,
        onRequest: request => status.log(`默认热更: ${request.method} ${request.url} · body=${request.body}`)
      }).then(
        result => {
          annotateStaleResponses(triggers);
          if (result.ok) {
            updateStatus(() => status.setSentUnverified());
            notifyBatchResult(`已发送${result.detail.length > 0 ? `——${result.detail}` : ''}`, false);
            return;
          }
          triggers.forEach(forgetSentFailed);
          updateStatus(() => status.setFailed(result.detail.length > 0 ? result.detail : '默认热更请求失败'));
          notifyBatchResult(`失败${result.detail.length > 0 ? `——${result.detail}` : ''}`, true);
        },
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          triggers.forEach(forgetSentFailed);
          updateStatus(() => status.setFailed(message));
          notifyBatchResult(`失败——${message}`, true);
        }
      );
    };
    // IDE-HOT-102:审计五要素(谁/何时/文件/通道/结果)的「谁」与日志行——
    // 触发源缺省 watcher-auto(自动监视);通道面、actionName 回落面与 def 闸
    // 拦下面共用同一行式(「何时」由 OUTPUT 通道行前缀时间承担)。
    const channelAuditSource = options.auditSource ?? 'watcher-auto';
    const auditLine = (channelLabel: string, files: readonly string[], resultText: string): void => {
      status.log(`审计: 触发源=${channelAuditSource} | 文件=${files.length} 个 | 通道=${channelLabel} | 结果=${resultText}`);
      // 文件变化元信息(方案 B):审计行之后逐文件补一行元信息(module/process/
      // sha256/version),与 python 索引日志同一格式。懒异步解析,不阻塞发送;
      // 未注入解析器(测试/未接线)零 IO,解析失败只少一行审计不抛。
      const metaResolver = options.fileChangeMeta;
      if (!metaResolver) {
        return;
      }
      for (const file of files) {
        void metaResolver
          .metaFor({ fsPath: file, identity: normalizeFileIdentity(file), kind: 'change' })
          .then(meta => status.log(`文件元信息: ${formatFileChangeMeta(meta)}`), () => undefined);
      }
    };
    // HR-PR-08 provider 插槽发送面(键开才进链):应答者胜,结果如实映射
    // 既有状态/审计/指纹撤回面;无人应答(null=注册表空/全不应答)回落
    // 既有默认热更面,不冒充、不空转。
    const runViaProvider = (lifecycle: HotReloadResolvedLifecycle): void => {
      // .then 工厂起调:实现同步抛错也落拒绝分支(不在事件边界裸抛)。
      // 双名发送面(HR-DOD-001/RUST-440):逐文件经生命周期槽 resolveModule→
      // prepareRequest 解析出 requestModule(实际发送名,书 §19.1),经 send 的
      // moduleIdentities 上线路——只送短名,UI 展示名(fullModule)不上线路。
      // 解析不出(无根/歧义/非 py/__init__)该文件 moduleIdentities 置空串=视同
      // 未给(HR-HTTP-002),走既有推导面,不因收口丢文件;全不可解析=请求形状与
      // 增量前逐字一致(不带 moduleIdentities,零配置零漂移)。
      void Promise.resolve()
        .then(() => {
          const scriptRoot = options.defaultHotfix?.resolveScriptRoot?.() ?? '';
          const allowRootLevelStem = options.defaultHotfix?.resolveAllowRootLevelStem?.() ?? false;
          const moduleIdentities: string[] = [];
          let anyDual = false;
          for (const file of triggers) {
            const resolution = lifecycle.slots.resolveModule({
              fileUri: file,
              ...(scriptRoot.length > 0 ? { scriptRoots: [scriptRoot] } : {}),
              ...(options.defaultHotfix?.resolveAllowRootLevelStem !== undefined ? { allowRootLevelStem } : {})
            });
            if ('ok' in resolution && resolution.ok) {
              const request = lifecycle.slots.prepareRequest({ targetId: '', identity: resolution.identity });
              moduleIdentities.push(request.moduleIdentities?.[0] ?? resolution.identity.requestModule);
              anyDual = true;
            } else {
              moduleIdentities.push('');
            }
          }
          return lifecycle.provider.send({
            targetId: '',
            files: triggers,
            ...(anyDual ? { moduleIdentities } : {})
          });
        })
        .then(
          result => {
            annotateStaleResponses(triggers);
            if (result.ok) {
              updateStatus(() => status.setSentUnverified());
              auditLine(
                `provider:${lifecycle.provider.providerId}`,
                triggers,
                `已发送${result.detail ? `——${result.detail}` : ''}`
              );
              notifyBatchResult(`已发送${result.detail ? `——${result.detail}` : ''}`, false);
              return;
            }
            triggers.forEach(forgetSentFailed);
            updateStatus(() =>
              status.setFailed(
                result.detail && result.detail.length > 0
                  ? result.detail
                  : `provider ${lifecycle.provider.providerId} 发送失败`
              )
            );
            auditLine(
              `provider:${lifecycle.provider.providerId}`,
              triggers,
              `失败${result.detail ? `——${result.detail}` : ''}`
            );
            notifyBatchResult(`失败${result.detail ? `——${result.detail}` : ''}`, true);
            },
          (error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            triggers.forEach(forgetSentFailed);
            updateStatus(() => status.setFailed(message));
            auditLine(`provider:${lifecycle.provider.providerId}`, triggers, `失败——${message}`);
            notifyBatchResult(`失败——${message}`, true);
          }
        );
    };
    const proceed = (): void => {
      const fail = (error: unknown): void => {
        updateStatus(() => {
          status.setFailed(error instanceof Error ? error.message : String(error));
          reportActionError(error);
        });
      };
      // IDE-REV-021:该次发送逐文件落双维台账——targetId/rootId 解不到的
      // 维度如实不落;结果仍只有 sent-unverified/failed 两态(无回执管道,
      // 传输/执行成功≠应用成功,绝不记成功态)。
      // IDE-HOT-102:actionName 回落通道的台账记录带触发源与通道
      // (actionName:<名>),与通道发送面共用审计五要素语义。
      const fallbackChannel = `actionName:${settings.actionName}`;
      const recordOutcomes = (targetId: string | null, outcome: HotReloadDeliveryOutcome, detail?: string): void => {
        // HR-WATCH-008:脚本/命令动作整批一果,失败即整批撤回指纹(同内容照发)
        if (outcome === 'failed') {
          triggers.forEach(forgetSentFailed);
        }
        // RUST-386(HR-UI-013):成功结果摘要(通知面独立于台账,无
        // targetState/无目标也照实报)。失败面不在此弹——actionName 失败
        // 只走 reportActionError,其余发送路径只走 notifyBatchResult,
        // 同一完成不双弹。
        if (outcome !== 'failed') {
          notifyBatchResult('已发送(未校验业务回执)', false);
        }
        const wiring = options.targetState;
        if (!wiring || targetId === null) {
          return;
        }
        for (const file of triggers) {
          if (pipeline !== pipelineAtFire || staleSinceFire(file)) {
            continue;
          }
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
          detail: [current.detail, reason].filter(Boolean).join(' | '),
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
      // 解不到 root 的文件仍发送(单组 '' 键)但不落台账。发送核心(发送代际
      // 建立/冻结基准 await/全分支 digest 落账/applied 双证核验/代际绑定结算)
      // 抽到 hotReloadChannelSend,与失败目标重试共用同一实现(二轮交叉修复:
      // 部署通道失败重试接回同一通道,不再各自复刻回执流)。
      const sendViaChannel = (transport: ReloadTransport, channelTargetId: string): void => {
        const wiring = options.targetState;
        void sendFilesViaReloadChannel({
          transport,
          targetId: channelTargetId,
          files: triggers,
          resolveRootId: file => wiring?.resolveRootId(file) ?? null,
          store: wiring?.store,
          readFileContent: wiring?.readFileContent,
          timers,
          settleHandles,
          now,
          source: channelAuditSource
        }).then(({ sentCount, failedCount }) => {
          annotateStaleResponses(triggers);
          // HR-WATCH-008:逐文件精确撤回——最新回执为 failed 的文件才撤指纹,
          // 已送达文件的去重不受影响;RUST-419:同时收第一条 failed 明细
          // (分类后的可用错误)供部分失败汇总呈现
          let firstFailedDetail = '';
          if (failedCount > 0 && wiring) {
            for (const file of triggers) {
              const rootId = wiring.resolveRootId(file);
              const record = rootId == null ? undefined : wiring.store.get({ rootId, targetId: channelTargetId }, file);
              if (record?.outcome === 'failed') {
                forgetSentFailed(file);
                if (firstFailedDetail === '' && record.detail) {
                  firstFailedDetail = record.detail.length > 160 ? `${record.detail.slice(0, 160)}…` : record.detail;
                }
              }
            }
          }
          const allApplied = triggers.length > 0 && triggers.every(file => {
            const rootId = wiring?.resolveRootId(file);
            return rootId != null &&
              wiring?.store.get({ rootId, targetId: channelTargetId }, file)?.outcome === 'applied';
          });
          const result =
            failedCount > 0 && sentCount === 0
              ? `失败(${failedCount})${firstFailedDetail ? `:${firstFailedDetail}` : ''}`
              : failedCount > 0
                ? `部分失败(${failedCount} 失败/${sentCount} 已发)${firstFailedDetail ? `:${firstFailedDetail}` : ''}`
                : allApplied ? `已应用(${sentCount})——引擎回执指纹已核验`
                  : `已发送(${sentCount})——未确认引擎应用`;
          // F4:通道审计行带目标标识(状态/审计面区分目标;通道名仍是
          // transport.kind,通道=前缀断言不受影响)
          auditLine(`${transport.kind} 目标=${channelTargetId}`, triggers, result);
          // RUST-386:通道成功摘要(失败面下方 reportActionError 已报,
          // 不双弹)
          if (failedCount === 0) {
            notifyBatchResult(result, false);
          }
          if (failedCount > 0 && sentCount === 0) {
            updateStatus(() => status.setFailed(`通道 ${transport.kind} 全部失败(${failedCount})${firstFailedDetail ? `:${firstFailedDetail}` : ''}`));
          } else if (allApplied) {
            updateStatus(() => status.setApplied(`目标=${channelTargetId}，${sentCount} 个文件，回执指纹一致`));
          } else if (failedCount > 0) {
            updateStatus(() => status.setFailed(`通道 ${transport.kind} 部分失败(${failedCount}/${triggers.length})${firstFailedDetail ? `:${firstFailedDetail}` : ''}`));
          } else {
            updateStatus(() => status.setSentUnverified());
          }
          // 组内错误已在 catch 落账 failed,这里按汇总如实上报一次(部分
          // 失败也上报,动作名回落面的 fail() 同口径:失败即报)。
          if (failedCount > 0) {
            updateStatus(() => reportActionError(new Error(`通道 ${transport.kind} 发送失败:${failedCount} 个文件未送达`)));
          }
        }, (error: unknown) => {
          // HR-WATCH-008:整批异常无法区分逐文件结果——无回执(未确认送达)
          // 或回执为 failed 的文件一律撤指纹,允许同内容重发;回执查询自身
          // 抛错时退化为整批撤回,绝不因撤回吞掉失败上报面
          try {
            for (const file of triggers) {
              const rootId = wiring?.resolveRootId(file);
              const record = rootId == null ? undefined : wiring?.store.get({ rootId, targetId: channelTargetId }, file);
              if (record === undefined || record.outcome === 'failed') {
                forgetSentFailed(file);
              }
            }
          } catch {
            for (const file of triggers) {
              forgetSentFailed(file);
            }
          }
          updateStatus(() => {
            status.setFailed(error instanceof Error ? error.message : String(error));
            reportActionError(error);
          });
        });
      };
      const start = (targetId: string | null): void => {
        // RT-10:applied 核验窗口统一锚定「发送发起时点」——与重试路径
        // (resendHotReloadTarget 的 sentAt)同语义,响应晚到不后移窗口。
        const sentAt = now();
        const wiring = options.targetState;
        const attemptsAtSend = new Map<string, number | undefined>();
        if (wiring && targetId !== null) {
          for (const file of triggers) {
            const rootId = wiring.resolveRootId(file);
            if (rootId !== null) {
              attemptsAtSend.set(file, wiring.store.get({ rootId, targetId }, file)?.attempt);
            }
          }
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
          if (!wiring || targetId === null || pipeline !== pipelineAtFire) {
            return;
          }
          for (const file of triggers) {
            const rootId = wiring.resolveRootId(file);
            if (rootId === null) {
              continue;
            }
            const key = { rootId, targetId };
            if (staleSinceFire(file) && wiring.store.get(key, file)?.attempt !== attemptsAtSend.get(file)) {
              continue;
            }
            // IDE-REV-027:回包体喂引擎 digest 证据册(册内判协议与归属)
            options.noteEngineDigest?.(key, file, response.body);
            // 观察者只在响应到达时触发 → 传输已成功,分类按 status 走
            const record = recordHttpDelivery(wiring.store, key, file, { ok: true, status: response.status }, {});
            // HR-WATCH-008:非 2xx=投递失败,撤回去重指纹(同内容变更照发,
            // 不因一次失败永久跳过)
            if (record.outcome === 'failed') {
              forgetSentFailed(file);
            }
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
                // 回执 file 不在本次发送批(异常/伪造接收端回包)时 baselineReads
                // 无该键——旧实现对 undefined 取 .then 抛 TypeError 中断回执回调
                // 批处理;回落「无基准保持未确认」而非崩溃。
                const sentDigestPromise = baselineReads.get(file);
                if (sentDigestPromise === undefined) {
                  noteStillUnverified(
                    wiring,
                    key,
                    file,
                    'applied 核验阻塞:发送批无该文件基准,保持未确认',
                    attempt
                  );
                } else {
                  void sentDigestPromise.then(sentDigest => {
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
              }
              scheduleAppliedSettle(wiring, key, file, sentAt, attempt);
            }
            // HR-WATCH-011:响应相对本代发送已过期(文件又定稿新版本)→ 台账
            // 记录如实注解,读者不会把旧响应误读成新版本的成功依据;只注解
            // sent-unverified(accepted/applied 是发送内容的事实,锚定冻结
            // 基准,不冒充),绑定本代 attempt(新代记录不背旧响应的注解)
            if (staleSinceFire(file)) {
              noteStillUnverified(wiring, key, file, STALE_RESPONSE_NOTE, attempt);
            }
          }
          annotateStaleResponses(triggers);
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
              updateStatus(() => status.setSentUnverified());
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
      const channelHandle = options.resolveChannelTransport?.(settings.actionName.length === 0);
      if (channelHandle) {
        void Promise.resolve().then(() => sendViaChannel(channelHandle.transport, channelHandle.targetId));
        return;
      }
      if (settings.actionName.length === 0) {
        // 未配动作名不再空转(旧行为 setSkippedNoAction):改发默认热更请求。
        // 走到这里说明 def 结构闸已放行本批,结构性 def 变更照旧拦下不发。
        // HR-PR-08:键开时先问发送 provider 注册表(应答者胜),无人应答
        // 才落默认热更面;键关=面不进链,行为与既有完全一致。
        if (settings.sendViaProviders) {
          // RUST-412:注册表解析(canSend 是第三方同步代码)与回落默认热更整段
          // 挪进微任务,不占 fire 回调同步段——语言服务(hover/definition 同
          // 事件循环)的尾延迟不该被派发决议吃掉;键开=本段延一跳,键关分支
          // 逐字保留(下面 runDefaultHotfix 仍在同步段)。
          // 双名发送面(HR-DOD-001/RUST-440):经 resolveLifecycle 合成生命周期槽
          // (实现自带槽优先,缺槽回落缺省组合核)——provider 只是一个通道,双名
          // 解析在槽上。
          void Promise.resolve().then(() => {
            const lifecycle = providerHost.registry.resolveLifecycle(buildEngineProfile({}));
            if (lifecycle) {
              runViaProvider(lifecycle);
              return;
            }
            runDefaultHotfix();
          });
          return;
        }
        runDefaultHotfix();
        return;
      }
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
    // RT-3:判定面抽到 hotReloadDefGate,fail 与失败目标重试共用同一实例与
    // 同一基线册(可注入),重试不复用判定就会让结构性 def 经重试通道下发。
    const warnRestart = (text: string): void => {
      if (notifyMode() === 'silent') {
        // HR-UI-013:silent 全静默;拦截事实照旧落审计/状态栏/历史,不丢。
        return;
      }
      try {
        void Promise.resolve(vscode.window.showWarningMessage(text)).catch(() => undefined);
      } catch {
        // VS Code 关闭期间提示 API 可能不可用,闸门决策不受影响
      }
    };
    const gateDefChanges = (): void => {
      // 纯 Python 批同步放行(与抽闸前行为逐字一致,不引入微任务延迟);
      // 配置文件批(RUST-336)同走闸链,只是判定面换成配置校验
      const hasDef = triggers.some(file => file.toLowerCase().endsWith('.def'));
      const configFiles = triggers.filter(isHotReloadConfigFile);
      if (!hasDef && configFiles.length === 0) {
        proceed();
        return;
      }
      const block = (reasons: readonly string[]): void => {
        updateStatus(() => status.setRestartRequired([...reasons], triggers));
        // IDE-HOT-100:拦下通知状态机标 RESTART_REQUIRED 呈现(与日志同源);
        // 拦下本身是 HOT-005 的既有面,这里只多一个呈现通知。
        options.onRestartRequired?.(settings.actionName, triggers, [...reasons]);
        const first = reasons[0] ?? 'def 结构待核';
        // IDE-HOT-102:def 闸拦下的重载也进审计——通道记为「拦截:需重启」,
        // 结果=拦截原因,与通道发送/actionName 回落共用五要素语义(谁/何时/
        // 文件/通道/结果);「何时」由 OUTPUT 通道行前缀时间承担。
        auditLine('拦截:需重启', triggers, `未发送——${first}${reasons.length > 1 ? ` 等 ${reasons.length} 项` : ''}`);
        warnRestart(`结构性 def 变更需要重启,本次不发普通 reload: ${first}${reasons.length > 1 ? ` 等 ${reasons.length} 项` : ''}`);
      };
      // RUST-336 配置闸拦下:不发普通 reload,但**不**称需重启——拦的是
      // 内容本身有问题(修复前重启也起不来),诚实口径是修好再发;审计
      // 通道记「拦截:配置校验失败」,与 def 闸共用五要素语义。状态机面
      // 不推(与流水线语法闸 blocked 同口径:不 fire 不推状态)。
      const blockConfig = (reasons: readonly string[]): void => {
        const first = reasons[0] ?? '配置校验失败';
        auditLine('拦截:配置校验失败', triggers, `未发送——${first}${reasons.length > 1 ? ` 等 ${reasons.length} 项` : ''}`);
        warnRestart(`配置文件校验失败,本次不发普通 reload(修复后再次保存即重发): ${first}${reasons.length > 1 ? ` 等 ${reasons.length} 项` : ''}`);
      };
      // RUST-336 配置闸放行面:内容校验通过的配置变更也不走模块热更
      // (引擎按 python 模块重载,XML 配置没有可发的 module_name),生效
      // 通道本就是重启——按 def 闸同款需重启面呈现(状态机/审计/警告),
      // 校验通过让重启决策有依据。
      const blockConfigRestart = (reasonText: string): void => {
        updateStatus(() => status.setRestartRequired([reasonText], triggers));
        options.onRestartRequired?.(settings.actionName, triggers, [reasonText]);
        auditLine('拦截:配置变更需重启', triggers, `未发送——${reasonText}`);
        warnRestart(`配置文件变更不走模块热更,需重启引擎生效: ${reasonText}`);
      };
      // RUST-398(HR-HASH-011):types.xml 变化影响报告——会话基线:该文件
      // 首次在本会话经管道见到即建档(变更面自下次起报告),此后变化做
      // before/after reverse-dependency 分析。types.xml 属配置,永不自动
      // 应用;受影响 .def 按 RUST-397 同判据需重启,报告并入需重启理由。
      const buildTypesImpact = async (): Promise<string | null> => {
        const typesXmlFiles = configFiles.filter(isTypesXmlBasename);
        if (typesXmlFiles.length === 0) {
          return null;
        }
        const readConfig = options.targetState?.readFileContent;
        if (!readConfig) {
          return 'types.xml 变更:无内容读取通道,影响报告未生成(如实跳过)';
        }
        const defs = (await options.collectDefsForTypesImpact?.()) ?? [];
        const lines: string[] = [];
        for (const file of typesXmlFiles) {
          const after = await readConfig(file);
          if (after === null || after === undefined) {
            lines.push(`${file}: 内容不可读,影响报告未生成(如实跳过)`);
            continue;
          }
          const before = typesXmlBaselines.get(file);
          typesXmlBaselines.set(file, after);
          if (before === undefined) {
            lines.push(`${file}: 本次会话首次见到,已建档为基线(变更面自下次起报告)`);
            continue;
          }
          const report = analyzeTypesImpact({ beforeTypesXml: before, afterTypesXml: after, defs });
          // RUST-403:依赖图闭包命中数记账(受影响 .def 数;影响分析是唯一
          // 依赖遍历面,统计口径=实际遍历到的节点数)
          options.fingerprintStats?.recordDependencyTraversal(report.affectedDefCount);
          lines.push(
            defs.length === 0
              ? `${file}: ${formatTypesImpactReport(report)};未收集 .def,影响面未知`
              : `${file}: ${formatTypesImpactReport(report)}`
          );
        }
        return lines.join(';');
      };
      // RUST-399(HR-HASH-012):entities.xml 注册项变化影响报告——会话基线:
      // 该文件首次在本会话经管道见到即建档(变更面自下次起报告),此后变化做
      // before/after 注册项对比。注册表是引擎装载期结构面:注册项变化即注册表
      // 版本变化,Python reload 不替代(默认不发 Python 热更请求替代结构变更),
      // 报告并入需重启理由。不需要收集 .def(受影响实体即变化集本身)。
      const buildEntitiesImpact = async (): Promise<string | null> => {
        const entitiesXmlFiles = configFiles.filter(isEntitiesXmlBasename);
        if (entitiesXmlFiles.length === 0) {
          return null;
        }
        const readConfig = options.targetState?.readFileContent;
        if (!readConfig) {
          return 'entities.xml 变更:无内容读取通道,影响报告未生成(如实跳过)';
        }
        const lines: string[] = [];
        for (const file of entitiesXmlFiles) {
          const after = await readConfig(file);
          if (after === null || after === undefined) {
            lines.push(`${file}: 内容不可读,影响报告未生成(如实跳过)`);
            continue;
          }
          const before = entitiesXmlBaselines.get(file);
          entitiesXmlBaselines.set(file, after);
          if (before === undefined) {
            lines.push(`${file}: 本次会话首次见到,已建档为基线(变更面自下次起报告)`);
            continue;
          }
          const report = analyzeEntitiesImpact({ beforeEntitiesXml: before, afterEntitiesXml: after });
          lines.push(`${file}: ${formatEntitiesImpactReport(report)}`);
        }
        return lines.join(';');
      };
      // 批内配置影响报告(types.xml + entities.xml):并入需重启理由/审计
      const buildConfigImpact = async (): Promise<string | null> => {
        const parts: string[] = [];
        const typesLine = await buildTypesImpact();
        if (typesLine) {
          parts.push(typesLine);
        }
        const entitiesLine = await buildEntitiesImpact();
        if (entitiesLine) {
          parts.push(entitiesLine);
        }
        return parts.length > 0 ? parts.join(';') : null;
      };
      // RUST-336:批内配置文件内容校验(良构+types.xml 值域/一致性);
      // 有致命发现拦下报校验失败,零发现走需重启面(配置永不走普通通道)
      const gateConfig = (then: () => void): void => {
        if (configFiles.length === 0) {
          then();
          return;
        }
        const readConfig = options.targetState?.readFileContent;
        if (!readConfig) {
          blockConfigRestart(`${configFiles[0]}: 无内容读取通道,内容未校验`);
          return;
        }
        void checkHotReloadConfigFiles(triggers, readConfig).then(verdict => {
          if (verdict.reasons.length > 0) {
            blockConfig(verdict.reasons);
            // 影响报告是事实面(内容有问题也如实报影响),不阻塞校验失败面
            void buildConfigImpact().then(line => {
              if (line) {
                status.log(`配置影响报告: ${line}`);
              }
            });
            return;
          }
          // 影响报告并入需重启理由(受影响 .def / 实体注册表同判据需重启,不自动热更)
          void buildConfigImpact().then(line => {
            blockConfigRestart(line ? `内容校验通过;${line}` : '内容校验通过');
          });
        });
      };
      if (!hasDef) {
        gateConfig(proceed);
        return;
      }
      void defGate.check(triggers).then(verdict => {
        if (verdict.reasons.length > 0) {
          block(verdict.reasons);
          return;
        }
        // F1:只有放行且即将真实发送的批次才前滚基线(commit)——被拦批次
        // 绝不滚动,否则第二次发送同一内容指纹相同即绕过需重启。F1 四轮:
        // commit 凭本批自己的令牌认领快照(被拦批不入认领队列,同文件集的
        // 并发批各归各)。前滚失败不阻塞发送(保守面在判定,不在前滚;下次
        // 判定按旧基线保守拦)。
        void Promise.resolve(defGate.commit?.(verdict.token)).catch(() => undefined);
        gateConfig(proceed);
      });
    };
    gateDefChanges();
  };

  // HR-PR-04 接线(HR-WATCH 纯核→live 触发链),两级形态:
  // ①进料级 HotReloadSavePipeline——每文件尾窗去抖(同文件连发归并)、
  //   max-delay 封顶、去重指纹/版本号册内建;稳定窗(HR-WATCH-007)/语法闸
  //   (HR-WATCH-012)/波次冲口(HR-WATCH-013)/预览阈(HR-WATCH-016)随配置
  //   键启用(键关=如实不做,不猜;替身经 pipelineFaces 只在键开时顶替)。
  //   0 冲口=定稿即汇入合并池(缺省时序不变)。
  // ②合并窗 HotReloadTrigger(既有全局去抖,与旧时序同感)——把同窗定稿
  //   合成一批交给发送编排。def 结构闸「整批拦下」契约依赖同批共见,逐文件
  //   直发会让混批里的 py 绕过闸,故合并窗必须在 fire 前兜住整批;波次窗
  //   (>0)在进料级先归集,合并窗仍兜整批(双层窗,延迟如实叠加)。
  // 同刻时序:offer 先排流水线去抖、后排合并窗,虚拟/真定时器都按插入序
  // 先定稿后合并,单拍(测试 tick)内即完成「定稿→合并→fire」。
  const pendingOut = new Set<string>();
  const trigger = new HotReloadTrigger(() => {
    const triggers = [...pendingOut];
    pendingOut.clear();
    if (triggers.length === 0) {
      return; // 定稿全被拦/去重时合并窗空转:如实不 fire 不推状态
    }
    options.onPipelineQueueChanged?.();
    runFire(triggers);
  }, timers);
  let pipeline: HotReloadSavePipeline | undefined;
  if (options.pipelineQueue) {
    // HR-UI-004 实时队列面:置一次闭锁(读 `let pipeline` 当前实例),随
    // apply 重建仍指现行流水线;流水线未建时如实空队列,不猜。
    options.pipelineQueue.current = () => {
      const snapshot = pipeline?.queueSnapshot() ?? { pending: [], previewHeld: [], wave: [] };
      return { ...snapshot, wave: [...new Set([...snapshot.wave, ...pendingOut])] };
    };
  }
  // RUST-002 判据③:热更语法闸是最高频的 Python 脚本执行面(每次定稿一次),
  // 原来每次 spawn 一个新解释器进程。改用常驻执行服务承载:一个解释器进程跑
  // 任意多次 compile(),只在故障/超时后重建。失败语义两路分叉(纯核
  // pythonExecSyntaxCompile):执行服务故障 reject → 闸门 fail-open 放行;
  // 真语法错误 resolve ok:false → 闸门拦下。
  let execCompile: ReturnType<typeof createExecServiceCompile> | undefined;
  // HR-WATCH-012 真语法闸:解释器解析一次随面建立(venv 深扫不进热更链路);
  // 配置面重建 apply 时闸随建,执行服务随之换句柄(解释器路径变更自然刷新)
  const buildRealSyntaxGate = (): SyntaxCheck => {
    const previous = execCompile;
    // 捕获局部句柄:外层的 execCompile 会被后续重建重新赋值,闭包里读它
    // 不会保住这里的赋值收窄(TS 不按「调用时已赋值」推断),局部 const 才稳。
    const handle = createExecServiceCompile({
      resolveInterpreter: () => resolveProfileInterpreter().interpreterPath,
      createService: interpreter => createPythonExecService({ interpreter })
    });
    execCompile = handle;
    previous?.dispose();
    return createPythonSyntaxGate({
      resolveInterpreter: () => resolveProfileInterpreter().interpreterPath,
      // 闸门契约是 compile(interpreter, content) 两参;常驻服务在创建时已按同一
      // 解析器固定解释器,故闸门解析出的解释器形参在此显式忽略。
      // **不可**直接写 handle.compile(单参):TS 少参数容忍会让 interpreter
      // 落进 content 位,把解释器路径当源码编译,一切内容都被判成语法错。
      compile: (_interpreter, content) => handle.compile(content),
      onUnavailable: reason => {
        status.log(`热更语法闸不可用: ${reason}`);
      }
    });
  };
  const buildPipeline = (current: HotReloadSettings): HotReloadSavePipeline =>
    new HotReloadSavePipeline({
      debounceMs: current.debounceMs,
      stabilityWindowMs: current.stabilityWindowMs,
      batchFlushMs: current.batchFlushMs,
      batchPreviewThreshold: current.batchPreviewThreshold,
      // HR-WATCH-007/012 快照读:稳定窗>0(两拍比对)或语法闸开(内容面)
      // 才注入——闸没有内容就是死面,如实接通;窗 0 时核单拍直取内容
      ...(current.stabilityWindowMs > 0 || current.syntaxGate
        ? { readSnapshot: options.pipelineFaces?.readSnapshot ?? readScriptSnapshot }
        : {}),
      // HR-WATCH-012 语法闸:开关开启才注入(检查器故障放行,不拦热更)
      ...(current.syntaxGate
        ? { checkSyntax: options.pipelineFaces?.syntaxCheck ?? buildRealSyntaxGate() }
        : {}),
      // HR-WATCH-016 滞留可见性:预览滞留必须上日志,否则放行命令无从发现;
      // RUST-341:八型诊断全量另落「KBEngine 热更诊断」通道(用户可审查
      // 时间线),主日志的既有可见性契约不因新面而丢
      onDiagnostic: diagnostic => {
        options.onPipelineQueueChanged?.();
        diagnosticsPanel.push(diagnostic);
        if (diagnostic.type === 'preview') {
          status.log(`热更批量预览滞留: ${diagnostic.detail}`);
        }
      },
      timers,
      now,
      onEmit: events => {
        for (const event of events) {
          pendingOut.add(event.uri);
        }
        // offer 时已排的合并窗照旧走(不后移 fire 时机);在途窗已 fire 而
        // 定稿晚到(稳定窗/封顶延迟的边缘路径)时才由这里补排,晚到文件
        // 随下一批走,不丢
        if (!trigger.pending()) {
          trigger.schedule(current.debounceMs);
        }
      }
    });

  // HR-WATCH-016 预览放行命令:闭锁 pipeline 变量,随 apply 重建仍操作当前
  // 实例;滞留为空时如实报空,不假装放行。滞留面上日志(见 buildPipeline
  // 的 onDiagnostic),命令入口从命令面板可达。命令随复合 disposable 一并
  // 释放(subscriptions 只挂一条复合,见函数头注)。
  const releasePreviewCommand = vscode.commands.registerCommand(
    'kbengine.hotReload.releasePreview',
    () => {
      const held = pipeline?.previewHeldFiles() ?? [];
      if (held.length === 0) {
        void vscode.window.showInformationMessage('没有滞留的热更预览批次');
        return;
      }
      pipeline?.releasePreview();
      void vscode.window.showInformationMessage(`已放行热更预览批次(${held.length} 文件)`);
    }
  );

  // HR-STATE-011 队列控制:暂停/恢复/取消(命令面板可达;闭锁 pipeline 变量,
  // 随 apply 重建仍操作当前实例,与 releasePreview 同口径)。
  const pauseCommand = vscode.commands.registerCommand('kbengine.hotReload.pause', () => {
    if (!pipeline) {
      void vscode.window.showInformationMessage('热更流水线未启用');
      return;
    }
    pipeline.pause();
    void vscode.window.showInformationMessage('已暂停热更流水线(新事件仍累积,恢复时一次放出)');
  });

  const resumeCommand = vscode.commands.registerCommand('kbengine.hotReload.resume', () => {
    if (!pipeline) {
      void vscode.window.showInformationMessage('热更流水线未启用');
      return;
    }
    pipeline.resume();
    void vscode.window.showInformationMessage('已恢复热更流水线');
  });

  const cancelCommand = vscode.commands.registerCommand('kbengine.hotReload.cancel', () => {
    const file = vscode.window.activeTextEditor?.document.uri.fsPath;
    if (!file || !pipeline) {
      void vscode.window.showInformationMessage('活动编辑器无文件或热更流水线未启用');
      return;
    }
    const hit = pipeline.cancel(file);
    if (hit === 'none') {
      void vscode.window.showInformationMessage(`当前文件无待发热更:${file}`);
      return;
    }
    const where =
      hit === 'pending' ? '归并中' : hit === 'preview-held' ? '预览滞留' : hit === 'wave' ? '波次内' : '定稿在途';
    void vscode.window.showInformationMessage(`已取消待发热更(${where}):${file}`);
  });

  // RUST-341:诊断审查入口——打开「KBEngine 热更诊断」通道(八型事件
  // 时间线,见 buildPipeline 的 onDiagnostic 全量落账)。命令随复合
  // disposable 一并释放(与 releasePreview 同口径)。
  const showDiagnosticsCommand = vscode.commands.registerCommand(
    HOT_RELOAD_SHOW_DIAGNOSTICS_COMMAND,
    () => diagnosticsPanel.show()
  );

  // HR-PR-05 磁盘侧接线面(HR-WATCH-003/005/015):注入 watcher 工厂才建。
  // 事件与 save 同链汇流(版本簿→流水线→合并窗),source='disk-change' 与
  // save 的重叠去重在流水线纯核归并(同 pending 单条,不双发);控制器随
  // apply 重建(每次新实例:filterOptions 的 roots 声明取当次工作区根,不
  // 留陈根;arm 窗在同步块内关,重建不产生可滑入的事件空档),范围闸与既有
  // watcher 面同口径(diskOfferInScope,见 apply)。
  let diskWatch: HotReloadDiskWatchController | undefined;
  let diskDebounceMs = 0;
  /** 磁盘 offer 的热更域范围闸输入(apply 按最新计划落盘;关/错面=null 不收) */
  let diskScope: {
    readonly mode: 'explicit' | 'derived';
    readonly globs: readonly string[];
    readonly assetsRoot: string;
    readonly roots: readonly string[];
  } | null = null;
  const diskOfferInScope = (file: string): boolean => {
    if (!diskScope) {
      return false;
    }
    if (diskScope.mode === 'derived') {
      // 派生:assetsRoot 前缀即热更域(与派生 watcher 的 RelativePattern 同界)
      const root = diskScope.assetsRoot;
      return root.length > 0 && (file === root || file.startsWith(`${root}/`));
    }
    // 显式:任一工作区根下相对路径命中配置 globs(与显式 watcher 同界,
    // 复用版本徽标同一匹配核,不另写第二套 glob 语义)
    for (const root of diskScope.roots) {
      if (file === root || file.startsWith(`${root}/`)) {
        if (matchesHotReloadGlob(file.slice(root.length + 1), diskScope.globs)) {
          return true;
        }
      }
    }
    return false;
  };

  const watchers: vscode.FileSystemWatcher[] = [];
  // IDE-REV-023 applied 核验窗口的结算定时器:随装配释放一并清掉
  const settleHandles = new Set<unknown>();
  // IDE-REV-024 def 结构基线:上次闸门见到的 .def 内容(会话内存,逐次滚动)
  const defBaselines = new Map<string, string>();
  // RUST-398:types.xml 会话基线(名 → 最近一次经管道见到的原文)。首见建档,
  // 再次变化才前后对比出影响报告;会话级(与 def 基线册同生命周期,fire 间
  // 不重置)——每批 fire 内建的基线册会因「首见即建档」永不产生前后对比。
  const typesXmlBaselines = new Map<string, string>();
  // RUST-399:entities.xml 会话基线(名 → 最近一次经管道见到的原文)。与
  // types.xml 基线册同纪律:首见建档,再次变化才前后对比出注册影响报告。
  const entitiesXmlBaselines = new Map<string, string>();
  // RT-3:判定面共用(hotReloadDefGate)——注入的闸实例优先(与重试侧同一基
  // 线册),否则本装配自建(基线册私有,重试侧拿不到)
  const defGate =
    options.defGate ?? createDefStructuralGate(options.targetState?.readFileContent, defBaselines);
  // §11.2 旁路通道:事件源复用 sharedFileEvents 的 30ms 合并 + version token
  // (KR-AUD-30 同一口径,不另起炉灶);路由表可注入(装配方持有以便注册消费者
  // 与订阅),不注入自建无消费者私有路由 = 只记录不处理。
  const router: FileChangeRouter = options.fileChangeRouter ?? createFileChangeRouter();
  const bypassMerger = createSharedFileEventMerger();
  /** 无消费者命中的累计数(状态日志「N 个待路由」的 N) */
  let unroutedNonPython = 0;
  const publishBypassEvent = async (event: SharedFileEvent): Promise<void> => {
    // .py/目录/取证失败在 build 内如实挡下(返回 null),不进旁路
    const meta = await buildNonPythonChangeEvent({ fsPath: event.fsPath, kind: event.kind });
    if (!meta) {
      return;
    }
    const hits = router.publish(meta);
    if (hits.length === 0) {
      unroutedNonPython += 1;
      // 如实记账:只记录,不投递、不发帧、不动热更状态栏
      status.log(`非 py 变化待路由(无消费者,未投递): 累计 ${unroutedNonPython} 个 | ${meta.fileName}`);
    }
  };
  const unsubscribeBypass = bypassMerger.subscribe(event => void publishBypassEvent(event));
  const disposeWatchers = (): void => {
    for (const watcher of watchers) {
      watcher.dispose();
    }
    watchers.length = 0;
  };

  const firstWorkspaceRoot = (): string => {
    try {
      return vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath ?? '';
    } catch {
      return '';
    }
  };
  const resolveAssetsRootSafe = (workspaceRoot: string): string => {
    try {
      return resolveAssetsRootForWorkspace(workspaceRoot);
    } catch {
      return ''; // 解析异常按缺根处理:显式报错,绝不回落全扫
    }
  };
  /** §11.4 上次生效的重建判据(初始空串:首次 apply 必落一次) */
  let lastWatchSignature = '';
  /** 读本次装配/签名共用的输入(显式 globs 关着不依赖根,省掉发现扫描) */
  const readWatchInputs = (): {
    settings: HotReloadSettings;
    workspaceRoot: string;
    assetsRoot: string;
  } => {
    const settings = readHotReloadSettings(hotReloadSectionReader());
    const workspaceRoot = firstWorkspaceRoot();
    // 关着但没写 globs 也要现算根:watch-off 的缺根提示必须基于**真解析出来的**
    // 根(否则 assetsRoot 配得好好的也会被说成「未配」)。显式 globs 关着时
    // 没有任何缺根提示要用根,才省掉发现扫描。
    const assetsRoot =
      settings.enabled || settings.globsSpec === 'unset'
        ? resolveAssetsRootSafe(workspaceRoot)
        : '';
    return { settings, workspaceRoot, assetsRoot };
  };
  /** §11.4 重建判据:显式输入 + 派生输入(不只看 enabled/globs) */
  const watchSignatureOf = (inputs: ReturnType<typeof readWatchInputs>): string =>
    JSON.stringify([
      inputs.settings.enabled,
      inputs.settings.globs,
      inputs.settings.globsSpec,
      inputs.workspaceRoot,
      inputs.assetsRoot
    ]);

  /** 旁路面注册形态:assetsRoot 下全扩展名(ACC-011 RelativePattern 口径) */
  const bypassPatternOf = (assetsRoot: string, workspaceRoot: string): vscode.RelativePattern => {
    const { base, pattern } = deriveWatcherPattern(assetsRoot, workspaceRoot, '**/*');
    return new vscode.RelativePattern(base, pattern);
  };
  /** 非 py 才进旁路(.py 归热更面;旁路事件恒 NonPython) */
  const emitToBypass = (uri: vscode.Uri, kind: FileChangeKind): void => {
    if (uri.fsPath.toLowerCase().endsWith('.py')) {
      return;
    }
    bypassMerger.emit(uri.fsPath, kind);
  };
  const pyOnly =
    (handler: (uri: vscode.Uri) => void) =>
    (uri: vscode.Uri): void => {
      if (uri.fsPath.toLowerCase().endsWith('.py')) {
        handler(uri);
      }
    };

  /**
   * 热更域(§11.1/§11.2):显式 globs 也只把 `.py`(热更本职)与 `.def`
   * (结构闸 IDE-HOT-005/REV-024,非结构 def 照常放行)送进投递——引擎按
   * python 模块重载,其余扩展没有可发的模块(默认热更 POST 的 module_name
   * 同样只对 python 模块有意义),只走旁路。否则显式的全匹配模式会让 .xml
   * 既进投递(推状态栏、跑动作)又进旁路,同事件双处理。
   * RUST-336 例外:KBEngine 配置文件(types.xml/kbengine*.xml/entity_defs
   * 下 XML)进投递只为过配置闸受检——校验失败拦下报错,校验通过走需重启
   * 面;配置永不走普通模块发送(见 gateConfig)。
   */
  const hotDomainOnly =
    (handler: (uri: vscode.Uri) => void) =>
    (uri: vscode.Uri): void => {
      const lower = uri.fsPath.toLowerCase();
      if (lower.endsWith('.py') || lower.endsWith('.def') || isHotReloadConfigFile(uri.fsPath)) {
        handler(uri);
      }
    };

  const attachWatcher = (
    pattern: vscode.GlobPattern,
    handlers: {
      readonly onHot?: (uri: vscode.Uri) => void;
      readonly onBypass?: (uri: vscode.Uri, kind: FileChangeKind) => void;
    }
  ): void => {
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const wire =
      (kind: FileChangeKind) =>
      (uri: vscode.Uri): void => {
        handlers.onHot?.(uri);
        handlers.onBypass?.(uri, kind);
      };
    watcher.onDidChange(wire('change'));
    watcher.onDidCreate(wire('create'));
    watcher.onDidDelete(wire('delete'));
    watchers.push(watcher);
  };

  const apply = (): void => {
    disposeWatchers();
    // 磁盘面随 apply 重建(HR-WATCH-005):旧控制器连同其 watcher 全清,
    // 新面按本次计划/根重建(关/错面=null,磁盘事件就此不进)
    diskWatch?.dispose();
    diskWatch = undefined;
    diskScope = null;
    // 重建流水线:在途待定稿与在途合并批随旧实例弃置(与旧 trigger.cancel+
    // 清攒批同义),新实例按最新 debounceMs 建——去抖窗随配置联动重建(§11.4)
    pipeline?.dispose();
    trigger.cancel();
    pendingOut.clear();
    const inputs = readWatchInputs();
    const { settings, workspaceRoot, assetsRoot } = inputs;
    pipeline = buildPipeline(settings);
    options.onPipelineQueueChanged?.();
    lastWatchSignature = watchSignatureOf(inputs);
    const plan = planHotReloadWatch({
      enabled: settings.enabled,
      globs: settings.globs,
      globsSpec: settings.globsSpec,
      assetsRoot,
      workspaceRoot
    });
    if (plan.error) {
      // §11.1 显式报错:状态栏 ready-with-error + 诊断指路(缺根补救),
      // 绝不静默回落 `**/*.py` 全扫
      status.setReadyError(plan.error.message);
      return;
    }
    if (plan.watchOff) {
      // §11.1 关因如实区分:disabled 且「没写 globs 且派生不到根」时补一句缺根
      // 提示,与 empty-globs(显式空)两种关法绝不混写
      const detail =
        plan.watchOff === 'disabled' && settings.globsSpec === 'unset' && !assetsRoot
          ? HOT_RELOAD_ASSETS_ROOT_REMEDY
          : undefined;
      status.setWatchOff(plan.watchOff, detail);
      return;
    }
    // 走到这里必是显式或派生(错误/关闭已 return)
    const source: HotReloadGlobSource = plan.source === 'explicit' ? 'explicit' : 'derived';
    const scheduleHot = (uri: vscode.Uri): void => {
      // HOT-VER:watcher 热更域事件(.py/.def,含 create/change/delete)→ 版本簿
      // 采样(建档/跳号);与手动触发路径共用同一台账。域外文件不入台账。
      options.onWatchedFileChange?.(uri.fsPath);
      pipeline?.offer(uri.fsPath, 'save');
      // 合并窗与进料级同窗重排(尾窗语义与旧全局去抖同感):先排流水线
      // 去抖、后排合并窗,同拍定时器按插入序先定稿后合并
      trigger.schedule(settings.debounceMs);
    };
    if (source === 'explicit') {
      // 显式 globs 原样生效(§11.1/零回归):@types/vscode 只接受单个
      // GlobPattern,每个模式各建一个 watcher。投递面收在热更域内
      // (.py/.def,见 hotDomainOnly):域外扩展只走旁路,不推状态栏不跑动作
      for (const glob of plan.globs) {
        attachWatcher(glob, { onHot: hotDomainOnly(scheduleHot) });
      }
      // 旁路面与显式 globs 各挂各的(旁路恒按 assetsRoot 全扩展名);缺根则
      // 本会话无旁路面(显式 globs 不依赖根)
      if (assetsRoot) {
        attachWatcher(bypassPatternOf(assetsRoot, workspaceRoot), { onBypass: emitToBypass });
      }
    } else {
      // 派生场景一个 watcher 打两份工(§11.2 事件源唯一):assetsRoot 下全扩展
      // 名,.py 走热更、非 py 走旁路,不重复开第二个 watcher
      attachWatcher(bypassPatternOf(assetsRoot, workspaceRoot), {
        onHot: pyOnly(scheduleHot),
        onBypass: emitToBypass
      });
    }
    status.setReady(plan.globs, source, settings.debounceMs);
    // HR-PR-05 磁盘面接线(HR-WATCH-003/004/015):按已声明根建 watcher,
    // change/create 经过滤规范化后以 'disk-change' 进同一流水线(与 save 重叠
    // 纯核归并);建后即 arm——apply 同步块内完成,真事件只能在后续宏任务到
    // 达,HR-WATCH-015 基线窗保证启动既有文件不被当变更。范围闸按本次计划
    // 落盘(显式=globs 匹配,派生=assetsRoot 前缀),与既有 watcher 面同界。
    // HR-WATCH-001 模式面:onDiskChange 显式选中才建(默认 onSave 只走既有
    // watcher 面);模式属 kbengine 段,配置变更即 apply 重建,切回即拆。
    if (options.diskWatch && settings.triggerMode === 'onDiskChange') {
      const folderRoots = (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath);
      diskDebounceMs = settings.debounceMs;
      diskScope = {
        mode: source === 'explicit' ? 'explicit' : 'derived',
        globs: [...plan.globs],
        assetsRoot: canonicalizeScriptFilePath(assetsRoot),
        roots: folderRoots.map(root => canonicalizeScriptFilePath(root))
      };
      diskWatch = new HotReloadDiskWatchController({
        offer: (file, diskSource) => {
          if (!diskOfferInScope(file)) {
            return; // 热更域外如实不进(显式收窄 globs 不被磁盘面放大)
          }
          options.onWatchedFileChange?.(file);
          pipeline?.offer(file, diskSource);
          // 合并窗重排与 scheduleHot 同序(先排进料、后排合并,同拍先定稿后合并)
          trigger.schedule(diskDebounceMs);
        },
        createWatcher: options.diskWatch.createWatcher,
        ...(options.diskWatch.onDiagnostic
          ? { onDiagnostic: options.diskWatch.onDiagnostic }
          : {}),
        // HR-WATCH-004 深层防御:watcher 模式管根界,过滤层再拦排除目录/备份名
        filterOptions: { roots: folderRoots.map(root => canonicalizeScriptFilePath(root)) }
      });
      diskWatch.watchRoots(folderRoots);
      diskWatch.arm();
    }
  };

  /** §11.4 签名判据(配置事件与工作区根变更共用):签名不变不重建 */
  const applyIfWatchSignatureChanged = (): void => {
    if (watchSignatureOf(readWatchInputs()) !== lastWatchSignature) {
      apply();
    }
  };

  const subscription = vscode.workspace.onDidChangeConfiguration(event => {
    // §11.4:kbengine 段(含 kbengine.assetsRoot)一律重建;派生输入(assetsRoot/
    // 工作区根)变了但事件不认 kbengine 段时,按计划签名补一次重建——重建判据
    // 不只看 enabled/globs。
    if (event.affectsConfiguration('kbengine')) {
      apply();
    } else {
      applyIfWatchSignatureChanged();
    }
  });

  /** RUST-385(HR-UI-012)工作区根变更面:workspaceFolders 增删不派发
   * onDidChangeConfiguration,§11.4 的签名兜底只在配置事件里才评估;这里
   * 自订 folder 变更走同一判据——多根会话加/删文件夹即时按新根重建
   * watcher/流水线。整工作区切换由宿主重启接管(deactivate 复合释放全清,
   * activate 重跑 apply,历史按各自工作区 workspaceState 各自回载)。 */
  const foldersSubscription = vscode.workspace.onDidChangeWorkspaceFolders(() => {
    applyIfWatchSignatureChanged();
  });
  context.subscriptions.push({
    dispose: (): void => {
      releasePreviewCommand.dispose();
      pauseCommand.dispose();
      resumeCommand.dispose();
      cancelCommand.dispose();
      showDiagnosticsCommand.dispose();
      diagnosticsPanel.dispose();
      subscription.dispose();
      foldersSubscription.dispose();
      unsubscribeBypass();
      bypassMerger.dispose();
      diskWatch?.dispose();
      diskWatch = undefined;
      diskScope = null;
      providerHost.dispose();
      pipeline?.dispose();
      pipeline = undefined;
      // RUST-002:常驻解释器随装配释放,不留孤儿进程
      // HR-WATCH-014 在途请求策略=自然完成(不建 abort 面):停用只清待提交队列
      // 并停受理,已发出的 transport 请求不打断——回执照常落台账(UI 数据面),
      // 旧代回执由代际结算(hotReloadChannelSend)挡住不冒当前。
      execCompile?.dispose();
      execCompile = undefined;
      trigger.dispose();
      pendingOut.clear();
      for (const handle of settleHandles) {
        timers.clear(handle);
      }
      settleHandles.clear();
      disposeWatchers();
      status.dispose();
    }
  });
  apply();
  // 首激活一次性非模态提示(用户令 2026-11-06):默认开 + 保存即自动发请求,
  // 用户该知道发到哪、怎么一键关;弹出即记 flag(可永久关闭),不挡编辑器。
  // 极简装配上下文(无 workspaceState)不弹——没有地方记 flag,不能每次激活都扰。
  const noticeState: typeof context.workspaceState | undefined = context.workspaceState;
  if (noticeState !== undefined && readHotReloadSettings(hotReloadSectionReader()).enabled) {
    void showHotReloadFirstRunNotice({
      isShown: () => noticeState.get<boolean>(HOT_RELOAD_NOTICE_KEY) === true,
      markShown: () => noticeState.update(HOT_RELOAD_NOTICE_KEY, true),
      show: async (message, ...items) => {
        const choice = await vscode.window.showInformationMessage(message, ...items);
        if (choice === '打开日志') {
          status.showLogWithVersions();
        }
        return choice;
      },
      // 「立即关闭」写回失败必须如实上报(不静默吞):状态栏日志 + 错误提示
      turnOff: () =>
        writeHotReloadEnabled(false).catch((error: unknown) => {
          const detail = error instanceof Error ? error.message : String(error);
          status.log(`首激活提示「立即关闭」写回配置失败: ${detail}`);
          void Promise.resolve(vscode.window.showErrorMessage(`热更开关写回配置失败: ${detail}`)).catch(
            () => undefined
          );
        })
    }).catch(() => undefined);
  }
}
