import { findFilesAcrossRoots, getExternalScanRoots, resetScanRootCache, resolveAssetsRootForWorkspace, setActiveProfileScanRoot } from './scanRoots';
import { bumpRootConfigGeneration } from './rootConfigGeneration';
import { createRootRemovalNotifier } from './rootRemovalEvents';
import { createSharedFileEventMerger } from './sharedFileEvents';
import { disposePythonParserWorker } from './pythonParserWorkerHost';
import { importExistingProject } from './projectImport';
import { createMinimalProject } from './projectCreate';
import { onDidChangeActiveProfile, resolveActiveProfile, selectActiveProfile } from './activeProfile';
import { showProfileHealthSummary } from './profileHealth';
import {
  classifyPythonService,
  collectPythonServiceFacts,
  renderPythonServiceMessage
} from './pythonLanguageServiceStatus';
import { setJumpLogEnabled } from './navigationLog';
import {
  RECEIVER_NONE_DIAGNOSTICS_ENABLED_DEFAULT,
  receiverNoneDiagnosticItemsAsync,
  type ReceiverDiagnosticItem
} from './receiverNoneDiagnostics';
import { createLinkedCancellationToken, HOVER_ASYNC_BUDGET_MS_DEFAULT, raceWithBudget, setHoverBudgetLogHub } from './hoverBudget';
import {
  getActiveOperationCounts,
  getLanguageServiceSummaryReport,
  renderActiveTasksReport,
  setDetailedRecordingEnabled,
  setLanguageServiceMetricsLogHub,
  startLanguageServiceOperation
} from './languageServiceMetrics';
import type { OperationStatus } from './languageServiceMetrics';
import {
  releaseAllDocumentSnapshots,
  releaseDocument,
  releaseDocumentsUnderRoot,
  updateDocumentSnapshot
} from './documentStore';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { KBEngineServerManager, SERVER_COMPONENTS, parseServerKey, DEFAULT_TARGET_ID } from './serverManager';
import {
  injectDebugpyAfterStart,
  syncDebugpyPackage,
  allocateDebugpyInstancePort,
  autoDebugpyEnabled,
  debugpyPackageDir,
  debugpyPortFor,
  type DebugpyInjectTarget
} from './autoDebugpy';
import { checkInterpreterDebugpy, debugpyPreflightAllowsInjection, debugpyPreflightDeps } from './debugpyPreflight';
import {
  findEngineEntryScript,
  injectWaitBootstrap,
  removeWaitBootstrap,
  debugpyWaitAtStartupEnabled
} from './debugpyWaitAtStartup';
import {
  DebugSessionRegistry,
  applySessionEndBehavior,
  SESSION_END_BEHAVIOR_DEFAULT,
  type DebugSessionEndBehavior,
  type DebugSessionLike
} from './debugSessionRegistry';
import {
  buildDebugStatusRows,
  type DebugInjectionEntry
} from './debugStatusBoard';
import { DebugTargetTreeProvider, DEBUG_PHASE_LABELS } from './debugStatusTree';
import { BUILD_TASK_TYPE, buildScriptCheckTaskSpec, formatBuildTaskPreview } from './buildTaskSpec';
import { KbengineBuildTaskProvider } from './buildTaskProvider';
import { discoverProjectPythonTests, showPythonTestList } from './pythonTestDiscovery';
import { runPythonTests, spawnTestProcess } from './pythonTestRunner';
import {
  captureTaskRunContext,
  prepareTestRun,
  taskContextScriptsRoot,
  TEST_TASK_CONTEXT_STORAGE_KEY
} from './taskContext';
import { showEntityMessageTablePreview } from './messageTablePreview';
import { exportEntityMessageTable } from './messageTableExport';
import { buildMessageTable, renderMessageTableJson, renderMessageTableMarkdown, type DefTreeSource } from './messageTable';
import { createDefinitionSemanticsLoader } from './definitionSemantics';
import { getIndexScanRoots } from './scanRoots';
import { ProjectProfileStore } from './projectProfiles';
import { RuntimeLogLevel } from './logHub';
import { KBEngineLogCollector, LogCollectorConfig } from './logCollector';
import { LogViewerWebView } from './logWebView';
import {
  buildDefReferenceGraphFromFile,
  buildProjectDoctorReport,
  formatDefReferenceGraphPreview,
  formatProjectDoctorReport
} from './defReferenceGraph';
import {
  LogErrorScanView,
  realLogErrorScanDeps,
  runLogErrorScanCommand,
  scanRawLogErrors
} from './logErrorScan';
import { DebugConfigManager } from './debugConfig';
import { MonitoringWebView } from './monitoringWebView';
import { MonitoringCollector } from './monitoringCollector';
import { discoverLocalComponents, querySpaces, startProfileQuery } from './kbengineProtocol';
import { RuntimeQueryWebView } from './runtimeQueryWebView';
import { CallChainController } from './defCallChainProvider';
import {
  checkExtensionCompatibility,
  findEngineRoot,
  formatEngineCompatibilityReport,
  type ExtensionCompatibilityTarget
} from './engineCompatibility';
import {
  DefinitionSymbolIdentity,
  EntityMappingManager,
  EntityMethodSection
} from './entityMapping';
import { EntityDependencyWebView } from './entityDependencyWebView';
import { EntityFlowWebView } from './entityFlowWebView';
import { KBEngineCodeGenerator } from './codeGenerator';
import { runGeneratorFormWizard } from './generatorForms';
import { runClientSdkGenerateCommand } from './clientSdkGenerator';
import { bindSdkGenerationToProfile } from './sdkGenerationProfile';
import { makeSdkEngineTrace } from './sdkGenerationTrace';
import {
  EntityExplorerProvider,
  pickServerComponent,
  ServerControlProvider
} from './explorerProviders';
import { resolveServerComponent } from './serverCommandTarget';
import { parseHttpRequestEntries } from './httpRequests';
import { HttpRequestService } from './httpRequestService';
import { QuickActionManager, setDefaultScriptRuntime } from './quickActions';
import { QuickActionTreeProvider } from './quickActionTree';
import { setupHotReload } from './hotReload';
import { setupKodeCoreGate } from './kodeCoreGateWiring';
import {
  shadowMirrorCorpusDocument,
  shadowReleaseCorpusDocument
} from './kodeCoreShadowFaces';
import {
  readTempEditReloadSettings,
  runTempEditReload,
  tempEditSectionReader
} from './hotReloadTempEdit';
import { fileSystemScriptRootDeps, syncPythonExtraPaths } from './pythonExtraPaths';
import { disableJsoncAssociation, syncJsoncAssociation } from './jsoncAssociation';
import { exportKbeStubs, fileSystemStubExportDeps, readManagedDirSetting, resolveManagedDirName } from './pythonStubExport';
import {
  PYTHON_TYPE_STUB_FILE_NAME,
  buildPythonTypeStubPlan,
  exportPythonTypeStubs,
  setupTypeStubRegeneration
} from './pythonTypeStubs';
import { GeneratedSourceCodeLensProvider } from './generatedSourceLenses';
import {
  buildEntityTypeStubPlan,
  exportEntityTypeStubs
} from './entityTypeStubs';
import { getCustomTypeInfos, getWorkspaceRootForDocument } from './definitionWorkspace';
import {
  applySavedFileAnnotations,
  getPendingDocumentUpdateCount,
  removeSavedFileAnnotations,
  renameSavedFileAnnotations,
  queueDocumentReturnAnnotations,
  releaseDocumentReturnAnnotations
} from './pythonReturnTypeInference';
import {
  DEBUG_CONFIG_CHANNEL_NAME,
  ensureDebugConfig,
  fileSystemBootstrapDeps
} from './debugConfigBootstrap';
import {
  readTelnetTargetsFromSettings,
  TelnetService,
  updateTelnetStatusBar
} from './telnetService';
import { TelnetWebView } from './telnetWebView';
import {
  KBEngineCallHierarchyProvider,
  KBEngineReferencesProvider,
  KBEngineDocumentSymbolProvider,
  KBEngineWorkspaceSymbolProvider,
  KBEngineImplementationProvider,
  KBEngineCompletionProvider,
  EventCodeLensProvider,
  KBEngineDefinitionProvider,
  KBEngineHoverProvider,
  KBEngineBuiltinTypeInlayHintsProvider,
  KBEngineRenameProvider,
  KBEngineSignatureHelpProvider,
  KBEngineTypeCodeActionProvider,
  KBEngineMethodImplementationCodeActionProvider,
  prewarmKbengineIndex,
  revealSourceCommand,
  PythonCompletionProvider,
  PythonDefinitionProvider,
  PropertyCodeLensProvider,
  RpcCodeLensProvider,
  TypesXmlCodeLensProvider,
  isPythonMroJumpEnabled,
  setPythonMroJumpEnabled,
  validateDocument,
  validateEntitiesXmlDocument
} from './languageProviders';
import { WorkspaceIndex } from './workspaceIndex';
import { PythonTypeInlayHintsProvider } from './typeInlayHints';
import { DefParamInlayHintsProvider } from './defParamInlayHints';
import { PythonClassIndex } from './pythonClassIndex';
import { IndexScheduler, IndexTaskPriority } from './indexScheduler';
import { shouldStartKbEngineIndexing } from './workspaceGate';
import { preheatDiscoveryScan } from './workspaceDiscovery';
import { getDiagnosticScheduler } from './diagnosticScheduler';
import {
  getDatabaseSchemaSnapshot,
  locateDatabaseSchemaLine,
  resolveEntityTableName,
  resolveSchemaTablePrefix,
  getPendingTypeStorageColdBuildCount,
  setTypeStorageUsageBackgroundDispatcher
} from './databaseSchema';
import {
  createDatabaseSchemaUri,
  KBEngineDatabaseSchemaProvider
} from './databaseSchemaPresentation';
import {
  checkDatabaseDrift,
  checkDatabaseDriftForSnapshots,
  createMysqlDriftExecutor,
  DATABASE_DRIFT_CHANNEL_NAME,
  publishDriftReport
} from './databaseDrift';
import {
  createDatabaseSimulationUri,
  getSimulationEntityName,
  isDatabaseSimulationDocument,
  KBENGINE_DATABASE_SIMULATION_SCHEME,
  KBEngineDatabaseSimulationProvider
} from './databaseSimulator';
import { findEntityDefinitionFile, getDefinitionWorkspaceLayout, getRegisteredEntities, readWorkspaceTextFile } from './definitionWorkspace';
import { scheduleBackgroundSchemaWarmup } from './schemaWarmup';
import { analyzeDefDocument, collectInheritedNames, formatDefAnalysisReport } from './defAnalyzer';
import { joinWorkspacePath } from './workspacePath';
import {
  CUSTOM_SNIPPETS_RELATIVE_PATH,
  mergeSnippetEntry,
  selectionToSnippetBody
} from './snippetGenerator';
import type { MergeSnippetResult } from './snippetGenerator';
import { buildEngineApiCatalog, readEngineApiMetadata } from './engineApiMetadata';
import { KBE_SCHEME, appendEngineApiMetadata, buildKbeStubDocument } from './kbeModuleIndex';
import {
  SERVER_CONFIG_SELECTOR,
  ServerConfigHoverProvider
} from './serverConfigHover';
import {
  KBE_CONFIG_SCHEME,
  KBE_CONFIG_VIRTUAL_PATH,
  FinalConfigContentProvider,
  FinalConfigTreeProvider,
  buildFinalServerConfig,
  resetDatabaseInterfaceConfigCache,
  resolveDatabaseInterfaceConfig
} from './serverConfigMerge';
import type { DiscoveryKey, DiscoveryLayoutFacts, DiscoveryPromptDeps } from './workspaceDiscovery';
import {
  buildDiscoveryReport,
  renderDiscoveryReport,
  runWorkspaceDiscovery
} from './workspaceDiscovery';
import { hostLabel, renderExtensionIdentityReport, sideLabel } from './extensionIdentity';
import { KBENGINE_SOURCE_REVEAL_COMMAND } from './sourceRevealCommand';
import { renderReproductionSummary } from './reproductionSummary';
import { detectDualActivation, formatDualActivationWarning } from './dualActivationConflict';
import { readBuildCommit } from './buildCommit';
import { setFileReadVerbose } from './fileReadMetrics';
import { setCpuProfileDirectory, startCpuProfile, stopCpuProfile } from './cpuProfileCapture';
import {
  getEventLoopDelayReport,
  getHostVitalsReport,
  startEventLoopDelayMonitor,
  startHostVitalsMonitor,
  stopEventLoopDelayMonitor,
  stopHostVitalsMonitor
} from './hostVitals';
import { TelnetTreeProvider } from './telnetTree';
/**
 * Kode - KBEngine Development Environment
 * KBEngine VSCode 扩展主入口
 */

export function activate(context: vscode.ExtensionContext) {
  console.log('KBEngine Language Extension is now active!');
  const engineApiEnabled = vscode.workspace.getConfiguration('kbengine')
    .get<boolean>('python.apiMetadata', true);
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  let engineApiCatalog: Awaited<ReturnType<typeof buildEngineApiCatalog>> | null = null;
  if (engineApiEnabled) {
    const catalogPromise = buildEngineApiCatalog(workspaceRoot).then(catalog => {
      engineApiCatalog = catalog;
      return catalog;
    }).catch(() => null);
    void catalogPromise;
  }
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(KBE_SCHEME, {
      provideTextDocumentContent(): string {
        const stub = buildKbeStubDocument();
        return engineApiCatalog
          ? appendEngineApiMetadata(stub.content, engineApiCatalog.metadata)
          : stub.content;
      }
    })
  );
  // 跳转决策路径日志开关(默认关闭;Settings 搜 kbengine.jumpLog 随时切换)
  setJumpLogEnabled(vscode.workspace.getConfiguration('kbengine').get<boolean>('jumpLog', false));
  // 层2 python-mro(mixin 函数导航)开关(默认开;Settings 搜 kbengine.python.enableMroJump 随时切换)
  setPythonMroJumpEnabled(vscode.workspace.getConfiguration('kbengine.python').get<boolean>('enableMroJump', true));
  // kode2 PR-012:双轨切流门(kill-switch/shadow;kbengine.core.backend 默认 ts,
  // Rust 仅影子比对不服务,默认装配下用户可见行为与纯 TS 单轨一致)
  setupKodeCoreGate(context);
  const databaseSchemaProvider = new KBEngineDatabaseSchemaProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('kbengine-db-schema', databaseSchemaProvider)
  );
  // 数据库模拟(批122):schema 快照之上的行模拟虚拟文档,scheme 与
  // databaseSchema 的 kbengine-db-schema 并列
  const databaseSimulationProvider = new KBEngineDatabaseSimulationProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      KBENGINE_DATABASE_SIMULATION_SCHEME,
      databaseSimulationProvider
    )
  );
  // kbe 模块符号桩文档(批108):go-to-definition 的只读跳转源
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(KBE_SCHEME, {
      provideTextDocumentContent(): string {
        const stub = buildKbeStubDocument();
        return engineApiCatalog
          ? appendEngineApiMetadata(stub.content, engineApiCatalog.metadata)
          : stub.content;
      }
    })
  );
  const defDocumentSelector: vscode.DocumentSelector = [
    { language: 'kbengine-def', scheme: 'file' },
    { scheme: 'file', pattern: '**/*.def' },
    { language: 'kbengine-def', scheme: 'untitled' }
  ];
  const kbengineXmlSelector: vscode.DocumentSelector = [
    { language: 'xml', scheme: 'file', pattern: '**/types.xml' },
    { language: 'xml', scheme: 'file', pattern: '**/entities.xml' }
  ];
  const definitionNavigationSelector: vscode.DocumentSelector = [
    ...defDocumentSelector,
    ...kbengineXmlSelector
  ];
  const pythonDocumentSelector: vscode.DocumentSelector = [
    { language: 'python', scheme: 'file' }
  ];

  const isDefDocument = (document: vscode.TextDocument): boolean =>
    document.languageId === 'kbengine-def' || document.fileName.toLowerCase().endsWith('.def');
  // entities.xml 清单诊断(source-analysis 设计 D3):与 .def 共用同一
  // 诊断 collection 与文档事件生命周期
  const isEntitiesXmlDocument = (document: vscode.TextDocument): boolean =>
    document.fileName.endsWith('entities.xml');
  // Python 侧诊断(receiver 可能为 None + 段错配,用户令 2026-10-27):与
  // .def/entities.xml 共用诊断 collection 与文档事件生命周期
  const isPythonDocument = (document: vscode.TextDocument): boolean =>
    document.languageId === 'python';

  // PR1 性能观测:请求级打点只看「结果是否为空」定 ok/miss(vscode Hover /
  // Location / CompletionItem[] 约定),结果对象原样透传,不改任何语义。
  const emptyResultStatus = (result: unknown): OperationStatus => {
    if (result === null || result === undefined) {
      return 'miss';
    }
    if (Array.isArray(result)) {
      return result.length === 0 ? 'miss' : 'ok';
    }
    if (typeof result === 'object') {
      const contents = (result as { contents?: unknown[] }).contents;
      return Array.isArray(contents) && contents.length === 0 ? 'miss' : 'ok';
    }
    return 'ok';
  };

  // PR1 打点:diagnostics = validateDocument/validateEntitiesXmlDocument 的
  // 同步耗时(保持同步调用,不改发布时序)。
  const validateDocumentTimed = (document: vscode.TextDocument, collection: vscode.DiagnosticCollection): void => {
    const operation = startLanguageServiceOperation('diagnostics', {
      fileKind: 'def',
      documentVersion: document.version
    });
    try {
      validateDocument(document, collection);
      operation.end('ok');
    } catch (error) {
      operation.end('error');
      throw error;
    }
  };
  const validateEntitiesXmlDocumentTimed = (document: vscode.TextDocument, collection: vscode.DiagnosticCollection): void => {
    const operation = startLanguageServiceOperation('diagnostics', {
      fileKind: 'entities',
      documentVersion: document.version
    });
    try {
      validateEntitiesXmlDocument(document, collection);
      operation.end('ok');
    } catch (error) {
      operation.end('error');
      throw error;
    }
  };

  // PR6 A6-1/A6-2:诊断任务统一走 DiagnosticScheduler —— 版本令牌守卫只发布
  // 匹配当前版本的结果;连续编辑经排队通道合并过期任务;同版本+同诊断输入代
  // 已发布的请求零重算(skippedCurrentVersion,指标可断言)。
  const diagnosticScheduler = getDiagnosticScheduler();
  let diagnosticFlushTimer: ReturnType<typeof setTimeout> | undefined;
  context.subscriptions.push({
    dispose: () => {
      if (diagnosticFlushTimer !== undefined) {
        clearTimeout(diagnosticFlushTimer);
        diagnosticFlushTimer = undefined;
      }
    }
  });
  const scheduleDefDiagnostics = (
    document: vscode.TextDocument,
    channel: 'immediate' | 'queued'
  ): void => {
    const options = {
      layer: 'local' as const,
      compute: () => {
        const list: vscode.Diagnostic[] = [];
        // 复用既有计时面:计算本体仍走 validateDocumentTimed(内部含 PR1 打点)
        validateDocumentTimed(document, diagnostics);
        // validateDocument 同步写 collection;这里经 publish 面回填.scheduler 统计
        return list;
      },
      publish: () => {
        /* validateDocument 直接写 collection,无独立发布面 */
      }
    };
    if (channel === 'queued') {
      diagnosticScheduler.requestQueued(document, options);
    } else {
      diagnosticScheduler.request(document, options);
    }
  };
  const scheduleEntitiesDiagnostics = (
    document: vscode.TextDocument,
    channel: 'immediate' | 'queued'
  ): void => {
    const options = {
      layer: 'local' as const,
      compute: () => {
        const list: vscode.Diagnostic[] = [];
        validateEntitiesXmlDocumentTimed(document, diagnostics);
        return list;
      },
      publish: () => {
        /* validateEntitiesXmlDocument 直接写 collection,无独立发布面 */
      }
    };
    if (channel === 'queued') {
      diagnosticScheduler.requestQueued(document, options);
    } else {
      diagnosticScheduler.request(document, options);
    }
  };

  // 初始化实体映射管理器(用户令 2026-10-21 内建属性单:补全的 def 归属面
  // 兜底也走 manager,故提到补全注册之前)
  // PR3/PR5:统一索引调度器实例化一次共享——EntityMappingManager 首扫与
  // PythonClassIndex 文件发现/分块解析都经它入队,后台任务受交互限流。
  const indexScheduler = new IndexScheduler();
  context.subscriptions.push({ dispose: () => indexScheduler.dispose() });
  // SCH-009 冷路径退交互线程:types.xml 用法索引的冷构建(整仓读)派发到
  // 统一调度器 non-interactive 队列——交互线程冷读只回空表并登记后台构建,
  // CodeLens 由 onTypeStorageUsageIndexPublished 回调失效重算,不再首击
  // 同步整仓扫描。
  setTypeStorageUsageBackgroundDispatcher(run =>
    indexScheduler.enqueue({
      kind: 'non-interactive',
      priority: IndexTaskPriority.NonInteractive,
      run
    }).wait
  );
  // 书 PR-002 工作区门控:deferStartup=true → 构造零副作用(不建 watcher、
  // 不入队全量首扫)。是否启动由 shouldStartKbEngineIndexing() 的特征探测决定:
  // 有 .def/entities.xml/types.xml/alias.xml/kbengine*.xml 之一即启动(与门控前
  // 逐行为一致);无特征的纯 Python 工作区零后台扫描零 watcher,查询入口的
  // ensureStartup() 幂等兜底保证结果口径不变(fail-open:探测异常按放行处理)。
  const entityMappingManager = new EntityMappingManager(context, indexScheduler, {
    deferStartup: true
  });

  // Python 侧诊断(receiver 可能为 None + .def 段错配,用户令 2026-10-27 任务1):
  // compute 同步(guard 分析走 in-tree pythonParser;映射经 getMappingForPythonFile
  // 纯内存快照),severity=Warning,kbengine.receiverNoneDiagnostics 开关默认开,
  // 与 .def/entities.xml 共用诊断 collection 与文档事件生命周期。
  const scheduleReceiverNoneDiagnostics = (
    document: vscode.TextDocument,
    channel: 'immediate' | 'queued'
  ): void => {
    // IDE-DIA-005:大文件 receiver 诊断走异步分片面(片间让出宿主),计算
    // 期间版本前进即中止返回 null(旧版本回包丢弃),调度器完成后复核版本
    // 才发布;版本令牌以受理时为准,shouldContinue 与之同源
    const capturedVersion = document.version;
    const options = {
      layer: 'local' as const,
      computeAsync: async (): Promise<readonly ReceiverDiagnosticItem[] | null> => {
        const enabled = vscode.workspace.getConfiguration('kbengine')
          .get<boolean>('receiverNoneDiagnostics', RECEIVER_NONE_DIAGNOSTICS_ENABLED_DEFAULT);
        // IDE-DIA-003:与类索引消费同一份版本键解析(惰性提供器——仅当确有
        // receiver 使用点过闸后才取解析,DIA-001 零使用点不解析语义保持;
        // syncDocumentParse 命中即零解析,未命中解析一次入缓存供索引同版本
        // 去重);层2 关闭时索引不参与跳转,不喂索引,诊断自解析(口径不变)
        const preparsed = isPythonMroJumpEnabled() && isPythonDocument(document)
          ? () => pythonClassIndex.syncDocumentParse(document)
          : undefined;
        return receiverNoneDiagnosticItemsAsync(
          document.getText(),
          document.uri.fsPath,
          isPythonDocument(document)
            ? entityMappingManager.getMappingForPythonFile(document.uri.fsPath)
            : undefined,
          enabled,
          preparsed,
          {
            shouldContinue: () =>
              capturedVersion === undefined || document.version === capturedVersion
          }
        );
      },
      publish: (items: readonly ReceiverDiagnosticItem[]) => {
        diagnostics.set(document.uri, items.map(item => {
          const diagnostic = new vscode.Diagnostic(
            new vscode.Range(
              item.range.start.line, item.range.start.character,
              item.range.end.line, item.range.end.character
            ),
            item.message,
            vscode.DiagnosticSeverity.Warning
          );
          diagnostic.source = item.source;
          return diagnostic;
        }));
      }
    };
    if (channel === 'queued') {
      diagnosticScheduler.requestQueued(document, options);
    } else {
      diagnosticScheduler.request(document, options);
    }
  };

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
  // 标注走与 RPC CodeLens 同一把形参闸门;PR1 起带 hover 打点）
  const kbengineHoverImpl = new KBEngineHoverProvider(entityMappingManager);
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
  const pythonDefinitionImpl = new PythonDefinitionProvider(entityMappingManager, pythonClassIndex);
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
  const pythonIndexEditEvents = new Map<vscode.TextDocument, number>();
  let pythonIndexEditFlushTimer: NodeJS.Timeout | undefined;
  let pendingPythonIndexEditCount = 0;
  let pythonIndexWatchers: vscode.Disposable[] = [];
  // IDE-SNP-008:watcher 原始通知先入本索引的合并器(同 URI 同 kind 的重复
  // 通知只应用一次;窗口内 kind 变化补投终态),pythonClassIndex 经订阅收单。
  const pythonIndexFileEvents = createSharedFileEventMerger();
  context.subscriptions.push(
    { dispose: () => pythonIndexFileEvents.dispose() },
    { dispose: pythonIndexFileEvents.subscribe(event => {
      if (event.kind === 'delete') {
        pythonClassIndex.invalidate(event.fsPath);
        return;
      }
      void pythonClassIndex.onFileChanged(event.fsPath);
    }) }
  );
  const watchPythonIndex = () => {
    pythonIndexWatchers.forEach(watcher => watcher.dispose());
    pythonIndexWatchers = [];
    const patterns: vscode.GlobPattern[] = [
      '**/*.{py,def,xml}',
      ...getExternalScanRoots().map(root => new vscode.RelativePattern(root, '**/*.{py,def,xml}'))
    ];
    for (const pattern of patterns) {
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      pythonIndexWatchers.push(watcher,
        watcher.onDidCreate(uri => { pythonIndexFileEvents.emit(uri.fsPath, 'create'); }),
        watcher.onDidChange(uri => { pythonIndexFileEvents.emit(uri.fsPath, 'change'); }),
        watcher.onDidDelete(uri => { pythonIndexFileEvents.emit(uri.fsPath, 'delete'); }));
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
  // schema 文档定位到列;def/types.xml/entities.xml 改动由 provider 内
  // watcher 失效重扫;批154 起配独立开关 kbengine.codeLens.typesXml
  const typesXmlCodeLensProviderImpl = new TypesXmlCodeLensProvider();
  const typesXmlCodeLensProvider = vscode.languages.registerCodeLensProvider(
    [{ language: 'xml', scheme: 'file', pattern: '**/types.xml' }],
    typesXmlCodeLensProviderImpl
  );
  context.subscriptions.push(typesXmlCodeLensProvider);

  // 生成桩的来源镜(T-05):声明/字段行上方保留原始 types.xml 行,点击
  // 直接跳原始声明;禁止从生成行号反推来源。
  const generatedSourceLensProviderImpl = new GeneratedSourceCodeLensProvider(
    PYTHON_TYPE_STUB_FILE_NAME,
    buildPythonTypeStubPlan(
      getCustomTypeInfos(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '')
    ).entries,
    []
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
    new PythonTypeInlayHintsProvider(entityMappingManager)
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
  const referencesProvider = vscode.languages.registerReferenceProvider(
    defDocumentSelector,
    new KBEngineReferencesProvider(entityMappingManager)
  );
  context.subscriptions.push(referencesProvider);

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
  const pythonCompletionImpl = new PythonCompletionProvider(entityMappingManager, engineApiCatalog);
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

  // 注册诊断检查器
  const diagnostics = vscode.languages.createDiagnosticCollection('kbengine');
  context.subscriptions.push(diagnostics);

  // IDE-NAV-013:未知类型诊断的 QuickFix 替换候选(只出已注册类型的近似替换)
  const typeCodeActionProvider = vscode.languages.registerCodeActionsProvider(
    defDocumentSelector,
    new KBEngineTypeCodeActionProvider()
  );
  context.subscriptions.push(typeCodeActionProvider);

  // IDE-NAV-014:缺实现 def 方法生成空方法(目标属主脚本内插入,已有实现不重复)
  const methodImplementationCodeActionProvider = vscode.languages.registerCodeActionsProvider(
    defDocumentSelector,
    new KBEngineMethodImplementationCodeActionProvider(entityMappingManager)
  );
  context.subscriptions.push(methodImplementationCodeActionProvider);

  // 监听文档变化，实时检查
  if (vscode.workspace.workspaceFolders) {
    // PR2 快照接入:文档开/改先喂 documentStore(内存优先,快照与缓冲区同版本);
    // 关文档释放快照(内存不泄漏)。磁盘旧内容没有路径能进快照。
    context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(document => {
      updateDocumentSnapshot(document);
      // E-1:语料镜像腿独立于诊断开关(不走 validateDocument 的提前返回)
      shadowMirrorCorpusDocument(document);
    }));
    const closeWatcher = vscode.workspace.onDidCloseTextDocument(document => {
      releaseDocument(document);
      diagnosticScheduler.releaseDocument(document);
      // E-4:撤 Rust 侧镜像 overlay 与版本账(连续开合不积累)
      shadowReleaseCorpusDocument(document);
      // IDE-HOV-011:弃当前文件注解桶(未保存修改随关闭消失,回磁盘口径)
      if (isPythonDocument(document)) {
        releaseDocumentReturnAnnotations(
          getWorkspaceRootForDocument(document),
          document.uri.toString()
        );
      }
    });
    context.subscriptions.push(closeWatcher);
    const watcher = vscode.workspace.onDidChangeTextDocument(event => {
      updateDocumentSnapshot(event.document);
      shadowMirrorCorpusDocument(event.document);
      // IDE-HOV-011:未保存的返回注解变化按文档版本进入该文件桶。
      // 2026-10-28 审核整改:整文件注解提取移出编辑同步路径(同文件合并到
      // 最新版本,宏任务冲刷时让出式异步提取,不再在编辑事件里同步 120ms)。
      if (isPythonDocument(event.document)) {
        queueDocumentReturnAnnotations(getWorkspaceRootForDocument(event.document), {
          fileKey: event.document.uri.toString(),
          version: event.document.version,
          source: () => event.document.getText()
        });
      }
      // PR6 A6-1:连续编辑走排队通道——同 URI 只保留最新版本任务,旧版本
      // 任务出队合并(coalescedStale),宏任务边界冲刷时发布前复核版本令牌,
      // 过期结果绝不落 collection。首次发布语义不变(计算面仍是同步
      // validateDocument/validateEntitiesXmlDocument,仅发布时点推迟一拍)。
      if (isDefDocument(event.document)) {
        scheduleDefDiagnostics(event.document, 'queued');
      } else if (isEntitiesXmlDocument(event.document)) {
        scheduleEntitiesDiagnostics(event.document, 'queued');
      } else if (isPythonDocument(event.document)) {
        scheduleReceiverNoneDiagnostics(event.document, 'queued');
      }
      if (diagnosticFlushTimer === undefined) {
        diagnosticFlushTimer = setTimeout(() => {
          diagnosticFlushTimer = undefined;
          // IDE-DIA-006:flush 单轮时间片化(重批量让出宿主续批),不 await——
          // 编辑事件面不等诊断收尾,发布节拍与版本守卫全在调度器内
          void diagnosticScheduler.flushQueued();
        }, 0);
      }
      // Python 类索引增量失效:只重解析该文件,避免大仓全量扫描卡输入;
      // 层2 关闭时索引不参与跳转,变更喂给索引纯属后台空转,一并跳过
      if (isPythonMroJumpEnabled() && event.document.languageId === 'python' &&
          (event.contentChanges?.length ?? 0) > 0) {
        pendingPythonIndexEditCount += 1;
        pythonIndexEditEvents.set(event.document, pendingPythonIndexEditCount);
        if (!pythonIndexEditFlushTimer) {
          pythonIndexEditFlushTimer = setTimeout(() => {
            pythonIndexEditFlushTimer = undefined;
            const documents = [...pythonIndexEditEvents.keys()];
            pythonIndexEditEvents.clear();
            pendingPythonIndexEditCount = 0;
            for (const document of documents) {
              void pythonClassIndex.onDocumentChanged(document);
            }
          }, 100);
        }
      }
    });
    context.subscriptions.push(watcher);
    // IDE-HOV-012:保存只替换该文件注解桶(取文档文本纯内存换桶,不重读其他文件)
    const annotationSaveWatcher = vscode.workspace.onDidSaveTextDocument(document => {
      if (isPythonDocument(document)) {
        applySavedFileAnnotations(
          getWorkspaceRootForDocument(document),
          document.fileName,
          document.getText()
        );
      }
    });
    context.subscriptions.push(annotationSaveWatcher);
    // IDE-HOV-014:删除文件移除该文件注解桶(纯内存弃桶+重合并,零文件读取)
    const annotationDeleteWatcher = vscode.workspace.onDidDeleteFiles(event => {
      for (const uri of event.files) {
        if (uri.fsPath.endsWith('.py')) {
          removeSavedFileAnnotations(getWorkspaceRootForDocument({ fileName: uri.fsPath }), uri.fsPath);
        }
      }
    });
    context.subscriptions.push(annotationDeleteWatcher);
    // IDE-HOV-015:重命名迁移注解来源(旧键原位换新键;.py 改非 .py 视为移除)
    const annotationRenameWatcher = vscode.workspace.onDidRenameFiles(event => {
      for (const { oldUri, newUri } of event.files) {
        const wasPython = oldUri.fsPath.endsWith('.py');
        if (!wasPython) { continue; }
        if (newUri.fsPath.endsWith('.py')) {
          renameSavedFileAnnotations(
            getWorkspaceRootForDocument({ fileName: oldUri.fsPath }),
            oldUri.fsPath,
            newUri.fsPath
          );
        } else {
          removeSavedFileAnnotations(getWorkspaceRootForDocument({ fileName: oldUri.fsPath }), oldUri.fsPath);
        }
      }
    });
    context.subscriptions.push(annotationRenameWatcher);
  context.subscriptions.push({
    dispose: () => {
      if (pythonIndexEditFlushTimer) {
        clearTimeout(pythonIndexEditFlushTimer);
      }
    }
  });

    // 初始检查所有 .def 文件(立即通道:开档/激活期发布保持同步时点)
    const openWatcher = vscode.workspace.onDidOpenTextDocument(document => {
      if (isDefDocument(document)) {
        scheduleDefDiagnostics(document, 'immediate');
      } else if (isEntitiesXmlDocument(document)) {
        scheduleEntitiesDiagnostics(document, 'immediate');
      } else if (isPythonDocument(document)) {
        scheduleReceiverNoneDiagnostics(document, 'immediate');
      }
      // 批159:开 Python 档即预热实体 def 定向首解析,首次 hover/CodeLens/
      // 签名帮助不再吃冷启动等待(失败静默,预热是优化不是功能)。
      prewarmKbengineIndex(entityMappingManager, document);
    });
    context.subscriptions.push(openWatcher);

    vscode.workspace.textDocuments.forEach(document => {
      shadowMirrorCorpusDocument(document);
      if (isDefDocument(document)) {
        scheduleDefDiagnostics(document, 'immediate');
      } else if (isEntitiesXmlDocument(document)) {
        scheduleEntitiesDiagnostics(document, 'immediate');
      } else if (isPythonDocument(document)) {
        scheduleReceiverNoneDiagnostics(document, 'immediate');
      }
    });
  }

  const configWatcher = vscode.workspace.onDidChangeConfiguration(event => {
    if (!event.affectsConfiguration('kbengine')) {
      return;
    }

    // 跳转日志开关变更即时生效(不重载窗口)
    if (event.affectsConfiguration('kbengine.jumpLog')) {
      setJumpLogEnabled(vscode.workspace.getConfiguration('kbengine').get<boolean>('jumpLog', false));
    }

    // 层2 python-mro(mixin 函数导航)开关变更即时生效(不重载窗口)
    if (event.affectsConfiguration('kbengine.python.enableMroJump')) {
      const enabled = vscode.workspace.getConfiguration('kbengine.python').get<boolean>('enableMroJump', true);
      setPythonMroJumpEnabled(enabled);
    }

    // CodeLens 各功能开关变更即时生效(批154):四类镜链 provider 每次
    // 调用现读配置,这里只需各自 fire 让 VS Code 重取;hover 面(含
    // serverConfig)同样现读,不需要 fire
    if (event.affectsConfiguration('kbengine.codeLens')) {
      rpcCodeLensProviderImpl.fireConfigurationChanged();
      callChainController.fireConfigurationChanged();
      eventCodeLensProviderImpl.fireConfigurationChanged();
      propertyCodeLensProviderImpl.fireConfigurationChanged();
      typesXmlCodeLensProviderImpl.fireConfigurationChanged();
    }

    // 实体面开关变更即时生效(用户令 2026-10-21):hover/补全/跳转各 provider
    // 每次调用现读配置,无需 fire;RPC 镜链的接收者段镜是缓存面,重取一次
    if (event.affectsConfiguration('kbengine.entity')) {
      rpcCodeLensProviderImpl.fireConfigurationChanged();
    }

    if (event.affectsConfiguration('kbengine.python.callChainHints')) {
      callChainController.fireConfigurationChanged();
    }

    if (event.affectsConfiguration('kbengine.assetsRoot') ||
        event.affectsConfiguration('kbengine.python.enableMroJump')) {
      // IDE-SNP-010:assetsRoot 切换 = 根集输入变化——旧外部根记录先定向摘除
      // (实体/语义面不残留旧根可查结果,SNP-009 路径),generation 前进使持旧
      // 快照的消费端判过期;enableMroJump 只是开关,无根集变化,不 bump 不摘根
      if (event.affectsConfiguration('kbengine.assetsRoot')) {
        for (const oldRoot of getExternalScanRoots()) {
          entityMappingManager.removeRoot(oldRoot);
        }
        bumpRootConfigGeneration('assetsRoot');
      }
      resetScanRootCache();
      pythonClassIndex.invalidate();
      watchPythonIndex();
      // IDE-IDX-014:实体面外部根 watcher 三件套整组重建(旧根释放,新根挂上)
      entityMappingManager.refreshExternalRootWatchers();
      if (isPythonMroJumpEnabled()) { pythonClassIndex.scheduleBackgroundScan(); }
    }

    // IDE-SNP-010:运行域配置(表前缀/数据库连接)变化 → 根配置 generation 前进,
    // 持旧快照的消费端判过期(重读值本身由下方 resetDatabaseInterfaceConfigCache 失效)
    if (event.affectsConfiguration('kbengine.db') ||
        event.affectsConfiguration('kbengine.binPath') ||
        event.affectsConfiguration('kbengine.configPath')) {
      bumpRootConfigGeneration('db-config');
      // IDE-SCH-005:表前缀/连接配置切换 → 打开中的 schema 预览与模拟文档
      // 立即重取(新表名不等文件保存;快照面由 tablePrefix/generation 轴判过期)
      databaseSchemaProvider.refresh();
      databaseSimulationProvider.refresh();
    }

    // binPath/configPath 变更影响数据库连接读值(批131):只失效缓存本体;
    // 诊断面是否重算由下方诊断相关配置裁断决定(A6-2 收口:任意 kbengine.*
    // 变更都全量重扫旧行为废除,无关配置变更零重算)
    resetDatabaseInterfaceConfigCache();

    // PR6 A6-4:诊断开关切换正确清理/重算 —— 关闭即清空 collection 并停算,
    // 重开迫使全部已发布文档重算;子开关/结构开关变更使已发布标记失效后重算。
    if (event.affectsConfiguration('kbengine.enableDiagnostics')) {
      const enabled = vscode.workspace.getConfiguration('kbengine')
        .get<boolean>('enableDiagnostics', true);
      diagnosticScheduler.setEnabled(enabled, () => diagnostics.clear());
    }
    const diagnosticsInputsChanged =
      event.affectsConfiguration('kbengine.enableStructureDiagnostics') ||
      event.affectsConfiguration('kbengine.diagnostics') ||
      event.affectsConfiguration('kbengine.enableDiagnostics') ||
      event.affectsConfiguration('kbengine.receiverNoneDiagnostics');
    if (diagnosticsInputsChanged && diagnosticScheduler.isEnabled()) {
      if (event.affectsConfiguration('kbengine.enableStructureDiagnostics') ||
          event.affectsConfiguration('kbengine.diagnostics') ||
          event.affectsConfiguration('kbengine.receiverNoneDiagnostics')) {
        diagnosticScheduler.invalidateAll();
      }
      // receiverNoneDiagnostics 开关切换即重算(任务1,用户令 2026-10-27):
      // compute 每次现读配置，失效版本标记后重调已开文档。
      vscode.workspace.textDocuments.forEach(doc => {
        if (isDefDocument(doc)) {
          scheduleDefDiagnostics(doc, 'immediate');
        } else if (isEntitiesXmlDocument(doc)) {
          scheduleEntitiesDiagnostics(doc, 'immediate');
        } else if (isPythonDocument(doc)) {
          scheduleReceiverNoneDiagnostics(doc, 'immediate');
        }
      });
    }
  });
  context.subscriptions.push(configWatcher);

  // 注册侧边栏视图
  const entityExplorerProvider = new EntityExplorerProvider();
  const entityExplorerRegistration = vscode.window.registerTreeDataProvider(
    'kbengine.entityExplorer',
    entityExplorerProvider
  );
  context.subscriptions.push(entityExplorerRegistration);

  // 刷新实体浏览器的命令
  const refreshCommand = vscode.commands.registerCommand(
    'kbengine.refreshExplorer',
    () => entityExplorerProvider.refresh()
  );
  context.subscriptions.push(refreshCommand);

  const openEntityCommand = vscode.commands.registerCommand(
    'kbengine.entity.open',
    async (entityName: string) => {
      if (!entityName) {
        return;
      }

      const definitionPath = findEntityDefinitionFile(entityName);
      if (!definitionPath) {
        vscode.window.showWarningMessage(
          `打开实体定义失败: ${entityName}.def (未找到定义文件)`
        );
        return;
      }

      try {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(definitionPath));
        await vscode.window.showTextDocument(document);
      } catch (error) {
        vscode.window.showWarningMessage(
          `打开实体定义失败: ${entityName}.def (${error})`
        );
      }
    }
  );
  context.subscriptions.push(openEntityCommand);

  const openEntityMethodCommand = vscode.commands.registerCommand(
    'kbengine.entity.method.open',
    async (
      identityOrEntityName: DefinitionSymbolIdentity | string,
      methodName?: string,
      section?: EntityMethodSection
    ) => {
      // 空目标早退必须先于 label 拼接:原实现先读 identityOrEntityName.ownerName,
      // 无参调用(命令面板)会在守卫前抛 TypeError——装配测试锁定的真实缺陷
      if (!identityOrEntityName) {
        return;
      }

      const label = typeof identityOrEntityName === 'string'
        ? `${identityOrEntityName}.${methodName || ''} (${section || ''})`
        : `${identityOrEntityName.ownerName}.${identityOrEntityName.symbolName} (${identityOrEntityName.section || ''})`;

      try {
        const didOpen = typeof identityOrEntityName === 'string'
          ? await entityMappingManager.openMethodTarget(identityOrEntityName, methodName, section)
          : await entityMappingManager.openMethodTarget(identityOrEntityName);
        // 不可达(批71 定性):该 if 的隐式 else 臂(v8-to-istanbul 记为 arm#1
        // armLoc=undefined)为负数伪影。真实行为由既有用例锁定:
        // - "method.open 成功侧静默"(extension.test.ts)与
        // - extensionBranches.test.ts 两文件 4 个用例分别以字符串/identity
        // 形态调用并断言无 warning,即 didOpen=true 走隐式 else。
        // v8 对无显式 else 块的 if 语句,隐式 else 计数器不随执行增量
        // (见 TESTING.md 批71 段),属工具链已知缺陷,不反映真实可达性。
        /* istanbul ignore start */
        if (!didOpen) {
        /* istanbul ignore stop */
          vscode.window.showWarningMessage(
            `打开实体方法失败: ${label}`
          );
        }
      } catch (error) {
        vscode.window.showWarningMessage(
          `打开实体方法失败: ${label} (${error})`
        );
      }
    }
  );
  context.subscriptions.push(openEntityMethodCommand);

  const openDatabaseSchemaCommand = vscode.commands.registerCommand(
    'kbengine.database.open',
    async (entityName?: string, tableName?: string, fieldName?: string) => {
      // 命令面板无参直开时取活动 .def 推断实体,与 simulate 同口径;仍无实体
      // 如实提示——此前命令体直接 return,面板点了毫无反应,数据库表结构入口
      // 找不到(Entities 视图的数据库条目是唯一可达路径)
      const resolvedEntityName = entityName ?? resolveActiveDefEntityName();
      if (!resolvedEntityName) {
        vscode.window.showInformationMessage('请先打开一个实体 .def 文件');
        return;
      }

      try {
        const uri = createDatabaseSchemaUri(resolvedEntityName);
        const document = await vscode.workspace.openTextDocument(uri);
        // IDE-SCH-010:优先用「屏上这一代」渲染定位(展示与跳转同源,await 期间
        // def/配置变更不撕裂行号);未发布过才退独立快照口径
        const publishedSnapshot = databaseSchemaProvider.getPublishedSnapshot(uri);
        const line = publishedSnapshot !== undefined
          ? databaseSchemaProvider.locateInPublishedContent(
              uri,
              tableName || resolveEntityTableName(resolvedEntityName, publishedSnapshot),
              fieldName
            ) ?? 1
          : (() => {
              const snapshot = getDatabaseSchemaSnapshot(resolvedEntityName);
              return snapshot
                ? locateDatabaseSchemaLine(snapshot, tableName || resolveEntityTableName(resolvedEntityName, snapshot), fieldName)
                : 1;
            })();
        const position = new vscode.Position(Math.max(line - 1, 0), 0);
        const selection = new vscode.Range(position, position);
        await vscode.window.showTextDocument(document, { selection });
      } catch (error) {
        vscode.window.showWarningMessage(
          `打开数据库结构失败: ${resolvedEntityName}${tableName ? ` (${tableName}${fieldName ? `.${fieldName}` : ''})` : ''} (${error})`
        );
      }
    }
  );
  context.subscriptions.push(openDatabaseSchemaCommand);

  // 活动编辑器的 .def 路径给出实体名;非 .def 返回 undefined(批122)
  function resolveActiveDefEntityName(): string | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'kbengine-def') {
      return undefined;
    }
    return path.basename(editor.document.uri.fsPath, '.def');
  }

  // 数据库模拟(批122):活动 .def 为实体打开模拟文档;无活动 .def 如实提示,
  // 不静默空转
  const simulateDatabaseCommand = vscode.commands.registerCommand(
    'kbengine.database.simulate',
    async (entityName?: string) => {
      const resolvedEntityName = entityName ?? resolveActiveDefEntityName();
      if (!resolvedEntityName) {
        vscode.window.showInformationMessage('请先打开一个实体 .def 文件');
        return;
      }
      try {
        const uri = createDatabaseSimulationUri(resolvedEntityName);
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
      } catch (error) {
        vscode.window.showWarningMessage(`打开数据库模拟失败: ${resolvedEntityName} (${error})`);
      }
    }
  );
  context.subscriptions.push(simulateDatabaseCommand);

  // 数据库模拟导出(批122):当前模拟文档全文经 showSaveDialog 落盘;取消直接
  // 返回,写出失败进错误通道不裸抛
  const exportDatabaseSimulationCommand = vscode.commands.registerCommand(
    'kbengine.database.exportSimulation',
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !isDatabaseSimulationDocument(editor.document)) {
        vscode.window.showWarningMessage('请先打开数据库模拟文档');
        return;
      }
      const defaultUri = vscode.Uri.file(
        `${getSimulationEntityName(editor.document.uri)}-simulation.md`
      );
      const target = await vscode.window.showSaveDialog({
        defaultUri,
        filters: { Markdown: ['md'] }
      });
      if (!target) {
        return;
      }
      try {
        await vscode.workspace.fs.writeFile(target, Buffer.from(editor.document.getText(), 'utf8'));
      } catch (error) {
        vscode.window.showErrorMessage(`导出数据库模拟失败: ${error}`);
      }
    }
  );
  context.subscriptions.push(exportDatabaseSimulationCommand);

  // 数据库漂移校验(批C):用真实表结构反向校验 def 推导的虚拟表结构——
  // 属性→字段映射算错时唯一会暴露的地方。连接要素读引擎配置,不新增配置项;
  // 语句白名单 + 只读会话双保险;连不上降级为「未校验」不报错
  const databaseDriftChannel = vscode.window.createOutputChannel(DATABASE_DRIFT_CHANNEL_NAME);
  context.subscriptions.push(databaseDriftChannel);
  const checkDatabaseDriftCommand = vscode.commands.registerCommand(
    'kbengine.database.checkDrift',
    async (entityName?: string) => {
      const resolvedEntityName = entityName ?? resolveActiveDefEntityName();
      if (!resolvedEntityName) {
        vscode.window.showInformationMessage('请先打开一个实体 .def 文件');
        return;
      }
      const snapshot = getDatabaseSchemaSnapshot(resolvedEntityName);
      if (!snapshot) {
        vscode.window.showWarningMessage(`读取实体定义失败: ${resolvedEntityName}(未找到 .def 文件)`);
        return;
      }
      const database = resolveDatabaseInterfaceConfig();
      if (!database) {
        vscode.window.showInformationMessage(
          '数据库漂移未校验:读不到引擎数据库配置(检查 kbengine.binPath / assetsRoot)'
        );
        return;
      }
      const report = await checkDatabaseDrift(
        snapshot,
        database,
        resolveSchemaTablePrefix(),
        createMysqlDriftExecutor
      );
      publishDriftReport(databaseDriftChannel, vscode.window, report);
    }
  );
  context.subscriptions.push(checkDatabaseDriftCommand);

  const checkAllDatabaseDriftCommand = vscode.commands.registerCommand(
    'kbengine.database.checkAllDrift',
    async () => {
      const folders = vscode.workspace.workspaceFolders ?? [];
      const snapshots = folders.flatMap(folder =>
        getRegisteredEntities(folder.uri.fsPath)
          .map(entity => getDatabaseSchemaSnapshot(entity.name, folder.uri.fsPath))
          .filter((snapshot): snapshot is NonNullable<typeof snapshot> => snapshot !== null)
      );
      if (snapshots.length === 0) {
        vscode.window.showInformationMessage('数据库漂移未校验:工作区没有可检查的实体定义');
        return;
      }
      const database = resolveDatabaseInterfaceConfig();
      if (!database) {
        vscode.window.showInformationMessage(
          '数据库漂移未校验:读不到引擎数据库配置(检查 kbengine.binPath / assetsRoot)'
        );
        return;
      }
      const report = await checkDatabaseDriftForSnapshots(
        snapshots, database, resolveSchemaTablePrefix(), createMysqlDriftExecutor
      );
      publishDriftReport(databaseDriftChannel, vscode.window, report);
    }
  );
  context.subscriptions.push(checkAllDatabaseDriftCommand);

  // 初始化服务器管理器
  const serverManager = new KBEngineServerManager(context);
  setDefaultScriptRuntime(serverManager.processManager, serverManager.logHub);

  // telnet 探测与联动(工单:telnet 探测+联动):目标解析 设置 →
  // kbengine.xml <telnet_service>(未指定路径时按 configPath/约定路径探测)
  // → 引擎 kbengine_defaults.xml(批112 用户令);配置未开 telnet → 空目标;
  // 5s 低频探测
  const telnetService = new TelnetService({
    getTargets: () => {
      const targets = readTelnetTargetsFromSettings();
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
          `${serverKey} ${DEBUG_PHASE_LABELS.attached}:${names}(Run and Debug 视图已打开,调用堆栈可见该会话)`
        );
        return;
      }
      if (row.phase === 'listening') {
        void vscode.window.showInformationMessage(
          `${serverKey} ${DEBUG_PHASE_LABELS.listening}中(debugpy ${row.port ?? '?'}):用 launch.json 里对应的 attach 配置附加`
        );
        return;
      }
      if (row.phase === 'failed') {
        void vscode.window.showErrorMessage(
          `${serverKey} 注入失败:${row.detail ?? '(无细节)'}——处理后在 Debug Targets 视图确认,或重启组件重试`
        );
        return;
      }
      void vscode.window.showInformationMessage(
        `${serverKey} ${DEBUG_PHASE_LABELS['not-injected']}:开启 kbengine.debug.autoDebugpy(启动联动注入)或 kbengine.debug.waitAtStartup(启动等待)并重启组件`
      );
    }
  );
  context.subscriptions.push(focusDebugTargetCommand);

  // IDE-TSK-001 构建任务描述预览:活动 profile → 脚本编译检查任务的
  // command/args/cwd/env 四要素逐字预览(所见即所跑;TSK-002 起任务
  // 列表按同一描述注册)。无活动 profile 如实提示去选。
  const previewBuildTaskCommand = vscode.commands.registerCommand(
    'kbengine.build.previewTask',
    () => {
      const profile = resolveActiveProfile(context.workspaceState);
      if (!profile) {
        void vscode.window.showInformationMessage(
          '尚未选择活动 profile:先在 Profiles 里选一套 assets/engine 组合,再预览构建任务'
        );
        return;
      }
      void vscode.window.showInformationMessage(
        formatBuildTaskPreview(buildScriptCheckTaskSpec(profile)),
        { modal: true }
      );
    }
  );
  context.subscriptions.push(previewBuildTaskCommand);

  // IDE-TSK-002 构建 TaskProvider:任务列表(Run Task → kode 源)逐
  // profile 出构建项,resolveTask 反解 tasks.json 手写条目;执行走
  // ProcessExecution——取消/终止由 VS Code 任务系统原生杀进程树
  const buildTaskProvider = new KbengineBuildTaskProvider({
    getProfiles: () => new ProjectProfileStore(context.workspaceState).list()
  });
  context.subscriptions.push(
    vscode.tasks.registerTaskProvider(BUILD_TASK_TYPE, buildTaskProvider)
  );

  // IDE-TSK-004 发现项目声明的 Python 测试:只扫所选 profile 的 scripts
  // 根(test_*.py / *_test.py 递归),工作区里其他资产根与引擎仓(依赖
  // 库)结构性不进清单;QuickPick 列文件,选中打开源文件
  const listPythonTestsCommand = vscode.commands.registerCommand(
    'kbengine.tests.list',
    () => {
      const profile = resolveActiveProfile(context.workspaceState);
      if (!profile) {
        void vscode.window.showInformationMessage(
          '尚未选择活动 profile:先在 Profiles 里选一套 assets/engine 组合,再列出 Python 测试'
        );
        return;
      }
      showPythonTestList(profile, {
        pick: items =>
          Promise.resolve(
            vscode.window.showQuickPick(items, {
              placeHolder: `${items.length} 个测试文件(范围:所选 profile 的 scripts 根)`
            })
          ),
        open: absolutePath => {
          void vscode.window.showTextDocument(vscode.Uri.file(absolutePath));
        },
        notify: message => {
          void vscode.window.showInformationMessage(message);
        }
      });
      // 列表面也是发现面:顺手刷新测试面板树(profile 或文件变了之后
      // 跑一次命令即同步;refreshHandler 是 1.64 仍 proposed 的面,不用)
      refreshPythonTestItems();
    }
  );
  context.subscriptions.push(listPythonTestsCommand);

  // IDE-SDK-001/002 单实体 messageTable:预览(markdown 查看)与 JSON 导
  // 出共用同一构建面——def 取源与索引扫描同一 scanRoots/loader 公式;
  // 缺声明(构建 null)两条命令同样明确提示,不展示空预览不写空文件
  const buildEntityMessageTable = (entityName: string) => {
    const loader = createDefinitionSemanticsLoader(getIndexScanRoots());
    if (!loader) {
      return null;
    }
    const source: DefTreeSource = {
      loadDef: (name, kind) => loader.loadLocal(name, kind)
    };
    return buildMessageTable(entityName, source);
  };
  const entityMessageTableDeps = {
    listEntityNames: () => entityMappingManager.getAllMappings().map(mapping => mapping.name),
    pick: (items: string[]) =>
      Promise.resolve(
        vscode.window.showQuickPick(items, {
          placeHolder: `${items.length} 个实体(选择实体的 messageTable)`
        })
      ),
    notifyWarning: (message: string) => {
      void vscode.window.showWarningMessage(message);
    },
    notifyInformation: (message: string) => {
      void vscode.window.showInformationMessage(message);
    }
  };
  const previewMessageTableCommand = vscode.commands.registerCommand(
    'kbengine.messagetable.preview',
    async () => {
      await entityMappingManager.waitForInitialScan();
      await showEntityMessageTablePreview({
        ...entityMessageTableDeps,
        buildTableMarkdown: entityName => {
          const table = buildEntityMessageTable(entityName);
          return table === null ? null : renderMessageTableMarkdown(table);
        },
        show: async markdown => {
          const document = await vscode.workspace.openTextDocument({
            content: markdown,
            language: 'markdown'
          });
          await vscode.window.showTextDocument(document, { preview: true });
        }
      });
    }
  );
  context.subscriptions.push(previewMessageTableCommand);

  // IDE-SDK-002 消息表 JSON 导出:renderMessageTableJson 现有面(保留
  // 方法段/utype/alias 配置/问题清单);保存对话框取消不创建文件
  const exportMessageTableCommand = vscode.commands.registerCommand(
    'kbengine.messagetable.export',
    async () => {
      await entityMappingManager.waitForInitialScan();
      await exportEntityMessageTable({
        ...entityMessageTableDeps,
        buildTableJson: entityName => {
          const table = buildEntityMessageTable(entityName);
          return table === null ? null : renderMessageTableJson(table);
        },
        chooseSavePath: defaultFileName =>
          Promise.resolve(
            vscode.window.showSaveDialog({
              defaultUri: vscode.Uri.file(defaultFileName),
              filters: { JSON: ['json'] }
            })
          ).then(uri => uri?.fsPath),
        writeFile: async (savePath, content) => {
          await vscode.workspace.fs.writeFile(
            vscode.Uri.file(savePath),
            new TextEncoder().encode(content)
          );
        }
      });
    }
  );
  context.subscriptions.push(exportMessageTableCommand);

  // IDE-TSK-005 测试面板:TSK-004 发现面落成 TestController 树(文件→
  // 用例,用例条目 range=发现时的行号列号——通过失败即与源码位置对应);
  // Run 档逐条目 <解释器> -m pytest(取消=下一跳发起前拦截,验收:取消
  // 不继续执行下一测试);无活动 profile 树清空。测试 API 面=基准
  // (1.59+)+appendOutput(1.61),engines 相应 ^1.61.0。
  const testController = vscode.tests.createTestController('kbengine-python-tests', 'KBEngine Python 测试');
  const testRunTargets = new Map<string, { file: string; caseName?: string; item: vscode.TestItem }>();
  const refreshPythonTestItems = (): void => {
    testController.items.replace([]);
    testRunTargets.clear();
    const profile = resolveActiveProfile(context.workspaceState);
    if (!profile) {
      return;
    }
    const result = discoverProjectPythonTests(profile);
    // TSK-006:发现面同时重新捕获任务上下文(换根唯一显式入口)
    void context.workspaceState.update(TEST_TASK_CONTEXT_STORAGE_KEY, JSON.stringify(captureTaskRunContext(profile)));
    for (const file of result.files) {
      const absolutePath = path.join(result.scriptsRoot, file.relativePath);
      const fileItem = testController.createTestItem(
        file.relativePath,
        file.relativePath,
        vscode.Uri.file(absolutePath)
      );
      testRunTargets.set(file.relativePath, { file: absolutePath, item: fileItem });
      for (const testCase of file.cases) {
        const caseId = `${file.relativePath}::${testCase.className ? `${testCase.className}.` : ''}${testCase.name}`;
        const item = testController.createTestItem(caseId, testCase.name, vscode.Uri.file(absolutePath));
        item.range = new vscode.Range(
          testCase.line - 1,
          testCase.column,
          testCase.line - 1,
          testCase.column + testCase.name.length
        );
        fileItem.children.add(item);
        testRunTargets.set(caseId, {
          file: absolutePath,
          caseName: testCase.className ? `${testCase.className}::${testCase.name}` : testCase.name,
          item
        });
      }
      testController.items.add(fileItem);
    }
  };
  refreshPythonTestItems();
  testController.createRunProfile(
    '运行',
    vscode.TestRunProfileKind.Run,
    async (request, token) => {
      // TSK-006:重跑钉住 workspaceState 里保存的任务上下文(首跑捕获,
      // kbengine.tests.list 重新捕获);活动 profile 漂移只提示不换根
      const pinnedJson = context.workspaceState.get<string>(TEST_TASK_CONTEXT_STORAGE_KEY);
      const prepared = prepareTestRun(resolveActiveProfile(context.workspaceState), pinnedJson, {
        exists: candidate => fs.existsSync(candidate)
      });
      if (prepared.outcome === 'refuse') {
        void vscode.window.showWarningMessage(prepared.message);
        return;
      }
      const runContext = prepared.context;
      if (pinnedJson === undefined) {
        // 首跑:把捕获的上下文存下,之后的重跑都钉住它
        void context.workspaceState.update(TEST_TASK_CONTEXT_STORAGE_KEY, JSON.stringify(runContext));
      }
      if (prepared.notes.length > 0) {
        void vscode.window.showInformationMessage(prepared.notes.join(';'));
      }
      const interpreterPath = runContext.interpreterPath ?? 'python3';
      // 请求条目:include 空=全部;文件条目展开成逐用例(单测试执行语义)
      const targets: Array<{ id: string; file: string; caseName?: string }> = [];
      const pushTarget = (item: vscode.TestItem): void => {
        const target = testRunTargets.get(item.id);
        if (target) {
          targets.push({ id: item.id, file: target.file, caseName: target.caseName });
        }
        item.children.forEach(child => pushTarget(child));
      };
      if (request.include && request.include.length > 0) {
        request.include.forEach(item => pushTarget(item));
      } else {
        testController.items.forEach(item => pushTarget(item));
      }
      if (targets.length === 0) {
        return;
      }
      const run = testController.createTestRun(request);
      let cancelled = false;
      token.onCancellationRequested(() => {
        cancelled = true;
      });
      const entries = await runPythonTests(
        {
          interpreterPath,
          cwd: taskContextScriptsRoot(runContext),
          items: targets
        },
        { exec: spawnTestProcess, isCancelled: () => cancelled }
      );
      const entriesById = new Map(entries.map(entry => [entry.id, entry]));
      for (const target of targets) {
        const registered = testRunTargets.get(target.id);
        if (!registered) {
          continue;
        }
        const entry = entriesById.get(target.id);
        if (!entry) {
          // 取消未跑:面板如实标跳过,不冒充通过
          run.skipped(registered.item);
          continue;
        }
        run.appendOutput(entry.output, undefined, registered.item);
        if (entry.outcome === 'passed') {
          run.passed(registered.item);
        } else if (entry.outcome === 'skipped') {
          run.skipped(registered.item);
        } else {
          run.failed(registered.item, new vscode.TestMessage(entry.message ?? entry.outcome));
        }
      }
      run.end();
    },
    true
  );
  context.subscriptions.push(testController);

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

  // HTTP 快捷请求(批105):OUTPUT 流水 + 列表 quick pick + 具名运行
  // (实际快捷键经「键盘快捷方式」为本命令配 args.name 绑定)
  const quickActionManagerRef: { current?: QuickActionManager } = {};
  const httpRequestChannel = vscode.window.createOutputChannel('KBEngine HTTP 快捷请求');
  const httpRequestService = new HttpRequestService({
    getEntries: () =>
      parseHttpRequestEntries(vscode.workspace.getConfiguration('kbengine').get('httpRequests')),
    log: line => httpRequestChannel.appendLine(line),
    notifyError: message => {
      void vscode.window.showErrorMessage(message);
    },
    getTemplateContext: () => {
      const editor = vscode.window.activeTextEditor;
      return {
        filePath: editor?.document.uri.fsPath,
        cursorLineZeroBased: editor?.selection.active.line,
        selection: editor ? editor.document.getText(editor.selection) : undefined,
        workspaceRoots: (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath)
      };
    },
    // ${module} 包边界探针:目录含 __init__.py 才算包段(base/cell 等
    // 角色目录无 __init__.py 即不算模块,批153 用户令)
    isPackageDir: dirPath => fs.existsSync(path.join(dirPath, '__init__.py'))
  });
  const runHttpQuickPickCommand = vscode.commands.registerCommand(
    'kbengine.httpRequests.run',
    async () => {
      const combined = quickActionManagerRef.current
        ? (await quickActionManagerRef.current.getTreeData()).httpRequests
        : [];
      const entries = combined;
      const configuredEntries = parseHttpRequestEntries(vscode.workspace.getConfiguration('kbengine').get('httpRequests'));
      if (entries.length === 0) {
        void vscode.window.showInformationMessage(
          '没有已启用的 HTTP 快捷请求(可配置于 .kbengine/debug.json 或设置 kbengine.httpRequests)'
        );
        return;
      }
      const picked = await vscode.window.showQuickPick(
        entries.map(entry => ({
          label: entry.name,
          description: `${entry.method} ${entry.target}`,
          detail: `${entry.requestSource === 'settings' ? '来源：kbengine.httpRequests 设置' : '来源：.kbengine/debug.json'}${entry.requestSource === 'settings' && configuredEntries[entry.requestIndex]?.keybinding ? ` · 键位: ${configuredEntries[entry.requestIndex].keybinding}` : ''}`,
          entry
        })),
        { placeHolder: '选择要运行的 HTTP 快捷请求' }
      );
      if (picked) {
        await quickActionManagerRef.current?.runByName(`@http:${picked.entry.requestSource}:${picked.entry.requestIndex}`);
      }
    }
  );
  const runNamedHttpCommand = vscode.commands.registerCommand(
    'kbengine.httpRequest.run',
    async (args?: { name?: string }) => {
      const name = args?.name;
      if (!name) {
        void vscode.window.showWarningMessage(
          'kbengine.httpRequest.run 需要 args.name(在键盘快捷方式里以 args 传入);或改用 kbengine.httpRequests.run 从合并列表选择'
        );
        return;
      }
      const manager = quickActionManagerRef.current;
      if (manager) {
        const entry = (await manager.getTreeData()).httpRequests.find(item => item.name === name);
        if (entry) await manager.runByName(`@http:${entry.requestSource}:${entry.requestIndex}`);
        else await httpRequestService.runByName(name);
      }
    }
  );
  context.subscriptions.push(httpRequestChannel, runHttpQuickPickCommand, runNamedHttpCommand);

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

  const showLogsCommand = vscode.commands.registerCommand(
    'kbengine.server.showLogs',
    (target) => {
      const component = resolveServerComponent(target);
      if (!component) {
        return;
      }

      logViewer.show();
    }
  );
  context.subscriptions.push(showLogsCommand);

  // 初始化日志收集器
  const kbengineConfig = vscode.workspace.getConfiguration('kbengine');
  const logAutoConnect = kbengineConfig.get<boolean>('logAutoConnect', true);
  const logConfig: LogCollectorConfig = {
    host: '127.0.0.1',
    port: kbengineConfig.get<number>('loggerPort', 20022),
    autoReconnect: true,
    reconnectInterval: 5000,
    maxBufferSize: kbengineConfig.get<number>('maxLogEntries', 10000)
  };

  const logCollector = new KBEngineLogCollector(logConfig, context);

  if (logAutoConnect) {
    void logCollector.connect().catch(() => {
      // logger 可能尚未启动，collector 内部会继续按配置重连
    });
  }

  // 初始化日志查看器
  const logViewer = new LogViewerWebView(context, logCollector);
  const logHub = serverManager.logHub;
  // 悬停/异步层预算闸的 LogHub 接线(2026-10-22):超时与耗时记账走同一
  // LogHub,真机在日志查看器过滤 [kode-hover] 即可定位慢层/超时层
  setHoverBudgetLogHub(logHub);

  // PR1:语言服务指标接线——LogHub 时间线(详细记录开启时逐样本 [kode-lsm]),
  // 详细开关默认关(kbengine.metrics.detailed);命令面板 kbengine.metrics.showSummary
  // 输出聚合汇总(P50/P95/P99/命中率/计数)。
  setLanguageServiceMetricsLogHub(logHub);
  setDetailedRecordingEnabled(kbengineConfig.get<boolean>('metrics.detailed', false));
  const metricsChannel = vscode.window.createOutputChannel('Kode Language Service Metrics');
  context.subscriptions.push(metricsChannel);
  context.subscriptions.push(vscode.commands.registerCommand('kbengine.metrics.showSummary', () => {
    metricsChannel.clear();
    metricsChannel.append(getLanguageServiceSummaryReport());
    metricsChannel.append(getEventLoopDelayReport());
    metricsChannel.append(getHostVitalsReport());
    metricsChannel.show();
  }));
  // IDE-MET-007:卡顿取证入口——start 开采/stop 落盘(.cpuprofile+.window.txt
  // 关联请求窗口);globalStorage 不可用时回落系统临时目录。
  if (context.globalStoragePath) {
    setCpuProfileDirectory(context.globalStoragePath);
  }
  context.subscriptions.push(vscode.commands.registerCommand('kbengine.metrics.startCpuProfile', async () => {
    if (await startCpuProfile()) {
      vscode.window.showInformationMessage('Kode: CPU profile started');
    } else {
      vscode.window.showWarningMessage('Kode: CPU profile is already running');
    }
  }));
  context.subscriptions.push(vscode.commands.registerCommand('kbengine.metrics.stopCpuProfile', async () => {
    const result = await stopCpuProfile();
    if (result) {
      vscode.window.showInformationMessage(`Kode: CPU profile saved: ${result.profilePath}`);
    } else {
      vscode.window.showWarningMessage('Kode: no CPU profile is running');
    }
  }));
  // IDE-MET-008:取消前后活动任务从账面对账,不拿空返回值推断工作已停止
  context.subscriptions.push(vscode.commands.registerCommand('kbengine.metrics.showActiveTasks', () => {
    metricsChannel.clear();
    metricsChannel.append(renderActiveTasksReport({
      operationCounts: getActiveOperationCounts(),
      scheduler: getDiagnosticScheduler().pendingWorkload()
    }));
    metricsChannel.show();
  }));
  // IDE-MET-005/006:宿主事件循环延迟与 CPU/RSS 自激活即采样(showSummary 面)
  startEventLoopDelayMonitor();
  startHostVitalsMonitor();
  context.subscriptions.push({
    dispose: () => {
      stopEventLoopDelayMonitor();
      stopHostVitalsMonitor();
    }
  });
  // IDE-MET-004:读盘明细开关(默认关=只累计计数,明细环形缓冲不启用)
  setFileReadVerbose(kbengineConfig.get<boolean>('metrics.fileReadDetail', false));
  logViewer.subscribeLogHub(logHub);

  const enableWebviewConsoleLogs = kbengineConfig.get<boolean>('webviewConsoleLogs', true);
  if (enableWebviewConsoleLogs) {
    logViewer.attachLogHub(logHub);
  }

  // 注册日志相关命令
  const showLogViewerCommand = vscode.commands.registerCommand(
    'kbengine.logs.showViewer',
    () => logViewer.show()
  );
  context.subscriptions.push(showLogViewerCommand);

  const connectLoggerCommand = vscode.commands.registerCommand(
    'kbengine.logs.connect',
    async () => {
      vscode.window.showWarningMessage(
        KBEngineLogCollector.PROTOCOL_WARNING
      );
      try {
        await logCollector.connect();
      } catch (error) {
        vscode.window.showErrorMessage(`连接日志收集器失败: ${error}`);
      }
    }
  );
  context.subscriptions.push(connectLoggerCommand);

  const disconnectLoggerCommand = vscode.commands.registerCommand(
    'kbengine.logs.disconnect',
    () => logCollector.disconnect()
  );
  context.subscriptions.push(disconnectLoggerCommand);

  const clearLogsCommand = vscode.commands.registerCommand(
    'kbengine.logs.clear',
    () => logViewer.clearLogs()
  );
  context.subscriptions.push(clearLogsCommand);

  const exportLogsCommand = vscode.commands.registerCommand(
    'kbengine.logs.export',
    () => logViewer.exportLogs()
  );
  context.subscriptions.push(exportLogsCommand);

  // 原始日志 ERROR 扫描(盘点 G6):离线聚合日志文件里的 ERROR/CRITICAL 行;
  // 重扫按上一批文件重跑,不再弹对话框
  const logErrorScanView = new LogErrorScanView(context, previous =>
    scanRawLogErrors(
      previous.files.map(file => file.uri),
      realLogErrorScanDeps
    )
  );
  const scanRawLogErrorsCommand = vscode.commands.registerCommand(
    'kbengine.logs.scanErrors',
    () => runLogErrorScanCommand(logErrorScanView)
  );
  context.subscriptions.push(scanRawLogErrorsCommand);

  // 初始化调试配置管理器
  const debugConfigManager = new DebugConfigManager(context);

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

  // 最终服务端配置合成(批112 用户令:defaults 先载、元件 kbengine.xml 覆盖)。
  // 默认开启令:激活即出(后台预览不抢焦点)、侧栏常驻节点、文件保存联动刷新,
  // 命令入口保留不删。
  const finalConfigProvider = new FinalConfigContentProvider();
  const finalConfigContentProvider = vscode.workspace.registerTextDocumentContentProvider(
    KBE_CONFIG_SCHEME,
    finalConfigProvider
  );
  context.subscriptions.push(finalConfigContentProvider);

  // 打开合成视图。auto = 激活自动路径:定位失败静默跳过不弹错、后台标签;
  // 手动命令 = 明示报错、正常聚焦打开。
  const openFinalConfig = async (auto: boolean): Promise<void> => {
    if (buildFinalServerConfig().text.length === 0) {
      if (!auto) {
        vscode.window.showErrorMessage(
          '无法定位引擎默认配置 kbengine_defaults.xml(请检查 kbengine.binPath 是否指向引擎的 kbe/bin/server)'
        );
      }
      return;
    }
    const uri = vscode.Uri.parse(`${KBE_CONFIG_SCHEME}:${KBE_CONFIG_VIRTUAL_PATH}`);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(
      document,
      auto ? { preview: true, preserveFocus: true } : undefined
    );
  };

  // types.xml 落盘后自动重生成类型桩(§4 二期):静默、零写纪律兜底,
  // stubExport 关掉时导出函数自门,watcher 实际停摆。挂在终配 watcher
  // 之前:activate 期 watcher 创建次序是既有探针测试的隐含契约
  setupTypeStubRegeneration(context);

  const showFinalConfigCommand = vscode.commands.registerCommand(
    'kbengine.config.showFinal',
    () => openFinalConfig(false)
  );
  context.subscriptions.push(showFinalConfigCommand);

  // 侧栏常驻入口:始终可见可回,不随配置门控
  const finalConfigTreeRegistration = vscode.window.registerTreeDataProvider(
    'kbengine.config',
    new FinalConfigTreeProvider()
  );
  context.subscriptions.push(finalConfigTreeRegistration);

  // 变更联动:defaults / 元件 kbengine.xml 保存或增删后重算已打开的合成文档
  if (
    vscode.workspace.getConfiguration('kbengine').get<boolean>('autoRefreshFinalConfig', true)
  ) {
    const finalConfigWatcher = vscode.workspace.createFileSystemWatcher('**/kbengine*.xml');
    // kbengine*.xml 增删改同时影响数据库连接读值(批131):失效缓存再联动
    finalConfigWatcher.onDidChange(() => {
      resetDatabaseInterfaceConfigCache();
      finalConfigProvider.refresh();
    });
    finalConfigWatcher.onDidCreate(() => {
      resetDatabaseInterfaceConfigCache();
      finalConfigProvider.refresh();
    });
    finalConfigWatcher.onDidDelete(() => {
      resetDatabaseInterfaceConfigCache();
      finalConfigProvider.refresh();
    });
    context.subscriptions.push(finalConfigWatcher);
  }

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

  const compatibilityChannel = vscode.window.createOutputChannel('KBEngine Compatibility');
  const compatibilityTarget: ExtensionCompatibilityTarget = {
    displayName: 'Kode KBEngine',
    engines: '^1.84.0',
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
    const report = checkExtensionCompatibility(context.extensionUri.fsPath, engineRoot, compatibilityTarget);
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
  const dependencyWebView = new EntityDependencyWebView(context, outputChannel);

  // 注册依赖关系相关命令
  const showDependencyCommand = vscode.commands.registerCommand(
    'kbengine.dependency.show',
    () => dependencyWebView.show()
  );
  context.subscriptions.push(showDependencyCommand);

  // 实体架构流程图(批124):客户端到 base/cell 的方法调用与属性自动同步,
  // 边语义按 Flags 位带引擎出处。实体名缺省取活动 .def 编辑器。
  const flowWebView = new EntityFlowWebView(context);
  const showEntityFlowCommand = vscode.commands.registerCommand(
    'kbengine.flow.show',
    (entityName?: string) => flowWebView.show(entityName)
  );
  context.subscriptions.push(showEntityFlowCommand);

  // 快速执行动作(批126):动作清单由 .kbengine/debug.json 的 quickActions 驱动,
  // 独立树视图逐行执行;Servers 与编辑器标题栏保留清单入口。
  // 首装扫一层 .bat/.ps1 的提示在激活末跑一次(不 await,不挡激活)。
  // 批136:保留 runDefault 命令,供命令面板一键跑上次执行的动作。
  const quickActionManager = new QuickActionManager(context, {
    getSettingHttpEntries: () => parseHttpRequestEntries(vscode.workspace.getConfiguration('kbengine').get('httpRequests')),
    runHttpEntry: entry => httpRequestService.runEntry(entry)
  });
  quickActionManagerRef.current = quickActionManager;
  const quickActionTreeProvider = new QuickActionTreeProvider({
    getActions: () => quickActionManager.getTreeData()
  });
  context.subscriptions.push(vscode.window.registerTreeDataProvider('kbengine.quickActions', quickActionTreeProvider));
  const runQuickActionByNameCommand = vscode.commands.registerCommand(
    'kbengine.quickActions.runByName',
    (name: string) => quickActionManager.runByName(name)
  );
  context.subscriptions.push(runQuickActionByNameCommand);
  const showQuickActionsCommand = vscode.commands.registerCommand('kbengine.quickActions.show', () =>
    quickActionManager.show()
  );
  context.subscriptions.push(showQuickActionsCommand);
  const rescanQuickActionScriptsCommand = vscode.commands.registerCommand(
    'kbengine.quickActions.scanScripts',
    async () => {
      await quickActionManager.scanScriptsAndRefresh();
      quickActionTreeProvider.refresh();
    }
  );
  context.subscriptions.push(rescanQuickActionScriptsCommand);
  const runDefaultQuickActionCommand = vscode.commands.registerCommand(
    'kbengine.quickActions.runDefault',
    () => quickActionManager.runDefault()
  );
  context.subscriptions.push(runDefaultQuickActionCommand);

  // 自动热重载(盘点 G5):文件保存/监视 → 按名触发 quick action。门控默认关
  // 防误触;无人值守通道跳过确认框,找不到名字只落 OUTPUT 流水不弹窗。
  setupHotReload(context, actionName =>
    quickActionManager.runByName(actionName, { suppressConfirm: true })
  );

  // 临时编辑热重载 quick action(书 §19 HR-PR-02):先临时编辑 → 可选自动
  // 还原 → reloadScript → 结果回显。开关默认关(与 kbengine.hotReload.enabled
  // 同口径);reloadScript 不另起第二套 HTTP,复用既有 quick action 通道
  // (HTTP 与终端两条腿都从 quickActionManager.runByName 走);回显走
  // 「KBEngine HTTP 快捷请求」OUTPUT 通道 + 独立问题通道(诊断集,成功清除)。
  // 铁律:accepted≠applied——通道回执再好也只报「已发送(未确认)」,
  // 绝不显示「已热更新」。
  const tempEditDiagnostics = vscode.languages.createDiagnosticCollection(
    'KBEngine 临时编辑热更新'
  );
  context.subscriptions.push(tempEditDiagnostics);
  const runTempEditReloadCommand = vscode.commands.registerCommand(
    'kbengine.hotReload.tempEdit.run',
    async () => {
      const settings = readTempEditReloadSettings(
        tempEditSectionReader(
          vscode.workspace.getConfiguration('kbengine').get<unknown>('hotReload', undefined)
        )
      );
      if (!settings.enabled) {
        void vscode.window.showWarningMessage(
          '临时编辑热更新已停用(默认关);确认风险后在设置 kbengine.hotReload.tempEdit.enabled 开启'
        );
        return;
      }
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showInformationMessage('临时编辑热更新需要活动编辑器中的文件');
        return;
      }
      const targetDoc = { fsPath: editor.document.uri.fsPath, label: path.basename(editor.document.uri.fsPath) };
      const decoder = new TextDecoder();
      const result = await runTempEditReload(targetDoc, settings, {
        readFile: async doc =>
          decoder.decode(await vscode.workspace.fs.readFile(vscode.Uri.file(doc.fsPath))),
        writeFile: async (doc, content) => {
          await vscode.workspace.fs.writeFile(
            vscode.Uri.file(doc.fsPath),
            new TextEncoder().encode(content)
          );
        },
        // 无人值守口径:跳过确认框,也不污染「上次执行」记忆
        runReloadAction: name =>
          quickActionManager.runByName(name, { suppressConfirm: true, skipLastRun: true }),
        log: line => httpRequestChannel.appendLine(`[临时编辑热更新] ${line}`),
        reportProblem: (doc, message) => {
          if (message === null) {
            tempEditDiagnostics.delete(editor.document.uri);
            return;
          }
          tempEditDiagnostics.set(editor.document.uri, [
            new vscode.Diagnostic(
              new vscode.Range(0, 0, 0, 1),
              `临时编辑热更新: ${message}`,
              vscode.DiagnosticSeverity.Error
            )
          ]);
        }
      });
      if (result.phase === 'sent-unverified') {
        void vscode.window.showInformationMessage(
          `临时编辑热更新:已发送(未确认)。引擎是否 applied 未知,详见输出通道「KBEngine HTTP 快捷请求」。`
        );
      } else if (result.phase !== 'missing-action') {
        void vscode.window.showErrorMessage(`临时编辑热更新失败: ${result.detail}`);
      }
    }
  );
  context.subscriptions.push(runTempEditReloadCommand);

  // Python 生态接线(盘点 G1/G2):先导出 .kbengine/stubs/KBEngine.pyi
  // (符号索引发射,盘点 G2),再同步 python.analysis.extraPaths(scripts 根
  // + 存根目录,盘点 G1)——顺序保证首次激活存根就进得了 extraPaths。
  // 激活期全程零提示不打扰开窗;命令面板留手动重跑入口(存根导出命令
  // 导出后链一次同步,新目录即刻生效)。
  const syncPythonExtraPathsCommand = vscode.commands.registerCommand(
    'kbengine.python.syncExtraPaths',
    () => syncPythonExtraPaths(context)
  );
  context.subscriptions.push(syncPythonExtraPathsCommand);
  // debug.json 的 jsonc 关联(用户令 2026-10-27 ②):激活期静默接线一次,
  // 命令面板只留关闭入口(回收托管键 + 翻开关;重新启用=设回 true 重载)
  const jsoncAssociationOffCommand = vscode.commands.registerCommand(
    'kbengine.jsoncAssociation.off',
    () => disableJsoncAssociation(context)
  );
  context.subscriptions.push(jsoncAssociationOffCommand);
  const exportKbeStubsCommand = vscode.commands.registerCommand(
    'kbengine.python.exportStubs',
    async () => {
      await exportKbeStubs();
      await syncPythonExtraPaths(context);
    }
  );
  context.subscriptions.push(exportKbeStubsCommand);
  // types.xml 自定义类型桩(docs/design/def-pyi-stubs.md §6):kbe_types.pyi 分件与
  // KBEngine.pyi 同开关同目录,命令导出后同样链一次同步让新目录即刻生效
  const exportPythonTypeStubsCommand = vscode.commands.registerCommand(
    'kbengine.python.exportTypeStubs',
    async () => {
      await exportPythonTypeStubs();
      await syncPythonExtraPaths(context);
    }
  );
  context.subscriptions.push(exportPythonTypeStubsCommand);
  const generatedEntitySourceLensProviderImpl = new GeneratedSourceCodeLensProvider(
    'entity_types.pyi',
    [],
    buildEntityTypeStubPlan(
      entityMappingManager.getAllMappings(),
      getCustomTypeInfos(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '')
    ).entries
  );
  const generatedEntitySourceLensProvider = vscode.languages.registerCodeLensProvider(
    pythonDocumentSelector,
    generatedEntitySourceLensProviderImpl
  );
  context.subscriptions.push(generatedEntitySourceLensProvider);
  void (async () => {
    await exportKbeStubs(fileSystemStubExportDeps, { silent: true });
    await exportPythonTypeStubs(fileSystemStubExportDeps, { silent: true });
    await exportEntityTypeStubs(entityMappingManager);
    await syncPythonExtraPaths(context, fileSystemScriptRootDeps, { silent: true });
    await syncJsoncAssociation(context, { silent: true });
  })();
  // 批143(用户单 kode-debug-json.md):`.kbengine/debug.json` 缺失即生成带注释
  // 的骨架,并按脚本扫描填 quickActions。放在首装扫描之前——骨架里已经有动作
  // 时,首装扫描不再重复问用户。生效工作目录与来源落 OUTPUT 通道。
  const debugConfigChannel = vscode.window.createOutputChannel(DEBUG_CONFIG_CHANNEL_NAME);
  context.subscriptions.push(debugConfigChannel);
  const bootstrap = ensureDebugConfig(
    { ...fileSystemBootstrapDeps, log: (line: string): void => debugConfigChannel.appendLine(line) },
    {
      workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map(folder => ({
        name: folder.name,
        fsPath: folder.uri.fsPath
      })),
      scanRoots: (vscode.workspace.workspaceFolders ?? []).slice(0, 1)
        .map(folder => resolveAssetsRootForWorkspace(folder.uri.fsPath))
        .filter((root): root is string => root.length > 0),
      managedDirName: resolveManagedDirName(readManagedDirSetting()).name
    }
  );
  // 托管目录自动重建(任务 B,用户令 2026-10-21):.kbengine(kbengine.managedDir
  // 可配)目录被删后不需重载窗口,下一次相关事件即重建全链——KBEngine.pyi /
  // kbe_types.pyi / entity_types.pyi / debug.json 全部内容比对零写或缺失即生成,
  // 重复触发无副作用。watcher 盯托管目录自身与其内部,删除目录也能收到事件。
  const bootstrapOptions = () => ({
    workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map(folder => ({
      name: folder.name,
      fsPath: folder.uri.fsPath
    })),
    scanRoots: (vscode.workspace.workspaceFolders ?? []).slice(0, 1)
      .map(folder => resolveAssetsRootForWorkspace(folder.uri.fsPath))
      .filter((root): root is string => root.length > 0),
    managedDirName: resolveManagedDirName(readManagedDirSetting()).name
  });
  const regenerateManagedDirAssets = (): void => {
    void exportKbeStubs(fileSystemStubExportDeps, { silent: true });
    void exportPythonTypeStubs(fileSystemStubExportDeps, { silent: true });
    void exportEntityTypeStubs(entityMappingManager);
    ensureDebugConfig(
      { ...fileSystemBootstrapDeps, log: (line: string): void => debugConfigChannel.appendLine(line) },
      bootstrapOptions()
    );
  };
  const createManagedDirWatcher = (): vscode.FileSystemWatcher => {
    const name = resolveManagedDirName(readManagedDirSetting()).name;
    // `**/<dir>`(目录本体被删)+ `**/<dir>/**`(内部文件增删改)两个 pattern 都盯
    const watchers = [`**/${name}`, `**/${name}/**`].map(pattern =>
      vscode.workspace.createFileSystemWatcher(pattern)
    );
    for (const watcher of watchers) {
      watcher.onDidChange(regenerateManagedDirAssets);
      watcher.onDidCreate(regenerateManagedDirAssets);
      watcher.onDidDelete(regenerateManagedDirAssets);
      context.subscriptions.push(watcher);
    }
    return { dispose: (): void => watchers.forEach(watcher => watcher.dispose()) } as vscode.FileSystemWatcher;
  };
  let managedDirWatcher = createManagedDirWatcher();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(event => {
      if (!event.affectsConfiguration('kbengine.managedDir')) {
        return;
      }
      managedDirWatcher.dispose();
      managedDirWatcher = createManagedDirWatcher();
      regenerateManagedDirAssets();
    })
  );
  // 存根内容面开关变更即时重导(用户令 2026-10-21:配置开关变更即时生效):
  // 关掉引擎 typings 全量/实体方法面后,下次激活前先把已生成的 .pyi 收回
  // 到关掉后的内容(总闸 kbengine.python.stubExport 关时导出函数自门,零写)
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(event => {
      if (
        event.affectsConfiguration('kbengine.python.stubEngineTypings') ||
        event.affectsConfiguration('kbengine.python.entityStubMethods')
      ) {
        regenerateManagedDirAssets();
      }
    })
  );
  const firstWorkspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  const assetsRoot = firstWorkspaceRoot ? resolveAssetsRootForWorkspace(firstWorkspaceRoot) : '';
  quickActionManager.setConfigurationRoots(
    bootstrap.workspaceRoot,
    assetsRoot ? [assetsRoot] : []
  );
  // 首装扫描要读写 workspaceState(取消记忆);宿主没给(嵌入/烟测替身)就不扫
  if (context.workspaceState) {
    void quickActionManager.offerScanOnActivate();
  }

  // 初始化代码生成器
  const codeGenerator = new KBEngineCodeGenerator(context);

  // 注册代码生成器相关命令
  const showGeneratorWizardCommand = vscode.commands.registerCommand(
    'kbengine.generator.wizard',
    () => codeGenerator.showWizard()
  );
  context.subscriptions.push(showGeneratorWizardCommand);

  const showTemplatesCommand = vscode.commands.registerCommand(
    'kbengine.generator.templates',
    () => codeGenerator.showTemplates()
  );
  context.subscriptions.push(showTemplatesCommand);

  // 定义形态生成(盘点 G7):代理/空间/组件/固定字典四种形态的向导,实体向导之外
  // 的定义面(此前只能手写)。已代决按「先出骨架 + 引擎装载口径附带改写」落地
  const showGeneratorFormWizardCommand = vscode.commands.registerCommand(
    'kbengine.generator.formWizard',
    () => runGeneratorFormWizard({ workspaceState: context.workspaceState })
  );
  context.subscriptions.push(showGeneratorFormWizardCommand);

  // 现有 KBEngine 项目导入(IDE-PRJ-003):选资产根→按约定链识别
  // entities/defs/scripts/engine 四面→预览确认→建立项目 profile(稳定身份存储)
  const importProjectCommand = vscode.commands.registerCommand(
    'kbengine.project.import',
    () => importExistingProject(context)
  );
  context.subscriptions.push(importProjectCommand);

  // 最小项目创建(IDE-PRJ-008):模板清单落盘建空项目,冲突拒绝/预览确认/
  // 失败回收全程走生成器保护,成功后与导入同链建档
  const createProjectCommand = vscode.commands.registerCommand(
    'kbengine.project.create',
    () => createMinimalProject(context)
  );
  context.subscriptions.push(createProjectCommand);

  // 活动 profile 选择(IDE-PRJ-010):稳定 ID 持久化,真实切换恰发一次事件
  const selectActiveProfileCommand = vscode.commands.registerCommand(
    'kbengine.project.selectActive',
    () => selectActiveProfile(context)
  );
  context.subscriptions.push(selectActiveProfileCommand);

  // 语言索引响应 profile 切换(IDE-PRJ-011):活动 profile 的资产根成为索引
  // 输入(优先于 assetsRoot 设置/自动发现,见 scanRoots);切换时旧外部根先
  // 定向摘除(SNP-009 口径),generation 前进使旧输入的在途扫描批次经代闸
  // 不再写入当前快照(entityMapping.performScanEntityMappings),Python 索引
  // 面整组重建
  const applyActiveProfileToIndexInput = (): void => {
    const profile = resolveActiveProfile(context.workspaceState);
    for (const oldRoot of getExternalScanRoots()) {
      entityMappingManager.removeRoot(oldRoot);
    }
    bumpRootConfigGeneration('profile-switch');
    setActiveProfileScanRoot(profile && profile.assetsRoot ? profile.assetsRoot : null);
    resetScanRootCache();
    pythonClassIndex.invalidate();
    watchPythonIndex();
    entityMappingManager.refreshExternalRootWatchers();
    if (isPythonMroJumpEnabled()) { pythonClassIndex.scheduleBackgroundScan(); }
  };
  context.subscriptions.push(onDidChangeActiveProfile(() => { applyActiveProfileToIndexInput(); }));
  // 激活期:持久化的选择先落到索引输入(此后首扫按选定根起步;此刻零索引
  // 面,不需要切换路径的摘除/失效序列,也不 bump)
  const startupProfile = resolveActiveProfile(context.workspaceState);
  setActiveProfileScanRoot(startupProfile && startupProfile.assetsRoot ? startupProfile.assetsRoot : null);

  // 客户端实体 SDK 生成(盘点 G4):按 entities.xml 登记实体生成客户端语言骨架,
  // 语言清单在命令内选(已代决首批 TS + C#)。IDE-SDK-003 生成绑定活动
  // profile:注册序与类型数据取所选 profile 资产根(getRegisteredEntities/
  // getCustomTypeInfos 同一解析面),其他扫描根的同名实体经绑定模块拒收
  // 点名(不静默覆盖);无活动 profile 回落工作区首根(旧口径)。
  const clientSdkGenerateCommand = vscode.commands.registerCommand(
    'kbengine.clientSdk.generate',
    async () => {
      const profile = resolveActiveProfile(context.workspaceState);
      const profileRoot = profile?.assetsRoot || undefined;
      // IDE-SDK-004 引擎溯源:探测面=readEngineApiMetadata(版本宏+git),
      // 引擎根有 profile 记录时优先用,探测不到模块内写 unknown。
      const generationRoot = profileRoot
        ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
        ?? '';
      const engineMetadata = await readEngineApiMetadata(
        generationRoot,
        profile ? { engineRoot: profile.engineRoot || undefined } : {}
      );
      const engineTrace = makeSdkEngineTrace(engineMetadata);
      if (!profileRoot) {
        return runClientSdkGenerateCommand(undefined, undefined, engineTrace);
      }
      const binding = bindSdkGenerationToProfile(profileRoot, {
        listRegistrations: root => getRegisteredEntities(root),
        readTypesXml: root => {
          const layout = getDefinitionWorkspaceLayout(root);
          return layout.typesXmlPath ? readWorkspaceTextFile(layout.typesXmlPath) : null;
        },
        listOtherRootEntityNames: root => {
          const names = new Set<string>();
          for (const otherRoot of getIndexScanRoots()) {
            if (otherRoot === root) {
              continue;
            }
            for (const info of getRegisteredEntities(otherRoot)) {
              names.add(info.name);
            }
          }
          return [...names];
        }
      });
      return runClientSdkGenerateCommand(profileRoot, binding.skippedSameNameFromOtherRoots, engineTrace);
    }
  );
  context.subscriptions.push(clientSdkGenerateCommand);

  // .def 静态分析建议(性能分析):扫描工作区全部 .def,报告写入输出面板
  // 并以诊断形式落到问题列表
  const defAnalysisOutputChannel = vscode.window.createOutputChannel('KBEngine Def 分析');
  const defAnalysisDiagnostics = vscode.languages.createDiagnosticCollection(
    'kbengine-def-analysis'
  );
  const analyzeDefCommand = vscode.commands.registerCommand(
    'kbengine.def.analyze',
    async () => {
      const defUris = await findFilesAcrossRoots('**/*.def');
      if (defUris.length === 0) {
        vscode.window.showInformationMessage('未找到 .def 文件,无法分析');
        return;
      }

      defAnalysisOutputChannel.clear();
      defAnalysisDiagnostics.clear();
      // 每个 .def 只打开一次:文本缓存供单文件检查与继承链闭包(collectInheritedNames)共用
      const sortedUris = defUris.sort((a, b) => a.fsPath.localeCompare(b.fsPath));
      const openedDocuments = new Map<string, vscode.TextDocument>();
      const defTexts = new Map<string, string>();
      for (const uri of sortedUris) {
        const document = await vscode.workspace.openTextDocument(uri);
        openedDocuments.set(uri.fsPath, document);
        defTexts.set(path.resolve(uri.fsPath), document.getText());
      }
      const readDefText = (filePath: string): string | null =>
        defTexts.get(path.resolve(filePath)) ?? null;

      let totalFindings = 0;
      for (const uri of sortedUris) {
        const document = openedDocuments.get(uri.fsPath) as vscode.TextDocument;
        const findings = analyzeDefDocument(document.getText(), collectInheritedNames(uri.fsPath, readDefText));
        totalFindings += findings.length;
        defAnalysisOutputChannel.appendLine(
          formatDefAnalysisReport(uri.fsPath, findings)
        );
        defAnalysisDiagnostics.set(
          uri,
          findings.map(item => {
            const start = document.positionAt(item.offset);
            const end = document.positionAt(item.offset + item.length);
            return new vscode.Diagnostic(
              new vscode.Range(start, end),
              item.message,
              item.severity === 'error'
                ? vscode.DiagnosticSeverity.Error
                : item.severity === 'warning'
                  ? vscode.DiagnosticSeverity.Warning
                  : vscode.DiagnosticSeverity.Information
            );
          })
        );
      }

      defAnalysisOutputChannel.show();
      vscode.window.showInformationMessage(
        `Def 分析完成: ${defUris.length} 个文件, ${totalFindings} 条建议`
      );
    }
  );
  context.subscriptions.push(analyzeDefCommand);

  // Cross-file semantic doctor: reuses the same rename parser and engine
  // alignment as F2 so diagnostics and refactor decisions cannot diverge.
  const projectDoctorChannel = vscode.window.createOutputChannel('KBEngine Project Doctor');
  const projectDoctorCommand = vscode.commands.registerCommand(
    'kbengine.project.doctor',
    async () => {
      const targetUri = vscode.window.activeTextEditor?.document.uri;
      const candidateUri = targetUri?.fsPath.endsWith('.def')
        ? targetUri
        : (await findFilesAcrossRoots('**/*.def'))[0];
      if (!candidateUri) {
        vscode.window.showInformationMessage('未找到 .def 文件,无法运行 Project Doctor');
        return;
      }

      const graph = buildDefReferenceGraphFromFile(candidateUri.fsPath);
      if (!graph) {
        vscode.window.showWarningMessage('未找到 entity_defs 定义根,Project Doctor 仅支持标准定义布局');
        return;
      }

      const report = buildProjectDoctorReport(graph);
      projectDoctorChannel.clear();
      projectDoctorChannel.appendLine(formatProjectDoctorReport(report));
      projectDoctorChannel.show(true);
      if (report.errors.length > 0) {
        vscode.window.showWarningMessage(`Project Doctor 发现 ${report.errors.length} 项错误,详见输出面板`);
      } else if (report.warnings.length > 0) {
        vscode.window.showInformationMessage(`Project Doctor 完成:${report.warnings.length} 项警告`);
      } else {
        vscode.window.showInformationMessage('Project Doctor 完成:跨文件语义无错误');
      }
    }
  );
  context.subscriptions.push(projectDoctorCommand, projectDoctorChannel);

  const symbolReferencesChannel = vscode.window.createOutputChannel('KBEngine Symbol References');
  const symbolReferencesCommand = vscode.commands.registerCommand(
    'kbengine.symbolReferences.show',
    async () => {
      const targetUri = vscode.window.activeTextEditor?.document.uri;
      const candidateUri = targetUri?.fsPath.endsWith('.def')
        ? targetUri
        : (await findFilesAcrossRoots('**/*.def'))[0];
      if (!candidateUri) {
        vscode.window.showInformationMessage('未找到 .def 文件,无法生成符号引用图');
        return;
      }

      const graph = buildDefReferenceGraphFromFile(candidateUri.fsPath);
      if (!graph) {
        vscode.window.showWarningMessage('未找到 entity_defs 定义根,符号引用图仅支持标准定义布局');
        return;
      }

      const preview = formatDefReferenceGraphPreview(graph);
      symbolReferencesChannel.clear();
      symbolReferencesChannel.appendLine('Mermaid');
      symbolReferencesChannel.appendLine(preview.mermaid);
      symbolReferencesChannel.appendLine('\nText');
      symbolReferencesChannel.appendLine(preview.text);
      symbolReferencesChannel.show(true);
    }
  );
  context.subscriptions.push(symbolReferencesCommand, symbolReferencesChannel);
  context.subscriptions.push(defAnalysisOutputChannel);
  context.subscriptions.push(defAnalysisDiagnostics);

  // 自定义代码片段生成器:把选区文本做片段语法转义(\$ 与 \\)并去公共缩进
  // 为片段体,经名称/前缀/描述三步输入后合并写入工作区
  // .vscode/kbengine-custom.code-snippets;手改出注释/坏 JSON 的片段文件
  // 不静默改写,报错让用户先整理
  const generateSnippetCommand = vscode.commands.registerCommand(
    'kbengine.snippets.generateFromSelection',
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        vscode.window.showInformationMessage('请先在编辑器中选中要生成片段的文本');
        return;
      }

      const snippetName = await vscode.window.showInputBox({
        prompt: '输入代码片段名称',
        placeHolder: 'MyDefTemplate',
        validateInput: (value) => (!value || value.trim() === '' ? '片段名称不能为空' : null)
      });
      if (!snippetName) {
        return;
      }

      const prefix = await vscode.window.showInputBox({
        prompt: '输入触发前缀',
        placeHolder: `kbe-${snippetName.toLowerCase()}`,
        value: `kbe-${snippetName.toLowerCase()}`,
        validateInput: (value) => (!value || value.trim() === '' ? '触发前缀不能为空' : null)
      });
      if (!prefix) {
        return;
      }

      // 描述可选:取消(Esc)按仓库既有口径视为继续,记空串不写该字段
      const description = await vscode.window.showInputBox({
        prompt: '输入片段描述(可选)',
        value: ''
      }) ?? '';

      // tabSize 列语义参与去公共缩进:选区 tab/空格混用时字符数口径
      // 保不住相对层级(审计块18 遗留①);d.ts 声明 tabSize 为 string|number,
      // 非数字回落默认 4
      const editorTabSize = typeof editor.options.tabSize === 'number'
        ? editor.options.tabSize
        : 4;
      const body = selectionToSnippetBody(
        editor.document.getText(editor.selection),
        editorTabSize
      );
      if (body.length === 0) {
        vscode.window.showInformationMessage('选区不含有效文本,未生成片段');
        return;
      }

      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        vscode.window.showErrorMessage('没有打开的工作区,无法保存自定义片段');
        return;
      }

      const snippetsFilePath = joinWorkspacePath(
        workspaceFolder.uri.fsPath,
        CUSTOM_SNIPPETS_RELATIVE_PATH
      );
      // 读取/写入的底层 IO 失败(权限、路径被文件占位等)不裸抛给宿主,
      // 落到错误通道并给出片段文件路径
      let existingContent: string | null;
      try {
        existingContent = fs.existsSync(snippetsFilePath)
          ? fs.readFileSync(snippetsFilePath, 'utf8')
          : null;
      } catch (error) {
        vscode.window.showErrorMessage(
          `无法读取自定义片段文件: ${snippetsFilePath}(${(error as Error).message})`
        );
        return;
      }

      let merged: MergeSnippetResult;
      try {
        merged = mergeSnippetEntry(existingContent, snippetName, {
          prefix,
          body,
          description,
          scope: editor.document.languageId
        });
      } catch {
        vscode.window.showErrorMessage(
          `自定义片段文件不是合法的对象 JSON,请先手工整理后再生成: ${snippetsFilePath}`
        );
        return;
      }

      try {
        fs.mkdirSync(path.dirname(snippetsFilePath), { recursive: true });
        fs.writeFileSync(snippetsFilePath, merged.content, 'utf8');
      } catch (error) {
        vscode.window.showErrorMessage(
          `无法写入自定义片段文件: ${snippetsFilePath}(${(error as Error).message})`
        );
        return;
      }

      if (merged.overwritten) {
        vscode.window.showWarningMessage(
          `已覆盖同名自定义片段 ${snippetName}: ${snippetsFilePath}`
        );
      } else {
        vscode.window.showInformationMessage(
          `已生成自定义代码片段 ${snippetName}(前缀 ${prefix}): ${snippetsFilePath}`
        );
      }
    }
  );
  context.subscriptions.push(generateSnippetCommand);

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

  // 批125 自动发现:激活期盘点工作区锚点(entities.xml/entity_defs/types.xml/
  // kbe 源码根),多候选弹一次 quick pick 并记忆(workspaceState 回放,后续
  // 会话不再询问);单候选/零命中零打扰。显式配置永远优先于发现结果。
  // workspaceState 缺失(测试替身/嵌入场景)时静默跳过,不做磁盘级记忆。
  const primaryWorkspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  // 批127 发现与定位诊断:定位失败不再静默——报告摊开每个键的显式配置/
  // 约定链/深扫描/记忆选择与最终取用,写入输出通道供复制回传。
  const discoveryReportChannel = vscode.window.createOutputChannel('KBEngine 发现与定位');
  const writeDiscoveryReport = (workspaceRoot: string): number => {
    const config = vscode.workspace.getConfiguration('kbengine');
    const layout = getDefinitionWorkspaceLayout(workspaceRoot);
    const facts: DiscoveryLayoutFacts = {
      // 不可达(批64 定性):layout.entityDefsRoot 恒为非空字符串(见
      // definitionWorkspace.ts 同口径区间),空值臂无来源;保留守卫防布局
      // 契约变更时静默出错。
      /* istanbul ignore start */
      entityDefsRoot: layout.entityDefsRoot || '',
      /* istanbul ignore stop */
      entityScriptsRoot: layout.entityScriptsRoot,
      interfacesRoot: layout.interfacesRoot,
      componentsRoot: layout.componentsRoot,
      entitiesXmlPath: layout.entitiesXmlPath,
      typesXmlPath: layout.typesXmlPath,
      configPath: config.get<string>('assetsRoot', ''),
      // 生效资产根走管理器口径(原值探针命中优先,否则发现兜底,批128)
      configPathEffective: serverManager.getConfigPath(),
      binPathSetting: config.get<string>('binPath', ''),
      binPath: serverManager.getBinPath(),
      entityDefsPathSetting: config.get<string>('entityDefsPath', ''),
      entitiesXmlPathSetting: config.get<string>('entitiesXmlPath', ''),
      // types.xml 无独立配置项,布局内硬编码候选链,显式配置恒空
      typesXmlPathSetting: ''
    };
    const report = buildDiscoveryReport(workspaceRoot, facts);
    discoveryReportChannel.clear();
    discoveryReportChannel.appendLine(renderDiscoveryReport(report));
    return report.issues.length;
  };
  const discoveryReportCommand = vscode.commands.registerCommand(
    'kbengine.discovery.report',
    () => {
      if (!primaryWorkspaceRoot) {
        vscode.window.showWarningMessage('未打开工作区,无法生成发现与定位诊断');
        return;
      }
      const issueCount = writeDiscoveryReport(primaryWorkspaceRoot);
      discoveryReportChannel.show(true);
      if (issueCount > 0) {
        vscode.window.showWarningMessage(
          `发现与定位存在 ${issueCount} 项问题,详见「KBEngine 发现与定位」输出面板`
        );
      } else {
        vscode.window.showInformationMessage('发现与定位全部正常');
      }
    }
  );
  context.subscriptions.push(discoveryReportCommand, discoveryReportChannel);

  // IDE-MET-001:活动扩展身份报告——区分「安装目录存在」(文件系统核验)与
  // 「当前窗口已激活」(isActive),列宿主位置(remote(name)/local)与
  // 扩展宿主侧(workspace/ui);渲染纯函数在 extensionIdentity.ts。
  const identityChannel = vscode.window.createOutputChannel('Kode 扩展身份');
  const identityCommand = vscode.commands.registerCommand('kbengine.extension.identity', () => {
    const entries = vscode.extensions.all
      .filter(extension => extension.id.toLowerCase().startsWith('cuihairu.'))
      .map(extension => ({
        id: extension.id,
        version: String(extension.packageJSON?.version ?? 'unknown'),
        extensionPath: extension.extensionPath ?? '',
        installExists: Boolean(extension.extensionPath) && fs.existsSync(extension.extensionPath),
        isActive: extension.isActive,
        extensionKind: String(extension.extensionKind ?? 'unknown')
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
    identityChannel.clear();
    identityChannel.appendLine(renderExtensionIdentityReport(entries, {
      remoteName: vscode.env.remoteName,
      appName: vscode.env.appName
    }, readBuildCommit(context.extensionPath)));
    identityChannel.show(true);
  });
  context.subscriptions.push(identityCommand, identityChannel);

  // IDE-REL-001 两个 Kode ID 共激活检测:激活时查一次当前宿主窗口的
  // Kode 系扩展(cuihairu. 名下 id 含 kode),只有「实际共激活」(两个
  // 都 isActive)才提示冲突;已安装未激活/被禁用(禁用不进
  // extensions.all,采集面天然见不到)不算冲突,零虚报零打扰。
  const kodeFamilyFacts = vscode.extensions.all
    .filter(extension => {
      const id = extension.id.toLowerCase();
      return id.startsWith('cuihairu.') && id.includes('kode');
    })
    .map(extension => ({ id: extension.id, isActive: extension.isActive }));
  const dualActivationWarning = formatDualActivationWarning(detectDualActivation(kodeFamilyFacts));
  if (dualActivationWarning !== null) {
    void vscode.window.showWarningMessage(dualActivationWarning);
  }

  // IDE-REL-007 复现配置摘要:诊断排障时「环境长什么样」一页导出——活动
  // 版本(cuihairu. 名下 id@version+构建提交)/根(workspace/索引扫描根/
  // 活动 profile 双根)/宿主角色(local|remote + 扩展宿主侧)/开关(自身
  // package.json 里全部 kbengine.* 布尔项,自动随贡献面增长)/队列数据
  // (诊断排队/在途、注解、索引任务、schema 冷构建+语言服务在册操作)。
  // 连接信息取引擎 dbmgr 数据库接口配置,username/password 渲染层即遮蔽,
  // 全文再过 maskConnectionSecrets 兜底;渲染纯函数在 reproductionSummary.ts。
  const reproSummaryChannel = vscode.window.createOutputChannel('Kode 复现配置摘要');
  const reproSummaryCommand = vscode.commands.registerCommand(
    'kbengine.diagnostics.exportReproSummary',
    () => {
      const configuration = vscode.workspace.getConfiguration('kbengine');
      const contributed = JSON.parse(
        fs.readFileSync(path.join(context.extensionPath, 'package.json'), 'utf8')
      ) as { contributes?: { configuration?: { properties?: Record<string, { type?: string }> } } };
      const switchKeys = Object.entries(contributed.contributes?.configuration?.properties ?? {})
        .filter(([, schema]) => schema.type === 'boolean')
        .map(([key]) => key)
        .sort();
      const activeProfile = resolveActiveProfile(context.workspaceState);
      const database = resolveDatabaseInterfaceConfig();
      reproSummaryChannel.clear();
      reproSummaryChannel.appendLine(renderReproductionSummary({
        host: {
          label: hostLabel({ remoteName: vscode.env.remoteName, appName: vscode.env.appName }),
          side: sideLabel(String(context.extension.extensionKind ?? 'unknown'))
        },
        extensions: vscode.extensions.all
          .filter(extension => extension.id.toLowerCase().startsWith('cuihairu.'))
          .map(extension => ({
            id: extension.id,
            version: String(extension.packageJSON?.version ?? 'unknown'),
            active: extension.isActive,
            side: sideLabel(String(extension.extensionKind ?? 'unknown'))
          }))
          .sort((left, right) => left.id.localeCompare(right.id)),
        buildCommit: readBuildCommit(context.extensionPath),
        workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath),
        scanRoots: getIndexScanRoots(),
        profile: activeProfile
          ? {
              name: activeProfile.displayName,
              assetsRoot: activeProfile.assetsRoot,
              engineRoot: activeProfile.engineRoot
            }
          : null,
        switches: switchKeys.map(key => ({ key, on: Boolean(configuration.get<boolean>(key)) })),
        queue: {
          diagnosticsQueued: getDiagnosticScheduler().pendingWorkload().queued,
          diagnosticsInFlight: getDiagnosticScheduler().pendingWorkload().inFlight,
          annotationUpdates: getPendingDocumentUpdateCount(),
          indexTasksQueued: indexScheduler.getStatus().queued,
          schemaColdBuilds: getPendingTypeStorageColdBuildCount()
        },
        activeOperations: getActiveOperationCounts(),
        connections: database
          ? [{
              source: 'engine-dbmgr',
              host: database.host,
              port: database.port,
              username: database.username,
              databaseName: database.databaseName,
              encrypt: database.encrypt
            }]
          : []
      }));
      reproSummaryChannel.show(true);
    }
  );
  context.subscriptions.push(reproSummaryCommand, reproSummaryChannel);

  // Python 语言服务三态检查(IDE-PRJ-005):未安装/未启用/已激活,判定只看
  // 扩展事实(采集 collectPythonServiceFacts 与 profile 健康汇总同源);
  // extraPaths 写入只是配置面,附警示不参与可用判定
  const pythonServiceStatusCommand = vscode.commands.registerCommand('kbengine.python.serviceStatus', () => {
    const facts = collectPythonServiceFacts();
    vscode.window.showInformationMessage(
      renderPythonServiceMessage(classifyPythonService(facts), facts)
    );
  });
  context.subscriptions.push(pythonServiceStatusCommand);

  // profile 健康状态汇总(IDE-PRJ-009):缺引擎/缺解释器/缺语言服务/根歧义
  // 各带定位入口,活动 profile 经稳定 ID 解析(IDE-PRJ-010)
  const profileHealthCommand = vscode.commands.registerCommand(
    'kbengine.profile.health',
    () => showProfileHealthSummary(context)
  );
  context.subscriptions.push(profileHealthCommand);

  // 激活期发现完成后自动落一份报告;有问题时提示用户到输出面板看/复制回传
  const discoveryRoot = primaryWorkspaceRoot;
  if (discoveryRoot && context.workspaceState) {
    const workspaceState = context.workspaceState;
    const discoveryStateKey = `kbengine.discovery.${discoveryRoot}`;
    const discoveryDeps: DiscoveryPromptDeps = {
      showQuickPick: (items, title) =>
        vscode.window.showQuickPick(items, { placeHolder: title, ignoreFocusOut: true }),
      recall: () =>
        workspaceState.get<Partial<Record<DiscoveryKey, string>>>(discoveryStateKey),
      remember: (_root, choices) =>
        void workspaceState.update(discoveryStateKey, choices)
    };
    void runWorkspaceDiscovery(discoveryDeps, discoveryRoot).then(() => {
      const issueCount = writeDiscoveryReport(discoveryRoot);
      if (issueCount > 0) {
        vscode.window.showWarningMessage(
          `发现与定位存在 ${issueCount} 项问题,详见「KBEngine 发现与定位」输出面板`
        );
      }
    });
  }

  // 默认开启令:激活即出最终配置视图(后台标签,不抢焦点);定位不到
  // defaults(未配 binPath 或引擎目录不在)静默跳过,不弹错
  if (
    vscode.workspace.getConfiguration('kbengine').get<boolean>('showFinalConfigOnOpen', true)
  ) {
    void openFinalConfig(true);
  }

  // 清理资源
  context.subscriptions.push({
    dispose: async () => {
      telnetService.dispose();
      telnetWebView.dispose();
      serverManager.dispose();
      await serverManager.dispose();
      logHub.dispose();
      logCollector.dispose();
      logViewer.dispose();
      debugConfigManager.dispose();
      monitoringWebView.dispose();
      monitoringCollector.dispose();
      entityMappingManager.dispose();
      dependencyWebView.dispose();
      flowWebView.dispose();
      codeGenerator.dispose();
      outputChannel.dispose();
    }
  });

  // P0-4b/4c 审核重开(2026-10-28)验收面:激活返回值即现场探针 API——
  // ①probeHover:请求级 hover 取消路径,走与注册 provider 同一 KBEngineHoverProvider
  //   实例,调用方 token 经 cancelAfterMs 定时取消(真实请求级取消语义,不再以
  //   突发响应性近似);②pendingWork:残留任务量规,聚合诊断排队/在途、编辑路径
  //   去抖注解、索引任务、schema 冷构建四个后台面的在途计数。经
  //   vscode.extensions.getExtension(...).exports 消费,不进命令面板不改注册行为。
  const previewOf = (item: unknown): string => {
    if (item === null || item === undefined) { return ''; }
    if (typeof item === 'string') { return item; }
    const value = (item as { value?: unknown }).value;
    return value === undefined ? String(item) : String(value);
  };
  return {
    probeHover: async (
      target: { file: string; line: number; character: number },
      cancelAfterMs?: number,
      preCancel?: boolean
    ) => {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target.file));
      const canceller = new vscode.CancellationTokenSource();
      let cancelled = false;
      if (preCancel) {
        // 预取消面:请求带着已取消 token 进入 provider(用户快速输入/失焦时
        // VS Code 递给 provider 的真实语义)——入口守卫应零工作直接返回空。
        cancelled = true;
        canceller.cancel();
      }
      const timer = cancelAfterMs === undefined ? undefined : setTimeout(() => {
        cancelled = true;
        canceller.cancel();
      }, cancelAfterMs);
      const startedAt = Date.now();
      try {
        const hover = await kbengineHoverImpl.provideHover(
          document,
          new vscode.Position(target.line, target.character),
          canceller.token
        );
        return {
          elapsedMs: Date.now() - startedAt,
          cancelled,
          returnedHover: hover !== null && hover !== undefined,
          preview: previewOf(hover?.contents?.[0]).slice(0, 120)
        };
      } finally {
        if (timer !== undefined) { clearTimeout(timer); }
        canceller.dispose();
      }
    },
    pendingWork: () => ({
      diagnosticsQueued: diagnosticScheduler.pendingWorkload().queued,
      diagnosticsInFlight: diagnosticScheduler.pendingWorkload().inFlight,
      annotationUpdates: getPendingDocumentUpdateCount(),
      indexTasksQueued: indexScheduler.getStatus().queued,
      schemaColdBuilds: getPendingTypeStorageColdBuildCount()
    })
  };
}

export function deactivate() {
  disposePythonParserWorker();
  // PR2:停用即释放全部文档快照(进程回收前不留缓冲区副本)
  releaseAllDocumentSnapshots();
  console.log('KBEngine Language Extension is now deactivated!');
}
