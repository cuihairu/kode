/**
 * Temporary-edit hot reload quick action (book docs/kode2/KODE_2_COMPLETE_TODO.md §19,
 * the temporary-edit leg carried by HR-PR-02): temp edit first → optional auto
 * restore → reloadScript → echo the result.
 * - temp edit = appending one line of comment marker at the tail of the original
 *   content (leaving the original semantics untouched; a Python comment is safe);
 * - auto restore is on by default, and a failed restore aborts reloadScript (never
 *   sending the marked half-product to the engine);
 * - reloadScript does not stand up a second HTTP mechanism: it triggers the
 *   existing quick action channel by name (both the HTTP and terminal legs go
 *   through QuickActionManager.runByName);
 * - the result echo goes through the output channel (stream) + the problems
 *   channel (a failure sets diagnostics, success clears them);
 * - the iron rule of success semantics: a usable transport receipt is not the
 *   engine having applied it. Without a trusted receipt, always report honestly
 *   "sent (unconfirmed)"; the applied literal type of the outcome is always
 *   false, so claiming "hot reloaded" is impossible even at compile time
 *   (book §19.1 HTTP success classification).
 * The pure logic (dual-name resolution / settings read / temp edit content) is
 * kept apart from the execution orchestration; tests drive it with fake legs.
 */

import type { ConfigReader } from '../hotReload';

/** Temp edit marker prefix: the appended line is `# kode-temp-reload <ISO timestamp>` */
export const TEMP_EDIT_MARKER_TAG = 'kode-temp-reload';

/** Dual-name model (book §19.1): UI/echo uses fullModule, request detail uses requestModule */
export interface ModuleDualName {
  /** All directory segments relative to the script asset root + the file stem: entities.fight.FightAI */
  readonly fullModule: string;
  /** The immediate parent dir name + the file stem: fight.FightAI */
  readonly requestModule: string;
  /** The file name with its trailing .py stripped: FightAI (.pyi/.pyc never match spuriously, anchored by $) */
  readonly fileStem: string;
  /** The immediate parent dir name: fight */
  readonly parentName: string;
}

/** Dual-name resolution result: a failure yields an explicit unsupported reason; the name is never guessed */
export type ModuleDualNameResult =
  | ModuleDualName
  | { readonly unsupported: string; readonly reason: ModuleDualNameUnsupportedReason };

/**
 * Machine-readable classification of unsupported (HR-MOD-002 diagnostic codes;
 * the only implementation is this function's return value, so the upper
 * ModuleResolver face emits diagnostics by code instead of each writing its own
 * string interpretation):
 * - no-root: script asset root not configured / not-python: not a .py / out-of-root: a file outside the root
 * - traversal: an empty segment or `..` traversal / empty-stem: an empty stem
 * - init-file: the `__init__.py` special file (skipped before verification, HR-MOD-007)
 * - root-level: a single-level script right under the root (unresolved by default, HR-MOD-008)
 */
export type ModuleDualNameUnsupportedReason =
  | 'no-root'
  | 'not-python'
  | 'out-of-root'
  | 'traversal'
  | 'empty-stem'
  | 'init-file'
  | 'root-level';

/** Dual-name resolution options (HR-MOD-008: an explicit single-level fallback setting) */
export interface ModuleDualNameOptions {
  /**
   * A single-level script under the root (`scripts/Foo.py`) is judged
   * unresolved by default; when this switch is explicitly on, it falls back to
   * the bare stem fullModule=requestModule=Foo (a file right under the engine
   * process root is literally the bare name in sys.modules). Off by default =
   * the book §19.1 "mark unresolved by default" convention.
   */
  readonly allowRootLevelStem?: boolean;
}

const toPosix = (value: string): string => value.replace(/\\/g, '/');

const trimSlashes = (value: string): string => value.replace(/\/+$/, '');

const splitSegments = (value: string): string[] => toPosix(value).split('/');

/**
 * Pure dual-name resolution (book §19.1 rules + the four examples; the
 * HR-MOD-002 pure-function convention, no IO):
 * - the file must end with .py (only the trailing suffix is stripped; .pyi/.pyc
 *   never match spuriously);
 * - the file must sit strictly inside the script asset root; any `..` path
 *   traversal is refused outright;
 * - `__init__.py` is judged unsupported (HR-MOD-007: skipped before real service
 *   verification);
 * - a single-level script under the root is judged unsupported (HR-MOD-008:
 *   unresolved by default, requiring an explicit fallback);
 * - requestModule = immediate parent dir + '.' + file stem; fullModule = all
 *   directory segments + stem.
 */
/**
 * KBEngine process role directory names (scripts/{base,cell,client,bots}). These
 * are **process load roots** (baseapp loads scripts/base, cellapp loads
 * scripts/cell; KB-API-007: the script face of bots is the client face), not
 * Python module segments — the engine process's sys.modules holds no such
 * prefixes. Even a directory carrying __init__.py must not count as a module
 * segment: a module_name prefixed with base./cell. is unrecognized by the
 * server, so the request is accepted yet no module is ever reloaded (the 2026-11-12
 * user report: the direct cause of hot reload "sent but not taking effect").
 * Module name derivation strips segments uniformly against this set.
 */
export const PYTHON_PROCESS_ROLE_DIRS: ReadonlySet<string> =
  new Set(['base', 'cell', 'client', 'bots']);

export function resolveModuleDualName(
  filePath: string,
  scriptRoot: string,
  options: ModuleDualNameOptions = {}
): ModuleDualNameResult {
  const root = trimSlashes(toPosix(scriptRoot));
  const file = toPosix(filePath);
  if (root.length === 0) {
    return { unsupported: '未配置脚本资源根(kbengine.hotReload.tempEdit.scriptRoot)', reason: 'no-root' };
  }
  if (!file.toLowerCase().endsWith('.py')) {
    return { unsupported: `非 .py 文件不可热更: ${file}`, reason: 'not-python' };
  }
  // Strict prefix + whole boundary segment: prevents /ws/scripts2 from masquerading as containment of /ws/scripts
  if (file !== root && !file.startsWith(`${root}/`)) {
    return { unsupported: `文件不在脚本资源根内: ${file} ∉ ${root}`, reason: 'out-of-root' };
  }
  const segments = splitSegments(file.slice(root.length === 0 ? 0 : root.length + 1));
  if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) {
    return { unsupported: `路径含空段或穿越段,拒绝解析: ${file}`, reason: 'traversal' };
  }
  const stem = segments[segments.length - 1].replace(/\.py$/i, '');
  if (stem.length === 0) {
    return { unsupported: `文件短名为空: ${file}`, reason: 'empty-stem' };
  }
  if (stem === '__init__') {
    return { unsupported: '__init__.py 特殊文件(HR-MOD-007:真实服务验证前跳过)', reason: 'init-file' };
  }
  const directories = segments.slice(0, -1);
  if (directories.length === 0) {
    if (options.allowRootLevelStem === true) {
      // HR-MOD-008 explicit fallback: a file right under the process root is loaded by the engine under its bare stem
      return { fullModule: stem, requestModule: stem, fileStem: stem, parentName: '' };
    }
    return {
      unsupported: `脚本根下单层脚本(HR-MOD-008:需显式 single-level fallback): ${file}`,
      reason: 'root-level'
    };
  }
  const parentName = directories[directories.length - 1];
  // Process role directories (base/cell/client/bots) are the engine's process load roots, not
  // Python module segments — the engine's sys.modules holds no such prefixes (baseapp loads scripts/base
  // as its process directory). Even a directory carrying __init__.py is not taken as a segment: a
  // module_name carrying the prefix is unrecognized by the server, and the request is accepted
  // yet no module is ever reloaded.
  const moduleDirs = directories.filter(segment => !PYTHON_PROCESS_ROLE_DIRS.has(segment.toLowerCase()));
  const lastModuleDir = moduleDirs.length > 0 ? moduleDirs[moduleDirs.length - 1] : '';
  return {
    fullModule: [...moduleDirs, stem].join('.'),
    requestModule: lastModuleDir.length > 0 ? `${lastModuleDir}.${stem}` : stem,
    fileStem: stem,
    parentName
  };
}

/** Temporary-edit hot reload settings (the kbengine.hotReload.tempEdit section) */
export interface TempEditReloadSettings {
  /** Master switch, off by default (the same convention as kbengine.hotReload.enabled, guarding against accidental triggers) */
  readonly enabled: boolean;
  /** The quick action name that reloadScript triggers by name (leaving it empty is a configuration error and aborts) */
  readonly actionName: string;
  /** Whether to auto restore the original content before reloadScript sends (on by default) */
  readonly autoRestore: boolean;
  /** Script asset root (the starting point of dual-name resolution; empty means the echoed module name is unresolved) */
  readonly scriptRoot: string;
}

export const TEMP_EDIT_DEFAULTS: Readonly<TempEditReloadSettings> = Object.freeze({
  enabled: false,
  actionName: '',
  autoRestore: true,
  scriptRoot: ''
});

/** Tolerant read: a mismatched type falls back to the default, so a broken configuration never drags execution down (the same convention as hotReload) */
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

/** Derives a tempEdit subsection reader from the raw values of the kbengine.hotReload section (flat keys inside the section) */
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
 * Temporary edit content: appends one line of comment marker at the tail of the
 * original content (the timestamp is injected by the caller, since this pure
 * function never reads the clock). A Python comment line leaves the original
 * semantics untouched; if the original content lacks a trailing newline it is
 * padded first, then the marker is appended.
 */
export function applyTempEdit(original: string, stamp: string): string {
  const separator = original.length > 0 && !original.endsWith('\n') ? '\n' : '';
  return `${original}${separator}# ${TEMP_EDIT_MARKER_TAG} ${stamp}\n`;
}

/** Execution subject (the minimal projection of the active editor document) */
export interface TempEditReloadDoc {
  readonly fsPath: string;
  /** Display name used for echoing (usually the file name) */
  readonly label: string;
}

/** Injected execution channels: file read/write / reload channel / output and problems echo / clock */
export interface TempEditReloadDeps {
  readFile: (doc: TempEditReloadDoc) => Promise<string>;
  writeFile: (doc: TempEditReloadDoc, content: string) => Promise<void>;
  /** The reloadScript channel: triggers the existing quick action by name (reusing the HTTP/terminal legs) */
  runReloadAction: (actionName: string) => Promise<boolean>;
  /** Output channel echo (one line each) */
  log: (line: string) => void;
  /** Problems channel echo: null = clear this file's diagnostics */
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
  /** Transport layer only: the reload channel receipt was usable (not a claim that the engine applied it) */
  readonly transportOk: boolean;
  /** Always false: there is no trusted applied receipt (book §19.1, accepted≠applied) */
  readonly applied: false;
  /** A one-sentence result (the same source for echo and popup) */
  readonly detail: string;
  /** Dual-name resolution result (best-effort; unsupported when no root is configured) */
  readonly dualName: ModuleDualNameResult;
}

/** The uniformly phrased failure receipt at the end: sets the problems diagnostics + the stream line + the outcome */
const failedOutcome = (
  phase: TempEditReloadPhase,
  detail: string,
  dualName: ModuleDualNameResult
): TempEditReloadOutcome => ({ phase, transportOk: false, applied: false, detail, dualName });

/**
 * Execution orchestration (the order prescribed by book HR-PR-02): temp edit →
 * optional auto restore → reloadScript → echo the result. A failed restore
 * aborts the request; the reload channel receipt only decides transportOk and
 * never claims applied.
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

  // Step 1: the temporary edit
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

  // Step 2: the optional auto restore (restore before requesting; a failed restore never sends the marked content to the engine)
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

  // Step 3: reloadScript (reusing the existing quick action channel, the HTTP/terminal legs)
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

  // Step 4: echoing the result — it only honestly reports "sent (unconfirmed)" and never displays "hot reloaded"
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
