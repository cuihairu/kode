// SRC-001 L4 抽象层(KODE-ARCH 纯移动,零行为变更):组合根的服务器/调试域激活器。
// 职责(分析文档 docs/design/src-001-extension-abstraction-layers.md L4):
// serverManager 初始化与状态订阅、telnet 探测服务与状态灯/面板、玩家数据只读
// 面板、远程服务器管理视图与增删选命令、debugpy 注入链(自动注入/预检/命名
// 实例端口窗)、调试会话注册表与 Debug Targets 状态树、server 控制命令、
// 调试配置命令(start/attach/attachRemote/py-spy dump/火焰图/waitAtStartup)、
// 机器人控制命令、server 运行状态栏。
// 形态:deps 仅注入 context;四个共享实例(serverManager/telnetService/
// telnetWebView/debugConfigManager)返回组合根,logging 接线/发现报告/释放
// 闭包经句柄消费;subscriptions push 原文随迁,销毁所有权不变。

import { l10nText } from '../nlsRuntime';
import * as vscode from 'vscode';
import { registerDebugpyInjectCommand } from '../debugpyInjectCommand';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  KBEngineServerManager,
  SERVER_COMPONENTS,
  parseServerKey,
  DEFAULT_TARGET_ID,
  type TargetOutcome,
} from '../serverManager';
import {
  injectDebugpyAfterStart,
  injectDebugpyListen,
  syncDebugpyPackage,
  allocateDebugpyInstancePort,
  autoDebugpyEnabled,
  debugpyPackageDir,
  debugpyPortFor,
  type DebugpyInjectTarget,
} from '../autoDebugpy';
import { checkInterpreterDebugpy, debugpyPreflightAllowsInjection, debugpyPreflightDeps } from '../debugpyPreflight';
import {
  findEngineEntryScript,
  injectWaitBootstrap,
  removeWaitBootstrap,
  debugpyWaitAtStartupEnabled,
} from '../debugpyWaitAtStartup';
import { prefillEntryScriptBreakpoints } from '../entryScriptBreakpoint';
import {
  DebugSessionRegistry,
  applySessionEndBehavior,
  SESSION_END_BEHAVIOR_DEFAULT,
  type DebugSessionEndBehavior,
  type DebugSessionLike,
} from '../debugSessionRegistry';
import { buildDebugStatusRows, type DebugInjectionEntry } from '../debugStatusBoard';
import { DebugTargetTreeProvider } from '../debugStatusTree';
import { runListeningRowFocus } from '../debugTargetFocus';
import { RuntimeLogLevel } from '../logHub';
import { DEBUG_ATTACH_MODE_STATE_KEY, DebugConfigManager } from '../debugConfig';
import {
  PYSPY_RECORD_DEFAULTS,
  defaultSpawnRunner,
  ensurePyspyReady,
  resolvePyspyCommand,
  runPyspyDump,
  runPyspySchedule,
} from '../pyspyDump';
import { resolveProfileInterpreter } from '../profileInterpreter';
import { buildSshExecArgs, readSshHostsFromHome, type SshHostsSnapshot } from '../remoteConnection';
import { listRemoteProcesses, pickRemoteProcessId } from '../remoteProcessList';
import {
  LOCAL_SERVER_ID,
  REMOTE_SERVERS_MANUAL_KEY,
  REMOTE_SERVERS_SELECTED_KEY,
  RemoteServerTreeProvider,
  buildRemoteServerNodes,
} from '../remoteServerTree';
import { pickServerComponent, ServerControlProvider } from '../explorerProviders';
import { resolveServerComponent } from '../serverCommandTarget';
import { setDefaultScriptRuntime } from '../quickActions';
import { readDerivedTelnetTargets } from '../telnetDeriveTargets';
import { makeProbeOne, TelnetService, updateTelnetStatusBar } from '../telnetService';
import { TelnetWebView } from '../telnetWebView';
import { runBotsAddCommand, runBotsCountCommand, type BotsControlDeps } from '../botsControl';
import { TelnetTreeProvider } from '../telnetTree';
import { ensureConfigDerivedScanRoot } from '../configDerive';
import { PlayerDataTreeProvider, queryPlayerByDbid, testPlayerDatabaseConnection } from '../playerDataPanel';

export interface ServerControlsDeps {
  context: vscode.ExtensionContext;
}

/** L4 共享句柄:logging 接线/发现报告/释放闭包经此消费 server/debug 域实例 */
export interface ServerControlsShared {
  serverManager: KBEngineServerManager;
  telnetService: TelnetService;
  telnetWebView: TelnetWebView;
  debugConfigManager: DebugConfigManager;
}

export function activateServerControls(deps: ServerControlsDeps): ServerControlsShared {
  const { context } = deps;

  // 初始化服务器管理器
  const serverManager = new KBEngineServerManager(context);
  setDefaultScriptRuntime(serverManager.processManager, serverManager.logHub);

  // telnet 探测与联动(工单:telnet 探测+联动):目标解析 设置 →
  // kbengine.xml <telnet_service>(未指定路径时按 configPath/约定路径探测)
  // → 引擎 kbengine_defaults.xml(批112 用户令);配置未开 telnet → 空目标;
  // 5s 低频探测
  const telnetService = new TelnetService({
    getTargets: () => {
      // CFG-007:目标列表按配置派生(telnet 段开启 → 列出含派生端口,关闭
      // → 空;派生不可用/显式端口/密码保护未覆盖时旧路径兜底,读同一份配置)。
      const targets = readDerivedTelnetTargets();
      // 批111 用户令:配置未开 telnet 不展示 telnet 相关的东西——状态灯、
      // 独立树视图与命令面板入口随空目标/context key 自然隐藏。探测每轮
      // 重读目标,context 同步刷新。
      void vscode.commands.executeCommand(
        'setContext',
        'kbengine.telnetConfigured',
        targets.length > 0
      );
      return targets;
    },
    intervalMs: Math.max(1, vscode.workspace.getConfiguration('kbengine').get<number>('telnet.probeIntervalSeconds', 5)) * 1000
  });
  telnetService.start();

  // Servers 进程树(批112 用户令:telnet 不与 server 进程混置,已移出本树)
  const serverControlProvider = new ServerControlProvider(serverManager);
  const serverControlRegistration = vscode.window.registerTreeDataProvider(
    'kbengine.serverControl',
    serverControlProvider
  );
  context.subscriptions.push(serverControlRegistration);

  // telnet 独立树视图(批112 用户令:单独分类,与 server 进程分开)
  const telnetTreeProvider = new TelnetTreeProvider(telnetService);
  const telnetTreeRegistration = vscode.window.registerTreeDataProvider(
    'kbengine.telnetStatus',
    telnetTreeProvider
  );
  context.subscriptions.push(telnetTreeRegistration);

  // CLONE-P5 骨架:「玩家数据」专用只读面板(用户令 2026-11-06:不做通用
  // MySQL 客户端、零编辑字段、只能查询)。连接档案真源在 Rust
  // derive_database(configDerive 缓存);查询经 databaseDrift 只读执行器。
  const playerDataProvider = new PlayerDataTreeProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('kbengine.playerData', playerDataProvider),
    vscode.commands.registerCommand('kbengine.playerData.refresh', async () => {
      await ensureConfigDerivedScanRoot().catch(() => {
        /* 派生失败:面板如实展示未找到 */
      });
      playerDataProvider.refresh();
    }),
    vscode.commands.registerCommand('kbengine.playerData.testConnection', async () => {
      await ensureConfigDerivedScanRoot().catch(() => {
        /* 同上:派生失败走降级文案 */
      });
      playerDataProvider.refresh();
      const message = await testPlayerDatabaseConnection();
      void vscode.window.showInformationMessage(message);
    }),
    vscode.commands.registerCommand('kbengine.playerData.queryByDbid', async () => {
      await ensureConfigDerivedScanRoot().catch(() => {
        /* 同上 */
      });
      const dbid = await vscode.window.showInputBox({
        prompt: '玩家 DBID(十进制正整数;只读查询 tbl_Account)',
        placeHolder: '如 1',
        validateInput: value =>
          /^\d+$/.test(value.trim()) || value.trim() === ''
            ? null
            : '仅接受十进制正整数'
      });
      if (dbid === undefined || dbid.trim() === '') {
        return;
      }
      const message = await queryPlayerByDbid(dbid);
      void vscode.window.showInformationMessage(message);
    })
  );

  // IDE-PDBG-004 远程服务器管理视图:~/.ssh/config 主机 + 手动项,「本地」
  // 恒首位默认选中;选中态供 debug/py-spy 分派(debug.json 组件级声明仍最
  // 优先)。快照先建空,后台读 config 后刷新。
  let sshHostsSnapshot: SshHostsSnapshot | null = null;
  const readManualHosts = (): string[] =>
    context.workspaceState.get<string[]>(REMOTE_SERVERS_MANUAL_KEY) ?? [];
  const selectedServerId = (): string =>
    context.workspaceState.get<string>(REMOTE_SERVERS_SELECTED_KEY) ?? LOCAL_SERVER_ID;
  const remoteServerTreeProvider = new RemoteServerTreeProvider({
    getSnapshot: () => sshHostsSnapshot,
    getManualHosts: readManualHosts,
    getSelected: selectedServerId
  });
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('kbengine.remoteServers', remoteServerTreeProvider)
  );
  const loadSshHosts = async (): Promise<void> => {
    sshHostsSnapshot = await readSshHostsFromHome(
      configPath => fs.promises.readFile(configPath, 'utf8'),
      os.homedir()
    );
    remoteServerTreeProvider.refresh();
  };
  void loadSshHosts();
  const selectRemoteServerCommand = vscode.commands.registerCommand(
    'kbengine.remoteServers.select',
    async (hostId?: string) => {
      const candidates = buildRemoteServerNodes(
        sshHostsSnapshot ?? { hosts: [] },
        readManualHosts(),
        selectedServerId()
      );
      const target = typeof hostId === 'string'
        ? candidates.find(node => node.id === hostId)?.id
        : (await vscode.window.showQuickPick(
            candidates.map(node => ({
              label: node.id === LOCAL_SERVER_ID ? '本地(直接执行)' : node.id,
              description: node.selected ? '当前' : '',
              id: node.id
            })),
            { placeHolder: '选择 debug 与 py-spy 的执行服务器(debug.json 组件级声明优先)' }
          ))?.id;
      if (target === undefined) {
        return; // 取消或无效 id:不动选择
      }
      await context.workspaceState.update(REMOTE_SERVERS_SELECTED_KEY, target);
      remoteServerTreeProvider.refresh();
      vscode.window.showInformationMessage(
        target === LOCAL_SERVER_ID
          ? '已切回本地:debug 与 py-spy 在本机执行'
          : `已选择 ${target}:debug 与 py-spy 经 ssh 执行(端口模式走 -L 隧道)`
      );
    }
  );
  context.subscriptions.push(selectRemoteServerCommand);
  const addRemoteServerCommand = vscode.commands.registerCommand(
    'kbengine.remoteServers.add',
    async () => {
      const host = await vscode.window.showInputBox({
        prompt: '手动添加远程主机(ssh 别名或 user@host;ProxyJump 等参数请写 ~/.ssh/config)',
        validateInput: value => value.trim().length > 0 ? null : '主机名不能为空'
      });
      if (!host) {
        return;
      }
      const manual = [...new Set([...readManualHosts(), host.trim()])];
      await context.workspaceState.update(REMOTE_SERVERS_MANUAL_KEY, manual);
      remoteServerTreeProvider.refresh();
      vscode.window.showInformationMessage(`已添加远程主机 ${host.trim()}`);
    }
  );
  context.subscriptions.push(addRemoteServerCommand);
  const removeRemoteServerCommand = vscode.commands.registerCommand(
    'kbengine.remoteServers.remove',
    async (node?: { id?: string }) => {
      const hostId = typeof node?.id === 'string' ? node.id : undefined;
      if (!hostId) {
        return;
      }
      const manual = readManualHosts().filter(item => item !== hostId);
      await context.workspaceState.update(REMOTE_SERVERS_MANUAL_KEY, manual);
      // 删的是当前选中项 → 回落本地(不悬空指向不存在的选择)
      if (selectedServerId() === hostId) {
        await context.workspaceState.update(REMOTE_SERVERS_SELECTED_KEY, LOCAL_SERVER_ID);
      }
      remoteServerTreeProvider.refresh();
      vscode.window.showInformationMessage(`已移除手动主机 ${hostId}`);
    }
  );
  context.subscriptions.push(removeRemoteServerCommand);
  const refreshRemoteServersCommand = vscode.commands.registerCommand(
    'kbengine.remoteServers.refresh',
    async () => {
      await loadSshHosts();
      vscode.window.showInformationMessage(
        `远程主机已刷新:${sshHostsSnapshot?.hosts.length ?? 0} 台来自 ~/.ssh/config${sshHostsSnapshot?.configExists === false ? '(文件不存在)' : ''}`
      );
    }
  );
  context.subscriptions.push(refreshRemoteServersCommand);

  // 服务器状态变化时刷新视图
  // 调试启动即 attach(2026-10-27 ③b):kbengine.debug.autoDebugpy 开时,
  // 组件进 Running 即联动注入(injectDebugpyAfterStart 自带开关闸/等 telnet
  // 就绪轮询/单组件失败只记日志);注入用短命客户端,不碰面板持久会话。
  // 已注入集合随组件退出清位,重启组件可再注入。
  const debugpyInjected = new Set<string>();
  // DBG-001:命名实例 → 窗口分配的 debugpy 口;随实例退出清位,空出的口
  // 可被后续实例复用。默认实例不进 Map(走端口分配表)。
  const debugpyPortByServerKey = new Map<string, number>();
  // DBG-008 注入结果面(serverKey → listening/failed):autoDebugpy 的
  // report 回调、预检拦截、等待模式播种、窗口耗尽四路喂;进程退出时
  // 随实例清位。状态树据此四态归因(未注入=无条目)。
  const debugInjections = new Map<string, DebugInjectionEntry>();
  // 状态树刷新面(树 provider 在下方创建;注入回调可能先于其定义发生,
  // 用前置持有器解前向引用)
  let refreshDebugTargets = (): void => undefined;
  const recordInjection = (serverKey: string, entry: DebugInjectionEntry): void => {
    debugInjections.set(serverKey, entry);
    refreshDebugTargets();
  };
  // DBG-003 注入统一入口(默认实例 string 形/命名实例对象形共用):发起前
  // 先做所选解释器 debugpy 预检——缺依赖在注入前给可操作状态;资产树已
  // 同步过包则照常注入(引擎导入的是资产树包,不依赖本机解释器)。
  const runDebugpyInjection = (injectTarget: DebugpyInjectTarget): void => {
    const log = (componentName: string, level: 'info' | 'warning' | 'error', text: string): void => {
      serverManager.logHub.ingest({
        source: 'process',
        component: componentName,
        level: level === 'error' ? RuntimeLogLevel.ERROR : level === 'warning' ? RuntimeLogLevel.WARNING : RuntimeLogLevel.INFO,
        text
      });
    };
    void (async () => {
      if (autoDebugpyEnabled()) {
        const preflight = await checkInterpreterDebugpy(debugpyPreflightDeps());
        const allows = debugpyPreflightAllowsInjection(
          preflight,
          fs.existsSync(debugpyPackageDir(serverManager.getConfigPath()))
        );
        if (!allows) {
          const componentName = typeof injectTarget === 'string' ? injectTarget : injectTarget.component;
          log(componentName, 'warning', preflight.message);
          recordInjection(
            typeof injectTarget === 'string' ? injectTarget : `${injectTarget.component}#${injectTarget.targetId}`,
            { outcome: 'failed', detail: preflight.message }
          );
          return;
        }
      }
      // DBG-004 等待连接模式:默认实例由入口脚本引导块在启动最早期
      // listen+wait(端口同表),telnet 注入不再重复 listen,跳过并记一笔。
      // DBG-008:引导块持有表口监听=「监听」态(表外组件 machine 无 env,不播)。
      if (debugpyWaitAtStartupEnabled() && typeof injectTarget === 'string') {
        const waitPort = debugpyPortFor(injectTarget);
        log(injectTarget, 'info', 'autoDebugpy:等待连接模式已由启动引导监听,跳过 telnet 注入');
        if (waitPort !== undefined) {
          recordInjection(injectTarget, { outcome: 'listening', port: waitPort });
        }
        return;
      }
      await injectDebugpyAfterStart([injectTarget], () => telnetService.getTargets(), {
        log,
        report: (serverKey, outcome, detail, port) =>
          recordInjection(serverKey, { outcome, detail, port })
      });
    })();
  };
  const serverStatusSubscription = serverManager.onDidChangeStatus(() => {
    serverControlProvider.refresh();
    updateStatusBar(serverManager);
    refreshDebugTargets();
    const running = new Set(serverManager.getRunningServers().keys());
    for (const gone of [...debugpyInjected]) {
      if (!running.has(gone)) {
        debugpyInjected.delete(gone);
        debugpyPortByServerKey.delete(gone);
        debugInjections.delete(gone);
      }
    }
    for (const component of running) {
      if (debugpyInjected.has(component)) {
        continue;
      }
      debugpyInjected.add(component);
      // RUN-001:登记键可带 #targetId 后缀(同组件多实例);默认实例 telnet
      // 目标与调试端口按纯组件名(分配表);DBG-001 命名实例按组件窗口分
      // 配独立口——同类型多实例各持一口,attach 可指向指定实例。
      const { componentName: targetName, targetId } = parseServerKey(component);
      if (targetId === DEFAULT_TARGET_ID) {
        runDebugpyInjection(targetName);
        continue;
      }
      const port = allocateDebugpyInstancePort(targetName, debugpyPortByServerKey.values());
      if (port === undefined) {
        serverManager.logHub.ingest({
          source: 'process',
          component: targetName,
          level: RuntimeLogLevel.WARNING,
          text: `autoDebugpy:实例 ${targetId} 组件端口窗口已耗尽(${targetName} 同组件命名实例超过 8 个),跳过注入`
        });
        recordInjection(component, {
          outcome: 'failed',
          detail: `同组件命名实例超过 8 个,端口窗口耗尽,未注入`
        });
        continue;
      }
      debugpyPortByServerKey.set(component, port);
      runDebugpyInjection({ component: targetName, targetId, port });
    }
  });
  context.subscriptions.push(serverStatusSubscription);

  // DBG-005 调试会话注册表:按生成条目名(表条目=默认实例,`#` 条目=命名
  // 实例)把 VS Code 调试会话挂回运行目标——两个 cellapp 的会话与进程
  // 状态各自可辨;工作台消费面在 DBG-008。
  const debugSessionRegistry = new DebugSessionRegistry({
    // vscode.DebugSession 是识别面的超集(configuration 索引签名),按
    // 注册表的最小面收窄
    onStart: listener =>
      vscode.debug.onDidStartDebugSession(session => listener(session as unknown as DebugSessionLike)),
    onTerminate: listener =>
      vscode.debug.onDidTerminateDebugSession(session => listener(session as unknown as DebugSessionLike))
  });
  context.subscriptions.push(debugSessionRegistry);

  // DBG-006 断开只影响指定目标:会话结束按 kbengine.debug.sessionEndBehavior
  // 决定是否停进程——detach(默认)零停止;stop-process 只停该会话自己的
  // 目标(serverKey 精确到实例,同组件其他实例不受牵连)。
  context.subscriptions.push(
    debugSessionRegistry.onLinkTerminated(link => {
      const behavior = vscode.workspace
        .getConfiguration('kbengine')
        .get<DebugSessionEndBehavior>('debug.sessionEndBehavior', SESSION_END_BEHAVIOR_DEFAULT);
      applySessionEndBehavior(behavior, link, (component, targetId) => {
        void serverManager.stopComponent(
          component,
          targetId === DEFAULT_TARGET_ID ? undefined : targetId
        );
      });
    })
  );

  // DBG-008 Debug Targets 状态树:进程在册面 × 注入结果面 × 会话挂链面
  // 合成四态板(未注入/监听/已附加/失败)的工作台面;三面任一变化都
  // 刷新(注入回报走 recordInjection,进程变化走状态订阅,会话起止走
  // debug 事件双订阅)。
  const getDebugStatusRows = () => {
    const runningLike = new Map<string, { component: string; targetId: string; status: string }>();
    for (const [serverKey, server] of serverManager.getRunningServers()) {
      runningLike.set(serverKey, {
        component: server.component.name,
        targetId: server.targetId,
        status: String(server.status)
      });
    }
    return buildDebugStatusRows(runningLike, debugInjections, debugSessionRegistry);
  };
  const debugTargetTreeProvider = new DebugTargetTreeProvider({ getRows: getDebugStatusRows });
  refreshDebugTargets = () => debugTargetTreeProvider.refresh();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('kbengine.debugTargets', debugTargetTreeProvider)
  );
  context.subscriptions.push(
    vscode.debug.onDidStartDebugSession(() => debugTargetTreeProvider.refresh())
  );
  context.subscriptions.push(
    vscode.debug.onDidTerminateDebugSession(() => debugTargetTreeProvider.refresh())
  );

  // KODE-CFG-006:entryScriptFile 自动断点——attach/端口模式调试目标启动
  // 即按配置派生结果(CFG-004 推导链经 configDerive 缓存)预填入口脚本
  // 断点,免手点;派生未就绪/入口缺失 → 如实不预填并出诊断(见
  // entryScriptBreakpoint),绝不干扰调试会话。
  context.subscriptions.push(
    vscode.debug.onDidStartDebugSession(session => {
      const name = (session.configuration as { name?: string } | undefined)?.name ?? '';
      if (name.startsWith('KBEngine: Python attach to ')) {
        void prefillEntryScriptBreakpoints();
      }
    })
  );

  // DBG-008 点击定位:已附加=打开 Run and Debug 视图(调用堆栈里可见
  // 该会话,条目名一并给出);监听/失败/未注入=如实提示端口/细节/开启
  // 路径;无参调用(命令面板)=指引去视图点击。
  const focusDebugTargetCommand = vscode.commands.registerCommand(
    'kbengine.debug.focusTarget',
    async (serverKey?: string) => {
      if (!serverKey) {
        void vscode.window.showInformationMessage(
          '在 KBEngine Explorer 的 Debug Targets 视图中点击某个目标,查看/定位其调试状态'
        );
        return;
      }
      const row = getDebugStatusRows().find(item => item.serverKey === serverKey);
      if (!row) {
        void vscode.window.showInformationMessage(`${serverKey} 不在运行中(进程已停)`);
        return;
      }
      if (row.phase === 'attached') {
        await vscode.commands.executeCommand('workbench.view.debug');
        const names = debugSessionRegistry
          .linksFor(serverKey)
          .map(link => link.session.name)
          .join(' / ');
        void vscode.window.showInformationMessage(
          l10nText(
            '{serverKey} attached: {names} (Run and Debug view opened; the session is visible in the call stack)',
            { serverKey, names }
          )
        );
        return;
      }
      if (row.phase === 'listening') {
        // 下一步控件(端口模式):立即附加 / 打开 launch.json(先动态写好再开),
        // 行为面收在 debugTargetFocus,副作用在此装配
        const result = await runListeningRowFocus(serverKey, row.port, {
          attach: componentName => debugConfigManager.attachToComponent(componentName),
          openLaunchJson: async (componentName, port) => {
            const folder = vscode.workspace.workspaceFolders?.[0];
            if (!folder) {
              return { ok: false, detail: '没有打开的工作区,写不了 launch.json' };
            }
            // 按组件声明的 host 写(缺省 127.0.0.1),与 attach 取口同源
            const host =
              debugConfigManager.getComponentConfig(componentName).debugpyHost || '127.0.0.1';
            const state = await debugConfigManager.ensurePortLaunchConfig(
              componentName,
              host,
              port
            );
            if (!state.ok) {
              return state;
            }
            const document = await vscode.workspace.openTextDocument(
              vscode.Uri.joinPath(folder.uri, '.vscode', 'launch.json')
            );
            await vscode.window.showTextDocument(document);
            return state;
          },
          show: async (message, actions) => vscode.window.showInformationMessage(message, ...actions)
        });
        if (result.outcome === 'write-failed') {
          void vscode.window.showWarningMessage(
            `launch.json 未写入:${result.detail}(可手动跑 kbengine.debug.updateLaunchJson)`
          );
        }
        return;
      }
      if (row.phase === 'failed') {
        void vscode.window.showErrorMessage(
          `${serverKey} 注入失败:${row.detail ?? '(无细节)'}——处理后在 Debug Targets 视图确认,或重启组件重试`
        );
        return;
      }
      void vscode.window.showInformationMessage(
        l10nText(
          '{serverKey} not injected: enable kbengine.debug.autoDebugpy (launch-time injection) or kbengine.debug.waitAtStartup (startup wait) and restart the component',
          { serverKey }
        )
      );
    }
  );
  context.subscriptions.push(focusDebugTargetCommand);
  // telnet 面板与状态灯
  const telnetWebView = new TelnetWebView(context, telnetService);
  const telnetStatusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    99
  );
  const showTelnetPanelCommand = vscode.commands.registerCommand('kbengine.telnet.showPanel', () => {
    telnetWebView.show();
  });
  // 断开当前 telnet 会话:面板 Ctrl+]/Ctrl+D 与顶部入口(telnet 树标题栏
  // 按钮/命令面板)共用此命令
  const disconnectTelnetCommand = vscode.commands.registerCommand('kbengine.telnet.disconnect', () => {
    telnetWebView.disconnectActive();
  });
  context.subscriptions.push(showTelnetPanelCommand, disconnectTelnetCommand, telnetStatusBarItem);
  const telnetStateSubscription = telnetService.onDidChange(() => {
    telnetTreeProvider.refresh();
    updateTelnetStatusBar(telnetService, telnetStatusBarItem);
  });
  context.subscriptions.push(telnetStateSubscription);
  updateTelnetStatusBar(telnetService, telnetStatusBarItem);

  // 机器人控制(IDE-BOT-001 A 案:本地单机闭环):经 bots 进程 telnet
  // python 层 addBots/计数;引擎无逐个减员 API,减员=停进程(编排层与
  // 命令提示都如实说明)。白名单闸在 telnet 服务层,此处只做编排。
  const botsChannel = vscode.window.createOutputChannel('KBEngine 机器人');
  const botsControlDeps: BotsControlDeps = {
    getBotsTarget: () => telnetService.getTargets().find(target => target.component === 'bots') ?? null,
    connectTarget: key => telnetService.connectTarget(key),
    getSessionState: key => telnetService.getSessionState(key),
    sendCommand: (key, command) => telnetService.sendCommand(key, command),
    getOutput: key => telnetService.getOutput(key),
    sleep: ms => new Promise<void>(resolve => setTimeout(resolve, ms)),
    withInput: (prompt, placeholder, validate) =>
      vscode.window.showInputBox({ prompt, placeHolder: placeholder, validateInput: validate }),
    showInformationMessage: message => vscode.window.showInformationMessage(message),
    showErrorMessage: message => vscode.window.showErrorMessage(message),
    channel: botsChannel
  };
  const botsAddCommand = vscode.commands.registerCommand('kbengine.bots.add', () => {
    void runBotsAddCommand(botsControlDeps);
  });
  const botsCountCommand = vscode.commands.registerCommand('kbengine.bots.count', () => {
    void runBotsCountCommand(botsControlDeps);
  });
  context.subscriptions.push(botsChannel, botsAddCommand, botsCountCommand);
  // 注册服务器控制命令
  const startServerCommand = vscode.commands.registerCommand(
    'kbengine.server.start',
    (target) => {
      const component = resolveServerComponent(target);
      // 2026-10-10 fix(CI 38027480815):必须返回 Promise,否则 executeCommand 立刻
      // 返回、在途启动的报错渗进后续测试(beforeEach 已清,旧 async 仍会吐错)。
      return component
        ? serverManager.startComponent(component)
        : serverManager.startAutoComponents();
    }
  );
  context.subscriptions.push(startServerCommand);

  const stopServerCommand = vscode.commands.registerCommand(
    'kbengine.server.stop',
    (target) => {
      const component = resolveServerComponent(target);
      return component
        ? serverManager.stopComponent(component.name)
        : serverManager.stopAll();
    }
  );
  context.subscriptions.push(stopServerCommand);

  const restartServerCommand = vscode.commands.registerCommand(
    'kbengine.server.restart',
    (target) => {
      const component = resolveServerComponent(target);
      if (!component) {
        return undefined;
      }

      return serverManager.restartComponent(component.name);
    }
  );
  context.subscriptions.push(restartServerCommand);

  // AUD-038(R2-F14):失败单目标重试产品入口——retryTarget 原只被管理器与
  // 测试使用,此命令把它接到命令面。带目标载荷直接重试该组件;无载荷时
  // 从登记失败的组启动目标中 QuickPick 选择,失败原因如实显示。重试只作用
  // 该失败目标,在册实例(report already-running)不重启;取消/超时沿用
  // startTargetGroup 的既有依赖/就绪守卫(依赖与就绪超时)。
  interface RetryTargetPickItem extends vscode.QuickPickItem {
    outcome: TargetOutcome;
  }
  const describeServerRetryOutcome = (outcome: TargetOutcome): string => {
    switch (outcome.outcome) {
      case 'started': return '已启动';
      case 'already-running': return '已在运行,未重启';
      case 'spawn-failed': return '启动失败(进程未启动)';
      case 'dependency-failed': return `依赖未就绪: ${outcome.dependency}`;
      case 'dependency-timeout': return `依赖等待超时: ${outcome.dependency}`;
      case 'not-found': return '未知组件';
      default: return outcome.outcome;
    }
  };
  const reportServerRetryOutcome = (outcome: TargetOutcome): void => {
    const label = outcome.targetId === DEFAULT_TARGET_ID
      ? outcome.component
      : `${outcome.component} 实例 ${outcome.targetId}`;
    switch (outcome.outcome) {
      case 'started':
        vscode.window.showInformationMessage(`${label} 已启动`);
        break;
      case 'already-running':
        vscode.window.showInformationMessage(`${label} 已在运行,未重启`);
        break;
      case 'spawn-failed':
        vscode.window.showErrorMessage(`${label} 启动失败`);
        break;
      case 'dependency-failed':
        vscode.window.showErrorMessage(`${label} 未启动: 依赖 ${outcome.dependency} 未就绪`);
        break;
      case 'dependency-timeout':
        vscode.window.showErrorMessage(`${label} 未启动: 等待依赖 ${outcome.dependency} 超时`);
        break;
      case 'not-found':
        vscode.window.showErrorMessage(`${label} 未知组件`);
        break;
      default:
        vscode.window.showErrorMessage(`${label} ${outcome.outcome}`);
    }
  };
  const retryServerCommand = vscode.commands.registerCommand(
    'kbengine.server.retry',
    async (target) => {
      const component = resolveServerComponent(target);
      if (component) {
        const outcome = await serverManager.retryTarget({ component: component.name });
        reportServerRetryOutcome(outcome);
        return outcome;
      }
      const failed = serverManager.getFailedTargetsForRetry();
      if (failed.length === 0) {
        vscode.window.showInformationMessage('没有可重试的失败目标');
        return undefined;
      }
      const picked = await vscode.window.showQuickPick<RetryTargetPickItem>(
        failed.map(item => ({
          label: item.targetId === DEFAULT_TARGET_ID ? item.component : `${item.component} 实例 ${item.targetId}`,
          description: describeServerRetryOutcome(item),
          outcome: item
        })),
        { placeHolder: '选择要重试的失败目标' }
      );
      if (!picked) {
        return undefined;
      }
      const outcome = await serverManager.retryTarget({
        component: picked.outcome.component,
        targetId: picked.outcome.targetId
      });
      reportServerRetryOutcome(outcome);
      return outcome;
    }
  );
  context.subscriptions.push(retryServerCommand);
  // 初始化调试配置管理器
  // IDE-PDBG-004:连接分派的 ssh 面(主机表 + 视图选中态)接进调试管理器
  // 端口模式「下一步」(IDE-PDBG-002 死路修复):一键起监听面接进管理器——
  // 引擎 import 的是资产树包(系统 pip 装好 ≠ 引擎能 import),先缺了就同步,
  // 再等该组件 telnet 就绪经 :python 层发 debugpy.listen;结果同口径记进
  // 状态板(监听/失败),Debug Targets 视图看得见这一步。
  const startDebugpyListenerNow = async (
    componentName: string,
    port: number
  ): Promise<{ ok: boolean; detail: string }> => {
    const target = telnetService.getTargets().find(item => item.component === componentName);
    if (!target) {
      return {
        ok: false,
        detail:
          `${componentName} 未开 telnet(缺 <telnet_service>),发不了 listen——改用 kbengine.debug.waitAtStartup ` +
          `启动等待,或在代码里 debugpy.listen(("127.0.0.1", ${port}))`
      };
    }
    const assetsRoot = serverManager.getConfigPath();
    if (!fs.existsSync(debugpyPackageDir(assetsRoot))) {
      const synced = await syncDebugpyPackage(context, assetsRoot);
      if (synced.status === 'error') {
        return { ok: false, detail: `资产树缺 debugpy 包且同步失败:${synced.message}` };
      }
    }
    if (!(await makeProbeOne(1500)(target.host, target.port))) {
      const detail = `telnet ${target.host}:${target.port} 连不上(组件未运行或 telnet 未开)`;
      recordInjection(componentName, { outcome: 'failed', detail });
      return { ok: false, detail };
    }
    const result = await injectDebugpyListen(target, port);
    if (result.status === 'injected') {
      recordInjection(componentName, { outcome: 'listening', detail: result.detail, port });
      return { ok: true, detail: result.detail };
    }
    recordInjection(componentName, { outcome: 'failed', detail: result.detail });
    return { ok: false, detail: `${componentName} telnet 注入失败——${result.detail}` };
  };

  const debugConfigManager = new DebugConfigManager(context, {
    listSshHosts: () => sshHostsSnapshot?.hosts ?? [],
    selectedServer: selectedServerId,
    startDebugpyListener: startDebugpyListenerNow
  });

  // 注册调试相关命令(DBG-001:运行中的命名实例逐条透传,launch.json 里
  // 各得一条指向自己分配口的 attach 条目)
  const updateLaunchJsonCommand = vscode.commands.registerCommand(
    'kbengine.debug.updateLaunchJson',
    async () => {
      const runningInstances = [...serverManager.getRunningServers().keys()]
        .map(serverKey => {
          const { componentName, targetId } = parseServerKey(serverKey);
          const port = debugpyPortByServerKey.get(serverKey);
          return port === undefined ? null : { component: componentName, targetId, port };
        })
        .filter((instance): instance is { component: string; targetId: string; port: number } => instance !== null);
      await debugConfigManager.updateLaunchJson(runningInstances);
    }
  );
  context.subscriptions.push(updateLaunchJsonCommand);

  // KODE-DBG-001 方案②一键注入命令(docs/design/debugpy-attach.md 首选项):
  // telnet console 发 debugpy.listen + 端口模式 connect 附加,一条命令零文件
  // 改动,不改引擎。起监听复用 startDebugpyListenerNow(资产树同步+短命
  // telnet 客户端),附加复用 attachViaDebugpyPort,不起第二条注入通路;
  // 开关 kbengine.debug.debugpyInject 缺省 true(见 src/debugpyInjectCommand.ts),
  // 关闭时命令只提示不动作。启动最早期断点属方案①,由 waitAtStartup 覆盖。
  registerDebugpyInjectCommand(context, {
    listRunningComponents: () =>
      [...serverManager.getRunningServers().keys()].map(serverKey => {
        const { componentName, targetId } = parseServerKey(serverKey);
        return {
          component: componentName,
          label: targetId === DEFAULT_TARGET_ID ? componentName : `${componentName}#${targetId}`
        };
      }),
    ensureListener: (component, port) => startDebugpyListenerNow(component, port),
    attachViaDebugpyPort: component => debugConfigManager.attachViaDebugpyPort(component)
  });

  // (a)三件套之一:系统 debugpy 复制进 <assets>/scripts/common/debugpy
  // (2026-10-27 ③;版本闸/不覆盖用户手放目录的口径见 src/autoDebugpy.ts)
  const debugpySyncCommand = vscode.commands.registerCommand(
    'kbengine.python.debugpySync',
    async () => {
      const assetsRoot = serverManager.getConfigPath();
      const result = await syncDebugpyPackage(context, assetsRoot);
      if (result.status === 'error') {
        void vscode.window.showErrorMessage(`debugpy 同步失败: ${result.message}`);
      } else {
        void vscode.window.showInformationMessage(`debugpy 同步: ${result.message}`);
      }
    }
  );
  context.subscriptions.push(debugpySyncCommand);

  // DBG-004 等待连接模式开关命令:on=写引导块进入口脚本+开设置(显式
  // opt-in);off=删块逐字节还原+关设置。块与设置双保险:任一缺席都不生效。
  const waitAtStartupOnCommand = vscode.commands.registerCommand(
    'kbengine.debug.waitAtStartup.on',
    async () => {
      const assetsRoot = serverManager.getConfigPath();
      const entry = assetsRoot ? findEngineEntryScript(assetsRoot) : null;
      if (!entry) {
        void vscode.window.showErrorMessage(
          `未找到入口脚本 ${assetsRoot ? `${assetsRoot}/scripts/kbengine.py` : '(资产根未知)'},等待连接模式需要它`
        );
        return;
      }
      const result = injectWaitBootstrap(entry);
      if (result.status === 'error') {
        void vscode.window.showErrorMessage(`开启等待连接模式失败: ${result.message}`);
        return;
      }
      await vscode.workspace
        .getConfiguration('kbengine')
        .update('debug.waitAtStartup', true, vscode.ConfigurationTarget.Global);
      void vscode.window.showInformationMessage(
        `等待连接模式已开:${result.message}(组件启动将停住,直到 VS Code 附加对应 debugpy attach 配置)`
      );
    }
  );
  context.subscriptions.push(waitAtStartupOnCommand);
  const waitAtStartupOffCommand = vscode.commands.registerCommand(
    'kbengine.debug.waitAtStartup.off',
    async () => {
      await vscode.workspace
        .getConfiguration('kbengine')
        .update('debug.waitAtStartup', false, vscode.ConfigurationTarget.Global);
      const assetsRoot = serverManager.getConfigPath();
      const entry = assetsRoot ? findEngineEntryScript(assetsRoot) : null;
      const result = entry ? removeWaitBootstrap(entry) : null;
      if (result && result.status === 'error') {
        void vscode.window.showErrorMessage(`移除等待引导块失败: ${result.message}(设置已关,引导块不再生效)`);
        return;
      }
      void vscode.window.showInformationMessage(
        `等待连接模式已关${result ? `:${result.message}` : '(入口脚本未定位,引导块若在可手动移除)'}`
      );
    }
  );
  context.subscriptions.push(waitAtStartupOffCommand);
  const createDebugConfigCommand = vscode.commands.registerCommand(
    'kbengine.debug.createConfig',
    async () => {
      await debugConfigManager.createExampleConfig();
    }
  );
  context.subscriptions.push(createDebugConfigCommand);

  const startDebuggingCommand = vscode.commands.registerCommand(
    'kbengine.debug.start',
    async (target) => {
      const component = resolveServerComponent(target);
      if (component) {
        await debugConfigManager.startDebugging(component.name);
      } else {
        const selection = await pickServerComponent('选择要调试的组件');
        if (selection) {
          await debugConfigManager.startDebugging(selection.name);
        }
      }
    }
  );
  context.subscriptions.push(startDebuggingCommand);

  const attachToComponentCommand = vscode.commands.registerCommand(
    'kbengine.debug.attach',
    async (target) => {
      const component = resolveServerComponent(target);
      if (component) {
        await debugConfigManager.attachToComponent(component.name);
      } else {
        const selection = await pickServerComponent('选择要附加的组件');
        if (selection) {
          await debugConfigManager.attachToComponent(selection.name);
        }
      }
    }
  );
  context.subscriptions.push(attachToComponentCommand);

  // 远程附加(批112 用户令:配置服务器 IP 数组,点击远程弹目标选择)
  const attachRemoteCommand = vscode.commands.registerCommand(
    'kbengine.debug.attachRemote',
    async () => {
      await debugConfigManager.attachRemote();
    }
  );
  context.subscriptions.push(attachRemoteCommand);

  // IDE-PDBG-001:清除记住的附加模式(端口/进程附加)——下次附加重新选择
  const resetAttachModeCommand = vscode.commands.registerCommand(
    'kbengine.debug.resetAttachMode',
    async () => {
      await context.workspaceState.update(DEBUG_ATTACH_MODE_STATE_KEY, undefined);
      vscode.window.showInformationMessage('已清除附加模式选择:下次附加时会重新询问');
    }
  );
  context.subscriptions.push(resetAttachModeCommand);

  // IDE-PDBG-003:serverControl 树 debug 图标后的 py-spy 性能分析入口
  // ($(pulse));dump 出目标组件进程的 Python 调用栈到输出通道,进程选择
  // 复用既有选择器(组件名置顶 ✓);未装按所选解释器 pip 一键安装,装失败
  // 如实弹原因不重试轰炸;dump 失败把 ptrace 权限指引拼在原因后。
  const pyspyChannel = vscode.window.createOutputChannel('KBEngine py-spy');
  context.subscriptions.push(pyspyChannel);
  const pyspyDumpCommand = vscode.commands.registerCommand(
    'kbengine.debug.pyspyDump',
    async (target: unknown) => {
      const fromTree = resolveServerComponent(target);
      const component = fromTree ?? (await pickServerComponent('选择要性能分析的组件'));
      if (!component) {
        return; // 树节点无效且选择器取消:不空转
      }
      // IDE-PDBG-004:组件连接声明为远程 → py-spy 探测/安装/dump 全走
      // ssh 前缀(远端 python3 装包);进程清单与选择对齐本地口径(PDBG-005)
      const connection = debugConfigManager.getConnectionFor(component.name);
      const isRemote = connection !== 'local';
      const runner = isRemote
        ? (command: string, args: string[], timeoutMs: number) =>
            defaultSpawnRunner('ssh', buildSshExecArgs(connection.ssh, [command, ...args]), timeoutMs)
        : defaultSpawnRunner;
      const hostPrefix = isRemote ? `[${connection.ssh.host}] ` : '';
      const uiFace = {
        warn: (message: string, ...actions: string[]) =>
          vscode.window.showWarningMessage(`${hostPrefix}${message}`, ...actions),
        info: (message: string) => vscode.window.showInformationMessage(`${hostPrefix}${message}`),
        error: (message: string) => vscode.window.showErrorMessage(`${hostPrefix}${message}`)
      };
      // IDE-PDBG-006:本地链解释器旁定位 py-spy 入口(venv bin/~/.local/bin),
      // 探测与 dump 同一命令,装进解释器环境不再被 PATH 误判未装;远端保持
      // ssh 裸命令口径
      const localResolution = isRemote
        ? null
        : resolveProfileInterpreter(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
      const ready = await ensurePyspyReady(runner, uiFace, isRemote
        ? () => ({ interpreterPath: 'python3', interpreterSource: 'path' })
        : () => localResolution ?? { interpreterPath: '', interpreterSource: 'setting' });
      if (!ready) {
        return; // 未装且未装成/用户取消:不往下跑
      }
      let pid: number | undefined;
      if (isRemote) {
        // IDE-PDBG-005:远端进程清单经 ssh ps,选择器口径与本地一致
        // (buildProcessPickItems 共用);清单拿不到如实报,不本地兜底
        pid = await pickRemoteProcessId(component.name, connection.ssh.host, {
          listRemote: () => listRemoteProcesses(connection.ssh),
          showQuickPick: (items, options) => vscode.window.showQuickPick(items, options),
          showErrorMessage: message => vscode.window.showErrorMessage(`${hostPrefix}${message}`)
        });
      } else {
        pid = await debugConfigManager.pickProcessId(component.name);
      }
      if (pid === undefined || !Number.isFinite(pid) || pid <= 0) {
        return; // 取消/空清单:pickProcessId 或输入框已自行说明
      }
      pyspyChannel.appendLine(
        `\n===== py-spy dump ${component.name}${isRemote ? ` @${connection.ssh.host}` : ''} pid=${pid} ${new Date().toISOString()} =====`
      );
      pyspyChannel.show(true);
      const dump = await runPyspyDump(runner, pid, localResolution && resolvePyspyCommand(localResolution.interpreterPath));
      pyspyChannel.appendLine(dump.output);
      if (!dump.ok) {
        vscode.window.showErrorMessage(`py-spy dump 失败(pid=${pid}),详情见「KBEngine py-spy」输出通道`);
      }
    }
  );
  context.subscriptions.push(pyspyDumpCommand);

  // IDE-PYSPY-001:py-spy 火焰图采集(record --format flamegraph)。傻瓜化
  // 默认参数(10s 窗口、100/s 采样、非阻塞)一键采集;定时/周期采集经两次
  // 输入框提示(每 N 秒采 X 次)。record 落盘 SVG,采集成功后在编辑器打开
  // (VS Code 原生图像预览呈现,不另造渲染面);逐次结果记同一输出通道。
  // 本批仅本地:远端 record 的文件产出需 scp 回传,先如实提示用 dump 拿栈。
  const pyspyFlamegraphCommand = vscode.commands.registerCommand(
    'kbengine.debug.pyspyFlamegraph',
    async (target: unknown) => {
      const fromTree = resolveServerComponent(target);
      const component = fromTree ?? (await pickServerComponent('选择要采集火焰图的组件'));
      if (!component) {
        return;
      }
      const connection = debugConfigManager.getConnectionFor(component.name);
      if (connection !== 'local') {
        vscode.window.showWarningMessage(
          '火焰图 record 暂仅支持本地组件(远端文件需回传);远端组件先用 py-spy dump 拿调用栈'
        );
        return;
      }
      const runner = defaultSpawnRunner;
      const uiFace = {
        warn: (message: string, ...actions: string[]) =>
          vscode.window.showWarningMessage(message, ...actions),
        info: (message: string) => vscode.window.showInformationMessage(message),
        error: (message: string) => vscode.window.showErrorMessage(message)
      };
      const resolution =
        resolveProfileInterpreter(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
      const ready = await ensurePyspyReady(
        runner,
        uiFace,
        () => resolution ?? { interpreterPath: '', interpreterSource: 'setting' }
      );
      if (!ready) {
        return;
      }
      const pid = await debugConfigManager.pickProcessId(component.name);
      if (pid === undefined || !Number.isFinite(pid) || pid <= 0) {
        return;
      }
      // 采集配置:缺省值即傻瓜化口径(1 次 / 每 5 秒);输入非整数/越界即拒
      const countRaw = await vscode.window.showInputBox({
        prompt: '采集次数 X(每 N 秒采一次,共 X 次)',
        value: '1',
        validateInput: text => (/^[1-9][0-9]*$/.test(text) ? null : '请输入正整数(如 1)')
      });
      if (countRaw === undefined) {
        return;
      }
      const intervalRaw = await vscode.window.showInputBox({
        prompt: '采集间隔秒 N(相邻两次采集之间的秒数)',
        value: '5',
        validateInput: text => (/^[1-9][0-9]*$/.test(text) ? null : '请输入正整数秒(如 5)')
      });
      if (intervalRaw === undefined) {
        return;
      }
      const outDir = path.join(os.tmpdir(), 'kode-pyspy-flamegraphs');
      try {
        fs.mkdirSync(outDir, { recursive: true });
      } catch (error) {
        vscode.window.showErrorMessage(`创建输出目录失败: ${String(error)}`);
        return;
      }
      pyspyChannel.appendLine(
        `\n===== py-spy flamegraph ${component.name} pid=${pid} ×${countRaw} 次/${intervalRaw}s ${new Date().toISOString()} =====`
      );
      pyspyChannel.show(true);
      const runs = await runPyspySchedule(
        runner,
        pid,
        {
          count: Number(countRaw),
          intervalSec: Number(intervalRaw),
          outDir,
          durationSec: PYSPY_RECORD_DEFAULTS.durationSec,
          rateHz: PYSPY_RECORD_DEFAULTS.rateHz,
          format: PYSPY_RECORD_DEFAULTS.format,
          nonblocking: PYSPY_RECORD_DEFAULTS.nonblocking
        },
        resolution && resolvePyspyCommand(resolution.interpreterPath)
      );
      for (const run of runs) {
        pyspyChannel.appendLine(
          run.ok
            ? `第 ${run.index + 1} 次: ${run.file}`
            : `第 ${run.index + 1} 次: 采集失败(已中止后续采集)——${run.output}`
        );
        if (run.ok) {
          void vscode.commands.executeCommand('vscode.open', vscode.Uri.file(run.file));
        }
      }
      const succeeded = runs.filter(run => run.ok).length;
      if (succeeded === 0) {
        vscode.window.showErrorMessage('py-spy 火焰图采集失败,详情见「KBEngine py-spy」输出通道');
      } else {
        pyspyChannel.appendLine(`共 ${succeeded}/${runs.length} 次采集成功,SVG 已在编辑器打开`);
      }
    }
  );
  context.subscriptions.push(pyspyFlamegraphCommand);
  // 创建状态栏项
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'workbench.view.extension.kbengine-explorer';
  context.subscriptions.push(statusBarItem);

  // 更新状态栏
  function updateStatusBar(manager: KBEngineServerManager) {
    const runningCount = manager.getRunningServers().size;
    const totalCount = SERVER_COMPONENTS.length;

    if (runningCount > 0) {
      statusBarItem.text = `$(server) KBEngine: ${runningCount}/${totalCount} Running`;
      statusBarItem.show();
    } else {
      statusBarItem.hide();
    }
  }

  // 启动时更新状态栏
  updateStatusBar(serverManager);

  return {
    serverManager,
    telnetService,
    telnetWebView,
    debugConfigManager
  };
}
