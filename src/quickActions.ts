/**
 * 快速执行动作装配层(设计 1.9/1.10):
 * - 动作清单 quick pick(标签/类型/目标三列)与三后端分发(command/script/http);
 * - 默认执行器是真实现(集成终端 / node http),注入点只给测试与将来换实现;
 * - 破坏性动作默认弹 modal 确认;前台脚本跑隐藏可复用终端(不抢焦点,失败一次性弹窗),
 * - 首装扫一层 .bat/.ps1(词表只定分类不过滤),用户勾选确认后才写回 .kbengine/debug.json。
 *
 * 安全边界(用户 2026-10-15 追加):script/http 只执行配置里显式声明的目标,
 * 执行期不拼接任何运行时参数——白名单来自配置本身,不是运行时字符串判断。
 * 变量替换只作用在配置字面串上,未知变量直接报错中止(1.5 拒绝静默空串)。
 */

import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import {
  baseNameOf,
  buildScannedActions,
  parseQuickActionConfigs,
  parseHttpRequestConfigs,
  resolveActionVariables,
  DEFAULT_VENV_DIRECTORY_NAMES,
  normalizeVenvDirectoryNames
} from './quickActionConfig';
import type {
  QuickAction,
  HttpRequestConfig,
  QuickActionCategory,
  WorkspaceFolderRef
} from './quickActionConfig';
import type { HttpRequestEntry } from './httpRequests';
import { scanBatchScriptsInRoots } from './quickActionScanner';
import { LogHubLike } from './logHub';
import { ProcessManager, type ManagedProcess } from './processManager';
import { parseDebugConfigText } from './debugConfigBootstrap';
import type { BatchScriptCandidate, DirectoryEntry } from './quickActionScanner';

export const QUICK_ACTION_SCAN_DISMISS_KEY = 'kbengine.quickActions.scanDismissed';
/** Explorer ▶ 主按钮的默认目标:上次实际执行的动作名(选中即记忆) */
export const QUICK_ACTION_LAST_RUN_KEY = 'kbengine.quickActions.lastRun';
export const QUICK_ACTION_CONFIRM_LABEL = '执行';
/** 本地热更新不该更久(设计 1.6);与 HTTP 快捷请求同量级 */
export const QUICK_ACTION_TIMEOUT_MS = 10000;
/** HTTP 回包的截顶长度(字符),超出丢弃——热更回包本就很小,
 *  而本地服务失控时不该让扩展宿主无限攒内存 */
export const RESPONSE_PREVIEW_LIMIT = 4000;

const CATEGORY_LABELS: Record<QuickActionCategory, string> = {
  server: '启停服务器',
  export: '导配置表'
};

/** 扫描确认清单项:label=bat 名,value=候选(与 buildScannedActions 同源) */
interface ScanPickItem extends vscode.QuickPickItem {
  value: BatchScriptCandidate;
}

export interface ScriptRunOptions {
  name?: string;
  script: string;
  background: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ScriptRunResult {
  /** true when submitted to an interactive terminal; terminal exit status is unavailable */
  submitted?: boolean;
  /** 后台启动与被信号终止时为 null(拿不到退出码) */
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface HttpRunOptions {
  url: string;
  method: string;
  body?: string;
}

export interface HttpRunResult {
  status: number;
  body: string;
}

export type ScriptRunner = (options: ScriptRunOptions) => Promise<ScriptRunResult>;
export type HttpRunner = (options: HttpRunOptions) => Promise<HttpRunResult>;
export type CommandRunner = (command: string, args: string[]) => Promise<unknown> | Thenable<unknown>;

export interface QuickActionManagerDeps {
  runScript?: ScriptRunner;
  runHttp?: HttpRunner;
  executeCommand?: CommandRunner;
  /** Shared HTTP service entry point used by both views and command picks. */
  runHttpEntry?: (
    entry: HttpRequestEntry,
    execute?: () => Promise<void>,
    onHttpResponse?: (response: HttpActionResponse) => void
  ) => Promise<boolean>;
  getSettingHttpEntries?: () => HttpRequestEntry[];
}

/** 真实 HTTP 动作的响应面(IDE-REV-022):HTTP 状态 + 回包 body 交给观察者 */
export interface HttpActionResponse {
  status: number;
  body: string;
}

/** 无人值守通道(自动热重载等)的执行选项 */
export interface QuickActionRunOptions {
  /** 跳过执行确认框(自动热重载等无人值守通道传 true) */
  readonly suppressConfirm?: boolean;
  /** 不记入「上次执行」记忆(默认仍记,Explorer ▶ 跟着最近一次执行走) */
  readonly skipLastRun?: boolean;
  /** HTTP 响应到达即回调(回执解析面);脚本/命令动作无此回调 */
  readonly onHttpResponse?: (response: HttpActionResponse) => void;
}

/** 工作区根清单;无工作区(只开了单文件)返回空数组,变量解析由调用方报错 */
function workspaceFolders(): readonly WorkspaceFolderRef[] {
  return vscode.workspace.workspaceFolders?.map(folder => ({
    fsPath: folder.uri.fsPath,
    name: folder.name
  })) ?? [];
}

/** Hidden interactive terminal channel. A terminal is created only when needed and never auto-shown. */
const actionTerminals = new Map<string, vscode.Terminal>();

let defaultProcessManager = new ProcessManager(undefined, undefined);
let defaultLogHub: LogHubLike | undefined;

export function setDefaultScriptRuntime(processManager: ProcessManager, logHub?: LogHubLike): void {
  defaultProcessManager = processManager;
  defaultLogHub = logHub;
}

const shellFor = (script: string, platform: NodeJS.Platform = process.platform): string =>
  platform === 'win32' ? 'cmd.exe' : '/bin/sh';

const shellArgsFor = (script: string, platform: NodeJS.Platform = process.platform): string[] =>
  platform === 'win32' ? ['/d', '/s', '/c', script] : ['-c', script];

/** Non-interactive scripts run in ProcessManager; foreground scripts remain in reusable hidden terminals. */
export const terminalScript: ScriptRunner = options => {
  const cwd = options.cwd ?? workspaceFolders()[0]?.fsPath;
  if (options.background) {
    let managed: ManagedProcess;
    try {
      managed = defaultProcessManager.start({
        id: `quick-action:${options.name ?? options.script}`,
        command: shellFor(options.script),
        args: shellArgsFor(options.script),
        cwd,
        env: options.env,
        component: options.name ?? 'quick-action'
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      defaultLogHub?.error({ source: 'process', component: options.name ?? 'quick-action', text: message });
      return Promise.resolve({ code: null, stdout: '', stderr: message, submitted: false });
    }
    void managed;
    return Promise.resolve({ code: null, stdout: '', stderr: '', submitted: true });
  }

  const scriptToken = options.script.trim().match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/);
  const scriptName = baseNameOf(scriptToken?.[1] ?? scriptToken?.[2] ?? scriptToken?.[3] ?? options.script);
  const name = `Kode: ${options.name ?? '快速动作'} · ${scriptName}`;
  let terminal = actionTerminals.get(name);
  if (!terminal || terminal.exitStatus !== undefined) {
    terminal = vscode.window.createTerminal({
      name,
      hideFromUser: true,
      ...(cwd ? { cwd } : {}),
      ...(options.env ? { env: options.env } : {})
    });
    actionTerminals.set(name, terminal);
  }
  const announcement = `即将执行：${options.script}`;
  const printCommand = process.platform === 'win32'
    ? `echo ${announcement.replace(/[&|<>^]/g, '^$&')}`
    : `printf '%s\\n' '${announcement.replace(/\\/g, '\\\\').replace(/'/g, "'\\''")}'`;
  terminal.sendText(printCommand, true);
  terminal.sendText(options.script, true);
  return Promise.resolve({ code: null, stdout: '', stderr: '', submitted: true });
};

/** 将 curl 命令送入集成终端；Windows 使用系统自带 curl.exe，避免 PowerShell curl 别名。 */
export function buildCurlCommand(request: HttpRequestConfig, platform: NodeJS.Platform = process.platform): string {
  const quote = platform === 'win32'
    ? (value: string) => `'${value.replace(/'/g, "''")}'`
    : (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  const args = ['--silent', '--show-error', '--write-out', quote('\\nHTTP_STATUS:%{http_code}\\n'), '--request', quote(request.method)];
  for (const [name, value] of Object.entries(request.headers ?? {})) args.push('--header', quote(`${name}: ${value}`));
  if (request.body !== undefined) args.push('--data-binary', quote(request.body));
  args.push(quote(request.url));
  return `${platform === 'win32' ? 'curl.exe' : 'curl'} ${args.join(' ')}`;
}

export const terminalHttp: (request: HttpRequestConfig) => Promise<void> = request =>
  fetchHttp({
    url: request.url,
    method: request.method,
    ...(request.body !== undefined ? { body: request.body } : {})
  }).then(result => {
    const level = result.status >= 200 && result.status < 300 ? 'info' : 'error';
    void defaultLogHub?.[level]({
      source: 'process',
      component: `http:${request.name ?? request.url}`,
      text: `${request.method} ${request.url} → ${result.status}\n${result.body}`
    });
  });

/**
 * 默认 http 执行器:非 2xx 照实回状态码,由流水层判成败(不抛)。
 * timeoutMs 是给测试留的缝——本地热更默认 10 秒,用例不该真等 10 秒。
 */
export const fetchHttp = (
  options: HttpRunOptions,
  timeoutMs: number = QUICK_ACTION_TIMEOUT_MS
): Promise<HttpRunResult> =>
  new Promise<HttpRunResult>((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(options.url);
    } catch {
      reject(new Error(`URL 无法解析: ${options.url}`));
      return;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      reject(new Error(`不支持的协议: ${parsed.protocol}`));
      return;
    }
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.request(parsed, { method: options.method }, res => {
      const chunks: Buffer[] = [];
      let received = 0;
      res.on('data', (chunk: Buffer) => {
        // 接收窗口封顶:窗口内有多少收多少,窗口满后整段丢弃
        const room = RESPONSE_PREVIEW_LIMIT - received;
        if (room > 0) {
          chunks.push(room < chunk.length ? chunk.subarray(0, room) : chunk);
        }
        received += chunk.length;
      });
      res.on('end', () =>
        resolve({ status: res.statusCode as number, body: Buffer.concat(chunks).toString('utf8') })
      );
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`请求超时(${timeoutMs}ms)`));
    });
    req.on('error', (error: Error) => reject(error));
    if (options.body !== undefined && options.body.length > 0) {
      req.write(options.body);
    }
    req.end();
  });

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** quick pick 与确认框的目标描述:命令带参数,脚本/请求给原始目标 */
function describeActionTarget(action: QuickAction): string {
  if (action.type === 'command') {
    return action.args.length > 0 ? `${action.command} ${action.args.join(' ')}` : action.command;
  }
  if (action.type === 'script') {
    return action.script;
  }
  return action.url;
}

/** 执行期变量替换(1.5):只碰配置字面串,解析不了就抛,绝不静默空串 */
function resolveAction(action: QuickAction, folders: readonly WorkspaceFolderRef[]): QuickAction {
  if (action.type === 'command') {
    return { ...action, args: action.args.map(arg => resolveActionVariables(arg, folders)) };
  }
  if (action.type === 'script') {
    return {
      ...action,
      script: resolveActionVariables(action.script, folders),
      cwd: action.cwd === undefined ? undefined : resolveActionVariables(action.cwd, folders),
      ...(action.venv ? {
        venv: {
          ...action.venv,
          path: action.venv.path === undefined ? undefined : resolveActionVariables(action.venv.path, folders)
        }
      } : {})
    };
  }
  return {
    ...action,
    url: resolveActionVariables(action.url, folders),
    body: action.body === undefined ? undefined : resolveActionVariables(action.body, folders)
  };
}

/**
 * 清单按后端分组(用户令 2026-10-15「学 debugger 那样…下拉」):同类型连续段
 * 共用一条分隔线(标签=后端名),不重排用户配置顺序;每个组的开头都有一条,
 * 包括第一组——分隔线本身就是组名。
 */
const QUICK_ACTION_TARGET_PREVIEW_LIMIT = 120;

/** 中间省略目标,并确保脚本文件名留在可见尾部。 */
function previewActionTarget(action: QuickAction, target: string): string {
  if (target.length <= QUICK_ACTION_TARGET_PREVIEW_LIMIT) return target;
  const scriptName = action.type === 'script' ? baseNameOf(target) : '';
  const suffix = scriptName.length > 0 ? scriptName : target.slice(-36);
  const prefixLength = Math.max(12, QUICK_ACTION_TARGET_PREVIEW_LIMIT - suffix.length - 5);
  return `${target.slice(0, prefixLength)}...${target.slice(-suffix.length)}`;
}

function resolvedActionTarget(action: QuickAction, folders: readonly WorkspaceFolderRef[]): string {
  try {
    return describeActionTarget(resolveAction(action, folders));
  } catch {
    // Invalid variables are reported by the normal execution path after selection.
    return describeActionTarget(action);
  }
}

function buildQuickPickItems(
  actions: readonly QuickAction[],
  folders: readonly WorkspaceFolderRef[]
): vscode.QuickPickItem[] {
  return actions.flatMap((action, index) => {
    const previous = actions[index - 1];
    const target = resolvedActionTarget(action, folders);
    const item: vscode.QuickPickItem = {
      label: action.name,
      description: action.type,
      detail: previewActionTarget(action, target)
    };
    if (previous !== undefined && previous.type === action.type) {
      return [item];
    }
    const separator: vscode.QuickPickItem = {
      label: action.type,
      kind: vscode.QuickPickItemKind.Separator
    };
    return [separator, item];
  });
}

export class QuickActionManager {
  private readonly runScript: ScriptRunner;
  private readonly runHttp: HttpRunner;
  private readonly executeCommand: CommandRunner;
  private readonly runHttpEntry?: (
    entry: HttpRequestEntry,
    execute?: () => Promise<void>,
    onHttpResponse?: (response: HttpActionResponse) => void
  ) => Promise<boolean>;
  private readonly getSettingHttpEntries: () => HttpRequestEntry[];
  private configurationRoot: string | null = null;
  private additionalScanRoots: string[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    deps: QuickActionManagerDeps = {}
  ) {
    this.runScript = deps.runScript ?? terminalScript;
    this.runHttp = deps.runHttp ?? fetchHttp;
    this.executeCommand =
      deps.executeCommand ?? ((command, args) => vscode.commands.executeCommand(command, ...args));
    this.runHttpEntry = deps.runHttpEntry;
    this.getSettingHttpEntries = deps.getSettingHttpEntries ?? (() => []);
  }

  /** 配置、扫描、脚本变量解析统一锚定到启动引导选出的工作目录。 */
  setConfigurationRoots(configurationRoot: string, scanRoots: readonly string[] = []): void {
    this.configurationRoot = configurationRoot || null;
    this.additionalScanRoots = [...scanRoots];
  }

  /** 显式重新扫描脚本并刷新扫描生成的动作，保留手工动作与 debug 配置。 */
  async scanScriptsAndRefresh(): Promise<void> {
    const root = this.getConfigurationRoot();
    if (!root) {
      await vscode.window.showInformationMessage('无法扫描快速动作:请先打开工作区');
      return;
    }
    const candidates = await this.scanCandidates();
    const current = await this.readConfigFile();
    const existing = parseQuickActionConfigs(current?.quickActions).actions;
    const manual = existing.filter(action => action.source !== 'scan');
    if (candidates.length === 0) {
      const staleCount = existing.length - manual.length;
      if (staleCount > 0) await this.writeQuickActions(root, manual);
      await vscode.window.showInformationMessage(
        staleCount > 0
          ? `未找到脚本，已清除 ${staleCount} 个过期扫描动作并保留 ${manual.length} 个手工动作`
          : '未找到可登记的 .bat / .ps1 脚本'
      );
      return;
    }
    const picked = await vscode.window.showQuickPick<ScanPickItem>(
      candidates.map(candidate => ({
        label: baseNameOf(candidate.path),
        description: candidate.category === null ? '' : CATEGORY_LABELS[candidate.category],
        detail: candidate.path,
        value: candidate
      })),
      { canPickMany: true, placeHolder: '选择要登记的 .bat / .ps1 脚本；已有手工动作会保留' }
    );
    if (!picked) return;
    const scanned = buildScannedActions(picked.map(item => item.value), root);
    await this.writeQuickActions(root, [...manual, ...scanned]);
    await vscode.window.showInformationMessage(
      `已重新扫描脚本:登记 ${scanned.length} 个动作，保留 ${manual.length} 个手工动作`
    );
  }

  /** 动作清单:读配置 → 无动作指路 → 勾选 → 执行 */
  async show(): Promise<void> {
    const { actions, invalidCount, warnings } = await this.loadActions();
    if (invalidCount > 0) {
      await vscode.window.showInformationMessage(`快速执行动作配置中有 ${invalidCount} 条无效，已跳过`);
    }
    // background 非布尔等写法问题(2026-10-27 ①):条目保留按前台执行,但
    // 告警逐条播报——静默回落会让「写了 true 还是弹终端」查无实据
    if (warnings.length > 0) {
      await vscode.window.showWarningMessage(warnings.join('；'));
    }
    if (actions.length === 0) {
      await vscode.window.showInformationMessage(
        '未配置快速执行动作：在 .kbengine/debug.json 的 quickActions 数组里添加'
      );
      return;
    }
    const picked = await vscode.window.showQuickPick(buildQuickPickItems(actions, this.actionWorkspaceFolders()), {
      placeHolder: '选择要执行的快速动作'
    });
    if (!picked) {
      return;
    }
    // 真 UI 分隔线不可选;替身能给出的按防御口径当取消(不猜着执行)
    // 按 label 回找配置项;清单与配置同源,回找不到也当取消
    const action =
      picked.kind === vscode.QuickPickItemKind.Separator
        ? undefined
        : actions.find(item => item.name === picked.label);
    if (!action) {
      return;
    }
    await this.run(action);
  }

  /**
   * Explorer ▶ 主按钮(用户令 2026-10-15「学 debugger 那样…点一下就执行」):
   * 跑上次实际执行过的动作;没记过就清单第一个;一条都没有时指路配置文件。
   */
  async runDefault(): Promise<void> {
    const { actions } = await this.loadActions();
    if (actions.length === 0) {
      await vscode.window.showInformationMessage(
        '未发现可执行脚本：在 .kbengine/debug.json 的 quickActions 数组里添加'
      );
      return;
    }
    const lastRun = this.context.workspaceState?.get<string>(QUICK_ACTION_LAST_RUN_KEY);
    const action = actions.find(item => item.name === lastRun) ?? actions[0];
    const folders = this.actionWorkspaceFolders();
    const picked = await vscode.window.showQuickPick(
      buildQuickPickItems([action], folders),
      { placeHolder: `上次命令：${previewActionTarget(action, resolvedActionTarget(action, folders))}` }
    );
    if (picked?.label === action.name) await this.run(action);
  }

  /**
   * 按名执行动作(自动热重载等无人值守通道):命中即走 run 链。
   * 名字为空直接返回;找不到只记 OUTPUT 流水,不弹窗不打扰。
   * suppressConfirm/skipLastRun 透传给 run。
   */
  async runByName(name: string, options: QuickActionRunOptions = {}): Promise<boolean> {
    if (name.length === 0) {
      return false;
    }
    if (name.startsWith('@http:')) {
      // AUD-054:options(含 onHttpResponse)必须随 @http: 直达入口透传,
      // 不能在 runHttpRequestFrom 跳板处丢掉(R2-F27)
      const match = /^@http:(debug|settings):(\d+)$/.exec(name);
      return match
        ? this.runHttpRequestFrom(match[1] as 'debug' | 'settings', Number(match[2]), options)
        : this.runHttpRequest(Number(name.slice('@http:'.length)), options);
    }
    if (name.startsWith('@script:')) return this.runScannedScript(name.slice('@script:'.length));
    const { actions } = await this.loadActions();
    const action = actions.find(item => item.name === name);
    if (!action) {
      return false;
    }
    return this.run(action, options);
  }

  /** Tree view rows use the same resolved target and script basename as the picker. */
  async getTreeActions(): Promise<Array<{ name: string; type: QuickAction['type']; target: string }>> {
    const { actions } = await this.loadActions();
    const folders = this.actionWorkspaceFolders();
    return actions.map(action => ({
      name: action.name,
      type: action.type,
      target: resolvedActionTarget(action, folders)
    }));
  }

  /** 未登记脚本直接走既有 resolveAction/run 链；登记询问在执行开始后异步出现。 */
  async runScannedScript(scriptPath: string): Promise<boolean> {
    const root = this.getConfigurationRoot();
    if (!root) return false;
    const candidate: BatchScriptCandidate = { path: scriptPath, category: null };
    const [action] = buildScannedActions([candidate], root);
    // 不可达(批 65 定性):buildScannedActions 按候选逐一生成动作,单候选恒得
    // 长 1 的 QuickActionScript 数组,解构首项恒非空且恒为 'script';空/非脚本
    // 守卫无触发输入。
    /* istanbul ignore start */
    if (!action || action.type !== 'script') return false;
    /* istanbul ignore stop */
    const direct: QuickAction = { ...action, confirm: false };
    void vscode.window.showInformationMessage(`是否登记「${baseNameOf(scriptPath)}」为快速执行动作？`, '登记').then(async choice => {
      if (choice !== '登记') return;
      const current = await this.readConfigFile();
      const existing = parseQuickActionConfigs(current?.quickActions).actions;
      const name = direct.name;
      if (existing.some(item => item.name === name)) return;
      await this.writeQuickActions(root, [...existing, action]);
      await vscode.window.showInformationMessage(`已登记「${baseNameOf(scriptPath)}」`);
    }, () => undefined);
    return this.run(direct);
  }

  async getTreeData(): Promise<{ registered: Array<{ name: string; type: QuickAction['type']; target: string }>; scripts: Array<{ name: string; type: 'script'; target: string; runDirect: true }>; httpRequests: Array<{ name: string; type: 'http'; target: string; method: string; runDirect: true; requestSource: 'debug' | 'settings'; requestIndex: number }> }> {
    const registered = await this.getTreeActions();
    const registeredPaths = new Set(registered.filter(action => action.type === 'script').map(action => path.resolve(action.target).toLowerCase()));
    const scripts = (await this.scanCandidates()).filter(candidate => !registeredPaths.has(path.resolve(candidate.path).toLowerCase())).map(candidate => ({
      name: baseNameOf(candidate.path), type: 'script' as const, target: candidate.path, runDirect: true as const
    }));
    const config = await this.readConfigFile();
    const debugRequests = parseHttpRequestConfigs(config?.httpRequests).requests;
    const settingRequests = this.getSettingHttpEntries();
    // Conflict policy: settings win for duplicate names, matching the command-panel configuration.
    const requests = [
      ...debugRequests.map((request, index) => ({ request, source: 'debug' as const, index }))
        .filter(item => !settingRequests.some(setting => setting.name === (item.request.name ?? `${item.request.method} ${item.request.url}`))),
      ...settingRequests.map((request, index) => ({ request, source: 'settings' as const, index }))
    ];
    const folders = this.actionWorkspaceFolders();
    const httpRequests = requests.filter(item => !('enabled' in item.request) || item.request.enabled !== false).map(({ request, source, index }) => {
      let target = request.url;
      try { target = resolveActionVariables(request.url, folders); } catch { /* execution reports the invalid variable */ }
      return {
        name: request.name ?? `${request.method} ${request.url}`,
        type: 'http' as const,
        method: request.method,
        source,
        target,
        runDirect: true as const,
        // Index is stable against the same parsed request ordering at click time.
        requestIndex: index,
        requestSource: source
      };
    });
    return { registered, scripts, httpRequests };
  }

  private async runHttpRequest(index: number, options: QuickActionRunOptions = {}): Promise<boolean> {
    // Legacy numeric selectors refer to debug.json entries.
    return this.runHttpRequestFrom('debug', index, options);
  }

  async runHttpRequestFrom(
    source: 'debug' | 'settings',
    index: number,
    options: QuickActionRunOptions = {}
  ): Promise<boolean> {
    if (source === 'settings' && this.runHttpEntry) {
      const entry = this.getSettingHttpEntries()[index];
      return entry ? this.runHttpEntry(entry, undefined, options.onHttpResponse) : false;
    }
    const config = await this.readConfigFile();
    const request = source === 'debug'
      ? parseHttpRequestConfigs(config?.httpRequests).requests[index]
      : undefined;
    if (!request) return false;
    try {
      const folders = this.actionWorkspaceFolders();
      const resolved: HttpRequestConfig = {
        ...request,
        url: resolveActionVariables(request.url, folders),
        ...(request.body === undefined ? {} : { body: resolveActionVariables(request.body, folders) }),
        ...(request.headers ? { headers: Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key, resolveActionVariables(value, folders)])) } : {})
      };
      if (this.runHttpEntry) {
        // AUD-054:有观察器时不再走 execute=terminalHttp 闭包(返回 void,拿
        // 不到 status/body),改由 hook(真装配=httpRequestService.runEntry)自
        // 身传输并上报 status/body——观察器才能按真实 HTTP 事实落账;无观
        // 察器保留 terminalHttp 闭包原行为(既有用例与终端路径不受扰)。
        return await this.runHttpEntry({
          name: resolved.name ?? `${resolved.method} ${resolved.url}`, url: resolved.url, method: resolved.method,
          headers: resolved.headers ?? {}, body: resolved.body ?? '', enabled: true, keybinding: ''
        }, options.onHttpResponse ? undefined : () => terminalHttp(resolved), options.onHttpResponse);
      }
      await terminalHttp(resolved);
      return true;
    } catch (error) {
      await vscode.window.showErrorMessage(errorMessage(error));
      return false;
    }
  }

  /** 激活期首装扫描:勾完才写配置,取消后本工作区不再自动弹 */
  async offerScanOnActivate(): Promise<void> {
    const root = this.getConfigurationRoot();
    if (!root) {
      return;
    }
    // workspaceState 缺失(极简装配上下文)按「首次运行」处理:首装扫描只是提示,
    // 不该因为拿不到 memento 就中断激活链
    if (this.context.workspaceState?.get<boolean>(QUICK_ACTION_SCAN_DISMISS_KEY) === true) {
      return;
    }
    const { actions } = await this.loadActions();
    if (actions.length > 0) {
      return;
    }
    let candidates: BatchScriptCandidate[];
    try {
      candidates = await this.scanCandidates();
    } catch {
      // 根目录读不到(权限/虚拟文件系统):静默返回,不打扰用户
      return;
    }
    if (candidates.length === 0) {
      return;
    }
    const picked = await vscode.window.showQuickPick<ScanPickItem>(
      candidates.map(candidate => ({
        label: baseNameOf(candidate.path),
        description: candidate.category === null ? '' : CATEGORY_LABELS[candidate.category],
        detail: candidate.path,
        value: candidate
      })),
      { canPickMany: true, placeHolder: '勾选要登记为快速执行动作的脚本' }
    );
    const chosen = (picked ?? []).map(item => item.value);
    if (chosen.length === 0) {
      await this.context.workspaceState?.update(QUICK_ACTION_SCAN_DISMISS_KEY, true);
      return;
    }
    const scanned = buildScannedActions(chosen, root);
    await this.writeQuickActions(root, scanned);
    await vscode.window.showInformationMessage(`已写入 ${scanned.length} 个快速执行动作到 .kbengine/debug.json`);
  }

  /** 单个动作执行链:变量替换 → 确认 → 分发 → 流水(失败一次性弹窗) */
  private async run(action: QuickAction, options: QuickActionRunOptions = {}): Promise<boolean> {
    // 选中即记忆:Explorer ▶ 主按钮的默认目标跟着最近一次执行走;
    // 极简装配上下文没有 workspaceState 时照常执行,只是不记忆;
    // 无人值守通道(skipLastRun)不污染「上次执行」记忆
    if (!options.skipLastRun) {
      await this.context.workspaceState?.update(QUICK_ACTION_LAST_RUN_KEY, action.name);
    }
    let resolved: QuickAction;
    try {
      resolved = resolveAction(action, this.actionWorkspaceFolders());
    } catch (error) {
      const message = errorMessage(error);
      await vscode.window.showErrorMessage(message);
      return false;
    }
    if (!options.suppressConfirm && resolved.confirm) {
      const confirmed = await vscode.window.showInformationMessage(
        `执行 ${resolved.name}：${describeActionTarget(resolved)}?`,
        { modal: true },
        QUICK_ACTION_CONFIRM_LABEL
      );
      if (confirmed !== QUICK_ACTION_CONFIRM_LABEL) {
        return false;
      }
    }
    try {
      if (resolved.type === 'command') {
        await this.executeCommand(resolved.command, resolved.args);
        return true;
      }
      if (resolved.type === 'script') {
        return await this.runScriptAction(resolved);
      }
      return await this.runHttpAction(resolved, options);
    } catch (error) {
      // 执行器抛错(spawn 失败/请求超时/命令未注册)统一收口
      const message = errorMessage(error);
      await vscode.window.showErrorMessage(message);
      return false;
    }
  }

  private async runScriptAction(action: Extract<QuickAction, { type: 'script' }>): Promise<boolean> {
    const env = action.venv?.enabled ? this.resolveVenvEnvironment(action) : undefined;
    const result = await this.runScript({
      name: action.name,
      script: action.script,
      background: action.background,
      cwd: action.cwd,
      ...(env ? { env } : {})
    });
    if (action.background) {
      return true;
    }
    if (result.submitted) return true;
    if (result.code === 0) {
      return true;
    }
    // 被信号终止时拿不到退出码,照实写「未知」而不是编一个码
    const exit = result.code === null ? '未知' : String(result.code);
    await vscode.window.showErrorMessage(`执行快速动作失败: ${action.name} (exit ${exit})`);
    return false;
  }

  private async runHttpAction(
    action: Extract<QuickAction, { type: 'http' }>,
    options: QuickActionRunOptions = {}
  ): Promise<boolean> {
    const result = await this.runHttp({ url: action.url, method: action.method, body: action.body });
    const ok = result.status >= 200 && result.status < 300;
    // IDE-REV-022:响应到达即上报观察者(回执解析面);脚本/命令动作无此回调
    options.onHttpResponse?.({ status: result.status, body: result.body });
    if (!ok) {
      await vscode.window.showErrorMessage(`执行快速动作失败: ${action.name} (HTTP ${result.status})`);
      return false;
    }
    return true;
  }

  private configUri(fsPath: string): vscode.Uri {
    return vscode.Uri.joinPath(vscode.Uri.file(fsPath), '.kbengine', 'debug.json');
  }

  /** 读动作配置;文件缺失/坏 JSON 一律当没有动作(不打断用户) */
  private async loadActions(): Promise<{
    actions: QuickAction[];
    invalidCount: number;
    warnings: string[];
  }> {
    const config = await this.readConfigFile();
    if (config === null) {
      return { actions: [], invalidCount: 0, warnings: [] };
    }
    return parseQuickActionConfigs(config.quickActions);
  }

  private async readConfigFile(): Promise<Record<string, unknown> | null> {
    const root = this.getConfigurationRoot();
    if (!root) {
      return null;
    }
    try {
      const data = await vscode.workspace.fs.readFile(this.configUri(root));
      // 批143:骨架按 JSONC 写(带注释),读配置统一剥注释再解析,坏 JSON 按没有
      // 动作处理——用户在文件里写的注释不该让整份配置读不动
      return parseDebugConfigText(Buffer.from(data).toString('utf8'));
    } catch {
      return null;
    }
  }

  /** 写回动作清单:保留既有 version/debug 段,只落顶层 quickActions 键 */
  private async writeQuickActions(fsPath: string, actions: QuickAction[]): Promise<void> {
    const existing = (await this.readConfigFile()) ?? {};
    const content = Buffer.from(JSON.stringify({ ...existing, quickActions: actions }, null, 2), 'utf8');
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(vscode.Uri.file(fsPath), '.kbengine'));
    await vscode.workspace.fs.writeFile(this.configUri(fsPath), content);
  }

  private getConfigurationRoot(): string | null {
    return this.configurationRoot ?? workspaceFolders()[0]?.fsPath ?? null;
  }

  private actionWorkspaceFolders(): WorkspaceFolderRef[] {
    const folders = workspaceFolders();
    const root = this.getConfigurationRoot();
    if (!root) return [...folders];
    const samePath = (left: string, right: string): boolean =>
      path.resolve(left).replace(/\\/g, '/').toLowerCase() === path.resolve(right).replace(/\\/g, '/').toLowerCase();
    const primary = folders.find(folder => samePath(folder.fsPath, root));
    const rootRef = { fsPath: root, name: primary?.name ?? folders[0]?.name ?? path.basename(root) };
    return [rootRef, ...folders.filter(folder => !samePath(folder.fsPath, root))];
  }

  private async scanCandidates(): Promise<BatchScriptCandidate[]> {
    const root = this.getConfigurationRoot();
    if (!root) return [];
    const roots = [...new Set([root, ...this.additionalScanRoots].filter(Boolean))];
    const entriesByRoot = new Map<string, DirectoryEntry[]>();
    for (const scanRoot of roots) {
      try {
        const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(scanRoot));
        entriesByRoot.set(scanRoot, entries.map(([name, type]) => ({ name, type })));
      } catch {
        entriesByRoot.set(scanRoot, []);
      }
    }
    return scanBatchScriptsInRoots(roots, scanRoot => entriesByRoot.get(scanRoot) ?? []);
  }

  /** venv 自动查找目录名:设置 kbengine.python.venvDirectories(默认
   * .venv/venv/.kbenv,环境目录不写死);读取异常回落默认清单。 */
  private venvDirectoryNames(): string[] {
    try {
      return normalizeVenvDirectoryNames(
        vscode.workspace.getConfiguration('kbengine').get('python.venvDirectories')
      );
    } catch {
      return [...DEFAULT_VENV_DIRECTORY_NAMES];
    }
  }

  private resolveVenvEnvironment(action: Extract<QuickAction, { type: 'script' }>): NodeJS.ProcessEnv {
    const root = this.getConfigurationRoot() ?? process.cwd();
    const actionDirectory = action.cwd ?? path.dirname(action.script);
    const candidates = action.venv?.path
      ? [path.isAbsolute(action.venv.path) ? action.venv.path : path.resolve(root, action.venv.path)]
      : this.venvDirectoryNames().flatMap(name => [
          path.resolve(actionDirectory, name), path.resolve(root, name)
        ]);
    const venvPath = candidates.find(candidate => {
      try { return fs.statSync(candidate).isDirectory(); } catch { return false; }
    });
    if (!venvPath) {
      throw new Error(`动作「${action.name}」启用了 venv，但找不到虚拟环境目录;请设置 venv.path 或按 kbengine.python.venvDirectories(默认 .venv/venv/.kbenv)创建`);
    }
    const scriptsDirectory = process.platform === 'win32' ? 'Scripts' : 'bin';
    const binPath = path.join(venvPath, scriptsDirectory);
    const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
    return {
      ...process.env,
      VIRTUAL_ENV: venvPath,
      [pathKey]: `${binPath}${path.delimiter}${process.env[pathKey] ?? ''}`
    };
  }

}
