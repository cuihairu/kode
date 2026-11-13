/**
 * KSEM-SER-03:getDictFromObj 输出绑定 FIXED_DICT schema。
 *
 * 引擎真源(datatype.cpp FixedDictType::addToStreamEx,契约真源
 * docs/review/2026-11-13-ksem-ser-02-contract-model.md §2):序列化出口
 * hasImpl() → impl_getDictFromObj(pyValue) 先行,返回 dict 逐字段按
 * keyTypes_ 声明序装载;**缺键或 isSameType 失败 → 静默 parseDefaultStr("")
 * 默认值顶替,不报错不中止**——转换函数的结构错误在引擎侧表现为「静默写
 * 默认值上 wire/db」,静态面必须提前抓出。
 *
 * 判定面(保守,误报=0 优先;绑定面复用 STRUCT-06 implementedByBinding
 * 的裁定——本模块只吃已给定 container+symbol,绑定未成立的不进):
 * - 绑定推导(调用方):CustomTypeInfo.implementedBy 指向本文档 + 符号末段;
 * - 方法体内 `return {…}` 字面量 → 直接对 schema 校验(锚 return);
 * - 方法体内局部名 `d = {…}` 后裸 `return d` → 校验落在构造写点
 *   (验收原句「定位到 return 或构造写点」);名字重绑定非字面量 → 作废不猜;
 * - 键宇宙开放(`**` 展开/动态键)→ 缺键不报、多键照报(与 STRUCT-04
 *   构造点同口径,同一配对/切分核心 matchDictBraces+parseDictPairs);
 * - 字段值结构面复用 CELL-08 同一引擎标量真源,仅内置标量字段裁定;
 * - 其余 return 形态(调用/链/元组)与缺失方法/类不可解析 → 零产出不猜。
 *
 * 纯逻辑层,不 import vscode。
 */

import { l10nText } from '../nlsRuntime';
import type { CustomTypeInfo } from '../definitionWorkspace';
import {
  matchDictBraces,
  parseDictPairs,
  containerSource,
  type FixedDictConstructDiagnosticItem,
  type MatchedBraces
} from './fixedDictConstructCheck';
import {
  classifyCellDataWriteValue,
  cellDataScalarFamilyLabel,
  judgeCellDataValueStructure,
  type CellDataValueLiteral
} from './cellDataWriteCheck';
import { parsePythonFile, pythonCodeLines } from './pythonParser';

export const FIXED_DICT_RETURN_SCHEMA_DIAGNOSTIC_CODE = 'kbengine.fixedDictReturnSchema';

/** 一个绑定面:FD 容器 + 绑定符号名(implementedBy 末段,调用方拆好)。 */
export interface FixedDictImplBinding {
  container: CustomTypeInfo;
  symbol: string;
}

/** 一处序列化出口错配。 */
export interface FixedDictReturnFinding {
  line: number;
  /** 0 基字符列。 */
  character: number;
  length: number;
  /** missing=缺声明字段;extra=字面量键不在声明集;type=字段值结构错配。 */
  kind: 'missing' | 'extra' | 'type';
  /** FD 容器类型名。 */
  container: string;
  /** missing:缺的字段名(声明序逗号串);extra/type:涉事键。 */
  key: string;
  expected: string;
  actual: string;
  /** types.xml 声明位置(file:line)。 */
  source: string;
  /** return=直接返回字面量;construct=裸名返回锚构造写点。 */
  anchor: 'return' | 'construct';
  message: string;
}

/** 消息模板单一来源(缺键面)。 */
export function renderFixedDictReturnMissingMessage(
  container: string,
  fields: string,
  source: string
): string {
  return l10nText(
    '{container}.getDictFromObj returns a dict missing field(s) {fields} declared in {source}; the engine silently substitutes default values for missing keys',
    { container, fields, source }
  );
}

/** 消息模板单一来源(多键面)。 */
export function renderFixedDictReturnExtraMessage(
  container: string,
  key: string,
  source: string
): string {
  return l10nText(
    '"{key}" is not a field of {container} (declared in {source}); getDictFromObj must return only declared fields',
    { container, key, source }
  );
}

/** 消息模板单一来源(字段值结构面)。 */
export function renderFixedDictReturnTypeMessage(
  container: string,
  key: string,
  expected: string,
  source: string,
  actual: string
): string {
  return l10nText(
    '{container}.getDictFromObj field "{key}" expects {expected} (declared in {source}) but this value reads as {actual}; a wrong-typed field is silently replaced by the default value on wire',
    { container, key, expected, source, actual }
  );
}

/** 行掩码:注释与字符串原位抹空(pythonCodeLines,偏移零位移)——docstring/注释里的
 * `return {` 假阳性由此排除;列偏移不变,brace 定位与 matchDictBraces 同面。 */
function validateLiteralAgainstSchema(
  matched: MatchedBraces,
  binding: FixedDictImplBinding,
  anchor: 'return' | 'construct'
): FixedDictReturnFinding[] {
  const container = binding.container;
  const source = containerSource(container);
  const { pairs, openUniverse } = parseDictPairs(matched);
  const literalKeys = new Map<string, { keyStart: { line: number; character: number }; valueStart: { line: number; character: number }; valueText: string }>();
  for (const pair of pairs) {
    if (pair.spread || pair.key === null) {
      continue; // 宇宙开放项不进字面量键集
    }
    literalKeys.set(pair.key, pair);
  }

  const findings: FixedDictReturnFinding[] = [];

  // 缺键:键宇宙封闭才可判(声明集 − 字面量键);引擎对缺键静默写默认值
  if (!openUniverse) {
    const missing = container.properties.filter(property => !literalKeys.has(property.name));
    if (missing.length > 0) {
      const fields = missing.map(property => property.name).join(', ');
      findings.push({
        line: matched.startLine,
        character: matched.startColumn,
        length: 1,
        kind: 'missing',
        container: container.name,
        key: fields,
        expected: '',
        actual: '',
        source,
        anchor,
        message: renderFixedDictReturnMissingMessage(container.name, fields, source)
      });
    }
  }

  for (const [key, pair] of literalKeys) {
    const field = container.properties.find(property => property.name === key);
    if (!field) {
      // 多键:宇宙开放也照报(展开带不回一个字面量多键)
      findings.push({
        line: pair.keyStart.line,
        character: pair.keyStart.character,
        length: key.length,
        kind: 'extra',
        container: container.name,
        key,
        expected: '',
        actual: '',
        source,
        anchor,
        message: renderFixedDictReturnExtraMessage(container.name, key, source)
      });
      continue;
    }
    // 字段值结构面:内置标量按字面量裁定;其余类型/非字面量值不猜
    const familyLabel = field.typeName ? cellDataScalarFamilyLabel(field.typeName) : null;
    if (!familyLabel) {
      continue;
    }
    const literal: CellDataValueLiteral = classifyCellDataWriteValue(pair.valueText);
    const verdict = judgeCellDataValueStructure(literal, field.typeName ?? '');
    if (verdict && !verdict.ok) {
      findings.push({
        line: pair.valueStart.line,
        character: pair.valueStart.character,
        length: Math.max(1, pair.valueText.length),
        kind: 'type',
        container: container.name,
        key,
        expected: familyLabel,
        actual: verdict.actual,
        source,
        anchor,
        message: renderFixedDictReturnTypeMessage(
          container.name, key, familyLabel, source, verdict.actual
        )
      });
    }
  }
  return findings;
}

/**
 * 序列化出口 schema 校验入口。bindings = 调用方从 CustomTypeInfo 注册表推导
 * (implementedBy 指向本文档的绑定面);无绑定/类不可解析/方法缺失 → 零产出。
 */
export function computeGetDictFromObjReturnFindings(
  text: string,
  bindings: readonly FixedDictImplBinding[]
): FixedDictReturnFinding[] {
  const findings: FixedDictReturnFinding[] = [];
  if (bindings.length === 0) {
    return findings;
  }
  const parsed = parsePythonFile(text, 'getDictFromObjReturnCheck');
  const lines = pythonCodeLines(text);
  const realLines = text.split(/\r?\n/);

  for (const binding of bindings) {
    if (!binding.symbol) {
      continue;
    }
    // 同名多类:歧义不猜(动态返回不冒称已证明,SER-07 同口径)
    const classes = parsed.classes.filter(cls => cls.name === binding.symbol);
    if (classes.length !== 1) {
      continue;
    }
    const cls = classes[0];
    const def = cls.methods.get('getDictFromObj');
    if (!def) {
      continue; // 方法缺失归 userTypeContract lane,此处零产出
    }

    // 方法体域:def 行缩进为界,首个缩进 ≤ def 缩进的非空行收尾(掩码行缩进=真实缩进)
    const defLine = realLines[def.line] ?? '';
    const defIndent = defLine.length - defLine.trimStart().length;
    let line = def.line + 1;
    /** 局部名 → 已配对字面量(重绑定非字面量 → null 作废)。 */
    const dictLocals = new Map<string, MatchedBraces | null>();
    while (line < lines.length) {
      const masked = lines[line] ?? '';
      if (masked.trim().length > 0) {
        const indent = masked.length - masked.trimStart().length;
        if (indent <= defIndent) {
          break; // 方法体收尾
        }
        // 嵌套 def:内层 return 不返回本方法,整块跳过(域诚实)
        if (/^\s*def\s/.test(masked)) {
          const nestedIndent = indent;
          line += 1;
          while (line < lines.length) {
            const inner = lines[line] ?? '';
            if (inner.trim().length > 0 && (inner.length - inner.trimStart().length) <= nestedIndent) {
              break;
            }
            line += 1;
          }
          continue;
        }
      }

      // 局部名 = 非字面量(作废该名的既有字面量;排除 == 与增强赋值)
      const nonLiteralAssign = masked.match(/^\s*([A-Za-z_]\w*)\s*=(?![=])\s*(?!\{)\S/);
      if (nonLiteralAssign) {
        dictLocals.set(nonLiteralAssign[1], null);
        line += 1;
        continue;
      }

      // 局部名 = 字面量(记录构造写点;列取掩码行 `{` 位=真实列,配对走原文行)
      const literalAssign = masked.match(/^(\s*)([A-Za-z_]\w*)\s*=\s*\{/);
      if (literalAssign) {
        const braceColumn = masked.indexOf('{');
        const matched = matchDictBraces(realLines, line, braceColumn);
        dictLocals.set(literalAssign[2], matched);
        line = matched ? matched.endLine + 1 : line + 1;
        continue;
      }

      // return 字面量(锚 return;配对走原文行,键串内容完好)
      if (/^\s*return\s*\{/.test(masked)) {
        const braceColumn = masked.indexOf('{');
        const matched = matchDictBraces(realLines, line, braceColumn);
        if (matched) {
          findings.push(...validateLiteralAgainstSchema(matched, binding, 'return'));
          line = matched.endLine + 1;
          continue;
        }
        line += 1;
        continue;
      }

      // 裸名 return(锚构造写点;掩码行尾空白即注释位,$ 照常成立)
      const returnBare = masked.match(/^\s*return\s+([A-Za-z_]\w*)\s*$/);
      if (returnBare) {
        const local = dictLocals.get(returnBare[1]);
        if (local) {
          findings.push(...validateLiteralAgainstSchema(local, binding, 'construct'));
        }
        line += 1;
        continue;
      }

      line += 1;
    }
  }
  return findings;
}

/** finding → 诊断项(纯数据;extension 侧转 vscode.Diagnostic,与构造点同形状)。 */
export function fixedDictReturnFindingToItem(
  finding: FixedDictReturnFinding
): FixedDictConstructDiagnosticItem {
  return {
    range: {
      start: { line: finding.line, character: finding.character },
      end: { line: finding.line, character: finding.character + finding.length }
    },
    message: finding.message,
    severity: 'Warning',
    source: 'kbengine',
    code: FIXED_DICT_RETURN_SCHEMA_DIAGNOSTIC_CODE
  };
}
