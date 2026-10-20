import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ChildProcess, spawn } from 'child_process';
import { LogHub, RuntimeLogLevel } from './logHub';
import { ProcessManager } from './processManager';
import { joinWorkspacePath, usesPosixPath } from './workspacePath';
import { hasEngineConfigProbe, resolveDiscoveredConfigRoot, resolveKbeSourceRoot } from './workspaceDiscovery';

/**
 * KBEngine 服务器组件信息
 */
export interface ServerComponent {
  name: string;
  displayName: string;
  executable: string;
  defaultArgs?: string[];
  order: number;
  required: boolean;
  description: string;
}

/**
 * KBEngine 服务器组件定义
 */
export const SERVER_COMPONENTS: ServerComponent[] = [
  {
    name: 'machine',
    displayName: 'Machine',
    executable: 'machine',
    defaultArgs: ['--cid=2129652375332859700', '--gus=1'],
    order: 1,
    required: true,
    description: '机器管理器（必须最先启动）'
  },
  {
    name: 'logger',
    displayName: 'Logger',
    executable: 'logger',
    defaultArgs: ['--cid=1129653375331859700', '--gus=2'],
    order: 2,
    required: false,
    description: '日志服务器'
  },
  {
    name: 'interfaces',
    displayName: 'Interfaces',
    executable: 'interfaces',
    defaultArgs: ['--cid=1129652375332859700', '--gus=3'],
    order: 3,
    required: false,
    description: '外部接口服务'
  },
  {
    name: 'dbmgr',
    displayName: 'DBMgr',
    executable: 'dbmgr',
    defaultArgs: ['--cid=3129652375332859700', '--gus=4'],
    order: 4,
    required: true,
    description: '数据库管理器'
  },
  {
    name: 'baseappmgr',
    displayName: 'BaseAppMgr',
    executable: 'baseappmgr',
    defaultArgs: ['--cid=4129652375332859700', '--gus=5'],
    order: 5,
    required: true,
    description: 'BaseApp 管理器'
  },
  {
    name: 'cellappmgr',
    displayName: 'CellAppMgr',
    executable: 'cellappmgr',
    defaultArgs: ['--cid=5129652375332859700', '--gus=6'],
    order: 6,
    required: true,
    description: 'CellApp 管理器'
  },
  {
    name: 'baseapp',
    displayName: 'BaseApp',
    executable: 'baseapp',
    defaultArgs: ['--cid=6129652375332859700', '--gus=7'],
    order: 7,
    required: true,
    description: '网关服务器'
  },
  {
    name: 'cellapp',
    displayName: 'CellApp',
    executable: 'cellapp',
    defaultArgs: ['--cid=7129652375332859700', '--gus=8'],
    order: 8,
    required: true,
    description: '游戏服务器'
  },
  {
    name: 'loginapp',
    displayName: 'LoginApp',
    executable: 'loginapp',
    defaultArgs: ['--cid=8129652375332859700', '--gus=9'],
    order: 9,
    required: true,
    description: '登录服务器'
  },
  {
    name: 'bots',
    displayName: 'Bots',
    executable: 'bots',
    defaultArgs: ['--gus=1'],
    order: 10,
    required: false,
    description: '机器人测试客户端'
  }
];

/**
 * 服务器进程状态
 */
export enum ServerStatus {
  Stopped = 'stopped',
  Starting = 'starting',
  Running = 'running',
  Stopping = 'stopping',
  Error = 'error'
}

/**
 * 运行中的服务器信息
 */
export interface RunningServer {
  component: ServerComponent;
  process: ChildProcess;
  pid: number;
  status: ServerStatus;
  startTime: Date;
  logs: string[];
}

/**
 * 进程启动端口(docs/redesign.md L2):默认实现透传 child_process.spawn,
 * 生产行为不变;测试可注入记录型/故障注入型 runner,或与
 * tests/sim/fakeComponentBin 的假组件二进制组合做真实进程编排。
 */
export interface ProcessRunner {
  spawn(command: string, args: string[], options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    windowsHide: true;
  }): ChildProcess;
}

const defaultProcessRunner: ProcessRunner = {
  spawn: (command, args, options) => spawn(command, args, options)
};

function ensureTrailingSeparator(value: string): string {
  if (!value) {
    return value;
  }

  return value.endsWith(path.sep) ? value : `${value}${path.sep}`;
}

/**
 * KBEngine 服务器管理器
 */
export class KBEngineServerManager {
  private runningServers: Map<string, RunningServer> = new Map();
  readonly logHub: LogHub;
  readonly processManager: ProcessManager;
  private readonly logSubscriptions: Array<() => void> = [];
  private _onDidChangeStatus = new vscode.EventEmitter<void>();
  readonly onDidChangeStatus = this._onDidChangeStatus.event;

  private outputChannels: Map<string, vscode.OutputChannel> = new Map();

  constructor(
    private context: vscode.ExtensionContext,
    private readonly processRunner: ProcessRunner = defaultProcessRunner,
    logHub?: LogHub
  ) {
    this.logHub = logHub ?? new LogHub({ flushIntervalMs: 25, maxListeners: 256 });
    // TODO: Watch process-owned log files once the server manager exposes a
    // component-to-logfile mapping. Registering arbitrary guessed paths would
    // repeatedly emit fs errors into the runtime log stream.
    this.processManager = new ProcessManager(request => this.processRunner.spawn(request.command, [...(request.args ?? [])], {
      cwd: request.cwd ?? process.cwd(),
      env: request.env ?? process.env,
      windowsHide: true
    }), this.logHub);
    this.logSubscriptions.push(this.processManager.onState(event => {
      const server = this.runningServers.get(event.id);
      if (!server) return;
      if (event.state === 'starting') server.status = ServerStatus.Starting;
      if (event.state === 'running') server.status = ServerStatus.Running;
      if (event.state === 'stopping') server.status = ServerStatus.Stopping;
      if (event.state === 'error') server.status = ServerStatus.Error;
      if (event.state === 'running') {
        vscode.window.showInformationMessage(`${server.component.displayName} 启动成功 (PID: ${server.pid})`);
      }
      if (event.state === 'exited' || event.state === 'error') this.runningServers.delete(event.id);
      this._onDidChangeStatus.fire();
    }));
    this.logSubscriptions.push(this.logHub.onBatch(batch => {
      const current = [...this.runningServers.entries()];
      current.forEach(([name, server]) => {
        const events = batch.events.filter(event => event.component === name);
        if (events.length > 0) server.logs.push(...events.map(event => event.text));
      });
      batch.events.forEach(event => {
        const level = event.level <= RuntimeLogLevel.INFO ? '[INFO]' : event.level === RuntimeLogLevel.WARNING ? '[WARN]' : '[ERROR]';
        this.outputChannels.get(event.component)?.appendLine(`${level} ${event.text}`);
      });
    }));
  }

  /**
   * 获取 KBEngine 二进制路径
   */
  getBinPath(): string {
    const config = vscode.workspace.getConfiguration('kbengine');
    let binPath = config.get<string>('binPath', '');

    if (!binPath) {
      // 尝试自动检测
      binPath = this.detectBinPath();
    }

    // 解析变量
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    binPath = binPath
      .replace(/\$\{workspaceFolder\}/g, workspaceFolder)
      .replace(/\$\{env:(.+?)\}/g, (_, envVar) => process.env[envVar] || '');
    // 相对值以仓库根为基准(不许假设 cwd);无根可锚 → 空串。
    // 绝对判定含 win32 语义:Linux/macOS 主机上 path.isAbsolute 对
    // `D:\...` 判假会把 Windows 风格 binPath 锚到 workspace 根下。
    if (binPath && !path.isAbsolute(binPath) && !path.win32.isAbsolute(binPath)) {
      binPath = workspaceFolder ? path.join(workspaceFolder, binPath) : '';
    }

    return binPath;
  }

  /**
   * 自动检测 KBEngine 二进制路径
   */
  private detectBinPath(): string {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceFolder) {
      return '';
    }

    // 批125 自动发现:引擎源码根锚点(entitydef.cpp / entity_table_mysql.cpp)
    // 命中时直接推导 kbe/bin/server,优先于逐个猜兄弟目录
    const kbeSourceRoot = resolveKbeSourceRoot(workspaceFolder);
    const possiblePaths = [
      kbeSourceRoot ? path.join(kbeSourceRoot, 'bin', 'server') : '',
      joinWorkspacePath(workspaceFolder, '../kbe/bin/server'),
      joinWorkspacePath(workspaceFolder, '../../kbe/bin/server'),
      joinWorkspacePath(workspaceFolder, '../kbengine/kbe/bin/server'),
      joinWorkspacePath(workspaceFolder, '../../kbengine/kbe/bin/server'),
      process.env.KBENGINE_HOME ? path.join(process.env.KBENGINE_HOME, 'kbe/bin/server') : '',
      process.env.KBENGINE_HOME ? path.join(process.env.KBENGINE_HOME, 'kbe/bin') : '',
      'D:/kbengine/kbe/bin/server',
      'D:/kbengine/kbe/bin',
      'D:/kbe/bin/server',
      '/usr/local/kbengine/kbe/bin',
      '/opt/kbengine/kbe/bin'
    ];

    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        return p;
      }
    }

    return '';
  }

  /**
   * 获取配置文件路径:原值(默认或显式)以引擎装载探针验收,未通过时用
   * 发现兜底(约定 → 记忆选择 → 唯一深扫描,批128);都失败则原样返回,
   * 让启动检查链给出带期望形态的报错
   */
  getConfigPath(): string {
    const config = vscode.workspace.getConfiguration('kbengine');
    let configPath = config.get<string>('assetsRoot', '');

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    configPath = configPath.replace(/\$\{workspaceFolder\}/g, workspaceFolder);
    // 相对值以仓库根为基准(不许假设 cwd);无根可锚 → 空串(启动检查链报「未配置」)
    if (configPath && !path.isAbsolute(configPath)) {
      configPath = workspaceFolder ? path.join(workspaceFolder, configPath) : '';
    }

    if (configPath && hasEngineConfigProbe(configPath)) {
      return configPath;
    }
    const discovered = workspaceFolder ? resolveDiscoveredConfigRoot(workspaceFolder) : null;
    return discovered || configPath;
  }

  private detectKbeRoot(binPath: string): string {
    if (process.env.KBE_ROOT) {
      return process.env.KBE_ROOT;
    }

    if (!binPath) {
      return '';
    }

    const normalized = path.normalize(binPath);
    const suffix = path.normalize(path.join('kbe', 'bin', 'server'));
    if (normalized.endsWith(suffix)) {
      return normalized.slice(0, -(suffix.length + 1));
    }

    return '';
  }

  private buildComponentEnvironment(configPath: string, binPath: string): NodeJS.ProcessEnv {
    const env = { ...process.env };
    const kbeRoot = this.detectKbeRoot(binPath);

    if (kbeRoot) {
      env.KBE_ROOT = kbeRoot;
      env.KBE_RES_PATH = [
        joinWorkspacePath(kbeRoot, 'kbe', 'res'),
        configPath,
        joinWorkspacePath(configPath, 'res'),
        joinWorkspacePath(configPath, 'scripts')
      ].join(path.delimiter);
    }

    env.KBE_BIN_PATH = ensureTrailingSeparator(binPath);
    return env;
  }

  /**
   * 获取可执行文件的完整路径
   */
  getExecutablePath(component: ServerComponent): string {
    const binPath = this.getBinPath();
    const isWindows = process.platform === 'win32' && !usesPosixPath(binPath);
    const exeName = isWindows ? `${component.executable}.exe` : component.executable;
    return joinWorkspacePath(binPath, exeName);
  }

  /**
   * 获取输出通道
   */
  private getOutputChannel(component: ServerComponent): vscode.OutputChannel {
    let channel = this.outputChannels.get(component.name);
    if (!channel) {
      channel = vscode.window.createOutputChannel(`KBEngine: ${component.displayName}`);
      this.outputChannels.set(component.name, channel);
    }
    return channel;
  }

  private log(component: ServerComponent, level: RuntimeLogLevel, text: string): void {
    this.getOutputChannel(component).appendLine(`${level === RuntimeLogLevel.WARNING ? '[WARN]' : level === RuntimeLogLevel.ERROR ? '[ERROR]' : '[INFO]'} ${text}`);
    this.logHub.ingest({ source: 'process', component: component.name, level, text });
  }

  /**
   * 启动单个组件
   */
  async startComponent(component: ServerComponent): Promise<boolean> {
    // 检查是否已运行
    if (this.runningServers.has(component.name)) {
      vscode.window.showWarningMessage(`${component.displayName} 已在运行中`);
      return false;
    }

    const exePath = this.getExecutablePath(component);
    const binPath = this.getBinPath();
    const configPath = this.getConfigPath();

    // 检查可执行文件是否存在
    if (!fs.existsSync(exePath)) {
      vscode.window.showErrorMessage(
        `找不到 ${component.executable} 可执行文件：${exePath}`
      );
      return false;
    }

    if (!configPath) {
      vscode.window.showErrorMessage(
        'KBEngine 配置目录为空，请检查 kbengine.assetsRoot（应指向资产根，其下应有 res/server/kbengine.xml 与 scripts/）'
      );
      return false;
    }

    if (!fs.existsSync(configPath)) {
      vscode.window.showErrorMessage(
        `找不到 KBEngine 配置目录：${configPath}（应指向资产根，其下应有 res/server/kbengine.xml 与 scripts/）`
      );
      return false;
    }

    const configStat = fs.statSync(configPath);
    if (!configStat.isDirectory()) {
      vscode.window.showErrorMessage(`KBEngine 配置路径不是目录：${configPath}`);
      return false;
    }

    // 批127:引擎期望的 res/server/kbengine.xml 不在时不拦截启动(引擎可能
    // 有别的取法),但在输出通道留可见警告,用户可把日志贴回来定位
    if (!hasEngineConfigProbe(configPath)) {
      this.log(component, RuntimeLogLevel.WARNING,
        `期望的引擎配置文件不存在：${path.join(configPath, 'res', 'server', 'kbengine.xml')}（启动可能失败）`);
    }

    this.log(component, RuntimeLogLevel.INFO, `正在启动 ${component.displayName}...`);
    this.log(component, RuntimeLogLevel.INFO, `可执行文件: ${exePath}`);
    this.log(component, RuntimeLogLevel.INFO, `配置目录: ${configPath}`);
    this.log(component, RuntimeLogLevel.INFO, `启动参数: ${(component.defaultArgs || []).join(' ') || '(none)'}`);

    try {
      const managed = this.processManager.start({
        id: component.name,
        command: exePath,
        args: component.defaultArgs || [],
        cwd: configPath,
        env: this.buildComponentEnvironment(configPath, binPath),
        component: component.name,
        readyAfterMs: 1000
      });
      void managed;

      const runningServer: RunningServer = {
        component,
        process: managed.process,
        pid: managed.pid,
        status: ServerStatus.Starting,
        startTime: new Date(),
        logs: []
      };

      this.runningServers.set(component.name, runningServer);

      this._onDidChangeStatus.fire();
      return true;

    } catch (error) {
      this.log(component, RuntimeLogLevel.ERROR, `启动失败: ${String(error)}`);
      return false;
    }
  }

  /**
   * 停止单个组件
   */
  async stopComponent(componentName: string): Promise<boolean> {
    const runningServer = this.runningServers.get(componentName);
    if (!runningServer) {
      return false;
    }

    this.log(runningServer.component, RuntimeLogLevel.INFO, `正在停止 ${runningServer.component.displayName}...`);

    const stopped = await this.processManager.stop(componentName);
    this.log(
      runningServer.component,
      RuntimeLogLevel.INFO,
      `${runningServer.component.displayName} ${stopped ? '已停止' : '停止失败'}`
    );
    return stopped;
  }

  /**
   * 启动所有配置的组件
   */
  async startAutoComponents(): Promise<void> {
    const config = vscode.workspace.getConfiguration('kbengine');
    const autoStart: string[] = config.get('autoStart', ['machine', 'logger', 'dbmgr']);

    // 按启动顺序排序
    const componentsToStart = SERVER_COMPONENTS
      .filter(c => autoStart.includes(c.name))
      .sort((a, b) => a.order - b.order);

    for (const component of componentsToStart) {
      await this.startComponent(component);
      // 等待一段时间再启动下一个
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  /**
   * 停止所有组件
   */
  async stopAll(): Promise<void> {
    const running = Array.from(this.runningServers.entries());

    // 按启动顺序的逆序停止
    running.sort((a, b) => b[1].component.order - a[1].component.order);

    for (const [name] of running) {
      await this.stopComponent(name);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  /**
   * 获取所有服务器状态
   */
  getAllServers(): ServerComponent[] {
    return SERVER_COMPONENTS;
  }

  /**
   * 获取运行中的服务器
   */
  getRunningServers(): Map<string, RunningServer> {
    return this.runningServers;
  }

  /**
   * 显示组件对应的输出通道
   */
  showComponentLogs(componentName: string): boolean {
    const component = SERVER_COMPONENTS.find(item => item.name === componentName);
    if (!component) {
      return false;
    }

    const outputChannel = this.getOutputChannel(component);
    this.logHub.getRetained()
      .filter(event => event.component === componentName)
      .forEach(event => outputChannel.appendLine(event.text));
    outputChannel.show(true);
    return true;
  }

  /**
   * 获取服务器状态
   */
  getServerStatus(componentName: string): ServerStatus {
    const server = this.runningServers.get(componentName);
    return server?.status || ServerStatus.Stopped;
  }

  /**
   * 重启组件
   */
  async restartComponent(componentName: string): Promise<boolean> {
    await this.stopComponent(componentName);
    await new Promise(resolve => setTimeout(resolve, 1000));

    const component = SERVER_COMPONENTS.find(c => c.name === componentName);
    if (!component) {
      return false;
    }

    return this.startComponent(component);
  }

  /**
   * 清理资源
   */
  async dispose(): Promise<void> {
    await this.processManager.dispose();
    this.logSubscriptions.forEach(dispose => dispose());
    this.outputChannels.forEach(channel => channel.dispose());
    this.runningServers.clear();
    this._onDidChangeStatus.dispose();
  }
}
