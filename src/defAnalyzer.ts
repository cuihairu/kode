import {
  DEF_METHOD_SECTIONS,
  DefDocument,
  DefElementNode,
  DefTextNode,
  getDirectChildElement,
  getDirectChildElements,
  getDirectChildElementsByName,
  getLineNumberAt,
  parseDefDocument
} from './defParser';

// .def 静态分析建议(性能分析建议,COMPLETED_FEATURES「未来增强功能」条目)。
// 定位与语言侧实时诊断(语法检查,languageProviders)错位:本模块只产出
// 「优化建议」——引擎注册对齐、同步开销、冗余定义三类,不做重复定义等
// 既有实时诊断已覆盖的结构校验。检查项定案见 COMPLETED_FEATURES.md 同名
// 条目与 README「性能分析」节。

export interface DefAnalysisFinding {
  /** 检查项标识(见 CHECK describable 常量与文档) */
  check: DefAnalysisCheck;
  severity: DefAnalysisSeverity;
  /** 1 基行号(报告展示用) */
  line: number;
  /** 0 基偏移与长度(诊断定位用) */
  offset: number;
  length: number;
  /** 涉及的属性/方法名(无则省略) */
  name?: string;
  message: string;
}

export type DefAnalysisSeverity = 'error' | 'warning' | 'info';

export type DefAnalysisCheck =
  | 'phantom-type'
  | 'missing-type'
  | 'duplicate-type-tag'
  | 'heavy-sync-broadcast'
  | 'redundant-detail-level'
  | 'invalid-identifier'
  | 'method-property-collision';

export const DEF_ANALYSIS_SEVERITY_ORDER: Record<DefAnalysisSeverity, number> = {
  error: 0,
  warning: 1,
  info: 2
};

// 引擎从未注册、写了必加载失败的类型名(datatypes.cpp addDataType 真值的
// 补集高频误写;kbengineMetadata.test.ts 对引擎源码锁定注册表)。
const PHANTOM_TYPE_NAMES = new Set(['BOOL', 'BOOLEAN', 'TUPLE', 'MAP', 'FIXED_ARRAY']);

// 大负载类型:对全体客户端广播时同步开销显著(字符串按长度、容器按元素数
// 逐变更同步)。
const HEAVY_SYNC_TYPE_NAMES = new Set([
  'STRING',
  'UNICODE',
  'BLOB',
  'ARRAY',
  'FIXED_DICT',
  'PY_DICT',
  'PY_LIST',
  'PY_TUPLE',
  'VECTOR2',
  'VECTOR3',
  'VECTOR4'
]);

// 客户端可见旗标:DetailLevel 只影响这些旗标下的 AOI 细节同步;
// 纯服务端属性(CELL_PRIVATE 等)配 DetailLevel 属冗余字段。
const CLIENT_SYNC_FLAGS = new Set(['ALL_CLIENTS', 'ANY_CLIENT', 'CELL_PUBLIC', 'OTHER_CLIENTS']);

// 属性/方法名会落地为 Python 实体类的成员名:defParser 标签字符集
// ([A-Za-z_][A-Za-z0-9_]*)已保证标识符形态,此处只需拦 Python 关键字——
// 关键字成员令实体类生成失败。
const PYTHON_KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break',
  'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally',
  'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal',
  'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield'
]);

const isPythonKeyword = (name: string): boolean => PYTHON_KEYWORDS.has(name);

const finding = (
  check: DefAnalysisCheck,
  severity: DefAnalysisSeverity,
  node: { offset: number; length: number },
  line: number,
  message: string,
  name: string
): DefAnalysisFinding => ({
  check,
  severity,
  line,
  offset: node.offset,
  length: node.length,
  name,
  message
});

const textNodeSpan = (node: DefTextNode): { offset: number; length: number } => ({
  offset: node.startOffset,
  length: Math.max(node.endOffset - node.startOffset, 1)
});

const nameSpan = (node: DefElementNode): { offset: number; length: number } => ({
  offset: node.tagStart + 1,
  length: node.name.length
});

const describeKeywordProblem = (name: string): string =>
  `名字 ${name} 是 Python 关键字,实体类无法生成该成员`;

const analyzePropertyNode = (
  document: DefDocument,
  propertyNode: DefElementNode,
  findings: DefAnalysisFinding[]
): void => {
  const lineAtNode = (node: DefElementNode): number =>
    getLineNumberAt(document, node.tagStart);

  // 命名合法性(Python 成员名不得为关键字)
  if (isPythonKeyword(propertyNode.name)) {
    findings.push(
      finding(
        'invalid-identifier',
        'error',
        nameSpan(propertyNode),
        lineAtNode(propertyNode),
        describeKeywordProblem(propertyNode.name),
        propertyNode.name
      )
    );
  }

  const typeNodes = getDirectChildElementsByName(propertyNode, 'Type');
  const typeNode = typeNodes[0];
  const typeText = typeNode?.children.find((child): child is DefTextNode => child.kind === 'text');
  const typeValue = typeText ? typeText.text.trim() : '';

  // 类型缺失或为空:引擎无法实例化属性
  if (!typeNode || !typeValue) {
    findings.push(
      finding(
        'missing-type',
        'error',
        nameSpan(propertyNode),
        lineAtNode(propertyNode),
        `属性 ${propertyNode.name} 缺少有效的 <Type>,引擎无法确定存储与同步布局`,
        propertyNode.name
      )
    );
  }

  // 引擎未注册的幻影类型:加载必失败
  if (typeText && PHANTOM_TYPE_NAMES.has(typeValue)) {
    findings.push(
      finding(
        'phantom-type',
        'error',
        textNodeSpan(typeText),
        lineAtNode(typeNode),
        `属性 ${propertyNode.name} 的类型 ${typeValue} 引擎未注册,实体加载会失败;请改用注册表中的类型`,
        propertyNode.name
      )
    );
  }

  // 重复 <Type>:存在取值歧义的冗余定义
  if (typeNodes.length > 1) {
    findings.push(
      finding(
        'duplicate-type-tag',
        'warning',
        nameSpan(propertyNode),
        lineAtNode(propertyNode),
        `属性 ${propertyNode.name} 定义了 ${typeNodes.length} 个 <Type>,存在取值歧义,请仅保留一个`,
        propertyNode.name
      )
    );
  }

  const flagsNode = getDirectChildElement(propertyNode, 'Flags');
  const flagsText = flagsNode?.children.find((child): child is DefTextNode => child.kind === 'text');
  const flags = (flagsText?.text ?? '')
    .split('|')
    .map(flag => flag.trim())
    .filter(Boolean);

  // 大字段对全体客户端广播:同步开销随变更频率线性放大
  if (
    flagsText &&
    typeValue &&
    flags.includes('ALL_CLIENTS') &&
    HEAVY_SYNC_TYPE_NAMES.has(typeValue)
  ) {
    findings.push(
      finding(
        'heavy-sync-broadcast',
        'warning',
        textNodeSpan(flagsText),
        lineAtNode(propertyNode),
        `属性 ${propertyNode.name}(${typeValue})以 ALL_CLIENTS 对全体客户端同步,大字段建议收窄旗标或改用 tag/DetailLevel 降低同步粒度`,
        propertyNode.name
      )
    );
  }

  // DetailLevel 只作用于客户端可见属性的 AOI 细节;纯服务端属性配了也无效
  const detailNode = getDirectChildElement(propertyNode, 'DetailLevel');
  if (detailNode && !flags.some(flag => CLIENT_SYNC_FLAGS.has(flag))) {
    findings.push(
      finding(
        'redundant-detail-level',
        'info',
        nameSpan(propertyNode),
        lineAtNode(propertyNode),
        `属性 ${propertyNode.name} 的 Flags 无客户端可见性,配置 <DetailLevel> 不产生任何效果(冗余字段)`,
        propertyNode.name
      )
    );
  }
};

/**
 * 对一份 .def 文本做静态分析,返回优化建议列表(按文档顺序)。
 */
export function analyzeDefDocument(text: string): DefAnalysisFinding[] {
  const document = parseDefDocument(text);
  const findings: DefAnalysisFinding[] = [];
  const root = document.root;
  if (!root) {
    return findings;
  }

  const propertyNames = new Set<string>();
  const propertiesSection = getDirectChildElement(root, 'Properties');
  if (propertiesSection) {
    for (const propertyNode of getDirectChildElements(propertiesSection)) {
      analyzePropertyNode(document, propertyNode, findings);
      propertyNames.add(propertyNode.name);
    }
  }

  for (const sectionName of DEF_METHOD_SECTIONS) {
    const sectionNode = getDirectChildElement(root, sectionName);
    if (!sectionNode) {
      continue;
    }
    for (const methodNode of getDirectChildElements(sectionNode)) {
      if (isPythonKeyword(methodNode.name)) {
        findings.push(
          finding(
            'invalid-identifier',
            'error',
            nameSpan(methodNode),
            getLineNumberAt(document, methodNode.tagStart),
            describeKeywordProblem(methodNode.name),
            methodNode.name
          )
        );
      }
      if (propertyNames.has(methodNode.name)) {
        findings.push(
          finding(
            'method-property-collision',
            'error',
            nameSpan(methodNode),
            getLineNumberAt(document, methodNode.tagStart),
            `方法 ${methodNode.name} 与同名属性冲突,Python 实体类中会互相覆盖`,
            methodNode.name
          )
        );
      }
    }
  }

  return findings;
}

const SEVERITY_LABELS: Record<DefAnalysisSeverity, string> = {
  error: '错误',
  warning: '警告',
  info: '提示'
};

/**
 * 把单文件分析结果格式化为输出面板报告(含逐条建议与汇总行)。
 */
export function formatDefAnalysisReport(label: string, findings: DefAnalysisFinding[]): string {
  if (findings.length === 0) {
    return `${label}: 未发现可优化项`;
  }

  const lines = findings.map(item =>
    `  [${SEVERITY_LABELS[item.severity]}] L${item.line} ${item.check}: ${item.message}`
  );
  const counts = { error: 0, warning: 0, info: 0 } as Record<DefAnalysisSeverity, number>;
  for (const item of findings) {
    counts[item.severity] += 1;
  }
  lines.push(
    `${label}: 共 ${findings.length} 条建议(错误 ${counts.error} / 警告 ${counts.warning} / 提示 ${counts.info})`
  );
  return lines.join('\n');
}
