import type { CustomTypeInfo } from '../definitionWorkspace';
import { KBENGINE_TYPES } from './kbengineMetadata';
import {
  getDirectChildElement,
  getDirectChildElements,
  getScalarChildValue,
  parseDefDocument,
  type DefElementNode
} from './defParser';

/**
 * .def 属性持久化×ENTITYCALL 静默降级检查(RUST-177/KBE-007 诊断面,纯核
 * 零 vscode):属性显式声明 `<Persistent>true</Persistent>` 且类型(含
 * types.xml 别名链末端)解析到 ENTITYCALL 时,引擎在 PropertyDescription
 * 构造里**无日志静默把 isPersistent 改回 false**——用户以为字段会持久化,
 * 实际不会;这是「不可序列化字段」子项的引擎真源落点。
 *
 * 引擎真源锚(kbengine kbe/src 本地树逐条取证):
 * - 持久化声明读型:loadDefPropertys 里 `bool isPersistent = false` 缺省
 *   关,`<Persistent>` 文本经 tolower 后 == 'true' 才开(entitydef.cpp
 *   :1181-1187)——本检查同口径(tolower+恒等)。
 * - 静默降级:PropertyDescription 构造 `if(isPersistent &&
 *   strcmp(dataType_->getName(), "ENTITYCALL") == 0) { isPersistent_ =
 *   false; }`,无任何日志(property.cpp:48-51)。判定对象是属性自身
 *   dataType_ 的 getName():
 *   · 直书 ENTITYCALL → 命中;
 *   · types.xml 别名链末端是 ENTITYCALL → 命中(别名复用同一 DataType*
 *     实例,getName() 仍是 "ENTITYCALL";datatypes.cpp:180 addDataType
 *     同指针注册 + :194 aliasName 改写);
 *   · 内联 ARRAY 属性 → dataType_ 是数组类型,getName() 是 "ARRAY" 形态,
 *     **不命中**——数组元素是 ENTITYCALL 不触发引擎判定,本检查同口径,
 *     不扩大。
 * - 别名链消费面与 scalarAssignCheck.resolveEngineScalarTypeName 同款
 *   (CustomTypeInfo.aliasType 逐层下钻,visited 有界;名字精确匹配,与
 *   引擎 dataTypes_ 查表同口径大小写敏感)。
 * - types.xml 侧的同一引擎真源(FD 字段缺省 true + ENTITYCALL 静默降级)
 *   在 typesXmlStructureCheck(fdEntityCallPersistent 码)按 types.xml 读型
 *   落地;数据库 schema 面已按同一真源建模列剪枝(databaseSchemaCore),
 *   本检查是诊断面,三者互补不重复。
 *
 * 诚实边界:`<Persistent>` 缺省即 false、写成 false/1/yes 等引擎不认的值
 * 一律不开持久化(无落差,不报);别名链有环或断链按不可解处理(环链引擎
 * 本就装载中止,归 typesXmlStructureCheck 前向引用码);`<Persistent>` 值
 * 非恒等 'true'(tolower 后)的一律不报——引擎就是不开。
 */

export const PERSISTENT_ENTITY_CALL_DIAGNOSTIC_CODE = 'kbengine.persistentEntityCall';

export interface PersistentEntityCallFinding {
  /** 0 基字符偏移(锚 <Persistent> 元素——那是用户「以为会持久化」的声明位) */
  offset: number;
  length: number;
  propertyName: string;
  /** 类型在 .def 里的原样文本(未展开别名) */
  declaredType: string;
  message: string;
}

/** 引擎内建类型名注册表(datatypes.cpp DataTypes::initialize 同源) */
const BUILTIN_TYPE_NAMES: ReadonlySet<string> = new Set(KBENGINE_TYPES.map(item => item.name));

/** 别名链末端解析(CustomTypeInfo.aliasType 下钻,visited 有界;引擎 dataTypes_ 查表大小写敏感) */
function resolveAliasChainEnd(name: string, customTypes: readonly CustomTypeInfo[]): string | null {
  let current = name.trim();
  const visited = new Set<string>();
  while (current.length > 0 && !visited.has(current)) {
    visited.add(current);
    if (BUILTIN_TYPE_NAMES.has(current)) {
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

/**
 * 全量计算:`<Persistent>true</Persistent>` × 类型解析到 ENTITYCALL 的
 * 属性发现。纯函数(def 文本 + types.xml 注册表快照,快照与 scalarAssign
 * 等消费面同一来源)。
 */
export function computePersistentEntityCallFindings(
  defText: string,
  customTypes: readonly CustomTypeInfo[]
): PersistentEntityCallFinding[] {
  // 解析器对畸形 XML 会抛(assignNodePositions 定位失败);本文面只在可解析
  // 文档上声称,解析失败 = 零发现(结构面归各自解析诊断,不在此重复)
  let document;
  try {
    document = parseDefDocument(defText);
  } catch {
    return [];
  }
  const root = document.root;
  if (!root) { return []; }
  const propertiesSection = getDirectChildElement(root, 'Properties');
  if (!propertiesSection) { return []; }
  const findings: PersistentEntityCallFinding[] = [];
  for (const propertyNode of getDirectChildElements(propertiesSection)) {
    // 引擎口径:tolower 后恒等 'true' 才开持久化(entitydef.cpp:1181-1187)
    const persistentRaw = (getScalarChildValue(propertyNode, 'Persistent') ?? '').trim();
    if (persistentRaw.toLowerCase() !== 'true') { continue; }
    // 类型指引 = getValStr 全文折叠(引擎不拆 token,整串查表;内联 ARRAY
    // 形态 getElementText 直取文本即 "ARRAY"——见头注:数组属性不触发引擎判定)
    const declaredType = (getScalarChildValue(propertyNode, 'Type') ?? '').replace(/\s+/g, ' ').trim();
    if (declaredType.length === 0) { continue; } // 类型缺失/空归 unknown-type lint,不在此声称
    if (resolveAliasChainEnd(declaredType, customTypes) !== 'ENTITYCALL') { continue; }
    const persistentNode = getDirectChildElement(propertyNode, 'Persistent');
    const span = persistentSpan(propertyNode, persistentNode);
    findings.push({
      offset: span.offset,
      length: span.length,
      propertyName: propertyNode.name,
      declaredType,
      message: `属性「${propertyNode.name}」声明 <Persistent>true</Persistent> 但类型「${declaredType}」解析到 ENTITYCALL：引擎在 PropertyDescription 构造里无日志静默把 isPersistent 改回 false——以为在持久化其实不会持久化（property.cpp:48-51）`
    });
  }
  return findings;
}

/** 锚 <Persistent> 元素区间(缺失时回落属性开标签,防御位;正常路径不触达) */
function persistentSpan(propertyNode: DefElementNode, persistentNode: DefElementNode | null | undefined): { offset: number; length: number } {
  if (persistentNode) {
    return { offset: persistentNode.tagStart, length: Math.max(1, persistentNode.closeTagEnd - persistentNode.tagStart) };
  }
  return { offset: propertyNode.tagStart, length: Math.max(1, propertyNode.closeTagEnd - propertyNode.tagStart) };
}
