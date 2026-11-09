// SRC-001 L2 抽象层(KODE-ARCH 纯移动,零行为变更):组合根的语言服务激活器。
// 职责(分析文档 docs/design/src-001-extension-abstraction-layers.md L2):
// 补全/签名帮助/悬停/定义/引用/重命名/CodeLens/inlay/callHierarchy/
// documentSymbol/workspaceSymbol/implementations 共 20+ 语言 provider 装配,
// 及 pythonClassIndex、python 索引 watcher/文件事件合并器/根移除通知、
// WorkspaceIndex 共享事件索引等装配期机制。
// 形态:deps 显式注入(L0 选择器与引擎 API 目录 getter、L1 共享实例、PR1
// 打点辅助);注册面直接 push 组合根 context.subscriptions——startKbEngine
// Indexing 的 schema warmup 与 WorkspaceIndex 错峰 grace 两处 push 在异步
// 回调内晚绑定执行,转交局部 disposables 数组会丢句柄,故不走返回值通道,
// 销毁所有权仍由组合根 context.subscriptions 单一持有;装配期产出的共享
// 实例经返回值交组合根注入后续层(事件接线/命令/探针)。
import * as vscode from 'vscode';
import { CallChainController } from '../defCallChainProvider';
import { DefParamInlayHintsProvider } from '../defParamInlayHints';
import { DefPropsInlayHintsProvider } from '../defPropsInlayHints';
import { getCustomTypeInfos, getRegisteredEntities } from '../definitionWorkspace';
import { createFileChangeMetaResolver } from '../fileChangeMeta';
import { logIndexFileChangeMeta } from '../fileChangeMetaLog';
import { createLinkedCancellationToken, HOVER_ASYNC_BUDGET_MS_DEFAULT, raceWithBudget } from '../hoverBudget';
import { IndexTaskPriority } from '../indexScheduler';
import { isExcludedScanPath, watcherPatternSignature } from '../indexWatcherScope';
import type { OperationStatus } from '../languageServiceMetrics';
import { startLanguageServiceOperation } from '../languageServiceMetrics';
import {
  EventCodeLensProvider,
  InferredMirrorTypeInlayHintsProvider,
  KBEngineBuiltinTypeInlayHintsProvider,
  KBEngineCallHierarchyProvider,
  KBEngineCompletionProvider,
  KBEngineDefinitionProvider,
  KBEngineDocumentSymbolProvider,
  KBEngineHoverProvider,
  KBEngineImplementationProvider,
  KBEngineReferencesProvider,
  KBEngineRenameProvider,
  KBEngineSignatureHelpProvider,
  KBEngineWorkspaceSymbolProvider,
  PropertyCodeLensProvider,
  PythonCompletionProvider,
  PythonDefinitionProvider,
  revealSourceCommand,
  RpcCodeLensProvider,
  TypesXmlCodeLensProvider
} from '../languageProviders';
import { StartupScriptCompletionProvider, StartupScriptHoverProvider } from '../kbengineStartupScript';
import { PythonClassIndex } from '../pythonClassIndex';
import { PYTHON_TYPE_STUB_FILE_NAME, buildPythonTypeStubLineMap, buildPythonTypeStubPlan } from '../pythonTypeStubs';
import { bumpRootConfigGeneration } from '../rootConfigGeneration';
import { createRootRemovalNotifier } from '../rootRemovalEvents';
import { getExternalScanRoots, resetScanRootCache, resolveAssetsRootForWorkspace } from '../scanRoots';
import { scheduleBackgroundSchemaWarmup } from '../schemaWarmup';
import { createSharedFileEventMerger } from '../sharedFileEvents';
import { KBENGINE_SOURCE_REVEAL_COMMAND } from '../sourceRevealCommand';
import { SERVER_CONFIG_SELECTOR, ServerConfigHoverProvider } from '../serverConfigHover';
import { registerTypeStorageIndexWatchers } from '../typeStorageIndexWatchers';
import { PythonTypeInlayHintsProvider } from '../typeInlayHints';
import { shouldStartKbEngineIndexing } from '../workspaceGate';
import { WorkspaceIndex } from '../workspaceIndex';
import { preheatDiscoveryScan } from '../workspaceDiscovery';
import { releaseDocumentsUnderRoot } from '../documentStore';
import { readTempEditReloadSettings, tempEditSectionReader } from '../hotReloadTempEdit';
import { GeneratedSourceCodeLensProvider } from '../generatedSourceLenses';
import type { CoreServicesShared } from './coreServices';
import type { InfrastructureShared } from './infrastructure';

export interface LanguageServicesDeps
  extends Pick<InfrastructureShared, 'getEngineApiCatalog' | 'defDocumentSelector' | 'definitionNavigationSelector' | 'pythonDocumentSelector'>,
    Pick<CoreServicesShared, 'entityMappingManager' | 'dataDictIndex' | 'indexScheduler'> {
  context: vscode.ExtensionContext;
  /** PR1 打点:结果空判状态(组合根 perf 辅助块,本层各 provider 包装共用) */
  emptyResultStatus(result: unknown): OperationStatus;
}

/** L2 装配产出的共享实例/句柄——事件接线、命令与探针面经组合根注入消费 */
export interface LanguageServicesShared {
  kbengineHoverImpl: KBEngineHoverProvider;
  pythonDefinitionImpl: PythonDefinitionProvider;
  pythonClassIndex: PythonClassIndex;
  startKbEngineIndexing(): void;
  watchPythonIndex(): void;
  fileChangeMetaResolver: ReturnType<typeof createFileChangeMetaResolver>;
  callChainController: CallChainController;
  sharedWorkspaceIndex: WorkspaceIndex;
  rpcCodeLensProviderImpl: RpcCodeLensProvider;
  propertyCodeLensProviderImpl: PropertyCodeLensProvider;
  eventCodeLensProviderImpl: EventCodeLensProvider;
  typesXmlCodeLensProviderImpl: TypesXmlCodeLensProvider;
}

export function activateLanguageServices(deps: LanguageServicesDeps): LanguageServicesShared {
  const {
    context,
    entityMappingManager,
    dataDictIndex,
    indexScheduler,
    getEngineApiCatalog,
    defDocumentSelector,
    definitionNavigationSelector,
    pythonDocumentSelector,
    emptyResultStatus
  } = deps;

  // 注册智能提示提供者（.def 结构补全 + Python 热更 API 补全;PR1 起带 completion 打点）
  const kbengineCompletionImpl = new KBEngineCompletionProvider(entityMappingManager);
  const completionProvider = vscode.languages.registerCompletionItemProvider(
    [
      ...defDocumentSelector,
      ...pythonDocumentSelector
    ],
    {
      async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        _context: vscode.CompletionContext
      ) {
        const operation = startLanguageServiceOperation('completion', {
          fileKind: document.languageId,
          documentVersion: document.version
        });
        try {
          const result = await kbengineCompletionImpl.provideCompletionItems(document, position, token);
          if (token.isCancellationRequested) {
            operation.end('cancelled');
            return null;
          }
          operation.end(emptyResultStatus(result));
          return result;
        } catch (error) {
          operation.end('error');
          throw error;
        }
      }
    },
    '<', ' ', '\t', '>', '/', ':', '.'
  );
  context.subscriptions.push(completionProvider);

  // 批159:镜链跳转统一走自建 reveal 命令(不用 vscode.open):showTextDocument
  // 带 selection 后再显式 revealRange,已打开已定位的目标也强制滚回 ——
  // 「跳 def → 后退 → 再点没反应」的根因即 vscode.open 对此类目标跳过 reveal。
  context.subscriptions.push(
    vscode.commands.registerCommand(
      KBENGINE_SOURCE_REVEAL_COMMAND,
      revealSourceCommand
    )
  );

  // 批159:签名帮助(def 声明方法,括号/逗号触发,预算闸内解析)。
  const kbengineSignatureHelpImpl = new KBEngineSignatureHelpProvider(entityMappingManager);
  const signatureHelpProvider = vscode.languages.registerSignatureHelpProvider(
    pythonDocumentSelector,
    {
      async provideSignatureHelp(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
      ) {
        const operation = startLanguageServiceOperation('signature-help', {
          fileKind: document.languageId,
          documentVersion: document.version
        });
        try {
          const result = await kbengineSignatureHelpImpl.provideSignatureHelp(document, position, token);
          operation.end(emptyResultStatus(result));
          return result;
        } catch (error) {
          operation.end('error');
          throw error;
        }
      }
    },
    '(', ',',
  );
  context.subscriptions.push(signatureHelpProvider);

  // 注册悬停文档提供者（.def/xml 与 Python 实体脚本均可查看 hook 文档;
  // 注入实体映射管理器后,python def 声明行的「实体 def 声明的 X 方法」
  // 标注走与 RPC CodeLens 同一把形参闸门;PR1 起带 hover 打点;GLOBDATA-002
  // 起注入数据字典键索引做键类型悬停）
  const kbengineHoverImpl = new KBEngineHoverProvider(entityMappingManager, dataDictIndex);
  const hoverProvider = vscode.languages.registerHoverProvider(
    [
      ...definitionNavigationSelector,
      ...pythonDocumentSelector
    ],
    {
      async provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
      ) {
        const operation = startLanguageServiceOperation('hover', {
          fileKind: document.languageId,
          documentVersion: document.version
        });
        try {
          // IDE-MET-003:hover 分支耗时经 per-request 计时器直传进 provider,
          // 落到 operation.subPhases(总耗时仍由 operation.elapsedMs 承担)。
          const result = await kbengineHoverImpl.provideHoverTimed(document, position, token, {
            start: label => operation.startSubPhase(label)
          });
          operation.end(emptyResultStatus(result));
          return result;
        } catch (error) {
          operation.end('error');
          throw error;
        }
      }
    }
  );
  context.subscriptions.push(hoverProvider);

  // 元件 kbengine.xml / 引擎 kbengine_defaults.xml 字段悬浮文档(批112 用户令:
  // 悬停配置字段显示引擎源码注释整理的作用说明)
  const serverConfigHoverProvider = vscode.languages.registerHoverProvider(
    SERVER_CONFIG_SELECTOR,
    new ServerConfigHoverProvider()
  );
  context.subscriptions.push(serverConfigHoverProvider);

  // KBEXP-1 启动参数悬浮/补全(用户令 2026-11-02;KB-001 第六篇):.sh/.bat
  // 启动脚本链里的 --cid/--gus/--hide/--KBE_* 与 KBE_ROOT/KBE_RES_PATH/
  // KBE_BIN_PATH/KBE_TIMING_METHOD/UID/UUID 文档悬浮与补全;开关
  // kbengine.hover.startupScript(默认开),装配即注册(提供者自读开关)。
  const startupScriptHoverProvider = vscode.languages.registerHoverProvider(
    [{ language: 'shellscript' }, { language: 'bat' }],
    new StartupScriptHoverProvider()
  );
  context.subscriptions.push(startupScriptHoverProvider);
  const startupScriptCompletionProvider = vscode.languages.registerCompletionItemProvider(
    [{ language: 'shellscript' }, { language: 'bat' }],
    new StartupScriptCompletionProvider()
  );
  context.subscriptions.push(startupScriptCompletionProvider);

  // 注册定义跳转提供者（.def 文件）
  // PR1 打点:definition(.def 导航面)。结果原样透传。
  const kbengineDefinitionImpl = new KBEngineDefinitionProvider(entityMappingManager);
  const definitionProvider = vscode.languages.registerDefinitionProvider(
    definitionNavigationSelector,
    {
      async provideDefinition(document: vscode.TextDocument, position: vscode.Position) {
        const operation = startLanguageServiceOperation('definition', {
          fileKind: document.languageId,
          documentVersion: document.version
        });
        try {
          const result = await kbengineDefinitionImpl.provideDefinition(document, position);
          operation.end(emptyResultStatus(result));
          return result;
        } catch (error) {
          operation.end('error');
          throw error;
        }
      }
    }
  );
  context.subscriptions.push(definitionProvider);

  // Python 方法使用优先跳实现；属性、声明与实现缺失时保留 .def 导航。
  // PR5:共享调度器注入 + 首扫后台化(激活即排程,Definition 首查不等全量)。
  const pythonClassIndex = new PythonClassIndex(indexScheduler);
  // 书 PR-002 门控启动面:特征确认后 entityMapping 首扫 + python 后台全量扫描
  // 一起放行(与门控前激活期行为一致);负案例(无特征)两者都不启动。
  const startKbEngineIndexing = (): void => {
    entityMappingManager.ensureStartup();
    if (vscode.workspace.getConfiguration('kbengine.python').get<boolean>('enableMroJump', true)) {
      pythonClassIndex.scheduleBackgroundScan();
    }
    // 书 PR-002 ③:深扫描缓存激活期预热——首查交互不再付 20000 条目有界
    // walk(巨仓实测 40.5ms/次);结果同源 scanCache,只挪时机不挪语义。
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (folder?.uri?.fsPath) {
        preheatDiscoveryScan(folder.uri.fsPath);
      }
    }
    // IDE-SCH-006:schema 快照后台预热——首扫完成后逐实体以非交互优先级入队,
    // 冷 schema 计算不再发生在首次悬停/打开;交互任务优先(编辑高峰让路),
    // 逐实体一条任务天然分块,dispose 即取消。
    void entityMappingManager.waitForInitialScan().then(() => {
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        const rootPath = folder?.uri?.fsPath;
        if (!rootPath) { continue; }
        const entityNames = getRegisteredEntities(rootPath).map(entry => entry.name);
        if (entityNames.length === 0) { continue; }
        const warmup = scheduleBackgroundSchemaWarmup(indexScheduler, rootPath, entityNames);
        context.subscriptions.push({ dispose: () => warmup.cancel('extension-dispose') });
      }
    }).catch(() => undefined);
  };
  void shouldStartKbEngineIndexing().then(gated => {
    if (gated) {
      startKbEngineIndexing();
    }
  });
  const pythonDefinitionImpl = new PythonDefinitionProvider(
    entityMappingManager,
    pythonClassIndex,
    dataDictIndex
  );
  const pythonDefinitionProvider = vscode.languages.registerDefinitionProvider(
    { language: 'python', scheme: 'file' },
    {
      async provideDefinition(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken) {
        const requestCancellation = createLinkedCancellationToken(token);
        const operation = startLanguageServiceOperation('definition', {
          fileKind: 'python',
          documentVersion: document.version
        });
        try {
          const result = await raceWithBudget('definition:request',
            pythonDefinitionImpl.provideDefinition(document, position, requestCancellation.token),
            HOVER_ASYNC_BUDGET_MS_DEFAULT, token, requestCancellation.cancel);
          operation.end(requestCancellation.token.isCancellationRequested ? 'cancelled' : emptyResultStatus(result));
          return result;
        } catch (error) {
          operation.end('error');
          throw error;
        } finally {
          requestCancellation.dispose();
        }
      }
    }
  );
  context.subscriptions.push(pythonDefinitionProvider);
  let pythonIndexWatchers: vscode.Disposable[] = [];
  // IDE-SNP-008:watcher 原始通知先入本索引的合并器(同 URI 同 kind 的重复
  // 通知只应用一次;窗口内 kind 变化补投终态),pythonClassIndex 经订阅收单。
  const pythonIndexFileEvents = createSharedFileEventMerger();
  // 文件变化元信息(方案 B):热更审计与 python 索引日志共用同一行格式。
  // scriptRoot 取 tempEdit 的脚本资源根(与双名称解析同口径),留空由解析器
  // 按 `<assetsRoot>/scripts` 约定兜底;assetsRoot 每次现取(配置热切换)。
  const fileChangeMetaResolver = createFileChangeMetaResolver({
    scriptRoot: () =>
      readTempEditReloadSettings(
        tempEditSectionReader(vscode.workspace.getConfiguration('kbengine').get<unknown>('hotReload', undefined))
      ).scriptRoot,
    assetsRoot: () => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
      return root ? resolveAssetsRootForWorkspace(root) : '';
    }
  });
  context.subscriptions.push(
    { dispose: () => pythonIndexFileEvents.dispose() },
    { dispose: pythonIndexFileEvents.subscribe(event => {
      if (event.kind === 'delete') {
        pythonClassIndex.invalidate(event.fsPath);
        return;
      }
      void pythonClassIndex.onFileChanged(event.fsPath);
    }) },
    // 文件变化元信息(方案 B):索引事件的元信息行沿用既有 jumpLog 开关与
    // 通道(默认关 → 关时零 IO、不新增设置项)。与上面的索引接线分属两个
    // 订阅者:老消费端同步收单的口径不动,元信息解析是懒异步的。
    { dispose: pythonIndexFileEvents.subscribe(event => {
      logIndexFileChangeMeta(fileChangeMetaResolver, event);
    }) }
  );
  // KODE-PERF 重复扫描抑制(KB-GC-001):watcher 集是 patterns 的纯函数,
  // 同签名重建是空转(伴随 invalidate+全量重扫)。两条面:
  // ① 签名守卫:patterns(工作区 glob + 外部根 RelativePattern 集)未变时
  //    跳过整组拆除重建——foldersChanged 空事件/同配置重复通知不再触发重扫;
  // ② 排除目录出口过滤:PY_SCAN_EXCLUDED_DIRS(node_modules/.git/out/dist 等)
  //    命中的路径事件在 watcher 出口即丢弃,不进合并器/消费索引(消费面各自
  //    内部早有同口径过滤,这里把空转挡在最上游)。
  let lastWatcherSignature: string | null = null;
  const watchPythonIndex = () => {
    const patterns: vscode.GlobPattern[] = [
      '**/*.{py,def,xml}',
      ...getExternalScanRoots().map(root => new vscode.RelativePattern(root, '**/*.{py,def,xml}'))
    ];
    const signature = watcherPatternSignature(patterns);
    if (signature === lastWatcherSignature) {
      return;
    }
    lastWatcherSignature = signature;
    pythonIndexWatchers.forEach(watcher => watcher.dispose());
    pythonIndexWatchers = [];
    for (const pattern of patterns) {
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      pythonIndexWatchers.push(watcher,
        watcher.onDidCreate(uri => { if (!isExcludedScanPath(uri.fsPath)) pythonIndexFileEvents.emit(uri.fsPath, 'create'); }),
        watcher.onDidChange(uri => { if (!isExcludedScanPath(uri.fsPath)) pythonIndexFileEvents.emit(uri.fsPath, 'change'); }),
        watcher.onDidDelete(uri => { if (!isExcludedScanPath(uri.fsPath)) pythonIndexFileEvents.emit(uri.fsPath, 'delete'); }));
    }
  };
  watchPythonIndex();
  // IDE-SNP-009:统一移除根通知——根移除事件一次广播,各消费索引订阅后
  // 定向摘除(实体/语义走 removeRoot(IDX-015 路径),Python 索引走 removeRoot
  // 定向摘文件),不再整库失效等重扫自愈
  const rootRemovals = createRootRemovalNotifier();
  context.subscriptions.push(
    { dispose: () => rootRemovals.dispose() },
    { dispose: rootRemovals.subscribe(event => { entityMappingManager.removeRoot(event.rootPath); }) },
    { dispose: rootRemovals.subscribe(event => { pythonClassIndex.removeRoot(event.rootPath); }) },
    // IDE-RES-008:根移除同时释放 documentStore 派生缓存——该根下文档快照
    // (源码文本/行索引)与 entities/def 解析缓存不再被长会话持有(文档可能
    // 仍开着,下次访问按空快照重建重解析)
    { dispose: rootRemovals.subscribe(event => { releaseDocumentsUnderRoot(event.rootPath); }) },
    { dispose: () => pythonIndexWatchers.forEach(watcher => watcher.dispose()) },
    vscode.workspace.onDidCloseTextDocument(document => pythonClassIndex.onDocumentClosed(document)),
    vscode.workspace.onDidChangeWorkspaceFolders(event => {
      resetScanRootCache();
      // IDE-IDX-015/IDE-SNP-009:移除的根经统一通知整根摘除各索引记录(留存根原样保留)
      const removedFolders = (event as { removed?: ReadonlyArray<{ uri: { fsPath: string } }> }).removed ?? [];
      for (const folder of removedFolders) {
        rootRemovals.emit(folder.uri.fsPath);
      }
      // 新增根保持既有发现面:全量失效触发增量发现;纯移除事件不再整库失效
      const addedFolders = (event as { added?: ReadonlyArray<{ uri: { fsPath: string } }> }).added ?? [];
      if (addedFolders.length > 0) {
        pythonClassIndex.invalidate();
      }
      // IDE-SNP-010:根集变化是快照隐性输入,generation 前进使持旧快照的消费端判过期
      if (removedFolders.length > 0 || addedFolders.length > 0) {
        bumpRootConfigGeneration('workspace-folders');
      }
      watchPythonIndex();
    })
  );

  // RPC 方法标记(批126 用户令:Python 侧函数看不出哪些是 def 声明的
  // RPC):在实现脚本里命中 def 方法声明的声明行上方出一行可点 CodeLens
  // (区块/Exposed/来源 def,点击回声明),普通函数不出;批154 起配独立
  // 开关 kbengine.codeLens.rpc,实例留在具名变量供配置监听 fire
  const rpcCodeLensProviderImpl = new RpcCodeLensProvider(entityMappingManager);
  const rpcCodeLensProvider = vscode.languages.registerCodeLensProvider(
    pythonDocumentSelector,
    rpcCodeLensProviderImpl
  );
  context.subscriptions.push(rpcCodeLensProvider);

  const callChainController = new CallChainController(entityMappingManager, context);
  const callChainLensProvider = vscode.languages.registerCodeLensProvider(
    pythonDocumentSelector,
    callChainController
  );
  context.subscriptions.push(callChainLensProvider);
  const showCallChainCommand = vscode.commands.registerCommand(
    'kbengine.python.showCallChain',
    (uri?: vscode.Uri, line?: number, methodName?: string) =>
      callChainController.showForActiveEditor(uri, line, methodName)
  );
  context.subscriptions.push(showCallChainCommand);
  context.subscriptions.push(callChainController);

  // 属性访问标记(批135 用户令:types.xml 能跳到代码,代码侧没有等价的反向
  // 标记):self.<属性> 访问处出一行 CodeLens,标 def 声明的类型与可见域,
  // 点击回 def 声明行;只认 self.<属性> 形态,与属性 F12 同口径;批154 起
  // 配独立开关 kbengine.codeLens.property
  const propertyCodeLensProviderImpl = new PropertyCodeLensProvider(entityMappingManager);
  const propertyCodeLensProvider = vscode.languages.registerCodeLensProvider(
    pythonDocumentSelector,
    propertyCodeLensProviderImpl
  );
  context.subscriptions.push(propertyCodeLensProvider);

  // 事件回调标记(批154 从 RPC 镜链返回值里拆出独立注册):addEvent/
  // registerEvent 的回调 def 声明处标「事件回调 · EV_X」、emitEvent 处标
  // 监听数,独立开关 kbengine.codeLens.eventCallbacks,与 RPC 互不影响
  // IDE-EVT-012:事件 CodeLens 复用统一文件索引(全仓扫描入口只此一份)
  // 预启动错峰窗:激活后等冷窗(首查/首扫/Pylance 初始化)过去再入队全量扫描
  const WORKSPACE_PRESTART_GRACE_MS = 8_000;
  const sharedWorkspaceIndex = new WorkspaceIndex();
  const eventCodeLensProviderImpl = new EventCodeLensProvider(sharedWorkspaceIndex);
  const eventCodeLensProvider = vscode.languages.registerCodeLensProvider(
    pythonDocumentSelector,
    eventCodeLensProviderImpl
  );
  context.subscriptions.push(eventCodeLensProvider, eventCodeLensProviderImpl);
  context.subscriptions.push(sharedWorkspaceIndex);
  // IDE-AUD-036:共享事件索引(WorkspaceIndex)也收统一根移除通知——该根缓存
  // 条目定向摘除,在途 B 回包按版本作废,其他根原样保留(R2-F11 覆盖共享事件索引)。
  context.subscriptions.push(
    { dispose: rootRemovals.subscribe(event => { sharedWorkspaceIndex.removeRoot(event.rootPath); }) }
  );
  // EVT-012 冷路径(2026-10-28 审核整改;同日现场联合重验修订):共享索引
  // 首扫提前到启动期后台队列(KBEngine 特征门控与首扫口径一致),首次交互
  // CodeLens 不再是全仓扫描的触发点。激活瞬间入队会让该任务与 python 首扫
  // /文件发现在同一冷窗互踩(现场联合重验:冷首查 1189ms→2526ms 且预算内
  // 0 目标),故延迟 8s 错峰——首用交互扫描(RequestLocal)先行,预启动只
  // 在冷窗之后补位。门控外工作区保持懒启动:无事件调用的纯 Python 仓零后台扫描。
  void shouldStartKbEngineIndexing().then(gated => {
    if (!gated) { return; }
    const grace = setTimeout(() => {
      void indexScheduler.enqueue({
        kind: 'non-interactive',
        priority: IndexTaskPriority.NonInteractive,
        run: async () => {
          try {
            await sharedWorkspaceIndex.ensureStarted();
          } catch {
            // 首扫失败不拖垮启动:交互侧首用时仍可按需重扫(幂等)
          }
        }
      }).wait.catch(() => undefined);
    }, WORKSPACE_PRESTART_GRACE_MS);
    context.subscriptions.push({ dispose: (): void => clearTimeout(grace) });
  });

  // types.xml 类型声明行的引用反扫镜(批134 用户拍板「形态 + 引用反扫
  // CodeLens」):声明行上方列真实使用(实体.属性 → 落库表.列),点击开
  // schema 文档定位到列;批154 起配独立开关 kbengine.codeLens.typesXml。
  // IDE-ARC-005:def/types.xml/entities.xml 全仓 watcher 归装配线模块统一
  // 建/释放(provider 不私建第二套全仓服务),impl 实例一并入 subscriptions
  const typesXmlCodeLensProviderImpl = new TypesXmlCodeLensProvider();
  const typesXmlCodeLensProvider = vscode.languages.registerCodeLensProvider(
    [{ language: 'xml', scheme: 'file', pattern: '**/types.xml' }],
    typesXmlCodeLensProviderImpl
  );
  context.subscriptions.push(typesXmlCodeLensProvider, typesXmlCodeLensProviderImpl);
  context.subscriptions.push(
    registerTypeStorageIndexWatchers(() => typesXmlCodeLensProviderImpl.fireConfigurationChanged())
  );

  // 生成桩的来源镜(T-05):声明/字段行上方保留原始 types.xml 行,点击
  // 直接跳原始声明;禁止从生成行号反推来源。
  const generatedSourceLensProviderImpl = new GeneratedSourceCodeLensProvider(
    PYTHON_TYPE_STUB_FILE_NAME,
    buildPythonTypeStubPlan(
      getCustomTypeInfos(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '')
    ).entries,
    [],
    // KR-AUD-78:来源镜按渲染期记录的真实行映射,不再硬编码 0/2
    buildPythonTypeStubLineMap(
      buildPythonTypeStubPlan(
        getCustomTypeInfos(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '')
      ).entries
    )
  );
  const generatedSourceLensProvider = vscode.languages.registerCodeLensProvider(
    pythonDocumentSelector,
    generatedSourceLensProviderImpl
  );
  context.subscriptions.push(generatedSourceLensProvider);

  // types.xml 数据类型 inlay hints(批154 用户令 todo:7):python 侧
  // self.<属性> 访问处原位渲染 def 声明的 <Type> 取值,与属性 F12 同索引;
  // 一枚独立开关 kbengine.inlayHints.typeData(默认开),inlay 无变更事件,
  // provider 现读配置下一次渲染即生效,不需要配置监听 fire
  const typeInlayHintsProvider = vscode.languages.registerInlayHintsProvider(
    pythonDocumentSelector,
    new PythonTypeInlayHintsProvider(entityMappingManager, dataDictIndex)
  );
  context.subscriptions.push(typeInlayHintsProvider);

  // 内建属性行内类型提示(用户令 2026-10-21 形态升级单 ③):self.<内建属性>
  // 访问处 `: <type>` inlay,与 hover 同一命中底座;独立开关
  // kbengine.python.builtinTypeInlayHints(默认开)且受总闸
  // kbengine.entity.builtinProperties 双控,provider 现读配置下一次渲染即生效
  const builtinTypeInlayHintsProvider = vscode.languages.registerInlayHintsProvider(
    pythonDocumentSelector,
    new KBEngineBuiltinTypeInlayHintsProvider(entityMappingManager)
  );
  context.subscriptions.push(builtinTypeInlayHintsProvider);

  // def 函数形参 inlay(定义点,用户令 2026-10-27 任务2):entity 脚本区块内
  // `def foo(self, a, b):` 未标注形参后渲染 def <Arg> 类型,方向反转到定义点;
  // 独立开关 kbengine.inlayHints.defParams(默认开),provider 现读配置
  // 下一次渲染即生效,不需要配置监听 fire
  const defParamInlayHintsProvider = vscode.languages.registerInlayHintsProvider(
    pythonDocumentSelector,
    new DefParamInlayHintsProvider(entityMappingManager)
  );
  context.subscriptions.push(defParamInlayHintsProvider);

  // C-22 def 属性只读视图 inlay(注释锚形态):整行注释锚
  // `# kode:props-from-def` 行尾渲染该实体 def 根级属性清单(纯渲染,事实源
  // = .def);独立开关 kbengine.inlayHints.defProps(默认开),provider 现读
  // 配置下一次渲染即生效,不需要配置监听 fire
  const defPropsInlayHintsProvider = vscode.languages.registerInlayHintsProvider(
    pythonDocumentSelector,
    new DefPropsInlayHintsProvider(entityMappingManager)
  );
  context.subscriptions.push(defPropsInlayHintsProvider);

  // KODE-CFG-017-R 推断镜像行内提示:源行未标注而 .kbengine/inferred 副本
  // 同行有 pyrefly 注解处 `: <type>` / `-> <type>`;开关复用 infer.enabled
  // (镜像生产总闸),provider 现读配置下一次渲染即生效;副本只读不进导入解析
  const inferredTypeInlayHintsProvider = vscode.languages.registerInlayHintsProvider(
    pythonDocumentSelector,
    new InferredMirrorTypeInlayHintsProvider()
  );
  context.subscriptions.push(inferredTypeInlayHintsProvider);

  const callHierarchyProvider = vscode.languages.registerCallHierarchyProvider(
    [
      ...definitionNavigationSelector,
      { language: 'python', scheme: 'file' }
    ],
    new KBEngineCallHierarchyProvider(entityMappingManager)
  );
  context.subscriptions.push(callHierarchyProvider);

  // IDE-NAV-001:def 原生引用查询(Shift+F12)——统一符号身份链复用,
  // 引用位=python 调用点(getIncomingPythonMethodCalls 既有面)
  const referencesImpl = new KBEngineReferencesProvider(entityMappingManager, dataDictIndex);
  const referencesProvider = vscode.languages.registerReferenceProvider(
    defDocumentSelector,
    referencesImpl
  );
  context.subscriptions.push(referencesProvider);
  // GLOBDATA-001:python 文档引用查询(Shift+F12)——数据字典键访问落点
  // 返回同键族全部写+读点;同一实例双 selector 注册(非字典键落点交回 null)
  const pythonReferencesProvider = vscode.languages.registerReferenceProvider(
    { language: 'python', scheme: 'file' },
    referencesImpl
  );
  context.subscriptions.push(pythonReferencesProvider);
  // IDE-NAV-017:types.xml 符号引用查询(Shift+F12)——同一实例复用,只挂
  // types.xml 选择器(entities.xml 无类型符号引用面,不进引用查询)
  const typesXmlReferencesProvider = vscode.languages.registerReferenceProvider(
    { language: 'xml', scheme: 'file', pattern: '**/types.xml' },
    referencesImpl
  );
  context.subscriptions.push(typesXmlReferencesProvider);

  // IDE-NAV-005:def 文档符号(Outline)——Properties/三方法段容器+段内声明
  const documentSymbolProvider = vscode.languages.registerDocumentSymbolProvider(
    defDocumentSelector,
    new KBEngineDocumentSymbolProvider()
  );
  context.subscriptions.push(documentSymbolProvider);

  // IDE-NAV-006:工作区符号(Ctrl+T)——已索引 def 符号前缀查询,零全仓扫描
  const workspaceSymbolProvider = vscode.languages.registerWorkspaceSymbolProvider(
    new KBEngineWorkspaceSymbolProvider(entityMappingManager)
  );
  context.subscriptions.push(workspaceSymbolProvider);

  // IDE-NAV-007:Go to Implementations——def 方法按精确声明身份出实现列表
  const implementationProvider = vscode.languages.registerImplementationProvider(
    defDocumentSelector,
    new KBEngineImplementationProvider(entityMappingManager)
  );
  context.subscriptions.push(implementationProvider);

  // 注册重命名提供者(.def 属性/方法 F2 重命名,引用面见 defRenamer 头注)
  // IDE-NAV-011:属性重命名改写已解析 python self 访问,注入 manager
  const renameProvider = vscode.languages.registerRenameProvider(
    defDocumentSelector,
    new KBEngineRenameProvider(entityMappingManager)
  );
  context.subscriptions.push(renameProvider);

  // 注册 Python 文件的智能提示提供者（提供来自 .def 的属性和方法）
  // PR1 打点:completion(python 面)。
  const pythonCompletionImpl = new PythonCompletionProvider(entityMappingManager, getEngineApiCatalog());
  const pythonCompletionProvider = vscode.languages.registerCompletionItemProvider(
    { language: 'python', scheme: 'file' },
    {
      async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        _context: vscode.CompletionContext
      ) {
        const operation = startLanguageServiceOperation('completion', {
          fileKind: 'python',
          documentVersion: document.version
        });
        try {
          const version = document.version;
          const result = await pythonCompletionImpl.provideCompletionItems(document, position, token);
          if (token.isCancellationRequested || document.version !== version) {
            operation.end('cancelled');
            return null;
          }
          operation.end(emptyResultStatus(result));
          return result;
        } catch (error) {
          operation.end('error');
          throw error;
        }
      }
    },
    '.' // 输入 . 时触发
  );
  context.subscriptions.push(pythonCompletionProvider);
  return {
    kbengineHoverImpl,
    pythonDefinitionImpl,
    pythonClassIndex,
    startKbEngineIndexing,
    watchPythonIndex,
    fileChangeMetaResolver,
    callChainController,
    sharedWorkspaceIndex,
    rpcCodeLensProviderImpl,
    propertyCodeLensProviderImpl,
    eventCodeLensProviderImpl,
    typesXmlCodeLensProviderImpl
  };
}
