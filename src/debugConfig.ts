import * as child_process from 'child_process';
import * as vscode from 'vscode';
import { DEBUGPY_PORT_TABLE, debugpyPortFor } from './autoDebugpy';
import {
  DEBUG_ATTACH_TIMEOUT_DEFAULT_MS,
  attachWithDeadline,
  type AttachGuardOutcome
} from './debugAttachGuard';
import { parseDebugConfigText } from './debugConfigBootstrap';
import {
  DEBUGPY_PORT_PROBE_TIMEOUT_MS,
  PORT_NEXT_STEP_ACTION_LIST,
  PORT_NEXT_STEP_ACTIONS,
  buildAfterInstallStillClosedMessage,
  buildListenManualGuide,
  buildManualInstallGuide,
  buildPortClosedGuidance,
  buildPortNextStepMessage,
  defaultDebugpyInstallRunner,
  defaultTcpConnect,
  portClosedReasonText,
  type DebugpyInstallRunner,
  type TcpConnectFn,
  type TcpProbeResult
} from './backend/debugpyPortProbe';
import {
  checkInterpreterDebugpy,
  debugpyPreflightDeps,
  type DebugpyPreflightStatus
} from './backend/debugpyPreflight';
import { openSshTunnel, resolveComponentConnection, type ServerConnection } from './backend/remoteConnection';
import type { SshHostEntry } from './backend/sshConfig';
import {
  DEFAULT_DEBUGPY_PORT,
  buildPortLaunchEntry,
  buildProcessPickItems,
  dropSupersededPortEntries,
  isKbengineGeneratedEntry,
  makeProcessLister,
  mergePortLaunchEntry,
  nextAttachAttemptId,
  pidFromPick,
  portLaunchEntryName,
  readRemoteTargets,
  remoteTargetPathMappings,
  withGeneratedMarker
} from './debugConfigLaunch';

export interface ComponentDebugConfig {
  telnetHost?: string;
  telnetPort?: number;
  telnetPassword?: string;
  telnetDefaultLayer?: string;
  telnetEnableCommands?: string[];
  /**
   * IDE-PDBG-001:该组件的 debugpy 监听端口(端口模式)。配置了(>0)则
   * 附加直接 connect 到 debugpyHost:debugpyPort,不再弹进程选择;未配置
   * (缺省/0)= 走模式选择(首次)或记住的模式。引擎 Python 进程不内置
   * debugpy 监听——需在代码里埋 debugpy.listen(port) 或经注入面开启,
   * 文档「调试」节有说明。
   */
  debugpyHost?: string;
  debugpyPort?: number;
  /**
   * IDE-PDBG-004:连接声明——该组件的 debug/py-spy 在哪跑。'local'/
   * 缺省 = 本地直接执行;填 ssh 主机别名则远程执行(ssh 前缀跑命令,
   * 端口模式经 -L 隧道 connect 附加)。别名无需在 ~/.ssh/config 里
   * (不在则按裸主机名连),跳板链随 config 的 ProxyJump。
   */
  sshHost?: string;
  pathMappings?: Array<{
    localRoot: string;
    remoteRoot: string;
  }>;
}

/** 附加模式(IDE-PDBG-001):端口模式 connect 直连 / 进程附加模式按 PID */
export type DebugAttachMode = 'debugpy-port' | 'process-attach';

/** 模式选择记忆键(workspaceState):首次选择后记住,可经「清除」重问 */
export const DEBUG_ATTACH_MODE_STATE_KEY = 'kbengine.debug.attachMode.v1';

export interface KBEngineDebugConfig {
  defaultTelnetHost?: string;
  defaultTelnetPort?: number;
  /** IDE-PDBG-004:全局连接声明(组件级 sshHost 覆盖它;'local'/缺省=本地) */
  defaultSshHost?: string;
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

export class DebugConfigManager {
  private config: KBEngineDebugConfig;
  private configWatcher: vscode.FileSystemWatcher | null = null;
  private _onDidChangeConfig = new vscode.EventEmitter<void>();
  readonly onDidChangeConfig = this._onDidChangeConfig.event;
  /**
   * IDE-AUD-001:尚未落定的会话追踪订阅(超时/取消已返回而 start 仍挂起)。
   * 此类订阅必须存活到 start 落定以捕获迟到会话句柄;永不落定的 start 由
   * 管理器 dispose 兜底释放,防订阅泄漏。
   */
  private readonly pendingAttachTrackers = new Set<{ dispose(): void }>();

  /**
   * IDE-AUD-003:成功附加后仍存活的隧道拆解器。隧道随自家会话终止关闭,
   * 失败/取消即时关闭;会话启动事件迟到或未归属时隧道活到管理器 dispose
   * 兜底——一律不留后台 ssh。
   */
  private readonly tunnelTeardowns = new Set<() => void>();

  constructor(
    private context: vscode.ExtensionContext,
    private readonly deps: {
      listProcesses?: () => ProcessEntry[];
      /** IDE-PDBG-002:端口探测注入面(缺省真实 net.connect) */
      probeTcpPort?: TcpConnectFn;
      /** IDE-PDBG-002:本机 debugpy 预检注入面(缺省既有 debugpyPreflight 链) */
      checkDebugpy?: () => Promise<DebugpyPreflightStatus>;
      /** IDE-PDBG-002:一键安装注入面(缺省 `<解释器> -m pip install -U debugpy`) */
      installDebugpy?: DebugpyInstallRunner;
      /** IDE-PDBG-004:ssh 主机表(连接声明按别名查参数;缺省空表=裸主机名连) */
      listSshHosts?: () => SshHostEntry[];
      /** IDE-PDBG-004:视图选中的服务器(debug.json 未声明时的分派层) */
      selectedServer?: () => string;
      /** IDE-PDBG-004:隧道进程注入面(缺省真实 spawn ssh -N -L) */
      spawnTunnel?: (args: string[]) => { onExit(cb: () => void): void; kill(): void };
      /**
       * 端口模式下一步(死路修复):一键起 debugpy 监听——装配层负责同步
       * debugpy 进资产树并经该组件 telnet 发 `debugpy.listen`,回执如实
       * (ok=false 带原因)。缺省(未接线)= 一键动作退化为起监听指引,
       * 不假装能起。
       */
      startDebugpyListener?: (
        componentName: string,
        port: number
      ) => Promise<{ ok: boolean; detail: string }>;
    } = {}
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
          // KR-AUD-41:默认面不带密码——硬编码 pwd123456 回落已废除,缺失由
          // startDebugging 显式提示用户自行填写
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
      // KR-AUD-41:无默认密码回落——用户配了就给,没配/显式空值如实 undefined,
      // 由 startDebugging 显式提示,不再编造 pwd123456
      telnetPassword: userConfig?.telnetPassword,
      telnetDefaultLayer: userConfig?.telnetDefaultLayer || 'python',
      telnetEnableCommands: userConfig?.telnetEnableCommands || [],
      debugpyHost: userConfig?.debugpyHost,
      debugpyPort:
        typeof userConfig?.debugpyPort === 'number' && userConfig.debugpyPort > 0
          ? userConfig.debugpyPort
          : undefined,
      sshHost: typeof userConfig?.sshHost === 'string' && userConfig.sshHost.trim().length > 0
        ? userConfig.sshHost.trim()
        : undefined,
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

    // 端口模式显式声明(IDE-PDBG-001:debug.json 的 debugpyPort>0)。端口模式
    // 的 attach 从 debug.json 取口,launch.json 就必须有指向该口的 connect
    // 条目——否则 F5/Debug Targets 的「用 launch.json 附加」指引落空。与
    // 动态写入口(ensurePortLaunchConfig)同名同体,幂等合流,默认关的
    // autoDebugpy 不再是端口模式条目的前提。
    const explicitPortComponents = new Set<string>();
    for (const [componentName, componentConfig] of Object.entries(this.config.components)) {
      const explicitPort =
        typeof componentConfig.debugpyPort === 'number' && componentConfig.debugpyPort > 0
          ? componentConfig.debugpyPort
          : undefined;
      if (explicitPort === undefined) {
        continue;
      }
      explicitPortComponents.add(componentName);
      configurations.push(
        buildPortLaunchEntry(
          componentName,
          componentConfig.debugpyHost || '127.0.0.1',
          explicitPort,
          componentConfig.pathMappings,
          this.getDebuggerType()
        )
      );
    }

    // 端口模式「记住的选择」(IDE-PDBG-001:没显式声明端口的组件,模式选择
    // 一次对全部组件生效)。此时 Update launch.json 也得给这些组件各落一条
    // 指向其实际端口(分配表/缺省 5678)的 connect 条目——否则重跑一次就
    // 把端口模式的 F5 落点刷没了,动态写入与全量生成两个面才不互相拆台。
    // 记忆面按最小可用取:极简装配/替身的 workspaceState 可能没有 get 面,
    // 取不到就当没记住(不抛)
    const memento = this.context.workspaceState;
    const rememberedPortMode =
      typeof memento?.get === 'function' &&
      memento.get<string>(DEBUG_ATTACH_MODE_STATE_KEY) === 'debugpy-port';
    if (rememberedPortMode) {
      for (const [componentName, componentConfig] of Object.entries(this.config.components)) {
        if (explicitPortComponents.has(componentName)) {
          continue; // 显式端口条目已覆盖
        }
        explicitPortComponents.add(componentName);
        configurations.push(
          buildPortLaunchEntry(
            componentName,
            componentConfig.debugpyHost || '127.0.0.1',
            debugpyPortFor(componentName) ?? DEFAULT_DEBUGPY_PORT,
            componentConfig.pathMappings,
            this.getDebuggerType()
          )
        );
      }
    }

    // 调试启动即 attach(2026-10-27 ③c):kbengine.debug.autoDebugpy 开时,
    // 按端口分配表逐组件追加 debugpy connect 附加配置(localRoot=
    // workspaceFolder,与本地 attach 同映射口径);注入由启动联动负责,
    // 这里只负责把「组件→端口」面写进 launch.json。默认关=零追加。
    // 显式声明了 debugpyPort 的组件跳过表条目:它已有指向自己口的条目,
    // 两条同组件条目会互相打架(名字不同、口不同)。
    // DBG-001 命名实例面:同组件多实例各持独立口(启动联动按组件窗口
    // 分配),逐实例追加一条 connect 附加——条目名带
    // `component#targetId` 指明归属实例;默认实例不进此列表(上方表配置
    // 已覆盖)。与表条目同映射口径(localRoot=workspaceFolder)。
    if (vscode.workspace.getConfiguration('kbengine').get<boolean>('debug.autoDebugpy', false)) {
      for (const { component, port } of DEBUGPY_PORT_TABLE) {
        if (explicitPortComponents.has(component)) {
          continue;
        }
        configurations.push({
          name: portLaunchEntryName(component, port),
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

    // KR-AUD-42:统一在出口打隐藏管理标记——所有生成条目(组件 PID 条目/
    // 远程条目/端口条目/命名实例条目)都可被 updateLaunchJson 按标记辨识,
    // 清理只回收自己的产出,不碰用户手写的任何条目。
    return configurations.map(item => withGeneratedMarker(item as Record<string, unknown>));
  }

  /**
   * launch.json 读改写串行闸(Update launch.json 与端口模式动态写入共用):
   * 同一时刻只有一个「读-改-写」在飞,后到者基于前者落盘后的结果再读改写,
   * 并发不丢条目;任务失败不毒化队列(下一个照常排队)。
   */
  private launchWriteChain: Promise<unknown> = Promise.resolve();

  private queueLaunchWrite<T>(task: () => Promise<T>): Promise<T> {
    const run = this.launchWriteChain.then(task);
    this.launchWriteChain = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * 读 .vscode/launch.json:文件不在=空骨架(照常生成);内容为空=空骨架;
   * 解析不了=拒绝改写并给原因——JSONC 带注释时改写会丢注释,坏 JSON 改写会
   * 丢整份用户配置,两种都绝不盲写(保留用户已有配置不破坏)。
   */
  private async readLaunchConfig(
    launchJsonPath: vscode.Uri
  ): Promise<{ config: Record<string, any> } | { error: string }> {
    let text = '';
    try {
      const launchData = await vscode.workspace.fs.readFile(launchJsonPath);
      text = Buffer.from(launchData).toString('utf8');
    } catch {
      return { config: { configurations: [], inputs: [] } };
    }
    if (text.trim().length === 0) {
      return { config: { configurations: [], inputs: [] } };
    }
    try {
      return { config: JSON.parse(text) as Record<string, any> };
    } catch {
      // 落到 JSONC/坏文件判定
    }
    const jsoncParsed = parseDebugConfigText(text);
    if (jsoncParsed !== null && typeof jsoncParsed === 'object') {
      return {
        error: 'launch.json 带注释(JSONC),扩展改写会丢注释,为免破坏未改写;去掉注释后重跑'
      };
    }
    return { error: 'launch.json 无法按 JSON 解析,为免破坏未改写;修好语法后重跑' };
  }

  /**
   * 端口模式动态写 launch.json(IDE-PDBG-002 死路修复):为该组件的
   * `debugpyHost:debugpyPort` 落一条 connect 附加条目。幂等(同名条目只更
   * 托管字段,已在位零写入)、保留用户条目与手改字段、与 Update launch.json
   * 串行走同一闸。永不抛:失败如实回 detail(引导文案里带出)。
   */
  async ensurePortLaunchConfig(
    componentName: string,
    host: string,
    port: number
  ): Promise<{ ok: boolean; detail: string; entryName: string }> {
    const entryName = portLaunchEntryName(componentName, port);
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return { ok: false, detail: '没有打开的工作区,未写 launch.json', entryName };
    }
    return this.queueLaunchWrite(async () => {
      const vscodeDir = vscode.Uri.joinPath(workspaceFolder.uri, '.vscode');
      const launchJsonPath = vscode.Uri.joinPath(workspaceFolder.uri, '.vscode', 'launch.json');
      try {
        await vscode.workspace.fs.createDirectory(vscodeDir);
        const read = await this.readLaunchConfig(launchJsonPath);
        if ('error' in read) {
          return { ok: false, detail: read.error, entryName };
        }
        const entry = buildPortLaunchEntry(
          componentName,
          host,
          port,
          this.getComponentConfig(componentName).pathMappings,
          this.getDebuggerType()
        );
        const cleaned = dropSupersededPortEntries(
          read.config.configurations || [],
          componentName,
          port
        );
        const merged = mergePortLaunchEntry(cleaned.configurations, entry);
        const changed = cleaned.removed > 0 || merged.changed;
        if (changed) {
          const finalConfig = {
            version: read.config.version || '0.2.0',
            configurations: merged.configurations,
            inputs: this.generateLaunchInputs(read.config.inputs || [])
          };
          await vscode.workspace.fs.writeFile(
            launchJsonPath,
            Buffer.from(JSON.stringify(finalConfig, null, 2), 'utf8')
          );
        }
        const note = cleaned.removed > 0
          ? `已写入「${entryName}」并回收 ${cleaned.removed} 条同组件旧端口条目`
          : merged.changed
            ? `已写入「${entryName}」`
            : `「${entryName}」已在位`;
        return { ok: true, detail: note, entryName };
      } catch (error) {
        return { ok: false, detail: String(error), entryName };
      }
    });
  }

  async updateLaunchJson(runningInstances: ReadonlyArray<{ component: string; targetId: string; port: number }> = []): Promise<boolean> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      vscode.window.showErrorMessage('没有打开的工作区');
      return false;
    }

    const vscodeDir = vscode.Uri.joinPath(workspaceFolder.uri, '.vscode');
    const launchJsonPath = vscode.Uri.joinPath(workspaceFolder.uri, '.vscode', 'launch.json');

    return this.queueLaunchWrite(async () => {
      try {
        await vscode.workspace.fs.createDirectory(vscodeDir);
        const read = await this.readLaunchConfig(launchJsonPath);
        if ('error' in read) {
          vscode.window.showErrorMessage(`更新 launch.json 失败: ${read.error}`);
          return false;
        }
        const existingConfig = read.config;

        const newConfigurations = this.generateLaunchConfigurations(runningInstances);
        // KR-AUD-42:生成/清理只认隐藏管理标记——「KBEngine:」前缀是用户可见
        // 文案,用户手写的同前缀条目按名字前缀清理会被误删
        const kbConfigs = newConfigurations.filter(isKbengineGeneratedEntry);
        const userConfigs = (existingConfig.configurations || []).filter(
          (item: unknown) => !isKbengineGeneratedEntry(item)
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
    });
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
              // KR-AUD-41:示例不带默认密码——telnetPassword 留给用户自填
              // (扩展/文档均不再内置 pwd123456)
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
              telnetDefaultLayer: 'python',
              telnetEnableCommands: []
            },
            loginapp: {
              telnetHost: '127.0.0.1',
              telnetPort: 31000,
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
    // IDE-PDBG-001:已配置 debugpy 端口的组件直接端口模式附加——telnet 简
    // 报是进程附加路径的开启指引,端口模式用不上,不再打扰
    if (config.debugpyPort !== undefined) {
      return this.attachViaDebugpyPort(componentName);
    }
    // 不可达(批68 定性):telnetEnableCommands 与下方 password/layer 同族——
    // getComponentConfig 已归一化(`userConfig?.telnetEnableCommands || []`),
    // 产出恒为真值数组 ⇒ `|| []` 兜底右臂无触发路径。语句与两分支条目
    // 随区间移出分母(TESTING.md 分母口径据实登记);真臂行为由既有
    // startDebugging 编排用例锁定。
    /* istanbul ignore start */
    const telnetLines = (config.telnetEnableCommands || []).filter(Boolean);
    /* istanbul ignore stop */
    const telnetCommand = `telnet ${config.telnetHost || '127.0.0.1'} ${config.telnetPort || 0}`;
    // KR-AUD-41:密码无默认回落——缺失/显式空值显式警告 + 简报如实报未配置,
    // 不再编造 pwd123456;配置了的用户密码语义不变,仍如实展示
    if (!config.telnetPassword) {
      void vscode.window.showWarningMessage(
        `KBEngine ${componentName} 未配置 telnet 密码:请在 .kbengine/debug.json 的 ${componentName} 下填写 telnetPassword(扩展不带默认密码)`
      );
    }
    const telnetMeta = [
      config.telnetPassword
        ? `password: ${config.telnetPassword}`
        : 'password: 未配置（在 .kbengine/debug.json 填 telnetPassword）',
      // 不可达(批68 定性):config 出自 getComponentConfig,其
      // telnetDefaultLayer 已做同款归一化(`userConfig?.x || 'python'`),
      // 产出恒为非空字符串 ⇒ 兜底右臂无触发路径,随行移出分母(TESTING.md
      // 分母口径据实登记);真臂行为由既有 startDebugging 简报断言锁定。
      /* istanbul ignore start */
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

  /**
   * IDE-PDBG-001 附加模式解析:配置了 debugpyPort 的组件无需选择——端口
   * 模式直接成立;未配置时第一次弹模式选择并记住(workspaceState),之后
   * 按记住的模式走(重选走 kbengine.debug.resetAttachMode 命令清记忆);
   * 首次提示里的「清除记住的选择」= 本次不附加且不记忆。极简装配(无
   * workspaceState):每次都问,不记忆。
   */
  async resolveAttachMode(componentName: string): Promise<DebugAttachMode | undefined> {
    const config = this.getComponentConfig(componentName);
    if (config.debugpyPort !== undefined) {
      return 'debugpy-port'; // 配置即端口模式,不问
    }
    const memento = this.context.workspaceState;
    const remembered = memento?.get<string>(DEBUG_ATTACH_MODE_STATE_KEY);
    if (remembered === 'debugpy-port' || remembered === 'process-attach') {
      return remembered;
    }
    const picked = await vscode.window.showQuickPick(
      [
        {
          label: '$(plug) 端口模式',
          description: 'connect 到组件 debugpy 监听端口(未配置时用组件默认端口表)',
          mode: 'debugpy-port' as DebugAttachMode
        },
        {
          label: '$(search) 进程附加模式',
          description: '弹出进程选择器按 PID 附加(既有口径)',
          mode: 'process-attach' as DebugAttachMode
        },
        {
          label: '$(discard) 清除记住的选择',
          description: '本次不附加,下次再问',
          mode: 'clear' as const
        }
      ],
      {
        placeHolder: `选择 ${componentName} 的附加模式(选择后记住;引擎进程需先有 debugpy 监听——文档「调试」节)`
      }
    );
    if (!picked) {
      return undefined;
    }
    if (picked.mode === 'clear') {
      await memento?.update(DEBUG_ATTACH_MODE_STATE_KEY, undefined);
      return undefined;
    }
    await memento?.update(DEBUG_ATTACH_MODE_STATE_KEY, picked.mode);
    return picked.mode;
  }

  /**
   * 端口模式附加(IDE-PDBG-001):connect 到 debugpyHost:debugpyPort,不经
   * 进程选择器;未配置端口时用组件默认端口表(autoDebugpy 分配表),表外
   * 组件落 debugpy 默认 5678。host 缺省 127.0.0.1。
   * IDE-PDBG-002:connect 前先探端口——通则直接附加零多余弹窗;不通分开
   * 说原因(端口未开 / 未装 debugpy),未装给一键安装,装完/端口开了再附加;
   * 仍不通则进「下一步」引导(起监听并附加 / 重试附加 / 起监听指引)。
   * 动态写 launch.json(尽力而为、幂等、静默):端口模式的 F5 落点随每次
   * 附加对齐到实际 host:port,失败不阻塞附加、在引导文案里如实带出。
   * IDE-PDBG-004:组件连接声明为远程主机时改走 ssh -L 隧道 connect 附加
   * (远端监听口打到本地;隧道随会话终止关闭,见 attachViaTunnel)——隧道口
   * 是动态的,不落 launch.json。
   */
  async attachViaDebugpyPort(componentName: string): Promise<boolean> {
    const config = this.getComponentConfig(componentName);
    const port = config.debugpyPort ?? debugpyPortFor(componentName) ?? DEFAULT_DEBUGPY_PORT;
    const host = config.debugpyHost || '127.0.0.1';
    const connection = this.getConnectionFor(componentName);
    if (connection !== 'local') {
      return this.attachViaTunnel(componentName, connection.ssh, port, config.pathMappings);
    }
    // 静默对齐 launch.json:失败不拦附加(端口开了照样能连;引导文案里如实带出)
    await this.ensurePortLaunchConfig(componentName, host, port);
    const probe = await (this.deps.probeTcpPort ?? defaultTcpConnect)(
      host,
      port,
      DEBUGPY_PORT_PROBE_TIMEOUT_MS
    );
    if (!probe.open) {
      return this.handlePortClosed(componentName, host, port, probe);
    }
    return this.attachPortConfig(componentName, host, port, config.pathMappings);
  }

  /** 组件连接声明(IDE-PDBG-004):py-spy/视图与端口模式的远程分派共用 */
  getConnectionFor(componentName: string): ServerConnection {
    const config = this.getComponentConfig(componentName);
    return resolveComponentConnection(
      config.sshHost,
      this.config.defaultSshHost,
      this.deps.listSshHosts?.() ?? [],
      this.deps.selectedServer?.()
    );
  }

  /**
   * 远程端口模式:起 ssh -N -L 隧道,本地端 connect 附加;隧道起不来
   * (跳板/主机不可达)如实报错。IDE-AUD-003:隧道存活绑定真实调试会话,
   * 不随 startDebugging 的 Boolean 立即拆(启动结果≠会话结束)——成功
   * 附加后隧道保留到自家会话终止(onDidTerminateDebugSession)才关;
   * 启动失败/取消即时关;管理器卸载兜底关。一律不留后台 ssh。
   */
  private async attachViaTunnel(
    componentName: string,
    entry: SshHostEntry,
    remotePort: number,
    pathMappings: ComponentDebugConfig['pathMappings']
  ): Promise<boolean> {
    const outcome = await openSshTunnel(entry, remotePort, {
      ...(this.deps.spawnTunnel ? { spawnTunnel: this.deps.spawnTunnel } : {}),
      probe: this.deps.probeTcpPort ?? defaultTcpConnect
    });
    if (!outcome.ok) {
      vscode.window.showErrorMessage(`远程附加失败:${outcome.reason}`);
      return false;
    }
    // 隧道只拆一次;拆解器被会话终止/失败/取消/卸载四面共享
    let ownSession: vscode.DebugSession | undefined;
    let tunnelDown = false;
    const stopTunnel = (): void => {
      if (tunnelDown) { return; }
      tunnelDown = true;
      outcome.tunnel.stop();
    };
    const releaseTunnel = (): void => {
      terminateListener.dispose();
      this.tunnelTeardowns.delete(releaseTunnel);
      stopTunnel();
    };
    // 会话终止才是成功附加的隧道关闭时点;会话启动事件迟到/未归属(极端
    // 形状)由 releaseTunnel 仍登记,卸载兜底关闭,不拆活会话的隧道。
    const terminateListener = vscode.debug.onDidTerminateDebugSession(session => {
      if (session !== ownSession) { return; }
      releaseTunnel();
    });
    this.tunnelTeardowns.add(releaseTunnel);
    try {
      const ok = await this.attachPortConfig(
        componentName,
        '127.0.0.1',
        outcome.tunnel.localPort,
        pathMappings,
        session => {
          ownSession = session;
        }
      );
      if (ok) {
        // 成功:隧道交会话终止接管(terminateListener 已订阅)
        return true;
      }
      releaseTunnel();
      return false;
    } catch (error) {
      releaseTunnel();
      throw error;
    }
  }

  /**
   * 端口不通的分诊(IDE-PDBG-002):本机 debugpy 预检 → 主因口径 → 安装/指引;
   * 装完仍未开、或压根没有安装动作可给(预检就绪/解释器缺位)——都不再是
   * 死路,一律接「下一步」引导(guideNextSteps)。
   */
  private async handlePortClosed(
    componentName: string,
    host: string,
    port: number,
    probe: TcpProbeResult
  ): Promise<boolean> {
    const preflight = await (this.deps.checkDebugpy ?? this.defaultCheckDebugpy)();
    const guidance = buildPortClosedGuidance(probe, preflight);
    if (guidance.installAction === undefined || preflight.interpreterPath === null) {
      return this.guideNextSteps(componentName, host, port, guidance.message);
    }
    const pick = await vscode.window.showWarningMessage(
      guidance.message,
      guidance.installAction,
      '手动安装指引'
    );
    if (pick === guidance.installAction) {
      const install = await (this.deps.installDebugpy ?? defaultDebugpyInstallRunner)(
        preflight.interpreterPath
      );
      if (!install.ok) {
        // 安装失败如实报错,不假成功不重试轰炸
        vscode.window.showErrorMessage(`debugpy 安装失败: ${install.detail}`);
        return false;
      }
      const reprobe = await (this.deps.probeTcpPort ?? defaultTcpConnect)(
        host,
        port,
        DEBUGPY_PORT_PROBE_TIMEOUT_MS
      );
      if (!reprobe.open) {
        // 装完仍未开:不中断,接下一步(起监听 / 重试 / 指引)——这正是
        // 「点完安装没下一步」的死路口,补上控件
        return this.guideNextSteps(
          componentName,
          host,
          port,
          buildAfterInstallStillClosedMessage(host, port)
        );
      }
      return this.attachPortConfig(componentName, host, port, this.getComponentConfig(componentName).pathMappings);
    }
    if (pick === '手动安装指引') {
      vscode.window.showInformationMessage(
        buildManualInstallGuide(preflight.interpreterPath, port)
      );
    }
    return false;
  }

  /**
   * 端口模式「下一步」引导(死路修复的主面):分诊/装完之后端口仍不开时的
   * 三个控件——起监听并附加 / 重试附加 / 起监听指引,外加动态落好的
   * launch.json 说明。动作逐个如实收口:
   * - 起监听并附加:装配层同步 debugpy 进资产树并经 telnet 发 listen,成功
   *   后重探端口,通了就附加;失败如实报错不假成功(未接线时退化为指引);
   * - 重试附加:直接重探,通了就附加,不通按最新原因再来一轮(用户逐次点,
   *   不自旋);
   * - 起监听指引:三条现成路径 + 可复制命令,看完即止。
   * 取消弹窗=本次到此为止,返回 false。
   */
  private async guideNextSteps(
    componentName: string,
    host: string,
    port: number,
    baseMessage: string
  ): Promise<boolean> {
    const launchState = await this.ensurePortLaunchConfig(componentName, host, port);
    const launchNote = launchState.ok
      ? `launch.json 已写入/更新「${launchState.entryName}」(Run and Debug 里可 F5 附加)`
      : `launch.json 未更新:${launchState.detail}(可手动跑 kbengine.debug.updateLaunchJson)`;
    let message = buildPortNextStepMessage(baseMessage, launchNote);
    for (;;) {
      const pick = await vscode.window.showWarningMessage(
        message,
        ...PORT_NEXT_STEP_ACTION_LIST
      );
      if (pick === PORT_NEXT_STEP_ACTIONS.listenGuide) {
        vscode.window.showInformationMessage(buildListenManualGuide(port));
        return false;
      }
      if (pick === PORT_NEXT_STEP_ACTIONS.startListen) {
        const outcome = await this.startDebugpyListen(componentName, port);
        if (!outcome.ok) {
          vscode.window.showErrorMessage(`起 debugpy 监听失败:${outcome.detail}`);
          return false;
        }
      } else if (pick !== PORT_NEXT_STEP_ACTIONS.retry) {
        return false; // 关掉弹窗/点了别处:本次到此为止
      }
      const reprobe = await (this.deps.probeTcpPort ?? defaultTcpConnect)(
        host,
        port,
        DEBUGPY_PORT_PROBE_TIMEOUT_MS
      );
      if (reprobe.open) {
        return this.attachPortConfig(
          componentName,
          host,
          port,
          this.getComponentConfig(componentName).pathMappings
        );
      }
      // listen 已发/再探仍不通:如实给最新原因,继续给一轮控件(不假成功)
      message = buildPortNextStepMessage(
        `debugpy 端口仍未开(${portClosedReasonText(reprobe)})`,
        launchNote
      );
    }
  }

  /**
   * 一键起监听:装配层注入面(startDebugpyListener)同步 debugpy 进资产树并
   * 经该组件 telnet 发 `debugpy.listen`,进度通知可见;未接线=不假装能起,
   * 返回 ok=false 让调用方给出指引。
   */
  private async startDebugpyListen(
    componentName: string,
    port: number
  ): Promise<{ ok: boolean; detail: string }> {
    const start = this.deps.startDebugpyListener;
    if (!start) {
      return { ok: false, detail: '本会话未接入 telnet 起监听面——按起监听指引手动处理' };
    }
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `起 debugpy 监听 ${componentName} 127.0.0.1:${port}`,
        cancellable: false
      },
      () => start(componentName, port)
    );
  }

  /** 本机 debugpy 预检默认面:PRJ-004 解释器解析链 + 真实 spawn 探版本 */
  private async defaultCheckDebugpy(): Promise<DebugpyPreflightStatus> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return checkInterpreterDebugpy(debugpyPreflightDeps(workspaceRoot));
  }

  /**
   * 端口模式 connect 附加本体(探测通过后调用)。IDE-AUD-003:onSession 在
   * 自家会话被捕获时上报(隧道存活绑定用);远程隧道口附加经此取得真实
   * 会话句柄。
   */
  private async attachPortConfig(
    componentName: string,
    host: string,
    port: number,
    pathMappings: ComponentDebugConfig['pathMappings'],
    onSession?: (session: vscode.DebugSession) => void
  ): Promise<boolean> {
    const attachConfig: vscode.DebugConfiguration = {
      name: portLaunchEntryName(componentName, port),
      type: this.getDebuggerType(),
      request: 'attach',
      connect: { host, port },
      justMyCode: false,
      pathMappings
    };
    try {
      const outcome = await this.startAttachGuarded(`${componentName} ${host}:${port}`, attachConfig, onSession);
      return outcome.status === 'completed' && outcome.success;
    } catch (error) {
      vscode.window.showErrorMessage(`附加调试失败: ${error}`);
      return false;
    }
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
    const picked = await vscode.window.showQuickPick(
      buildProcessPickItems(processes, componentName),
      {
        placeHolder: `选择要附加的 ${componentName} 进程(✓ 匹配组件名的进程已置顶)`
      }
    );
    return pidFromPick(picked);
  }

  async attachToComponent(componentName: string): Promise<boolean> {
    const config = this.getComponentConfig(componentName);
    // IDE-PDBG-001 附加模式分派:配置了 debugpy 端口 → 端口模式直连;未配置
    // → 首次选择(记住)/按记住的模式走。模式未定(取消/清除)不附加。
    const mode = await this.resolveAttachMode(componentName);
    if (mode === undefined) {
      return false;
    }
    if (mode === 'debugpy-port') {
      return this.attachViaDebugpyPort(componentName);
    }
    // IDE-AUD-004:进程附加(PID)模式的 debugpy 适配器只认本地进程 PID——
    // 组件声明在远端主机(或经 defaultSshHost/视图选中归远端)时,本地 PID
    // 列表绝不冒充远端(静默走本地是缺陷)。暂不支持远端 PID 附加,明确
    // 拒绝并指引端口模式(经 ssh -L 隧道 connect 到组件 debugpy 端口)。
    const connection = this.getConnectionFor(componentName);
    if (connection !== 'local') {
      vscode.window.showErrorMessage(
        `${componentName} 声明为远程主机(${connection.ssh.host}),进程附加(PID)模式暂不支持远端:` +
          'debugpy 适配器按本地 PID 附加。请改用端口模式——先起 ssh -L 隧道 connect 到组件 debugpy 端口。'
      );
      return false;
    }
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
    attachConfig: vscode.DebugConfiguration,
    /** IDE-AUD-003:自家会话捕获即上报(隧道存活绑定等外部存活面) */
    onSession?: (session: vscode.DebugSession) => void
  ): Promise<AttachGuardOutcome> {
    // IDE-AUD-002:每次尝试唯一身份。配置名(组件/端口或进程名)可相同——
    // 两个同名附加并发时,onDidStartDebugSession 无法只按名字区分彼此;
    // 给配置打上本次尝试的 __kodeAttachId,会话启动事件携带的
    // session.configuration 据此精确归属(不同 workspace/同名启动也不误认)。
    // 自定义字段经 DebugConfiguration 索引签名透传,无 resolveDebugConfiguration
    // 改写配置,会话侧 configuration 保留该标记。
    const attachAttemptId = nextAttachAttemptId();
    const markedConfig: vscode.DebugConfiguration = {
      ...attachConfig,
      __kodeAttachId: attachAttemptId
    };
    let ownSession: vscode.DebugSession | undefined;
    let cleanupDone = false;
    let trackerDisposed = false;
    // IDE-AUD-001:闸返回态两标记——abandoned=截止/取消已收口(stop 被调过),
    // 此时新出现的自家会话应立即停(start 可能永不落定,不能等 onStartSettled);
    // startSettled=start 承诺已落定,追踪订阅释放的唯一权威时点
    let abandoned = false;
    let startSettled = false;
    const sessionTracker = vscode.debug.onDidStartDebugSession(session => {
      // IDE-AUD-002:只认本尝试的标记,不按名字——同名无关会话/其他尝试的
      // 会话(即便同名)一律不捕获;本尝试会话已捕获则忽略后到者。
      if (ownSession || session.configuration?.__kodeAttachId !== attachAttemptId) {
        return;
      }
      ownSession = session;
      // IDE-AUD-003:隧道等外部存活面需要真实会话句柄,捕获即上报
      onSession?.(session);
      // 闸已返回(超时/取消)后才启动的自家会话立即停,不等 start 落定;
      // timely 附加此刻闸未返回(abandoned=false),绝不误伤正常会话
      if (abandoned) {
        cleanupOwnSession();
      }
    });
    this.pendingAttachTrackers.add(sessionTracker);
    // 会话追踪订阅必须活到 start 落定:迟到成功的会话在闸返回后才启动,
    // 提前 dispose 会捕获不到句柄(F01 反例);两种落定(timely/迟到)各释放
    // 一次,幂等;永不落定的 start 由管理器 dispose 兜底
    const disposeTracker = (): void => {
      if (trackerDisposed) { return; }
      trackerDisposed = true;
      sessionTracker.dispose();
      this.pendingAttachTrackers.delete(sessionTracker);
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
            // IDE-AUD-002:startDebugging 用带尝试标记的配置,会话启动事件的
            // configuration 才能据标记归属本次尝试。
            start: () => Promise.resolve(vscode.debug.startDebugging(undefined, markedConfig)),
            // IDE-REV-002:窗内截止/取消只停自家会话;stopDebugging(undefined)
            // 等同无参(停全部)——无自家句柄就一次都不停,迟到面由 REV-003 接
            stop: () => {
              abandoned = true;
              cleanupOwnSession();
            },
            // IDE-REV-003:超时/取消返回后 start 才落定——迟到成功时自家会话
            // 此刻才创建,清一次且不二次提示;迟到异常同样只经此回调不外泄;
            // 两种落定都释放追踪订阅(AUD-001:释放权威时点)
            onStartSettled: late => {
              startSettled = true;
              if (late) { cleanupOwnSession(); }
              disposeTracker();
            },
            notify: message => void vscode.window.showWarningMessage(message),
            onCancel: listener => token.onCancellationRequested(() => listener())
          })
      );
    } finally {
      // IDE-AUD-001:闸返回不得提前释放订阅(F01 反例=finally 无条件释放,
      // 迟到会话捕获不到句柄)——仅在 start 已落定(onStartSettled 已释放过,
      // 幂等)时收口;未落定的存活订阅由管理器 dispose 兜底
      if (startSettled) {
        disposeTracker();
      }
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
    // IDE-AUD-001:永不落定的 start 所遗留的追踪订阅,卸载兜底释放
    for (const tracker of this.pendingAttachTrackers) {
      tracker.dispose();
    }
    this.pendingAttachTrackers.clear();
    // IDE-AUD-003:成功附加后仍存活的隧道(会话未终止/未识别),卸载兜底关闭
    for (const teardown of this.tunnelTeardowns) {
      teardown();
    }
    this.tunnelTeardowns.clear();
  }
}

// SRC-012:进程/端口启动条目辅助已拆至 debugConfigLaunch.ts;此处再导出保持
// 既有 `from './debugConfig'` 导入路径不变(remoteProcessList 等消费方)。
export {
  buildPortLaunchEntry,
  buildProcessPickItems,
  dropSupersededPortEntries,
  isKbengineGeneratedEntry,
  KBENGINE_LAUNCH_GENERATED_KEY,
  makeProcessLister,
  mergePortLaunchEntry,
  parsePsProcesses,
  parseTasklistProcesses,
  pidFromPick,
  portLaunchEntryName,
  readRemoteTargets,
  remoteTargetPathMappings
} from './debugConfigLaunch';
export type { RemoteDebugTarget } from './debugConfigLaunch';
