/**
 * 网络包结构生成(批123)
 * 从 def 树(实体 → Interfaces → Parent 递归,同一 ScriptDefModule)产出客户端
 * 可见方法的参数序列、utype 序列与消息编号表,机读 JSON + 人读 Markdown 双产出。
 *
 * 规格对齐引擎装载语义(kbe/src/lib/entitydef):
 * - 模块装配顺序:loadDefInfo(entitydef.cpp L339-387)= 本 def 全量描述
 *   (Properties → CellMethods → BaseMethods → ClientMethods,L927-975)→
 *   Interfaces 声明序逐个并入(每接口:全量描述 → 组件槽 → 递归自身
 *   Interfaces,L549-638;接口路径不装父类)→ Components(各自独立
 *   ScriptDefModule,全局缓存,L650-780)→ Parent 递归 loadDefInfo。
 *   组件模块不并入实体模块,其方法 utype 消耗依赖 entities.xml 全局装载序,
 *   静态不可定,本表不含组件模块(编号口径:该实体是本次装载的首个模块)。
 * - 方法 utype:显式 <Utype> 登记全局已用集(g_methodCusUtypes);未设置(≤0)
 *   从 g_methodUtypeAuto(初值 1)取最小未占用值;同模块(含继承/接口并入的
 *   方法)重复 → 'Utype' X Conflict 报错并 return false;>65535 溢出报错
 *   (ENTITY_METHOD_UID 为 uint16)。冲突查找只搜本模块三张方法表,跨模块
 *   重复不报错。简化:<Utype> 在 Arg 循环内处理,Arg 失败时已占号不回收;
 *   本生成器在参数全部通过后才登记 utype,差异只影响失败模块的后续推演编号。
 * - 方法名冲突:addXxxMethodDescription 先查 hasPropertyName(三域任一)/
 *   hasComponentName(组件槽名,随装配序累积)/同段同名,均报错并失败
 *   (scriptdef_module.cpp L857-960);属性侧 addPropertyDescription 对称
 *   查 hasMethodName/hasComponentName/同域同名(L533-599)。
 * - aliasID:仅 entitydefAliasID 开启时(entitydef.h L189,引擎默认关)。
 *   hasClient 属性从 ENTITY_BASE_PROPERTY_ALIASID_MAX(=4,1-3 保留给
 *   position/direction/spaceID)起、ClientMethods 从 1 起,均按名字升序
 *   (std::map keyed by name);计数超 255 全部回退 -1 且不使用 aliasID
 *   (scriptdef_module.cpp onLoaded L116-196,无报错静默禁用)。Exposed 的
 *   Base/Cell 方法线上用 utype 标识,不参与 aliasID。
 * - 参数序列:<Arg> 直文本为类型名;ARRAY 走 <of> 递归链;未知类型/缺 of/
 *   of 类型未注册/嵌套失败均按引擎 ERROR_MSG 字面收集。内联数组类型构造即
 *   占 utype(datatype.cpp L87-92),方法参数级不注册名,嵌套级注册
 *   _{名}_ArrayType(datatypes.cpp L1671-1683)。
 * - types.xml:基元 21 个按 DataTypes::initialize 顺序占 utype 1-21
 *   (datatypes.cpp L54-79),用户类型文档序从 22 起(_g_dataTypeUID++);
 *   别名共享底层 DataType 的 utype(查找区分大小写,datatypes.cpp L262-266);
 *   重名别名(大小写不敏感,addDataType dataTypesLowerName_)报错但装载继续;
 *   下划线前缀别名名/别名指向未注册类型 → loadTypes 失败。
 * - 属性:保留名(ENTITY_LIMITED_PROPERTYS 静态表;动态 KBEngine.Entity
 *   Python 属性名比对静态不可复现,未入表)→ Flags 必填且须在
 *   g_entityFlagMapping 12 项内(entitydef.cpp L161-174,查找前 toupper;
 *   12 表项值均含 base 或 cell 位,引擎的无 base/cell 位臂实际不可达;
 *   引擎三处拼写均为 "fount")→ Type 缺失报 not fount TypeNode,未注册类型
 *   静默 return false(无 ERROR_MSG)→ 属性 utype(calcDefPropertyUType
 *   L1018-1094,与方法 utype 独立的计数器/已用集;冲突按持有者注册域逐条
 *   报,先分配后查名)→ cell→base→client 域添加(方法名/组件槽名/同域
 *   同名三查,内部报错后外层补 addPropertyDescription({module}): {root}.)。
 * - 组件槽(loadComponents L650-820):槽 = 三域属性(BASE|CELL_PUBLIC|
 *   客户端位)占属性 utype、计入 aliasID;组件类型名首见构造
 *   EntityComponentType 占一个 DataType utype(模块缓存,重复引用不重占);
 *   组件 def 树是独立 ScriptDefModule(自身另有 aliasID 空间),不并入。
 *
 * 遇 fatal 问题(引擎 return false)后推演继续到全表:已用集/计数器/已分配表
 * 照常演进,后续方法拿到"假设装载继续"的应然编号,供一次定位全部冲突;
 * loadFailed 与 issues 如实标注引擎真实结局。
 *
 * SRC-012 分片:渲染半边在 src/backend/messageTableRender.ts,实体装配分派半边在
 * src/backend/messageTableEntity.ts,引擎装载模拟半边(常量表 + ModuleAssembly +
 * loadDefIntoModule/loadTypesXml/assignAliasIds 等)在
 * src/backend/messageTableEngine.ts;本文件是类型词汇 + 两个构建入口(TS 纯实现与
 * Rust 主路径)的枢纽,公开导入路径不变。
 */

import { DefMethodSection } from './defParser';
import { LocalDefinitionSemantics, parseLocalDefinition } from '../definitionSemantics';
import { getKodeCoreShadowGate } from './kodeCoreShadowFaces';
import {
  assignAliasIds,
  loadDefIntoModule,
  loadTypesXml,
  type ModuleAssembly,
  PRIMITIVE_TYPE_UTYPES
} from './messageTableEngine';

export interface MessageTableOptions {
  /** entitydefAliasID 开关(引擎默认关);关时 aliasID 全 null */
  aliasIdEnabled?: boolean;
  /** types.xml 全文,可选;给出时用户类型从 22 起占 utype */
  typesXml?: string;
}

/** def 树取源:实体/接口 def 文件的本地语义;装配层用 DefinitionSemanticsLoader 适配 */
export interface DefTreeSource {
  loadDef(name: string, kind: 'entity' | 'interface' | 'component'): LocalDefinitionSemantics | null;
}

export type MessageTableIssueKind =
  | 'utype-conflict'
  | 'utype-overflow'
  | 'unknown-arg-type'
  | 'array-of-missing'
  | 'array-of-unknown-type'
  | 'array-init-failed'
  | 'method-name-conflict'
  | 'method-property-name-conflict'
  | 'method-component-name-conflict'
  | 'property-method-name-conflict'
  | 'property-component-name-conflict'
  | 'property-flags-missing'
  | 'property-flags-unknown'
  | 'property-flags-no-base-cell'
  | 'property-type-missing'
  | 'property-type-unknown'
  | 'property-name-conflict'
  | 'property-name-limited'
  | 'duplicate-type-alias'
  | 'invalid-type-alias-name'
  | 'unknown-aliased-type'
  | 'types-parse-error'
  | 'interface-file-missing'
  | 'interface-cycle'
  | 'parent-file-missing'
  | 'parent-cycle'
  | 'component-def-missing';

export interface MessageTableIssue {
  kind: MessageTableIssueKind;
  /** 引擎 ERROR_MSG 原文(无换行);引擎静默失败处为 kode 组合文本并注明 */
  message: string;
  /** 引擎在该问题处 return false(装载失败);别名重名等继续装载为 false */
  fatal: boolean;
  line: number | null;
}

export interface MessageArgEntry {
  /** 类型名;ARRAY 级为 'ARRAY' */
  name: string;
  /** ARRAY 级的元素类型链;非 ARRAY 恒 null */
  ofType: MessageArgEntry | null;
  /** 本级类型 utype(ARRAY 级 = 内联数组类型自身 utype);失败 null */
  utype: number | null;
  line: number;
}

export type MessageMethodStatus = 'ok' | 'utype-conflict' | 'utype-overflow' | 'arg-load-failed' | 'name-conflict';

export interface MessageMethodEntry {
  name: string;
  section: DefMethodSection;
  /** server-to-client = ClientMethods 回调;client-to-server = Exposed 的 Base/Cell 请求 */
  direction: 'server-to-client' | 'client-to-server' | 'server-internal';
  visibleToClient: boolean;
  exposed: boolean;
  args: MessageArgEntry[];
  declaredUtype: number | null;
  utype: number | null;
  aliasID: number | null;
  status: MessageMethodStatus;
  /** 方法来源 def(本 def / 接口名 / 父类名),装配序透明化 */
  origin: string;
  originKind: 'own' | 'interface' | 'parent';
  line: number;
}

export interface MessagePropertyEntry {
  name: string;
  typeName: string | null;
  /** 校验通过的 flags 文本(大写归一);缺/未知/纯客户端位在装载期已报错,空串占位 */
  flags: string;
  hasClient: boolean;
  /** 属性 utype(与方法 utype 独立的空间);显式冲突/溢出/装载失败 null */
  utype: number | null;
  declaredUtype: number | null;
  aliasID: number | null;
  /** 组件槽 `<Persistent>`(缺省 true);普通属性 null(不透出) */
  persistent: boolean | null;
  origin: string;
  originKind: 'own' | 'interface' | 'parent';
  line: number;
}

export type MessageTableTypeKind =
  | 'primitive'
  | 'alias'
  | 'fixed-dict'
  | 'array'
  | 'inline-array'
  | 'entity-component';

export interface TypeUtypeEntry {
  name: string;
  utype: number;
  kind: MessageTableTypeKind;
  /** alias 指向的底层类型名(别名共享其 utype);嵌套数组级为引擎注册名 */
  aliasedTo: string | null;
  line: number | null;
  origin: string;
}

export interface MessageTable {
  module: string;
  generatedAt: string;
  aliasIdEnabled: boolean;
  /** 存在任一 fatal 问题(引擎语义下模块装载失败) */
  loadFailed: boolean;
  fatalCount: number;
  /** 装配序走过的 def(实体 + 接口 + 父链) */
  sources: Array<{ name: string; kind: 'own' | 'interface' | 'parent'; filePath: string }>;
  methods: MessageMethodEntry[];
  /** 客户端可见子集(ClientMethods 全部 + 带 Exposed 的 Base/Cell 方法) */
  clientMethods: MessageMethodEntry[];
  /** 全量属性(含服务器内部属性与组件槽,属性 utype 序列的载体) */
  properties: MessagePropertyEntry[];
  clientProperties: MessagePropertyEntry[];
  types: TypeUtypeEntry[];
  issues: MessageTableIssue[];
}

/**
 * 构建 def 树消息编号表。实体 def 取不到返回 null;其余取不到的接口/父类
 * def 记 issue(fatal)后按引擎语义终止该分支。
 */
export function buildMessageTable(
  entityName: string,
  source: DefTreeSource,
  options: MessageTableOptions = {}
): MessageTable | null {
  const own = source.loadDef(entityName, 'entity');
  if (!own) {
    return null;
  }

  const assembly: ModuleAssembly = {
    entityName,
    usedUtypes: new Set<number>(),
    autoCounter: 1,
    holders: new Map<number, { name: string }>(),
    propertyUsedUtypes: new Set<number>(),
    propertyAutoCounter: 1,
    propertyHolders: new Map<number, { name: string; domains: Set<'cell' | 'base' | 'client'> }>(),
    methodNamesBySection: {
      BaseMethods: new Set<string>(),
      CellMethods: new Set<string>(),
      ClientMethods: new Set<string>()
    },
    allMethodNames: new Set<string>(),
    propertyDomains: {
      cell: new Set<string>(),
      base: new Set<string>(),
      client: new Set<string>()
    },
    allPropertyNames: new Set<string>(),
    componentNames: new Set<string>(),
    seenComponentTypes: new Set<string>(),
    registry: new Map<string, number>(),
    types: [],
    issues: [],
    nextTypeUtype: 1,
    methods: [],
    properties: [],
    sources: [],
    visited: new Set<string>(),
    interfacePath: new Set<string>()
  };

  for (const [name, utype] of PRIMITIVE_TYPE_UTYPES) {
    assembly.registry.set(name, utype);
    assembly.types.push({ name, utype, kind: 'primitive', aliasedTo: null, line: null, origin: '' });
  }
  assembly.nextTypeUtype = PRIMITIVE_TYPE_UTYPES.length + 1;
  if (options.typesXml !== undefined) {
    loadTypesXml(entityName, options.typesXml, assembly);
  }

  loadDefIntoModule(entityName, own, 'own', source, assembly);

  assignAliasIds(assembly, options.aliasIdEnabled ?? false);

  const methods = assembly.methods;
  return {
    module: entityName,
    generatedAt: new Date().toISOString(),
    aliasIdEnabled: options.aliasIdEnabled ?? false,
    loadFailed: assembly.issues.some(issue => issue.fatal),
    fatalCount: assembly.issues.filter(issue => issue.fatal).length,
    sources: assembly.sources,
    methods,
    clientMethods: methods.filter(method => method.visibleToClient),
    properties: assembly.properties,
    clientProperties: assembly.properties.filter(property => property.hasClient),
    types: assembly.types,
    issues: assembly.issues
  };
}

/** def 原文取源(Rust 命令级 RPC 语料用):按名取文件原文+路径。 */
export interface DefRawText {
  content: string;
  filePath: string;
}

export interface DefRawSource {
  loadDefRaw(name: string, kind: 'entity' | 'interface' | 'component'): DefRawText | null;
}

/**
 * 主路径:Rust 核心建表(单一来源)。Rust 不可用(无 gate/无 serverPath/调用
 * 失败/结果形状不完整)返回 null,由调用方回落到 TS 纯实现。
 *
 * 语料直传:TS 只负责按名取 def 原文(实体 + 父链 + 接口闭包),Rust 侧负责
 * 全部解析与装配;不依赖 mirror 语料与 shadow 模式。TS 不解析原文,仅用
 * parseLocalDefinition 的 Parent/Interfaces 引用做闭包发现。
 */
export async function buildMessageTableInRust(
  entityName: string,
  rawSource: DefRawSource,
  options: MessageTableOptions = {}
): Promise<MessageTable | null> {
  const gate = getKodeCoreShadowGate();
  if (!gate) {
    return null;
  }

  const defs: Record<string, string> = {};
  const paths: Record<string, string> = {};
  const ownRaw = rawSource.loadDefRaw(entityName, 'entity');
  if (!ownRaw) {
    return null;
  }

  // 闭包发现:实体父链 BFS(每实体的接口引用 + 父类),接口递归自身 Interfaces
  // (引擎 loadInterfaces 对每个接口递归自身 Interfaces,entitydef.cpp L628-638;
  // 接口内 Parent 不装,引擎 loadInterfaces 路径不调 loadParentClass),接口
  // Components 的组件 def 同实体口径入组件闭包。缺失 def 不收集,Rust 侧按
  // parent-file-missing/interface-file-missing 如实报出。
  const entityQueue: string[] = [entityName];
  const seenEntities = new Set<string>();
  const seenInterfaces = new Set<string>();
  const componentQueue: string[] = [];
  const enqueuedComponents = new Set<string>();
  const enqueueComponents = (local: LocalDefinitionSemantics): void => {
    for (const component of local.components) {
      if (!enqueuedComponents.has(component.typeName)) {
        enqueuedComponents.add(component.typeName);
        componentQueue.push(component.typeName);
      }
    }
  };
  const collectInterface = (name: string): void => {
    if (seenInterfaces.has(name)) {
      return;
    }
    seenInterfaces.add(name);
    const ifaceRaw = rawSource.loadDefRaw(name, 'interface');
    if (!ifaceRaw) {
      return;
    }
    defs[name] = ifaceRaw.content;
    paths[name] = ifaceRaw.filePath;
    let ifaceLocal: LocalDefinitionSemantics;
    try {
      ifaceLocal = parseLocalDefinition(ifaceRaw.content, 'interface', name, ifaceRaw.filePath);
    } catch {
      return;
    }
    // KR-AUD-67:接口自身 Interfaces 递归入闭包;接口 Components 入组件闭包
    for (const ref of ifaceLocal.interfaces) {
      collectInterface(ref.name);
    }
    enqueueComponents(ifaceLocal);
  };
  while (entityQueue.length > 0) {
    const name = entityQueue.shift()!;
    if (seenEntities.has(name)) {
      continue;
    }
    seenEntities.add(name);
    const raw = name === entityName ? ownRaw : rawSource.loadDefRaw(name, 'entity');
    if (!raw) {
      continue;
    }
    defs[name] = raw.content;
    paths[name] = raw.filePath;
    let local: LocalDefinitionSemantics;
    try {
      local = parseLocalDefinition(raw.content, 'entity', name, raw.filePath);
    } catch {
      continue;
    }
    if (local.parentName && !seenEntities.has(local.parentName)) {
      entityQueue.push(local.parentName);
    }
    for (const ref of local.interfaces) {
      collectInterface(ref.name);
    }
    enqueueComponents(local);
  }
  // 组件闭包 BFS(IDE-RUST-006):组件 def 原文 + 其接口(interface 类)+ 父类
  // (component 类)递归,供 Rust 侧组件模块域面与 SDK 组件可见性用。
  while (componentQueue.length > 0) {
    const name = componentQueue.shift()!;
    const raw = rawSource.loadDefRaw(name, 'component');
    if (!raw) {
      continue;
    }
    defs[name] = raw.content;
    paths[name] = raw.filePath;
    let local: LocalDefinitionSemantics;
    try {
      local = parseLocalDefinition(raw.content, 'component', name, raw.filePath);
    } catch {
      continue;
    }
    for (const ref of local.interfaces) {
      collectInterface(ref.name);
    }
    if (local.parentName && !enqueuedComponents.has(local.parentName)) {
      enqueuedComponents.add(local.parentName);
      componentQueue.push(local.parentName);
    }
    enqueueComponents(local);
  }

  const response = await gate.runInRust<MessageTable>('$/kode/messageTable/build', {
    entityName,
    defText: defs[entityName],
    typesXml: options.typesXml,
    defs,
    paths,
    aliasIdEnabled: options.aliasIdEnabled ?? false
  });
  if (!response.ok) {
    return null;
  }
  const table = response.result;
  if (!table || typeof table.module !== 'string' || !Array.isArray(table.methods)) {
    return null;
  }
  return table;
}

// ---------------------------------------------------------------------------
// 渲染:人读 Markdown + 机读 JSON(SRC-012 迁 src/backend/messageTableRender.ts)
// ---------------------------------------------------------------------------

export { renderMessageTableJson, renderMessageTableMarkdown } from './messageTableRender';
