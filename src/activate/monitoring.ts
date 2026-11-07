// SRC-001 L8:监控/面板层(KODE-ARCH-002 纯移动)。区域含监控面板
// (collector+webview)、运行时查询(profile/spaces/runtimeQuery)、异常源
// 跳转/兼容性检查/工作台命令、后台预热控制器(BG-WARM)与依赖/实体流
// 面板/python 调用图命令接线。装配顺序由组合根调用点保持;注册面直推
// context.subscriptions(销毁所有权不变);entityMappingManager(coreServices
// L1)/indexScheduler(coreServices L1)/sharedWorkspaceIndex(languageServices
// L2)经 deps 注入;面板实例与区域自建 outputChannel 返回给组合根供
// deactivate 收口 dispose。

import * as vscode from 'vscode';
import { BackgroundWarmupController, WARMUP_SCAN_CONCURRENCY } from '../backgroundWarmup';
import { EntityDependencyWebView } from '../entityDependencyWebView';
import { EntityFlowWebView } from '../entityFlowWebView';
import { IndexTaskPriority } from '../indexScheduler';
import { MonitoringCollector } from '../monitoringCollector';
import { MonitoringWebView } from '../monitoringWebView';
import { RuntimeQueryWebView } from '../runtimeQueryWebView';
import { createWarmupStages } from '../warmupStages';
import { discoverLocalComponents, querySpaces, startProfileQuery } from '../kbengineProtocol';
import { findEngineRoot, formatEngineCompatibilityReport, runCompatibilityCheck, ExtensionCompatibilityTarget } from '../engineCompatibility';
import { formatUnresolvedException, parseExceptionSourceLocation, resolveExceptionSource } from '../exceptionSourceLocator';
import { getDefinitionWorkspaceLayout } from '../definitionWorkspace';
import { shouldStartKbEngineIndexing } from '../workspaceGate';
import type { EntityMappingManager } from '../entityMapping';
import type { IndexScheduler } from '../indexScheduler';
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
      { label: '$(search) Discovery & Positioning', command: 'kbengine.discovery.report' },
      // IDE-MET-001:活动扩展身份报告入口(区分安装目录存在/当前窗口已激活,
      // 标注远程或本地宿主位置)
      { label: '$(info) Extension Identity', command: 'kbengine.extension.identity' },
      { label: '$(checklist) Project Doctor', command: 'kbengine.project.doctor' },
      { label: '$(graph) Symbol References', command: 'kbengine.symbolReferences.show' },
      { label: '$(graph) Monitoring', command: 'kbengine.monitoring.show' },
      { label: '$(pulse) Runtime Profile', command: 'kbengine.profile.start' },
      { label: '$(search) Runtime Queries', command: 'kbengine.runtimeQuery.show' },
      { label: '$(map) Spaces', command: 'kbengine.spaces.query' },
      { label: '$(database) Database Schema', command: 'kbengine.database.open' },
      { label: '$(database) Database Drift', command: 'kbengine.database.checkAllDrift' },
      { label: '$(file-binary) Client SDK', command: 'kbengine.clientSdk.generate' },
      { label: '$(shield) Compatibility', command: 'kbengine.compatibility.check' }
    ], { placeHolder: 'KBEngine Workbench', ignoreFocusOut: true });
    if (selection) await vscode.commands.executeCommand(selection.command);
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
    stages: createWarmupStages({
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
    }),
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

  // 实体架构流程图(批124):客户端到 base/cell 的方法调用与属性自动同步,
  // 边语义按 Flags 位带引擎出处。实体名缺省取活动 .def 编辑器。
  const flowWebView = new EntityFlowWebView(context, backgroundWarmup);
  warmupPanels.flow = flowWebView;
  const showEntityFlowCommand = vscode.commands.registerCommand(
    'kbengine.flow.show',
    (entityName?: string) => flowWebView.show(entityName)
  );
  context.subscriptions.push(showEntityFlowCommand);

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
          try {
            const final = await backgroundWarmup.start();
            const snapshot = backgroundWarmup.snapshot();
            outputChannel.appendLine(
              final === 'completed'
                ? `后台预热完成:${snapshot.completedStages}/${snapshot.totalStages} 阶段`
                : `后台预热${final === 'cancelled' ? '已取消' : '未完成'}:${snapshot.completedStages}/${snapshot.totalStages} 阶段`
            );
          } finally {
            reportWarmupDetail = null;
          }
        }
      )
      .then(undefined, () => undefined);
  });
  return { monitoringCollector, monitoringWebView, dependencyWebView, flowWebView, outputChannel };
}
