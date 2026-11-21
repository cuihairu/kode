/**
 * RUST-398(HR-HASH-011):types.xml 自定义类型变化 → 受影响全部 .def 的
 * reverse-dependency 影响报告。
 *
 * 口径:
 * - 自定义类型声明 = types.xml <root> 的每个子元素(别名、ARRAY、FIXED_DICT
 *   都是命名类型,声明名 = 元素名;kind = `type` 属性或内容首 token)。
 * - 类型结构形状 = 声明元素的规范化结构序列化(与 hotReloadDefStructure 的
 *   structuralNodeFingerprint 同款:去注释/空白、子序排序)。形状变 = 结构性变化。
 * - 类型依赖图:类型 A 引用类型 B ⟺ A 的子树里出现 B 的名字(作为 <Type>/<of>
 *   token),且 B 本身是已声明自定义类型。变化沿依赖图**传递闭包**传播:
 *   类型 B 变 → 依赖 B 的类型 A 的语义也变 → 引用 A 的 .def 受影响。
 * - .def 的自定义类型引用 = 文档内 <Type>/<Arg>/<of> 元素文本首 token,
 *   过滤到已声明自定义类型名集合。内建类型(UINT16/STRING/...)不在声明集,
 *   自然不被计入(引用未注册名 = 未注册,另有诊断面,本模块不冒充)。
 * - 严重性:任何受影响 .def 都标 restartRequired——自定义类型形状变化即
 *   序列化/RPC 形状变化(与 RUST-397 门禁同判据),不作为普通 Python reload
 *   自动发送;types.xml 本身按书 §19.4 不得默认自动应用,本模块只出报告。
 * - 新增类型不使既有 .def 受影响(现有文档无从引用尚不存在的类型),只如实
 *   记入 changedTypes;删除/变化按上述闭包传播。
 *
 * 纯逻辑无 vscode/fs 依赖,单测用例直驱;执行编排归 hotReload 管道调用方。
 */

import { parseDefDocument, type DefElementNode } from './defParser';

export interface CustomTypeDecl {
  name: string;
  /** 规范化结构形状:变=结构性变化(去注释/空白,子序排序) */
  shape: string;
  /** 直接引用的自定义类型名(子树 <Type>/<of> token ∩ 声明集) */
  references: string[];
}

export type CustomTypeChangeKind = 'added' | 'removed' | 'changed';

export interface CustomTypeChange {
  name: string;
  change: CustomTypeChangeKind;
  /** 变化说明(回显/报告同源) */
  reason: string;
}

export interface AffectedDef {
  name: string;
  /** 逐条影响(引用链点名:直接引用 vs 经类型依赖传播) */
  reasons: string[];
}

export interface TypesImpactReport {
  /** types.xml 自定义类型变化逐条(增/删/形状变) */
  readonly changedTypes: CustomTypeChange[];
  /** 受影响 .def 逐文件(经直接或传递闭包依赖) */
  readonly affectedDefs: AffectedDef[];
  readonly totalDefCount: number;
  readonly affectedDefCount: number;
  /** 任何受影响 .def 存在 → 需重启,不自动热更 */
  readonly anyAffected: boolean;
}

/** 元素内全部文本拼接去空白(取 <Type> 文本首 token 用) */
const descendantTextTrimmed = (element: DefElementNode): string => {
  let text = '';
  for (const child of element.children) {
    if (child.kind === 'text') {
      text += child.text.trim();
    } else {
      text += descendantTextTrimmed(child);
    }
  }
  return text;
};

/**
 * 规范化结构序列化(与 hotReloadDefStructure.structuralNodeFingerprint 同款
 * 纪律):递归元素名+文本,去注释/空白,子序排序——注释/空白/重排不产生差异,
 * 结构或文本变则差异。
 */
const structuralShape = (element: DefElementNode): string => {
  const parts: string[] = [];
  // 属性入形:`<JSONDATA type="UINT32"/>` 的 kind 就在 type 属性里,忽略属性
  // 会把 UINT32→INT32 判成未变(序列化形状已变)。
  for (const [key, value] of Object.entries(element.attributes)) {
    parts.push(`${key}=${value}`);
  }
  for (const child of element.children) {
    if (child.kind === 'text') {
      const text = child.text.trim();
      if (text) {
        parts.push(text);
      }
    } else {
      parts.push(`${child.name}{${structuralShape(child)}}`);
    }
  }
  return parts.sort().join('|');
};

const childElements = (element: DefElementNode): DefElementNode[] =>
  element.children.filter((child): child is DefElementNode => child.kind === 'element');

const firstToken = (value: string): string => value.trim().split(/\s+/)[0];

/** 子树内所有 <Type>/<of>/<Arg> 文本 token(自定义类型候选,调用方过滤) */
const collectTypeTokens = (element: DefElementNode, into: Set<string>): void => {
  if (element.name === 'Type' || element.name === 'of' || element.name === 'Arg') {
    const token = firstToken(descendantTextTrimmed(element));
    if (token) {
      into.add(token);
    }
  }
  for (const child of childElements(element)) {
    collectTypeTokens(child, into);
  }
};

/**
 * 解析 types.xml → 自定义类型声明表(名 → 声明)。解析不出根 = 空表
 * (如实,不造声明);重复名首见保留(BTreeMap entry/or_insert 同口径)。
 */
export function parseCustomTypes(typesXml: string): Map<string, CustomTypeDecl> {
  const document = parseDefDocument(typesXml);
  const root = document.root;
  const table = new Map<string, CustomTypeDecl>();
  if (!root) {
    return table;
  }
  // 首遍:声明集(重复名首见保留,并记住声明元素供第二遍取 token)
  const declaredElements = new Map<string, DefElementNode>();
  for (const child of childElements(root)) {
    if (!declaredElements.has(child.name)) {
      declaredElements.set(child.name, child);
      table.set(child.name, {
        name: child.name,
        shape: structuralShape(child),
        references: []
      });
    }
  }
  // 二遍:依赖引用 = 子树 token ∩ 声明集(声明集此时已完整)
  const declaredNames = new Set(declaredElements.keys());
  for (const [name, element] of declaredElements) {
    const tokens = new Set<string>();
    collectTypeTokens(element, tokens);
    table.get(name)!.references = [...tokens].filter(token => declaredNames.has(token));
  }
  return table;
}

/**
 * .def 文档引用的自定义类型名(直接引用):<Type>/<Arg>/<of> 文本 token ∩
 * 声明集。解析不出 = 空集(解析失败另有诊断面,本面不冒充)。
 */
export function collectDefCustomTypeRefs(
  defText: string,
  declaredNames: ReadonlySet<string>
): Set<string> {
  const document = parseDefDocument(defText);
  const root = document.root;
  const refs = new Set<string>();
  if (!root) {
    return refs;
  }
  const tokens = new Set<string>();
  collectTypeTokens(root, tokens);
  for (const token of tokens) {
    if (declaredNames.has(token)) {
      refs.add(token);
    }
  }
  return refs;
}

/**
 * 类型依赖图传递闭包:from → 直接引用的自定义类型名集合。
 * reachable = 自身 ∪ 直接引用 ∪ 其引用(迭代至不动点)。
 */
function reachableTypes(from: string, decls: ReadonlyMap<string, CustomTypeDecl>): Set<string> {
  const reached = new Set<string>([from]);
  const queue = [from];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    const decl = decls.get(current);
    if (!decl) {
      continue;
    }
    for (const reference of decl.references) {
      if (!reached.has(reference)) {
        reached.add(reference);
        queue.push(reference);
      }
    }
  }
  return reached;
}

export interface TypesImpactInput {
  /** types.xml 变更前原文 */
  readonly beforeTypesXml: string;
  /** types.xml 变更后原文 */
  readonly afterTypesXml: string;
  /** 工作区内全部 .def(名 + 原文;名仅用于报告点名) */
  readonly defs: ReadonlyArray<{ name: string; text: string }>;
}

/**
 * types.xml 自定义类型变化 → 受影响 .def 影响报告(HR-HASH-011)。
 * 变化集 = 增/删/形状变;受影响 = 直接引用或经类型依赖闭包触及变化集的 .def。
 */
export function analyzeTypesImpact(input: TypesImpactInput): TypesImpactReport {
  const before = parseCustomTypes(input.beforeTypesXml);
  const after = parseCustomTypes(input.afterTypesXml);
  const names = new Set<string>([...before.keys(), ...after.keys()]);

  const changedTypes: CustomTypeChange[] = [];
  for (const name of [...names].sort()) {
    const beforeDecl = before.get(name);
    const afterDecl = after.get(name);
    if (!beforeDecl) {
      changedTypes.push({ name, change: 'added', reason: `类型新增: ${name}(声明集新增)` });
    } else if (!afterDecl) {
      changedTypes.push({ name, change: 'removed', reason: `类型删除: ${name}(引用它的 .def 将无法解析)` });
    } else if (beforeDecl.shape !== afterDecl.shape) {
      changedTypes.push({
        name,
        change: 'changed',
        reason: `类型结构变化: ${name}(序列化形状 ${beforeDecl.shape} → ${afterDecl.shape})`
      });
    }
  }

  // 受影响自定义类型名集:删除/形状变(新增不使既有 .def 受影响)
  const impactful = new Set(
    changedTypes.filter(change => change.change !== 'added').map(change => change.name)
  );

  // .def 的自定义类型引用按 before∪after 声明集过滤:删除前的类型仍是自定义
  // 类型(被删后 def 文本未变,仍引用它),不能用 after 集把删除引用漏掉。
  const unionNames = new Set<string>([...before.keys(), ...after.keys()]);

  // 逐 .def:引用集 ∩ 变化闭包;闭包 = 该 def 引用的每个类型可达的(含自身)变化类型
  const affectedDefs: AffectedDef[] = [];
  for (const def of input.defs) {
    const refs = collectDefCustomTypeRefs(def.text, unionNames);
    if (refs.size === 0) {
      continue;
    }
    const reasons: string[] = [];
    for (const reference of refs) {
      const reached = reachableTypes(reference, after);
      for (const hit of [...impactful].sort()) {
        if (hit === reference) {
          reasons.push(`直接引用受影响类型: ${reference}`);
        } else if (reached.has(hit)) {
          reasons.push(`经类型依赖传播受影响: ${reference} 依赖 ${hit}`);
        }
      }
    }
    if (reasons.length > 0) {
      affectedDefs.push({ name: def.name, reasons: [...new Set(reasons)] });
    }
  }

  return {
    changedTypes,
    affectedDefs,
    totalDefCount: input.defs.length,
    affectedDefCount: affectedDefs.length,
    anyAffected: affectedDefs.length > 0
  };
}

/** 影响报告回显行(详情面直显) */
export function formatTypesImpactReport(report: TypesImpactReport): string {
  if (report.changedTypes.length === 0) {
    return 'types.xml 无自定义类型结构变化,无影响';
  }
  const typeLine = report.changedTypes.map(change => change.reason).join(';');
  if (!report.anyAffected) {
    return `types.xml 变化: ${typeLine};无 .def 受影响`;
  }
  const defLines = report.affectedDefs
    .map(def => `${def.name}: ${def.reasons.join(';')}`)
    .join('|');
  return `types.xml 变化: ${typeLine};受影响 ${report.affectedDefCount}/${report.totalDefCount} 个 .def — ${defLines}(需重启,不作为普通 Python reload 自动发送)`;
}
