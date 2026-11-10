// C-23 交付②首条规则(KBE-PY-015):FIXED_DICT 属性子键赋值 lint。
// 数据源 = KB-001 行为知识结构化条目(src/knowledge/trapsKnowledge.ts,
// detection='fixed-dict-nested-mutation')。引擎语义:属性同步以「属性
// 顶层整体赋值」为单位,FIXED_DICT 子键(点号/字符串下标)赋值只改字典
// 对象内部,不触发同步事件——须整体重赋。
//
// 纯逻辑层,不 import vscode。判定(保守面,误报=0 优先):
//   - 单行语句(分号/反斜杠续行/多行赋值目标不分析,如实边界);
//   - 目标必须是 `self.<属性>` 单段前缀(属性名在调用方传入的
//     FIXED_DICT 属性表内;`other.profile`/`self.cell.position` 不参与);
//   - 子键两形:`self.<prop>.<key> …=`(含增强赋值)与
//     `self.<prop>['<key>'] …=`;更深嵌套(`self.<prop>.<key>.<k2> =`)
//     同样不触发同步,亦报(key 取首段,quick fix 不生成);
//   - 属性顶层整体赋值(`self.<prop> = …`)不报——这正是正确姿势;
//   - 注释行/字符串字面量里的同形文本不报。
//
// FIXED_DICT 判定(属性类型→types.xml 类型图)在调用方(wiring 层)
// 完成,本模块只消费属性名集合。

import { l10nText } from '../nlsRuntime';

export const FIXED_DICT_MUTATION_DIAGNOSTIC_CODE = 'kbengine.fixedDictNestedMutation';

/** 一处子键赋值 */
export interface FixedDictMutationFinding {
  line: number;
  /** 目标表达式起点(`self` 的 0 起列) */
  character: number;
  /** 目标表达式长度(到赋值运算符前) */
  length: number;
  property: string;
  key: string;
  kind: 'attr' | 'subscript';
  /** 整条语句文本(quick fix 取右值用) */
  statement: string;
  message: string;
}

const ATTR_TARGET = /^(\s*)\bself\.(\w+)((?:\.\w+)+)\s*(?:=[^=]|[+\-*/%|&^]=)/;
const SUBSCRIPT_TARGET = /^(\s*)\bself\.(\w+)\[((?:'[^']*'|"[^"]*"))\]\s*(?:=[^=]|[+\-*/%|&^]=)/;

/**
 * 分析 FIXED_DICT 属性子键赋值。fixedDictProperties:属性名 →
 * 顶层键集(仅证据面,判定只用键名集合的键存在性不做强校验)。
 */
export function analyzeFixedDictMutations(
  text: string,
  fixedDictProperties: ReadonlyMap<string, readonly string[]>
): FixedDictMutationFinding[] {
  const findings: FixedDictMutationFinding[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const property = matchFixedDictTarget(raw, fixedDictProperties);
    if (!property) {
      continue;
    }
    findings.push(buildFinding(index, raw, property));
  }
  return findings;
}

/** 单行目标匹配:返回命中的属性名;注释/非 FIXED_DICT 属性不命中 */
function matchFixedDictTarget(
  lineText: string,
  fixedDictProperties: ReadonlyMap<string, readonly string[]>
): { name: string; kind: 'attr' | 'subscript' } | null {
  // 字符串字面量里的同形文本不报:语句以引号开头(字符串续行/纯字面量)跳过
  const stripped = lineText.trim();
  if (stripped.startsWith('"') || stripped.startsWith("'")) {
    return null;
  }
  const attr = ATTR_TARGET.exec(lineText);
  if (attr && fixedDictProperties.has(attr[2])) {
    return { name: attr[2], kind: 'attr' };
  }
  const subscript = SUBSCRIPT_TARGET.exec(lineText);
  if (subscript && fixedDictProperties.has(subscript[2])) {
    return { name: subscript[2], kind: 'subscript' };
  }
  return null;
}

/** 诊断文案(l10n 模板单一来源;Rust 结构面经 wiring 层用本函数渲染) */
export function renderFixedDictMutationMessage(property: string): string {
  return l10nText(
    'FIXED_DICT property sub-key assignment does not trigger the property sync event; reassign {property} as a whole',
    { property: `self.${property}` }
  );
}

function buildFinding(
  line: number,
  lineText: string,
  property: { name: string; kind: 'attr' | 'subscript' }
): FixedDictMutationFinding {
  const indent = lineText.length - lineText.trimStart().length;
  // 目标表达式:语句首到赋值运算符(=/增强)之间的 `self.<prop>…` 形态
  const targetMatch = /^\s*(self\.\w+(?:\.\w+)*(?:\[[^\]]+\])*)\s*(?:=[^=]|[+\-*/%|&^]=)/.exec(lineText);
  const target = targetMatch ? targetMatch[1] : lineText.slice(indent);
  const key = property.kind === 'attr'
    ? target.slice(`self.${property.name}.`.length)
    : (/\[['"]([^'"]+)['"]\]/.exec(target)?.[1] ?? '');
  return {
    line,
    character: indent,
    length: target.length,
    property: property.name,
    key,
    kind: property.kind,
    statement: lineText.trim(),
    message: renderFixedDictMutationMessage(property.name)
  };
}

/**
 * quick fix 文本:整体重赋习语 `{**old, key: rhs}`。仅对单段键的直接
 * 赋值(非增强)生成——增强赋值的右值回算不可靠,返回 null(不冒充)。
 */
export function buildFixedDictWholeReassignText(
  statement: string,
  property: string,
  key: string
): string | null {
  // 增强赋值(+= 等)不生成(右值回算不可靠)
  if (/[+\-*/%|&^]=\s/.test(statement) || /\s[+\-*/%|&^]=/.test(statement)) {
    return null;
  }
  const eq = statement.indexOf('=', statement.indexOf(property));
  if (eq < 0) {
    return null;
  }
  const rhs = statement.slice(eq + 1).trim();
  if (!rhs) {
    return null;
  }
  const keyExpr = key.startsWith("'") || key.startsWith('"') ? key : `'${key}'`;
  return `self.${property} = {**self.${property}, ${keyExpr}: ${rhs}}`;
}
