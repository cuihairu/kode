import * as fs from 'fs';
import * as path from 'path';
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
import { findEntityDefsRootFromFile, parseDefFileSemantics } from './defRenamer';

// .def 静态分析建议(性能分析建议,COMPLETED_FEATURES「未来增强功能」条目)。
// 定位与语言侧实时诊断(语法检查,languageProviders)错位:本模块只产出
// 「优化建议」——引擎注册对齐、同步开销、冗余定义三类,不做重复定义等
// 既有实时诊断已覆盖的结构校验。检查项定案见 COMPLETED_FEATURES.md 同名
// 条目与 README「性能分析」节。
// 批96 引擎复核后各检查口径对齐源码:客户端可见旗标取 ENTITY_CLIENT_DATA_FLAGS
// 真值(common.h),方法/属性同名与幻影类型按装载失败表述,Python 关键字按
// 「引擎不失败、脚本语法不可访问」表述,重复 <Type> 按引擎首取语义表述。

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
  | 'method-property-collision'
  | 'engine-limited-name'
  | 'inherited-name-collision';

export const DEF_ANALYSIS_SEVERITY_ORDER: Record<DefAnalysisSeverity, number> = {
  error: 0,
  warning: 1,
  info: 2
};

/** 祖先闭包面上一个名字的声明聚合(跨祖先并集,批116 继承链同名检查)。 */
export interface InheritedNameInfo {
  /** 祖先属性命中的域位并集(base/cell/client) */
  propertyDomains: Set<string>;
  /** 祖先组件槽命中的域位并集(组件槽经 addComponentProperty 走同一属性注册面) */
  componentDomains: Set<string>;
  /** 祖先方法所在段(base/cell/client) */
  methodSections: Set<string>;
  /** 各类声明的来源 def(相对定义根路径,去重,至多 3 个,提示文案用) */
  propertySources: string[];
  componentSources: string[];
  methodSources: string[];
}

/** 祖先闭包面:名字 → 声明聚合,analyzeDefDocument 的可选入参。 */
export type InheritedNames = Map<string, InheritedNameInfo>;

// 旗标 → 三域位映射(common.h L19-45 真值:base=BASE|BASE_AND_CLIENT,
// cell=CELL_PUBLIC|CELL_PRIVATE|ALL_CLIENTS|CELL_PUBLIC_AND_OWN|OWN_CLIENT|
// OTHER_CLIENTS,client=BASE_AND_CLIENT|ALL_CLIENTS|CELL_PUBLIC_AND_OWN|
// OWN_CLIENT|OTHER_CLIENTS)。同名属性判重按域位相交——不同域位同名引擎允许
// 共存(addPropertyDescription 的 findXxxPropertyDescription 按域查找)。
// CELL 是 g_entityFlagMapping 的别名(entitydef.cpp L161),归一到 CELL_PUBLIC。
const PROPERTY_FLAG_DOMAINS: Record<string, string[]> = {
  BASE: ['base'],
  BASE_AND_CLIENT: ['base', 'client'],
  CELL_PUBLIC: ['cell'],
  CELL_PRIVATE: ['cell'],
  ALL_CLIENTS: ['cell', 'client'],
  CELL_PUBLIC_AND_OWN: ['cell', 'client'],
  OWN_CLIENT: ['client'],
  OTHER_CLIENTS: ['client']
};

const flagDomainsOfTokens = (tokens: string[]): Set<string> => {
  const domains = new Set<string>();
  for (const token of tokens) {
    const flag = token.trim().toUpperCase();
    const normalized = flag === 'CELL' ? 'CELL_PUBLIC' : flag;
    for (const domain of PROPERTY_FLAG_DOMAINS[normalized] ?? []) {
      domains.add(domain);
    }
  }
  return domains;
};

// Flags 取值与 analyzePropertyNode 同口径按 '|' 容错拆分(引擎整串比对会拒绝
// 组合旗标,该情形由语言侧实时诊断拦,分析侧容错只影响建议面)
const propertyFlagDomains = (node: DefElementNode): Set<string> => {
  const flagsNode = getDirectChildElement(node, 'Flags');
  const flagsText = flagsNode?.children.find((child): child is DefTextNode => child.kind === 'text');
  return flagDomainsOfTokens((flagsText?.text ?? '').split('|').map(flag => flag.trim()).filter(Boolean));
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

// 客户端可见旗标:引擎真值为 ENTITY_CLIENT_DATA_FLAGS 位集(kbengine
// common.h L45 = ED_FLAG_BASE_AND_CLIENT | ALL_CLIENTS | CELL_PUBLIC_AND_OWN
// | OTHER_CLIENTS | OWN_CLIENT;旗标名单见 common.cpp stringToEntityDataFlags,
// 共 8 个、无 ANY_CLIENT)。DetailLevel 只影响这些旗标下的 AOI 细节同步;
// 纯服务端旗标(CELL_PUBLIC/CELL_PRIVATE/BASE)配 DetailLevel 属冗余字段。
const CLIENT_SYNC_FLAGS = new Set([
  'ALL_CLIENTS',
  'CELL_PUBLIC_AND_OWN',
  'OWN_CLIENT',
  'BASE_AND_CLIENT',
  'OTHER_CLIENTS'
]);

// 属性/方法名会落地为 Python 实体类的成员名:defParser 标签字符集
// ([A-Za-z_][A-Za-z0-9_]*)已保证标识符形态,此处只需拦 Python 关键字——
// 引擎 C 层 setattr 挂关键字名不报错(装载不失败),但 Python 脚本语法上
// 无法写 self.class 这类访问,成员事实上不可用。
const PYTHON_KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break',
  'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally',
  'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal',
  'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield'
]);

const isPythonKeyword = (name: string): boolean => PYTHON_KEYWORDS.has(name);

// 引擎受限属性名:validDefPropertyName(entitydef.cpp L967)按
// ENTITY_LIMITED_PROPERTYS 逐名拒绝(entitydef/common.h L125-158)。同一
// 名单约束三处:def 属性注册(PyEntityDef::registerDefPropertys)、脚本
// 实体类构造的属性/方法/客户端方法 DefContext(registerDefContext,抛
// AssertionError)与 Components 槽名(loadComponents)——拒绝即模块装载
// 失败,实体加载会失败。FIXED_DICT 键不受此限(引擎 DC_TYPE_FIXED_ITEM
// 分支注释明写放开该限制)。引擎还会拒绝 KBEngine.Entity 既有属性名
// (运行时 PyObject_GetAttrString 查询),该属性面不在引擎仓静态可推导,
// 本检查只收受限名单臂。
// 引擎源清单 "component" 行尾缺逗号、与下一行 "databaseID" 拼成单个条目
// "componentdatabaseID"(C 字符串字面拼接语义)——两个名字单独并不被拒;
// "interface" 与终止哨兵 "" 拼接后仍为 "interface",在名单内。此处按
// 编译后真值收录。
const ENTITY_LIMITED_PROPERTYS = new Set([
  'id',
  'position',
  'direction',
  'spaceID',
  'autoLoad',
  'cell',
  'base',
  'client',
  'cellData',
  'className',
  'componentdatabaseID',
  'isDestroyed',
  'shouldAutoArchive',
  'shouldAutoBackup',
  '__ACCOUNT_NAME__',
  '__ACCOUNT_PASSWORD__',
  'clientAddr',
  'clientEnabled',
  'hasClient',
  'roundTripTime',
  'timeSinceHeardFromClient',
  'allClients',
  'hasWitness',
  'isWitnessed',
  'otherClients',
  'topSpeed',
  'topSpeedY',
  'interface'
]);

const describeLimitedName = (kind: string, name: string): string =>
  `${kind} ${name} 是引擎受限名(ENTITY_LIMITED_PROPERTYS):引擎按名拒绝,实体加载会失败;请改名`;

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
  `名字 ${name} 是 Python 关键字:引擎装载不失败,但脚本无法用 self.${name} 访问该成员,建议改名`;

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

  // 引擎受限名:validDefPropertyName 名单臂,def 属性注册即拒绝
  if (ENTITY_LIMITED_PROPERTYS.has(propertyNode.name)) {
    findings.push(
      finding(
        'engine-limited-name',
        'error',
        nameSpan(propertyNode),
        lineAtNode(propertyNode),
        describeLimitedName('属性', propertyNode.name),
        propertyNode.name
      )
    );
  }

  const typeNodes = getDirectChildElementsByName(propertyNode, 'Type');
  const typeNode = typeNodes[0];
  const typeText = typeNode?.children.find((child): child is DefTextNode => child.kind === 'text');
  const typeValue = typeText ? typeText.text.trim() : '';

  // 类型缺失或为空:引擎装载直接失败(loadDefPropertys 找不到 Type 报错返回)
  if (!typeNode || !typeValue) {
    findings.push(
      finding(
        'missing-type',
        'error',
        nameSpan(propertyNode),
        lineAtNode(propertyNode),
        `属性 ${propertyNode.name} 缺少有效的 <Type>,实体加载会失败`,
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

  // 重复 <Type>:引擎 enterNode 只取首个,其余被静默忽略(读者视角的歧义)
  if (typeNodes.length > 1) {
    findings.push(
      finding(
        'duplicate-type-tag',
        'warning',
        nameSpan(propertyNode),
        lineAtNode(propertyNode),
        `属性 ${propertyNode.name} 定义了 ${typeNodes.length} 个 <Type>,引擎只装载首个、其余被忽略,请仅保留一个`,
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

const MAX_LISTED_SOURCES = 3;

const readFileOrNull = (filePath: string): string | null => {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
};

const relativeDefLabel = (defsRoot: string, filePath: string): string =>
  path.relative(defsRoot, filePath).split(path.sep).join('/');

const mergeInheritedName = (
  inherited: InheritedNames,
  name: string,
  defsRoot: string,
  filePath: string,
  mark: 'property' | 'component' | 'method',
  domains: Set<string> | null,
  section: string | null
): void => {
  let info = inherited.get(name);
  if (!info) {
    info = {
      propertyDomains: new Set(),
      componentDomains: new Set(),
      methodSections: new Set(),
      propertySources: [],
      componentSources: [],
      methodSources: []
    };
    inherited.set(name, info);
  }
  const label = relativeDefLabel(defsRoot, filePath);
  const sources = mark === 'property' ? info.propertySources : mark === 'component' ? info.componentSources : info.methodSources;
  if (!sources.includes(label) && sources.length < MAX_LISTED_SOURCES) {
    sources.push(label);
  }
  if (mark === 'property' && domains) {
    for (const domain of domains) {
      info.propertyDomains.add(domain);
    }
  }
  if (mark === 'component' && domains) {
    for (const domain of domains) {
      info.componentDomains.add(domain);
    }
  }
  if (mark === 'method' && section) {
    info.methodSections.add(section);
  }
};

/**
 * 收集被分析 def 的祖先闭包声明面(Parent 链 + Interfaces 混入,传递)。
 * 引擎把父类/接口的描述装进同一 ScriptDefModule(entitydef.cpp loadDefInfo:
 * 自身描述 → loadInterfaces → loadComponents → loadParentClass 递归),同名
 * 冲突在装载时按模块全局拒绝——本面即该判重的输入。定义根定位不到(无
 * entities.xml)或闭包不可读时返回空面(退化为仅单文件检查,不虚构祖先)。
 * 环见 seen 即止;接口文件不跟随 Parent(loadInterfaces 不走 loadParentClass),
 * 组件 def 的 Parent 在 components/ 内解析(与 defRenamer.resolveLinkPaths
 * 同口径)。
 */
export function collectInheritedNames(
  entryPath: string,
  readText: (filePath: string) => string | null = readFileOrNull
): InheritedNames {
  const defsRoot = findEntityDefsRootFromFile(entryPath);
  const inherited: InheritedNames = new Map();
  if (!defsRoot) {
    return inherited;
  }

  const categoryOf = (filePath: string): 'entity' | 'component' | 'interface' => {
    const relative = path.relative(defsRoot, filePath).split(path.sep);
    if (relative.includes('interfaces')) {
      return 'interface';
    }
    if (relative.includes('components')) {
      return 'component';
    }
    return 'entity';
  };

  const entryResolved = path.resolve(entryPath);
  const seen = new Set([entryResolved]);
  const queue: string[] = [entryResolved];
  while (queue.length > 0) {
    const filePath = queue.shift() as string;
    const content = readText(filePath);
    if (content === null) {
      continue;
    }
    // 祖先文件不可解析(畸形 XML 抛错/空文档无根)即跳过:闭包面缺失不影响
    // 其余祖先,与 defRenamer.parseDefText 的容错口径一致
    let document: DefDocument;
    try {
      document = parseDefDocument(content);
    } catch {
      continue;
    }
    const root = document.root;
    if (!root) {
      continue;
    }

    // 入口自身只走出边,其声明不进祖先面(同文件判重由既有检查项覆盖)
    if (filePath !== entryResolved) {
      const propertiesSection = getDirectChildElement(root, 'Properties');
      if (propertiesSection) {
        for (const propertyNode of getDirectChildElements(propertiesSection)) {
          mergeInheritedName(inherited, propertyNode.name, defsRoot, filePath, 'property', propertyFlagDomains(propertyNode), null);
        }
      }
      const componentsSection = getDirectChildElement(root, 'Components');
      if (componentsSection) {
        for (const componentNode of getDirectChildElements(componentsSection)) {
          mergeInheritedName(inherited, componentNode.name, defsRoot, filePath, 'component', propertyFlagDomains(componentNode), null);
        }
      }
      for (const sectionName of DEF_METHOD_SECTIONS) {
        const sectionNode = getDirectChildElement(root, sectionName);
        if (!sectionNode) {
          continue;
        }
        const section = sectionName === 'BaseMethods' ? 'base' : sectionName === 'CellMethods' ? 'cell' : 'client';
        for (const methodNode of getDirectChildElements(sectionNode)) {
          mergeInheritedName(inherited, methodNode.name, defsRoot, filePath, 'method', null, section);
        }
      }
    }

    const semantics = parseDefFileSemantics(content);
    /* istanbul ignore start: parseDefFileSemantics 内部对同一文本跑同一解析器
       (parseDefText = try/catch 包裹 parseDefDocument),root 非空时必非空,
       该臂仅防御性保留(v8 覆盖率口径下 start/stop 才生效) */
    if (!semantics) {
      continue;
    }
    /* istanbul ignore stop */
    const category = categoryOf(filePath);
    const edges: string[] = [];
    if (semantics.parentName && category !== 'interface') {
      const parentDir = category === 'component' ? path.join(defsRoot, 'components') : defsRoot;
      edges.push(path.join(parentDir, `${semantics.parentName}.def`));
    }
    for (const name of semantics.interfaceNames) {
      edges.push(path.join(defsRoot, 'interfaces', `${name}.def`));
    }
    for (const edge of edges) {
      const resolved = path.resolve(edge);
      if (!seen.has(resolved)) {
        seen.add(resolved);
        queue.push(resolved);
      }
    }
  }
  return inherited;
}

/**
 * 继承链同名判重(批116,引擎判重语义见 scriptdef_module.cpp):
 * - 自身属性 vs 祖先方法:hasMethodName 全局拒绝,无条件失败;
 * - 自身属性 vs 祖先属性/组件槽:findXxxPropertyDescription 按域查找,域位
 *   相交才拒绝(不同域位同名可共存,不报);
 * - 自身方法 vs 祖先属性/组件:hasPropertyName/hasComponentName 全局拒绝,
 *   无条件失败;
 * - 自身方法 vs 祖先方法:仅同段拒绝(段即命名空间,异段同名可共存);
 * - 自身组件槽 vs 祖先任何同名声明:组件槽经 addComponentProperty 走
 *   addPropertyDescription,hasComponentName 查 componentDescr_ 全局,
 *   无条件失败。
 * 无冲突返回 null(不同域位/异段共存是引擎合法形态)。
 */
// 提示文案的来源注记:命中面由 mergeInheritedName 构造,任一列表非空才进
// 对应分支,来源恒有至少一个 def,无需判空臂
const cite = (sources: string[]): string => `(继承自 ${sources.join('、')})`;

const describePropertyCollision = (
  document: DefDocument,
  node: DefElementNode,
  ownDomains: Set<string>,
  info: InheritedNameInfo
): DefAnalysisFinding | null => {
  if (info.methodSources.length > 0) {
    return finding(
      'inherited-name-collision',
      'error',
      nameSpan(node),
      getLineNumberAt(document, node.tagStart),
      `属性 ${node.name} 与继承链上的方法同名:父子/接口描述装入同一 ScriptDefModule,hasMethodName 全局拒绝,实体加载会失败${cite(info.methodSources)}`,
      node.name
    );
  }
  const overlaps = [...info.propertyDomains, ...info.componentDomains].some(domain => ownDomains.has(domain));
  if (overlaps) {
    return finding(
      'inherited-name-collision',
      'error',
      nameSpan(node),
      getLineNumberAt(document, node.tagStart),
      `属性 ${node.name} 与继承链上的属性/组件槽同域位同名:同一模块 addPropertyDescription 判重拒绝,实体加载会失败${cite([...info.propertySources, ...info.componentSources])}`,
      node.name
    );
  }
  return null;
};

const describeMethodCollision = (
  document: DefDocument,
  node: DefElementNode,
  section: string,
  info: InheritedNameInfo
): DefAnalysisFinding | null => {
  if (info.methodSections.has(section)) {
    return finding(
      'inherited-name-collision',
      'error',
      nameSpan(node),
      getLineNumberAt(document, node.tagStart),
      `方法 ${node.name} 与继承链上的方法同段同名:同一模块同段判重拒绝,实体加载会失败${cite(info.methodSources)}`,
      node.name
    );
  }
  if (info.propertySources.length > 0 || info.componentSources.length > 0) {
    return finding(
      'inherited-name-collision',
      'error',
      nameSpan(node),
      getLineNumberAt(document, node.tagStart),
      `方法 ${node.name} 与继承链上的属性/组件同名:addXxxMethodDescription 的 hasPropertyName/hasComponentName 全局拒绝,实体加载会失败${cite([...info.propertySources, ...info.componentSources])}`,
      node.name
    );
  }
  return null;
};

// 组件槽判重无条件(见上方规则),恒产出 finding,无 null 臂
const describeComponentCollision = (
  document: DefDocument,
  node: DefElementNode,
  info: InheritedNameInfo
): DefAnalysisFinding => {
  const sources = [...info.propertySources, ...info.componentSources, ...info.methodSources];
  return finding(
    'inherited-name-collision',
    'error',
    nameSpan(node),
    getLineNumberAt(document, node.tagStart),
    `组件槽 ${node.name} 与继承链上的声明同名:组件槽经 addComponentProperty 走 addPropertyDescription,同名判重拒绝,实体加载会失败${cite(sources)}`,
    node.name
  );
};

/**
 * 对一份 .def 文本做静态分析,返回优化建议列表(按文档顺序)。
 * inheritedNames 为祖先闭包声明面(collectInheritedNames 产出);缺省时退化为
 * 仅单文件检查(既有行为不变)。
 */
export function analyzeDefDocument(
  text: string,
  inheritedNames: InheritedNames = new Map()
): DefAnalysisFinding[] {
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

      // 继承链同名(批116):祖先闭包面非空且该名字被祖先声明时按引擎判重
      // 规则报——方法同名全局拒绝;属性/组件槽同名按域位相交(不同域位同名
      // 引擎允许共存,不报)
      const info = inheritedNames.get(propertyNode.name);
      if (info) {
        const inheritedFinding = describePropertyCollision(
          document,
          propertyNode,
          propertyFlagDomains(propertyNode),
          info
        );
        if (inheritedFinding) {
          findings.push(inheritedFinding);
        }
      }
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
      // 方法名走同一受限名单(DC_TYPE_METHOD/DC_TYPE_CLIENT_METHOD 的
      // DefContext 构造都过 validDefPropertyName,拒绝抛 AssertionError)
      if (ENTITY_LIMITED_PROPERTYS.has(methodNode.name)) {
        findings.push(
          finding(
            'engine-limited-name',
            'error',
            nameSpan(methodNode),
            getLineNumberAt(document, methodNode.tagStart),
            describeLimitedName('方法', methodNode.name),
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
            `方法 ${methodNode.name} 与属性同名:引擎装载时按名冲突直接拒绝(scriptdef_module),实体加载会失败`,
            methodNode.name
          )
        );
      }
      // 继承链同名(批116):方法与祖先属性/组件同名全局拒绝;与祖先方法同名
      // 仅同段拒绝(段即命名空间,异段同名引擎允许共存)
      const inheritedInfo = inheritedNames.get(methodNode.name);
      if (inheritedInfo) {
        const section = sectionName === 'BaseMethods' ? 'base' : sectionName === 'CellMethods' ? 'cell' : 'client';
        const inheritedFinding = describeMethodCollision(document, methodNode, section, inheritedInfo);
        if (inheritedFinding) {
          findings.push(inheritedFinding);
        }
      }
    }
  }

  // Components 槽名同受受限名约束(loadComponents 对槽名逐个
  // validDefPropertyName,拒绝则整个模块装载失败)
  const componentsSection = getDirectChildElement(root, 'Components');
  if (componentsSection) {
    for (const componentNode of getDirectChildElements(componentsSection)) {
      if (ENTITY_LIMITED_PROPERTYS.has(componentNode.name)) {
        findings.push(
          finding(
            'engine-limited-name',
            'error',
            nameSpan(componentNode),
            getLineNumberAt(document, componentNode.tagStart),
            describeLimitedName('组件', componentNode.name),
            componentNode.name
          )
        );
      }
      // 继承链同名(批116):组件槽经 addComponentProperty 走
      // addPropertyDescription,与继承链上任何同名声明都判重(hasComponentName
      // 查 componentDescr_ 全局,无域位豁免),无条件报
      const inheritedInfo = inheritedNames.get(componentNode.name);
      if (inheritedInfo) {
        findings.push(describeComponentCollision(document, componentNode, inheritedInfo));
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
