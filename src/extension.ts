import { getExternalScanRoots, resetScanRootCache } from './scanRoots';

import { bumpRootConfigGeneration } from './rootConfigGeneration';
import { disposePythonParserWorker, getPythonParserWorkerGauge } from './backend/pythonParserWorkerHost';
import { disposeDefParserWorker } from './backend/defParserWorkerHost';




import { resolveActiveProfile } from './activeProfile';


import { setJumpLogEnabled } from './navigationLog';
import { setAnnotationSourceLogEnabled } from './backend/annotationSourceLog';
import { activateInfrastructure } from './activate/infrastructure';

import { OperationStatus } from './languageServiceMetrics';
import { releaseAllDocumentSnapshots, releaseDocument, updateDocumentSnapshot } from './backend/documentStore';
import * as vscode from 'vscode';

import * as fs from 'fs';
import * as path from 'path';
import { BUILD_TASK_TYPE, buildScriptCheckTaskSpec, formatBuildTaskPreview } from './backend/buildTaskSpec';
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
} from './backend/taskContext';
import { showEntityMessageTablePreview } from './backend/messageTablePreview';
import { exportEntityMessageTable } from './backend/messageTableExport';
import { renderMessageTableJson, renderMessageTableMarkdown, type MessageTable } from './backend/messageTable';
import { buildEntityMessageTableShared } from './backend/messageTableEntity';
import { createDefinitionSemanticsLoader } from './backend/definitionSemantics';
import { getIndexScanRoots } from './scanRoots';
import { readSharedFileSnapshot } from './sharedFileSnapshot';
import { ProjectProfileStore } from './projectProfiles';
import { wireDatabase } from './databaseWiring';
import { wireLogging } from './loggingWiring';
import {
  LogErrorScanView,
  realLogErrorScanDeps,
  runLogErrorScanCommand,
  scanRawLogErrors,
} from './logErrorScan';






import { activateCoreServices } from './activate/coreServices';
import { activateLanguageServices } from './activate/languageServices';
import { activateDiagnostics } from './activate/diagnostics';
import { activateServerControls } from './activate/serverControls';
import { activateEntityExplorerViews, activateFinalConfigTreeViews, activateFinalConfigViews, activateGitHistoryViews } from './activate/views';
import { activateHttpRequestViews, activateQuickActionTreeViews } from './activate/views';
import { activateHotReload } from './activate/hotReload';
import { activateGenerators } from './activate/generators';
import { activateMonitoring } from './activate/monitoring';
import { activateConsole } from './activate/console';
import { activateUtilityCommands } from './activate/utilityCommands';
export { setProcessTopologySchedulerForTests, getProcessTopologySchedulerForTests } from './activate/diagnostics';








import { registerRustFileChangeConsumer } from './backend/fileChangeBypass';
import { shadowMirrorCorpusDocument, shadowReleaseCorpusDocument } from './backend/kodeCoreShadowFaces';







import { getWorkspaceRootForDocument } from './definitionWorkspace';
import { getParsedDocumentCacheGauge } from './backend/defParser';
import {
  applySavedFileAnnotations,
  getAnnotationBuildWorkload,
  getPendingDocumentUpdateCount,
  getReturnAnnotationCacheGauge,
  removeSavedFileAnnotations,
  renameSavedFileAnnotations,
  queueDocumentReturnAnnotations,
  releaseDocumentReturnAnnotations,
} from './backend/pythonReturnTypeInference';

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







import { isTypeRegistryFile } from './backend/semanticIndex';
import {
  invalidateDatabaseSchemaCacheForFiles,
  invalidateDatabaseSchemaCacheForTypeRegistry,
  getDatabaseSchemaCacheGauge,
  getPendingTypeStorageColdBuildCount,
} from './databaseSchema';
import { getDefinitionWorkspaceLayout } from './definitionWorkspace';






import { sharedGitQueryGate } from './backend/gitQueryGate';
import { isStartupScriptDocument } from './kbengineStartupScript';
import { buildMergedConfigTree, resetDatabaseInterfaceConfigCache } from './serverConfigMerge';
import { ensureConfigResolved } from './serverConfigResolve';






import { getFileReadTotals } from './backend/fileReadMetrics';
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

  // SRC-001 L9:console 层(machined 发现共享链 hub、日志实时 tail、
  // 组件状态面板)迁 activate/console.ts(纯移动,装配顺序由本调用点保持);
  // 区域仅依赖 context,注册面直推 context.subscriptions。
  activateConsole({ context });

  // SRC-001 L8:监控/面板层(监控面板 collector+webview、运行时查询
  // profile/spaces/runtimeQuery、异常源/兼容性/工作台命令、BG-WARM 后台
  // 预热控制器与依赖/实体流面板/python 调用图命令)迁 activate/monitoring.ts
  // (纯移动,装配顺序由本调用点保持);entityMappingManager、indexScheduler
  // (coreServices L1)/sharedWorkspaceIndex(languageServices L2)经 deps 注入;
  // 面板实例与区域自建 outputChannel 返回给组合根供 deactivate 收口 dispose。
  const { monitoringCollector, monitoringWebView, dependencyWebView, flowWebView, outputChannel } = activateMonitoring({
    context,
    entityMappingManager,
    indexScheduler,
    sharedWorkspaceIndex
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
  // SRC-001 L10:工具命令层(.def 静态分析建议、语义医生、符号引用图、
  // 片段生成、发现报告、扩展身份、双激活警告、复现摘要、服务状态、profile
  // 健康、解释器状态栏与选择、ruff lint/安装等 10+ 独立命令)迁
  // activate/utilityCommands.ts(纯移动,装配顺序由本调用点保持);
  // entityMappingManager、indexScheduler(coreServices L1)/serverManager
  // (serverControls L4)经 deps 注入,区域无后向消费者。
  activateUtilityCommands({
    context,
    entityMappingManager,
    serverManager,
    indexScheduler
  });

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
