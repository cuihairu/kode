import * as child_process from 'child_process';
import * as vscode from 'vscode';
import { DEBUGPY_PORT_TABLE } from './autoDebugpy';
import {
  DEBUG_ATTACH_TIMEOUT_DEFAULT_MS,
  attachWithDeadline,
  type AttachGuardOutcome
} from './debugAttachGuard';
import { parseDebugConfigText } from './debugConfigBootstrap';

export interface ComponentDebugConfig {
  telnetHost?: string;
  telnetPort?: number;
  telnetPassword?: string;
  telnetDefaultLayer?: string;
  telnetEnableCommands?: string[];
  pathMappings?: Array<{
    localRoot: string;
    remoteRoot: string;
  }>;
}

export interface KBEngineDebugConfig {
  defaultTelnetHost?: string;
  defaultTelnetPort?: number;
  components: { [componentName: string]: ComponentDebugConfig };
}

export interface DebugConfigFile {
  version: string;
  debug: KBEngineDebugConfig;
}

/** 元件默认清单:元件名 + telnet 端口(批143 起骨架注释示例复用这份真源) */
export const SOURCE_DEFAULT_COMPONENTS: Array<{
  name: string;
  telnetPort: number;
}> = [
  { name: 'loginapp', telnetPort: 31000 },
  { name: 'dbmgr', telnetPort: 32000 },
  { name: 'interfaces', telnetPort: 33000 },
  { name: 'logger', telnetPort: 34000 },
  { name: 'baseapp', telnetPort: 40000 },
  { name: 'cellapp', telnetPort: 50000 },
  { name: 'bots', telnetPort: 51000 }
];

/** 进程清单条目(批112 用户令:attach 按进程名过滤,不只是裸 PID 列表) */
export interface ProcessEntry {
  pid: number;
  name: string;
}

/** 执行进程清单命令并返回 stdout(注入便于测试,不真跑 ps/tasklist) */
export type ProcessCommandRunner = (command: string) => string;

/**
 * 解析 `ps -axo pid=,comm=` 输出:行首 PID + 空白 + 进程名(comm 可能含空格)。
 */
export function parsePsProcesses(output: string): ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^(\d+)\s+(.+)$/);
    if (match) {
      const pid = Number(match[1]);
      if (Number.isFinite(pid) && pid > 0) {
        entries.push({ pid, name: match[2].trim() });
      }
    }
  }
  return entries;
}

/**
 * 解析 `tasklist /fo csv /nh` 输出:`"名","PID",...`;末列内存数带千位逗号,
 * 只取前两列,不整行 JSON 化。
 */
export function parseTasklistProcesses(output: string): ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  for (const line of output.split(/\r?\n/)) {
    const cells = line.trim().split('","');
    if (cells.length < 2) {
      continue;
    }
    const name = cells[0].replace(/^"/, '').trim();
    const pid = Number(cells[1].replace(/"$/, '').trim());
    if (name.length > 0 && Number.isFinite(pid) && pid > 0) {
      entries.push({ pid, name });
    }
  }
  return entries;
}

/**
 * 进程清单器(批112 用户令):win32 走 tasklist CSV,其余走 ps;
 * 命令失败(无 ps/无权限)返回空清单,不抛——attach 流程自己提示。
 */
export function makeProcessLister(
  run: ProcessCommandRunner,
  platform: NodeJS.Platform = process.platform
): () => ProcessEntry[] {
  return () => {
    try {
      if (platform === 'win32') {
        return parseTasklistProcesses(run('tasklist /fo csv /nh'));
      }
      return parsePsProcesses(run('ps -axo pid=,comm='));
    } catch {
      return [];
    }
  };
}

/** 远程调试目标(批112 用户令:服务器 IP 数组,点击远程弹选择) */
export interface RemoteDebugTarget {
  name: string;
  host: string;
  port: number;
  /** 路径映射(DBG-002):localRoot/remoteRoot 成对提供才落——缺一侧整对不收 */
  localRoot?: string;
  remoteRoot?: string;
}

/** debugpy 默认监听端口(debugpy --listen 不带端口时的约定值) */
const DEFAULT_DEBUGPY_PORT = 5678;

/**
 * 读取 kbengine.debug.remoteTargets(批112 用户令):name/host 缺一不收,
 * port 缺省/非法落 debugpy 默认 5678。localRoot/remoteRoot(DBG-002)
 * 成对非空才收——映射需要两侧,半配不猜、保持省略。
 */
export function readRemoteTargets(): RemoteDebugTarget[] {
  const config = vscode.workspace.getConfiguration('kbengine');
  const raw = config.get<Array<{ name?: string; host?: string; port?: number; localRoot?: unknown; remoteRoot?: unknown }>>(
    'debug.remoteTargets',
    []
  );
  const targets: RemoteDebugTarget[] = [];
  for (const item of raw ?? []) {
    // 设置里手写的数组难免混进 null/非对象条目:先整条剔除再逐键校验
    if (item === null || typeof item !== 'object') {
      continue;
    }
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    const host = typeof item.host === 'string' ? item.host.trim() : '';
    if (name.length === 0 || host.length === 0) {
      continue;
    }
    const port = typeof item.port === 'number' && item.port > 0 ? item.port : DEFAULT_DEBUGPY_PORT;
    const localRoot = typeof item.localRoot === 'string' ? item.localRoot.trim() : '';
    const remoteRoot = typeof item.remoteRoot === 'string' ? item.remoteRoot.trim() : '';
    const target: RemoteDebugTarget = { name, host, port };
    if (localRoot.length > 0 && remoteRoot.length > 0) {
      target.localRoot = localRoot;
      target.remoteRoot = remoteRoot;
    }
    targets.push(target);
  }
  return targets;
}

/** 远程目标的 pathMappings(DBG-002):成对才有,半配/无配返回 undefined */
export function remoteTargetPathMappings(
  target: Pick<RemoteDebugTarget, 'localRoot' | 'remoteRoot'>
): Array<{ localRoot: string; remoteRoot: string }> | undefined {
  if (target.localRoot === undefined || target.remoteRoot === undefined) {
    return undefined;
  }
  return [{ localRoot: target.localRoot, remoteRoot: target.remoteRoot }];
}

export class DebugConfigManager {
  private config: KBEngineDebugConfig;
  private configWatcher: vscode.FileSystemWatcher | null = null;
  private _onDidChangeConfig = new vscode.EventEmitter<void>();
  readonly onDidChangeConfig = this._onDidChangeConfig.event;

  constructor(
    private context: vscode.ExtensionContext,
    private readonly deps: { listProcesses?: () => ProcessEntry[] } = {}
  ) {
    this.config = this.getDefaultConfig();
    this.loadConfig();
    this.watchConfig();
  }

  private getDefaultConfig(): KBEngineDebugConfig {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    const defaultPathMappings = [{
      localRoot: workspaceFolder,
      remoteRoot: workspaceFolder
    }];
    const components = Object.fromEntries(
      SOURCE_DEFAULT_COMPONENTS.map(({ name, telnetPort }) => [
        name,
        {
          telnetHost: '127.0.0.1',
          telnetPort,
          telnetPassword: 'pwd123456',
          telnetDefaultLayer: 'python',
          telnetEnableCommands: [],
          pathMappings: ['baseapp', 'cellapp', 'interfaces', 'bots', 'loginapp', 'dbmgr'].includes(name)
            ? defaultPathMappings
            : undefined
        }
      ])
    );

    return {
      defaultTelnetHost: '127.0.0.1',
      defaultTelnetPort: 0,
      components
    };
  }

  private async loadConfig(): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return;
    }

    const configPath = vscode.Uri.joinPath(workspaceFolder.uri, '.kbengine', 'debug.json');

    try {
      const configData = await vscode.workspace.fs.readFile(configPath);
      // 批143:骨架按 JSONC 写(带注释),读配置统一剥注释再解析
      const configFile = parseDebugConfigText(Buffer.from(configData).toString('utf8')) as DebugConfigFile | null;
      if (configFile === null) {
        return;
      }
      this.config = {
        ...this.config,
        ...configFile.debug
      };
      this._onDidChangeConfig.fire();
    } catch {
      this.config = this.getDefaultConfig();
    }
  }

  private watchConfig(): void {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return;
    }

    const configPattern = vscode.Uri.joinPath(workspaceFolder.uri, '.kbengine', 'debug.json');
    this.configWatcher = vscode.workspace.createFileSystemWatcher(configPattern.toString());

    this.configWatcher.onDidChange(() => {
      this.loadConfig();
      vscode.window.showInformationMessage('KBEngine 调试配置已更新');
    });
    this.configWatcher.onDidCreate(() => {
      this.loadConfig();
      vscode.window.showInformationMessage('KBEngine 调试配置已创建');
    });
    this.configWatcher.onDidDelete(() => {
      this.loadConfig();
      vscode.window.showWarningMessage('KBEngine 调试配置已删除，已恢复默认配置');
    });

    this.context.subscriptions.push(this.configWatcher);
  }

  getComponentConfig(componentName: string): ComponentDebugConfig {
    const userConfig = this.config.components[componentName];
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';

    return {
      telnetHost: userConfig?.telnetHost || this.config.defaultTelnetHost,
      telnetPort: userConfig?.telnetPort || this.config.defaultTelnetPort,
      telnetPassword: userConfig?.telnetPassword || 'pwd123456',
      telnetDefaultLayer: userConfig?.telnetDefaultLayer || 'python',
      telnetEnableCommands: userConfig?.telnetEnableCommands || [],
      pathMappings: userConfig?.pathMappings || [{
        localRoot: workspaceFolder,
        remoteRoot: workspaceFolder
      }]
    };
  }

  private getDebuggerType(): string {
    return 'debugpy';
  }

  private generateLaunchInputs(existingInputs: any[] = []): any[] {
    // 批111 用户令:进程选择改走 VS Code 内建 ${command:pickProcess}
    // (debugpy 解析后弹原生进程选择器),promptString 手输 PID 的
    // kbengineProcessId 输入项废弃;更新 launch.json 时顺带清掉旧文件
    // 遗留的该输入项。
    return existingInputs.filter(item => item.id !== 'kbengineProcessId');
  }

  /**
   * 运行中的命名实例(DBG-001):启动联动按组件实例窗口分配了独立口,
   * attach 据此逐实例生成条目,指向指定实例而不是只指默认口。
   */
  generateLaunchConfigurations(runningInstances: ReadonlyArray<{ component: string; targetId: string; port: number }> = []): any[] {
    const configurations: any[] = [];
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';

    for (const [componentName, componentConfig] of Object.entries(this.config.components)) {
      configurations.push({
        name: `KBEngine: Python attach to ${componentName}`,
        type: this.getDebuggerType(),
        request: 'attach',
        // 批111 用户令:进程选择走 VS Code 内建进程选择器(${command:pickProcess})
        processId: '${command:pickProcess}',
        justMyCode: false,
        pathMappings: componentConfig.pathMappings || [{
          localRoot: workspaceFolder,
          remoteRoot: workspaceFolder
        }],
        presentation: {
          group: 'KBEngine',
          order: 1
        }
      });
    }

    // 批112 用户令:远程调试目标写入 launch.json(connect 模式附加,
    // 远端需已起 debugpy 监听)。DBG-002:目标带成对 localRoot/remoteRoot
    // 时写 pathMappings(半配/无配保持省略,不猜映射)。
    for (const target of readRemoteTargets()) {
      configurations.push({
        name: `KBEngine: Python attach ${target.name} (remote)`,
        type: this.getDebuggerType(),
        request: 'attach',
        connect: {
          host: target.host,
          port: target.port
        },
        justMyCode: false,
        pathMappings: remoteTargetPathMappings(target),
        presentation: {
          group: 'KBEngine',
          order: 2
        }
      });
    }

    // 调试启动即 attach(2026-10-27 ③c):kbengine.debug.autoDebugpy 开时,
    // 按端口分配表逐组件追加 debugpy connect 附加配置(localRoot=
    // workspaceFolder,与本地 attach 同映射口径);注入由启动联动负责,
    // 这里只负责把「组件→端口」面写进 launch.json。默认关=零追加。
    // DBG-001 命名实例面:同组件多实例各持独立口(启动联动按组件窗口
    // 分配),逐实例追加一条 connect 附加——条目名带
    // `component#targetId` 指明归属实例;默认实例不进此列表(上方表配置
    // 已覆盖)。与表条目同映射口径(localRoot=workspaceFolder)。
    if (vscode.workspace.getConfiguration('kbengine').get<boolean>('debug.autoDebugpy', false)) {
      for (const { component, port } of DEBUGPY_PORT_TABLE) {
        configurations.push({
          name: `KBEngine: Python attach to ${component} (debugpy ${port})`,
          type: this.getDebuggerType(),
          request: 'attach',
          connect: {
            host: '127.0.0.1',
            port
          },
          justMyCode: false,
          pathMappings: [{
            localRoot: workspaceFolder,
            remoteRoot: workspaceFolder
          }],
          presentation: {
            group: 'KBEngine',
            order: 3
          }
        });
      }

      for (const instance of runningInstances) {
        configurations.push({
          name: `KBEngine: Python attach to ${instance.component}#${instance.targetId} (debugpy ${instance.port})`,
          type: this.getDebuggerType(),
          request: 'attach',
          connect: {
            host: '127.0.0.1',
            port: instance.port
          },
          justMyCode: false,
          pathMappings: [{
            localRoot: workspaceFolder,
            remoteRoot: workspaceFolder
          }],
          presentation: {
            group: 'KBEngine',
            order: 4
          }
        });
      }
    }

    return configurations;
  }

  async updateLaunchJson(runningInstances: ReadonlyArray<{ component: string; targetId: string; port: number }> = []): Promise<boolean> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      vscode.window.showErrorMessage('没有打开的工作区');
      return false;
    }

    const vscodeDir = vscode.Uri.joinPath(workspaceFolder.uri, '.vscode');
    const launchJsonPath = vscode.Uri.joinPath(workspaceFolder.uri, '.vscode', 'launch.json');

    try {
      await vscode.workspace.fs.createDirectory(vscodeDir);

      let existingConfig: any = { configurations: [], inputs: [] };
      try {
        const launchData = await vscode.workspace.fs.readFile(launchJsonPath);
        existingConfig = JSON.parse(Buffer.from(launchData).toString('utf8'));
      } catch {
        existingConfig = { configurations: [], inputs: [] };
      }

      const newConfigurations = this.generateLaunchConfigurations(runningInstances);
      const kbConfigs = newConfigurations.filter(item => item.name?.startsWith('KBEngine:'));
      const userConfigs = (existingConfig.configurations || []).filter(
        (item: any) => !item.name?.startsWith('KBEngine:')
      );

      const finalConfig = {
        version: existingConfig.version || '0.2.0',
        configurations: [...userConfigs, ...kbConfigs],
        inputs: this.generateLaunchInputs(existingConfig.inputs || [])
      };

      await vscode.workspace.fs.writeFile(
        launchJsonPath,
        Buffer.from(JSON.stringify(finalConfig, null, 2), 'utf8')
      );

      vscode.window.showInformationMessage('launch.json 已更新为 KBEngine Python 附加配置（telnet 开启调试后经进程选择器附加）');
      return true;
    } catch (error) {
      vscode.window.showErrorMessage(`更新 launch.json 失败: ${error}`);
      return false;
    }
  }

  async createExampleConfig(): Promise<boolean> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      vscode.window.showErrorMessage('没有打开的工作区');
      return false;
    }

    const kbengineDir = vscode.Uri.joinPath(workspaceFolder.uri, '.kbengine');

    try {
      await vscode.workspace.fs.createDirectory(kbengineDir);

      const exampleConfig: DebugConfigFile = {
        version: '1.0.0',
        debug: {
          defaultTelnetHost: '127.0.0.1',
          defaultTelnetPort: 0,
          components: {
            baseapp: {
              telnetHost: '127.0.0.1',
              telnetPort: 40000,
              telnetPassword: 'pwd123456',
              telnetDefaultLayer: 'python',
              telnetEnableCommands: [
                '# 先连接源码默认 telnet 端口，再根据项目实际环境输入开启 Python 调试的命令',
                '# KBEngine 源码只明确提供 telnet 控制端口，不内置 debugpy 命令格式'
              ],
              pathMappings: [{
                localRoot: '${workspaceFolder}',
                remoteRoot: '${workspaceFolder}'
              }]
            },
            cellapp: {
              telnetHost: '127.0.0.1',
              telnetPort: 50000,
              telnetPassword: 'pwd123456',
              telnetDefaultLayer: 'python',
              telnetEnableCommands: []
            },
            loginapp: {
              telnetHost: '127.0.0.1',
              telnetPort: 31000,
              telnetPassword: 'pwd123456',
              telnetDefaultLayer: 'python',
              telnetEnableCommands: []
            }
          }
        }
      };

      const configPath = vscode.Uri.joinPath(kbengineDir, 'debug.json');
      await vscode.workspace.fs.writeFile(
        configPath,
        Buffer.from(JSON.stringify(exampleConfig, null, 2), 'utf8')
      );

      vscode.window.showInformationMessage('示例调试配置已创建: .kbengine/debug.json');
      return true;
    } catch (error) {
      vscode.window.showErrorMessage(`创建调试配置失败: ${error}`);
      return false;
    }
  }

  async startDebugging(componentName: string): Promise<boolean> {
    const config = this.getComponentConfig(componentName);
    // 不可达(批68 定性):telnetEnableCommands 与下方 password/layer 同族——
    // getComponentConfig 已归一化(`userConfig?.telnetEnableCommands || []`),
    // 产出恒为真值数组 ⇒ `|| []` 兜底右臂无触发路径。语句与两分支条目
    // 随区间移出分母(TESTING.md 分母口径据实登记);真臂行为由既有
    // startDebugging 编排用例锁定。
    /* istanbul ignore start */
    const telnetLines = (config.telnetEnableCommands || []).filter(Boolean);
    /* istanbul ignore stop */
    const telnetCommand = `telnet ${config.telnetHost || '127.0.0.1'} ${config.telnetPort || 0}`;
    const telnetMeta = [
      // 以下两处 `||` 右臂不可达(批68 定性):config 出自 getComponentConfig,
      // 其 telnetPassword/telnetDefaultLayer 已做同款归一化
      // (`userConfig?.x || 'pwd123456'/'python'`),产出恒为非空字符串 ⇒
      // 此处的左操作数恒真,兜底右臂无触发路径。语句与两分支条目随区间
      // 移出分母(TESTING.md 分母口径据实登记);真臂行为由既有
      // startDebugging 简报断言锁定。
      /* istanbul ignore start */
      `password: ${config.telnetPassword || 'pwd123456'}`,
      `default layer: ${config.telnetDefaultLayer || 'python'}`
      /* istanbul ignore stop */
    ];

    const message = telnetLines.length > 0
      ? [
          `KBEngine ${componentName} 调试以 telnet 控制端口为前提，再经进程选择器做 Python 附加。`,
          telnetCommand,
          ...telnetMeta,
          ...telnetLines
        ].join('\n')
      : [
          `KBEngine ${componentName} 调试不是直接启动 Python 文件。`,
          `请先连接 telnet 控制端口确认或开启你的项目调试入口，再经进程选择器附加。`,
          telnetCommand,
          ...telnetMeta
        ].join('\n');

    const action = await vscode.window.showInformationMessage(
      message,
      { modal: true },
      '继续附加'
    );

    if (action !== '继续附加') {
      return false;
    }

    return this.attachToComponent(componentName);
  }

  /** 列出本机进程(ps/tasklist;命令失败返回空清单;清单器可注入便于测试) */
  private listProcesses(): ProcessEntry[] {
    return this.deps.listProcesses?.() ?? makeProcessLister(command =>
      child_process.execSync(command, { encoding: 'utf8' })
    )();
  }

  /**
   * 进程选择(批112 用户令:不只列 PID,还要能按进程名过滤):组件名
   * (不区分大小写子串)命中的进程置顶并带 $(check) 标记,其余进程随后
   * (扩展基线 @types/vscode 1.50 无 QuickPickItemKind 分隔条,分组以
   * 置顶 + 图标呈现);取消/未选返回 undefined,附加流程就此终止。
   */
  async pickProcessId(componentName: string): Promise<number | undefined> {
    const processes = this.listProcesses();
    if (processes.length === 0) {
      vscode.window.showErrorMessage('未获取到进程列表,无法附加(请确认目标机器上进程可见)');
      return undefined;
    }
    const needle = componentName.toLowerCase();
    const matches = processes.filter(item => item.name.toLowerCase().includes(needle));
    const rest = processes.filter(item => !item.name.toLowerCase().includes(needle));
    const toItem = (entry: ProcessEntry): vscode.QuickPickItem => ({
      label: entry.name,
      description: String(entry.pid)
    });
    const items: vscode.QuickPickItem[] = [
      ...matches.map(entry => ({ ...toItem(entry), label: `$(check) ${entry.name}` })),
      ...rest.map(toItem)
    ];
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: `选择要附加的 ${componentName} 进程(✓ 匹配组件名的进程已置顶)`
    });
    if (!picked) {
      return undefined;
    }
    const pid = Number(picked.description);
    return Number.isFinite(pid) && pid > 0 ? pid : undefined;
  }

  async attachToComponent(componentName: string): Promise<boolean> {
    const config = this.getComponentConfig(componentName);
    // 批112 用户令:附加前弹进程选择器,组件名命中的进程置顶分组,
    // 选中的 PID 直接写入附加配置(取消/空清单则不附加)
    const processId = await this.pickProcessId(componentName);
    if (processId === undefined) {
      return false;
    }
    const attachConfig: vscode.DebugConfiguration = {
      name: `KBEngine: Python attach to ${componentName}`,
      type: this.getDebuggerType(),
      request: 'attach',
      processId,
      pathMappings: config.pathMappings,
      justMyCode: false
    };

    try {
      const outcome = await this.startAttachGuarded(
        `${componentName} (pid ${processId})`,
        attachConfig
      );
      return outcome.status === 'completed' && outcome.success;
    } catch (error) {
      vscode.window.showErrorMessage(`附加调试失败: ${error}`);
      return false;
    }
  }

  /**
   * 远程附加(批112 用户令:配置服务器 IP 数组,点击远程弹目标选择):
   * debugpy connect 模式,远端需已监听(通常先经 telnet 发开调试命令);
   * 未配置目标则提示去设置,不弹空选择。
   */
  async attachRemote(): Promise<boolean> {
    const targets = readRemoteTargets();
    if (targets.length === 0) {
      vscode.window.showInformationMessage(
        '尚未配置远程调试目标:请在设置 kbengine.debug.remoteTargets 添加服务器列表(名称 + IP + debugpy 端口)'
      );
      return false;
    }
    const picked = await vscode.window.showQuickPick(
      targets.map(target => ({
        label: target.name,
        description: `${target.host}:${target.port}`
      })),
      { placeHolder: '选择远程调试目标' }
    );
    if (!picked) {
      return false;
    }
    const target = targets.find(
      item => item.name === picked.label && `${item.host}:${item.port}` === picked.description
    );
    if (!target) {
      return false;
    }
    const action = await vscode.window.showInformationMessage(
      `远程附加前请确认 ${target.host}:${target.port} 已有 debugpy 监听(通常先经 telnet 发开启调试命令)。开始附加?`,
      { modal: true },
      '开始附加'
    );
    if (action !== '开始附加') {
      return false;
    }
    const attachConfig: vscode.DebugConfiguration = {
      name: `KBEngine: Python attach ${target.name} (remote)`,
      type: this.getDebuggerType(),
      request: 'attach',
      connect: {
        host: target.host,
        port: target.port
      },
      justMyCode: false,
      // DBG-002:目标带成对映射才写(与 launch.json 远程条目同口径)
      pathMappings: remoteTargetPathMappings(target)
    };
    try {
      const outcome = await this.startAttachGuarded(
        `${target.name} ${target.host}:${target.port}`,
        attachConfig
      );
      return outcome.status === 'completed' && outcome.success;
    } catch (error) {
      vscode.window.showErrorMessage(`附加远程调试失败: ${error}`);
      return false;
    }
  }

  /**
   * DBG-007 带截止与取消的附加入口:进度通知可取消(取消=停掉卡住的
   * 会话,不再重试),kbengine.debug.attachTimeoutMs 到点同路径停止——
   * 无人监听的端口不会让入口永久等待;<=0 不限时。条期完成/错误语义
   * 与裸 startDebugging 一致(错误原样抛给调用方既有 catch)。
   * IDE-REV-002:停止面只停本次附加——onDidStartDebugSession 按本配置名
   * 捕获自家会话句柄,截止/取消向该句柄调用 stopDebugging;无参调用会把
   * 并行运行的无关会话一并停掉。自家会话尚未启动(挂起在 TCP 连接)则无
   * 句柄可停,不强杀他人;迟到启动的会话清理由 IDE-REV-003 接续。
   */
  private async startAttachGuarded(
    label: string,
    attachConfig: vscode.DebugConfiguration
  ): Promise<AttachGuardOutcome> {
    let ownSession: vscode.DebugSession | undefined;
    let cleanupDone = false;
    let trackerDisposed = false;
    const sessionTracker = vscode.debug.onDidStartDebugSession(session => {
      if (!ownSession && session.name === attachConfig.name) {
        ownSession = session;
      }
    });
    // 会话追踪订阅必须活到 start 落定:迟到成功的会话在闸返回后才启动,
    // 提前 dispose 会捕获不到句柄;两种落定(timely/迟到)各释放一次,幂等
    const disposeTracker = (): void => {
      if (trackerDisposed) { return; }
      trackerDisposed = true;
      sessionTracker.dispose();
    };
    // 清理恰一次:窗内停止(REV-002)与迟到成功清理(REV-003)共用,先到先清
    const cleanupOwnSession = (): void => {
      if (cleanupDone || !ownSession) { return; }
      cleanupDone = true;
      void vscode.debug.stopDebugging(ownSession).then(() => undefined, () => undefined);
    };
    try {
      return await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `附加调试 ${label}(等待连接,可取消)`,
          cancellable: true
        },
        (_progress, token) =>
          attachWithDeadline({
            label,
            timeoutMs: vscode.workspace
              .getConfiguration('kbengine')
              .get<number>('debug.attachTimeoutMs', DEBUG_ATTACH_TIMEOUT_DEFAULT_MS),
            start: () => Promise.resolve(vscode.debug.startDebugging(undefined, attachConfig)),
            // IDE-REV-002:窗内截止/取消只停自家会话;stopDebugging(undefined)
            // 等同无参(停全部)——无自家句柄就一次都不停,迟到面由 REV-003 接
            stop: () => cleanupOwnSession(),
            // IDE-REV-003:超时/取消返回后 start 才落定——迟到成功时自家会话
            // 此刻才创建,清一次且不二次提示;迟到异常同样只经此回调不外泄;
            // 两种落定都释放追踪订阅
            onStartSettled: late => {
              if (late) { cleanupOwnSession(); }
              disposeTracker();
            },
            notify: message => void vscode.window.showWarningMessage(message),
            onCancel: listener => token.onCancellationRequested(() => listener())
          })
      );
    } finally {
      disposeTracker();
    }
  }

  getConfig(): KBEngineDebugConfig {
    return this.config;
  }

  dispose(): void {
    if (this.configWatcher) {
      this.configWatcher.dispose();
    }
    this._onDidChangeConfig.dispose();
  }
}
