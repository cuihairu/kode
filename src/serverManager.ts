import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ChildProcess, spawn } from 'child_process';
import { LogHub, RuntimeLogLevel } from './logHub';
import { ProcessManager } from './processManager';
import { joinWorkspacePath, usesPosixPath } from './workspacePath';
import { hasEngineConfigProbe, resolveDiscoveredConfigRoot, resolveKbeSourceRoot } from './workspaceDiscovery';
import { makeProbeOne, readTelnetTargetsFromSettings, type TelnetTarget } from './telnetService';
import {
  isDependencySatisfied,
  resolveLaunchOrder,
  type DependencyReadyState,
  type LaunchTargetSpec
} from './launchDependencies';

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
  /** 直接依赖(RUN-005):依赖键为组件名;组外依赖不参与排序,运行期就绪判定拦截 */
  dependsOn?: readonly string[];
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
    description: '机器管理器（必须最先启动）',
    dependsOn: []
  },
  {
    name: 'logger',
    displayName: 'Logger',
    executable: 'logger',
    defaultArgs: ['--cid=1129653375331859700', '--gus=2'],
    order: 2,
    required: false,
    description: '日志服务器',
    dependsOn: ['machine']
  },
  {
    name: 'interfaces',
    displayName: 'Interfaces',
    executable: 'interfaces',
    defaultArgs: ['--cid=1129652375332859700', '--gus=3'],
    order: 3,
    required: false,
    description: '外部接口服务',
    dependsOn: ['machine']
  },
  {
    name: 'dbmgr',
    displayName: 'DBMgr',
    executable: 'dbmgr',
    defaultArgs: ['--cid=3129652375332859700', '--gus=4'],
    order: 4,
    required: true,
    description: '数据库管理器',
    dependsOn: ['machine']
  },
  {
    name: 'baseappmgr',
    displayName: 'BaseAppMgr',
    executable: 'baseappmgr',
    defaultArgs: ['--cid=4129652375332859700', '--gus=5'],
    order: 5,
    required: true,
    description: 'BaseApp 管理器',
    dependsOn: ['dbmgr']
  },
  {
    name: 'cellappmgr',
    displayName: 'CellAppMgr',
    executable: 'cellappmgr',
    defaultArgs: ['--cid=5129652375332859700', '--gus=6'],
    order: 6,
    required: true,
    description: 'CellApp 管理器',
    dependsOn: ['dbmgr']
  },
  {
    name: 'baseapp',
    displayName: 'BaseApp',
    executable: 'baseapp',
    defaultArgs: ['--cid=6129652375332859700', '--gus=7'],
    order: 7,
    required: true,
    description: '网关服务器',
    dependsOn: ['baseappmgr']
  },
  {
    name: 'cellapp',
    displayName: 'CellApp',
    executable: 'cellapp',
    defaultArgs: ['--cid=7129652375332859700', '--gus=8'],
    order: 8,
    required: true,
    description: '游戏服务器',
    dependsOn: ['cellappmgr']
  },
  {
    name: 'loginapp',
    displayName: 'LoginApp',
    executable: 'loginapp',
    defaultArgs: ['--cid=8129652375332859700', '--gus=9'],
    order: 9,
    required: true,
    description: '登录服务器',
    dependsOn: ['baseappmgr']
  },
  {
    name: 'bots',
    displayName: 'Bots',
    executable: 'bots',
    defaultArgs: ['--gus=1'],
    order: 10,
    required: false,
    description: '机器人测试客户端',
    dependsOn: ['loginapp']
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
  /** 实例标识(RUN-001):默认实例为 DEFAULT_TARGET_ID,显式命名的多实例各自持有 */
  targetId: string;
  process: ChildProcess;
  pid: number;
  status: ServerStatus;
  startTime: Date;
  logs: string[];
  /** 就绪等待放弃原因(RUN-004):超时/取消后等待终止,状态保持 Starting,绝不误标 Running */
  readinessGivenUp?: 'timeout' | 'cancelled';
  /** 就绪等待取消柄(RUN-004):stopComponent 置位,等待轮询即终止 */
  readinessCancel?: { aborted: boolean };
}

/**
 * 多实例目标 ID(RUN-001):省略 targetId 的启动走默认实例,登记键保持纯
 * 组件名,UI 树/命令/调试注入等既有调用面零变化;显式命名的实例登记键
 * 为 `组件名#targetId`,同组件多实例互不覆盖进程记录。
 */
export const DEFAULT_TARGET_ID = 'default';

export function buildServerKey(componentName: string, targetId: string): string {
  if (!targetId || targetId === DEFAULT_TARGET_ID) {
    return componentName;
  }
  return `${componentName}#${targetId}`;
}

export function parseServerKey(key: string): { componentName: string; targetId: string } {
  const hashIndex = key.indexOf('#');
  if (hashIndex < 0) {
    return { componentName: key, targetId: DEFAULT_TARGET_ID };
  }
  return { componentName: key.slice(0, hashIndex), targetId: key.slice(hashIndex + 1) };
}

const READINESS_PROBE_TIMEOUT_MS = 1000;
const READINESS_PROBE_INTERVAL_MS = 250;
/** 就绪等待默认上限(RUN-004):到期放弃等待并报告 target;null 可显式关闭 */
const READINESS_WAIT_TIMEOUT_MS = 60000;

/**
 * 组启动请求(RUN-006):component=组件名,targetId=实例(dependsOn 缺省取
 * 组件声明链,可显式覆盖;readinessProbe 透传 startComponent 注入口)
 */
export interface GroupTargetRequest {
  component: string;
  targetId?: string;
  dependsOn?: readonly string[];
  readinessProbe?: (() => Promise<boolean>) | null;
}

/** 组启动单目标结局 */
export type TargetOutcomeKind = 'started' | 'dependency-failed' | 'dependency-timeout' | 'spawn-failed' | 'not-found';

export interface TargetOutcome {
  key: string;
  component: string;
  targetId: string;
  outcome: TargetOutcomeKind;
  /** 未启动时的责任依赖键 */
  dependency?: string;
}

/** 组启动报告:环时零启动只报环路径 */
export interface TargetGroupReport {
  order?: string[];
  cycle?: string[];
  outcomes: TargetOutcome[];
}

/**
 * 组件就绪探针(RUN-003):配置开了 telnet 的组件用其目标端口做真实 TCP
 * 连通探针(makeProbeOne 真套接字),探针通过才推进 Running;无匹配目标
 * (未开 telnet/端口无效)不猜端口,返回 undefined 回落固定宽限期。
 * getTargets 可注入(测试)。
 */
export function createComponentReadinessProbe(
  componentName: string,
  deps: { getTargets?: () => TelnetTarget[] } = {}
): (() => Promise<boolean>) | undefined {
  const target = (deps.getTargets ?? readTelnetTargetsFromSettings)()
    .find(item => item.component === componentName);
  if (!target || !(target.port > 0)) {
    return undefined;
  }
  const probeOne = makeProbeOne(READINESS_PROBE_TIMEOUT_MS);
  return () => probeOne(target.host, target.port);
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
      current.forEach(([, server]) => {
        const events = batch.events.filter(event => event.component === server.component.name);
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
   * 启动单个组件;options.targetId 指定实例(默认实例键=纯组件名),
   * options.readinessProbe 覆盖默认探针(null 显式关闭,回落宽限期),
   * options.readinessTimeoutMs 等待上限(null 显式关闭,默认 60s),
   * options.cancel 取消柄(置位即放弃等待,stopComponent 亦会置位)
   */
  async startComponent(
    component: ServerComponent,
    options?: {
      targetId?: string;
      readinessProbe?: (() => Promise<boolean>) | null;
      readinessTimeoutMs?: number | null;
      cancel?: { aborted: boolean };
    }
  ): Promise<boolean> {
    const targetId = options?.targetId ?? DEFAULT_TARGET_ID;
    const serverKey = buildServerKey(component.name, targetId);
    const readinessProbe = options?.readinessProbe !== undefined
      ? options.readinessProbe
      : createComponentReadinessProbe(component.name);
    const readinessTimeoutMs = options?.readinessTimeoutMs !== undefined
      ? options.readinessTimeoutMs
      : READINESS_WAIT_TIMEOUT_MS;
    const readinessCancel = options?.cancel ?? { aborted: false };
    // 检查是否已运行(同组件不同 targetId 的实例互不拦截)
    if (this.runningServers.has(serverKey)) {
      vscode.window.showWarningMessage(
        targetId === DEFAULT_TARGET_ID
          ? `${component.displayName} 已在运行中`
          : `${component.displayName} 实例 ${targetId} 已在运行中`
      );
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
        id: serverKey,
        command: exePath,
        args: component.defaultArgs || [],
        cwd: configPath,
        env: this.buildComponentEnvironment(configPath, binPath),
        component: component.name,
        readyAfterMs: 1000,
        readiness: readinessProbe
          ? {
            probe: readinessProbe,
            intervalMs: READINESS_PROBE_INTERVAL_MS,
            timeoutMs: readinessTimeoutMs === null ? undefined : readinessTimeoutMs,
            cancelHandle: readinessCancel,
            onGiveUp: reason => this.handleReadinessGiveUp(serverKey, component, targetId, readinessTimeoutMs, reason)
          }
          : undefined
      });
      void managed;

      const runningServer: RunningServer = {
        component,
        targetId,
        process: managed.process,
        pid: managed.pid,
        status: ServerStatus.Starting,
        startTime: new Date(),
        logs: [],
        readinessCancel
      };

      this.runningServers.set(serverKey, runningServer);

      this._onDidChangeStatus.fire();
      return true;

    } catch (error) {
      this.log(component, RuntimeLogLevel.ERROR, `启动失败: ${String(error)}`);
      return false;
    }
  }

  /**
   * 就绪等待放弃(RUN-004):报告对应 target 后等待终止,状态保持 Starting,
   * 绝不误标 Running;取消类只记日志(用户发起,不再弹窗惊扰)
   */
  private handleReadinessGiveUp(
    serverKey: string,
    component: ServerComponent,
    targetId: string,
    timeoutMs: number | null | undefined,
    reason: 'timeout' | 'cancelled'
  ): void {
    const runningServer = this.runningServers.get(serverKey);
    if (runningServer) {
      runningServer.readinessGivenUp = reason;
    }
    const targetLabel = targetId === DEFAULT_TARGET_ID ? component.displayName : `${component.displayName} 实例 ${targetId}`;
    if (reason === 'timeout') {
      this.log(component, RuntimeLogLevel.WARNING,
        `${targetLabel} 就绪等待超时(${timeoutMs ?? '∞'}ms)，停止等待（仍为 Starting，未误标 Running）`);
      vscode.window.showWarningMessage(`${targetLabel} 就绪等待超时，停止等待（仍为 Starting）`);
    } else {
      this.log(component, RuntimeLogLevel.INFO, `${targetLabel} 就绪等待已取消`);
    }
    this._onDidChangeStatus.fire();
  }

  /**
   * 停止单个组件;targetId 指定实例(省略时 componentName 即登记键,
   * stopAll 传入的复合键原样命中)
   */
  async stopComponent(componentName: string, targetId?: string): Promise<boolean> {
    const serverKey = targetId ? buildServerKey(componentName, targetId) : componentName;
    const runningServer = this.runningServers.get(serverKey);
    if (!runningServer) {
      return false;
    }
    // RUN-004:停止即取消就绪等待,先翻柄再发信号(等待轮询即刻终止)
    if (runningServer.readinessCancel) {
      runningServer.readinessCancel.aborted = true;
    }

    this.log(runningServer.component, RuntimeLogLevel.INFO, `正在停止 ${runningServer.component.displayName}...`);

    const stopped = await this.processManager.stop(serverKey);
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
   * 就绪视图:把登记表压成依赖就绪判定所需的最小面(RUN-005/006)
   */
  private dependencyReadyView(): Map<string, DependencyReadyState> {
    const view = new Map<string, DependencyReadyState>();
    this.runningServers.forEach((server, key) => {
      view.set(key, { status: server.status, readinessGivenUp: server.readinessGivenUp });
    });
    return view;
  }

  /**
   * 等一组直接依赖全部「在册且 Running」(RUN-006)。失败即返回:
   * - 依赖被组内判定失败/跳过(failedKeys)
   * - 依赖启动过又退出(在册→不在册)
   * - 依赖放弃就绪等待(RUN-004,停在 Starting)
   * 组外依赖若始终未就绪,等到 timeoutMs 上限(缺省 60s,null 关闭)。
   */
  private async waitForTargetDependencies(
    deps: readonly string[],
    failedKeys: ReadonlySet<string>,
    options: { intervalMs?: number; timeoutMs?: number | null }
  ): Promise<{ ok: true } | { ok: false; reason: 'dependency-failed' | 'dependency-timeout'; dependency: string }> {
    if (deps.length === 0) {
      return { ok: true };
    }
    const intervalMs = options.intervalMs ?? 250;
    const deadline = options.timeoutMs === null || options.timeoutMs === undefined
      ? Number.POSITIVE_INFINITY
      : Date.now() + options.timeoutMs;
    const seenPresent = new Set<string>();
    // 轮询起点先登记一遍当前在册依赖:组外早已 Running 的依赖不在"曾在册
    // 又消失"的失败观测范围内,直接按就绪判定处理
    const initial = this.dependencyReadyView();
    for (const dep of deps) {
      if (initial.get(dep) || (dep.indexOf('#') < 0 && [...initial.keys()].some(key => key === dep || key.startsWith(`${dep}#`)))) {
        seenPresent.add(dep);
      }
    }
    for (;;) {
      const view = this.dependencyReadyView();
      for (const dep of deps) {
        if (failedKeys.has(dep)) {
          return { ok: false, reason: 'dependency-failed', dependency: dep };
        }
        const entry = view.get(dep)
          ?? (dep.indexOf('#') < 0
            ? [...view.entries()].find(([key]) => key === dep || key.startsWith(`${dep}#`))?.[1]
            : undefined);
        if (entry && entry.readinessGivenUp) {
          return { ok: false, reason: 'dependency-failed', dependency: dep };
        }
        if (entry) {
          seenPresent.add(dep);
        } else if (seenPresent.has(dep)) {
          // 曾在册又不在册:依赖进程已退出
          return { ok: false, reason: 'dependency-failed', dependency: dep };
        }
      }
      if (deps.every(dep => isDependencySatisfied(dep, view))) {
        return { ok: true };
      }
      if (Date.now() >= deadline) {
        return { ok: false, reason: 'dependency-timeout', dependency: deps.find(dep => !isDependencySatisfied(dep, view)) ?? deps[0] };
      }
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  }

  /**
   * 按依赖就绪顺序启动一组目标(RUN-006):先拓扑定序(环→零启动+环报告);
   * 逐目标等全部直接依赖「在册且 Running」才启动,前置失败(退出/放弃就绪
   * 等待/启动失败/组内跳过)时依赖它的后续启动不继续,失败沿组传染。
   * dependsOn 缺省取组件声明的标准链,可显式覆盖(自定义启动图/测试)。
   */
  async startTargetGroup(
    requests: readonly GroupTargetRequest[],
    options?: { dependencyTimeoutMs?: number | null; readinessTimeoutMs?: number | null }
  ): Promise<TargetGroupReport> {
    const resolved: Array<{
      key: string;
      componentName: string;
      targetId: string;
      component: ServerComponent;
      dependsOn: readonly string[];
      readinessProbe?: (() => Promise<boolean>) | null;
    }> = [];
    const unknown: Array<{ key: string; componentName: string; targetId: string }> = [];
    for (const request of requests) {
      const targetId = request.targetId ?? DEFAULT_TARGET_ID;
      const component = SERVER_COMPONENTS.find(item => item.name === request.component);
      if (!component) {
        unknown.push({ key: buildServerKey(request.component, targetId), componentName: request.component, targetId });
        continue;
      }
      resolved.push({
        key: buildServerKey(component.name, targetId),
        componentName: component.name,
        targetId,
        component,
        dependsOn: request.dependsOn ?? component.dependsOn ?? [],
        readinessProbe: request.readinessProbe
      });
    }
    if (unknown.length > 0) {
      return {
        outcomes: unknown.map(item => ({
          key: item.key, component: item.componentName, targetId: item.targetId, outcome: 'not-found' as const
        }))
      };
    }

    const specs: LaunchTargetSpec[] = resolved.map(target => ({ key: target.key, dependsOn: target.dependsOn }));
    const order = resolveLaunchOrder(specs);
    if (!order.ok) {
      return { cycle: order.cycle, outcomes: [] };
    }

    const byKey = new Map(resolved.map(target => [target.key, target]));
    const failedKeys = new Set<string>();
    const outcomes: TargetOutcome[] = [];
    for (const key of order.order) {
      const target = byKey.get(key) as typeof resolved[number];
      const wait = await this.waitForTargetDependencies(target.dependsOn, failedKeys, {
        timeoutMs: options?.dependencyTimeoutMs ?? READINESS_WAIT_TIMEOUT_MS
      });
      if (!wait.ok) {
        failedKeys.add(key);
        outcomes.push({
          key, component: target.componentName, targetId: target.targetId,
          outcome: wait.reason, dependency: wait.dependency
        });
        continue;
      }
      const started = await this.startComponent(target.component, {
        targetId: target.targetId,
        readinessTimeoutMs: options?.readinessTimeoutMs,
        readinessProbe: target.readinessProbe
      });
      if (!started) {
        failedKeys.add(key);
        outcomes.push({ key, component: target.componentName, targetId: target.targetId, outcome: 'spawn-failed' });
        continue;
      }
      outcomes.push({ key, component: target.componentName, targetId: target.targetId, outcome: 'started' });
    }
    return { order: order.order, outcomes };
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
   * 获取服务器状态;targetId 指定实例
   */
  getServerStatus(componentName: string, targetId?: string): ServerStatus {
    const serverKey = targetId ? buildServerKey(componentName, targetId) : componentName;
    const server = this.runningServers.get(serverKey);
    return server?.status || ServerStatus.Stopped;
  }

  /**
   * 重启组件;targetId 指定实例
   */
  async restartComponent(componentName: string, targetId?: string): Promise<boolean> {
    await this.stopComponent(componentName, targetId);
    await new Promise(resolve => setTimeout(resolve, 1000));

    const component = SERVER_COMPONENTS.find(c => c.name === componentName);
    if (!component) {
      return false;
    }

    return this.startComponent(component, targetId === undefined ? undefined : { targetId });
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
