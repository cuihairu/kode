/**
 * 快速执行动作装配层(设计 1.9/1.10):
 * - 动作清单 quick pick(标签/类型/目标三列)与三后端分发(command/script/http);
 * - 默认执行器是真实现(child_process / node http),注入点只给测试与将来换实现;
 * - 破坏性动作默认弹 modal 确认,流水统一进 OUTPUT 专用通道,失败一次性弹窗;
 * - 首装扫一层 .bat,用户勾选确认后才写回 .kbengine/debug.json。
 *
 * 安全边界(用户 2026-10-15 追加):script/http 只执行配置里显式声明的目标,
 * 执行期不拼接任何运行时参数——白名单来自配置本身,不是运行时字符串判断。
 * 变量替换只作用在配置字面串上,未知变量直接报错中止(1.5 拒绝静默空串)。
 */

import * as child_process from 'child_process';
import * as http from 'http';
import * as https from 'https';
import * as vscode from 'vscode';
import {
  baseNameOf,
  buildScannedActions,
  parseQuickActionConfigs,
  resolveActionVariables
} from './quickActionConfig';
import type {
  QuickAction,
  QuickActionCategory,
  WorkspaceFolderRef
} from './quickActionConfig';
import { scanBatchScripts } from './quickActionScanner';
import type { BatchScriptCandidate, DirectoryEntry } from './quickActionScanner';

export const QUICK_ACTION_CHANNEL_NAME = 'KBEngine 快速执行动作';
export const QUICK_ACTION_SCAN_DISMISS_KEY = 'kbengine.quickActions.scanDismissed';
/** Explorer ▶ 主按钮的默认目标:上次实际执行的动作名(选中即记忆) */
export const QUICK_ACTION_LAST_RUN_KEY = 'kbengine.quickActions.lastRun';
export const QUICK_ACTION_CONFIRM_LABEL = '执行';
/** 本地热更新不该更久(设计 1.6);与 HTTP 快捷请求同量级 */
export const QUICK_ACTION_TIMEOUT_MS = 10000;
/** 回包进通道的截顶长度(字符),超出丢弃——热更回包本就很小,
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
  script: string;
  background: boolean;
  cwd?: string;
}

export interface ScriptRunResult {
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
}

/** 无人值守通道(自动热重载等)的执行选项 */
export interface QuickActionRunOptions {
  /** 跳过执行确认框(自动热重载等无人值守通道传 true) */
  readonly suppressConfirm?: boolean;
  /** 不记入「上次执行」记忆(默认仍记,Explorer ▶ 跟着最近一次执行走) */
  readonly skipLastRun?: boolean;
}

/** 工作区根清单;无工作区(只开了单文件)返回空数组,变量解析由调用方报错 */
function workspaceFolders(): readonly WorkspaceFolderRef[] {
  return vscode.workspace.workspaceFolders?.map(folder => ({
    fsPath: folder.uri.fsPath,
    name: folder.name
  })) ?? [];
}

function padTwo(value: number): string {
  return String(value).padStart(2, '0');
}

/** 流水行前缀:本地时区 HH:mm:ss,不依赖 toTimeString 的 GMT/时区尾巴 */
function timestamp(): string {
  const now = new Date();
  return `${padTwo(now.getHours())}:${padTwo(now.getMinutes())}:${padTwo(now.getSeconds())}`;
}

/**
 * 默认 script 执行器:走 shell 起 bat(Windows .bat 必须经 shell 才能执行)。
 * 前台收 stdout/stderr 原样交流水层;后台不接管道——长跑进程的输出若没人读,
 * 管道写满会把启服脚本挂死,输出归脚本自己的日志。
 */
export const spawnScript: ScriptRunner = options =>
  new Promise<ScriptRunResult>((resolve, reject) => {
    // cwd 未给即工作区根(设计 1.8):bat 内部按工程根写的相对路径才成立
    const cwd = options.cwd ?? workspaceFolders()[0]?.fsPath;
    const child = child_process.spawn(options.script, [], {
      cwd,
      shell: true,
      windowsHide: true,
      stdio: options.background ? 'ignore' : ['ignore', 'pipe', 'pipe']
    });
    if (options.background) {
      // 起服类不等退出码,但也不能一上来就报「已启动」——'spawn' 才代表进程
      // 真起来了;起不来走下方 error 分支,失败要如实说。
      child.once('spawn', () => resolve({ code: null, stdout: '', stderr: '' }));
    } else {
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('close', (code: number | null) => resolve({ code, stdout, stderr }));
    }
    // 启动失败(脚本路径不存在/cwd 无效)只走 error 不走 close;两支都挂了
    // 这个监听,后台分支才不会因无人接手的 'error' 事件带走扩展宿主。
    child.on('error', (error: Error) => reject(error));
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
      cwd: action.cwd === undefined ? undefined : resolveActionVariables(action.cwd, folders)
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
function buildQuickPickItems(actions: readonly QuickAction[]): vscode.QuickPickItem[] {
  return actions.flatMap((action, index) => {
    const previous = actions[index - 1];
    const item: vscode.QuickPickItem = {
      label: action.name,
      description: action.type,
      detail: describeActionTarget(action)
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
  private readonly channel: vscode.OutputChannel;
  private readonly runScript: ScriptRunner;
  private readonly runHttp: HttpRunner;
  private readonly executeCommand: CommandRunner;

  constructor(
    private readonly context: vscode.ExtensionContext,
    deps: QuickActionManagerDeps = {}
  ) {
    this.channel = vscode.window.createOutputChannel(QUICK_ACTION_CHANNEL_NAME);
    this.runScript = deps.runScript ?? spawnScript;
    this.runHttp = deps.runHttp ?? fetchHttp;
    this.executeCommand =
      deps.executeCommand ?? ((command, args) => vscode.commands.executeCommand(command, ...args));
    // deactivate 走 dispose():通道与本管理器同一条释放链
    this.context.subscriptions.push({ dispose: (): void => this.dispose() });
  }

  /** 动作清单:读配置 → 无动作指路 → 勾选 → 执行 */
  async show(): Promise<void> {
    const { actions, invalidCount } = await this.loadActions();
    if (invalidCount > 0) {
      await vscode.window.showInformationMessage(`快速执行动作配置中有 ${invalidCount} 条无效，已跳过`);
    }
    if (actions.length === 0) {
      await vscode.window.showInformationMessage(
        '未配置快速执行动作：在 .kbengine/debug.json 的 quickActions 数组里添加'
      );
      return;
    }
    const picked = await vscode.window.showQuickPick(buildQuickPickItems(actions), {
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
    await this.run(action);
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
    const { actions } = await this.loadActions();
    const action = actions.find(item => item.name === name);
    if (!action) {
      this.append(`未找到名为「${name}」的快速动作`);
      return false;
    }
    return this.run(action, options);
  }

  /** 激活期首装扫描:勾完才写配置,取消后本工作区不再自动弹 */
  async offerScanOnActivate(): Promise<void> {
    const [folder] = workspaceFolders();
    if (folder === undefined) {
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
      const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(folder.fsPath));
      candidates = scanBatchScripts(folder.fsPath, () =>
        entries.map(([name, type]): DirectoryEntry => ({ name, type }))
      );
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
        description: CATEGORY_LABELS[candidate.category],
        value: candidate
      })),
      { canPickMany: true, placeHolder: '勾选要登记为快速执行动作的脚本' }
    );
    const chosen = (picked ?? []).map(item => item.value);
    if (chosen.length === 0) {
      await this.context.workspaceState?.update(QUICK_ACTION_SCAN_DISMISS_KEY, true);
      return;
    }
    const scanned = buildScannedActions(chosen, folder.fsPath);
    await this.writeQuickActions(folder.fsPath, scanned);
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
      resolved = resolveAction(action, workspaceFolders());
    } catch (error) {
      const message = errorMessage(error);
      this.append(`${action.name} → ✗ ${message}`);
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
        this.append(`${resolved.name} → ✓`);
        return true;
      }
      if (resolved.type === 'script') {
        return await this.runScriptAction(resolved);
      }
      return await this.runHttpAction(resolved);
    } catch (error) {
      // 执行器抛错(spawn 失败/请求超时/命令未注册)统一收口
      const message = errorMessage(error);
      this.append(`${resolved.name} → ✗ ${message}`);
      await vscode.window.showErrorMessage(message);
      return false;
    }
  }

  private async runScriptAction(action: Extract<QuickAction, { type: 'script' }>): Promise<boolean> {
    const result = await this.runScript({
      script: action.script,
      background: action.background,
      cwd: action.cwd
    });
    if (action.background) {
      this.append(`${action.name} → 已启动`);
      return true;
    }
    if (result.stdout.length > 0) {
      this.append(result.stdout.trimEnd());
    }
    if (result.stderr.length > 0) {
      this.append(result.stderr.trimEnd());
    }
    if (result.code === 0) {
      this.append(`${action.name} → ✓ exit 0`);
      return true;
    }
    // 被信号终止时拿不到退出码,照实写「未知」而不是编一个码
    const exit = result.code === null ? '未知' : String(result.code);
    this.append(`${action.name} → ✗ exit ${exit}`);
    await vscode.window.showErrorMessage(`执行快速动作失败: ${action.name} (exit ${exit})`);
    return false;
  }

  private async runHttpAction(action: Extract<QuickAction, { type: 'http' }>): Promise<boolean> {
    const result = await this.runHttp({ url: action.url, method: action.method, body: action.body });
    const ok = result.status >= 200 && result.status < 300;
    this.append(`${action.name} → ${ok ? '✓' : '✗'} HTTP ${result.status}`);
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
  private async loadActions(): Promise<{ actions: QuickAction[]; invalidCount: number }> {
    const config = await this.readConfigFile();
    if (config === null) {
      return { actions: [], invalidCount: 0 };
    }
    return parseQuickActionConfigs(config.quickActions);
  }

  private async readConfigFile(): Promise<Record<string, unknown> | null> {
    const [folder] = workspaceFolders();
    if (folder === undefined) {
      return null;
    }
    try {
      const data = await vscode.workspace.fs.readFile(this.configUri(folder.fsPath));
      return JSON.parse(Buffer.from(data).toString('utf8')) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  /** 写回动作清单:保留既有 version/debug 段,只落顶层 quickActions 键 */
  private async writeQuickActions(fsPath: string, actions: QuickAction[]): Promise<void> {
    const existing = (await this.readConfigFile()) ?? {};
    const content = Buffer.from(JSON.stringify({ ...existing, quickActions: actions }, null, 2), 'utf8');
    await vscode.workspace.fs.writeFile(this.configUri(fsPath), content);
  }

  private append(line: string): void {
    this.channel.appendLine(`[${timestamp()}] ${line}`);
  }

  dispose(): void {
    this.channel.dispose();
  }
}
