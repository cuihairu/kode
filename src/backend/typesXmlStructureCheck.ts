import {
  FIXED_DICT_TYPE_NAME,
  KBENGINE_TYPES
} from './kbengineMetadata';
import {
  getDirectChildElements,
  parseDefDocument,
  type DefElementNode,
  type DefTextNode
} from './defParser';

/**
 * types.xml 结构完整性检查(RUST-177/KBE-007 诊断面,纯核零 vscode):
 * 别名前向引用/循环、`_` 保留前缀、别名重定义、ARRAY `<of>` 链缺失/目标
 * 未知、FIXED_DICT 结构(缺 Properties/无字段/字段缺 Type/字段类型未知)
 * 与 FD 字段 ENTITYCALL 静默降持久化——全部按引擎装载真源逐条取证。
 *
 * 引擎真源锚(kbengine kbe/src 本地树逐条取证,2026-11-17 复核):
 * - 装载入口 DataTypes::loadTypes(datatypes.cpp:105-187)**单遍序敏**:按文档
 *   序逐条处理,条目指引 = FirstChild 的 getValStr(xml.cpp:121-128 只认
 *   **文本节点**;tinyxml2 折叠纯空白文本,故指引=首个非空白子节点——纯空白
 *   文本节点引擎侧不存在)。
 *   · 指引文本 == "FIXED_DICT"(精确大小写)→ FixedDictType 分支
 *     (datatypes.cpp:135-151);
 *   · 指引文本 == "ARRAY" → FixedArrayType 分支(:152-168);
 *   · 其余文本 → getDataType(指引) 解析(:169-181);
 *   · FirstChild 是**元素** → getValStr 得空串 → getDataType("") 查不到
 *     → ERROR「can't fount type」+ return false → 启动中止(:169-178);
 *   · 条目无(非空白)子节点 → 引擎整条**静默跳过**(不注册无日志,
 *     loadTypes :132 的 if(childNode != NULL) 无 else 臂)。
 * - 名字口径:别名名查表解析是**大小写敏感精确匹配**(getDataType 用
 *   dataTypes_ 精确表,datatypes.cpp:221-236);重定义查重才用大小写不敏感
 *   的 dataTypesLowerName_(addDataType datatypes.cpp:190-218:命中 → ERROR
 *   「name {} exist.」+ return false——但 loadTypes 三个调用点
 *   (:141/:158/:180)全部丢弃返回值,装载继续,**先注册者胜**(dataTypes_
 *   不被覆写)。重定义是「引擎打日志但非致命」级别 → 本检查报 Warning。
 * - `_` 保留前缀:validTypeName(datatypes.cpp:43-50)只禁首字符 `_`,
 *   loadTypes 在读指引**之前**先查(:124-130)→ ERROR + return false → 中止。
 * - 解析失败/结构失败都是 ERROR + return false → **启动中止**(loadTypes
 *   各分支 :145-150/:162-167/:171-177)。引擎没有循环检测:别名循环/自引用/
 *   前向引用在单遍里必然落在某条的「此刻未知」上,走同一中止路径。因此本
 *   检查按**文档序**判定目标可解性,目标名在后文才出现时,消息注明
 *   「前向引用/循环」。
 * - ARRAY(datatype.cpp FixedArrayType::initialize :1658-1719):引擎把指引
 *   文本节点传进来,`enterNode(指引节点,"of")` 沿**兄弟链**扫(xml.cpp
 *   enterNode :72-93 扫本节点与后续兄弟,命中后返回其首个子节点)——`<of>`
 *   与指引文本同级。`<of>` 缺失 → ERROR「not found of」+ false → 中止
 *   (:1662-1667);`<of>` 指引 == "ARRAY" → 嵌套:**下一个兄弟 `<of>`**
 *   (继续沿兄弟链,不是子节点嵌套,:1671-1690);指引 == "FIXED_DICT" 或
 *   解析不到 → ERROR「did not find type」+ false → 中止(:1694-1706);
 *   嵌套深度受 XML 同级子节点数约束,环只在别名层存在。
 * - FIXED_DICT(datatype.cpp FixedDictType::initialize :2048-2196):缺
 *   `<Properties>` → ERROR + false → 中止(:2050-2055);字段缺 `<Type>` →
 *   ERROR「no label["Type"] ... will be ignored」**但继续装载、该字段被
 *   静默丢弃,非致命**(:2161-2165);字段类型未知 → ERROR「did not find
 *   type」+ false → 中止(:2151-2158);FD 字段类型只能是内建名/已注册别名
 *   /ARRAY(FIXED_DICT 是关键字不是注册名,作字段类型同样落「did not find
 *   type」中止);全部字段都被丢弃(或 Properties 下无字段)→ keyTypes_ 空
 *   → ERROR「no keys」+ false → 中止(:2187-2193)。任一致命 → loadTypes
 *   ERROR「parse FIXED_DICT error」→ 中止(:145-150;ARRAY 同形 :162-167)。
 * - FD 字段持久化读型:`<Persistent>` 文本 == 'false' **大小写敏感**才关断
 *   (:2068-2075,缺省即 true——与 .def 属性面 tolower+'true' 口径不同,
 *   见 persistentEntityCallCheck 头注)。
 * - FD 字段 ENTITYCALL 静默降持久化:字段类型(ARRAY 字段按元素末端类型)
 *   解析为 ENTITYCALL 时**无日志静默 persistent=false**——ARRAY 字段臂
 *   (:2104-2107)、纯类型臂(:2141-2144)。用户以为字段在持久化,引擎静默
 *   丢弃持久化;显式写 `<Persistent>false` 时无落差,不报。
 * - 诚实边界(检查面 vs 引擎行为的已知差异,不谎称同构):
 *   · 引擎首个致命错即 return false 中止,后文条目根本不装载;本检查继续
 *     扫描以一次给全发现,但**失败条目一律不入已注册表**(注册账与引擎
 *     一致:致命条目 addDataType 未达,后文条目按「先于本条才可解」口径
 *     依旧能如实检出前向引用)。
 *   · 条目属性(`type="X"` 等)引擎从不读取;本仓解析器(compositionRoots
 *     parseTypesXml)按 PR-012 门 §1.3-① 收编属性式回落并注册进 def 侧
 *     类型表——那是解析面口径;本检查按引擎真源**不认属性式**(无子节点的
 *     条目引擎静默跳过),两边落差属已知边界。
 *   · implementedBy 装载失败面(loadImplModule,cellapp/baseapp/client 组件
 *     :2174-2181)归既有 implementedBy 车道,不在此重复。
 *   · 值域/别名链深语义归 scalarAssign/cellData 各自车道。
 */

/** 引擎内建类型名注册表(DataTypes::initialize :58-98 同源,kbengineMetadata 校准表派生;精确大小写) */
const BUILTIN_TYPE_NAMES: ReadonlySet<string> = new Set(KBENGINE_TYPES.map(item => item.name));

export type TypesXmlStructureCode =
  | 'kbengine.types.reservedPrefix'
  | 'kbengine.types.forwardRef'
  | 'kbengine.types.duplicateAlias'
  | 'kbengine.types.arrayOf'
  | 'kbengine.types.fixedDictStructure'
  | 'kbengine.types.fieldType'
  | 'kbengine.types.fieldNoType'
  | 'kbengine.types.fdEntityCallPersistent';

export interface TypesXmlStructureFinding {
  code: TypesXmlStructureCode;
  severity: 'error' | 'warning';
  /** 0 基字符偏移(与 defParser 坐标系一致,装配面经 document.positionAt 转区间) */
  offset: number;
  length: number;
  message: string;
}

/** 已注册别名快照(引擎单遍装载的注册表;target=该别名指引文本的折叠形态) */
interface KnownAlias {
  name: string;
  target: string;
}

/** 装载注册账对(engine 双表):known 键=精确名(getDataType dataTypes_ 口径)、knownLower=小写名集(addDataType dataTypesLowerName_ 查重口径) */
type KnownTables = {
  known: Map<string, KnownAlias>;
  knownLower: Set<string>;
};

/** 全文档名字语境(只读,与装载账无关):供「前向引用/大小写变体」提示分流 */
type NameContext = {
  /** 全文档条目名(空白折叠后原样大小写) */
  allExact: ReadonlySet<string>;
  /** 全文档条目名小写集 */
  allLower: ReadonlySet<string>;
};

/**
 * 目标此刻不可解的分流消息(大小写变体/前向引用/纯未知)。引擎报错与中止
 * 行为三种情形完全一致(getDataType 查不到 → ERROR + return false),只有
 * 修复指引不同——大小写笔误指名对照,前向引用指移动声明序,其余如实说
 * 「此刻不可解」。
 */
function unresolvableTargetMessage(
  subject: string,
  directive: string,
  shown: string,
  names: NameContext,
  tables: KnownTables,
  engineNote: string
): string {
  const variant = [...names.allExact].find(
    candidate => candidate.toLowerCase() === directive.toLowerCase() && candidate !== directive
  );
  if (variant) {
    return `${subject}「${shown}」与本文档已知名「${variant}」仅大小写不同：引擎 getDataType 按精确名字查表（dataTypes_，datatypes.cpp:221-236），大小写不一致不命中——${engineNote}`;
  }
  const forward = names.allLower.has(directive.toLowerCase())
    && !tables.known.has(directive)
    && !BUILTIN_TYPE_NAMES.has(directive);
  if (forward) {
    return `${subject}「${shown}」在本文档后文才声明（前向引用/循环）：引擎单遍装载此刻未知，${engineNote}——把「${directive}」的定义移到本条目之前`;
  }
  return `${subject}「${shown}」此刻不可解（引擎按精确名字查表，只认内建类型与先于本条声明的别名）：${engineNote}`;
}

/** 指引文本折叠(tinyxml2 折叠纯空白 + kbe_trim:内部空白串收成单空格) */
function collapseDirectiveText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * 引擎 FirstChild 等价读型:首个「非纯空白文本或元素」子节点(defParser
 * 不产生注释子节点,与 tinyxml2 折叠空白/跳过注释的可见序一致)。
 */
function firstNonWhitespaceChild(node: DefElementNode): DefTextNode | DefElementNode | undefined {
  return node.children.find(child =>
    child.kind === 'element' || (child.kind === 'text' && child.text.trim().length > 0)
  );
}

/** 条目/`<of>`/`<Type>` 指引读型:文本 → 折叠文本;元素 → 空串(引擎 getValStr 得 "");无 → null(引擎整条跳过) */
function directiveText(node: DefElementNode): string | null {
  const first = firstNonWhitespaceChild(node);
  if (!first) {
    return null;
  }
  if (first.kind === 'text') {
    return collapseDirectiveText(first.text);
  }
  return '';
}

/** 元素名在开标签内的跨度(`<Name` 的 Name 段) */
function elementNameSpan(node: DefElementNode): { offset: number; length: number } {
  return { offset: node.tagStart + 1, length: node.name.length };
}

/** 首个非空白直接文本的跨度(无则回落整个元素区间) */
function firstTextSpan(node: DefElementNode): { offset: number; length: number } {
  const first = firstNonWhitespaceChild(node);
  if (first && first.kind === 'text') {
    return { offset: first.startOffset, length: Math.max(1, first.endOffset - first.startOffset) };
  }
  return { offset: node.tagStart, length: Math.max(1, node.closeTagEnd - node.tagStart) };
}

/** 名字此刻可解性:内建名或已注册别名——**大小写敏感精确匹配**(引擎 getDataType dataTypes_ 精确表口径) */
function isResolvableName(name: string, tables: KnownTables): boolean {
  return BUILTIN_TYPE_NAMES.has(name) || tables.known.has(name);
}

/** 名字沿别名链末端解析(精确大小写;visited 有界防环,环链引擎本就装载中止) */
function resolveAliasChainEnd(name: string, tables: KnownTables): string | null {
  let current = name;
  const visited = new Set<string>();
  while (current.length > 0 && !visited.has(current)) {
    visited.add(current);
    if (BUILTIN_TYPE_NAMES.has(current)) {
      return current;
    }
    const alias = tables.known.get(current);
    if (!alias) {
      return null;
    }
    current = alias.target;
  }
  return null;
}

/**
 * ARRAY `<of>` 兄弟链规约(engine enterNode 口径:`<of>` 与指引文本同级;
 * 嵌套 ARRAY = 同级**下一个** `<of>` 兄弟,不是子节点)。返回末端元素类型名
 * (不可解返回 null),FD 字段调用方据此判 ENTITYCALL 静默降持久化;
 * 顶层 ARRAY 别名无持久化语义,忽略返回值。发现码统一 kbengine.types.arrayOf。
 */
function resolveArrayOfChain(
  container: DefElementNode,
  ownerLabel: string,
  tables: KnownTables,
  findings: TypesXmlStructureFinding[],
  names: NameContext
): string | null {
  const ofElements = getDirectChildElements(container).filter(node => node.name === 'of');
  for (let index = 0; index < ofElements.length; index += 1) {
    const ofElement = ofElements[index];
    const ofSpan = firstTextSpan(ofElement);
    const directive = directiveText(ofElement);
    if (directive === null) {
      // <of> 无(非空白)子节点 → getValStr 得空串 → getDataType("") 查不到
      findings.push({
        code: 'kbengine.types.arrayOf',
        severity: 'error',
        offset: ofSpan.offset,
        length: ofSpan.length,
        message: `${ownerLabel} 的 <of> 没有元素类型指引：引擎 getValStr 读得空类型后 getDataType 查不到即报「did not find type」并中止启动（datatype.cpp:1694-1706）`
      });
      return null;
    }
    if (directive === 'ARRAY') {
      if (index + 1 >= ofElements.length) {
        findings.push({
          code: 'kbengine.types.arrayOf',
          severity: 'error',
          offset: ofSpan.offset,
          length: ofSpan.length,
          message: `${ownerLabel} 的 <of> 指引是 ARRAY（嵌套数组）但同层级没有下一个 <of> 兄弟节点：引擎沿兄弟链找下一个 <of>（不是子节点嵌套），找不到即报 not found "of" 并中止启动（datatype.cpp:1662-1667）`
        });
        return null;
      }
      continue; // 嵌套层交给下一个兄弟 <of> 迭代
    }
    if (directive === FIXED_DICT_TYPE_NAME) {
      findings.push({
        code: 'kbengine.types.arrayOf',
        severity: 'error',
        offset: ofSpan.offset,
        length: ofSpan.length,
        message: `${ownerLabel} 的 <of> 目标是 FIXED_DICT：这是声明关键字不是已注册类型名，引擎 getDataType 查不到即报「did not find type」并中止启动（datatype.cpp:1694-1706）`
      });
      return null;
    }
    if (directive.length === 0 || !isResolvableName(directive, tables)) {
      const shown = directive.length > 0 ? directive : '<空>';
      findings.push({
        code: 'kbengine.types.arrayOf',
        severity: 'error',
        offset: ofSpan.offset,
        length: ofSpan.length,
        message: unresolvableTargetMessage(
          `${ownerLabel} 的 <of> 目标`,
          directive,
          shown,
          names,
          tables,
          'getDataType 查不到即报「did not find type」并中止启动（datatype.cpp:1694-1706）'
        )
      });
      return null;
    }
    return resolveAliasChainEnd(directive, tables);
  }
  findings.push({
    code: 'kbengine.types.arrayOf',
    severity: 'error',
    offset: elementNameSpan(container).offset,
    length: elementNameSpan(container).length,
    message: `${ownerLabel} 的 ARRAY 缺少 <of> 子节点：引擎 FixedArrayType::initialize 报 not found "of" 即出错并中止启动（datatype.cpp:1662-1667）`
  });
  return null;
}

/**
 * FIXED_DICT 字段遍历(引擎 FixedDictType::initialize :2048-2196 口径)。
 * 返回 false = FD 致命(initialize 失败,引擎中止装载、本条不注册);
 * 字段缺 Type 是非致命 Warning(字段被静默丢弃),字段解析齐备时检查
 * ENTITYCALL 静默降持久化(Warning)。
 */
function checkFixedDictFields(
  aliasNode: DefElementNode,
  ownerLabel: string,
  tables: KnownTables,
  findings: TypesXmlStructureFinding[],
  names: NameContext
): boolean {
  const propertiesNode = getDirectChildElements(aliasNode).find(node => node.name === 'Properties');
  if (!propertiesNode) {
    const span = elementNameSpan(aliasNode);
    findings.push({
      code: 'kbengine.types.fixedDictStructure',
      severity: 'error',
      offset: span.offset,
      length: span.length,
      message: `${ownerLabel} 缺少 <Properties> 子节点：引擎 FixedDictType::initialize 报 not found "Properties" 并中止启动（datatype.cpp:2050-2055）`
    });
    return false;
  }
  const fields = getDirectChildElements(propertiesNode);
  let resolvedFieldCount = 0;
  let fatal = false;
  for (const field of fields) {
    const fieldLabel = `FD 字段「${field.name}」`;
    const typeElement = getDirectChildElements(field).find(node => node.name === 'Type');
    if (!typeElement) {
      const span = elementNameSpan(field);
      findings.push({
        code: 'kbengine.types.fieldNoType',
        severity: 'warning',
        offset: span.offset,
        length: span.length,
        message: `${ownerLabel} 的${fieldLabel}缺少 <Type> 子节点：引擎报 no label["Type"] 后继续装载、该字段被静默丢弃——字段实际不存在（datatype.cpp:2161-2165）`
      });
      continue;
    }
    const typeSpan = firstTextSpan(typeElement);
    const directive = directiveText(typeElement);
    if (directive === null) {
      // <Type> 无(非空白)子节点 → getValStr 得空串 → getDataType("") 查不到 → 中止
      findings.push({
        code: 'kbengine.types.fieldType',
        severity: 'error',
        offset: typeSpan.offset,
        length: typeSpan.length,
        message: `${ownerLabel} 的${fieldLabel}的 <Type> 没有类型指引：引擎 getValStr 读得空类型后 getDataType 查不到即报「did not find type」并中止启动（datatype.cpp:2151-2158）`
      });
      fatal = true;
      continue;
    }
    // FD 字段 <Persistent> 缺省 true,显式关断是**大小写敏感**的 'false'
    // (datatype.cpp:2068-2075;元素形态指引 getValStr 得空串 → 视为未关断,引擎口径)
    const persistentElement = getDirectChildElements(field).find(node => node.name === 'Persistent');
    const persistentDirective = persistentElement ? directiveText(persistentElement) : null;
    const persistentOff = persistentDirective === 'false';
    if (directive === 'ARRAY') {
      const elementType = resolveArrayOfChain(typeElement, `${ownerLabel} 的${fieldLabel}`, tables, findings, names);
      if (elementType === null) {
        fatal = true; // ARRAY 字段装载失败 → FD initialize false → 中止
        continue;
      }
      resolvedFieldCount += 1;
      if (elementType === 'ENTITYCALL' && !persistentOff) {
        findings.push({
          code: 'kbengine.types.fdEntityCallPersistent',
          severity: 'warning',
          offset: typeSpan.offset,
          length: typeSpan.length,
          message: `${ownerLabel} 的${fieldLabel}的 ARRAY 元素类型解析到 ENTITYCALL：引擎对该字段无日志静默置 persistent=false——以为在持久化其实不会持久化（datatype.cpp:2104-2107）`
        });
      }
      continue;
    }
    if (directive === FIXED_DICT_TYPE_NAME) {
      findings.push({
        code: 'kbengine.types.fieldType',
        severity: 'error',
        offset: typeSpan.offset,
        length: typeSpan.length,
        message: `${ownerLabel} 的${fieldLabel}的类型是 FIXED_DICT：这是声明关键字不是已注册类型名（FD 字段类型只能内建名/已注册别名/ARRAY），引擎 getDataType 查不到即报「did not find type」并中止启动（datatype.cpp:2151-2158）`
      });
      fatal = true;
      continue;
    }
    if (directive.length === 0 || !isResolvableName(directive, tables)) {
      const shown = directive.length > 0 ? directive : '<空>';
      findings.push({
        code: 'kbengine.types.fieldType',
        severity: 'error',
        offset: typeSpan.offset,
        length: typeSpan.length,
        message: unresolvableTargetMessage(
          `${ownerLabel} 的${fieldLabel}的类型`,
          directive,
          shown,
          names,
          tables,
          'getDataType 查不到即报「did not find type」并中止启动（datatype.cpp:2151-2158）'
        )
      });
      fatal = true;
      continue;
    }
    resolvedFieldCount += 1;
    if (resolveAliasChainEnd(directive, tables) === 'ENTITYCALL' && !persistentOff) {
      findings.push({
        code: 'kbengine.types.fdEntityCallPersistent',
        severity: 'warning',
        offset: typeSpan.offset,
        length: typeSpan.length,
        message: `${ownerLabel} 的${fieldLabel}的类型解析到 ENTITYCALL：引擎对该字段无日志静默置 persistent=false——以为在持久化其实不会持久化（datatype.cpp:2141-2144）`
      });
    }
  }
  // 任一字段致命 → FD initialize false → 中止;字段全部被丢弃/无字段 →
  // keyTypes_ 空 →「no keys」中止(datatype.cpp:2187-2193)
  if (fatal) {
    return false;
  }
  if (resolvedFieldCount === 0) {
    const span = elementNameSpan(aliasNode);
    findings.push({
      code: 'kbengine.types.fixedDictStructure',
      severity: 'error',
      offset: span.offset,
      length: span.length,
      message: `${ownerLabel} 没有可装载的字段（全部字段缺 <Type> 被丢弃，或 <Properties> 下没有字段）：引擎 keyTypes_ 为空即报 FIXED_DICT no keys 并中止启动（datatype.cpp:2187-2193）`
    });
    return false;
  }
  return true;
}

/**
 * 全量计算:types.xml 结构完整性发现。纯函数(文本进,发现出)。
 * `known` 表严格按引擎单遍装载序累积——检查本条目标时表里**没有本条**
 * (引擎 addDataType 在目标解析成功之后才注册),自引用与前向引用同落
 * 「此刻未知」。引擎首个致命错即中止、后文条目不装载;本检查继续扫描给全
 * 发现,但致命条目一律不入表(注册账与引擎一致,见头注边界)。
 */
export function computeTypesXmlStructureFindings(text: string): TypesXmlStructureFinding[] {
  // 解析器对畸形 XML 会抛(assignNodePositions 定位失败);本文面只在可解析
  // 文档上声称,解析失败 = 零发现
  let document;
  try {
    document = parseDefDocument(text);
  } catch {
    return [];
  }
  if (!document.root) { return []; }
  const findings: TypesXmlStructureFinding[] = [];
  const tables: KnownTables = { known: new Map<string, KnownAlias>(), knownLower: new Set<string>() };
  const items = getDirectChildElements(document.root);
  const names: NameContext = {
    allExact: new Set(items.map(item => item.name.trim())),
    allLower: new Set(items.map(item => item.name.trim().toLowerCase()))
  };
  for (const item of items) {
    const name = item.name.trim();
    const nameSpan = elementNameSpan(item);
    if (name.startsWith('_')) {
      // validTypeName 只禁首字符 _,loadTypes 在读指引之前先查 → 中止,本条不注册
      findings.push({
        code: 'kbengine.types.reservedPrefix',
        severity: 'error',
        offset: nameSpan.offset,
        length: nameSpan.length,
        message: `别名「${name}」以 _ 开头：引擎 validTypeName 只禁首字符 _（内部临时结构保留前缀），loadTypes 在读指引之前先查，命中即报错并中止启动（datatypes.cpp:43-50/124-130）`
      });
      continue;
    }
    const directive = directiveText(item);
    if (directive === null) {
      // 条目无(非空白)子节点:引擎 childNode == NULL 整条静默跳过(不注册无日志)
      continue;
    }
    let branchOk = false;
    if (directive === FIXED_DICT_TYPE_NAME) {
      branchOk = checkFixedDictFields(item, `FIXED_DICT「${name}」`, tables, findings, names);
    } else if (directive === 'ARRAY') {
      const elementType = resolveArrayOfChain(item, `别名「${name}」`, tables, findings, names);
      branchOk = elementType !== null;
    } else if (directive.length === 0) {
      // 指引读得空串(首子节点是元素):getDataType("") 查不到 → 中止
      findings.push({
        code: 'kbengine.types.forwardRef',
        severity: 'error',
        offset: firstTextSpan(item).offset,
        length: firstTextSpan(item).length,
        message: `别名「${name}」的目标是元素形态：引擎 getValStr 只认文本节点（xml.cpp:121-128），读得空类型后 getDataType 查不到即报错并中止启动（datatypes.cpp:169-178）`
      });
      branchOk = false;
    } else if (!isResolvableName(directive, tables)) {
      findings.push({
        code: 'kbengine.types.forwardRef',
        severity: 'error',
        offset: firstTextSpan(item).offset,
        length: firstTextSpan(item).length,
        message: unresolvableTargetMessage(
          `别名「${name}」的目标`,
          directive,
          directive,
          names,
          tables,
          'getDataType 查不到即报「can\'t fount type」并中止启动（datatypes.cpp:169-178）'
        )
      });
      branchOk = false;
    } else {
      branchOk = true;
    }
    if (!branchOk) {
      continue; // 致命:引擎中止,本条不注册(addDataType 未达)
    }
    // addDataType:大小写不敏感查重命中 → ERROR + false,但返回值被 loadTypes
    // 丢弃 → 装载继续、先注册者胜(本条不生效,报 Warning)
    if (tables.knownLower.has(name.toLowerCase())) {
      findings.push({
        code: 'kbengine.types.duplicateAlias',
        severity: 'warning',
        offset: nameSpan.offset,
        length: nameSpan.length,
        message: `别名「${name}」重名（引擎大小写不敏感查重）：addDataType 打「name exist」日志后返回值被 loadTypes 丢弃——装载继续、先注册者胜，本条不会生效（datatypes.cpp:198-203，调用点 :141/:158/:180 丢弃返回）`
      });
      continue;
    }
    tables.knownLower.add(name.toLowerCase());
    tables.known.set(name, { name, target: directive });
  }
  return findings;
}
