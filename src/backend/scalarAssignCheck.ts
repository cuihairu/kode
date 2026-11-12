/**
 * KSEM-STRUCT-05:def 属性标量赋值范围/结构校验。
 *
 * 引擎真源(STRUCT-04 同款,零新表):datatypes.cpp `DataTypes::initialize`
 * 注册表经 CELL-08 的 SCALAR_FAMILIES 复用(judgeCellDataValueWithRange——
 * 范围面在 STRUCT-04 构造面豁免,本面全量裁定),属性引擎类型取 def
 * <Type> 直文本/CustomTypePropertyInfo.typeName 原文——不凭 Python 类型名
 * 判断(验收原句)。
 *
 * 确定消费点(赋值目标可解析为引擎标量):
 * - ①`self.<属性> = <整行字面量>`(def 属性 <Type> 是引擎标量);
 * - ②`self.<属性>["<键>"]… = <整行字面量>`(键链复用 STRUCT-02
 *   resolveFixedDictSubscriptKey,末键字段 typeName 进标量表);
 * - ③`self.<属性>[<整数>] = <整行字面量>`(数组根,元素类型取注册表
 *   内联 `of` 节点原文)。
 *
 * 纯逻辑层,不 import vscode。判定(保守面,误报=0 优先):
 * - RHS 必须整段单行字面量且非 `{…}`(dict 字面量归 STRUCT-04 构造面,
 *   两面按 RHS 形态天然互斥不重复);名字/调用/跨行残缺 → unknown 不猜;
 * - bool 是 int 子类入整数/浮点不报(CELL-08 同真值);浮点字面量入整数
 *   族=结构不符;整数字面量越带宽界(负入无符号/越界)=范围不符;
 * - None 入引擎标量=结构不符(isSameType 假);None 入 PYTHON 族不查
 *   (标量表外,类型推不出=诚实);
 * - 标量字面量赋给 FD 型目标(FD 容器/数组 FD 元素)不猜——容器面错配
 *   属 STRUCT-04 族边界,本面不越界;
 * - 混合链(数组元素再取键:`self.bag[0]["x"] = …`)不追——链状态机
 *   尚不跨数组段推进,诚实断链(见纪实边界节)。
 */

import { l10nText } from '../nlsRuntime';
import type { CustomTypeInfo } from '../definitionWorkspace';
import { classifyCellDataWriteValue, judgeCellDataValueWithRange, type CellDataValueLiteral, type CellDataValueVerdict, cellDataScalarFamilyLabel } from './cellDataWriteCheck';
import { resolveFixedDictSubscriptKey, type FixedDictChainSegment } from './fixedDictSubscript';
import { findLineCommentIndex } from './globalDataIndexCore';

export const SCALAR_ASSIGN_DIAGNOSTIC_CODE = 'kbengine.scalarAssign';
export const SCALAR_ASSIGN_DIAGNOSTICS_ENABLED_DEFAULT = true;

/** 一处标量赋值错配。 */
export interface ScalarAssignFinding {
  line: number;
  /** RHS 字面量起点(0 基字符列)。 */
  character: number;
  length: number;
  /** 错配面:structure=结构不符(含 None);range=整数越引擎标量界。 */
  kind: 'structure' | 'range';
  /** 目标表达式(`self.health` / `self.info["uid"]` / `self.bag[0]`)。 */
  target: string;
  /** 期望引擎标量文案(`UINT8 (int 0..255)`)。 */
  expected: string;
  /** 实际值类文案(str/int/None/…)。 */
  actual: string;
  /** range 面:涉事整数字面量文本。 */
  valueText: string;
  /** 声明来源段(`Avatar.def:5` / `types.xml:10`)。 */
  source: string;
  message: string;
}

/** 诊断项(纯数据;extension 侧转 vscode.Diagnostic,测试免 vscode 依赖)。 */
export interface ScalarAssignDiagnosticItem {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  message: string;
  severity: 'Warning';
  source: 'kbengine';
  code: string;
}

/** def 属性 → <Type> 直文本 + 声明来源段(locator 同契约;解析不出 null)。 */
export type ScalarAssignResolve = (propertyName: string) => Promise<{ typeName: string; source: string } | null>;

/** 消息模板单一来源(结构面)。 */
export function renderScalarAssignStructureMessage(
  target: string,
  expected: string,
  source: string,
  actual: string
): string {
  return l10nText(
    '{target} expects {expected} as declared in {source}; got {actual}',
    { target, expected, source, actual }
  );
}

/** 消息模板单一来源(范围面)。 */
export function renderScalarAssignRangeMessage(
  target: string,
  value: string,
  expected: string,
  source: string
): string {
  return l10nText(
    '{target} value {value} is out of range for {expected} as declared in {source}',
    { target, value, expected, source }
  );
}

/** 声明来源段(types.xml 基名:行)。 */
function containerSource(container: CustomTypeInfo): string {
  const base = container.filePath.split(/[\\/]/).pop() ?? container.name;
  return container.line > 0 ? `${base}:${container.line}` : base;
}

/**
 * 注册表层引擎标量名裁定(别名链原地逐层下钻,环有界):引擎标量名直配
 * 标量表;自定义别名沿 aliasType 走到引擎标量名;落 FIXED_DICT/ARRAY/
 * 未知/环 → null(不接管)。不走 pythonTypeStubs 注解链——那是 Python
 * 类型名(int/list),不是引擎标量名(验收:不凭 Python 类型名判断)。
 */
function resolveEngineScalarTypeName(
  raw: string,
  customTypes: readonly CustomTypeInfo[]
): string | null {
  let current = raw.trim();
  const visited = new Set<string>();
  while (current.length > 0 && !visited.has(current)) {
    visited.add(current);
    if (cellDataScalarFamilyLabel(current)) {
      return current;
    }
    const info = customTypes.find(candidate => candidate.name === current);
    if (!info) {
      return null;
    }
    current = info.aliasType;
  }
  return null;
}

/** 赋值目标:`self.<属性>` + 括号段(字符串键或整数下标)列。 */
interface ScalarAssignTarget {
  prop: string;
  /** 段列:{kind:'key',key} | {kind:'index',text}(按出现序;text=原样下标文本)。 */
  segments: Array<{ kind: 'key'; key: string } | { kind: 'index'; text: string }>;
  /** RHS 首个非空白字符列。 */
  rhsColumn: number;
  rhsText: string;
}

const TARGET_LHS =
  /^(\s*)self\.([A-Za-z_]\w*)((?:\s*\[\s*(?:'([A-Za-z_]\w*)'|"([A-Za-z_]\w*)"|(\d+))\s*\])*)\s*=(?!=)(.*)$/;

/** 行剥注释后匹配目标形态;非 `self.<属性>[…] = <RHS>` 形态 → null。 */
function matchScalarAssignTarget(lineText: string): ScalarAssignTarget | null {
  const commentAt = findLineCommentIndex(lineText);
  const stripped = commentAt === -1 ? lineText : lineText.slice(0, commentAt);
  const match = TARGET_LHS.exec(stripped);
  if (!match) {
    return null;
  }
  // 括号列:逐段收(字符串键/整数下标);杂质段整体不匹配(正则 *)已保证
  const segments: ScalarAssignTarget['segments'] = [];
  const bracketBlock = match[3];
  const bracketRe = /\[\s*(?:'([A-Za-z_]\w*)'|"([A-Za-z_]\w*)"|(\d+))\s*\]/g;
  let bracketMatch: RegExpExecArray | null;
  let consumed = 0;
  while ((bracketMatch = bracketRe.exec(bracketBlock)) !== null) {
    // 段间只允许空白:已消费长度 + 空白须正好衔接下一段
    const gap = bracketBlock.slice(consumed, bracketMatch.index);
    if (gap.trim() !== '') {
      return null;
    }
    consumed = bracketMatch.index + bracketMatch[0].length;
    segments.push(
      bracketMatch[3] !== undefined
        ? { kind: 'index', text: bracketMatch[3] }
        : { kind: 'key', key: bracketMatch[1] ?? bracketMatch[2] }
    );
  }
  if (bracketBlock.slice(consumed).trim() !== '') {
    return null;
  }
  // `=` 列不经惰性组算(会把 = 前尾随空白漏出组外),用 indexOf 算术
  const eqAt = stripped.indexOf('=', match[1].length + 'self.'.length + match[2].length);
  if (eqAt < 0) {
    return null;
  }
  let rhsColumn = eqAt + 1;
  while (rhsColumn < stripped.length && /\s/.test(stripped[rhsColumn])) {
    rhsColumn += 1;
  }
  const rhsText = stripped.slice(rhsColumn).trim();
  if (!rhsText) {
    return null;
  }
  return { prop: match[2], segments, rhsColumn, rhsText };
}

/**
 * 目标引擎类型裁定。返回 {typeLabel, source} 进标量表才判;null=不接管
 * (FD 容器面/数组 FD 元素/解析链断/非标量)。
 */
async function resolveTargetEngineType(
  target: ScalarAssignTarget,
  resolveSelfPropertyType: ScalarAssignResolve,
  customTypes: readonly CustomTypeInfo[],
  resolveCache: Map<string, { typeName: string; source: string } | null>
): Promise<{ typeLabel: string; source: string } | null> {
  if (!resolveCache.has(target.prop)) {
    resolveCache.set(target.prop, await resolveSelfPropertyType(target.prop));
  }
  const rootType = resolveCache.get(target.prop) ?? null;
  if (!rootType) {
    return null; // def 属性不可解析:目标不定型
  }

  // ① 根形态(FD 容器目标接 dict 字面量归 STRUCT-04 面;标量字面量赋 FD
  // 不越界——别名链落 FIXED_DICT/ARRAY 时 resolveEngineScalarTypeName 即 null)
  if (target.segments.length === 0) {
    const engineType = resolveEngineScalarTypeName(rootType.typeName, customTypes);
    if (!engineType) {
      return null;
    }
    return { typeLabel: engineType, source: rootType.source };
  }

  // ② 全字符串键链:STRUCT-02 单一解析链,末键字段 typeName
  if (target.segments.every(segment => segment.kind === 'key')) {
    const keys = target.segments.map(segment => (segment as { kind: 'key'; key: string }).key);
    const resolution = resolveFixedDictSubscriptKey(
      rootType.typeName,
      keys.slice(0, -1).map<FixedDictChainSegment>(key => ({
        kind: 'key', key, keyStart: 0, keyEnd: 0, form: 'subscript' as const
      })),
      keys[keys.length - 1],
      customTypes
    );
    const field = resolution?.field;
    if (!field?.typeName) {
      return null;
    }
    const container = resolution!.container;
    const engineType = resolveEngineScalarTypeName(field.typeName, customTypes);
    if (!engineType) {
      return null; // FD/FD 字段非标量:构造面(STRUCT-04)或本面边界
    }
    return { typeLabel: engineType, source: containerSource(container) };
  }

  // ③ 单整数下标 + 数组根:元素类型取注册表内联 `of` 节点原文
  if (target.segments.length === 1 && target.segments[0].kind === 'index') {
    const arrayType = customTypes.find(
      info => info.name === rootType.typeName && info.aliasType === 'ARRAY'
    );
    const elementNode = arrayType?.structure.children.find(child => child.tag === 'of');
    const elementName = elementNode?.value.name;
    if (!elementName) {
      return null;
    }
    const engineType = resolveEngineScalarTypeName(elementName, customTypes);
    if (!engineType) {
      return null;
    }
    return { typeLabel: engineType, source: containerSource(arrayType!) };
  }

  return null; // 混合链(数组元素再取键):链状态机不跨数组段,诚实断链
}

/**
 * 标量赋值扫描(纯函数)。resolveSelfPropertyType 给 def 属性 <Type> 直文本
 * 与声明来源段;customTypes 为 types.xml 注册表快照。目标落不到引擎标量/
 * RHS 非整段字面量 → 空集。
 */
export async function analyzeScalarAssignWrites(
  text: string,
  resolveSelfPropertyType: ScalarAssignResolve,
  customTypes: readonly CustomTypeInfo[]
): Promise<ScalarAssignFinding[]> {
  const lines = text.split(/\r?\n/);
  const findings: ScalarAssignFinding[] = [];
  const resolveCache = new Map<string, { typeName: string; source: string } | null>();
  for (let line = 0; line < lines.length; line += 1) {
    const target = matchScalarAssignTarget(lines[line]);
    if (!target) {
      continue;
    }
    if (target.rhsText.startsWith('{')) {
      continue; // dict 字面量归 STRUCT-04 构造面,互斥不重复
    }
    const resolved = await resolveTargetEngineType(target, resolveSelfPropertyType, customTypes, resolveCache);
    if (!resolved) {
      continue;
    }
    const literal: CellDataValueLiteral = classifyCellDataWriteValue(target.rhsText);
    const verdict: CellDataValueVerdict | null = judgeCellDataValueWithRange(literal, resolved.typeLabel);
    if (!verdict) {
      continue; // unknown/非标量:不猜
    }
    const expected = cellDataScalarFamilyLabel(resolved.typeLabel) ?? resolved.typeLabel;
    const targetLabel = `self.${target.prop}${target.segments
      .map(segment => segment.kind === 'key'
        ? `["${(segment as { key: string }).key}"]`
        : `[${(segment as { text: string }).text}]`)
      .join('')}`;
    const message = verdict.reason === 'range'
      ? renderScalarAssignRangeMessage(targetLabel, verdict.valueText ?? '', expected, resolved.source)
      : renderScalarAssignStructureMessage(targetLabel, expected, resolved.source, verdict.actual);
    findings.push({
      line,
      character: target.rhsColumn,
      length: target.rhsText.length,
      kind: verdict.reason,
      target: targetLabel,
      expected,
      actual: verdict.actual,
      valueText: verdict.valueText ?? '',
      source: resolved.source,
      message
    });
  }
  return findings;
}

/** finding → 诊断项(纯数据;extension 侧转 vscode.Diagnostic)。 */
export function scalarAssignFindingToItem(finding: ScalarAssignFinding): ScalarAssignDiagnosticItem {
  return {
    range: {
      start: { line: finding.line, character: finding.character },
      end: { line: finding.line, character: finding.character + finding.length }
    },
    message: finding.message,
    severity: 'Warning',
    source: 'kbengine',
    code: SCALAR_ASSIGN_DIAGNOSTIC_CODE
  };
}
