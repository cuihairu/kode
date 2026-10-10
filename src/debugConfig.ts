import * as child_process from 'child_process';
import * as vscode from 'vscode';

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

const SOURCE_DEFAULT_COMPONENTS: Array<{
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
}

/** debugpy 默认监听端口(debugpy --listen 不带端口时的约定值) */
const DEFAULT_DEBUGPY_PORT = 5678;

/**
 * 读取 kbengine.debug.remoteTargets(批112 用户令):name/host 缺一不收,
 * port 缺省/非法落 debugpy 默认 5678。
 */
export function readRemoteTargets(): RemoteDebugTarget[] {
  const config = vscode.workspace.getConfiguration('kbengine');
  const raw = config.get<Array<{ name?: string; host?: string; port?: number }>>(
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
    targets.push({ name, host, port });
  }
  return targets;
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
      const configFile: DebugConfigFile = JSON.parse(Buffer.from(configData).toString('utf8'));
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

  generateLaunchConfigurations(): any[] {
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
    // 远端需已起 debugpy 监听;远程无本地源码映射,不写 pathMappings)
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
        presentation: {
          group: 'KBEngine',
          order: 2
        }
      });
    }

    return configurations;
  }

  async updateLaunchJson(): Promise<boolean> {
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

      const newConfigurations = this.generateLaunchConfigurations();
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
      const success = await vscode.debug.startDebugging(undefined, attachConfig);
      return success === true;
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
      justMyCode: false
    };
    try {
      const success = await vscode.debug.startDebugging(undefined, attachConfig);
      return success === true;
    } catch (error) {
      vscode.window.showErrorMessage(`附加远程调试失败: ${error}`);
      return false;
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
