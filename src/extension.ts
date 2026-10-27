import { findFilesAcrossRoots, getExternalScanRoots, resetScanRootCache, resolveAssetsRootForWorkspace } from './scanRoots';
import { bumpRootConfigGeneration } from './rootConfigGeneration';
import { createRootRemovalNotifier } from './rootRemovalEvents';
import { createSharedFileEventMerger } from './sharedFileEvents';
import { disposePythonParserWorker } from './pythonParserWorkerHost';
import { setJumpLogEnabled } from './navigationLog';
import {
  RECEIVER_NONE_DIAGNOSTICS_ENABLED_DEFAULT,
  receiverNoneDiagnosticItems,
  type ReceiverDiagnosticItem
} from './receiverNoneDiagnostics';
import { createLinkedCancellationToken, HOVER_ASYNC_BUDGET_MS_DEFAULT, raceWithBudget, setHoverBudgetLogHub } from './hoverBudget';
import {
  getLanguageServiceSummaryReport,
  setDetailedRecordingEnabled,
  setLanguageServiceMetricsLogHub,
  startLanguageServiceOperation
} from './languageServiceMetrics';
import type { OperationStatus } from './languageServiceMetrics';
import {
  releaseAllDocumentSnapshots,
  releaseDocument,
  updateDocumentSnapshot
} from './documentStore';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { KBEngineServerManager, SERVER_COMPONENTS } from './serverManager';
import { injectDebugpyAfterStart, syncDebugpyPackage } from './autoDebugpy';
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
  removeSavedFileAnnotations,
  renameSavedFileAnnotations,
  releaseDocumentReturnAnnotations,
  updateDocumentReturnAnnotations
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
  KBEngineCompletionProvider,
  EventCodeLensProvider,
  KBEngineDefinitionProvider,
  KBEngineHoverProvider,
  KBEngineBuiltinTypeInlayHintsProvider,
  KBEngineRenameProvider,
  KBEngineSignatureHelpProvider,
  KBENGINE_SOURCE_REVEAL_COMMAND,
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
import { IndexScheduler } from './indexScheduler';
import { shouldStartKbEngineIndexing } from './workspaceGate';
import { preheatDiscoveryScan } from './workspaceDiscovery';
import { getDiagnosticScheduler } from './diagnosticScheduler';
import {
  createDatabaseSchemaUri,
  getDatabaseSchemaSnapshot,
  KBEngineDatabaseSchemaProvider,
  locateDatabaseSchemaLine,
  resolveEntityTableName,
  resolveSchemaTablePrefix
} from './databaseSchema';
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
import { findEntityDefinitionFile, getDefinitionWorkspaceLayout, getRegisteredEntities } from './definitionWorkspace';
import { analyzeDefDocument, collectInheritedNames, formatDefAnalysisReport } from './defAnalyzer';
import { joinWorkspacePath } from './workspacePath';
import {
  CUSTOM_SNIPPETS_RELATIVE_PATH,
  mergeSnippetEntry,
  selectionToSnippetBody
} from './snippetGenerator';
import type { MergeSnippetResult } from './snippetGenerator';
import { buildEngineApiCatalog } from './engineApiMetadata';
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
    const options = {
      layer: 'local' as const,
      compute: () => {
        const enabled = vscode.workspace.getConfiguration('kbengine')
          .get<boolean>('receiverNoneDiagnostics', RECEIVER_NONE_DIAGNOSTICS_ENABLED_DEFAULT);
        return receiverNoneDiagnosticItems(
          document.getText(),
          document.uri.fsPath,
          isPythonDocument(document)
            ? entityMappingManager.getMappingForPythonFile(document.uri.fsPath)
            : undefined,
          enabled
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
          const result = await kbengineHoverImpl.provideHover(document, position, token);
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
  const sharedWorkspaceIndex = new WorkspaceIndex();
  const eventCodeLensProviderImpl = new EventCodeLensProvider(sharedWorkspaceIndex);
  const eventCodeLensProvider = vscode.languages.registerCodeLensProvider(
    pythonDocumentSelector,
    eventCodeLensProviderImpl
  );
  context.subscriptions.push(eventCodeLensProvider, eventCodeLensProviderImpl);
  context.subscriptions.push(sharedWorkspaceIndex);

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

  // 注册重命名提供者(.def 属性/方法 F2 重命名,引用面见 defRenamer 头注)
  const renameProvider = vscode.languages.registerRenameProvider(
    defDocumentSelector,
    new KBEngineRenameProvider()
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
      // IDE-HOV-011:未保存的返回注解变化按文档版本立即进入该文件桶
      if (isPythonDocument(event.document)) {
        updateDocumentReturnAnnotations(getWorkspaceRootForDocument(event.document), {
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
          diagnosticScheduler.flushQueued();
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
        const snapshot = getDatabaseSchemaSnapshot(resolvedEntityName);
        const line = snapshot
          ? locateDatabaseSchemaLine(snapshot, tableName || resolveEntityTableName(resolvedEntityName, snapshot), fieldName)
          : 1;
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
  const serverStatusSubscription = serverManager.onDidChangeStatus(() => {
    serverControlProvider.refresh();
    updateStatusBar(serverManager);
    const running = new Set(serverManager.getRunningServers().keys());
    for (const gone of [...debugpyInjected]) {
      if (!running.has(gone)) {
        debugpyInjected.delete(gone);
      }
    }
    for (const component of running) {
      if (debugpyInjected.has(component)) {
        continue;
      }
      debugpyInjected.add(component);
      void injectDebugpyAfterStart([component], () => telnetService.getTargets(), {
        log: (componentName, level, text) => {
          serverManager.logHub.ingest({
            source: 'process',
            component: componentName,
            level: level === 'error' ? RuntimeLogLevel.ERROR : level === 'warning' ? RuntimeLogLevel.WARNING : RuntimeLogLevel.INFO,
            text
          });
        }
      });
    }
  });
  context.subscriptions.push(serverStatusSubscription);

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
    metricsChannel.show();
  }));
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

  // 注册调试相关命令
  const updateLaunchJsonCommand = vscode.commands.registerCommand(
    'kbengine.debug.updateLaunchJson',
    async () => {
      await debugConfigManager.updateLaunchJson();
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
    () => runGeneratorFormWizard()
  );
  context.subscriptions.push(showGeneratorFormWizardCommand);

  // 客户端实体 SDK 生成(盘点 G4):按 entities.xml 登记实体生成客户端语言骨架,
  // 语言清单在命令内选(已代决首批 TS + C#)
  const clientSdkGenerateCommand = vscode.commands.registerCommand(
    'kbengine.clientSdk.generate',
    () => runClientSdkGenerateCommand()
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
}

export function deactivate() {
  disposePythonParserWorker();
  // PR2:停用即释放全部文档快照(进程回收前不留缓冲区副本)
  releaseAllDocumentSnapshots();
  console.log('KBEngine Language Extension is now deactivated!');
}
