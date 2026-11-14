/**
 * KSEM-CFG-05 配置值校验(纯核心,零 vscode 依赖)。
 *
 * 验收口径(todo.md SEM-035,旧 KSEM-CFG-05):校验**有源码/schema 依据**的
 * 类型、范围、枚举和必填;引擎容忍/忽略未知 key 的行为与确实报错分级。
 *
 * 证据分级(CFG-02 五级证据之上,只查证据支持的维度):
 *  - 类型面(error):record.evidence ∈ {engine-read-site, defaults-type-annotation}
 *    且 valueKind 可判读(integer/integer8/float/boolean)——引擎读取点/注释
 *    类型声明是源码级证据,坏值=启动解析失败级 → error;
 *  - 枚举面(warning):record.enumValues 非空(注释枚举块证据)——引擎对
 *    未登记值按掩码/忽略处理,约束强度未经源码证明 → warning;
 *  - 未知键面(information):CFG-03 dynamic-extension/dynamic-segment-child
 *    (custom 独有段)——引擎配置层只读已知键(kbengine_defaults.xml 是引擎
 *    全量键 dumps),custom 独有键被容忍忽略 → information(是用户自己的
 *    工具键时无需处理);
 *  - 范围/必填面:**无结构化证据源**(defaults 注释里只有散文提及,无
 *    机器可判的范围/必填标注)→ 本批不实现,零产出,不虚构区间。此缺口
 *    如实记载于对账文档与 unproven,待引擎侧证据可用再接。
 *
 * 证据闸(诚实面):value-only 形态候选(defaults-value-only)、defaults-comment、
 * docs-only、无记录路径一律不查——不从默认值形态猜约束。list 记录(<item>
 * 重复)无逐项证据,不查。string/unknown 类型任何字面量都可解析,不查。
 *
 * 分级与既有 configContractDiagnostics(工作区环境契约,KBE-CFG-001..006)
 * 互不重叠:那族查 debug.json/extraPaths/.gitignore 工作区层,本族查
 * kbengine.xml 值层。锚定=custom 文件行号(configPathLineIndex,注释掩码
 * 偏移稳定,首现开标签行)。
 */
import { contractRecordByPath } from './configContract';
import type { ConfigContractExtraction, ConfigContractRecord } from './configContract';
import { normalizeRootNode } from './configFieldIdentity';
import type { ConfigFieldIdentityScan } from './configFieldIdentity';
import type { ConfigXmlNode } from '../serverConfigMerge';

/** 运行时文案模板(l10nText 动态取词,key=英文源串,zh 包给译文) */
export const CONFIG_VALUE_MESSAGE_TEMPLATES = {
  typeMismatch:
    "{path} expects {expected}, got '{value}'; the engine parses this key at startup",
  enumMismatch:
    "'{value}' is not a documented value of {path} (documented: {values}); the engine ignores undocumented values",
  unknownKey:
    '{path} is not an engine config key (absent from kbengine_defaults.xml); the engine ignores it — fine if your own tooling reads it',
} as const;

export type ConfigValueSeverity = 'error' | 'warning' | 'information';

export type ConfigValueFindingCode =
  | 'kbengine.configValue.typeMismatch'
  | 'kbengine.configValue.enumMismatch'
  | 'kbengine.configValue.unknownKey';

export interface ConfigValueFinding {
  /** 点分路径(去 <root> 包裹) */
  path: string;
  /** custom XML 原文 1 基行号(该路径首现开标签行) */
  line: number;
  severity: ConfigValueSeverity;
  code: ConfigValueFindingCode;
  /** 文案模板(英文源串,l10n key);渲染用 l10nText(message, args) */
  message: string;
  args: Record<string, string>;
}

export interface ConfigValueValidationInput {
  /** custom XML 原文(行号锚定面) */
  customText: string;
  /** custom 解析树(kbengine.xml;调用方保证非 null) */
  customTree: ConfigXmlNode;
  /** CFG-02 契约提取(defaults 快照) */
  extraction: ConfigContractExtraction;
  /** CFG-03 字段身份扫描(defaults+custom 双树对扫) */
  scan: ConfigFieldIdentityScan;
}

const TYPE_EVIDENCE: ReadonlyArray<ConfigContractRecord['evidence']> = [
  'engine-read-site',
  'defaults-type-annotation',
];

/** 类型字面量判读(只收引擎读取点/类型声明证据支持的形态) */
function literalMatches(valueKind: ConfigContractRecord['valueKind'], text: string): boolean {
  switch (valueKind) {
    case 'integer':
    case 'integer8':
      return /^[+-]?\d+$/.test(text);
    case 'float':
      return /^[+-]?(\d+(\.\d+)?|\.\d+)$/.test(text);
    case 'boolean':
      return /^(true|false)$/i.test(text);
    default:
      // string/enum/list/unknown:本函数不裁(types only;enum/list 上层闸)
      return true;
  }
}

function expectedText(valueKind: ConfigContractRecord['valueKind']): string {
  switch (valueKind) {
    case 'integer':
    case 'integer8':
      return 'an integer';
    case 'float':
      return 'a number';
    case 'boolean':
      return 'true or false';
    default:
      return 'a literal';
  }
}

/**
 * custom XML 原文 → 路径首现行号表(1 基)。注释掩码(等长替换)保偏移;
 * <root> 包裹段不入路径;路径可重复(动态键/列表)时只记首现行。
 */
export function configPathLineIndex(text: string): Map<string, number> {
  const masked = text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
  const lines: Map<string, number> = new Map();
  const stack: string[] = [];
  let lastNewlineIdx = -1;
  let lastLineNo = 1;
  const lineAt = (offset: number): number => {
    for (let i = lastNewlineIdx + 1; i < offset; i += 1) {
      if (text[i] === '\n') {
        lastLineNo += 1;
        lastNewlineIdx = i;
      }
    }
    return lastLineNo;
  };
  const tagPattern = /<(\/?)([A-Za-z_][\w.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(masked)) !== null) {
    const [, closing, name, , selfClose] = match;
    if (name === 'root' && stack.length === 0) {
      continue;
    }
    if (closing) {
      const topIndex = stack.lastIndexOf(name);
      if (topIndex >= 0) {
        stack.length = topIndex;
      }
    } else if (!selfClose) {
      const path = [...stack, name].join('.');
      if (!lines.has(path)) {
        lines.set(path, lineAt(match.index));
      }
      stack.push(name);
    }
  }
  return lines;
}

/** custom 树全量值叶子遍历(列表容器不下钻,与 CFG-03 collect 同口径) */
function* walkLeaves(node: ConfigXmlNode, prefix: string): Generator<{ path: string; text: string; node: ConfigXmlNode }> {
  for (const child of node.children) {
    const path = prefix.length > 0 ? `${prefix}.${child.name}` : child.name;
    if (child.children.length > 0 && child.children.every((grandchild) => grandchild.name === 'item')) {
      // <item> 列表容器:无逐项证据,不查不入
      continue;
    }
    if (child.children.length === 0) {
      const text = child.text.trim();
      if (text.length > 0) {
        yield { path, text, node: child };
      }
      continue;
    }
    yield* walkLeaves(child, path);
  }
}

/** dynamic 段边界路径:路径截到首个 defaults 缺失段为止(后代归并到它) */
function dynamicBoundary(fieldPath: string, dynamicSegments: readonly string[]): string {
  const first = dynamicSegments[0];
  if (first === undefined) {
    return fieldPath;
  }
  const segments = fieldPath.split('.');
  const index = segments.indexOf(first);
  return index >= 0 ? segments.slice(0, index + 1).join('.') : fieldPath;
}

/**
 * 值校验主入口:类型面(error)/枚举面(warning)/未知键面(information),
 * 逐条带 custom 文件行号锚。范围/必填无证据源,零产出(见文件头诚实面)。
 */
export function computeConfigValueFindings(input: ConfigValueValidationInput): ConfigValueFinding[] {
  const { customText, customTree, extraction, scan } = input;
  const lines = configPathLineIndex(customText);
  const findings: ConfigValueFinding[] = [];
  const lineOf = (path: string): number => lines.get(path) ?? 1;

  for (const leaf of walkLeaves(normalizeRootNode(customTree), '')) {
    const record = contractRecordByPath(extraction, leaf.path);
    if (record && record.enumValues.length > 0) {
      // 枚举面:注释枚举块证据;未登记值引擎按忽略/掩码处理 → warning
      if (!record.enumValues.some((entry) => entry.value === leaf.text)) {
        findings.push({
          path: leaf.path,
          line: lineOf(leaf.path),
          severity: 'warning',
          code: 'kbengine.configValue.enumMismatch',
          message: CONFIG_VALUE_MESSAGE_TEMPLATES.enumMismatch,
          args: {
            value: leaf.text,
            path: leaf.path,
            values: record.enumValues.map((entry) => entry.value).join(', '),
          },
        });
      }
      continue;
    }
    if (
      record
      && TYPE_EVIDENCE.includes(record.evidence)
      && (record.valueKind === 'integer'
        || record.valueKind === 'integer8'
        || record.valueKind === 'float'
        || record.valueKind === 'boolean')
      && !literalMatches(record.valueKind, leaf.text)
    ) {
      // 类型面:引擎读取点/类型声明证据,坏值=启动解析失败级 → error
      findings.push({
        path: leaf.path,
        line: lineOf(leaf.path),
        severity: 'error',
        code: 'kbengine.configValue.typeMismatch',
        message: CONFIG_VALUE_MESSAGE_TEMPLATES.typeMismatch,
        args: {
          path: leaf.path,
          expected: expectedText(record.valueKind),
          value: leaf.text,
        },
      });
    }
  }

  // 未知键面:custom 独有段(dynamic-extension/segment-child)归并到首缺段
  // 边界(与 CFG-03「只记首缺段」同口径,后代不重复登记)→ information
  const reportedBoundaries = new Set<string>();
  for (const field of scan.fields) {
    if (field.kind !== 'dynamic-extension' && field.kind !== 'dynamic-segment-child') {
      continue;
    }
    const boundary = dynamicBoundary(field.path, field.dynamicSegments);
    if (boundary.length === 0 || reportedBoundaries.has(boundary)) {
      continue;
    }
    reportedBoundaries.add(boundary);
    findings.push({
      path: boundary,
      line: lineOf(boundary),
      severity: 'information',
      code: 'kbengine.configValue.unknownKey',
      message: CONFIG_VALUE_MESSAGE_TEMPLATES.unknownKey,
      args: { path: boundary },
    });
  }

  const severityOrder: Record<ConfigValueSeverity, number> = { error: 0, warning: 1, information: 2 };
  // 重复节点去重(CFG-11 负例集口径):custom 重复同名叶会产生同路径同锚
  // 的重复 finding——完全相同(路径/行/码/文案参数)的只留一条;值不同
  // (args 不同)的两条都留(两处都是真坏值)。行锚=首现行(configPathLineIndex
  // 只记首现),重复条目本就同锚。
  const seen = new Set<string>();
  const deduped = findings.filter((f) => {
    const key = `${f.path}\u0000${f.line}\u0000${f.code}\u0000${JSON.stringify(f.args)}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  return deduped.sort(
    (a, b) => a.line - b.line || severityOrder[a.severity] - severityOrder[b.severity] || a.path.localeCompare(b.path),
  );
}

/** 诊断范围字面量:该行去首尾空白后的 0 基字符区间(下划线锚定用) */
export function configLineSpan(text: string, line: number): { start: number; end: number } {
  const lines = text.split(/\r?\n/);
  const raw = lines[line - 1] ?? '';
  const start = raw.length - raw.trimStart().length;
  const end = raw.trimEnd().length;
  return { start, end: Math.max(end, start) };
}
