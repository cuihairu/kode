import { findFilesAcrossRoots, getExternalScanRoots, resetScanRootCache } from './scanRoots';
import { execFile } from 'child_process';
import { bumpRootConfigGeneration } from './rootConfigGeneration';
import { disposePythonParserWorker, getPythonParserWorkerGauge } from './pythonParserWorkerHost';
import { disposeDefParserWorker } from './defParserWorkerHost';




import { resolveActiveProfile } from './activeProfile';
import { showProfileHealthSummary } from './profileHealth';
import { classifyPythonService, collectPythonServiceFacts, renderPythonServiceMessage } from './pythonLanguageServiceStatus';
import { setJumpLogEnabled } from './navigationLog';
import { setAnnotationSourceLogEnabled } from './annotationSourceLog';
import { activateInfrastructure } from './activate/infrastructure';
import { getActiveOperationCounts } from './languageServiceMetrics';
import { OperationStatus } from './languageServiceMetrics';
import { releaseAllDocumentSnapshots, releaseDocument, updateDocumentSnapshot } from './documentStore';
import * as vscode from 'vscode';
import { wireDefAnalysis } from './defAnalysisWiring';
import * as fs from 'fs';
import * as path from 'path';
import { BUILD_TASK_TYPE, buildScriptCheckTaskSpec, formatBuildTaskPreview } from './buildTaskSpec';
import { KbengineBuildTaskProvider } from './buildTaskProvider';
import { discoverProjectPythonTests, showPythonTestList } from './pythonTestDiscovery';
import {
  buildPythonTestSessionReport,
  describePythonTestExecIssue,
  runPythonTests,
  selectSessionFailures,
  spawnTestProcess,
} from './pythonTestRunner';
import {
  captureTaskRunContext,
  prepareTestRun,
  taskContextScriptsRoot,
  TEST_TASK_CONTEXT_STORAGE_KEY,
} from './taskContext';
import { showEntityMessageTablePreview } from './messageTablePreview';
import { exportEntityMessageTable } from './messageTableExport';
import { renderMessageTableJson, renderMessageTableMarkdown, type MessageTable } from './messageTable';
import { buildEntityMessageTableShared } from './messageTableEntity';
import { createDefinitionSemanticsLoader } from './definitionSemantics';
import { getIndexScanRoots } from './scanRoots';
import { readSharedFileSnapshot } from './sharedFileSnapshot';
import { ProjectProfileStore } from './projectProfiles';
import { wireDatabase } from './databaseWiring';
import { wireLogging } from './loggingWiring';
import {
  buildDefReferenceGraphFromFile,
  buildProjectDoctorReport,
  formatDefReferenceGraphPreview,
  formatProjectDoctorReport,
} from './defReferenceGraph';
import {
  LogErrorScanView,
  realLogErrorScanDeps,
  runLogErrorScanCommand,
  scanRawLogErrors,
} from './logErrorScan';
import { locateInterpreterOnPath, resolveInterpreterWith, resolveProfileInterpreter } from './profileInterpreter';
import {
  RUFF_MAX_FILES,
  runInstallRuffCommand,
  runRuffLintCommand,
  type RuffDiag,
} from './ruffLint';
import { scanVenvs, verifyVenvDirectory } from './venvDiscovery';
import {
  createVenvFlow,
  interpreterStatusBarText,
  probePythonVersion,
  runVenvModuleProcess,
  selectInterpreter,
} from './venvInterpreterPicker';
import { MonitoringWebView } from './monitoringWebView';
import { MonitoringCollector } from './monitoringCollector';
import { discoverLocalComponents, querySpaces, startProfileQuery } from './kbengineProtocol';
import { RuntimeQueryWebView } from './runtimeQueryWebView';
import { formatUnresolvedException, parseExceptionSourceLocation, resolveExceptionSource } from './exceptionSourceLocator';
import {
  findEngineRoot,
  formatEngineCompatibilityReport,
  runCompatibilityCheck,
  type ExtensionCompatibilityTarget,
} from './engineCompatibility';
import { activateCoreServices } from './activate/coreServices';
import { activateLanguageServices } from './activate/languageServices';
import { activateDiagnostics } from './activate/diagnostics';
import { activateServerControls } from './activate/serverControls';
import { activateEntityExplorerViews, activateFinalConfigTreeViews, activateFinalConfigViews, activateGitHistoryViews } from './activate/views';
import { activateHttpRequestViews, activateQuickActionTreeViews } from './activate/views';
import { activateHotReload } from './activate/hotReload';
import { activateGenerators } from './activate/generators';
export { setProcessTopologySchedulerForTests, getProcessTopologySchedulerForTests } from './activate/diagnostics';
import { EntityDependencyWebView } from './entityDependencyWebView';
import { EntityFlowWebView } from './entityFlowWebView';





import { normalizeVenvDirectoryNames } from './quickActionConfig';
import { registerRustFileChangeConsumer } from './fileChangeBypass';
import { shadowMirrorCorpusDocument, shadowReleaseCorpusDocument } from './kodeCoreShadowFaces';







import { getWorkspaceRootForDocument } from './definitionWorkspace';
import { getParsedDocumentCacheGauge } from './defParser';
import {
  applySavedFileAnnotations,
  getAnnotationBuildWorkload,
  getPendingDocumentUpdateCount,
  getReturnAnnotationCacheGauge,
  removeSavedFileAnnotations,
  renameSavedFileAnnotations,
  queueDocumentReturnAnnotations,
  releaseDocumentReturnAnnotations,
} from './pythonReturnTypeInference';

import {
  KBEngineTypeCodeActionProvider,
  KBEngineMethodImplementationCodeActionProvider,
  KBEngineDefPythonParityCodeActionProvider,
  KBEngineReceiverNoneGuardCodeActionProvider,
  prewarmKbengineIndex,
  isPythonMroJumpEnabled,
  setPythonMroJumpEnabled,
  setPythonDataDictIndexEnabled,
  setHoverInFlightGateForTests,
  setDefinitionInFlightGateForTests,
  setDefinitionDispatchGateForTests,
} from './languageProviders';
import { wireTrapLintDiagnostics } from './trapDiagnosticsWiring';
import { ConsoleHub } from './kbengineConsoleHub';
import { ConsoleLogTailController } from './consoleLogTail';
import { ComponentStatusTreeProvider, resolveThresholds } from './componentStatusPanel';
import { IndexTaskPriority } from './indexScheduler';
import { shouldStartKbEngineIndexing } from './workspaceGate';
import { getDiagnosticScheduler } from './diagnosticScheduler';
import { isTypeRegistryFile } from './semanticIndex';
import {
  invalidateDatabaseSchemaCacheForFiles,
  invalidateDatabaseSchemaCacheForTypeRegistry,
  getDatabaseSchemaCacheGauge,
  getPendingTypeStorageColdBuildCount,
} from './databaseSchema';
import { getDefinitionWorkspaceLayout } from './definitionWorkspace';
import { BackgroundWarmupController, WARMUP_SCAN_CONCURRENCY } from './backgroundWarmup';
import { createWarmupStages } from './warmupStages';
import { joinWorkspacePath } from './workspacePath';
import { CUSTOM_SNIPPETS_RELATIVE_PATH, mergeSnippetEntry, selectionToSnippetBody } from './snippetGenerator';
import { MergeSnippetResult } from './snippetGenerator';

import { sharedGitQueryGate } from './gitQueryGate';
import { isStartupScriptDocument } from './kbengineStartupScript';
import { buildMergedConfigTree, resetDatabaseInterfaceConfigCache, resolveDatabaseInterfaceConfig } from './serverConfigMerge';
import { ensureConfigResolved } from './serverConfigResolve';
import { DiscoveryKey, DiscoveryLayoutFacts, DiscoveryPromptDeps } from './workspaceDiscovery';
import { buildDiscoveryReport, renderDiscoveryReport, runWorkspaceDiscovery } from './workspaceDiscovery';
import { hostLabel, renderExtensionIdentityReport, sideLabel } from './extensionIdentity';
import { renderReproductionSummary } from './reproductionSummary';
import { detectDualActivation, formatDualActivationWarning } from './dualActivationConflict';
import { readBuildCommit } from './buildCommit';
import { getFileReadTotals } from './fileReadMetrics';
/**
 * Kode - KBEngine Development Environment
 * KBEngine VSCode 扩展主入口
 */

export function activate(context: vscode.ExtensionContext) {
  // SRC-001 L0 基础设施层(KODE-ARCH 纯移动):启动占位视图、引擎 API 目录、
  // 只读虚拟文档 provider、日志开关、kode core 门、文档选择器与文档形态谓词
  // 装配在 src/activate/infrastructure.ts,装配顺序由本调用点保持(activate
  // 最前),销毁句柄随返回值交组合根统一登记。
  const {
    disposables: infrastructureDisposables,
    kodeCoreGate,
    databaseSchemaProvider,
    databaseSimulationProvider,
    defDocumentSelector,
    definitionNavigationSelector,
    pythonDocumentSelector,
    getEngineApiCatalog,
    isDefDocument,
    isEntitiesXmlDocument,
    isPythonDocument,
    isProcessTopologyManifestDocument
  } = activateInfrastructure({ context });
  context.subscriptions.push(...infrastructureDisposables);

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


  let diagnosticFlushTimer: ReturnType<typeof setTimeout> | undefined;
  context.subscriptions.push({
    dispose: () => {
      if (diagnosticFlushTimer !== undefined) {
        clearTimeout(diagnosticFlushTimer);
        diagnosticFlushTimer = undefined;
      }
    }
  });

  // SRC-001 L1 共享核心服务层(KODE-ARCH 纯移动):indexScheduler/
  // entityMappingManager/dataDictIndex 装配在 src/activate/coreServices.ts,
  // 装配顺序由本调用点保持(先于诊断调度块与语言 provider 装配),销毁句柄
  // 随返回值交组合根统一登记。
  const {
    disposables: coreServicesDisposables,
    indexScheduler,
    entityMappingManager,
    dataDictIndex
  } = activateCoreServices({ context });
  context.subscriptions.push(...coreServicesDisposables);


  // SRC-001 L2 语言服务层(KODE-ARCH 纯移动):20+ 语言 provider 装配与
  // pythonClassIndex/watcher 机制装在 src/activate/languageServices.ts,
  // 装配顺序由本调用点保持(先于诊断 collection 与事件接线),注册面直推
  // context.subscriptions(销毁所有权不变),共享实例经返回值回组合根注入
  // 事件接线/命令/探针面。
  const {
    kbengineHoverImpl,
    pythonDefinitionImpl,
    pythonClassIndex,
    watchPythonIndex,
    fileChangeMetaResolver,
    callChainController,
    sharedWorkspaceIndex,
    rpcCodeLensProviderImpl,
    propertyCodeLensProviderImpl,
    eventCodeLensProviderImpl,
    typesXmlCodeLensProviderImpl
  } = activateLanguageServices({
    context,
    entityMappingManager,
    dataDictIndex,
    indexScheduler,
    getEngineApiCatalog,
    defDocumentSelector,
    definitionNavigationSelector,
    pythonDocumentSelector,
    emptyResultStatus
  });

  // Python 类索引编辑事件合并(IDE-SNP 线):三件状态被 didChange 事件面
  // 写值(+=/赋值),留组合根作用域;pythonIndexWatchers 闭包私有,随 L2 模块。

  const pythonIndexEditEvents = new Map<vscode.TextDocument, number>();
  let pythonIndexEditFlushTimer: NodeJS.Timeout | undefined;
  let pendingPythonIndexEditCount = 0;

  // SRC-001 L3 诊断调度层(KODE-ARCH 纯移动):主 collection/PR1 计时助手/
  // 统一调度器/配置契约诊断块/7 个独立调度器管线装在
  // src/activate/diagnostics.ts `activateDiagnostics(deps)`,装配顺序由本
  // 调用点保持(先于代码动作注册与文档事件接线),注册面直推
  // context.subscriptions(销毁所有权不变),调度句柄经返回值回组合根供
  // 事件面调用;flush 冲刷计时器被 didChange 事件面写值(pythonIndex 合并
  // 三件同款)留组合根作用域,冲刷闭包原样引用返回的调度器句柄。
  const {
    diagnostics,
    diagnosticScheduler,
    scheduleDefDiagnostics,
    scheduleEntitiesDiagnostics,
    scheduleReceiverNoneDiagnostics,
    scheduleStartupScriptDiagnostics,
    scheduleDefMethodConsistencyDiagnostics,
    scheduleUserTypeContractDiagnostics,
    rescheduleUserTypeContractForRegistryChange,
    schedulePropertyDirectionDiagnostics,
    scheduleReadOnlyWriteDiagnostics,
    scheduleRoleMisuseDiagnostics,
    schedulePostDestroyDiagnostics,
    scheduleProcessTopologyDiagnostics,
    defMethodConsistencyDiagnostics,
    defMethodConsistencyScheduler,
    userTypeContractDiagnostics,
    userTypeContractScheduler,
    propertyDirectionDiagnostics,
    propertyDirectionScheduler,
    readOnlyWriteDiagnostics,
    readOnlyWriteScheduler,
    roleMisuseDiagnostics,
    roleMisuseScheduler,
    postDestroyDiagnostics,
    postDestroyScheduler,
    processTopologyDiagnostics,
    processTopologyScheduler
  } = activateDiagnostics({
    context,
    entityMappingManager,
    pythonClassIndex,
    isDefDocument,
    isPythonDocument
  });


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

  // C-19:def-method-missing-in-python 诊断的一键生成方法骨架(签名按 def
  // 类型映射,目标取诊断双向定位面;生成后一致性重算,诊断消除)
  const defPythonParityCodeActionProvider = vscode.languages.registerCodeActionsProvider(
    defDocumentSelector,
    new KBEngineDefPythonParityCodeActionProvider()
  );
  context.subscriptions.push(defPythonParityCodeActionProvider);

  // B-7(2026-10-29 用户令):receiver-none 诊断的 None 守卫快速修复
  // (python 面,使用行前插入早退守卫;code 对账 kbengine.receiverNone)
  const receiverNoneGuardCodeActionProvider = vscode.languages.registerCodeActionsProvider(
    pythonDocumentSelector,
    new KBEngineReceiverNoneGuardCodeActionProvider()
  );
  context.subscriptions.push(receiverNoneGuardCodeActionProvider);

  // 监听文档变化，实时检查
  if (vscode.workspace.workspaceFolders) {
    // PR2 快照接入:文档开/改先喂 documentStore(内存优先,快照与缓冲区同版本);
    // 关文档释放快照(内存不泄漏)。磁盘旧内容没有路径能进快照。
    context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(document => {
      updateDocumentSnapshot(document);
      // E-1:语料镜像腿独立于诊断开关(不走 validateDocument 的提前返回)
      shadowMirrorCorpusDocument(document);
      // GEN-DEF-1e:打开 impl 文件即排 user_type 契约诊断(未打开时无诊断面)
      scheduleUserTypeContractDiagnostics(document, 'immediate');
      // GEN-DEF-1e ④:打开 python 文件即排方向违规诊断(属性面)
      schedulePropertyDirectionDiagnostics(document, 'immediate');
      // IDE-LINT-007:打开 python 文件即排只读写入诊断
      scheduleReadOnlyWriteDiagnostics(document, 'immediate');
      // IDE-LINT-009:打开 python 文件即排角色错用诊断
      scheduleRoleMisuseDiagnostics(document, 'immediate');
      // IDE-LINT-010:打开 python 文件即排销毁后访问诊断
      schedulePostDestroyDiagnostics(document, 'immediate');
    }));
    const closeWatcher = vscode.workspace.onDidCloseTextDocument(document => {
      releaseDocument(document);
      diagnosticScheduler.releaseDocument(document);
      // C-19:关闭文档同步摘除本规则的诊断与一致性调度器状态(随文档生命周期)
      defMethodConsistencyDiagnostics.delete(document.uri);
      defMethodConsistencyScheduler.releaseDocument(document);
      // C-17:进程拓扑集合/调度器随文档生命周期(清单或 def 关闭即摘除)。
      processTopologyDiagnostics.delete(document.uri);
      processTopologyScheduler.releaseDocument(document);
      // GEN-DEF-1e:user_type 契约诊断随文档生命周期(impl 文件关闭即摘除)。
      userTypeContractDiagnostics.delete(document.uri);
      userTypeContractScheduler.releaseDocument(document);
      // GEN-DEF-1e ④:方向违规诊断随文档生命周期(关闭即摘除)。
      propertyDirectionDiagnostics.delete(document.uri);
      propertyDirectionScheduler.releaseDocument(document);
      // IDE-LINT-007:只读写入诊断随文档生命周期(关闭即摘除)。
      readOnlyWriteDiagnostics.delete(document.uri);
      readOnlyWriteScheduler.releaseDocument(document);
      // IDE-LINT-009:角色错用诊断随文档生命周期(关闭即摘除)。
      roleMisuseDiagnostics.delete(document.uri);
      roleMisuseScheduler.releaseDocument(document);
      // IDE-LINT-010:销毁后访问诊断随文档生命周期(关闭即摘除)。
      postDestroyDiagnostics.delete(document.uri);
      postDestroyScheduler.releaseDocument(document);
      // E-4:撤 Rust 侧镜像 overlay 与版本账(连续开合不积累)
      shadowReleaseCorpusDocument(document);
      // IDE-HOV-011:弃当前文件注解桶(未保存修改随关闭消失,回磁盘口径)
      if (isPythonDocument(document)) {
        releaseDocumentReturnAnnotations(
          getWorkspaceRootForDocument(document),
          document.uri.toString()
        );
      }
      // IDE-REV-011:schema 缓存热命中不再懒重读输入文件(失效在事件面)——
      // 脏 def/types/alias 文档关闭 = document 域输入消失(磁盘内容与缓冲
      // 未必一致),同步摘除消费过该文件的缓存条目
      if (isDefDocument(document) || isTypeRegistryFile(document.uri.fsPath)) {
        invalidateDatabaseSchemaCacheForFiles([document.uri.fsPath]);
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
        scheduleDefMethodConsistencyDiagnostics(event.document, 'queued');
        // C-17:def 变更 → 拓扑校验(该 def 是全局输入之一)。
        scheduleProcessTopologyDiagnostics(event.document, 'queued');
      } else if (isEntitiesXmlDocument(event.document)) {
        scheduleEntitiesDiagnostics(event.document, 'queued');
        // C-17:entities.xml 变更 → 拓扑校验(实体注册信息是输入)。
        scheduleProcessTopologyDiagnostics(event.document, 'queued');
      } else if (isProcessTopologyManifestDocument(event.document)) {
        // C-17:清单变更 → 拓扑校验(全量重排,拓扑是全局输入)。
        scheduleProcessTopologyDiagnostics(event.document, 'queued');
      } else if (isPythonDocument(event.document)) {
        scheduleReceiverNoneDiagnostics(event.document, 'queued');
        // C-19:Python 改动联动两路——反向诊断(Python 有 def 无)与正向重算
        // (属主 def 文档的缺实现,手动补实现即消除;索引不可用静默跳过)
        scheduleDefMethodConsistencyDiagnostics(event.document, 'queued');
        // GEN-DEF-1e:impl 文件改动 → 重排本文件的 user_type 契约诊断
        // (缺方法即补即消,无需等 types.xml 变更)。
        scheduleUserTypeContractDiagnostics(event.document, 'queued');
        // GEN-DEF-1e ④:python 改动 → 重排本文件的方向违规诊断(属性面)
        schedulePropertyDirectionDiagnostics(event.document, 'queued');
        // IDE-LINT-007:python 改动 → 重排本文件的只读写入诊断
        scheduleReadOnlyWriteDiagnostics(event.document, 'queued');
        // IDE-LINT-009:python 改动 → 重排本文件的角色错用诊断
        scheduleRoleMisuseDiagnostics(event.document, 'queued');
        // IDE-LINT-010:python 改动 → 重排本文件的销毁后访问诊断
        schedulePostDestroyDiagnostics(event.document, 'queued');
        const owningDefFile = entityMappingManager.getDefFileForPythonFile(
          event.document.uri.fsPath
        );
        if (owningDefFile) {
          const owningDefDoc = vscode.workspace.textDocuments.find(
            candidate => candidate.uri.fsPath === owningDefFile
          );
          if (owningDefDoc && isDefDocument(owningDefDoc)) {
            scheduleDefMethodConsistencyDiagnostics(owningDefDoc, 'queued');
          }
        }
      } else if (isTypeRegistryFile(event.document.uri.fsPath)) {
        // GEN-DEF-1e:types.xml/alias.xml 变更 = user_type 契约输入变,
        // 重排全部已打开 impl 文件的契约诊断。
        rescheduleUserTypeContractForRegistryChange();
      } else if (isStartupScriptDocument(event.document)) {
        // KBEXP-1:启动脚本改动 → 重排本文件启动参数诊断(行级纯文本扫描)。
        scheduleStartupScriptDiagnostics(event.document, 'queued');
      }
      // IDE-REV-011:schema 缓存热命中不再懒重读输入文件(失效在事件面)——
      // 脏 def/types/alias 文档编辑同步摘除消费条目(磁盘域变更已由
      // entityMapping watcher 覆盖,这里补 document 域)
      if ((event.contentChanges?.length ?? 0) > 0) {
        const editedFsPath = event.document.uri.fsPath;
        if (isDefDocument(event.document)) {
          invalidateDatabaseSchemaCacheForFiles([editedFsPath]);
        } else if (isTypeRegistryFile(editedFsPath)) {
          invalidateDatabaseSchemaCacheForTypeRegistry(editedFsPath);
        }
      }
      if (diagnosticFlushTimer === undefined) {
        diagnosticFlushTimer = setTimeout(() => {
          diagnosticFlushTimer = undefined;
          // IDE-DIA-006:flush 单轮时间片化(重批量让出宿主续批),不 await——
          // 编辑事件面不等诊断收尾,发布节拍与版本守卫全在调度器内
          void diagnosticScheduler.flushQueued();
          // C-19 一致性管线独立调度器,同节拍冲刷(守卫语义同上)
          void defMethodConsistencyScheduler.flushQueued();
          // GEN-DEF-1e:user_type 契约调度器同节拍冲刷(守卫语义同上)
          void userTypeContractScheduler.flushQueued();
          // GEN-DEF-1e ④:方向违规调度器同节拍冲刷(守卫语义同上)
          void propertyDirectionScheduler.flushQueued();
          // IDE-LINT-007:只读写入调度器同节拍冲刷(守卫语义同上)
          void readOnlyWriteScheduler.flushQueued();
          // IDE-LINT-009:角色错用调度器同节拍冲刷(守卫语义同上)
          void roleMisuseScheduler.flushQueued();
          // IDE-LINT-010:销毁后访问调度器同节拍冲刷(守卫语义同上)
          void postDestroyScheduler.flushQueued();
          // KODE-AUD-001:进程拓扑诊断调度器同节拍冲刷——此前编辑事件面只
          // requestQueued 不冲刷,queued 任务滞留不发布致编辑期诊断不更新
          void processTopologyScheduler.flushQueued();
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
        scheduleDefMethodConsistencyDiagnostics(document, 'immediate');
        // C-17:def 打开 → 拓扑校验(该 def 是全局输入之一)。
        scheduleProcessTopologyDiagnostics(document, 'immediate');
      } else if (isEntitiesXmlDocument(document)) {
        scheduleEntitiesDiagnostics(document, 'immediate');
        scheduleProcessTopologyDiagnostics(document, 'immediate');
      } else if (isProcessTopologyManifestDocument(document)) {
        // C-17:清单打开 → 全量重排(拓扑是全局输入)。
        scheduleProcessTopologyDiagnostics(document, 'immediate');
      } else if (isPythonDocument(document)) {
        scheduleReceiverNoneDiagnostics(document, 'immediate');
        scheduleDefMethodConsistencyDiagnostics(document, 'immediate');
      } else if (isStartupScriptDocument(document)) {
        // KBEXP-1:开启动脚本档即发布启动参数诊断(立即通道)。
        scheduleStartupScriptDiagnostics(document, 'immediate');
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
        scheduleDefMethodConsistencyDiagnostics(document, 'immediate');
        scheduleProcessTopologyDiagnostics(document, 'immediate');
      } else if (isEntitiesXmlDocument(document)) {
        scheduleEntitiesDiagnostics(document, 'immediate');
        scheduleProcessTopologyDiagnostics(document, 'immediate');
      } else if (isProcessTopologyManifestDocument(document)) {
        scheduleProcessTopologyDiagnostics(document, 'immediate');
      } else if (isPythonDocument(document)) {
        scheduleReceiverNoneDiagnostics(document, 'immediate');
        scheduleDefMethodConsistencyDiagnostics(document, 'immediate');
      } else if (isStartupScriptDocument(document)) {
        // KBEXP-1:已开启动脚本档(激活期补发)即发布启动参数诊断。
        scheduleStartupScriptDiagnostics(document, 'immediate');
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

    // 注解来源日志开关变更即时生效(IDE-REV-037,不重载窗口)
    if (event.affectsConfiguration('kbengine.annotationLog')) {
      setAnnotationSourceLogEnabled(vscode.workspace.getConfiguration('kbengine').get<boolean>('annotationLog', false));
    }

    // 层2 python-mro(mixin 函数导航)开关变更即时生效(不重载窗口)
    if (event.affectsConfiguration('kbengine.python.enableMroJump')) {
      const enabled = vscode.workspace.getConfiguration('kbengine.python').get<boolean>('enableMroJump', true);
      setPythonMroJumpEnabled(enabled);
    }
    // GLOBDATA-001:数据字典键索引开关变更即时生效(definition/引用查索引前现读)
    if (event.affectsConfiguration('kbengine.python.enableDataDictIndex')) {
      setPythonDataDictIndexEnabled(
        vscode.workspace.getConfiguration('kbengine.python').get<boolean>('enableDataDictIndex', true)
      );
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
      // AUD-071:assetsRoot/profile 切换 = 根集变化 → 字典键索引整库重建(旧外部根不再贡献)
      dataDictIndex.invalidate();
      watchPythonIndex();
      // IDE-IDX-014:实体面外部根 watcher 三件套整组重建(旧根释放,新根挂上)
      entityMappingManager.refreshExternalRootWatchers();
      // IDE-AUD-035:事件索引外部根 watcher 同口径整组重建(旧根释放,新根挂上)
      sharedWorkspaceIndex.refreshExternalWatchers();
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

    // KR-AUD-55:defs 布局两键(entityDefsPath/entitiesXmlPath)变更同样进
    // 失效清单——entities.xml 与 entity_defs 是 schema/实体索引的数据源,
    // 指向切换不 bump 会继续喂旧路径的快照;口径与 db-config 分支一致。
    if (event.affectsConfiguration('kbengine.entityDefsPath') ||
        event.affectsConfiguration('kbengine.entitiesXmlPath')) {
      bumpRootConfigGeneration('def-paths');
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
      // C-19:主开关同闸一致性管线(关→清一致性集合,开→强制重算已发布文档)
      defMethodConsistencyScheduler.setEnabled(enabled, () =>
        defMethodConsistencyDiagnostics.clear()
      );
      // C-17:主开关同闸进程拓扑管线(关→清拓扑集合,开→强制重算)
      processTopologyScheduler.setEnabled(enabled, () =>
        processTopologyDiagnostics.clear()
      );
      // GEN-DEF-1e:主开关同闸 user_type 契约管线(关→清契约集合,开→强制重算)
      userTypeContractScheduler.setEnabled(enabled, () =>
        userTypeContractDiagnostics.clear()
      );
      // GEN-DEF-1e ④:主开关同闸方向违规管线(关→清集合,开→强制重算)
      propertyDirectionScheduler.setEnabled(enabled, () =>
        propertyDirectionDiagnostics.clear()
      );
      // IDE-LINT-007:主开关同闸只读写入管线(关→清集合,开→强制重算)
      readOnlyWriteScheduler.setEnabled(enabled, () =>
        readOnlyWriteDiagnostics.clear()
      );
      // IDE-LINT-009:主开关同闸角色错用管线(关→清集合,开→强制重算)
      roleMisuseScheduler.setEnabled(enabled, () =>
        roleMisuseDiagnostics.clear()
      );
      // IDE-LINT-010:主开关同闸销毁后访问管线(关→清集合,开→强制重算)
      postDestroyScheduler.setEnabled(enabled, () =>
        postDestroyDiagnostics.clear()
      );
    }
    const diagnosticsInputsChanged =
      event.affectsConfiguration('kbengine.enableStructureDiagnostics') ||
      event.affectsConfiguration('kbengine.diagnostics') ||
      event.affectsConfiguration('kbengine.enableDiagnostics') ||
      event.affectsConfiguration('kbengine.receiverNoneDiagnostics') ||
      event.affectsConfiguration('kbengine.attributeNoneDiagnostics') ||
      event.affectsConfiguration('kbengine.propertyDirectionDiagnostics') ||
      event.affectsConfiguration('kbengine.readOnlyWriteDiagnostics') ||
      event.affectsConfiguration('kbengine.roleMisuseDiagnostics') ||
      event.affectsConfiguration('kbengine.postDestroyDiagnostics') ||
      event.affectsConfiguration('kbengine.startupScriptDiagnostics');
    // C-19:def↔Python 一致性两开关 + 骨架体配置,任一变更即重算已开文档。
    const defMethodConsistencyInputsChanged =
      event.affectsConfiguration('kbengine.diagnostics.checkDefMethodMissingInPython') ||
      event.affectsConfiguration('kbengine.diagnostics.checkPythonMethodNotInDef') ||
      event.affectsConfiguration('kbengine.entity.methodStubBody');
    // C-17:进程拓扑开关变更 → 拓扑调度器重算。
    const processTopologyInputsChanged =
      event.affectsConfiguration('kbengine.diagnostics.checkProcessTopology');
    // GEN-DEF-1e:user_type 契约诊断无独立子开关(引擎装载必炸恒应亮),
    // 只随主 enableDiagnostics 开关重算。
    const userTypeContractInputsChanged =
      event.affectsConfiguration('kbengine.enableDiagnostics');
    if ((diagnosticsInputsChanged || defMethodConsistencyInputsChanged || processTopologyInputsChanged) &&
        diagnosticScheduler.isEnabled()) {
      if (event.affectsConfiguration('kbengine.enableStructureDiagnostics') ||
          event.affectsConfiguration('kbengine.diagnostics') ||
          event.affectsConfiguration('kbengine.receiverNoneDiagnostics') ||
          event.affectsConfiguration('kbengine.attributeNoneDiagnostics') ||
          event.affectsConfiguration('kbengine.startupScriptDiagnostics')) {
        diagnosticScheduler.invalidateAll();
      }
      // C-19:一致性输入开关/骨架体变更 → 一致性调度器输入代自增,已发布重算
      if (defMethodConsistencyInputsChanged && defMethodConsistencyScheduler.isEnabled()) {
        defMethodConsistencyScheduler.invalidateAll();
      }
      // C-17:拓扑开关变更 → 拓扑调度器输入代自增,已发布重算。
      if (processTopologyInputsChanged && processTopologyScheduler.isEnabled()) {
        processTopologyScheduler.invalidateAll();
      }
      // receiverNoneDiagnostics 开关切换即重算(任务1,用户令 2026-10-27):
      // compute 每次现读配置，失效版本标记后重调已开文档。
      vscode.workspace.textDocuments.forEach(doc => {
        if (isDefDocument(doc)) {
          scheduleDefDiagnostics(doc, 'immediate');
          if (defMethodConsistencyInputsChanged) {
            scheduleDefMethodConsistencyDiagnostics(doc, 'immediate');
          }
          if (processTopologyInputsChanged) {
            scheduleProcessTopologyDiagnostics(doc, 'immediate');
          }
        } else if (isEntitiesXmlDocument(doc)) {
          scheduleEntitiesDiagnostics(doc, 'immediate');
          if (processTopologyInputsChanged) {
            scheduleProcessTopologyDiagnostics(doc, 'immediate');
          }
        } else if (isProcessTopologyManifestDocument(doc)) {
          if (processTopologyInputsChanged) {
            scheduleProcessTopologyDiagnostics(doc, 'immediate');
          }
        } else if (isPythonDocument(doc)) {
          scheduleReceiverNoneDiagnostics(doc, 'immediate');
          if (defMethodConsistencyInputsChanged) {
            scheduleDefMethodConsistencyDiagnostics(doc, 'immediate');
          }
          if (userTypeContractInputsChanged) {
            scheduleUserTypeContractDiagnostics(doc, 'immediate');
          }
          // GEN-DEF-1e ④:方向违规开关变更 → 立即重算已开 python 文档
          if (event.affectsConfiguration('kbengine.propertyDirectionDiagnostics')) {
            schedulePropertyDirectionDiagnostics(doc, 'immediate');
          }
          // IDE-LINT-007:只读写入开关变更 → 立即重算已开 python 文档
          if (event.affectsConfiguration('kbengine.readOnlyWriteDiagnostics')) {
            scheduleReadOnlyWriteDiagnostics(doc, 'immediate');
          }
          // IDE-LINT-009:角色错用开关变更 → 立即重算已开 python 文档
          if (event.affectsConfiguration('kbengine.roleMisuseDiagnostics')) {
            scheduleRoleMisuseDiagnostics(doc, 'immediate');
          }
          // IDE-LINT-010:销毁后访问开关变更 → 立即重算已开 python 文档
          if (event.affectsConfiguration('kbengine.postDestroyDiagnostics')) {
            schedulePostDestroyDiagnostics(doc, 'immediate');
          }
        } else if (isStartupScriptDocument(doc)) {
          // KBEXP-1:启动脚本诊断开关变更 → 立即重算已开启动脚本(compute
          // 每次现读配置,关闭即清,开启即重发布)。
          scheduleStartupScriptDiagnostics(doc, 'immediate');
        }
      });
    }
  });
  context.subscriptions.push(configWatcher);

  // SRC-001 L5:实体浏览器树视图与 open/refresh 命令迁 activate/views.ts
  // (纯移动,装配顺序由本调用点保持;entityMappingManager 经 deps 注入,
  // 命令回调原文引用共享 manager)。
  activateEntityExplorerViews({ context, entityMappingManager });

  // KODE-ARCH-002:数据库域装配(schema 打开/模拟/漂移/表预览/schema 影响/
  // 玩家数据克隆与连接档案)整体迁 databaseWiring.ts——纯移动,装配顺序由本
  // 调用点保持(前位:openEntityMethodCommand 之后、serverManager 构造之前)。
  wireDatabase(context, { databaseSchemaProvider });

  // SRC-001 L4:服务器/调试域装配(serverManager/telnet/玩家数据/远程服务器/
  // 调试会话与目标/server 控制命令/调试配置与 py-spy 命令/状态栏)整体迁
  // activate/serverControls.ts——纯移动,装配顺序由本调用点保持(wireDatabase
  // 之后、构建任务预览之前);serverManager/telnetService/telnetWebView/
  // debugConfigManager 作为共享句柄返回,logging 接线/发现报告/释放闭包经
  // 句柄消费(subscriptions push 原文随迁,销毁所有权不变)。
  const { serverManager, telnetService, telnetWebView, debugConfigManager } =
    activateServerControls({ context });

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
  // 缺声明(构建 null)两条命令同样明确提示,不展示空预览不写空文件。
  // 构建主路径走 Rust 核心(buildMessageTableInRust,原文直传),Rust 不可用
  // (无 gate/serverPath/调用失败)回落 TS 纯实现——与 clientSdkGenerator
  // 的主路径/兜底分面同形。
  // IDE-AUD-060:类型注册表按「所选根」接入——实体所属根的 types.xml 全文
  // (MY_INT→UINT32 等自定义别名)喂给两条构建路,方法参数不再误报
  // unknown-arg-type;entitydefAliasID 引擎配置如实驱动 aliasID 开关。
  const scanRoots = getIndexScanRoots();
  const readEntityTypesXml = (entityName: string): string | null => {
    const loader = createDefinitionSemanticsLoader(scanRoots);
    if (!loader) {
      return null;
    }
    const raw = loader.loadLocalRaw(entityName, 'entity');
    if (!raw) {
      return null;
    }
    // 实体所属根 = def 文件路径所在的最具体扫描根(前缀匹配;嵌套根取最长)。
    // 与 loader 的 originRootOf 同一口径,保证 types.xml 与 def 同根解析。
    const entityRoot = scanRoots
      .filter(candidate => raw.filePath === candidate || raw.filePath.startsWith(`${candidate}${path.sep}`))
      .sort((left, right) => right.length - left.length)[0];
    if (!entityRoot) {
      return null;
    }
    const layout = getDefinitionWorkspaceLayout(entityRoot);
    if (!layout.typesXmlPath) {
      return null;
    }
    // 共享快照:打开的脏缓冲优先(未保存别名修改即时进注册表),未打开磁盘补载
    const content = readSharedFileSnapshot(layout.typesXmlPath)?.content ?? null;
    return content !== null && content.length > 0 ? content : null;
  };
  const readAliasIdEnabled = (): boolean => {
    // entitydefAliasID 是引擎全局开关(kbengine_defaults.xml 裸键,默认关);
    // 配置树缺失(无引擎 defaults/解析失败)或值非真按 false 如实处理。
    try {
      const merged = buildMergedConfigTree().merged;
      const aliasNode = merged?.children.find(child => child.name === 'entitydefAliasID');
      if (!aliasNode) {
        return false;
      }
      const value = aliasNode.text.trim().toLowerCase();
      return value === '1' || value === 'true';
    } catch {
      return false;
    }
  };
  const buildEntityMessageTable = async (entityName: string): Promise<MessageTable | null> => {
    // 别名开关读 core 配置消费缓存(KODE-CFG-009),先保证新鲜
    await ensureConfigResolved().catch(() => {});
    const loader = createDefinitionSemanticsLoader(scanRoots);
    if (!loader) {
      return null;
    }
    return buildEntityMessageTableShared(entityName, {
      loadDefRaw: (name, kind) => loader.loadLocalRaw(name, kind),
      loadDef: (name, kind) => loader.loadLocal(name, kind)
    }, {
      readEntityTypesXml,
      readAliasIdEnabled
    });
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
        buildTableMarkdown: async entityName => {
          const table = await buildEntityMessageTable(entityName);
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
        buildTableJson: async entityName => {
          const table = await buildEntityMessageTable(entityName);
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
      // R2-F19:节点主体真实结果已入账(通过节点仍标 passed),但进程退出
      // 非零/被信号终止/解释器缺失不再被丢弃——呈报会话错误+stderr,
      // 整个运行不冒充成功。失败/错误节点的非零退出已被节点解释,不重复。
      const sessionFailures = selectSessionFailures(entries);
      if (sessionFailures.length > 0) {
        run.appendOutput(`${buildPythonTestSessionReport(sessionFailures)}\n`);
        const causes = sessionFailures
          .map(entry => `${entry.id}: ${describePythonTestExecIssue(entry.exec!)}`)
          .join('; ');
        void vscode.window.showErrorMessage(`测试会话失败(节点结果仍如实保留): ${causes};详见测试输出面板`);
      }
      run.end();
    },
    true
  );
  context.subscriptions.push(testController);

  // SRC-001 L5:HTTP 快捷请求服务与命令迁 activate/views.ts(纯移动);
  // httpRequestService/quickActionManagerRef/httpRequestChannel 返回给
  // quickAction 装配、临时编辑热更日志等下游消费。
  const { httpRequestService, quickActionManagerRef, httpRequestChannel } =
    activateHttpRequestViews({ context });

  // 日志收集器/查看器/LogHub 与语言服务面板装配(本体在 ./loggingWiring,KODE-ARCH-002 纯移动)
  const { logCollector, logViewer, logHub } = wireLogging(context, serverManager);

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

  // SRC-001 L5:最终配置合成视图(内容 provider/打开/手动命令)迁
  // activate/views.ts(纯移动);openFinalConfig 供激活尾默认开启令、
  // finalConfigProvider 供常驻树与联动 watcher 消费。
  const { openFinalConfig, finalConfigProvider } = activateFinalConfigViews({ context });

  // SRC-001 L5:文件历史/范围历史树视图、版本虚拟文档 provider 与六命令迁
  // activate/views.ts(纯移动,查询门/开关门随域,装配顺序由本调用点保持)。
  activateGitHistoryViews({ context });

  // SRC-001 L5:最终配置常驻树 + kbengine*.xml 联动 watcher 迁
  // activate/views.ts(纯移动;调用位保持在 stub 重生成 watcher 之后,
  // activate 期 watcher 创建次序契约不变;watcher census 随迁见
  // provider-data-sources §5)。
  activateFinalConfigTreeViews({ context, finalConfigProvider });

  // KB-GC-001 guiconsole 期一:machined 发现共享链(hub)+ 日志实时 tail(702
  // 注册 → 65501 长连推流进 Output)+ 组件状态面板(负载/存活,异常红色)。
  // 两个面共用一个 hub,不建两套链(design docs/design/
  // kbengine-guiconsole-integration.md §4;协议解码陷阱见同文档 §1.4)。
  const consoleConfig = vscode.workspace.getConfiguration('kbengine');
  const consoleRefreshSeconds = Math.max(1, consoleConfig.get<number>('componentStatusPanel.refreshSeconds', 5));
  const consoleHub = new ConsoleHub({
    pollIntervalMs: consoleRefreshSeconds * 1000,
    // 默认 127.0.0.1(链路 localhost-only,设计文档 §5);跨机须显式配置
    // kbengine.console.discoveryHost(见配置说明安全边界)
    discovery: { host: consoleConfig.get<string>('console.discoveryHost', '127.0.0.1') }
  });
  consoleHub.start();
  context.subscriptions.push(consoleHub);

  const tailOutput = vscode.window.createOutputChannel('KBEngine Console 日志');
  // 优先级 95:低于 server 100/telnet 99/热更 98/解释器 97/热更通道灯 96
  // (HOT_RELOAD_CHANNEL_STATUS_PRIORITY),不与任何既有灯同优先级。
  const tailStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 95);
  const tailController = new ConsoleLogTailController({
    hub: consoleHub,
    workspaceRoots: () => (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath),
    // IDE-LIV-007 同源:错误行 traceback → 工作区真实文件落点
    resolveSource: (roots, location) => resolveExceptionSource(roots, location),
    output: tailOutput,
    statusItem: tailStatusItem,
    // 配置访问器:每次重读,组件过滤/开关「下次重连生效」而非激活期快照
    getConfig: () => ({
      // 默认开:配置缺失也开,显式 false 才关(用户令,热更/门控同类口径)
      enabled: consoleConfig.get<boolean>('consoleLogTail.enabled', true),
      components: consoleConfig.get<string[]>('consoleLogTail.components', [])
    })
  });
  if (consoleConfig.get<boolean>('consoleLogTail.enabled', true)) {
    tailController.start();
  }
  context.subscriptions.push(tailController, tailOutput, tailStatusItem);
  context.subscriptions.push(vscode.commands.registerCommand('kbengine.consoleLogTail.show', () => tailOutput.show()));
  context.subscriptions.push(vscode.commands.registerCommand('kbengine.consoleLogTail.toggle', () => tailController.toggle()));
  // 开关即时生效:显式 true→start / false→stop(组件过滤即时生效靠注册帧重建,
  // 简化口径:改过滤数组后用 toggle 重连)
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (!event.affectsConfiguration('kbengine.consoleLogTail.enabled')) {
      return;
    }
    const enabled = consoleConfig.get<boolean>('consoleLogTail.enabled', true);
    if (enabled && tailController.getState() === 'disabled') {
      // 显式用户意图开启:force=true 越过激活期快照(off→on 时 deps.config.enabled
      // 仍是激活时的旧值,start() 会误把用户开启当缺省关闭而停在 disabled)
      tailController.start(true);
    } else if (!enabled && tailController.getState() !== 'disabled') {
      tailController.stop();
    }
  }));

  const componentStatusProvider = new ComponentStatusTreeProvider(consoleHub, () => resolveThresholds(key => {
    if (key === 'cpu') {
      return consoleConfig.get<number>('componentStatusPanel.cpuThresholdPercent', 90);
    }
    return consoleConfig.get<number>('componentStatusPanel.memThresholdMb', 1024);
  }));
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('kbengine.componentStatus', componentStatusProvider)
  );
  const stopPanelAutoRefresh = componentStatusProvider.startAutoRefresh(
    (intervalMs, fire) => {
      const timer = setInterval(fire, intervalMs);
      return () => clearInterval(timer);
    },
    consoleRefreshSeconds * 1000
  );
  context.subscriptions.push({ dispose: stopPanelAutoRefresh });
  context.subscriptions.push(vscode.commands.registerCommand('kbengine.consoleComponentPanel.refresh', () => {
    void componentStatusProvider.refresh();
  }));

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


  // 自动热重载(盘点 G5):文件保存/监视 → 按名触发 quick action。门控默认关
  // 防误触;无人值守通道跳过确认框,找不到名字只落 OUTPUT 流水不弹窗。
  // IDE-REV-021:每次发送按「rootId × targetId」双维台账记账——targetId =
  // 动作解析出的服务实例目标(注册动作的 resolved target;@script: 直取内
  // 嵌路径;@http: 调试/设置源按索引对齐树数据,对不上如实不落),rootId =
  // 文件归属的工作区扫描根;动作完成无回执仍只记 sent-unverified,绝不记
  // 成功态——同文件发不同实例各落各的,切目标不复用上一目标状态。
  // IDE-HOT-100:台账落账即时刷呈现面(角标/状态点跟住回执落地,不等下次
  // 保存);呈现面 provider 在后面才建,这里挂前向引用
  const hotReloadStateViewRefresh: { refresh?: () => void } = {};
  // HOT-VER:版本簿的前向引用——回执落账/采样变化 → 重采版本并补渲染状态栏
  const hotReloadVersionRefresh: { refresh?: (forceRender?: boolean) => void } = {};
  // SRC-001 L5:快捷动作树视图与四命令迁 activate/views.ts(纯移动);
  // 调用位在 hotReloadVersionRefresh 声明之后——命令回调原文引用该前向
  // 引用 holder,共享同一对象;quickActionManager 返回供热更自动触发/
  // 监控/临时编辑热更/激活末扫描消费。
  const { quickActionManager } = activateQuickActionTreeViews({
    context,
    httpRequestService,
    quickActionManagerRef,
    hotReloadVersionRefresh
  });
  // SRC-001 L6:热重载域(状态机/台账/版本簿/通道快速切换/呈现面/临时编辑
  // 热更)迁 activate/hotReload.ts(纯移动,装配顺序由本调用点保持);
  // 组合根声明的两个前向引用 holder 经 deps 传入,模块内 `.refresh =` 写回
  // 共享对象;quickActionManager(views L5 返回句柄)/httpRequestChannel(views
  // Q1)/fileChangeMetaResolver(languageServices L2)经 deps 注入;
  // fileChangeRouter 返回给 rust 文件变化消费者接线。
  const { fileChangeRouter } = activateHotReload({
    context,
    quickActionManager,
    hotReloadStateViewRefresh,
    hotReloadVersionRefresh,
    httpRequestChannel,
    fileChangeMetaResolver
  });

  // SRC-001 L7:生成器/项目层(Python 生态接线/桩导出、debug.json 引导与
  // 托管目录 watcher、代码生成器/项目向导、客户端 SDK 生成、profile 切换落
  // 索引输入)迁 activate/generators.ts(纯移动,装配顺序由本调用点保持);
  // entityMappingManager(coreServices)/quickActionManager(views L5)/
  // pythonClassIndex、watchPythonIndex(languageServices L2)/
  // pythonDocumentSelector(infrastructure)经 deps 注入(isPythonMroJumpEnabled
  // 为纯模块导入,模块内直引);codeGenerator 返回给组合根供 deactivate
  // 收口 dispose。
  const { codeGenerator } = activateGenerators({
    context,
    entityMappingManager,
    quickActionManager,
    pythonClassIndex,
    pythonDocumentSelector,
    watchPythonIndex
  });

  // .def 静态分析建议(性能分析):扫描工作区全部 .def,报告写入输出面板
  // 并以诊断形式落到问题列表(装配本体在 ./defAnalysisWiring,KODE-ARCH-002 纯移动)
  const defAnalysis = wireDefAnalysis();
  context.subscriptions.push(defAnalysis.command);

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
  context.subscriptions.push(defAnalysis.outputChannel, defAnalysis.diagnostics);

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
          annotationBuilds: getAnnotationBuildWorkload(),
          worker: getPythonParserWorkerGauge(),
          caches: {
            parsedDocuments: getParsedDocumentCacheGauge(),
            databaseSchemas: getDatabaseSchemaCacheGauge(),
            annotationIndex: getReturnAnnotationCacheGauge()
          },
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

  // 解释器状态栏与选择(PY-ENV 二期):状态栏项显示当前解释器(venv 名/
  // 版本/来源徽标 auto|configured|PATH|缺失),点击进 QuickPick——选中写入
  // kbengine.python.interpreterPath(workspace 级)即刻生效(解析链每次读
  // 实时配置);列表尾「创建新 venv…」走创建流(选放置 venv 的父目录,目标
  // 固定 .venv;基础解释器=设置→PATH 链,缺失如实拒绝;完成后对目标直接
  // 验真再选用)。
  const interpreterStatusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    97
  );
  interpreterStatusBarItem.command = 'kbengine.python.selectInterpreter';
  context.subscriptions.push(interpreterStatusBarItem);

  const venvPreferredNames = (): string[] =>
    normalizeVenvDirectoryNames(
      vscode.workspace.getConfiguration('kbengine').get('python.venvDirectories')
    );
  const refreshInterpreterStatusBar = async (): Promise<void> => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const resolution = resolveProfileInterpreter(root);
    interpreterStatusBarItem.text = interpreterStatusBarText(resolution);
    interpreterStatusBarItem.tooltip = resolution.interpreterPath
      ? resolution.interpreterPath
      : 'Python 解释器缺失(点击可选择或创建)';
    interpreterStatusBarItem.show();
    // 版本探测失败如实省略版本段,不影响徽标与路径显示
    if (resolution.interpreterPath) {
      const version = await probePythonVersion(resolution.interpreterPath);
      if (version) {
        interpreterStatusBarItem.text = interpreterStatusBarText(resolution, version);
      }
    }
  };

  const runCreateVenvFlow = (): Promise<'created' | null> =>
    createVenvFlow({
      workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      // 对话框只能选已存在目录:选放置 venv 的父目录(默认工作区根),
      // 目标固定为其中的 .venv(python -m venv 自己落目录)
      pickTargetParentDir: async defaultDir => {
        const picks = await vscode.window.showOpenDialog({
          canSelectFolders: true,
          canSelectMany: false,
          defaultUri: vscode.Uri.file(defaultDir),
          openLabel: '选择放置 venv 的目录'
        });
        return picks?.[0]?.fsPath ?? null;
      },
      // 基础解释器走 设置存在才采用 → PATH 链(不走工作区发现——那可能
      // 正是要被重建的环境);与缺失提示的补救入口一致
      baseInterpreter: () => {
        const configured = vscode.workspace
          .getConfiguration('kbengine')
          .get<string>('python.interpreterPath', '');
        return resolveInterpreterWith({
          interpreterSetting: configured,
          pathEnv: process.env.PATH,
          platform: process.platform
        }).interpreterPath;
      },
      targetDirectoryExistsNonEmpty: dir => {
        try {
          return fs.readdirSync(dir).length > 0;
        } catch {
          return false;
        }
      },
      // withProgress 返回 Thenable,await 归一成 Promise(依赖面签名)
      runVenvModule: async (base, target) =>
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `创建 venv: python -m venv ${target}` },
          () => runVenvModuleProcess(base, target)
        ),
      // 直接对目标验真(不依赖扫描范围,深层/工作区外目标照常选用)
      verifyTarget: dir => verifyVenvDirectory(dir, process.platform),
      writeInterpreterSetting: async value =>
        await vscode.workspace
          .getConfiguration('kbengine')
          .update('python.interpreterPath', value, vscode.ConfigurationTarget.Workspace),
      report: async message => {
        await vscode.window.showInformationMessage(message);
      }
    });

  const selectInterpreterCommand = vscode.commands.registerCommand(
    'kbengine.python.selectInterpreter',
    async () => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      await selectInterpreter({
        current: () => resolveProfileInterpreter(root),
        discovered: () => (root ? scanVenvs(root, { preferredNames: venvPreferredNames() }) : []),
        pathInterpreter: () => locateInterpreterOnPath(process.env.PATH, process.platform),
        showQuickPick: async items =>
          await vscode.window.showQuickPick(items, {
            placeHolder: '选择 Python 解释器(写入 kbengine.python.interpreterPath 即刻生效)'
          }),
        writeInterpreterSetting: async value =>
          await vscode.workspace
            .getConfiguration('kbengine')
            .update('python.interpreterPath', value, vscode.ConfigurationTarget.Workspace),
        report: async message => {
          await vscode.window.showInformationMessage(message);
        },
        createVenv: () => runCreateVenvFlow()
      });
      await refreshInterpreterStatusBar();
    }
  );

  const createVenvCommand = vscode.commands.registerCommand('kbengine.python.createVenv', async () => {
    await runCreateVenvFlow();
    await refreshInterpreterStatusBar();
  });

  const interpreterConfigListener = vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('kbengine.python.interpreterPath')) {
      void refreshInterpreterStatusBar();
    }
  });
  context.subscriptions.push(selectInterpreterCommand, createVenvCommand, interpreterConfigListener);
  void refreshInterpreterStatusBar();

  // .py lint via ruff(IDE-RUST-005,A 案 shell out):Rust 侧 `$/kode/ruff/lint`
  // 恒 --target-version py37 + --no-cache(不写工作区);缺 ruff 如实
  // available:false → 这里同意式 pip 安装(选定解释器),失败亮手动命令
  // (用户令 2026-11-06),绝不静默装。
  const ruffChannel = vscode.window.createOutputChannel('KBEngine Ruff');
  const ruffDiagnostics = vscode.languages.createDiagnosticCollection('kode-ruff');
  context.subscriptions.push(ruffChannel, ruffDiagnostics);

  // C-23 行为知识流水线(坑→lint/code action/hover):三规则(KBE-PY-015/
  // 016/017)独立诊断集合与 quick fix provider 自持装配(trapDiagnosticsWiring
  // 自带事件监听,不进主调度链);hover 行为注记在 languageProviders/hover.ts
  // self 属性悬停面接线。注册点放在全部既有诊断集合之后(集合创建序即
  // 注册表序,消费方按序取集合,不抢既有下标)
  wireTrapLintDiagnostics(context, entityMappingManager);
  const ruffLintDeps = {
    getWorkspacePythonFiles: async () =>
      (
        await vscode.workspace.findFiles('**/*.py', '**/node_modules/**', RUFF_MAX_FILES + 1)
      ).map(uri => uri.fsPath),
    getInterpreterPath: () => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      return resolveProfileInterpreter(root).interpreterPath || null;
    },
    runPipInstall: (interpreterPath: string) =>
      new Promise<{ ok: boolean; output: string }>(resolve => {
        execFile(interpreterPath, ['-m', 'pip', 'install', 'ruff'], (error, stdout, stderr) => {
          resolve({ ok: !error, output: `${stdout ?? ''}\n${stderr ?? ''}`.trim() });
        });
      }),
    showInformationMessage: (message: string, ...items: string[]) =>
      vscode.window.showInformationMessage(message, ...items),
    showErrorMessage: async (message: string) => {
      await vscode.window.showErrorMessage(message);
    },
    setDiagnostics: (entries: Array<{ file: string; diags: RuffDiag[] }>) => {
      ruffDiagnostics.clear();
      for (const { file, diags } of entries) {
        ruffDiagnostics.set(
          vscode.Uri.file(file),
          diags.map(
            d =>
              new vscode.Diagnostic(
                new vscode.Range(d.line - 1, d.col - 1, d.endLine - 1, d.endCol - 1),
                `${d.code ? `${d.code}: ` : ''}${d.message}`,
                d.severity === 'error'
                  ? vscode.DiagnosticSeverity.Error
                  : vscode.DiagnosticSeverity.Warning
              )
          )
        );
      }
    },
    channel: ruffChannel
  };
  const ruffLintCommand = vscode.commands.registerCommand('kbengine.python.ruffLint', async () => {
    const summary = await runRuffLintCommand(ruffLintDeps);
    ruffChannel.appendLine(`[ruff] ${summary}`);
    ruffChannel.show(true);
    await vscode.window.showInformationMessage(summary);
  });
  const installRuffCommand = vscode.commands.registerCommand(
    'kbengine.python.installRuff',
    async () => {
      const summary = await runInstallRuffCommand(ruffLintDeps);
      ruffChannel.appendLine(`[ruff] ${summary}`);
      await vscode.window.showInformationMessage(summary);
    }
  );
  context.subscriptions.push(ruffLintCommand, installRuffCommand);

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
      // KR-AUD-57:serverManager.dispose 只调一次(await)——原处多出一次
      // 裸调(丢弃 promise),进程表清理被连跑两遍
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
    /**
     * §11.3 非 py 旁路的 rust 消费者注册口(公共 API):按扩展名/路径前缀
     * 注册即接通 `$/kode/fileChanged` → 现有 LSP stdio(KodeCoreGate);不注册
     * 任何消费者 = 只记录不投递(设计 §11.2 默认口径)。返回退订口。
     */
    registerFileChangeConsumer: (selectors: {
      readonly id?: string;
      readonly extensions?: readonly string[];
      readonly pathPrefixes?: readonly string[];
    }): { dispose(): void } =>
      registerRustFileChangeConsumer(fileChangeRouter, kodeCoreGate, selectors),
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
    // IDE-REV-033:定义跳转确定性在途取消探针——与 REV-032 hover 探针同构,
    // 但走 PythonDefinitionProvider.provideDefinition(导航面,不得以 hover 或
    // 预取消代替):门内斩 token=开始后完成前取消;settledBeforeCancel 斩后
    // 立即定格,false 即「无晚到结果发布」的结构性证明。
    probeDefinitionGatedCancel: async (target: { file: string; line: number; character: number }) => {
      let markEntered!: () => void;
      let releaseGate!: () => void;
      const enteredSignal = new Promise<void>(resolve => { markEntered = resolve; });
      const release = new Promise<void>(resolve => { releaseGate = resolve; });
      setDefinitionInFlightGateForTests(() => {
        markEntered();
        return release.then(() => { setDefinitionInFlightGateForTests(null); });
      });
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target.file));
      const canceller = new vscode.CancellationTokenSource();
      const startedAt = Date.now();
      let gateEnteredAtMs = -1;
      const definitionPromise = pythonDefinitionImpl.provideDefinition(
        document,
        new vscode.Position(target.line, target.character),
        canceller.token
      );
      let definitionSettled = false;
      void Promise.resolve(definitionPromise).then(() => { definitionSettled = true; }, () => { definitionSettled = true; });
      await enteredSignal;
      gateEnteredAtMs = Date.now() - startedAt;
      // 确定性在途斩:此刻请求在途(已开始未完成)
      canceller.cancel();
      const cancelledAtMs = Date.now() - startedAt;
      // 斩后立即定格:此刻之后结果落定属正常(放行收口),定格值才是「完成前」证明
      const settledBeforeCancel = definitionSettled;
      releaseGate();
      const definition = await Promise.resolve(definitionPromise);
      const elapsedMs = Date.now() - startedAt;
      canceller.dispose();
      return {
        gateEnteredAtMs,
        cancelledAtMs,
        settledBeforeCancel,
        elapsedMs,
        cancelled: true,
        returnedDefinition: definition !== null && definition !== undefined,
        location: definition
          ? (Array.isArray(definition) ? definition[0] : definition)?.uri?.toString() ?? null
          : null
      };
    },
    // IDE-AUD-016(F14/IDE-REV-033 深审):定义依赖链派发后取消探针——与
    // probeDefinitionGatedCancel(入口闸,证明「进 provider 后取消零工作」)
    // 互补:本闸在层1 entity-def 方法探针返回后(真实 def 依赖链已派发:定向
    // glob/解析/索引解析已执行并返回),取消落在此窗口=「真实工作已启动后的
    // 中止」。请求归属 IO 以请求窗前后读盘快照差记录(readsBefore/readsAtCancel),
    // 本请求为窗内唯一在途请求(调用方先排干后台)。gateReached=false 即请求在
    // 方法探针前已收口(夹具/层序不符),如实上报供断言失败说明。
    probeDefinitionDispatchCancel: async (target: { file: string; line: number; character: number }) => {
      let markEntered!: () => void;
      let releaseGate!: () => void;
      const enteredSignal = new Promise<void>(resolve => { markEntered = resolve; });
      const release = new Promise<void>(resolve => { releaseGate = resolve; });
      setDefinitionDispatchGateForTests(() => {
        markEntered();
        return release.then(() => { setDefinitionDispatchGateForTests(null); });
      });
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target.file));
      const canceller = new vscode.CancellationTokenSource();
      const readsBefore = getFileReadTotals();
      const startedAt = Date.now();
      let gateEnteredAtMs = -1;
      const definitionPromise = pythonDefinitionImpl.provideDefinition(
        document,
        new vscode.Position(target.line, target.character),
        canceller.token
      );
      let definitionSettled = false;
      void Promise.resolve(definitionPromise).then(() => { definitionSettled = true; }, () => { definitionSettled = true; });
      // 门达探测:请求跑到方法探针后即达;30s 未达说明在方法探针前已收口
      let gateTimer: NodeJS.Timeout | undefined;
      const gateTimeout = new Promise<boolean>(resolve => { gateTimer = setTimeout(() => resolve(false), 30_000); });
      const gateReached = await Promise.race([enteredSignal.then(() => true), gateTimeout]);
      if (gateTimer !== undefined) { clearTimeout(gateTimer); }
      if (gateReached) {
        gateEnteredAtMs = Date.now() - startedAt;
        // 真实链已派发:此刻快照即本请求已派发的 IO 归属(窗内唯一在途请求)
        const readsAtCancel = getFileReadTotals();
        // 确定性在途斩:此刻请求在途(已派发真实链、未完成)
        canceller.cancel();
        const cancelledAtMs = Date.now() - startedAt;
        // 斩后立即定格:「完成前」证明(放行后落定属正常收口)
        const settledBeforeCancel = definitionSettled;
        releaseGate();
        const definition = await Promise.resolve(definitionPromise);
        const elapsedMs = Date.now() - startedAt;
        const readsAfter = getFileReadTotals();
        canceller.dispose();
        return {
          gateReached,
          gateEnteredAtMs,
          cancelledAtMs,
          settledBeforeCancel,
          elapsedMs,
          cancelled: true,
          returnedDefinition: definition !== null && definition !== undefined,
          location: definition
            ? (Array.isArray(definition) ? definition[0] : definition)?.uri?.toString() ?? null
            : null,
          readsBefore: readsBefore.reads,
          readsAtCancel: readsAtCancel.reads,
          readsAfter: readsAfter.reads
        };
      }
      // 门未达:释放闸(清安装)并如实上报,由测试断言说明夹具/层序不符
      releaseGate();
      const definition = await Promise.resolve(definitionPromise);
      canceller.dispose();
      return {
        gateReached: false,
        gateEnteredAtMs: -1,
        cancelledAtMs: -1,
        settledBeforeCancel: definitionSettled,
        elapsedMs: Date.now() - startedAt,
        cancelled: false,
        returnedDefinition: definition !== null && definition !== undefined,
        location: definition
          ? (Array.isArray(definition) ? definition[0] : definition)?.uri?.toString() ?? null
          : null,
        readsBefore: readsBefore.reads,
        readsAtCancel: readsBefore.reads,
        readsAfter: getFileReadTotals().reads
      };
    },
    // IDE-REV-032:确定性在途取消探针——门住 provider「已过入口守卫、未出结果」
    // 的在途窗口,门内斩 token(开始后、完成前取消,不再靠 2ms 竞速),放行
    // 后按取消语义收口。gateEnteredAtMs>=0 证请求已开始,cancelAtMs>gateEnteredAtMs
    // 证取消落在在途窗口内(完成前)。
    probeHoverGatedCancel: async (target: { file: string; line: number; character: number }) => {
      let markEntered!: () => void;
      let releaseGate!: () => void;
      const enteredSignal = new Promise<void>(resolve => { markEntered = resolve; });
      const release = new Promise<void>(resolve => { releaseGate = resolve; });
      setHoverInFlightGateForTests(() => {
        markEntered();
        return release.then(() => { setHoverInFlightGateForTests(null); });
      });
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target.file));
      const canceller = new vscode.CancellationTokenSource();
      const startedAt = Date.now();
      let gateEnteredAtMs = -1;
      const hoverPromise = kbengineHoverImpl.provideHover(
        document,
        new vscode.Position(target.line, target.character),
        canceller.token
      );
      // 在途证明:门未放行前结果不可能落定;斩后立刻定格此旗,若定格时已
      // 翻转,说明门未真正挡住结果(证明失守)
      let hoverSettled = false;
      void Promise.resolve(hoverPromise).then(() => { hoverSettled = true; }, () => { hoverSettled = true; });
      await enteredSignal;
      gateEnteredAtMs = Date.now() - startedAt;
      // 确定性在途斩:此刻请求在途(已开始未完成)
      canceller.cancel();
      const cancelledAtMs = Date.now() - startedAt;
      // 斩后立即定格:此刻之后结果落定属正常(放行收口),定格值才是「完成前」证明
      const settledBeforeCancel = hoverSettled;
      releaseGate();
      const hover = await Promise.resolve(hoverPromise);
      const elapsedMs = Date.now() - startedAt;
      canceller.dispose();
      return {
        gateEnteredAtMs,
        cancelledAtMs,
        settledBeforeCancel,
        elapsedMs,
        cancelled: true,
        returnedHover: hover !== null && hover !== undefined,
        preview: previewOf(hover?.contents?.[0]).slice(0, 120)
      };
    },
    pendingWork: () => ({
      diagnosticsQueued: diagnosticScheduler.pendingWorkload().queued +
        defMethodConsistencyScheduler.pendingWorkload().queued +
        userTypeContractScheduler.pendingWorkload().queued +
        propertyDirectionScheduler.pendingWorkload().queued,
      diagnosticsInFlight: diagnosticScheduler.pendingWorkload().inFlight +
        defMethodConsistencyScheduler.pendingWorkload().inFlight +
        userTypeContractScheduler.pendingWorkload().inFlight +
        propertyDirectionScheduler.pendingWorkload().inFlight,
      annotationUpdates: getPendingDocumentUpdateCount(),
      caches: {
        parsedDocuments: getParsedDocumentCacheGauge(),
        databaseSchemas: getDatabaseSchemaCacheGauge(),
        annotationIndex: getReturnAnnotationCacheGauge()
      },
      worker: getPythonParserWorkerGauge(),
      annotationBuilds: getAnnotationBuildWorkload(),
      indexTasksQueued: indexScheduler.getStatus().queued,
      schemaColdBuilds: getPendingTypeStorageColdBuildCount()
    })
  };
}

export function deactivate() {
  disposePythonParserWorker();
  // IDE-REV-039:def 解析 worker 一并停用(在途解析拒绝,由调用方同步兜底)
  disposeDefParserWorker();
  // PR2:停用即释放全部文档快照(进程回收前不留缓冲区副本)
  releaseAllDocumentSnapshots();
  // IDE-GIT-011:卸载即取消全部在途/排队历史查询并清缓存(不残留 Git 子进程)。
  sharedGitQueryGate.dispose();
  console.log('KBEngine Language Extension is now deactivated!');
}
