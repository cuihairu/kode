// SRC-001 L3 抽象层(KODE-ARCH 纯移动,零行为变更):组合根的诊断调度激活器。
// 职责(分析文档 docs/design/src-001-extension-abstraction-layers.md L3):
// 主诊断 collection(.def 结构/entities.xml 共用)+PR1 计时助手+统一
// DiagnosticScheduler 装配、配置契约诊断块(独立 collection+watcher)、
// 7 个独立调度器管线(def 方法一致性/user_type 契约/属性方向/只读写/
// 角色错用/销毁后访问/进程拓扑)+进程拓扑调度器测试访问器。
// 形态:deps 显式注入(entityMappingManager/pythonClassIndex/谓词面),调度
// 句柄与 collection 一并返回;文档事件面(didChange/open/close)留组合根,
// 经返回句柄调度;flush 冲刷计时器被 didChange 事件面写值(pythonIndex 合并
// 三件同款),留组合根作用域,冲刷闭包经返回句柄引用 8 个调度器。
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CONFIG_CONTRACT_DIAGNOSTICS_ENABLED_DEFAULT, computeConfigContractFindings } from '../backend/configContractDiagnostics';
import { RECEIVER_NONE_DIAGNOSTICS_ENABLED_DEFAULT, receiverNoneDiagnosticItemsAsync, type ReceiverDiagnosticItem } from '../backend/receiverNoneDiagnostics';
import { buildReceiverNoneItemsWithRust } from '../backend/receiverNoneRust';
import { buildAttributeNoneItemsWithRust } from '../backend/attributeNoneRust';
import { ATTRIBUTE_NONE_DIAGNOSTICS_ENABLED_DEFAULT, attributeNoneDiagnosticItems, ATTRIBUTE_NONE_DIAGNOSTIC_CODE } from '../backend/selfAttributeNoneDiagnostics';
import { SPACE_NAV_DIAGNOSTICS_ENABLED_DEFAULT, SPACE_NAV_DIAGNOSTIC_CODE, computeSpaceNavFindings } from '../backend/spaceNavDiagnostics';
import { buildSpaceNavItemsWithRust } from '../backend/spaceNavRust';
import { RPC_ARG_COUNT_DIAGNOSTICS_ENABLED_DEFAULT, RPC_ARG_COUNT_DIAGNOSTIC_CODE, computeRpcArgCountFindingsAsync } from '../backend/rpcArgCountDiagnostics';
import { flowVersionKeyForDocument } from '../flowVersionKey';
import {
  DEF_METHOD_MISSING_DIAGNOSTIC_CODE,
  KBENGINE_DEF_METHOD_CONSISTENCY_REVALIDATE_COMMAND,
  PYTHON_METHOD_NOT_IN_DEF_DIAGNOSTIC_CODE,
  collectDefMethodMissingItems,
  collectPythonMethodNotInDefItems,
} from '../backend/defMethodConsistency';
import { USER_TYPE_CONTRACT_MISSING_DIAGNOSTIC_CODE, collectUserTypeContractMissingByImplFile } from '../backend/userTypeContract';
import { collectUserTypeContractMissingByImplFileFromRust } from '../backend/userTypeContractRust';
import { collectUserTypeContractStatuses } from '../backend/userTypeContractSource';
import {
  PROPERTY_DIRECTION_DIAGNOSTICS_ENABLED_DEFAULT,
  propertyDirectionDiagnosticItemsAsync,
  type PropertyDirectionDiagnosticItem,
  type PropertyDirectionHit,
} from '../backend/propertyDirectionDiagnostics';
import { buildPropertyDirectionScanBundleWithRust } from '../backend/propertyDirectionRust';
import { READONLY_WRITE_DIAGNOSTICS_ENABLED_DEFAULT, readOnlyWriteDiagnosticItemsAsync, type ReadOnlyWriteDiagnosticItem } from '../backend/readOnlyWriteDiagnostics';
import { buildReadOnlyWriteItemsWithRust } from '../backend/readOnlyWriteRust';
import { ROLE_MISUSE_DIAGNOSTICS_ENABLED_DEFAULT, roleMisuseDiagnosticItemsAsync, type RoleMisuseDiagnosticItem } from '../backend/roleMisuseDiagnostics';
import { POST_DESTROY_DIAGNOSTICS_ENABLED_DEFAULT, postDestroyDiagnosticItemsAsync, type PostDestroyDiagnosticItem } from '../backend/postDestroyDiagnostics';
import { buildPostDestroyItemsWithRust } from '../backend/postDestroyRust';
import { CELL_DATA_WRITE_DIAGNOSTICS_ENABLED_DEFAULT, analyzeCellDataFieldWrites, cellDataWriteFindingToItem, type CellDataWriteDiagnosticItem } from '../backend/cellDataWriteCheck';
import { SPACE_DATA_PROTECTED_KEY_DIAGNOSTICS_ENABLED_DEFAULT, analyzeSpaceDataProtectedKeys, type SpaceDataProtectedKeyDiagnosticItem } from '../backend/spaceDataProtectedKeyCheck';
import { getKbeAliases } from '../kbeModuleIndex';
import {
  FIXED_DICT_CONSTRUCT_DIAGNOSTICS_ENABLED_DEFAULT,
  analyzeFixedDictConstructWrites,
  fixedDictConstructFindingToItem,
  type FixedDictConstructDiagnosticItem
} from '../backend/fixedDictConstructCheck';
import {
  computeGetDictFromObjReturnFindings,
  fixedDictReturnFindingToItem
} from '../backend/getDictFromObjReturnCheck';
import {
  computeCreateObjFromDictInputKeyFindings,
  createObjFromDictInputFindingToItem,
  implBindingsForDocument,
  resolveCreateObjFromDictInputBindings,
  resolveImplMethodInputs
} from '../backend/createObjFromDictInput';
import {
  computeConvertedObjMemberFindings,
  convertedObjMemberFindingToItem
} from '../backend/convertedObjMembers';
import {
  computeRoundTripFieldFindings,
  roundTripFieldFindingToItem
} from '../backend/roundTripFields';
import {
  computeSameTypeFindings,
  sameTypeFindingToItem
} from '../backend/isSameTypeContract';
import {
  SCALAR_ASSIGN_DIAGNOSTICS_ENABLED_DEFAULT,
  analyzeScalarAssignWrites,
  scalarAssignFindingToItem,
  type ScalarAssignDiagnosticItem
} from '../backend/scalarAssignCheck';
import { cellScriptRoleAndEntity, collectCellDataDefUniverseWithCategory, fetchCellDataKeys, resolveCellDataDeclAnchor, type CellDataRelatedLocation } from '../backend/cellDataCompletion';
import {
  cellDataKeyWorldOpen,
  trackCellDataKeys
} from '../backend/cellDataKeyTracking';
import {
  CELL_DATA_WRONG_KEY_DIAGNOSTICS_ENABLED_DEFAULT,
  cellDataWrongKeyFindingToItem,
  cellDataWrongKeyFindings,
  type CellDataWrongKeyDiagnosticItem
} from '../backend/cellDataWrongKey';
import {
  CELL_DATA_CALLBACK_DIAGNOSTICS_ENABLED_DEFAULT,
  cellDataCallbackFindingToItem,
  cellDataCallbackFindings,
  type CellDataCallbackDiagnosticItem
} from '../backend/cellDataCallbackCheck';
import { startLanguageServiceOperation } from '../languageServiceMetrics';
import { EntityMappingManager, pythonScriptDomain } from '../entityMapping';
import { PythonClassIndex } from '../backend/pythonClassIndex';
import { getWorkspaceRootForDocument, findDefinitionFileByCategory, findDefinitionTextByCategory, getEntityCustomTypesSnapshot } from '../definitionWorkspace';
import { getDefinitionWorkspaceLayout, listDefinitionFiles } from '../definitionWorkspace';
import { readSharedFileSnapshot } from '../sharedFileSnapshot';
import { isPythonMroJumpEnabled, validateDocument, validateEntitiesXmlDocument } from '../languageProviders';
import { DiagnosticScheduler, getDiagnosticScheduler } from '../backend/diagnosticScheduler';
import { validateProcessTopologyInRust } from '../backend/processTopologyRust';
import { mapFindingsToDiagnostics, type ProcessTopologyDiagnosticSpec } from '../backend/processTopologyDiagnostics';
import {
  STARTUP_SCRIPT_DIAGNOSTIC_CODE,
  STARTUP_SCRIPT_DIAGNOSTICS_ENABLED_DEFAULT,
  computeStartupScriptFindings,
  type StartupScriptFinding,
} from '../kbengineStartupScript';

/** 文档级诊断调度签名(didChange/open 事件面经返回句柄调用) */
type ScheduleDiagnostics = (document: vscode.TextDocument, channel: 'immediate' | 'queued') => void;

// KODE-AUD-001:进程拓扑诊断调度器是 activate 内局部实例(与其他四个同模式),
// 测试经此访问器断言「编辑事件→requestQueued→同节拍 flushQueued」接线
// (此前漏 flushQueued 致 queued 任务滞留不发布)。activate 每次装配覆写,
// 测试方置 null 释放(惯用法同 setHoverInFlightGateForTests)。
let processTopologySchedulerForTests: DiagnosticScheduler | null = null;
export function setProcessTopologySchedulerForTests(
  scheduler: DiagnosticScheduler | null
): void {
  processTopologySchedulerForTests = scheduler;
}
export function getProcessTopologySchedulerForTests(): DiagnosticScheduler | null {
  return processTopologySchedulerForTests;
}

export interface DiagnosticsDeps {
  context: vscode.ExtensionContext;
  entityMappingManager: EntityMappingManager;
  pythonClassIndex: PythonClassIndex;
  isDefDocument(document: vscode.TextDocument): boolean;
  isPythonDocument(document: vscode.TextDocument): boolean;
}

/** L3 产出的调度句柄/集合——文档事件面经组合根注入消费 */
export interface DiagnosticsShared {
  diagnostics: vscode.DiagnosticCollection;
  diagnosticScheduler: DiagnosticScheduler;
  scheduleDefDiagnostics: ScheduleDiagnostics;
  scheduleEntitiesDiagnostics: ScheduleDiagnostics;
  scheduleReceiverNoneDiagnostics: ScheduleDiagnostics;
  scheduleStartupScriptDiagnostics: ScheduleDiagnostics;
  scheduleDefMethodConsistencyDiagnostics: ScheduleDiagnostics;
  scheduleUserTypeContractDiagnostics: ScheduleDiagnostics;
  rescheduleUserTypeContractForRegistryChange(): void;
  schedulePropertyDirectionDiagnostics: ScheduleDiagnostics;
  scheduleReadOnlyWriteDiagnostics: ScheduleDiagnostics;
  scheduleRoleMisuseDiagnostics: ScheduleDiagnostics;
  schedulePostDestroyDiagnostics: ScheduleDiagnostics;
  scheduleCellDataWriteDiagnostics: ScheduleDiagnostics;
  scheduleSpaceDataProtectedKeyDiagnostics: ScheduleDiagnostics;
  scheduleFixedDictConstructDiagnostics: ScheduleDiagnostics;
  rescheduleFixedDictConstructForRegistryChange: () => void;
  scheduleProcessTopologyDiagnostics: ScheduleDiagnostics;
  defMethodConsistencyDiagnostics: vscode.DiagnosticCollection;
  defMethodConsistencyScheduler: DiagnosticScheduler;
  userTypeContractDiagnostics: vscode.DiagnosticCollection;
  userTypeContractScheduler: DiagnosticScheduler;
  propertyDirectionDiagnostics: vscode.DiagnosticCollection;
  propertyDirectionScheduler: DiagnosticScheduler;
  readOnlyWriteDiagnostics: vscode.DiagnosticCollection;
  readOnlyWriteScheduler: DiagnosticScheduler;
  roleMisuseDiagnostics: vscode.DiagnosticCollection;
  roleMisuseScheduler: DiagnosticScheduler;
  postDestroyDiagnostics: vscode.DiagnosticCollection;
  postDestroyScheduler: DiagnosticScheduler;
  cellDataWriteDiagnostics: vscode.DiagnosticCollection;
  cellDataWriteScheduler: DiagnosticScheduler;
  spaceDataProtectedKeyDiagnostics: vscode.DiagnosticCollection;
  spaceDataProtectedKeyScheduler: DiagnosticScheduler;
  fixedDictConstructDiagnostics: vscode.DiagnosticCollection;
  fixedDictConstructScheduler: DiagnosticScheduler;
  scheduleScalarAssignDiagnostics: ScheduleDiagnostics;
  rescheduleScalarAssignForRegistryChange: () => void;
  scalarAssignDiagnostics: vscode.DiagnosticCollection;
  scalarAssignScheduler: DiagnosticScheduler;
  scheduleCellDataWrongKeyDiagnostics: ScheduleDiagnostics;
  cellDataWrongKeyDiagnostics: vscode.DiagnosticCollection;
  cellDataWrongKeyScheduler: DiagnosticScheduler;
  scheduleCellDataCallbackDiagnostics: ScheduleDiagnostics;
  cellDataCallbackDiagnostics: vscode.DiagnosticCollection;
  cellDataCallbackScheduler: DiagnosticScheduler;
  retriggerCellDataDiagnosticsForDefChange: (defDocument: vscode.TextDocument) => void;
  processTopologyDiagnostics: vscode.DiagnosticCollection;
  processTopologyScheduler: DiagnosticScheduler;
}

export function activateDiagnostics(deps: DiagnosticsDeps): DiagnosticsShared {
  const { context, entityMappingManager, pythonClassIndex, isDefDocument, isPythonDocument } = deps;
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
        const config = vscode.workspace.getConfiguration('kbengine');
        const receiverEnabled = config
          .get<boolean>('receiverNoneDiagnostics', RECEIVER_NONE_DIAGNOSTICS_ENABLED_DEFAULT);
        // LANG-NAR-1:自管属性可能为 None 诊断(默认开,有 None 证据才报)
        const attrEnabled = config
          .get<boolean>('attributeNoneDiagnostics', ATTRIBUTE_NONE_DIAGNOSTICS_ENABLED_DEFAULT);
        const shouldContinue = () =>
          capturedVersion === undefined || document.version === capturedVersion;
        // IDE-DIA-003/IDE-REV-009:与类索引消费同一份版本键解析(惰性提供器
        // ——仅当确有 receiver 使用点过闸后才取解析,DIA-001 零使用点不解析
        // 语义保持);异步共享面 asyncDocumentParse——缓存命中直取,未命中走
        // updateFileResponsive(≥256KiB 进 worker,宿主不落整文件同步解析),
        // 返回 null(worker 停用/积压上限/版本代被并发编辑顶掉)时诊断中止
        // 本轮不发布,下一次事件重试;层2 关闭时索引不参与跳转,不喂索引,
        // 诊断自解析(receiverNoneDiagnostics 异步面同样 worker 分流,口径不变)
        const preparsed = isPythonMroJumpEnabled() && isPythonDocument(document)
          ? () => pythonClassIndex.asyncDocumentParse(document)
          : undefined;
        // IDE-LINT-008:实体/根映射快照(receiver 段错配与 RPC 实参数共用
        // 同一份;仅在 Python 文档且确需要时取,避免无谓快照)
        const entityMapping = isPythonDocument(document)
          ? entityMappingManager.getMappingForPythonFile(document.uri.fsPath)
          : undefined;
        const receiverItems = receiverEnabled
          // AUDIT-005 B2 批 3:Rust-first(`$/kode/lint/analyzeReceiverNone`,
          // 解析面与映射投影由 TS 供给,guard 分析在 Rust);不可用/解析中止/
          // 失败/畸形整面回 TS 异步兜底,不部分采用。
          ? (await buildReceiverNoneItemsWithRust(document.getText(), document.uri.fsPath, entityMapping, preparsed)
              ?? await receiverNoneDiagnosticItemsAsync(
                  document.getText(),
                  document.uri.fsPath,
                  entityMapping,
                  receiverEnabled,
                  preparsed,
                  { shouldContinue }
                ))
          : [];
        if (receiverItems === null) {
          return null; // 异步中止(worker 停用/版本前进),整轮不发布
        }
        const attrItems = attrEnabled && isPythonDocument(document)
          // KODE-PERF-001:文档版本键——同版本诊断/inlay 共享一次流解析?
          // 按实例身份版本成键(跨实例重开不撞;flowVersionKey.ts)?
          // AUDIT-005 B2 批 6:Rust-first(`$/kode/lint/analyzeAttributeNone`,
          // 预掩码文本词法扫描在 Rust;流敏感 None 证据/消息渲染留 TS);不可用/
          // 失败/畸形整面回 TS 兜底,禁止部分采用。
          ? ((await buildAttributeNoneItemsWithRust(
              document.getText(),
              flowVersionKeyForDocument(document)
            )
            ?? attributeNoneDiagnosticItems(
              document.getText(),
              undefined,
              flowVersionKeyForDocument(document)
            )).map(finding => ({
              range: {
                start: { line: finding.line, character: finding.character },
                end: { line: finding.line, character: finding.character + finding.member.length }
              },
              message: finding.message,
              severity: 'Warning' as const,
              source: 'kbengine' as const,
              code: ATTRIBUTE_NONE_DIAGNOSTIC_CODE
            })))
          : [];
        // SP-4: 空间/导航语义诊断(_mapping 保留键/navigate 无 canNavigate/
        // params 字符串层键)——纯文本行级扫描,与 receiver/attr 同通道发布。
        // AUDIT-005 B2 批 3:Rust-first(`$/kode/lint/analyzeSpaceNav`),不可用/
        // 失败/畸形整面回 TS 同步兜底(computeSpaceNavFindings),不部分采用。
        const spaceNavEnabled = config
          .get<boolean>('spaceNavDiagnostics', SPACE_NAV_DIAGNOSTICS_ENABLED_DEFAULT);
        const spaceNavFindings = spaceNavEnabled && isPythonDocument(document)
          ? (await buildSpaceNavItemsWithRust(document.getText())
              ?? computeSpaceNavFindings(document.getText()))
          : [];
        const spaceNavItems = spaceNavFindings.map(finding => ({
            range: {
              start: { line: finding.line, character: finding.start },
              end: { line: finding.line, character: finding.end }
            },
            message: finding.message,
            severity: 'Warning' as const,
            source: 'kbengine' as const,
            code: finding.code || SPACE_NAV_DIAGNOSTIC_CODE
          }));
        // IDE-LINT-008:RPC 实参数量 lint——调用点顶层实参数与 .def <Arg> 数
        // 对账,明确数量不符才报;星号实参/动态接收者/声明未就绪保留未知
        // (未知一律不报,不用 inlay 提示替代诊断面)。
        const rpcArgCountEnabled = config
          .get<boolean>('rpcArgCountDiagnostics', RPC_ARG_COUNT_DIAGNOSTICS_ENABLED_DEFAULT);
        const rpcArgCountItems = rpcArgCountEnabled
          // AUDIT-005 B2 批 8:Rust-first(`$/kode/lint/analyzeRpcArgCount`,
          // 发现面/语义闸/消息留 TS,实参计数面在 Rust);门不可用/失败/畸形
          // 整面回本地计数兜底,禁止部分采用。
          ? (await computeRpcArgCountFindingsAsync(
              document.getText(),
              entityMapping,
              pythonScriptDomain(document.uri.fsPath) ?? undefined
            )).map(finding => ({
              range: {
                start: { line: finding.line, character: finding.character },
                end: { line: finding.line, character: finding.character + finding.methodName.length }
              },
              message: finding.message,
              severity: 'Warning' as const,
              source: 'kbengine' as const,
              code: RPC_ARG_COUNT_DIAGNOSTIC_CODE
            }))
          : [];
        return [...receiverItems, ...attrItems, ...spaceNavItems, ...rpcArgCountItems];
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
          // B-7:稳定 code 随诊断发布,守卫 QuickFix 按此对账
          diagnostic.code = item.code;
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

  // KBEXP-1 启动脚本诊断(用户令 2026-11-02;KB-001 第六篇):对 .sh/.bat 启动
  // 脚本链里的服务器进程启动行做 未知 --xxx / --cid|--gus 非数字 / 缺必要
  // 环境 三类保守检查,severity=Warning,kbengine.startupScriptDiagnostics 开关
  // 默认开,与其它诊断共用 collection 与文档事件生命周期(compute 同步,行级
  // 纯文本扫描,零异步面)。
  const scheduleStartupScriptDiagnostics = (
    document: vscode.TextDocument,
    channel: 'immediate' | 'queued'
  ): void => {
    const options = {
      layer: 'local' as const,
      compute: (): readonly StartupScriptFinding[] => {
        const config = vscode.workspace.getConfiguration('kbengine');
        const enabled = config.get<boolean>(
          'startupScriptDiagnostics',
          STARTUP_SCRIPT_DIAGNOSTICS_ENABLED_DEFAULT
        );
        if (!enabled) {
          return [];
        }
        return computeStartupScriptFindings(document.getText());
      },
      publish: (items: readonly StartupScriptFinding[]) => {
        diagnostics.set(
          document.uri,
          items.map(item => {
            const diagnostic = new vscode.Diagnostic(
              new vscode.Range(item.line, item.start, item.line, item.end),
              item.message,
              vscode.DiagnosticSeverity.Warning
            );
            diagnostic.source = 'kbengine';
            diagnostic.code = item.code ?? STARTUP_SCRIPT_DIAGNOSTIC_CODE;
            return diagnostic;
          })
        );
      }
    };
    if (channel === 'queued') {
      diagnosticScheduler.requestQueued(document, options);
    } else {
      diagnosticScheduler.request(document, options);
    }
  };

  // 注册诊断检查器
  const diagnostics = vscode.languages.createDiagnosticCollection('kbengine');
  context.subscriptions.push(diagnostics);

  // 配置契约检查诊断(docs/analysis/intranet-env-audit.md §4/§5,用户会话
  // 建议序 #2):工作区「配置层」(.kbengine/debug.json / extraPaths /
  // .gitignore / CLAUDE.md·README 声明)此前 0 覆盖——内网开发机(D:\kbengine)
  // 暴露的 4 项配置层事故(extraPaths 双层上跳、.gitignore 缺 .kbengine/、
  // debug.json components 空且 telnet 段全注释、文档密码声明与实值冲突)只能
  // 人肉 review + 线上复现发现。本规则把此类 bug 变「打开/保存即报」:
  // 纯逻辑面 computeConfigContractFindings(零 vscode 依赖,存在性注入,
  // tests/configContractDiagnostics.test.ts 红先行),独立 collection(findings
  // 按目标文件分桶锚定),开关 kbengine.configContractDiagnostics 默认开。
  // 触发面 = 激活首扫 + 配置文件打开/保存即扫 + FileSystemWatcher 变更即重算
  // (与 DebugConfigManager.configWatcher 同款变更即重算模式)。
  // 门控:仅 .kbengine 托管目录在盘的工作区启用(debug.json 本就在 .kbengine/
  // 下),纯 Python/非 KBEngine 工作区零噪声。
  const configContractRootFolder = vscode.workspace.workspaceFolders?.[0];
  if (configContractRootFolder) {
    const configContractCollection = vscode.languages.createDiagnosticCollection(
      'kbengine-config-contract'
    );
    context.subscriptions.push(configContractCollection);
    const configContractFileBasenames = new Set([
      'debug.json', 'settings.json', '.gitignore', 'CLAUDE.md', 'README.md', 'README.zh.md'
    ]);
    const isConfigContractFile = (document: vscode.TextDocument): boolean =>
      configContractFileBasenames.has(path.basename(document.uri.fsPath));
    let configContractPublishedUris = new Set<string>();
    let configContractScanSeq = 0;
    const clearConfigContractDiagnostics = (): void => {
      for (const uri of configContractPublishedUris) {
        configContractCollection.delete(vscode.Uri.parse(uri));
      }
      configContractPublishedUris = new Set();
    };
    const scanConfigContractDiagnostics = async (): Promise<void> => {
      const root = configContractRootFolder.uri.fsPath;
      const seq = ++configContractScanSeq;
      const enabled = vscode.workspace.getConfiguration('kbengine')
        .get<boolean>('configContractDiagnostics', CONFIG_CONTRACT_DIAGNOSTICS_ENABLED_DEFAULT);
      if (!enabled || !fs.existsSync(path.join(root, '.kbengine'))) {
        // 开关关闭 / 非 KBEngine 托管工作区:清空既有诊断,零产出
        if (configContractPublishedUris.size > 0) {
          clearConfigContractDiagnostics();
        }
        return;
      }
      const readIfExists = (rel: string): string | undefined => {
        try {
          const full = path.join(root, rel);
          return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : undefined;
        } catch {
          return undefined;
        }
      };
      const debugJsonExists = fs.existsSync(path.join(root, '.kbengine', 'debug.json'));
      const extraPaths = vscode.workspace.getConfiguration('python', configContractRootFolder)
        .get<string[]>('analysis.extraPaths') ?? [];
      const findings = computeConfigContractFindings({
        debugJson: debugJsonExists
          ? { exists: true, text: readIfExists('.kbengine/debug.json') }
          : { exists: false },
        extraPaths,
        // 相对条目按工作区根解析(与 Pylance 的根基准语义一致);CFG-02 起
        // 生成面写 ${workspaceFolder}/... 变量形态,先展开前缀再解析
        extraPathExists: (entry) => {
          const relative = entry.startsWith('${workspaceFolder}')
            ? entry.slice('${workspaceFolder}'.length).replace(/^[\\/]+/, '')
            : entry;
          return fs.existsSync(path.resolve(root, relative));
        },
        gitignore: fs.existsSync(path.join(root, '.gitignore'))
          ? { exists: true, text: readIfExists('.gitignore') }
          : { exists: false },
        docs: (['CLAUDE.md', 'README.md', 'README.zh.md'])
          .map(name => ({ name, text: readIfExists(name) }))
          .filter((doc): doc is { name: string; text: string } => typeof doc.text === 'string'),
        enabled
      });
      // 版本代守卫:扫描期间又来了新触发,旧回包丢弃(新触发会重算)
      if (seq !== configContractScanSeq) {
        return;
      }
      const nextUris = new Set<string>();
      for (const fileName of new Set(findings.map(f => f.file))) {
        const groupFindings = findings.filter(f => f.file === fileName);
        // finding.file 是展示名;锚定 URI 回工作区真实路径
        const relPath = fileName === 'debug.json'
          ? '.kbengine/debug.json'
          : fileName === 'settings.json'
            ? '.vscode/settings.json'
            : fileName;
        const uri = vscode.Uri.joinPath(configContractRootFolder.uri, relPath);
        nextUris.add(uri.toString());
        configContractCollection.set(uri, groupFindings.map(f => {
          const diagnostic = new vscode.Diagnostic(
            new vscode.Range(f.line, f.character, f.line, f.character + 1),
            f.message,
            vscode.DiagnosticSeverity.Warning
          );
          diagnostic.source = 'kbengine';
          diagnostic.code = f.code;
          return diagnostic;
        }));
      }
      for (const uri of configContractPublishedUris) {
        if (!nextUris.has(uri)) {
          configContractCollection.delete(vscode.Uri.parse(uri));
        }
      }
      configContractPublishedUris = nextUris;
    };
    // 激活首扫(fire-and-forget,不阻塞激活)
    void scanConfigContractDiagnostics();
    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(document => {
      if (isConfigContractFile(document)) {
        void scanConfigContractDiagnostics();
      }
    }));
    context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(document => {
      if (isConfigContractFile(document)) {
        void scanConfigContractDiagnostics();
      }
    }));
    // 变更即重算:与 DebugConfigManager.configWatcher 同款模式;brace 模式
    // 一发覆盖六个契约文件(.kbengine/debug.json 变更即重算为主路径)
    const configContractWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(
        configContractRootFolder,
        '{.kbengine/debug.json,.gitignore,.vscode/settings.json,CLAUDE.md,README.md,README.zh.md}'
      )
    );
    configContractWatcher.onDidChange(() => void scanConfigContractDiagnostics());
    configContractWatcher.onDidCreate(() => void scanConfigContractDiagnostics());
    configContractWatcher.onDidDelete(() => void scanConfigContractDiagnostics());
    context.subscriptions.push(configContractWatcher);
    // 开关切换即重算(关→清集合零产出;开→立即重扫),独立于
    // diagnosticScheduler 的文档级重算路径(本规则是工作区级)
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('kbengine.configContractDiagnostics')) {
        void scanConfigContractDiagnostics();
      }
    }));
  }

  // C-19 交付①:def↔Python 方法一致性诊断。正向 def-method-missing-in-python
  // (def 有 Python 无,默认开;code=Rust lint 规则 id,与 CodeAction 同值
  // KODE-AUD-002)定位 def 方法
  // 行并关联目标 Python 文件与类名;反向 python-method-not-in-def(Python 有
  // def 无,默认关防误报,kbengine.pythonMethodNotInDef)定位 Python 方法行。
  // 专用 collection(整组替换)——与主 collection 的 .def 结构诊断互不覆写,
  // 重算即整文档替换,方法补实现后诊断自然消除(生成后重算经 CodeAction 命令
  // 与 Python 改动钩子双路)。计算走实体映射索引(ensureIndexByDefFile +
  // listMethodImplementationsByIdentity 同一实现查询面),版本令牌守卫由调度器
  // 承担;索引不可用/开关关闭一律静默无诊断。
  // 独立调度器:diagnosticScheduler 每 URI 单排队槽(one-pipeline-per-document),
  // 主 .def 结构诊断已占该槽——同一文档再 requestQueued 会顶掉主任务致结构
  // 诊断永不算(且 immediate 通道同版本会被 skippedCurrentVersion 跳过)。
  // 故一致性管线独立建调度器,各自保版本/关闭代/输入代守卫,互不挤占。
  const defMethodConsistencyDiagnostics = vscode.languages.createDiagnosticCollection(
    'kbengine-def-method-consistency'
  );
  context.subscriptions.push(defMethodConsistencyDiagnostics);
  const defMethodConsistencyScheduler = new DiagnosticScheduler();
  const scheduleDefMethodConsistencyDiagnostics = (
    document: vscode.TextDocument,
    channel: 'immediate' | 'queued'
  ): void => {
    const capturedVersion = document.version;
    const isDef = isDefDocument(document);
    const isPython = isPythonDocument(document);
    if (!isDef && !isPython) {
      return;
    }
    const options = {
      layer: 'local' as const,
      computeAsync: async (): Promise<readonly vscode.Diagnostic[] | null> => {
        const config = vscode.workspace.getConfiguration('kbengine');
        if (isDef) {
          const enabled = config.get<boolean>('diagnostics.checkDefMethodMissingInPython', true);
          if (!enabled || document.version !== capturedVersion) {
            return [];
          }
          const gaps = await entityMappingManager.collectDefMethodImplementationGaps(
            document.uri.fsPath
          );
          return collectDefMethodMissingItems(document.getText(), gaps).map(item => {
            const diagnostic = new vscode.Diagnostic(
              new vscode.Range(
                document.positionAt(item.startOffset),
                document.positionAt(item.endOffset)
              ),
              item.message,
              vscode.DiagnosticSeverity.Warning
            );
            diagnostic.code = DEF_METHOD_MISSING_DIAGNOSTIC_CODE;
            if (item.related.targetFile) {
              diagnostic.relatedInformation = [
                new vscode.DiagnosticRelatedInformation(
                  new vscode.Location(
                    vscode.Uri.file(item.related.targetFile),
                    new vscode.Range(0, 0, 0, 0)
                  ),
                  item.related.label
                )
              ];
            }
            return diagnostic;
          });
        }
        // python 文档:反向规则(默认关)
        const reverseEnabled = config.get<boolean>('diagnostics.checkPythonMethodNotInDef', false);
        if (!reverseEnabled || document.version !== capturedVersion) {
          return [];
        }
        const gaps = entityMappingManager.collectPythonMethodNotInDef(document.uri.fsPath);
        return collectPythonMethodNotInDefItems(gaps).map(item => {
          const diagnostic = new vscode.Diagnostic(
            new vscode.Range(
              new vscode.Position(item.line - 1, item.character),
              new vscode.Position(item.line - 1, item.character + item.length)
            ),
            item.message,
            vscode.DiagnosticSeverity.Warning
          );
          diagnostic.code = PYTHON_METHOD_NOT_IN_DEF_DIAGNOSTIC_CODE;
          return diagnostic;
        });
      },
      publish: (items: readonly vscode.Diagnostic[]) => {
        defMethodConsistencyDiagnostics.set(document.uri, items);
      }
    };
    if (channel === 'queued') {
      defMethodConsistencyScheduler.requestQueued(document, options);
    } else {
      defMethodConsistencyScheduler.request(document, options);
    }
  };

  // C-19 交付②:CodeAction 应用后重算源 def 文档缺实现诊断(诊断消除)。
  // VS Code 先应用 action.edit 再执行本命令;按 def URI 重排一致性计算,
  // 不依赖 Python 文件是否打开(编辑作用于磁盘文件时文档事件不必然触发)。
  const defMethodConsistencyRevalidateCommand = vscode.commands.registerCommand(
    KBENGINE_DEF_METHOD_CONSISTENCY_REVALIDATE_COMMAND,
    (defUri: string) => {
      const document = vscode.workspace.textDocuments.find(
        candidate => candidate.uri.toString() === defUri
      );
      if (document && isDefDocument(document)) {
        scheduleDefMethodConsistencyDiagnostics(document, 'immediate');
      }
    }
  );
  context.subscriptions.push(defMethodConsistencyRevalidateCommand);

  // GEN-DEF-1e:user_type 三契约方法缺方法预警(impl 类缺 createObjFromDict/
  // getDictFromObj/isSameType → 引擎装载实现模块必失败)。独立诊断集合 +
  // 独立调度器(共享调度器每 URI 单排队槽,同 C-19 范式)。诊断锚定在
  // impl python 文件符号行;types.xml/alias.xml 变更联动重排全部 impl 文件。
  const userTypeContractDiagnostics = vscode.languages.createDiagnosticCollection(
    'kbengine-user-type-contract'
  );
  context.subscriptions.push(userTypeContractDiagnostics);
  const userTypeContractScheduler = new DiagnosticScheduler();
  const scheduleUserTypeContractDiagnostics = (
    document: vscode.TextDocument,
    channel: 'immediate' | 'queued'
  ): void => {
    if (!isPythonDocument(document)) {
      return;
    }
    const capturedVersion = document.version;
    const options = {
      layer: 'local' as const,
      computeAsync: async (): Promise<readonly vscode.Diagnostic[] | null> => {
        const workspaceRoot = getWorkspaceRootForDocument(document);
        if (!workspaceRoot || document.version !== capturedVersion) {
          return [];
        }
        const statuses = collectUserTypeContractStatuses(workspaceRoot);
        // 批 4:探测/收集核收编 Rust(`$/kode/python/userTypeContract`),
        // Rust-first + TS collectUserTypeContractMissingByImplFile 兜底
        const items =
          (await collectUserTypeContractMissingByImplFileFromRust(
            statuses,
            document.uri.fsPath
          )) ?? collectUserTypeContractMissingByImplFile(
            statuses,
            document.uri.fsPath
          );
        const text = document.getText();
        const lineStarts = computeLineStarts(text);
        return items.map(item => {
          const lineIndex = Math.min(Math.max(item.line - 1, 0), Math.max(lineStarts.length - 1, 0));
          const start = lineStarts[lineIndex];
          const end = start + item.symbolLength;
          const diagnostic = new vscode.Diagnostic(
            new vscode.Range(
              document.positionAt(start),
              document.positionAt(end)
            ),
            item.message,
            vscode.DiagnosticSeverity.Error
          );
          diagnostic.code = USER_TYPE_CONTRACT_MISSING_DIAGNOSTIC_CODE;
          diagnostic.relatedInformation = [
            new vscode.DiagnosticRelatedInformation(
              new vscode.Location(
                vscode.Uri.file(item.related.targetFile),
                new vscode.Range(0, 0, 0, 0)
              ),
              item.related.label
            )
          ];
          return diagnostic;
        });
      },
      publish: (items: readonly vscode.Diagnostic[]) => {
        userTypeContractDiagnostics.set(document.uri, items);
      }
    };
    if (channel === 'queued') {
      userTypeContractScheduler.requestQueued(document, options);
    } else {
      userTypeContractScheduler.request(document, options);
    }
  };

  /** 类型注册表(types.xml/alias.xml)变更:契约输入变,重排全部已打开 impl 文件。 */
  const rescheduleUserTypeContractForRegistryChange = (): void => {
    for (const doc of vscode.workspace.textDocuments) {
      if (isPythonDocument(doc)) {
        scheduleUserTypeContractDiagnostics(doc, 'queued');
      }
    }
  };

  // GEN-DEF-1e ④:方向违规诊断(属性面)——self.<属性> / self.<role>.<属性>
  // 访问位置不在 def 属性 Flags 域位内 → Warning;文件作用域不足 → Information
  // (不标 Error)。独立诊断集合 + 独立调度器(同 C-19/user_type 范式);属性域
  // 位经 EntityMappingManager.resolvePropertyDefinitionInfo(与属性 CodeLens
  // 同索引同口径)。开关 kbengine.propertyDirectionDiagnostics 默认开。
  const propertyDirectionDiagnostics = vscode.languages.createDiagnosticCollection(
    'kbengine-property-direction'
  );
  context.subscriptions.push(propertyDirectionDiagnostics);
  const propertyDirectionScheduler = new DiagnosticScheduler();
  const schedulePropertyDirectionDiagnostics = (
    document: vscode.TextDocument,
    channel: 'immediate' | 'queued'
  ): void => {
    if (!isPythonDocument(document)) {
      return;
    }
    const capturedVersion = document.version;
    const options = {
      layer: 'local' as const,
      computeAsync: async (): Promise<readonly PropertyDirectionDiagnosticItem[] | null> => {
        if (document.version !== capturedVersion) {
          return [];
        }
        const enabled = vscode.workspace.getConfiguration('kbengine')
          .get<boolean>('propertyDirectionDiagnostics', PROPERTY_DIRECTION_DIAGNOSTICS_ENABLED_DEFAULT);
        const resolve = async (
          propertyPath: string,
          rootSymbol: string
        ): Promise<PropertyDirectionHit | null | undefined> => {
          const info = await entityMappingManager.resolvePropertyDefinitionInfo(
            document.uri.fsPath,
            propertyPath,
            rootSymbol
          );
          if (!info) {
            return null;
          }
          return {
            propertyName: info.identity.symbolName,
            domains: info.domains,
            defFile: info.defFile,
            defLine: info.line,
            typeName: info.typeName
          };
        };
        // AUDIT-005 B2 批 7:Rust-first(`$/kode/lint/analyzePropertyDirection`
        // 三扫描束;方向分类/影子抑制/cellData 两流判定与消息渲染留 TS);束不可
        // 用/畸形回本地扫描束,判定核零分叉。
        return propertyDirectionDiagnosticItemsAsync(
          document.getText(),
          document.uri.fsPath,
          resolve,
          enabled,
          (await buildPropertyDirectionScanBundleWithRust(document.getText())) ?? undefined
        );
      },
      publish: (items: readonly PropertyDirectionDiagnosticItem[]) => {
        propertyDirectionDiagnostics.set(document.uri, items.map(item => {
          const diagnostic = new vscode.Diagnostic(
            new vscode.Range(
              item.range.start.line, item.range.start.character,
              item.range.end.line, item.range.end.character
            ),
            item.message,
            item.severity === 'Information'
              ? vscode.DiagnosticSeverity.Information
              : vscode.DiagnosticSeverity.Warning
          );
          diagnostic.source = item.source;
          diagnostic.code = item.code;
          return diagnostic;
        }));
      }
    };
    if (channel === 'queued') {
      propertyDirectionScheduler.requestQueued(document, options);
    } else {
      propertyDirectionScheduler.request(document, options);
    }
  };
  // IDE-LINT-007:基于引擎属性表的只读写入诊断(独立集合,与方向违规同族
  // 生命周期)。实体身份/角色判定复用内建属性表面解析(目录域优先,判不出
  // 经 entityMappingManager.getEntityComponentFacesForPythonFile 取 def 归属)。
  const readOnlyWriteDiagnostics = vscode.languages.createDiagnosticCollection(
    'kbengine-readonly-write'
  );
  context.subscriptions.push(readOnlyWriteDiagnostics);
  const readOnlyWriteScheduler = new DiagnosticScheduler();
  const scheduleReadOnlyWriteDiagnostics = (
    document: vscode.TextDocument,
    channel: 'immediate' | 'queued'
  ): void => {
    if (!isPythonDocument(document)) {
      return;
    }
    const capturedVersion = document.version;
    const options = {
      layer: 'local' as const,
      computeAsync: async (): Promise<readonly ReadOnlyWriteDiagnosticItem[] | null> => {
        if (document.version !== capturedVersion) {
          return [];
        }
        const enabled = vscode.workspace.getConfiguration('kbengine')
          .get<boolean>('readOnlyWriteDiagnostics', READONLY_WRITE_DIAGNOSTICS_ENABLED_DEFAULT);
        const fetchDefFaces = () =>
          entityMappingManager.getEntityComponentFacesForPythonFile(document.uri.fsPath);
        // AUDIT-005 批 5:Rust-first(`$/kode/lint/analyzeReadOnlyWrite`,只读名集
        // TS 供给;写入形态分类/掩码扫描在 Rust);不可用/畸形整面回 TS 兜底。
        return (await buildReadOnlyWriteItemsWithRust(
            document.getText(),
            document.uri.fsPath,
            fetchDefFaces
          )
          ?? await readOnlyWriteDiagnosticItemsAsync(
            document.getText(),
            document.uri.fsPath,
            fetchDefFaces,
            enabled
          ));
      },
      publish: (items: readonly ReadOnlyWriteDiagnosticItem[]) => {
        readOnlyWriteDiagnostics.set(document.uri, items.map(item => {
          const diagnostic = new vscode.Diagnostic(
            new vscode.Range(
              item.range.start.line, item.range.start.character,
              item.range.end.line, item.range.end.character
            ),
            item.message,
            vscode.DiagnosticSeverity.Warning
          );
          diagnostic.source = item.source;
          diagnostic.code = item.code;
          return diagnostic;
        }));
      }
    };
    if (channel === 'queued') {
      readOnlyWriteScheduler.requestQueued(document, options);
    } else {
      readOnlyWriteScheduler.request(document, options);
    }
  };
  // IDE-LINT-009:已确认角色的引擎内建属性错用诊断(独立集合,与只读写入
  // 同族生命周期)。角色判定复用内建属性表面解析(目录域优先,判不出经
  // getEntityComponentFacesForPythonFile 取 def 归属),属性面表复用同一张
  // 引擎属性表——hover 元数据与 lint 共用来源;角色不明/非实体脚本不猜。
  const roleMisuseDiagnostics = vscode.languages.createDiagnosticCollection(
    'kbengine-role-misuse'
  );
  context.subscriptions.push(roleMisuseDiagnostics);
  const roleMisuseScheduler = new DiagnosticScheduler();
  const scheduleRoleMisuseDiagnostics = (
    document: vscode.TextDocument,
    channel: 'immediate' | 'queued'
  ): void => {
    if (!isPythonDocument(document)) {
      return;
    }
    const capturedVersion = document.version;
    const options = {
      layer: 'local' as const,
      computeAsync: async (): Promise<readonly RoleMisuseDiagnosticItem[] | null> => {
        if (document.version !== capturedVersion) {
          return [];
        }
        const enabled = vscode.workspace.getConfiguration('kbengine')
          .get<boolean>('roleMisuseDiagnostics', ROLE_MISUSE_DIAGNOSTICS_ENABLED_DEFAULT);
        return roleMisuseDiagnosticItemsAsync(
          document.getText(),
          document.uri.fsPath,
          () => entityMappingManager.getEntityComponentFacesForPythonFile(document.uri.fsPath),
          enabled
        );
      },
      publish: (items: readonly RoleMisuseDiagnosticItem[]) => {
        roleMisuseDiagnostics.set(document.uri, items.map(item => {
          const diagnostic = new vscode.Diagnostic(
            new vscode.Range(
              item.range.start.line, item.range.start.character,
              item.range.end.line, item.range.end.character
            ),
            item.message,
            vscode.DiagnosticSeverity.Warning
          );
          diagnostic.source = item.source;
          diagnostic.code = item.code;
          return diagnostic;
        }));
      }
    };
    if (channel === 'queued') {
      roleMisuseScheduler.requestQueued(document, options);
    } else {
      roleMisuseScheduler.request(document, options);
    }
  };
  // IDE-LINT-010:Entity 销毁后访问诊断(独立集合,与只读写入/角色错用同族
  // 生命周期)。同函数同块内确定的 `self.destroy()` 后直接访问 `self.<成员>`
  // 报 Warning;def 声明 destroy(动态分派边界)经 getMappingForPythonFile 判
  // → 整文件不分析;跨回调/异常/跨块不猜。
  const postDestroyDiagnostics = vscode.languages.createDiagnosticCollection(
    'kbengine-post-destroy'
  );
  context.subscriptions.push(postDestroyDiagnostics);
  const postDestroyScheduler = new DiagnosticScheduler();
  const schedulePostDestroyDiagnostics = (
    document: vscode.TextDocument,
    channel: 'immediate' | 'queued'
  ): void => {
    if (!isPythonDocument(document)) {
      return;
    }
    const capturedVersion = document.version;
    const options = {
      layer: 'local' as const,
      computeAsync: async (): Promise<readonly PostDestroyDiagnosticItem[] | null> => {
        if (document.version !== capturedVersion) {
          return [];
        }
        const enabled = vscode.workspace.getConfiguration('kbengine')
          .get<boolean>('postDestroyDiagnostics', POST_DESTROY_DIAGNOSTICS_ENABLED_DEFAULT);
        const fetchDefFaces = () =>
          entityMappingManager.getEntityComponentFacesForPythonFile(document.uri.fsPath);
        const isDestroyDeclared = () => {
          const mapping = entityMappingManager.getMappingForPythonFile(document.uri.fsPath);
          return Boolean(
            mapping && (mapping.methods.destroy || mapping.properties.destroy)
          );
        };
        // AUDIT-005 批 4:Rust-first(`$/kode/lint/analyzePostDestroy`,语句面 TS
        // 供给;块/销毁/早退/访问点分析在 Rust);不可用/畸形整面回 TS 兜底。
        return (await buildPostDestroyItemsWithRust(
            document.getText(),
            document.uri.fsPath,
            fetchDefFaces,
            isDestroyDeclared
          )
          ?? await postDestroyDiagnosticItemsAsync(
            document.getText(),
            document.uri.fsPath,
            fetchDefFaces,
            isDestroyDeclared,
            enabled
          ));
      },
      publish: (items: readonly PostDestroyDiagnosticItem[]) => {
        postDestroyDiagnostics.set(document.uri, items.map(item => {
          const diagnostic = new vscode.Diagnostic(
            new vscode.Range(
              item.range.start.line, item.range.start.character,
              item.range.end.line, item.range.end.character
            ),
            item.message,
            vscode.DiagnosticSeverity.Warning
          );
          diagnostic.source = item.source;
          diagnostic.code = item.code;
          return diagnostic;
        }));
      }
    };
    if (channel === 'queued') {
      postDestroyScheduler.requestQueued(document, options);
    } else {
      postDestroyScheduler.request(document, options);
    }
  };

  // KSEM-CELL-08:cellData 已知字段写入类型校验(独立集合,键宇宙与读型提示
  // 同源 CELL-04)。已知键的字面量赋值按声明类型校验引擎标量结构(datatypes.cpp
  // 注册表)与取值范围;RHS 整段字面量才判,未知键/非标量类型/推不出的值不猜;
  // 别名接收者经 CELL-07 最近赋值核定,重绑定后不查(逃逸不影响写型)。
  const cellDataWriteDiagnostics = vscode.languages.createDiagnosticCollection(
    'kbengine-celldata-write'
  );
  context.subscriptions.push(cellDataWriteDiagnostics);
  const cellDataWriteScheduler = new DiagnosticScheduler();
  const scheduleCellDataWriteDiagnostics = (
    document: vscode.TextDocument,
    channel: 'immediate' | 'queued'
  ): void => {
    if (!isPythonDocument(document)) {
      return;
    }
    const capturedVersion = document.version;
    const options = {
      layer: 'local' as const,
      computeAsync: async (): Promise<readonly CellDataWriteDiagnosticItem[] | null> => {
        if (document.version !== capturedVersion) {
          return [];
        }
        const enabled = vscode.workspace.getConfiguration('kbengine')
          .get<boolean>('cellDataWriteDiagnostics', CELL_DATA_WRITE_DIAGNOSTICS_ENABLED_DEFAULT);
        if (!enabled) {
          return [];
        }
        const role = cellScriptRoleAndEntity(document.fileName);
        if (!role) {
          return []; // client/bots/其他角色:cellData 面不可达
        }
        // KSEM-CELL-15:def 文本走脏 overlay 读取——未保存的 def 编辑立即进键宇宙
        const defs = collectCellDataDefUniverseWithCategory(role.entity, (name, category) =>
          findDefinitionTextByCategory(name, category, document));
        const entries = await fetchCellDataKeys(role.entity, defs);
        if (!entries || entries.length === 0) {
          return []; // Rust 不可用/畸形/实体缺:不造键,不出诊断
        }
        // KSEM-CELL-14:声明锚点关联跳转(仅 def 字段面;内建引擎证据路径
        // 不是工作区文件,不造假跳转)。line 已转 0 基 vscode 口径。
        return analyzeCellDataFieldWrites(document.getText(), entries).map(finding => {
          const anchor = resolveCellDataDeclAnchor(finding.declaredFile, defs, (name, category) =>
            findDefinitionFileByCategory(name, category, document));
          const related: CellDataRelatedLocation | undefined =
            anchor && finding.declaredLine != null
              ? {
                file: anchor.file,
                line: Math.max(0, finding.declaredLine - 1),
                label: `字段 ${finding.key} 声明 · ${finding.declaredFile}:${finding.declaredLine}`
              }
              : undefined;
          return cellDataWriteFindingToItem(finding, related);
        });
      },
      publish: (items: readonly CellDataWriteDiagnosticItem[]) => {
        cellDataWriteDiagnostics.set(document.uri, items.map(item => {
          const diagnostic = new vscode.Diagnostic(
            new vscode.Range(
              item.range.start.line, item.range.start.character,
              item.range.end.line, item.range.end.character
            ),
            item.message,
            vscode.DiagnosticSeverity.Warning
          );
          diagnostic.source = item.source;
          diagnostic.code = item.code;
          if (item.related) {
            diagnostic.relatedInformation = [
              new vscode.DiagnosticRelatedInformation(
                new vscode.Location(
                  vscode.Uri.file(item.related.file),
                  new vscode.Range(item.related.line, 0, item.related.line, 0)
                ),
                item.related.label
              )
            ];
          }
          return diagnostic;
        }));
      }
    };
    if (channel === 'queued') {
      cellDataWriteScheduler.requestQueued(document, options);
    } else {
      cellDataWriteScheduler.request(document, options);
    }
  };

  // KSEM-DATA-06:spaceData 保护键写入诊断(_mapping)。引擎 AssertionError
  // 契约的静态呈现:set/del 大小写不敏感拒(spacememory.cpp:740-742/:862-864),
  // get 放行(几何映射引擎自读路径,不发);键保护与 spaceID 可解性正交,
  // 动态 spaceID 照报。独立集合 + 独立调度器(同 C-19 范式);开关
  // kbengine.spaceDataProtectedKeyDiagnostics 默认开。
  const spaceDataProtectedKeyDiagnostics = vscode.languages.createDiagnosticCollection(
    'kbengine-space-data-protected-key'
  );
  context.subscriptions.push(spaceDataProtectedKeyDiagnostics);
  const spaceDataProtectedKeyScheduler = new DiagnosticScheduler();
  const scheduleSpaceDataProtectedKeyDiagnostics = (
    document: vscode.TextDocument,
    channel: 'immediate' | 'queued'
  ): void => {
    if (!isPythonDocument(document)) {
      return;
    }
    const capturedVersion = document.version;
    const options = {
      layer: 'local' as const,
      computeAsync: async (): Promise<readonly SpaceDataProtectedKeyDiagnosticItem[] | null> => {
        if (document.version !== capturedVersion) {
          return [];
        }
        const enabled = vscode.workspace.getConfiguration('kbengine')
          .get<boolean>('spaceDataProtectedKeyDiagnostics', SPACE_DATA_PROTECTED_KEY_DIAGNOSTICS_ENABLED_DEFAULT);
        if (!enabled) {
          return [];
        }
        return analyzeSpaceDataProtectedKeys(document.getText(), getKbeAliases(document.getText()));
      },
      publish: (items: readonly SpaceDataProtectedKeyDiagnosticItem[]) => {
        spaceDataProtectedKeyDiagnostics.set(document.uri, items.map(item => {
          const diagnostic = new vscode.Diagnostic(
            new vscode.Range(
              item.range.start.line, item.range.start.character,
              item.range.end.line, item.range.end.character
            ),
            item.message,
            vscode.DiagnosticSeverity.Error
          );
          diagnostic.source = item.source;
          diagnostic.code = item.code;
          return diagnostic;
        }));
      }
    };
    if (channel === 'queued') {
      spaceDataProtectedKeyScheduler.requestQueued(document, options);
    } else {
      spaceDataProtectedKeyScheduler.request(document, options);
    }
  };

  // KSEM-STRUCT-04:FIXED_DICT 构造点诊断(缺键/多键/字段值结构)。确定结构
  // 消费点 = 赋值目标可解析为 FD 容器(`self.<属性> = {…}` /
  // `self.<属性>["键"]… = {…}`,键链复用 STRUCT-02 单一解析链);普通 dict
  // 目标不套封闭约束。数据源 = CustomTypeInfo 注册表 + def 属性定型
  // (resolvePropertyDefinitionInfo,与属性 CodeLens 同索引同口径)。开关
  // kbengine.fixedDictConstructDiagnostics 默认开;独立诊断集合 + 独立
  // 调度器(同 C-19/cellData 族范式)。
  const fixedDictConstructDiagnostics = vscode.languages.createDiagnosticCollection(
    'kbengine-fixeddict-construct'
  );
  context.subscriptions.push(fixedDictConstructDiagnostics);
  const fixedDictConstructScheduler = new DiagnosticScheduler();
  const scheduleFixedDictConstructDiagnostics = (
    document: vscode.TextDocument,
    channel: 'immediate' | 'queued'
  ): void => {
    if (!isPythonDocument(document)) {
      return;
    }
    const capturedVersion = document.version;
    const options = {
      layer: 'local' as const,
      computeAsync: async (): Promise<readonly FixedDictConstructDiagnosticItem[] | null> => {
        if (document.version !== capturedVersion) {
          return [];
        }
        const enabled = vscode.workspace.getConfiguration('kbengine')
          .get<boolean>('fixedDictConstructDiagnostics', FIXED_DICT_CONSTRUCT_DIAGNOSTICS_ENABLED_DEFAULT);
        if (!enabled) {
          return [];
        }
        const workspaceRoot = getWorkspaceRootForDocument(document) ?? '';
        const customTypes = getEntityCustomTypesSnapshot(workspaceRoot);
        if (customTypes.length === 0) {
          return []; // types.xml 不可解析:注册表空,不造诊断
        }
        const findings = await analyzeFixedDictConstructWrites(
          document.getText(),
          async propertyName => {
            const info = await entityMappingManager.resolvePropertyDefinitionInfo(
              document.uri.fsPath,
              propertyName,
              propertyName
            );
            return info?.typeName ?? null;
          },
          customTypes
        );
        const items = findings.map(fixedDictConstructFindingToItem);
        // KSEM-SER-03:序列化出口面——本文档是某 FD user_type 的 impl 文件时,
        // getDictFromObj 返回 dict 对 schema 校验(缺键/多键/字段值结构;引擎
        // 对缺键/错型静默写默认值,datatype.cpp addToStreamEx)。绑定未成立的
        // (implementedBy 未解析/指他文件)不进判定面。
        const implBindings = implBindingsForDocument(
          customTypes, document.uri.fsPath
        );
        if (implBindings.length > 0) {
          const docText = document.getText();
          const createInputs = resolveCreateObjFromDictInputBindings(docText, implBindings);
          items.push(
            ...computeGetDictFromObjReturnFindings(docText, implBindings)
              .map(fixedDictReturnFindingToItem)
          );
          // KSEM-SER-04:序列化入口面——入参 wire 字典的键读取对 schema 校验
          // (未声明键引擎侧抛 KeyError/.get 静默返默认,静态面唯一可见处)
          items.push(
            ...computeCreateObjFromDictInputKeyFindings(
              docText,
              createInputs,
              customTypes
            ).map(createObjFromDictInputFindingToItem)
          );
          // KSEM-SER-05:转换输出对象成员面——createObjFromDict 可解析返回
          // (字面量/透传)推导输出结构,getDictFromObj 体内 obj 入参成员读取
          // 对键集校验(缺成员序列化时引擎整体按默认值顶替;自定义转换不凭
          // 函数名推定结构)
          items.push(
            ...computeConvertedObjMemberFindings(
              docText,
              createInputs,
              resolveImplMethodInputs(docText, implBindings, 'getDictFromObj'),
              customTypes
            ).map(convertedObjMemberFindingToItem)
          );
          // KSEM-SER-06:转换往返字段对应面——getDictFromObj 可解析产出键集
          // 与 createObjFromDict 可解析读取键集静态对拍(差集=遗漏/错误字段
          // 映射;值往返/语义等价不静态断言,运行时样本属 SER-14 车道)
          items.push(
            ...computeRoundTripFieldFindings(
              docText,
              createInputs,
              resolveImplMethodInputs(docText, implBindings, 'getDictFromObj')
            ).map(roundTripFieldFindingToItem)
          );
          // KSEM-SER-07:isSameType 契约边界面——签名对引擎单位置实参
          // 绑定的静态裁定(不符=每次判定 TypeError,Warning)+ 返回值
          // 兼容性证明状态(恒 True 短路免检 / 非 True 常量恒被引擎无视
          // 回落内建 / 动态返回=待运行验证,Information;引擎按指针恒等
          // 只认 True,datatype.cpp :2458/:2497-2512)
          items.push(
            ...computeSameTypeFindings(
              docText,
              resolveImplMethodInputs(docText, implBindings, 'isSameType', true)
            ).map(sameTypeFindingToItem)
          );
        }
        return items;
      },
      publish: (items: readonly FixedDictConstructDiagnosticItem[]) => {
        fixedDictConstructDiagnostics.set(document.uri, items.map(item => {
          const diagnostic = new vscode.Diagnostic(
            new vscode.Range(
              item.range.start.line, item.range.start.character,
              item.range.end.line, item.range.end.character
            ),
            item.message,
            item.severity === 'Information'
              ? vscode.DiagnosticSeverity.Information
              : vscode.DiagnosticSeverity.Warning
          );
          diagnostic.source = item.source;
          diagnostic.code = item.code;
          return diagnostic;
        }));
      }
    };
    if (channel === 'queued') {
      fixedDictConstructScheduler.requestQueued(document, options);
    } else {
      fixedDictConstructScheduler.request(document, options);
    }
  };

  /** 类型注册表(types.xml/alias.xml)变更:FD 构造输入变,重排全部已打开 python 文档。 */
  const rescheduleFixedDictConstructForRegistryChange = (): void => {
    fixedDictConstructScheduler.invalidateAll();
    for (const doc of vscode.workspace.textDocuments) {
      if (isPythonDocument(doc)) {
        scheduleFixedDictConstructDiagnostics(doc, 'queued');
      }
    }
  };

  // KSEM-STRUCT-05:def 属性标量赋值范围/结构校验。kbengine.scalarAssignDiagnostics
  // 默认开;独立诊断集合 + 独立调度器(同 C-19/cellData/STRUCT-04 族范式)。
  const scalarAssignDiagnostics = vscode.languages.createDiagnosticCollection(
    'kbengine-scalar-assign'
  );
  context.subscriptions.push(scalarAssignDiagnostics);
  const scalarAssignScheduler = new DiagnosticScheduler();
  const scheduleScalarAssignDiagnostics = (
    document: vscode.TextDocument,
    channel: 'immediate' | 'queued'
  ): void => {
    if (!isPythonDocument(document)) {
      return;
    }
    const capturedVersion = document.version;
    const options = {
      layer: 'local' as const,
      computeAsync: async (): Promise<readonly ScalarAssignDiagnosticItem[] | null> => {
        if (document.version !== capturedVersion) {
          return [];
        }
        const enabled = vscode.workspace.getConfiguration('kbengine')
          .get<boolean>('scalarAssignDiagnostics', SCALAR_ASSIGN_DIAGNOSTICS_ENABLED_DEFAULT);
        if (!enabled) {
          return [];
        }
        const workspaceRoot = getWorkspaceRootForDocument(document) ?? '';
        const customTypes = getEntityCustomTypesSnapshot(workspaceRoot);
        if (customTypes.length === 0) {
          return []; // types.xml 不可解析:注册表空,不造诊断
        }
        const findings = await analyzeScalarAssignWrites(
          document.getText(),
          async propertyName => {
            const info = await entityMappingManager.resolvePropertyDefinitionInfo(
              document.uri.fsPath,
              propertyName,
              propertyName
            );
            if (!info?.typeName) {
              return null;
            }
            const base = info.defFile.split(/[\\/]/).pop() ?? info.defFile;
            const source = info.line > 0 ? `${base}:${info.line}` : base;
            return { typeName: info.typeName, source };
          },
          customTypes
        );
        return findings.map(scalarAssignFindingToItem);
      },
      publish: (items: readonly ScalarAssignDiagnosticItem[]) => {
        scalarAssignDiagnostics.set(document.uri, items.map(item => {
          const diagnostic = new vscode.Diagnostic(
            new vscode.Range(
              item.range.start.line, item.range.start.character,
              item.range.end.line, item.range.end.character
            ),
            item.message,
            vscode.DiagnosticSeverity.Warning
          );
          diagnostic.source = item.source;
          diagnostic.code = item.code;
          return diagnostic;
        }));
      }
    };
    if (channel === 'queued') {
      scalarAssignScheduler.requestQueued(document, options);
    } else {
      scalarAssignScheduler.request(document, options);
    }
  };

  /** 类型注册表(types.xml/alias.xml)变更:标量赋值输入变,重排全部已打开 python 文档。 */
  const rescheduleScalarAssignForRegistryChange = (): void => {
    scalarAssignScheduler.invalidateAll();
    for (const doc of vscode.workspace.textDocuments) {
      if (isPythonDocument(doc)) {
        scheduleScalarAssignDiagnostics(doc, 'queued');
      }
    }
  };

  // KSEM-CELL-10:cellData 错键提示。键宇宙与 CELL-08 同源(Rust cellDataKeys),
  // 判据用 CELL-09 的键跟踪事实:裸下标读已证 absent 且世界封闭 → 确定性缺失;
  // 世界开放(动态键写/update/setdefault)或 .get 形态 → 只给低置信建议(get
  // 从不报必然 KeyError);声明/内建键与写点一律不报。
  const cellDataWrongKeyDiagnostics = vscode.languages.createDiagnosticCollection(
    'kbengine-celldata-wrongkey'
  );
  context.subscriptions.push(cellDataWrongKeyDiagnostics);
  const cellDataWrongKeyScheduler = new DiagnosticScheduler();
  const scheduleCellDataWrongKeyDiagnostics = (
    document: vscode.TextDocument,
    channel: 'immediate' | 'queued'
  ): void => {
    if (!isPythonDocument(document)) {
      return;
    }
    const capturedVersion = document.version;
    const options = {
      layer: 'local' as const,
      computeAsync: async (): Promise<readonly CellDataWrongKeyDiagnosticItem[] | null> => {
        if (document.version !== capturedVersion) {
          return [];
        }
        const enabled = vscode.workspace.getConfiguration('kbengine')
          .get<boolean>('cellDataWrongKeyDiagnostics', CELL_DATA_WRONG_KEY_DIAGNOSTICS_ENABLED_DEFAULT);
        if (!enabled) {
          return [];
        }
        const role = cellScriptRoleAndEntity(document.fileName);
        if (!role) {
          return []; // client/bots/其他角色:cellData 面不可达
        }
        // KSEM-CELL-15:def 文本走脏 overlay 读取——未保存的 def 编辑立即进键宇宙
        const defs = collectCellDataDefUniverseWithCategory(role.entity, (name, category) =>
          findDefinitionTextByCategory(name, category, document));
        const entries = await fetchCellDataKeys(role.entity, defs);
        if (!entries || entries.length === 0) {
          return []; // Rust 不可用/畸形/实体缺:不造键,不出诊断
        }
        const text = document.getText();
        const worldOpen = cellDataKeyWorldOpen(text);
        // KSEM-CELL-14:候选声明锚点关联跳转(仅 def 字段面;内建证据路径
        // 不是工作区文件,不造假跳转)。line 已转 0 基 vscode 口径。
        return cellDataWrongKeyFindings(trackCellDataKeys(text, entries), entries, worldOpen)
          .map(finding => {
            const anchor = resolveCellDataDeclAnchor(finding.candidateFile, defs, (name, category) =>
              findDefinitionFileByCategory(name, category, document));
            const related: CellDataRelatedLocation | undefined =
              anchor && finding.candidateLine != null
                ? {
                  file: anchor.file,
                  line: Math.max(0, finding.candidateLine - 1),
                  label: `声明键 ${finding.candidate} · ${finding.candidateFile}:${finding.candidateLine}`
                }
                : undefined;
            return cellDataWrongKeyFindingToItem(finding, related);
          });
      },
      publish: (items: readonly CellDataWrongKeyDiagnosticItem[]) => {
        cellDataWrongKeyDiagnostics.set(document.uri, items.map(item => {
          const diagnostic = new vscode.Diagnostic(
            new vscode.Range(
              item.range.start.line, item.range.start.character,
              item.range.end.line, item.range.end.character
            ),
            item.message,
            vscode.DiagnosticSeverity.Warning
          );
          diagnostic.source = item.source;
          diagnostic.code = item.code;
          if (item.related) {
            diagnostic.relatedInformation = [
              new vscode.DiagnosticRelatedInformation(
                new vscode.Location(
                  vscode.Uri.file(item.related.file),
                  new vscode.Range(item.related.line, 0, item.related.line, 0)
                ),
                item.related.label
              )
            ];
          }
          return diagnostic;
        }));
      }
    };
    if (channel === 'queued') {
      cellDataWrongKeyScheduler.requestQueued(document, options);
    } else {
      cellDataWrongKeyScheduler.request(document, options);
    }
  };

  // KSEM-CELL-12:cellData 回调入口访问。onGetCell 是唯一「确定」窗口——引擎
  // 在脚本回调前已删 cellData 属性(baseapp/entity.cpp:1024 在 :1030 之前),
  // 回调内求值必抛 AttributeError;其余回调(unknown 时机)按验收口径一律沉默。
  // 本面无需键宇宙/RPC:角色闸(base)+方法定位+行内求值/存储分类,纯本地。
  const cellDataCallbackDiagnostics = vscode.languages.createDiagnosticCollection(
    'kbengine-celldata-callback'
  );
  context.subscriptions.push(cellDataCallbackDiagnostics);
  const cellDataCallbackScheduler = new DiagnosticScheduler();
  const scheduleCellDataCallbackDiagnostics = (
    document: vscode.TextDocument,
    channel: 'immediate' | 'queued'
  ): void => {
    if (!isPythonDocument(document)) {
      return;
    }
    const capturedVersion = document.version;
    const options = {
      layer: 'local' as const,
      computeAsync: async (): Promise<readonly CellDataCallbackDiagnosticItem[] | null> => {
        if (document.version !== capturedVersion) {
          return [];
        }
        const enabled = vscode.workspace.getConfiguration('kbengine')
          .get<boolean>('cellDataCallbackDiagnostics', CELL_DATA_CALLBACK_DIAGNOSTICS_ENABLED_DEFAULT);
        if (!enabled) {
          return [];
        }
        const role = cellScriptRoleAndEntity(document.fileName);
        if (!role || role.role !== 'base') {
          return []; // onGetCell 只有 base 侧会被引擎调用;cell/client/bots 不报
        }
        return cellDataCallbackFindings(document.getText()).map(cellDataCallbackFindingToItem);
      },
      publish: (items: readonly CellDataCallbackDiagnosticItem[]) => {
        cellDataCallbackDiagnostics.set(document.uri, items.map(item => {
          const diagnostic = new vscode.Diagnostic(
            new vscode.Range(
              item.range.start.line, item.range.start.character,
              item.range.end.line, item.range.end.character
            ),
            item.message,
            vscode.DiagnosticSeverity.Warning
          );
          diagnostic.source = item.source;
          diagnostic.code = item.code;
          return diagnostic;
        }));
      }
    };
    if (channel === 'queued') {
      cellDataCallbackScheduler.requestQueued(document, options);
    } else {
      cellDataCallbackScheduler.request(document, options);
    }
  };

  // KSEM-CELL-15:def 缓冲变更(含未保存编辑)是 cellData 键宇宙的输入面——
  // 键集变化必须反映到同根已打开实体脚本的三诊断(写入类型/错键/回调入口)。
  // 先失效诊断输入代(同版本已发布的文档强制重算,否则同版本请求会被
  // skippedCurrentVersion 跳过),再逐文档重排。跨根 def 不是本根脚本的键
  // 宇宙,不串扰;invalidateAll 是全调度器代,跨根文档的下一次自身编辑会
  // 多算一次(保守正确,非错误面)。
  const retriggerCellDataDiagnosticsForDefChange = (
    defDocument: vscode.TextDocument
  ): void => {
    const root = getWorkspaceRootForDocument(defDocument);
    if (!root) {
      return;
    }
    cellDataWriteScheduler.invalidateAll();
    cellDataWrongKeyScheduler.invalidateAll();
    cellDataCallbackScheduler.invalidateAll();
    fixedDictConstructScheduler.invalidateAll(); // KSEM-STRUCT-04:def 属性类型也是 FD 构造输入
    scalarAssignScheduler.invalidateAll(); // KSEM-STRUCT-05:def 属性 <Type> 也是标量赋值输入
    for (const document of vscode.workspace.textDocuments) {
      if (document.uri.toString() === defDocument.uri.toString()) {
        continue; // def 自身不是 cellData 消费面(它是键宇宙输入)
      }
      if (!isPythonDocument(document) || !cellScriptRoleAndEntity(document.fileName)) {
        continue;
      }
      if (getWorkspaceRootForDocument(document) !== root) {
        continue;
      }
      scheduleCellDataWriteDiagnostics(document, 'queued');
      scheduleCellDataWrongKeyDiagnostics(document, 'queued');
      scheduleCellDataCallbackDiagnostics(document, 'queued');
    }
    // KSEM-STRUCT-04:FD 构造面不设 cell 角色闸(def 属性三域皆有),全 python 重排
    for (const document of vscode.workspace.textDocuments) {
      if (document.uri.toString() === defDocument.uri.toString()) {
        continue;
      }
      if (!isPythonDocument(document)) {
        continue;
      }
      if (getWorkspaceRootForDocument(document) !== root) {
        continue;
      }
      scheduleFixedDictConstructDiagnostics(document, 'queued');
      scheduleScalarAssignDiagnostics(document, 'queued');
    }
  };

  // C-17:进程拓扑定义期错配预警(清单 process_topology.xml + defs → Rust 校验)。
  // 独立诊断集合 + 独立调度器(共享调度器每 URI 单排队槽,会顶掉 def 结构
  // 诊断任务,必独立,同 C-19 范式)。缺清单=静默零发现(零误报)。
  const processTopologyDiagnostics = vscode.languages.createDiagnosticCollection(
    'kbengine-process-topology'
  );
  context.subscriptions.push(processTopologyDiagnostics);
  const processTopologyScheduler = new DiagnosticScheduler();
  setProcessTopologySchedulerForTests(processTopologyScheduler);
  const processTopologyManifestName = 'process_topology.xml';

  /** workspace 根下清单路径(缺 workspace 根 → null,静默)。KR-AUD-54:
   *  根按触发文档定位,无参回落第一根在多根工作区会读错根的清单。 */
  const resolveProcessTopologyManifestPath = (document?: vscode.TextDocument): string | null => {
    const root = getWorkspaceRootForDocument(document);
    if (!root) {
      return null;
    }
    return `${root}${path.sep}${processTopologyManifestName}`;
  };

  /** 读文件原文(优先打开文档缓冲,回退磁盘快照)。 */
  const readTextForPath = (fsPath: string): string | null => {
    const open = vscode.workspace.textDocuments.find(doc => doc.uri.fsPath === fsPath);
    if (open) {
      return open.getText();
    }
    const snapshot = readSharedFileSnapshot(fsPath);
    return snapshot?.content ?? null;
  };

  /** 收集 defs 原文集合(实体/接口/组件三根,闭包走查用)。KR-AUD-54:同
   *  清单路径口径,根随触发文档定位,不无参回落第一根。 */
  const collectTopologyDefInputs = (document?: vscode.TextDocument): Array<{ name: string; category: string; filePath: string; text: string }> => {
    const root = getWorkspaceRootForDocument(document);
    if (!root) {
      return [];
    }
    const layout = getDefinitionWorkspaceLayout(root);
    const defs: Array<{ name: string; category: string; filePath: string; text: string }> = [];
    const push = (directory: string | null, category: string) => {
      for (const filePath of listDefinitionFiles(directory)) {
        const name = filePath.split(/[\\/]/).pop()?.replace(/\.def$/i, '') ?? '';
        const text = readTextForPath(filePath);
        if (text !== null) {
          defs.push({ name, category, filePath, text });
        }
      }
    };
    push(layout.entityDefsRoot, 'entity');
    push(layout.interfacesRoot, 'interface');
    push(layout.componentsRoot, 'component');
    return defs;
  };

  /** 行首偏移表(同 defMethodConsistency 纯逻辑半边)。 */
  const computeLineStarts = (text: string): number[] => {
    const starts: number[] = [0];
    for (let i = 0; i < text.length; i += 1) {
      if (text[i] === '\n') {
        starts.push(i + 1);
      }
    }
    return starts;
  };

  /** 字节偏移 → vscode.Position(0 基行/列)。 */
  const documentPositionFromOffset = (text: string, offset: number): vscode.Position => {
    const starts = computeLineStarts(text);
    let line = 0;
    while (line + 1 < starts.length && starts[line + 1] <= offset) {
      line += 1;
    }
    return new vscode.Position(line, offset - starts[line]);
  };

  /** 把 spec 换算成 vscode.Diagnostic(整行定位;related 钉 0 位,同 C-19)。 */
  const specToDiagnostic = (spec: ProcessTopologyDiagnosticSpec, text: string): vscode.Diagnostic => {
    const lineStarts = computeLineStarts(text);
    const lineIndex = Math.min(Math.max(spec.line - 1, 0), Math.max(lineStarts.length - 1, 0));
    const start = lineStarts[lineIndex];
    const end = lineStarts[lineIndex + 1] ?? text.length;
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(
        documentPositionFromOffset(text, start),
        documentPositionFromOffset(text, Math.max(start, end - 1))
      ),
      spec.message,
      vscode.DiagnosticSeverity.Warning
    );
    diagnostic.code = spec.code;
    if (spec.related.length > 0) {
      diagnostic.relatedInformation = spec.related.map(related =>
        new vscode.DiagnosticRelatedInformation(
          new vscode.Location(vscode.Uri.file(related.filePath), new vscode.Range(0, 0, 0, 0)),
          related.message
        )
      );
    }
    return diagnostic;
  };

  /** 进程拓扑发布项:单文件诊断集合(全量重发用)。 */
  interface ProcessTopologyPublishItem {
    filePath: string;
    diagnostics: vscode.Diagnostic[];
  }

  /**
   * 进程拓扑诊断调度:读清单 + entities.xml + defs → Rust 校验 → 分组发布。
   * 清单/任一 def 变更都会全量重算(拓扑是全局输入)。
   */
  const scheduleProcessTopologyDiagnostics = (
    document: vscode.TextDocument,
    channel: 'immediate' | 'queued'
  ): void => {
    const capturedVersion = document.version;
    // KR-AUD-54:清单路径与 defs 集合的根都随触发文档定位(多根不串)
    const manifestPath = resolveProcessTopologyManifestPath(document);
    if (!manifestPath) {
      return;
    }
    // 清单未启用(缺文件)→ 静默零发现(不阻塞)。
    const manifestText = readTextForPath(manifestPath);
    if (manifestText === null) {
      return;
    }
    const options = {
      layer: 'local' as const,
      // 计算产出:按文件分组的诊断清单(拓扑是全局输入,单文件重算产出全量)。
      computeAsync: async (): Promise<readonly ProcessTopologyPublishItem[] | null> => {
        const config = vscode.workspace.getConfiguration('kbengine');
        const enabled = config.get<boolean>('diagnostics.checkProcessTopology', true);
        if (!enabled || document.version !== capturedVersion) {
          return [];
        }
        const root = getWorkspaceRootForDocument(document);
        if (!root) {
          return [];
        }
        const layout = getDefinitionWorkspaceLayout(root);
        const entitiesXmlPath = layout.entitiesXmlPath;
        const entitiesXmlText = entitiesXmlPath
          ? (readTextForPath(entitiesXmlPath) ?? '')
          : '';
        const result = await validateProcessTopologyInRust({
          manifestText,
          entitiesXmlText,
          defs: collectTopologyDefInputs(document)
        });
        if (!result) {
          // Rust 不可用/失败 → 零发现(静默,不误报)。
          return [];
        }
        const specs = mapFindingsToDiagnostics(result.findings, resolveProcessTopologyManifestPath);
        const grouped = new Map<string, vscode.Diagnostic[]>();
        for (const spec of specs) {
          const text = readTextForPath(spec.filePath) ?? '';
          const list = grouped.get(spec.filePath) ?? [];
          list.push(specToDiagnostic(spec, text));
          grouped.set(spec.filePath, list);
        }
        return Array.from(grouped, ([filePath, diagnostics]) => ({ filePath, diagnostics }));
      },
      publish: (items: readonly ProcessTopologyPublishItem[]) => {
        // 全量重发:清空后按文件重设(拓扑全局输入,任一变更都产出全量状态)。
        processTopologyDiagnostics.clear();
        for (const item of items) {
          processTopologyDiagnostics.set(vscode.Uri.file(item.filePath), item.diagnostics);
        }
      }
    };
    if (channel === 'queued') {
      processTopologyScheduler.requestQueued(document, options);
    } else {
      processTopologyScheduler.request(document, options);
    }
  };

  return {
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
    scheduleCellDataWriteDiagnostics,
    scheduleSpaceDataProtectedKeyDiagnostics,
    scheduleFixedDictConstructDiagnostics,
    rescheduleFixedDictConstructForRegistryChange,
    scheduleScalarAssignDiagnostics,
    rescheduleScalarAssignForRegistryChange,
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
    cellDataWriteDiagnostics,
    cellDataWriteScheduler,
    spaceDataProtectedKeyDiagnostics,
    spaceDataProtectedKeyScheduler,
    fixedDictConstructDiagnostics,
    fixedDictConstructScheduler,
    scalarAssignDiagnostics,
    scalarAssignScheduler,
    scheduleCellDataWrongKeyDiagnostics,
    cellDataWrongKeyDiagnostics,
    cellDataWrongKeyScheduler,
    scheduleCellDataCallbackDiagnostics,
    cellDataCallbackDiagnostics,
    cellDataCallbackScheduler,
    retriggerCellDataDiagnosticsForDefChange,
    processTopologyDiagnostics,
    processTopologyScheduler
  };
}
