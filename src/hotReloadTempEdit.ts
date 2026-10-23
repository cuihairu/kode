/**
 * 临时编辑热重载 quick action(书 docs/kode2/KODE_2_COMPLETE_TODO.md §19,
 * HR-PR-02 附带的临时编辑腿):先临时编辑 → 可选自动还原 → reloadScript →
 * 结果回显。
 * - 临时编辑 = 在原内容尾部追加一行注释性标记(不动原语义,Python 注释安全);
 * - 自动还原默认开,还原失败即中止 reloadScript(不把带标记的半成品发给引擎);
 * - reloadScript 不另起第二套 HTTP:按名触发既有 quick action 通道
 *   (HTTP 与终端两条腿都从 QuickActionManager.runByName 走);
 * - 结果回显走输出通道(流水)+ 问题通道(失败置诊断,成功清除);
 * - 成功语义铁律:传输通道回执可用 ≠ 引擎已应用。无可信回执一律如实报
 *   「已发送(未确认)」,outcome 的 applied 字面量类型恒为 false,
 *   编译期就不可能谎报「已热更新」(书 §19.1 HTTP 成功分类)。
 * 纯逻辑(双名称解析/设置读取/临时编辑内容)与执行编排分家,测试用假腿驱动。
 */

import type { ConfigReader } from './hotReload';

/** 临时编辑标记前缀:追加行为 `# kode-temp-reload <ISO 时间戳>` */
export const TEMP_EDIT_MARKER_TAG = 'kode-temp-reload';

/** 双名称模型(书 §19.1):UI/回显用 fullModule,请求详情用 requestModule */
export interface ModuleDualName {
  /** 脚本资源根相对的全部目录段 + 文件短名:entities.fight.FightAI */
  readonly fullModule: string;
  /** 直接父目录名 + 文件短名:fight.FightAI */
  readonly requestModule: string;
  /** 文件名去结尾 .py:FightAI(.pyi/.pyc 不假匹配,$ 锚点) */
  readonly fileStem: string;
  /** 直接父目录名:fight */
  readonly parentName: string;
}

/** 双名称解析结果:解析失败给 explicit unsupported 原因,不擅自猜名 */
export type ModuleDualNameResult = ModuleDualName | { readonly unsupported: string };

const toPosix = (value: string): string => value.replace(/\\/g, '/');

const trimSlashes = (value: string): string => value.replace(/\/+$/, '');

const splitSegments = (value: string): string[] => toPosix(value).split('/');

/**
 * 双名称纯解析(书 §19.1 规则 + 四个示例;HR-MOD-002 纯函数口径,无 IO):
 * - 文件必须以 .py 结尾(仅去结尾后缀,.pyi/.pyc 不假匹配);
 * - 文件必须严格落在脚本资源根内,含 `..` 路径穿越一律拒绝;
 * - `__init__.py` 判 unsupported(HR-MOD-007:真实服务验证前跳过);
 * - 根下单层脚本判 unsupported(HR-MOD-008:默认未解析,需显式 fallback);
 * - requestModule = 直接父目录 + '.' + 文件短名;fullModule = 全部目录段 + 短名。
 */
export function resolveModuleDualName(filePath: string, scriptRoot: string): ModuleDualNameResult {
  const root = trimSlashes(toPosix(scriptRoot));
  const file = toPosix(filePath);
  if (root.length === 0) {
    return { unsupported: '未配置脚本资源根(kbengine.hotReload.tempEdit.scriptRoot)' };
  }
  if (!file.toLowerCase().endsWith('.py')) {
    return { unsupported: `非 .py 文件不可热更: ${file}` };
  }
  // 严格前缀 + 边界整段:防止 /ws/scripts2 顶替 /ws/scripts 的假包含
  if (file !== root && !file.startsWith(`${root}/`)) {
    return { unsupported: `文件不在脚本资源根内: ${file} ∉ ${root}` };
  }
  const segments = splitSegments(file.slice(root.length === 0 ? 0 : root.length + 1));
  if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) {
    return { unsupported: `路径含空段或穿越段,拒绝解析: ${file}` };
  }
  const stem = segments[segments.length - 1].replace(/\.py$/i, '');
  if (stem.length === 0) {
    return { unsupported: `文件短名为空: ${file}` };
  }
  if (stem === '__init__') {
    return { unsupported: '__init__.py 特殊文件(HR-MOD-007:真实服务验证前跳过)' };
  }
  const directories = segments.slice(0, -1);
  if (directories.length === 0) {
    return { unsupported: `脚本根下单层脚本(HR-MOD-008:需显式 single-level fallback): ${file}` };
  }
  const parentName = directories[directories.length - 1];
  return {
    fullModule: [...directories, stem].join('.'),
    requestModule: `${parentName}.${stem}`,
    fileStem: stem,
    parentName
  };
}

/** 临时编辑热重载设置(kbengine.hotReload.tempEdit 段) */
export interface TempEditReloadSettings {
  /** 总开关,默认关(与 kbengine.hotReload.enabled 同口径防误触) */
  readonly enabled: boolean;
  /** reloadScript 按名触发的 quick action 名(留空视为配置错误,中止) */
  readonly actionName: string;
  /** reloadScript 发送前是否自动还原原始内容(默认开) */
  readonly autoRestore: boolean;
  /** 脚本资源根(双名称解析起点;留空则回显模块名未解析) */
  readonly scriptRoot: string;
}

export const TEMP_EDIT_DEFAULTS: Readonly<TempEditReloadSettings> = Object.freeze({
  enabled: false,
  actionName: '',
  autoRestore: true,
  scriptRoot: ''
});

/** 容忍式读取:类型不符回落默认,配置写坏不拖垮执行(与 hotReload 同口径) */
export function readTempEditReloadSettings(reader: ConfigReader): TempEditReloadSettings {
  const enabled = reader.get<boolean>('enabled', TEMP_EDIT_DEFAULTS.enabled);
  const actionName = reader.get<string>('actionName', TEMP_EDIT_DEFAULTS.actionName);
  const autoRestore = reader.get<boolean>('autoRestore', TEMP_EDIT_DEFAULTS.autoRestore);
  const scriptRoot = reader.get<string>('scriptRoot', TEMP_EDIT_DEFAULTS.scriptRoot);
  return {
    enabled: typeof enabled === 'boolean' ? enabled : TEMP_EDIT_DEFAULTS.enabled,
    actionName: typeof actionName === 'string' ? actionName : TEMP_EDIT_DEFAULTS.actionName,
    autoRestore: typeof autoRestore === 'boolean' ? autoRestore : TEMP_EDIT_DEFAULTS.autoRestore,
    scriptRoot: typeof scriptRoot === 'string' ? scriptRoot : TEMP_EDIT_DEFAULTS.scriptRoot
  };
}

/** 从 kbengine.hotReload 段原始值解出 tempEdit 子段读取器(段内扁平键) */
export const tempEditSectionReader = (hotReloadSection: unknown): ConfigReader => ({
  get: <T>(key: string, defaultValue: T): T => {
    const section = hotReloadSection as Record<string, unknown> | undefined;
    const value = section === undefined || section === null ? undefined : section.tempEdit;
    const flat = value as Record<string, unknown> | undefined;
    const hit = flat === undefined || flat === null ? undefined : flat[key];
    return (hit === undefined ? defaultValue : hit) as T;
  }
});

/**
 * 临时编辑内容:原内容尾部追加一行注释标记(时间戳由调用方注入,纯函数
 * 不取钟)。Python 注释行不动原语义;原内容缺尾换行先补齐再追加。
 */
export function applyTempEdit(original: string, stamp: string): string {
  const separator = original.length > 0 && !original.endsWith('\n') ? '\n' : '';
  return `${original}${separator}# ${TEMP_EDIT_MARKER_TAG} ${stamp}\n`;
}

/** 执行对象(活动编辑器文档的最小投影) */
export interface TempEditReloadDoc {
  readonly fsPath: string;
  /** 回显用展示名(通常文件名) */
  readonly label: string;
}

/** 执行通道注入:读写文件 / reload 通道 / 输出与问题回显 / 时钟 */
export interface TempEditReloadDeps {
  readFile: (doc: TempEditReloadDoc) => Promise<string>;
  writeFile: (doc: TempEditReloadDoc, content: string) => Promise<void>;
  /** reloadScript 通道:按名触发既有 quick action(HTTP/终端两条腿复用) */
  runReloadAction: (actionName: string) => Promise<boolean>;
  /** 输出通道回显(每行一条) */
  log: (line: string) => void;
  /** 问题通道回显:null = 清除该文件的诊断 */
  reportProblem: (doc: TempEditReloadDoc, message: string | null) => void;
  now?: () => Date;
}

export type TempEditReloadPhase =
  | 'sent-unverified'
  | 'sent-failed'
  | 'missing-action'
  | 'read-failed'
  | 'edit-write-failed'
  | 'restore-failed';

export interface TempEditReloadOutcome {
  readonly phase: TempEditReloadPhase;
  /** 仅传输层:reload 通道回执可用(不代表引擎已应用) */
  readonly transportOk: boolean;
  /** 恒为 false:无可信 applied 回执(书 §19.1,accepted≠applied) */
  readonly applied: false;
  /** 结果一句话(回显/弹窗同源) */
  readonly detail: string;
  /** 双名称解析结果(best-effort;未配置根时为 unsupported) */
  readonly dualName: ModuleDualNameResult;
}

/** 结束口径统一的失败回执:置问题诊断 + 流水 + outcome */
const failedOutcome = (
  phase: TempEditReloadPhase,
  detail: string,
  dualName: ModuleDualNameResult
): TempEditReloadOutcome => ({ phase, transportOk: false, applied: false, detail, dualName });

/**
 * 执行编排(书 HR-PR-02 指定顺序):临时编辑 → 可选自动还原 → reloadScript
 * → 结果回显。还原失败即中止请求;reload 通道回执只决定 transportOk,
 * 一律不宣称 applied。
 */
export async function runTempEditReload(
  doc: TempEditReloadDoc,
  settings: TempEditReloadSettings,
  deps: TempEditReloadDeps
): Promise<TempEditReloadOutcome> {
  const dualName = resolveModuleDualName(doc.fsPath, settings.scriptRoot);
  const dualEcho = 'unsupported' in dualName ? `未解析(${dualName.unsupported})` : `fullModule=${dualName.fullModule} · requestModule=${dualName.requestModule}`;

  if (settings.actionName.length === 0) {
    const detail = '未配置 kbengine.hotReload.tempEdit.actionName,中止(不编辑不发请求)';
    deps.log(`✗ 临时编辑热重载[${doc.label}] ${detail}`);
    deps.reportProblem(doc, detail);
    return failedOutcome('missing-action', detail, dualName);
  }

  // 第 1 步:临时编辑
  deps.log(`▶ 临时编辑热重载[${doc.label}] 第 1 步:写入临时编辑 · ${dualEcho}`);
  let original: string;
  try {
    original = await deps.readFile(doc);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const detail = `读取原文件失败: ${message}`;
    deps.log(`✗ 临时编辑热重载[${doc.label}] ${detail}`);
    deps.reportProblem(doc, detail);
    return failedOutcome('read-failed', detail, dualName);
  }
  const stamp = (deps.now ?? (() => new Date()))().toISOString();
  try {
    await deps.writeFile(doc, applyTempEdit(original, stamp));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const detail = `写入临时编辑失败: ${message}`;
    deps.log(`✗ 临时编辑热重载[${doc.label}] ${detail}`);
    deps.reportProblem(doc, detail);
    return failedOutcome('edit-write-failed', detail, dualName);
  }
  deps.log(`✓ 临时编辑热重载[${doc.label}] 临时编辑已写入(${TEMP_EDIT_MARKER_TAG} ${stamp})`);

  // 第 2 步:可选自动还原(先还原后请求;还原失败不把带标记内容发给引擎)
  if (settings.autoRestore) {
    deps.log(`↩ 临时编辑热重载[${doc.label}] 第 2 步:自动还原原始内容`);
    try {
      await deps.writeFile(doc, original);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const detail = `还原原始内容失败,已中止 reloadScript;文件停留在临时编辑态,请手工恢复(${message})`;
      deps.log(`✗ 临时编辑热重载[${doc.label}] ${detail}`);
      deps.reportProblem(doc, detail);
      return failedOutcome('restore-failed', detail, dualName);
    }
    deps.log(`✓ 临时编辑热重载[${doc.label}] 原始内容已还原`);
  } else {
    deps.log(`↹ 临时编辑热重载[${doc.label}] 第 2 步跳过:autoRestore=false,临时编辑保留在盘上`);
  }

  // 第 3 步:reloadScript(复用既有 quick action 通道,HTTP/终端两条腿)
  deps.log(
    `▶ 临时编辑热重载[${doc.label}] 第 3 步 reloadScript:quick action「${settings.actionName}」(HTTP/终端通道复用)`
  );
  let echoed: boolean;
  try {
    echoed = await deps.runReloadAction(settings.actionName);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const detail = `reloadScript 通道异常: ${message}`;
    deps.log(`✗ 临时编辑热重载[${doc.label}] ${detail}`);
    deps.reportProblem(doc, detail);
    return failedOutcome('sent-failed', detail, dualName);
  }
  if (!echoed) {
    const detail = `reloadScript 通道未确认执行(quick action「${settings.actionName}」回执 false)`;
    deps.log(`✗ 临时编辑热重载[${doc.label}] ${detail}`);
    deps.reportProblem(doc, detail);
    return failedOutcome('sent-failed', detail, dualName);
  }

  // 第 4 步:结果回显——只如实报「已发送(未确认)」,不显示「已热更新」
  deps.log(
    `● 临时编辑热重载[${doc.label}] 结果:请求已发送(未确认)。传输通道回执可用,但无引擎 applied 确认(accepted≠applied),不显示「已热更新」。`
  );
  deps.reportProblem(doc, null);
  return {
    phase: 'sent-unverified',
    transportOk: true,
    applied: false,
    detail: '已发送(未确认):传输回执可用,引擎是否 applied 未知',
    dualName
  };
}
