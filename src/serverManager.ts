import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';

/**
 * KBEngine 服务器组件信息
 */
export interface ServerComponent {
  name: string;
  displayName: string;
  executable: string;
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
    order: 1,
    required: true,
    description: '机器管理器（必须最先启动）'
  },
  {
    name: 'logger',
    displayName: 'Logger',
    executable: 'logger',
    order: 2,
    required: false,
    description: '日志服务器'
  },
  {
    name: 'dbmgr',
    displayName: 'DBMgr',
    executable: 'dbmgr',
    order: 3,
    required: true,
    description: '数据库管理器'
  },
  {
    name: 'baseappmgr',
    displayName: 'BaseAppMgr',
    executable: 'baseappmgr',
    order: 4,
    required: true,
    description: 'BaseApp 管理器'
  },
  {
    name: 'cellappmgr',
    displayName: 'CellAppMgr',
    executable: 'cellappmgr',
    order: 5,
    required: true,
    description: 'CellApp 管理器'
  },
  {
    name: 'loginapp',
    displayName: 'LoginApp',
    executable: 'loginapp',
    order: 6,
    required: true,
    description: '登录服务器'
  },
  {
    name: 'baseapp',
    displayName: 'BaseApp',
    executable: 'baseapp',
    order: 7,
    required: true,
    description: '网关服务器'
  },
  {
    name: 'cellapp',
    displayName: 'CellApp',
    executable: 'cellapp',
    order: 8,
    required: true,
    description: '游戏服务器'
  },
  {
    name: 'bots',
    displayName: 'Bots',
    executable: 'bots',
    order: 9,
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
 * KBEngine 服务器管理器
 */
export class KBEngineServerManager {
  private runningServers: Map<string, RunningServer> = new Map();
  private _onDidChangeStatus = new vscode.EventEmitter<void>();
  readonly onDidChangeStatus = this._onDidChangeStatus.event;

  private outputChannels: Map<string, vscode.OutputChannel> = new Map();

  constructor(private context: vscode.ExtensionContext) {}

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

    const possiblePaths = [
      path.join(workspaceFolder, '../kbe/bin/server'),
      path.join(workspaceFolder, '../../kbe/bin/server'),
      path.join(workspaceFolder, '../kbengine/kbe/bin/server'),
      path.join(workspaceFolder, '../../kbengine/kbe/bin/server'),
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
   * 获取配置文件路径
   */
  getConfigPath(): string {
    const config = vscode.workspace.getConfiguration('kbengine');
    let configPath = config.get<string>('configPath', '');

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    configPath = configPath.replace(/\$\{workspaceFolder\}/g, workspaceFolder);

    return configPath;
  }

  /**
   * 获取可执行文件的完整路径
   */
  getExecutablePath(component: ServerComponent): string {
    const binPath = this.getBinPath();
    const isWindows = process.platform === 'win32';
    const exeName = isWindows ? `${component.executable}.exe` : component.executable;
    return path.join(binPath, exeName);
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
    const configPath = this.getConfigPath();

    // 检查可执行文件是否存在
    if (!fs.existsSync(exePath)) {
      vscode.window.showErrorMessage(
        `找不到 ${component.executable} 可执行文件：${exePath}`
      );
      return false;
    }

    if (!configPath) {
      vscode.window.showErrorMessage('KBEngine 配置目录为空，请检查 kbengine.configPath');
      return false;
    }

    if (!fs.existsSync(configPath)) {
      vscode.window.showErrorMessage(`找不到 KBEngine 配置目录：${configPath}`);
      return false;
    }

    const configStat = fs.statSync(configPath);
    if (!configStat.isDirectory()) {
      vscode.window.showErrorMessage(`KBEngine 配置路径不是目录：${configPath}`);
      return false;
    }

    const outputChannel = this.getOutputChannel(component);
    outputChannel.show();
    outputChannel.appendLine(`[INFO] 正在启动 ${component.displayName}...`);
    outputChannel.appendLine(`[INFO] 可执行文件: ${exePath}`);
    outputChannel.appendLine(`[INFO] 配置目录: ${configPath}`);

    try {
      const childProcess = spawn(exePath, [], {
        cwd: configPath,
        env: { ...process.env }
      });

      const runningServer: RunningServer = {
        component,
        process: childProcess,
        pid: childProcess.pid ?? 0,
        status: ServerStatus.Starting,
        startTime: new Date(),
        logs: []
      };

      this.runningServers.set(component.name, runningServer);

      // 监听进程输出
      childProcess.stdout?.on('data', (data: Buffer) => {
        const message = data.toString();
        runningServer.logs.push(message);
        outputChannel.append(message);
      });

      childProcess.stderr?.on('data', (data: Buffer) => {
        const message = data.toString();
        runningServer.logs.push(message);
        outputChannel.append(`[ERROR] ${message}`);
      });

      childProcess.on('error', (error: Error) => {
        outputChannel.appendLine(`[ERROR] 进程错误: ${error.message}`);
        runningServer.status = ServerStatus.Error;
        this._onDidChangeStatus.fire();
      });

      childProcess.on('exit', (code: number | null, signal: string | null) => {
        outputChannel.appendLine(`[INFO] 进程退出: code=${code}, signal=${signal}`);
        this.runningServers.delete(component.name);
        this._onDidChangeStatus.fire();
      });

      // 延迟标记为运行中
      setTimeout(() => {
        if (this.runningServers.has(component.name)) {
          runningServer.status = ServerStatus.Running;
          this._onDidChangeStatus.fire();
          vscode.window.showInformationMessage(`${component.displayName} 启动成功 (PID: ${runningServer.pid})`);
        }
      }, 1000);

      this._onDidChangeStatus.fire();
      return true;

    } catch (error) {
      outputChannel.appendLine(`[ERROR] 启动失败: ${error}`);
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

    const outputChannel = this.getOutputChannel(runningServer.component);
    outputChannel.show();
    outputChannel.appendLine(`[INFO] 正在停止 ${runningServer.component.displayName}...`);

    runningServer.status = ServerStatus.Stopping;
    this._onDidChangeStatus.fire();

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        // 强制杀死进程
        runningServer.process.kill('SIGKILL');
        this.runningServers.delete(componentName);
        this._onDidChangeStatus.fire();
        outputChannel.appendLine(`[INFO] ${runningServer.component.displayName} 已强制停止`);
        resolve(true);
      }, 5000);

      runningServer.process.on('exit', () => {
        clearTimeout(timeout);
        this.runningServers.delete(componentName);
        this._onDidChangeStatus.fire();
        outputChannel.appendLine(`[INFO] ${runningServer.component.displayName} 已停止`);
        resolve(true);
      });

      // 尝试正常退出
      runningServer.process.kill('SIGTERM');
    });
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
  dispose(): void {
    this.outputChannels.forEach(channel => channel.dispose());
    this.runningServers.forEach(server => {
      server.process.kill();
    });
  }
}
