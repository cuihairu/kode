// KODE-ARCH-001 pure-move split from src/languageProviders.ts (zero behavior change).
import * as vscode from 'vscode';
import { DefDocument, DefElementNode, getDirectChildElement, getDirectChildElements, getScalarChildValue } from '../backend/defParser';
import { analyzeEntitiesXml } from '../backend/entitiesXmlAnalysis';
import { getOrParseDocumentSync } from '../backend/documentStore';
import { getKodeCoreShadowGate, serveDiagnosticsFromRust, shadowObserveDefDocument, type LspDiagnosticReportFace } from '../backend/kodeCoreShadowFaces';
import { analyzeDefDocumentInRust, type DefAnalysisFinding } from '../backend/defAnalyzer';
import { collectDefPythonParityInput } from '../backend/defPythonParity';
import { computeTypesXmlStructureFindings, type PreloadedRegistryName } from '../backend/typesXmlStructureCheck';
import {
  computePersistentEntityCallFindings,
  PERSISTENT_ENTITY_CALL_DIAGNOSTIC_CODE
} from '../backend/persistentEntityCallCheck';
import { getEntityCustomTypesSnapshot, getWorkspaceRootForDocument } from '../definitionWorkspace';
import { DETAIL_LEVELS, KBENGINE_FLAGS } from '../backend/kbengineMetadata';
import { FLAG_DOMAIN_ALIAS, normalizeFlagTokens } from '../generated/flagDomains';
import { ALLOWED_TOP_LEVEL_SECTIONS, KBEngineSectionName, createNodeRange, getLanguageFeatureConfig, getNodeValue, getSectionLabel, parseDefAst, pushDiagnosticForNodeValue, toSectionName, visitElementNodes } from './shared';
import { ENTITY_BASE_DATA_FLAGS, ENTITY_CELL_DATA_FLAGS, ENTITY_CLIENT_DATA_FLAGS, KnownTypeContext, PROPERTY_SCOPE_LABELS, PropertyScope, getKnownTypeContext } from './completion';
import { resolveCustomTypeReference } from './navigation';
export function validateDocument(
  document: vscode.TextDocument,
  diagnostics: vscode.DiagnosticCollection
): void {
  const featureConfig = getLanguageFeatureConfig();
  if (!featureConfig.enableDiagnostics) {
    diagnostics.delete(document.uri);
    return;
  }

  const diagnosticsList: vscode.Diagnostic[] = [];

  // 批92 性能优化:标量校验与结构校验共用同一次 parseDefAst 结果。
  // parseDefDocument 对同一段文本是确定性的,原先两阶段各自解析一遍,
  // 大 .def 文档上纯解析开销翻倍。
  const ast = parseDefAst(document);
  validateScalarTagValues(document, diagnosticsList, featureConfig, ast);
  if (featureConfig.enableStructureDiagnostics) {
    validateDefStructure(document, diagnosticsList, featureConfig, ast);
  }

  diagnostics.set(document.uri, diagnosticsList);
  // Phase2 首片:shadow 双轨对拍(诊断面)+ 语料镜像腿。fire-and-forget,
  // 只读 diagnosticsList 的可比面,不改 collection 内容。
  shadowObserveDefDocument(document, diagnosticsList);
  // Rust lint 注册表消费腿:把 analyzeDef 的分析建议(Rust 面)并集进诊断。
  // fire-and-forget + 版本护栏 + 默认 ts 模式零开销(见 observeRustDefFindings)。
  observeRustDefFindings(document, diagnostics);
  // 诊断面 rust 服务腿(2026-11-08 用户令「直接切到 rust」,最后一片服务面):
  // TS 同步面先落(首绘零延迟不变),Rust 面异步到达后按 message 键替换
  // 自身码、保留外来码(lint 并集 / missingPythonFile)。服务轨道外零开销。
  serveRustDiagnosticsFace(document, diagnostics, featureConfig);
  // RUST-177:def 属性 Persistent×ENTITYCALL 静默降级(主 collection 追加,
  // 不进对拍输入面,见函数注)
  appendPersistentEntityCallDiagnostics(document, diagnostics);
}

// ---- 诊断面 rust 服务腿 -----------------------------------------------------
// Rust 面 = 语料可复刻的 validateDocument 全集(标量三码:未知 Type 引用/
// 未知 Flags/未知 DetailLevel + 结构码:重复定义/缺 <Type>/<Flags>)。
// message 文案与 TS 逐字节同源(golden 对拍锁死),故 message 键即「码」键:
// 归并 = TS 面里凡与 Rust 同文案的让位(Rust 版本落),外来码(lint 并集、
// missingPythonFile 盘上探测)原样保留。

/** LSP 严重级 → vscode.DiagnosticSeverity(-1;1=Error…3=Information) */
export const lspSeverityToVscode = (severity: number): vscode.DiagnosticSeverity => {
  if (severity < 1 || severity > 3) {
    return vscode.DiagnosticSeverity.Error;
  }
  return severity - 1;
};

/**
 * 归并公式(幂等):TS 面剔除与 Rust 同文案的项(让位),Rust 面整面落,
 * 但与保留项同文案的不重复落(防御性:两轨文案意外重合时以 TS 版本为准,
 * 视觉零变化)。重入稳定:Rust 面是自身码的全量替换面,重复到达不叠加。
 */
export function mergeRustDiagnosticsFace(
  existing: readonly vscode.Diagnostic[],
  report: LspDiagnosticReportFace
): vscode.Diagnostic[] {
  const rustMessages = new Set(report.items.map(item => item.message));
  const kept = existing.filter(diagnostic => !rustMessages.has(diagnostic.message));
  const keptMessages = new Set(kept.map(diagnostic => diagnostic.message));
  const additions = report.items
    .filter(item => !keptMessages.has(item.message))
    .map(item =>
      new vscode.Diagnostic(
        new vscode.Range(
          item.range.start.line,
          item.range.start.character,
          item.range.end.line,
          item.range.end.character
        ),
        item.message,
        lspSeverityToVscode(item.severity)
      )
    );
  return [...kept, ...additions];
}

/** Rust 面按默认全开语料对齐;任一细分开关关闭 → TS 面与 Rust 面不再同构,整面回落 TS。 */
export function rustDiagnosticsFaceGateOpen(
  featureConfig: ReturnType<typeof getLanguageFeatureConfig>
): boolean {
  return (
    featureConfig.enableStructureDiagnostics &&
    featureConfig.diagnosticsCheckUnknownFlags &&
    featureConfig.diagnosticsCheckUnknownDetailLevels &&
    featureConfig.diagnosticsCheckUnknownTypes &&
    featureConfig.diagnosticsCheckDuplicateDefinitions &&
    featureConfig.diagnosticsCheckMissingPropertyFields
  );
}

/**
 * 诊断面 rust 服务腿:validateDocument 同步面落定后发出异步请求。版本护栏
 * 内(到达时 document.version 未动)按归并公式落 collection;Rust 失败/null
 * (非 .def/服务轨道外)不落 —— TS 集保持。lint 腿与本腿的到达序不敏感:
 * 各自 get→归并→set 在同一微任务内原子完成,先到者的产出是后到者的
 * existing,互不吞并。
 */
export function serveRustDiagnosticsFace(
  document: vscode.TextDocument,
  diagnostics: vscode.DiagnosticCollection,
  featureConfig: ReturnType<typeof getLanguageFeatureConfig>
): void {
  const gate = getKodeCoreShadowGate();
  if (!gate || !gate.serveFromRust() || !rustDiagnosticsFaceGateOpen(featureConfig)) {
    return;
  }
  const version = document.version;
  void serveDiagnosticsFromRust(document)
    .then(report => {
      if (!report || document.version !== version) {
        return;
      }
      const existing = diagnostics.get(document.uri) ?? [];
      diagnostics.set(document.uri, mergeRustDiagnosticsFace(existing, report));
    })
    .catch(() => undefined);
}

// Rust lint 注册表消费腿(validateDocument 侧):把 `$/kode/lint/analyzeDef`
// 的分析建议并集进诊断 collection。只并集 validateDocument 未覆盖的分析
// 建议码(phantom-type / duplicate-type-tag / heavy-sync-broadcast /
// redundant-detail-level / invalid-identifier / method-property-collision /
// engine-limited-name / inherited-name-collision)——结构码(unknown-type-
// reference / unknown-flag-value / unknown-detail-level / duplicate-definition /
// missing-flags / missing-type)由 validateDefStructure 现产,重复落会产生
// 双报。默认 ts 模式(未配 serverPath / backend=ts)零开销直通。
export const RUST_LIVE_MERGE_CODES = new Set<string>([
  'phantom-type',
  'duplicate-type-tag',
  'heavy-sync-broadcast',
  'redundant-detail-level',
  'invalid-identifier',
  'method-property-collision',
  'engine-limited-name',
  'inherited-name-collision',
  // C-19:def↔Python 方法一致性(warning,双向定位 related 面在
  // mergeRustDefFindings 转 relatedInformation)。
  'def-method-missing-in-python'
]);

export const toDiagnosticSeverity = (severity: DefAnalysisFinding['severity']): vscode.DiagnosticSeverity =>
  severity === 'error'
    ? vscode.DiagnosticSeverity.Error
    : severity === 'warning'
      ? vscode.DiagnosticSeverity.Warning
      : vscode.DiagnosticSeverity.Information;

export function observeRustDefFindings(
  document: vscode.TextDocument,
  diagnostics: vscode.DiagnosticCollection
): void {
  const gate = getKodeCoreShadowGate();
  if (!gate || gate.mode === 'ts') {
    return;
  }
  const version = document.version;
  // C-19:def↔Python 一致性入参按标准布局现采(打开缓冲区优先读盘);
  // 非 scripts/entity_defs 布局 → null,Rust parity 规则零产出。采集失败
  // (盘上异常)不阻断诊断面,回落零产出(Rust 规则不核验)。
  let pythonParity: unknown;
  try {
    pythonParity = collectDefPythonParityInput(document.fileName) ?? undefined;
  } catch {
    pythonParity = undefined;
  }
  // 空 inheritedNames:活校验侧只并集单文件分析建议,继承链同名由批分析命令
  // (kbengine.def.analyze)承担,避免每次按键做祖先闭包磁盘 I/O。
  void analyzeDefDocumentInRust(document.getText(), new Map(), { pythonParity })
    .then(findings => {
      if (!findings || findings.length === 0) {
        return;
      }
      if (document.version !== version) {
        return;
      }
      const existing = diagnostics.get(document.uri) ?? [];
      const rustDiags = mergeRustDefFindings(document, findings, existing);
      if (rustDiags.length > 0) {
        diagnostics.set(document.uri, [...existing, ...rustDiags]);
      }
    })
    .catch(() => undefined);
}

export function mergeRustDefFindings(
  document: vscode.TextDocument,
  findings: DefAnalysisFinding[],
  existing: readonly vscode.Diagnostic[]
): vscode.Diagnostic[] {
  // 已存在同位置同文案的诊断不重复落(跨响应幂等:重入/重复 probe 不叠加)。
  const existingKeys = new Set(
    existing.map(
      diag =>
        `${diag.range.start.line}:${diag.range.start.character}:${diag.message}`
    )
  );
  const seen = new Set<string>();
  const out: vscode.Diagnostic[] = [];
  for (const item of findings) {
    if (!RUST_LIVE_MERGE_CODES.has(item.check)) {
      continue;
    }
    const key = `${item.check}:${item.offset}:${item.message}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const start = document.positionAt(item.offset);
    const end = document.positionAt(item.offset + item.length);
    const diag = new vscode.Diagnostic(
      new vscode.Range(start, end),
      item.message,
      toDiagnosticSeverity(item.severity)
    );
    // C-19 双向定位:目标 Python 文件 + 类名 → relatedInformation
    // (vscode 面;CodeAction 经同一面定位目标文件,无需重新解析)。
    if (item.related) {
      const relatedUri = vscode.Uri.file(item.related.file);
      diag.relatedInformation = [
        new vscode.DiagnosticRelatedInformation(
          new vscode.Location(relatedUri, new vscode.Range(0, 0, 0, 0)),
          item.related.className
        )
      ];
    }
    const positionKey = `${diag.range.start.line}:${diag.range.start.character}:${diag.message}`;
    if (existingKeys.has(positionKey)) {
      continue;
    }
    out.push(diag);
  }
  return out;
}

// ---- RUST-142 推送消费面 ---------------------------------------------------
// 服务器 push 面 `$/kode/publishDiagnostics` 携带 finding 形载荷(与
// analyzeDef 同形;uri = 镜像腿原串 = document.uri.fsPath)。桥 onNotification
// 扩展位(PR-003)落此消费面。路由按 layer:localSyntax(唯一有 Rust 真源
// 的层)经 mergeRustDefFindings 并入主 collection(与 pull 腿同幂等/同版本
// 护栏);semantic/engineCompat/runtimeConfig 三族归各自车道接线后入表
// (诚实边界)。C-19(def-method-missing-in-python)输入在 TS 侧现采,
// Rust push 以缺省 parity 输入跑不产出,仍由 observeRustDefFindings 的
// pull 腿覆盖(push/pull 同键幂等,不双报)。

/** `$/kode/publishDiagnostics` 载荷面(Rust 侧 ServerNotification.params)。 */
export interface RustDiagnosticsPushParams {
  /** 客户端原串(镜像腿 = document.uri.fsPath) */
  uri: string;
  version: number | null;
  layer: string;
  findings: DefAnalysisFinding[];
}

/** push 消费面:文档在场 + 版本护栏内按归并公式落 collection(幂等)。 */
export function applyRustDiagnosticsPush(
  params: RustDiagnosticsPushParams,
  diagnostics: vscode.DiagnosticCollection,
  textDocuments: readonly vscode.TextDocument[]
): void {
  if (params.layer !== 'localSyntax' || typeof params.version !== 'number') {
    return;
  }
  const document = textDocuments.find(doc => doc.uri.fsPath === params.uri);
  if (!document || document.version !== params.version) {
    return; // 已关闭/晚到旧版丢弃(与 pull 腿版本护栏同口径)。
  }
  const existing = diagnostics.get(document.uri) ?? [];
  const rustDiags = mergeRustDefFindings(document, params.findings, existing);
  if (rustDiags.length > 0) {
    diagnostics.set(document.uri, [...existing, ...rustDiags]);
  }
}

/**
 * 桥面装配:gate 通知回调 → localSyntax findings 并入主 collection。
 * textDocuments 注入(vscode.workspace.textDocuments;测试替身可注入)。
 */
export function wireDiagnosticsPush(
  gate: {
    setNotificationHandler(
      handler: ((notification: { method: string; params?: unknown }) => void) | null
    ): void;
  },
  diagnostics: vscode.DiagnosticCollection,
  textDocuments: () => readonly vscode.TextDocument[]
): void {
  gate.setNotificationHandler(notification => {
    if (notification.method !== '$/kode/publishDiagnostics') {
      return;
    }
    const params = notification.params as RustDiagnosticsPushParams | undefined;
    if (!params) {
      return;
    }
    applyRustDiagnosticsPush(params, diagnostics, textDocuments());
  });
}

// entities.xml 清单诊断(source-analysis 设计 D3):同名重复条目引擎按首条
// 静默合并(entitydef.cpp:255-262),这里是文档事件联动的落 collection 面,
// 开关与 validateDocument 共用 kbengine.enableDiagnostics。
// PR6 A6-3:分析结果经 documentStore 同步解析缓存命名空间化版本化 ——
// 同版本重复校验直接命中缓存(不重跑 analyzeEntitiesXml),版本前进由
// 快照机制整体作废旧槽位;无版本替身每次现算(与旧行为同价)。
export function validateEntitiesXmlDocument(
  document: vscode.TextDocument,
  diagnostics: vscode.DiagnosticCollection
): void {
  const featureConfig = getLanguageFeatureConfig();
  if (!featureConfig.enableDiagnostics) {
    diagnostics.delete(document.uri);
    return;
  }

  const { result: findings } = getOrParseDocumentSync(
    document,
    text => analyzeEntitiesXml(text),
    'entities-analysis'
  );

  diagnostics.set(
    document.uri,
    findings.map(item => {
      const start = document.positionAt(item.offset);
      const end = document.positionAt(item.offset + item.length);
      return new vscode.Diagnostic(
        new vscode.Range(start, end),
        item.message,
        vscode.DiagnosticSeverity.Warning
      );
    })
  );
}

// types.xml 结构完整性诊断(RUST-177/KBE-007):别名装载序敏(前向引用/
// 循环)、`_` 保留前缀、重定义(Warning,引擎非致命)、ARRAY <of> 缺失/
// 未知、FIXED_DICT 结构(缺 Properties/字段缺 Type=Warning/字段类型未知)
// 与 FD 字段 ENTITYCALL 静默降持久化。引擎真源锚见模块头注
// (src/backend/typesXmlStructureCheck.ts)。与 entities.xml 面同款:共用
// 主 collection,开关与 validateDocument 共用 kbengine.enableDiagnostics,
// 分析结果经 documentStore 命名空间化版本缓存('types-analysis')。
export function validateTypesXmlDocument(
  document: vscode.TextDocument,
  diagnostics: vscode.DiagnosticCollection
): void {
  const featureConfig = getLanguageFeatureConfig();
  if (!featureConfig.enableDiagnostics) {
    diagnostics.delete(document.uri);
    return;
  }

  const { result: findings } = getOrParseDocumentSync(
    document,
    text => computeTypesXmlStructureFindings(text),
    'types-analysis'
  );

  diagnostics.set(
    document.uri,
    findings.map(item => {
      const start = document.positionAt(item.offset);
      const end = document.positionAt(item.offset + item.length);
      const diagnostic = new vscode.Diagnostic(
        new vscode.Range(start, end),
        item.message,
        item.severity === 'warning'
          ? vscode.DiagnosticSeverity.Warning
          : vscode.DiagnosticSeverity.Error
      );
      diagnostic.code = item.code;
      return diagnostic;
    })
  );
}

// alias.xml 结构完整性诊断(KODE-SYN-003):与 types.xml 同一检查核
// (computeTypesXmlStructureFindings),差异仅在装载语境——引擎单遍先载
// types.xml 再载 alias.xml(datatypes.cpp loadTypes 调用序),alias 文档域
// 预载 types.xml 注册名(仅名字+指引,过滤 alias.xml 来源:alias 条目按
// 本文件装载序在本文件域内判定,跨文件引用只认 types.xml——alias→后文
// alias 的前向引用仍是引擎中止面)。未保存编辑双通道:本文件按缓冲文本
// 校验;types.xml 脏版经 getEntityCustomTypesSnapshot 的 open-version
// 前进即时生效。开关与缓存命名空间('alias-analysis')同 types 面。
export function validateAliasXmlDocument(
  document: vscode.TextDocument,
  diagnostics: vscode.DiagnosticCollection
): void {
  const featureConfig = getLanguageFeatureConfig();
  if (!featureConfig.enableDiagnostics) {
    diagnostics.delete(document.uri);
    return;
  }

  const { result: findings } = getOrParseDocumentSync(
    document,
    text => computeTypesXmlStructureFindings(text, typesXmlRegistryNamesForDocument(document)),
    'alias-analysis'
  );

  diagnostics.set(
    document.uri,
    findings.map(item => {
      const start = document.positionAt(item.offset);
      const end = document.positionAt(item.offset + item.length);
      const diagnostic = new vscode.Diagnostic(
        new vscode.Range(start, end),
        item.message,
        item.severity === 'warning'
          ? vscode.DiagnosticSeverity.Warning
          : vscode.DiagnosticSeverity.Error
      );
      diagnostic.code = item.code;
      return diagnostic;
    })
  );
}

/** alias.xml 文档域的 types.xml 预载注册面(名字+指引;无工作区语境为空) */
function typesXmlRegistryNamesForDocument(
  document: vscode.TextDocument
): PreloadedRegistryName[] {
  const root = getWorkspaceRootForDocument(document) ?? '';
  if (!root) {
    return [];
  }
  return getEntityCustomTypesSnapshot(root)
    .filter(info => !info.filePath.endsWith('alias.xml'))
    .map(info => ({
      name: info.name,
      // extractCustomTypeAliasType 的空指引哨兵 'ALIAS' 还原为空串:
      // 引擎对空指引 getDataType("") 必然查不到,不得让哨兵词假可解
      target: info.aliasType === 'ALIAS' ? '' : info.aliasType
    }));
}

// .def 属性 Persistent×ENTITYCALL 静默降级诊断(RUST-177/KBE-007 诊断面,
// 「不可序列化字段」子项):validateDocument 主面落定后**追加进主
// collection**——不进 diagnosticsList(那是对拍/服务腿的 Rust 可复刻面,
// 本码不在其内,保持影子对拍输入形状不变,与 lint 并集/missingPythonFile
// 同「外来码保留」架构)。types.xml 注册表快照与 scalarAssign 等消费面
// 同一来源(getEntityCustomTypesSnapshot);注册表空(不可解析)不造诊断。
// 重入幂等:先剔除自身码旧项再追加。
export function appendPersistentEntityCallDiagnostics(
  document: vscode.TextDocument,
  diagnostics: vscode.DiagnosticCollection
): void {
  const featureConfig = getLanguageFeatureConfig();
  if (!featureConfig.enableDiagnostics) {
    return;
  }
  const customTypes = getEntityCustomTypesSnapshot(getWorkspaceRootForDocument(document) ?? '');
  if (customTypes.length === 0) {
    return; // types.xml 不可解析:注册表空,不造诊断
  }
  const findings = computePersistentEntityCallFindings(document.getText(), customTypes);
  // 真机 DiagnosticCollection 恒有 get;测试替身可能是只 set/delete 的最小桩
  // ——无 get 读不到既有项,零发现清旧项面跳过(不抛)
  const hasGet = typeof diagnostics.get === 'function';
  if (findings.length === 0) {
    // 零发现也要落:清掉上一轮可能存在的自身码旧项(修掉别名后诊断即消)
    if (!hasGet) {
      return;
    }
    const existing = diagnostics.get(document.uri) ?? [];
    const kept = existing.filter(diagnostic => diagnostic.code !== PERSISTENT_ENTITY_CALL_DIAGNOSTIC_CODE);
    if (kept.length !== existing.length) {
      diagnostics.set(document.uri, kept);
    }
    return;
  }
  const existing = hasGet ? diagnostics.get(document.uri) ?? [] : [];
  const kept = existing.filter(diagnostic => diagnostic.code !== PERSISTENT_ENTITY_CALL_DIAGNOSTIC_CODE);
  const additions = findings.map(item => {
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(document.positionAt(item.offset), document.positionAt(item.offset + item.length)),
      item.message,
      vscode.DiagnosticSeverity.Warning
    );
    diagnostic.code = PERSISTENT_ENTITY_CALL_DIAGNOSTIC_CODE;
    return diagnostic;
  });
  diagnostics.set(document.uri, [...kept, ...additions]);
}

export function validateScalarTagValues(
  document: vscode.TextDocument,
  diagnosticsList: vscode.Diagnostic[],
  featureConfig: ReturnType<typeof getLanguageFeatureConfig>,
  ast: DefDocument | null
): void {
  if (!ast?.root) {
    return;
  }

  const knownTypeContext = getKnownTypeContext(document);
  const knownFlags = new Set(KBENGINE_FLAGS.map(flag => flag.name));
  const knownLevels = new Set(DETAIL_LEVELS);

  visitElementNodes(ast.root, node => {
    if (node.name === 'Type') {
      validateTypeNode(document, diagnosticsList, node, knownTypeContext, featureConfig);
      return;
    }

    if (node.name === 'Flags') {
      const rawValue = getNodeValue(node);
      const normalizedValue = rawValue.toUpperCase();
      if (featureConfig.diagnosticsCheckUnknownFlags && normalizedValue) {
        // KR-AUD-84:引擎按单个映射值整串查表,不拆词。'|' 组合形态单独出
        // 「引擎不支持」诊断(与 Rust UnknownFlagValueRule 同文案)。
        if (rawValue.includes('|')) {
          pushDiagnosticForNodeValue(
            document,
            diagnosticsList,
            node,
            rawValue,
            `未知的 KBEngine Flags 值: ${rawValue}。引擎按单个映射值整串查表，不支持 '|' 组合形态；请改为单个词表值。`,
            vscode.DiagnosticSeverity.Error
          );
        } else if (!knownFlags.has(normalizedValue)) {
          pushDiagnosticForNodeValue(
            document,
            diagnosticsList,
            node,
            rawValue,
            `未知的 KBEngine Flags 值: ${rawValue}。KBEngine 源码按单个映射值解析 <Flags>，不支持此写法。`,
            vscode.DiagnosticSeverity.Error
          );
        }
      }
      return;
    }

    if (node.name === 'DetailLevel') {
      const value = getNodeValue(node);
      if (featureConfig.diagnosticsCheckUnknownDetailLevels && value && !knownLevels.has(value)) {
        pushDiagnosticForNodeValue(
          document,
          diagnosticsList,
          node,
          value,
          `未知的 DetailLevel: ${value}`,
          vscode.DiagnosticSeverity.Error
        );
      }
    }
  });
}

export function validateDefStructure(
  document: vscode.TextDocument,
  diagnosticsList: vscode.Diagnostic[],
  featureConfig: ReturnType<typeof getLanguageFeatureConfig>,
  ast: DefDocument | null
): void {
  const root = ast?.root;
  if (!root) {
    return;
  }

  for (const sectionNode of getDirectChildElements(root)) {
    const sectionName = toSectionName(sectionNode.name);
    if (!sectionName || !ALLOWED_TOP_LEVEL_SECTIONS.has(sectionName)) {
      continue;
    }

    validateSectionStructure(document, diagnosticsList, sectionNode, sectionName, featureConfig);
  }
}

// IDE-NAV-013:未注册类型诊断的稳定 code——Code Action 侧据此对账候选,
// 不靠 message 字串匹配(文案演进不动契约)。
export const UNKNOWN_TYPE_DIAGNOSTIC_CODE = 'kbengine.unknownType';

export function validateTypeNode(
  document: vscode.TextDocument,
  diagnosticsList: vscode.Diagnostic[],
  typeNode: DefElementNode,
  knownTypeContext: KnownTypeContext,
  featureConfig: ReturnType<typeof getLanguageFeatureConfig>
): void {
  const value = getNodeValue(typeNode);
  if (!value || getDirectChildElements(typeNode).length > 0 || !featureConfig.diagnosticsCheckUnknownTypes) {
    return;
  }

  const typeCandidateRegex = /\b[A-Za-z_][A-Za-z0-9_]*\b/g;
  let typeCandidateMatch: RegExpExecArray | null;

  while ((typeCandidateMatch = typeCandidateRegex.exec(value)) !== null) {
    const candidate = typeCandidateMatch[0];
    if (knownTypeContext.builtins.has(candidate) || knownTypeContext.entityTypes.has(candidate)) {
      continue;
    }

    const customTypeResolution = resolveCustomTypeReference(document, candidate, knownTypeContext.customTypes);
    if (customTypeResolution.status === 'resolved' || customTypeResolution.status === 'unverifiable') {
      continue;
    }

    if (customTypeResolution.status === 'missingPythonFile') {
      pushDiagnosticForNodeValue(
        document,
        diagnosticsList,
        typeNode,
        candidate,
        `自定义类型 ${candidate} 已在 types.xml 中注册，但未找到对应的 user_type Python 文件，请检查 user_type/${candidate}.py`,
        vscode.DiagnosticSeverity.Warning
      );
      continue;
    }

    // 不可达(批64 定性):CustomTypeResolutionStatus 共四值,resolved/
    // unverifiable/missingPythonFile 已在上方三分支 continue 穷尽,能走到此处
    // 即 missingTypeRegistration。精确单行区间只摘除该 if 的分支条目,
    // 诊断构造保持被覆盖计入分母。
    /* istanbul ignore start */
    if (customTypeResolution.status === 'missingTypeRegistration') {
    /* istanbul ignore stop */
      pushDiagnosticForNodeValue(
        document,
        diagnosticsList,
        typeNode,
        candidate,
        `自定义类型 ${candidate} 未在 types.xml 中注册，请先在 types.xml 注册后再引用`,
        vscode.DiagnosticSeverity.Error,
        UNKNOWN_TYPE_DIAGNOSTIC_CODE
      );
    }
  }
}

export function validateSectionStructure(
  document: vscode.TextDocument,
  diagnosticsList: vscode.Diagnostic[],
  sectionNode: DefElementNode,
  sectionName: KBEngineSectionName,
  featureConfig: ReturnType<typeof getLanguageFeatureConfig>
): void {
  const seenSymbols = new Map<string, vscode.Range>();
  const seenPropertyScopes = new Map<string, Map<PropertyScope, vscode.Range>>();

  for (const symbolNode of getDirectChildElements(sectionNode)) {
    const symbolRange = createNodeRange(document, symbolNode);
    // 接口区块条目是文本形态(`<interface>Name</interface>`,标签只是四拼写
    // 之一):身份取节点值(接口名)而非标签名——同标签不同接口是合法形态
    // (实体可挂多接口),按标签名判重会把第二个接口误报重复。
    const symbolIdentity = sectionName === 'Interfaces' ? getNodeValue(symbolNode) : symbolNode.name;
    if (featureConfig.diagnosticsCheckDuplicateDefinitions && sectionName === 'Properties') {
      const propertyScopes = getPropertyFlagScopes(symbolNode);
      const seenScopes = seenPropertyScopes.get(symbolNode.name) || new Map<PropertyScope, vscode.Range>();

      for (const scope of propertyScopes) {
        const existing = seenScopes.get(scope);
        if (!existing) {
          continue;
        }

        diagnosticsList.push(new vscode.Diagnostic(
          symbolRange,
          `${getSectionLabel(sectionName)}中存在重复定义: ${symbolNode.name} (${describePropertyScope(scope)})`,
          vscode.DiagnosticSeverity.Warning
        ));
        diagnosticsList.push(new vscode.Diagnostic(
          existing,
          `${symbolNode.name} 在 ${getSectionLabel(sectionName)} 中已在 ${describePropertyScope(scope)} 作用域定义`,
          vscode.DiagnosticSeverity.Information
        ));
      }

      for (const scope of propertyScopes) {
        if (!seenScopes.has(scope)) {
          seenScopes.set(scope, symbolRange);
        }
      }

      if (propertyScopes.length > 0) {
        seenPropertyScopes.set(symbolNode.name, seenScopes);
      }
    } else {
      const existing = seenSymbols.get(symbolIdentity);
      if (featureConfig.diagnosticsCheckDuplicateDefinitions && existing) {
        diagnosticsList.push(new vscode.Diagnostic(
          symbolRange,
          `${getSectionLabel(sectionName)}中存在重复定义: ${symbolIdentity}`,
          vscode.DiagnosticSeverity.Warning
        ));
        diagnosticsList.push(new vscode.Diagnostic(
          existing,
          `${symbolIdentity} 在 ${getSectionLabel(sectionName)} 中已定义`,
          vscode.DiagnosticSeverity.Information
        ));
      } else {
        seenSymbols.set(symbolIdentity, symbolRange);
      }
    }

    if (sectionName === 'Properties' && featureConfig.diagnosticsCheckMissingPropertyFields) {
      validatePropertyStructure(document, diagnosticsList, symbolNode);
    }
  }
}

export function validatePropertyStructure(
  document: vscode.TextDocument,
  diagnosticsList: vscode.Diagnostic[],
  propertyNode: DefElementNode
): void {
  const propertyRange = createNodeRange(document, propertyNode);

  if (!getDirectChildElement(propertyNode, 'Type')) {
    diagnosticsList.push(new vscode.Diagnostic(
      propertyRange,
      `属性 ${propertyNode.name} 缺少 <Type> 定义`,
      vscode.DiagnosticSeverity.Error
    ));
  }

  if (!getDirectChildElement(propertyNode, 'Flags')) {
    diagnosticsList.push(new vscode.Diagnostic(
      propertyRange,
      `属性 ${propertyNode.name} 缺少 <Flags> 定义`,
      vscode.DiagnosticSeverity.Error
    ));
  }
}

export function getPropertyFlagScopes(propertyNode: DefElementNode): PropertyScope[] {
  // 逐 token 判桶(normalizeFlagTokens 拆 `|` + 别名 + 遗留折叠):组合 Flags
  // 串(BASE | ALL_CLIENTS)整串 Set 成员判断不中任何桶,判重检查会被静默
  // 跳过——kode 宽容拆分组合串(def-flags §traps),拆分后逐 token 落桶才能
  // 让桶相交判重覆盖到组合形态。
  const tokens = normalizeFlagTokens(getScalarChildValue(propertyNode, 'Flags') ?? '');
  if (tokens.length === 0) {
    return [];
  }

  const inSet = (set: Set<string>): boolean => tokens.some(token => set.has(token));
  const scopes: PropertyScope[] = [];
  if (inSet(ENTITY_BASE_DATA_FLAGS)) {
    scopes.push('base');
  }
  if (inSet(ENTITY_CELL_DATA_FLAGS)) {
    scopes.push('cell');
  }
  if (inSet(ENTITY_CLIENT_DATA_FLAGS)) {
    scopes.push('client');
  }
  return scopes;
}

export function normalizePropertyFlag(flags: string | undefined): string | undefined {
  const normalizedFlag = flags?.trim().toUpperCase();
  if (!normalizedFlag) {
    return undefined;
  }

  // g_entityFlagMapping 12 项(entitydef.cpp:161-174)别名归一,与
  // src/generated/flagDomains.ts 单一来源同表——此前缺 CELL 归一,
  // `<Flags>CELL</Flags>` 的域判读会丢 cell 面。
  return FLAG_DOMAIN_ALIAS[normalizedFlag] ?? normalizedFlag;
}

export function describePropertyScope(scope: PropertyScope): string {
  return PROPERTY_SCOPE_LABELS[scope];
}
