// SRC-001 L8:监控/面板层(KODE-ARCH-002 纯移动)。区域含监控面板
// (collector+webview)、运行时查询(profile/spaces/runtimeQuery)、异常源
// 跳转/兼容性检查/工作台命令、后台预热控制器(BG-WARM)与依赖/实体流
// 面板/python 调用图命令接线。装配顺序由组合根调用点保持;注册面直推
// context.subscriptions(销毁所有权不变);entityMappingManager(coreServices
// L1)/indexScheduler(coreServices L1)/sharedWorkspaceIndex(languageServices
// L2)经 deps 注入;面板实例与区域自建 outputChannel 返回给组合根供
// deactivate 收口 dispose。

import * as vscode from 'vscode';
import * as path from 'path';
import { l10nText } from '../nlsRuntime';
import {
  INDEX_CACHE_DIR_NAME,
  INDEX_CACHE_SCHEMA_VERSION,
  readIndexCache,
  writeIndexCache
} from '../backend/indexDiskCache';
import { BackgroundWarmupController, WARMUP_SCAN_CONCURRENCY } from '../backend/backgroundWarmup';
import { EntityDependencyWebView } from '../entityDependencyWebView';
import { EntityFlowWebView } from '../entityFlowWebView';
import { FlowSwimlanePanel } from '../flowSwimlanePanel';
import { TraceReplayPanel } from '../traceReplayPanel';
import { IndexTaskPriority } from '../backend/indexScheduler';
import { MonitoringCollector } from '../monitoringCollector';
import { MonitoringWebView } from '../monitoringWebView';
import { RuntimeQueryWebView } from '../runtimeQueryWebView';
import { createWarmupStages } from '../backend/warmupStages';
import { activeProfileEngineMajor } from './engineVersionKey';
import { discoverLocalComponents, querySpaces, startProfileQuery } from '../backend/kbengineProtocol';
import { findEngineRoot, formatEngineCompatibilityReport, runCompatibilityCheck, ExtensionCompatibilityTarget } from '../backend/engineCompatibility';
import { formatUnresolvedException, parseExceptionSourceLocation, resolveExceptionSource } from '../backend/exceptionSourceLocator';
import { getDefinitionWorkspaceLayout } from '../definitionWorkspace';
import { shouldStartKbEngineIndexing } from '../workspaceGate';
import { findMethodScriptLocationInDef } from '../languageProviders/navigation';
import type { DefLutConventionResolver, EntityMappingManager } from '../entityMapping';
import type { IndexScheduler } from '../backend/indexScheduler';
import type { WorkspaceIndex } from '../workspaceIndex';

export interface MonitoringDeps {
  context: vscode.ExtensionContext;
  entityMappingManager: EntityMappingManager;
  indexScheduler: IndexScheduler;
  sharedWorkspaceIndex: WorkspaceIndex;
}

export interface MonitoringShared {
  monitoringCollector: MonitoringCollector;
  monitoringWebView: MonitoringWebView;
  dependencyWebView: EntityDependencyWebView;
  flowWebView: EntityFlowWebView;
  outputChannel: vscode.OutputChannel;
}

export function activateMonitoring(deps: MonitoringDeps): MonitoringShared {
  const { context, entityMappingManager, indexScheduler, sharedWorkspaceIndex } = deps;
  // DEF-LUT-001:约定链臂适配——LUT 后台重建需要「父 def/接口脚本里找实现」
  // (navigation 约定链),而 navigation 依赖 entityMapping(环),故此处开 def
  // 文档适配注入。落点转 1 基(与解析面同形);文档打不开/无实现 → null。
  const defLutConventionResolver: DefLutConventionResolver = async (defPath, methodName, section) => {
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(defPath));
      const location = findMethodScriptLocationInDef(document, methodName, section);
      return location
        ? {
            filePath: location.uri.fsPath,
            line: location.range.start.line + 1,
            character: location.range.start.character
          }
        : null;
    } catch {
      return null;
    }
  };
  // 初始化监控面板
  const monitoringCollector = new MonitoringCollector(context);
  const monitoringWebView = new MonitoringWebView(context, monitoringCollector);

  // 注册监控相关命令
  const showMonitoringCommand = vscode.commands.registerCommand(
    'kbengine.monitoring.show',
    () => {
      monitoringWebView.show();
    }
  );
  context.subscriptions.push(showMonitoringCommand);

  // Classic runtime observability: these commands use the guiconsole-compatible
  // fixed IDs already parsed in kbengineProtocol and degrade to a clear warning
  // when machine discovery finds no running components.
  const runtimeOutputChannel = vscode.window.createOutputChannel('KBEngine Runtime');
  const startRuntimeProfileCommand = vscode.commands.registerCommand(
    'kbengine.profile.start',
    async (componentName = 'cellapp', kind = 'pyprofile') => {
      const components = await discoverLocalComponents();
      const selected = components.find(component => component.componentName === componentName);
      if (!selected) {
        vscode.window.showWarningMessage('未发现可查询的 KBEngine 组件');
        return;
      }
      const results = await startProfileQuery(selected, {
        profileName: 'kode-runtime',
        kind: kind === 'cprofile' ? 'cprofile' : kind === 'eventprofile' ? 'eventprofile' : kind === 'networkprofile' ? 'networkprofile' : 'pyprofile',
        timingLengthSeconds: 5
      });
      runtimeOutputChannel.clear();
      if (results.length === 0) {
        runtimeOutputChannel.appendLine('No profile response received.');
      } else {
        runtimeOutputChannel.appendLine(JSON.stringify(results, null, 2));
      }
      runtimeOutputChannel.show(true);
    }
  );
  const querySpacesCommand = vscode.commands.registerCommand('kbengine.spaces.query', async () => {
    const components = await discoverLocalComponents();
    const manager = components.find(component => component.componentType === 4);
    if (!manager) {
      vscode.window.showWarningMessage('未发现可查询的 KBEngine 组件');
      return;
    }
    const result = await querySpaces(manager);
    runtimeOutputChannel.clear();
    runtimeOutputChannel.appendLine(JSON.stringify(result, null, 2));
    runtimeOutputChannel.show(true);
  });
  context.subscriptions.push(startRuntimeProfileCommand, querySpacesCommand, runtimeOutputChannel);

  const runtimeQueryWebView = new RuntimeQueryWebView(context);
  const showRuntimeQueryCommand = vscode.commands.registerCommand(
    'kbengine.runtimeQuery.show',
    () => runtimeQueryWebView.show()
  );
  context.subscriptions.push(showRuntimeQueryCommand);

  // IDE-LIV-007:运行异常关联到源码定位——带可解析文件行的异常跳到
  // 工作区真实文件行;解析不到源码时警告框原样保留原始信息。
  const openExceptionSourceCommand = vscode.commands.registerCommand(
    'kbengine.liveObservation.openExceptionSource',
    async (argument?: { file?: unknown; line?: unknown; raw?: unknown }) => {
      const raw = typeof argument?.raw === 'string' ? argument.raw : '';
      const parsed =
        argument && typeof argument.file === 'string' && typeof argument.line === 'number'
          ? { file: argument.file, line: argument.line, qualifier: 'logpath' as const }
          : parseExceptionSourceLocation(raw);
      if (!parsed) {
        void vscode.window.showWarningMessage(formatUnresolvedException(raw || '无原始信息', null));
        return;
      }
      const roots = (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath);
      const resolved = resolveExceptionSource(roots, parsed);
      if (!resolved) {
        void vscode.window.showWarningMessage(formatUnresolvedException(raw, parsed));
        return;
      }
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(resolved.absolutePath));
      const editor = await vscode.window.showTextDocument(document, { preview: false });
      const targetLine = Math.max(0, Math.min(parsed.line - 1, document.lineCount - 1));
      const position = new vscode.Position(targetLine, 0);
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
      editor.selection = new vscode.Selection(position, position);
    }
  );
  context.subscriptions.push(openExceptionSourceCommand);

  const compatibilityChannel = vscode.window.createOutputChannel('KBEngine Compatibility');
  // R2-F22:engines 是「KBEngine 引擎支持矩阵」槽位,未声明时引擎兼容性标未知,
  // 不把引擎版本与 VS Code 要求混比。宿主(扩展宿主)版本在命令内传入比对。
  const compatibilityTarget: ExtensionCompatibilityTarget = {
    displayName: 'Kode KBEngine',
    vscodeEngine: '^1.84.0',
    files: [{ relativePath: 'out/extension.js', exported: true }]
  };
  const checkCompatibilityCommand = vscode.commands.registerCommand('kbengine.compatibility.check', async () => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      vscode.window.showWarningMessage('未打开工作区,无法检查引擎兼容性');
      return;
    }
    const engineRoot = findEngineRoot(root, vscode.workspace.getConfiguration('kbengine').get<string>('engineRoot', '') || undefined);
    const report = runCompatibilityCheck(context.extensionUri.fsPath, engineRoot, compatibilityTarget, vscode.version);
    compatibilityChannel.clear();
    compatibilityChannel.appendLine(formatEngineCompatibilityReport(report));
    compatibilityChannel.show(true);
    if (report.checks.some(check => check.status === 'error')) {
      vscode.window.showWarningMessage('兼容性检查存在错误,详见输出面板');
    } else {
      vscode.window.showInformationMessage('兼容性检查完成');
    }
  });
  context.subscriptions.push(checkCompatibilityCommand, compatibilityChannel);

  const workbenchCommand = vscode.commands.registerCommand('kbengine.workbench.show', async () => {
    const selection = await vscode.window.showQuickPick([
      { label: l10nText('Project and environment'), kind: vscode.QuickPickItemKind.Separator },
      { label: `$(search) ${l10nText('Find project files')}`, description: l10nText('Check which project paths were found'), detail: 'Discovery & Positioning', command: 'kbengine.discovery.report' },
      { label: `$(info) ${l10nText('Extension information')}`, description: l10nText('See the installed and active extension'), detail: 'Extension Identity', command: 'kbengine.extension.identity' },
      { label: `$(checklist) ${l10nText('Check project definitions')}`, description: l10nText('Find errors in entity definitions'), detail: 'Project Doctor', command: 'kbengine.project.doctor' },
      { label: `$(shield) ${l10nText('Check compatibility')}`, description: l10nText('Check the editor and engine environment'), detail: 'Compatibility', command: 'kbengine.compatibility.check' },
      { label: l10nText('Server and runtime'), kind: vscode.QuickPickItemKind.Separator },
      { label: `$(graph) ${l10nText('Monitor servers')}`, description: l10nText('View component status and metrics'), detail: 'Monitoring', command: 'kbengine.monitoring.show' },
      { label: `$(pulse) ${l10nText('Profile a running component')}`, description: l10nText('Collect runtime performance information'), detail: 'Runtime Profile', command: 'kbengine.profile.start' },
      { label: `$(search) ${l10nText('Query a running component')}`, description: l10nText('Inspect watcher values'), detail: 'Runtime Queries', command: 'kbengine.runtimeQuery.show' },
      { label: `$(map) ${l10nText('View spaces')}`, description: l10nText('Query running spaces'), detail: 'Spaces', command: 'kbengine.spaces.query' },
      { label: l10nText('Data and development'), kind: vscode.QuickPickItemKind.Separator },
      { label: `$(database) ${l10nText('View database schema')}`, description: l10nText('Inspect the derived database structure'), detail: 'Database Schema', command: 'kbengine.database.open' },
      { label: `$(database) ${l10nText('Check database differences')}`, description: l10nText('Compare definitions with the database'), detail: 'Database Drift', command: 'kbengine.database.checkAllDrift' },
      { label: `$(graph) ${l10nText('Find symbol references')}`, description: l10nText('Explore where definitions are used'), detail: 'Symbol References', command: 'kbengine.symbolReferences.show' },
      { label: `$(file-binary) ${l10nText('Generate client SDK')}`, description: l10nText('Generate client files from entity definitions'), detail: 'Client SDK', command: 'kbengine.clientSdk.generate' }
    ], { placeHolder: l10nText('Choose a KBEngine task'), ignoreFocusOut: true, matchOnDescription: true, matchOnDetail: true });
    if (selection && 'command' in selection && selection.command) await vscode.commands.executeCommand(selection.command);
  });
  context.subscriptions.push(workbenchCommand);

  // 初始化实体依赖关系图
  const outputChannel = vscode.window.createOutputChannel('KBEngine Dependency');

  // ── BG-WARM:激活即后台预热(阶段管线 src/warmupStages.ts,控制器 src/backgroundWarmup.ts)──
  // 控制器先于面板构造(面板注入产物源做只读缓存);阶段体经 warmupPanels 句柄
  // 惰性取下方装配好的面板实例——阶段启动总在激活同步段之后,句柄必已就位。
  const warmupPanels: {
    dependency: EntityDependencyWebView | null;
    flow: EntityFlowWebView | null;
  } = { dependency: null, flow: null };
  // 状态栏进度 message 面:withProgress 任务体接线(未启动时 null,静默不报)
  let reportWarmupDetail: ((detail: string) => void) | null = null;
  // BG-WARM 索引磁盘缓存:阶段 def 引用(恢复命中后置 cached;构造后可变面)
  let warmupStageDefs: import('../backend/backgroundWarmup').WarmupStageDef[] | null = null;
  // 扩展关闭旗标:调度器在 dispose 后拒接任务(既有语义),这类拒绝是宿主收摊,
  // 不是索引失败——只它被就地吞掉,真实首扫错误照常向控制器传播(failed/不写标记)。
  let warmupDisposing = false;
  // 代际 = 扩展版本 + 工作区根指纹:版本或根变化即 upgraded(升级/换根重建轮,
  // 也走后台,不回退到面板打开时同步重扫)。
  const warmupGeneration = (() => {
    const version = String(context.extension?.packageJSON?.version ?? 'dev');
    const roots = (vscode.workspace.workspaceFolders ?? [])
      .map(folder => folder?.uri?.fsPath ?? '')
      .filter(Boolean)
      .sort()
      .join('|');
    return `${version}@${roots}`;
  })();

  const backgroundWarmup = new BackgroundWarmupController({
    stages: (() => {
      // BG-WARM 索引磁盘缓存:阶段 def 提变量——恢复命中后在 start() 前按 key
      // 置 cached(见 withProgress 回调),snapshot 现读投影「cached ⏭」。
      const defs = createWarmupStages({
      // 发现链首扫:复用 startKbEngineIndexing 已起的同一轮(ensureStartup 幂等),
      // 这里只等终态不重起第二套扫描(KR-AUD-34 会话缓存口径不动)。
      waitForDiscovery: () => entityMappingManager.waitForInitialScan(),
      // 事件/方法全量首扫:统一调度器非交互优先级入队(交互任务让路),
      // ensureStarted 幂等复用在跑任务;调度器拒接(已 dispose)按已终态结算。
      ensureEventIndex: async () => {
        const handle = indexScheduler.enqueue({
          kind: 'non-interactive',
          priority: IndexTaskPriority.NonInteractive,
          run: () => sharedWorkspaceIndex.ensureStarted()
        });
        try {
          await handle.wait;
        } catch (error) {
          if (warmupDisposing) {
            return; // 宿主收摊(调度器已 dispose):本轮随扩展一起止步,不算失败
          }
          // 真实首扫失败向上传播:阶段 failed、后续阶段不跑、不写完成标记
          throw error;
        }
      },
      // 依赖图:与面板现算同一出口(同一 analyzer 实例、同一 Rust 兜底口径)
      buildDependencyGraph: async () => {
        if (!warmupPanels.dependency) {
          throw new Error('dependency panel not assembled');
        }
        return warmupPanels.dependency.buildWarmupGraphSource();
      },
      listFlowEntities: () => entityMappingManager.getAllMappings().map(mapping => mapping.name),
      // 流程图:面板建图同一出口(未注册实体返回 null,阶段如实跳过不发布)
      buildFlowGraph: entityName => warmupPanels.flow?.buildGraph(entityName) ?? null,
      // 定义布局预热:KR-AUD-36 热路径首查不再付冷布局解析(只挪时机不改语义)
      preheatDefinitionLayout: () => {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (root) { getDefinitionWorkspaceLayout(root); }
      },
      report: detail => { reportWarmupDetail?.(detail); }
      });
      warmupStageDefs = defs;
      return defs;
    })(),
    // 完成标记持久面:极简 context(既有测试/宿主缺 workspaceState)如实降级为
    // 「不持久」——本轮照跑照热,只是不跨会话记账,绝不因缺面炸激活。
    workspaceState: {
      get: <T,>(key: string): T | undefined => context.workspaceState?.get<T>(key),
      update: (key: string, value: unknown): Thenable<void> =>
        context.workspaceState ? context.workspaceState.update(key, value) : Promise.resolve()
    },
    generation: warmupGeneration,
    concurrency: WARMUP_SCAN_CONCURRENCY,
    onDidChange: snapshot => {
      if (snapshot.state === 'failed') {
        const failed = snapshot.stages.filter(stage => stage.state === 'failed');
        outputChannel.appendLine(
          `后台预热失败:${failed
            .map(stage => `${stage.label}${stage.error ? `(${stage.error})` : ''}`)
            .join(';')}`
        );
        return;
      }
      if (snapshot.state === 'running') {
        reportWarmupDetail?.(
          `${snapshot.completedStages}/${snapshot.totalStages}` +
            `${snapshot.currentLabel ? ` · ${snapshot.currentLabel}` : ''}`
        );
      }
    }
  });
  context.subscriptions.push({
    dispose: (): void => {
      warmupDisposing = true;
      backgroundWarmup.cancel('extension-dispose');
    }
  });

  const dependencyWebView = new EntityDependencyWebView(context, outputChannel, backgroundWarmup);
  warmupPanels.dependency = dependencyWebView;

  // 注册依赖关系相关命令
  const showDependencyCommand = vscode.commands.registerCommand(
    'kbengine.dependency.show',
    () => dependencyWebView.show()
  );
  context.subscriptions.push(showDependencyCommand);

  // C-20:调用图模式(同面板切 mode='callgraph')。
  const showPythonCallGraphCommand = vscode.commands.registerCommand(
    'kbengine.pythonCallGraph.show',
    () => dependencyWebView.show('callgraph')
  );
  context.subscriptions.push(showPythonCallGraphCommand);

  // RUST-178:实体关系浏览器(同面板切 mode='relations')——聚焦实体双向
  // 邻接懒加载子图,点击未展开节点逐层扩充,已展开节点点击开文件。
  const showEntityRelationsCommand = vscode.commands.registerCommand(
    'kbengine.entityRelations.show',
    () => dependencyWebView.show('relations')
  );
  context.subscriptions.push(showEntityRelationsCommand);

  // 实体架构流程图(批124):客户端到 base/cell 的方法调用与属性自动同步,
  // 边语义按 Flags 位带引擎出处。实体名缺省取活动 .def 编辑器。
  const flowWebView = new EntityFlowWebView(context, backgroundWarmup);
  warmupPanels.flow = flowWebView;
  const showEntityFlowCommand = vscode.commands.registerCommand(
    'kbengine.flow.show',
    (entityName?: string) => flowWebView.show(entityName)
  );
  context.subscriptions.push(showEntityFlowCommand);

  // KFLOW G2 静态调用路径泳道面板(FLOW-015):活动 Python 编辑器函数入口
  // → 按角色分泳道(静态角色,不冒充运行实例),每边证据可追溯。
  const flowSwimlanePanel = new FlowSwimlanePanel({
    entityMappingManager
  });
  const openCallGraphCommand = vscode.commands.registerCommand(
    'kbengine.flow.openCallGraph',
    () => flowSwimlanePanel.show()
  );
  context.subscriptions.push(openCallGraphCommand);

  // KFLOW G3 回放实例级流转面板(FLOW-028):选 trace 会话 JSON → 真实
  // 组件实例泳道展示本地栈段与消息流(causal/candidate/广播/缺失可区分);
  // 零脚本静态页。
  const traceReplayPanel = new TraceReplayPanel();
  const openTraceReplayCommand = vscode.commands.registerCommand(
    'kbengine.flow.openTraceReplay',
    () => traceReplayPanel.show()
  );
  context.subscriptions.push(openTraceReplayCommand);

  // BG-WARM:门控放行即启动后台预热(与索引机械同一门;纯 Python 工作区零启动)。
  // withProgress Window 位 = 状态栏进度,可取消:取消止步不写完成标记,下次激活
  // 照常重跑;面板在此期间打开只见进度页 + 复用在跑产物,完成后自动换真图。
  void shouldStartKbEngineIndexing().then(gated => {
    if (!gated) { return; }
    vscode.window
      .withProgress(
        {
          location: vscode.ProgressLocation.Window,
          title: 'KBEngine 后台索引预热',
          cancellable: true
        },
        async (progress, token) => {
          reportWarmupDetail = detail => { void progress.report({ message: detail }); };
          token.onCancellationRequested(() => backgroundWarmup.cancel('user-cancel'));
          // BG-WARM 索引磁盘缓存(2026-11-18):错峰冷窗后(与预热同节拍)先试恢复。
          // discovery=注入 defParseCache(首扫批次 mtime 命中零重解析);
          // eventIndex=接管 WorkspaceIndex 起始槽(命中条目直取,漂移文件增量
          // 重建)。版本不符/哈希不符/任何异常 → 静默降级照旧全扫(不打扰用户)。
          const kodeVersion = String(context.extension?.packageJSON?.version ?? 'dev');
          // 版本键分级:扩展版本号只作溯源,淘汰键=引擎 API 主版本
          const engineMajor = activeProfileEngineMajor(context.workspaceState);
          const cacheDir = context.globalStorageUri?.fsPath
            ? path.join(context.globalStorageUri.fsPath, INDEX_CACHE_DIR_NAME)
            : null;
          if (cacheDir) {
            try {
              const cached = readIndexCache(cacheDir, { schemaVersion: INDEX_CACHE_SCHEMA_VERSION, kodeVersion, engineMajor });
              if (cached?.payload.discovery?.length) {
                const restore = await entityMappingManager.restoreDefParseCacheFromDisk(cached.payload.discovery);
                if (restore.injected > 0) {
                  if (warmupStageDefs && restore.injected === restore.discovered) {
                    warmupStageDefs.find(stage => stage.key === 'discovery')!.cached = true;
                  }
                  outputChannel.appendLine(
                    `索引缓存命中(discovery):注入 ${restore.injected}/${restore.discovered},漂移拒收 ${restore.rejected}`
                  );
                }
              }
              if (cached?.payload.eventIndex?.length) {
                const restore = await sharedWorkspaceIndex.restoreFromCache(cached.payload.eventIndex);
                if (restore.tookOver) {
                  if (warmupStageDefs) {
                    warmupStageDefs.find(stage => stage.key === 'eventIndex')!.cached = true;
                  }
                  outputChannel.appendLine(
                    `索引缓存命中(eventIndex):直取 ${restore.restored},增量重建 ${restore.rebuilt},丢弃 ${restore.dropped}`
                  );
                }
              }
              if (cached?.payload.defLut?.length) {
                // DEF-LUT-001:跳转反查表二次启动载入(逐 def stat 校验,漂移
                // 拒收);只入表零构建,门控红线不动(此处已在放行块内)
                const restore = entityMappingManager.restoreDefMethodLutFromDisk(cached.payload.defLut);
                if (restore.adoptedEntries > 0) {
                  outputChannel.appendLine(
                    `索引缓存命中(defLUT):载入 ${restore.adoptedDefs} def / ${restore.adoptedEntries} 条,漂移拒收 ${restore.rejectedDefs}`
                  );
                }
              }
              if (warmupStageDefs?.some(stage => stage.cached)) {
                reportWarmupDetail?.('索引缓存命中(跳过重扫) ⏭');
              }
            } catch {
              // 缓存面失败静默降级:本轮照旧全扫
            }
          }
          try {
            const final = await backgroundWarmup.start();
            const snapshot = backgroundWarmup.snapshot();
            const cachedCount = snapshot.stages.filter(stage => stage.cached).length;
            outputChannel.appendLine(
              final === 'completed'
                ? `后台预热完成:${snapshot.completedStages}/${snapshot.totalStages} 阶段${cachedCount ? `(缓存命中 ${cachedCount} ⏭)` : ''}`
                : `后台预热${final === 'cancelled' ? '已取消' : '未完成'}:${snapshot.completedStages}/${snapshot.totalStages} 阶段`
            );
            // 完成后异步写回(队列尾 setImmediate 节拍,不阻塞交互;失败/取消
            // 不写——与完成标记同口径,不基于残缺轮落盘)。写失败静默降级。
            // DEF-LUT-001:先排低优先级 LUT 重建(keyed 任务,交互限流;门控
            // 放行块内才发起),落定后再写回——defLut 产物不基于空表落盘。
            if (final === 'completed') {
              // 门控已放行(本块只在 gated 分支),幂等补一手 ensureStartup——
              // 防调度次序抖动下 warmup 先于语言服务放行回调完成,LUT 重建
              // 因 startupStarted=false 空转(零构建红线由放行块本身承担)。
              entityMappingManager.ensureStartup();
              const lutBuilt = entityMappingManager
                .scheduleDefMethodLutRebuild(defLutConventionResolver)
                .catch(() => undefined);
              if (cacheDir) {
                void lutBuilt.then(() => {
                  setImmediate(() => {
                    void (async () => {
                      try {
                        const ok = writeIndexCache(cacheDir, { schemaVersion: INDEX_CACHE_SCHEMA_VERSION, kodeVersion, engineMajor }, {
                          discovery: await entityMappingManager.captureDefParseCacheSnapshot(),
                          eventIndex: await sharedWorkspaceIndex.captureEventIndexSnapshot(),
                          defLut: entityMappingManager.captureDefMethodLutSnapshot()
                        });
                        if (!ok) {
                          outputChannel.appendLine('索引缓存写盘失败(静默降级,下次启动照旧全扫)');
                        }
                      } catch {
                        outputChannel.appendLine('索引缓存写盘异常(静默降级)');
                      }
                    })();
                  });
                });
              }
            }
          } finally {
            reportWarmupDetail = null;
          }
        }
      )
      .then(undefined, () => undefined);
  });
  return { monitoringCollector, monitoringWebView, dependencyWebView, flowWebView, outputChannel };
}
