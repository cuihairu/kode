/**
 * 网络包结构生成——引擎装载模拟半边(SRC-012 自 messageTable.ts 纯移动迁出)。
 *
 * 内容:引擎常量表(g_entityFlagMapping/三域位集/组件类型号/基元 utype 表/
 * 保留属性名/utype 上界/aliasID 常量/方法装载序)、装配态 ModuleAssembly、
 * 引擎装载语义的逐步模拟(loadDefIntoModule、loadSourceDef、loadTypesXml、
 * simulateProperty、allocatePropertyUtype、registerComponentSlot、
 * simulateMethod、parseMethodArg、assignAliasIds 等)。
 *
 * 功能规格与引擎语义逐条引用(file:line)见 messageTable.ts 模块头,本文件
 * 不重复规格叙述;函数级注释照录原位原文。类型词汇(MessageTable/条目/
 * DefTreeSource 等)自 messageTable 仅类型导入,运行时无环
 * (messageTableRender.ts 同口径);公开入口 messageTable.ts 的
 * buildMessageTable 经本文件导出的装配函数驱动(PRIMITIVE_TYPE_UTYPES 播种
 * → loadTypesXml → loadDefIntoModule → assignAliasIds)。
 */

import {
  DefDocument,
  DefMethodSection,
  getDirectChildElement,
  getDirectChildElements,
  getElementText,
  getLineNumberAt,
  parseDefDocument
} from './defParser';
import {
  DefinitionArgType,
  DefinitionComponentRef,
  DefinitionMethod,
  DefinitionProperty,
  LocalDefinitionSemantics
} from '../definitionSemantics';
import { FIXED_DICT_TYPE_NAME } from '../kbengineMetadata';
import type {
  DefTreeSource,
  MessageArgEntry,
  MessageMethodEntry,
  MessagePropertyEntry,
  MessageTableIssue,
  MessageTableIssueKind,
  TypeUtypeEntry
} from './messageTable';

// g_entityFlagMapping 12 项(entitydef.cpp L161-174),值为 EntityDataFlags 位
// (common.h L19-30)。查找前 toupper(引擎 std::transform),大小写不敏感。
// 注意:这是 utype 注册的**线位事实**(common.h L19-30 位集),与可见性域位表
// (单一来源 Rust src/generated/flagDomains.ts)是两份不同的引擎事实——如
// OWN_CLIENT(0x10)同时在 ENTITY_CELL_DATA_FLAGS 与 ENTITY_CLIENT_DATA_FLAGS
// 里,而域位表只给 ['client']。两者不可互相推导,勿合并。
const PROPERTY_FLAG_BITS: Record<string, number> = {
  CELL: 0x01,
  CELL_AND_CLIENT: 0x08,
  CELL_AND_CLIENTS: 0x04,
  CELL_AND_OTHER_CLIENTS: 0x80,
  BASE_AND_CLIENT: 0x20,
  BASE: 0x40,
  CELL_PUBLIC: 0x01,
  CELL_PRIVATE: 0x02,
  ALL_CLIENTS: 0x04,
  CELL_PUBLIC_AND_OWN: 0x08,
  OTHER_CLIENTS: 0x80,
  OWN_CLIENT: 0x10
};

// common.h L141-147:三域位集
const ENTITY_BASE_DATA_FLAGS = 0x40 | 0x20;
const ENTITY_CELL_DATA_FLAGS = 0x01 | 0x02 | 0x04 | 0x08 | 0x80 | 0x10;
const ENTITY_CLIENT_DATA_FLAGS = 0x20 | 0x04 | 0x08 | 0x80 | 0x10;

// 组件类型号(common.h L78-82),addPropertyDescription 冲突报错按域打印
const DOMAIN_COMPONENT_TYPE: Record<'cell' | 'base' | 'client', number> = {
  cell: 5,
  base: 6,
  client: 7
};

// 基元类型 utype 表:DataTypes::initialize 顺序(datatypes.cpp L54-79)。
// 全部以 did=0 构造,DataType 构造函数按 _g_dataTypeUID++(初值 1)分配
// (datatype.cpp L87-92),故 utype = 该顺序位置。
export const PRIMITIVE_TYPE_UTYPES: ReadonlyArray<readonly [string, number]> = [
  ['UINT8', 1],
  ['UINT16', 2],
  ['UINT64', 3],
  ['UINT32', 4],
  ['INT8', 5],
  ['INT16', 6],
  ['INT32', 7],
  ['INT64', 8],
  ['STRING', 9],
  ['UNICODE', 10],
  ['FLOAT', 11],
  ['DOUBLE', 12],
  ['PYTHON', 13],
  ['PY_DICT', 14],
  ['PY_TUPLE', 15],
  ['PY_LIST', 16],
  ['ENTITYCALL', 17],
  ['BLOB', 18],
  ['VECTOR2', 19],
  ['VECTOR3', 20],
  ['VECTOR4', 21]
];

// 引擎保留属性名(common.h L125-155 ENTITY_LIMITED_PROPERTYS,静态表部分):
// validDefPropertyName 命中即报 limited 并失败。原表两处相邻字符串字面量缺
// 逗号("component" "databaseID"、"interface" ""),C++ 拼接语义下引擎实际
// 比对的是 "componentdatabaseID" 与 "interface",照引擎实效收录。另一臂
// (运行时比对 KBEngine.Entity 的 Python 属性名)静态不可复现,不入表
const LIMITED_PROPERTY_NAMES: ReadonlySet<string> = new Set<string>([
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

// ENTITY_METHOD_UID 上界:uint16,超界引擎报溢出(entitydef.cpp L1372-1378)
const METHOD_UTYPE_MAX = 65535;
// aliasID:1 字节;属性从 4 起(common.h ENTITY_BASE_PROPERTY_ALIASID,1-3 保留
// position/direction/spaceID),超 255 回退 -1
const ALIAS_ID_PROPERTY_BASE = 4;
const ALIAS_ID_MAX = 255;

const METHOD_LOAD_ORDER: ReadonlyArray<DefMethodSection> = [
  'CellMethods',
  'BaseMethods',
  'ClientMethods'
];

/** 装配态:引擎全局计数器与模块内已注册名的模拟 */
export interface ModuleAssembly {
  /** 装载目标实体名(引擎 ERROR_MSG 里 {module} 均指它,非各 def 来源名) */
  entityName: string;
  usedUtypes: Set<number>;
  autoCounter: number;
  /** 方法 utype → 持有者(冲突报错点名用) */
  holders: Map<number, { name: string }>;
  /** 属性 utype 空间(g_propertyUtypeAuto/g_propertyUtypes,与方法独立) */
  propertyUsedUtypes: Set<number>;
  propertyAutoCounter: number;
  propertyHolders: Map<number, { name: string; domains: Set<'cell' | 'base' | 'client'> }>;
  /** 三张方法名表(scriptdef_module.cpp methodXxxDescr_) */
  methodNamesBySection: Record<DefMethodSection, Set<string>>;
  /** hasMethodName:三段任一(scriptdef_module.cpp L1049-1055) */
  allMethodNames: Set<string>;
  /** 三域属性名表(addPropertyDescription 按域查重) */
  propertyDomains: Record<'cell' | 'base' | 'client', Set<string>>;
  /** hasPropertyName:三域任一(scriptdef_module.cpp L1041-1046) */
  allPropertyNames: Set<string>;
  /** hasComponentName:组件槽名,随装配序累积 */
  componentNames: Set<string>;
  registry: Map<string, number>;
  /** 已占用 EntityComponentType 的组件类型名(引擎模块缓存语义,重复引用不重占) */
  seenComponentTypes: Set<string>;
  types: TypeUtypeEntry[];
  issues: MessageTableIssue[];
  /** _g_dataTypeUID 等价:def 内联类型接续点(types.xml 用户类型之后) */
  nextTypeUtype: number;
  methods: MessageMethodEntry[];
  properties: MessagePropertyEntry[];
  sources: Array<{ name: string; kind: 'own' | 'interface' | 'parent'; filePath: string }>;
  visited: Set<string>;
  /**
   * 接口装载路径(KR-AUD-67):接口递归自身 Interfaces 后存在成环可能
   * (引擎 loadInterfaces 无去重,互指接口会无限递归),path 守卫截断;
   * 重复声明(菱形)不走此守卫,靠撞名冲突如实报出(与引擎一致)。
   */
  interfacePath: Set<string>;
}

/**
 * 单份 def 并入模块(引擎 loadDefInfo 递归单元):
 * 属性 → Cell → Base → Client 方法 → 接口声明序递归 → 组件槽名 →(非接口)父类递归。
 * 接口 origin 与实体同走 Interfaces 递归 + 组件槽注册(引擎 loadInterfaces 对每个
 * 接口调 loadComponents 与递归 loadInterfaces,entitydef.cpp L598-638),但跳过父类
 * (loadInterfaces 路径不调 loadParentClass)。
 * 父链是线性的(每份 def 单父),同文件重入即父链成环(引擎无限递归,kode 截断)。
 */
export function loadDefIntoModule(
  moduleName: string,
  local: LocalDefinitionSemantics,
  originKind: 'own' | 'interface' | 'parent',
  source: DefTreeSource,
  assembly: ModuleAssembly
): void {
  const visitKey = normalizeSourceKey(local.owner.filePath);
  // 成环守卫罩两处(引擎两处递归均无去重,同文件重入即环,kode 截断报错):
  // 1. 实体 own+父链:parent-cycle。
  // 2. 接口自身 Interfaces 递归(KR-AUD-67):interface-cycle,path 守卫
  //    (进栈/出栈),菱形重复声明不经此守卫——引擎对重复声明每次完整装载,
  //    第二次撞名字报 [X] is exist!,kode 由既有撞名冲突如实报出。
  if (originKind === 'interface') {
    if (assembly.interfacePath.has(visitKey)) {
      assembly.issues.push({
        kind: 'interface-cycle',
        fatal: true,
        line: local.parentLine ?? null,
        message: `接口链成环:${assembly.entityName} 装载中重入接口 ${moduleName}(引擎 loadInterfaces 递归无法终止,kode 截断该分支)`
      });
      return;
    }
    assembly.interfacePath.add(visitKey);
  } else if (assembly.visited.has(visitKey)) {
    assembly.issues.push({
      kind: 'parent-cycle',
      fatal: true,
      /* istanbul ignore next -- 重入者必经父链到达,parentLine 必已定义,null 臂不可达 */
      line: local.parentLine ?? null,
      message: `父类链成环:${assembly.entityName} 装载中重入 ${moduleName}(引擎递归装载无法终止,kode 截断该分支)`
    });
    return;
  }
  assembly.sources.push({ name: moduleName, kind: originKind, filePath: local.owner.filePath });
  if (originKind !== 'interface') {
    assembly.visited.add(visitKey);
  }

  const rootName = local.document.root?.name ?? '';
  for (const property of local.properties) {
    simulateProperty(moduleName, property, originKind, rootName, assembly);
  }

  for (const section of METHOD_LOAD_ORDER) {
    for (const method of local.methodsBySection[section]) {
      simulateMethod(moduleName, method, originKind, assembly);
    }
  }

  // 接口声明序递归(接口 origin 同样递归自身 Interfaces,引擎 L628-638)
  for (const interfaceRef of local.interfaces) {
    const interfaceLocal = loadSourceDef(interfaceRef.name, 'interface', source, assembly);
    if (!interfaceLocal) {
      continue;
    }
    loadDefIntoModule(interfaceRef.name, interfaceLocal, 'interface', source, assembly);
  }

  // 组件槽注册(loadComponents 在接口后父类前;接口 origin 同样注册,引擎 L617-625):
  // 槽是一个属性(addComponentProperty → addPropertyDescription 三域),占属性 utype,
  // hasClient 计入 aliasID;组件 def 树本身是独立模块,不并入(见模块头)
  for (const component of local.components) {
    registerComponentSlot(moduleName, component, source, assembly);
  }

  // 引擎 loadInterfaces 路径不调 loadParentClass:接口 origin 到此为止
  if (originKind !== 'interface' && local.parentName) {
    const parentLocal = loadSourceDef(local.parentName, 'entity', source, assembly);
    if (!parentLocal) {
      return;
    }
    loadDefIntoModule(local.parentName, parentLocal, 'parent', source, assembly);
  }

  if (originKind === 'interface') {
    assembly.interfacePath.delete(visitKey);
  }
}

function loadSourceDef(
  name: string,
  kind: 'entity' | 'interface',
  source: DefTreeSource,
  assembly: ModuleAssembly
): LocalDefinitionSemantics | null {
  const local = source.loadDef(name, kind);
  if (!local) {
    // 引擎 openSection 失败 → return false,外层报 failed to load ... interface/parentClass
    const outer = kind === 'interface' ? 'interface' : 'parentClass';
    assembly.issues.push({
      kind: kind === 'interface' ? 'interface-file-missing' : 'parent-file-missing',
      fatal: true,
      line: null,
      message: `EntityDef::loadDefInfo: failed to load entity:${name} ${outer}.`
    });
  }
  return local;
}

/**
 * types.xml 装载模拟(datatypes.cpp loadTypes L107-186):root 子元素 = 别名名,
 * 文档序。FIXED_DICT/ARRAY 是别名元素的直接子元素(非文本),创建用户类型
 * 占新 utype(构造先于 initialize,失败也占);别名共享目标 utype;重名
 * (大小写不敏感)报错但装载继续;下划线前缀/未知目标 → loadTypes 失败。
 */
export function loadTypesXml(origin: string, typesXml: string, assembly: ModuleAssembly): void {
  let document: DefDocument;
  try {
    document = parseDefDocument(typesXml);
  } catch {
    assembly.issues.push({
      kind: 'types-parse-error',
      fatal: true,
      line: null,
      message: 'DataTypes::loadTypes: types.xml 解析失败(非法 XML)'
    });
    return;
  }
  const root = document.root;
  if (!root) {
    return;
  }

  for (const aliasNode of getDirectChildElements(root)) {
    const aliasName = aliasNode.name;
    const line = getLineNumberAt(document, aliasNode.tagStart);
    if (aliasName.startsWith('_')) {
      assembly.issues.push({
        kind: 'invalid-type-alias-name',
        fatal: true,
        line,
        message: `DataTypes::loadTypes: Not allowed to use the prefix "_"! aliasName=${aliasName}`
      });
      continue;
    }

    const fixedDictNode = getDirectChildElement(aliasNode, FIXED_DICT_TYPE_NAME);
    const arrayNode = getDirectChildElement(aliasNode, 'ARRAY');
    const childText = getElementText(aliasNode).trim();
    // addDataType 大小写不敏感查重(dataTypesLowerName_);重名报错但装载继续:
    // FIXED_DICT/ARRAY 的 utype 已被构造函数消费(uid_dataTypes_ 注册),
    // 名字不覆盖;别名无新类型不占号
    if (hasAliasName(assembly, aliasName)) {
      assembly.issues.push({
        kind: 'duplicate-type-alias',
        fatal: false,
        line,
        message: `DataTypes::addDataType(name): name ${aliasName} exist.`
      });
      if (fixedDictNode) {
        consumeUserType(aliasName, line, 'fixed-dict');
      } else if (arrayNode) {
        consumeUserType(aliasName, line, 'array');
      }
      continue;
    }

    if (fixedDictNode) {
      const propertiesNode = getDirectChildElement(fixedDictNode, 'Properties');
      if (!propertiesNode) {
        assembly.issues.push({
          kind: 'types-parse-error',
          fatal: true,
          line,
          message: 'FixedDictType::initialize: not found "Properties".'
        });
        assembly.issues.push({
          kind: 'types-parse-error',
          fatal: true,
          line,
          message: `DataTypes::loadTypes: parse FIXED_DICT [${aliasName}] error!`
        });
        // 引擎:new FixedDictType 构造先占号,initialize 失败后别名不注册
        consumeUserType(aliasName, line, 'fixed-dict');
        continue;
      }
      registerUserType(aliasName, line, 'fixed-dict', null);
      continue;
    }
    if (arrayNode) {
      const ofNode = getDirectChildElement(arrayNode, 'of');
      if (!ofNode) {
        assembly.issues.push({
          kind: 'array-of-missing',
          fatal: true,
          line,
          message: 'FixedArrayType::initialize: not found "of".'
        });
        assembly.issues.push({
          kind: 'types-parse-error',
          fatal: true,
          line,
          message: `DataTypes::loadTypes: parse ARRAY [${aliasName}] error!`
        });
        // 引擎:类型构造已占号,initialize 失败后别名不注册
        consumeUserType(aliasName, line, 'array');
        continue;
      }
      const ofName = getElementText(ofNode).trim();
      const ofUtype = lookupType(ofName, assembly);
      if (ofUtype === null) {
        assembly.issues.push({
          kind: 'array-of-unknown-type',
          fatal: true,
          line,
          message: `FixedArrayType::initialize: key[ARRAY] did not find type[${ofName}]!`
        });
        assembly.issues.push({
          kind: 'types-parse-error',
          fatal: true,
          line,
          message: `DataTypes::loadTypes: parse ARRAY [${aliasName}] error!`
        });
        consumeUserType(aliasName, line, 'array');
        continue;
      }
      registerUserType(aliasName, line, 'array', null);
      continue;
    }

    const targetUtype = lookupType(childText, assembly);
    if (targetUtype === null) {
      assembly.issues.push({
        kind: 'unknown-aliased-type',
        fatal: true,
        line,
        message: `DataTypes::loadTypes: can't fount type ${childText} by alias[${aliasName}].`
      });
      continue;
    }
    registerUserType(aliasName, line, 'alias', childText);
  }

  function hasAliasName(asm: ModuleAssembly, name: string): boolean {
    const lower = name.toLowerCase();
    for (const known of asm.registry.keys()) {
      if (known.toLowerCase() === lower) {
        return true;
      }
    }
    return false;
  }

  function registerUserType(
    name: string,
    line: number,
    kind: 'fixed-dict' | 'array' | 'alias',
    aliasedTo: string | null
  ): void {
    const utype = aliasedTo === null ? assembly.nextTypeUtype++ : lookupType(aliasedTo, assembly)!;
    assembly.registry.set(name, utype);
    assembly.types.push({ name, utype, kind, aliasedTo, line, origin });
  }

  // 占号不注册名(引擎 uid_dataTypes_ 有、名字不可达)
  function consumeUserType(name: string, line: number, kind: 'fixed-dict' | 'array'): void {
    const utype = assembly.nextTypeUtype++;
    assembly.types.push({ name, utype, kind, aliasedTo: null, line, origin });
  }
}

function lookupType(name: string, assembly: ModuleAssembly): number | null {
  const utype = assembly.registry.get(name);
  return utype === undefined ? null : utype;
}

/**
 * 属性装载模拟(loadDefPropertys L1097-1311 装载序):保留名检查 → flags
 * 校验(必填/查表/须含 base 或 cell 位)→ Type 校验(缺失报错,未注册静默
 * 失败;ARRAY 内联类型占号)→ 属性 utype 分配(calcDefPropertyUType,独立
 * 空间)→ cell→base→client 域添加(名冲突:方法名/组件槽名/同域同名,内部
 * 报错后外层再补一条 addPropertyDescription 汇总)。
 */
function simulateProperty(
  moduleName: string,
  property: DefinitionProperty,
  originKind: 'own' | 'interface' | 'parent',
  rootName: string,
  assembly: ModuleAssembly
): void {
  const origin = originLabel(moduleName, originKind);
  const entry: MessagePropertyEntry = {
    name: property.name,
    typeName: property.typeName ?? null,
    flags: '',
    hasClient: false,
    utype: null,
    declaredUtype: null,
    aliasID: null,
    persistent: null,
    origin,
    originKind,
    line: property.line
  };
  assembly.properties.push(entry);

  if (LIMITED_PROPERTY_NAMES.has(property.name)) {
    assembly.issues.push({
      kind: 'property-name-limited',
      fatal: true,
      line: property.line,
      message: `EntityDef::loadDefPropertys: '${property.name}' is limited, in module(${assembly.entityName})!`
    });
    return;
  }

  // 空 Flags 文本与缺 Flags 节点解析层不区分(getScalarChildValue 同给
  // undefined),统一按缺节点报(引擎对空文本走 not fount flags[] 臂)
  if (property.flags === undefined) {
    assembly.issues.push({
      kind: 'property-flags-missing',
      fatal: true,
      line: property.line,
      message: `EntityDef::loadDefPropertys: not fount flagsNode, is ${assembly.entityName}.${property.name}!`
    });
    return;
  }
  const flagsText = property.flags.trim().toUpperCase();
  entry.flags = flagsText;
  const flagBits = PROPERTY_FLAG_BITS[flagsText];
  if (flagBits === undefined) {
    assembly.issues.push({
      kind: 'property-flags-unknown',
      fatal: true,
      line: property.line,
      message: `EntityDef::loadDefPropertys: not fount flags[${flagsText}], is ${assembly.entityName}.${property.name}!`
    });
    return;
  }
  // 引擎保留此臂(hasBaseFlags<=0 && hasCellFlags<=0 报错),但 g_entityFlagMapping
  // 全部 12 表项的值均落在 base(0x60)∪cell(0x9F)位集内(含 OWN_CLIENT=0x10,
  // 归 cell+client),查表成功者恒过此关,引擎内该臂实际不可达;照形状保留
  /* istanbul ignore start */
  if ((flagBits & ENTITY_BASE_DATA_FLAGS) <= 0 && (flagBits & ENTITY_CELL_DATA_FLAGS) <= 0) {
    assembly.issues.push({
      kind: 'property-flags-no-base-cell',
      fatal: true,
      line: property.line,
      message: `EntityDef::loadDefPropertys: not fount flags[${flagsText}], is ${assembly.entityName}.${property.name}!`
    });
    return;
  }
  /* istanbul ignore stop */
  entry.hasClient = (flagBits & ENTITY_CLIENT_DATA_FLAGS) > 0;
  const registeredDomains = (['cell', 'base', 'client'] as const).filter(
    domain => (flagBits & domainBitsOf(domain)) > 0
  );

  if (property.typeName === undefined) {
    assembly.issues.push({
      kind: 'property-type-missing',
      fatal: true,
      line: property.line,
      message: `EntityDef::loadDefPropertys: not fount TypeNode, is ${assembly.entityName}.${property.name}!`
    });
    return;
  }
  if (property.typeName === 'ARRAY') {
    // 引擎内联 FixedArrayType:{module}_{property} 名不注册,构造即占号;
    // 属性侧 <of> 链解析层未带出(单层计),方法参数侧走全递归
    assembly.types.push({
      name: `${assembly.entityName}_${property.name}`,
      utype: assembly.nextTypeUtype++,
      kind: 'inline-array',
      aliasedTo: null,
      line: property.line,
      origin
    });
  } else if (lookupType(property.typeName, assembly) === null) {
    assembly.issues.push({
      kind: 'property-type-unknown',
      fatal: true,
      line: property.line,
      message: `属性 ${property.name} 的类型 ${property.typeName} 未注册(types.xml 与基元表均无),引擎静默 return false(无 ERROR_MSG)`
    });
    return;
  }

  // 属性 utype(calcDefPropertyUType L1018-1094):显式登记/溢出/冲突(按
  // 持有者注册域逐条报)/自动取最小未占用;分配先于名字三查(引擎顺序)
  const declared = property.utype !== undefined && property.utype !== null && property.utype > 0
    ? property.utype
    : null;
  entry.declaredUtype = declared;
  entry.utype = allocatePropertyUtype(
    declared,
    property.name,
    registeredDomains,
    property.line,
    assembly
  );
  if (entry.utype === null) {
    return;
  }

  // addPropertyDescription 名字三查(scriptdef_module.cpp L533-599),逐域
  // 添加时触发:方法名(父类属性后装时会撞子类已装方法)→ 组件槽名 → 同域
  // 同名。内部报错后引擎外层再补汇总报错(entitydef.cpp L1287-1292);
  // registeredDomains 必非空(过 base/cell 位检查者至少落一域)
  const firstDomain = registeredDomains[0] as 'cell' | 'base' | 'client';
  const reportAddFailure = (kind: MessageTableIssueKind, message: string): void => {
    assembly.issues.push({ kind, fatal: true, line: property.line, message });
    assembly.issues.push({
      kind,
      fatal: true,
      line: property.line,
      message: `EntityDef::addPropertyDescription(${assembly.entityName}): ${rootName}.`
    });
  };

  if (assembly.allMethodNames.has(property.name)) {
    reportAddFailure(
      'property-method-name-conflict',
      `ScriptDefModule::addPropertyDescription: There is a method[${property.name}] name conflict! componentType=${DOMAIN_COMPONENT_TYPE[firstDomain]}.`
    );
    return;
  }
  if (assembly.componentNames.has(property.name)) {
    reportAddFailure(
      'property-component-name-conflict',
      `ScriptDefModule::addPropertyDescription: There is a component[${property.name}] name conflict!`
    );
    return;
  }

  let nameRejected = false;
  for (const domain of registeredDomains) {
    if (assembly.propertyDomains[domain].has(property.name)) {
      assembly.issues.push({
        kind: 'property-name-conflict',
        fatal: true,
        line: property.line,
        message: `ScriptDefModule::addPropertyDescription: [${property.name}] is exist! componentType=${DOMAIN_COMPONENT_TYPE[domain]}.`
      });
      nameRejected = true;
      continue;
    }
    assembly.propertyDomains[domain].add(property.name);
  }
  if (nameRejected) {
    assembly.issues.push({
      kind: 'property-name-conflict',
      fatal: true,
      line: property.line,
      message: `EntityDef::addPropertyDescription(${assembly.entityName}): ${rootName}.`
    });
    return;
  }
  assembly.allPropertyNames.add(property.name);
}

/**
 * 属性 utype 分配(calcDefPropertyUType L1018-1094):独立于方法 utype 的
 * 计数器与已用集。冲突按持有者注册域逐条报(引擎逐域 findPropertyDescription
 * 命中逐条 ERROR);溢出/冲突均不入已用表(引擎 push 在检查之后)。
 */
function allocatePropertyUtype(
  declared: number | null,
  name: string,
  domains: ReadonlyArray<'cell' | 'base' | 'client'>,
  line: number,
  assembly: ModuleAssembly
): number | null {
  if (declared !== null) {
    if (declared > METHOD_UTYPE_MAX) {
      assembly.issues.push({
        kind: 'utype-overflow',
        fatal: true,
        line,
        message: `EntityDef::calcDefPropertyUType: 'Utype' has overflowed(${declared} > ${METHOD_UTYPE_MAX}), is ${assembly.entityName}.${name}!`
      });
      return null;
    }
    const holder = assembly.propertyHolders.get(declared);
    if (holder) {
      for (const domain of domains) {
        if (holder.domains.has(domain)) {
          assembly.issues.push({
            kind: 'utype-conflict',
            fatal: true,
            line,
            message: `EntityDef::calcDefPropertyUType: ${assembly.entityName}.${name}, 'Utype' ${declared} Conflict(${assembly.entityName}.${holder.name} 'Utype' ${declared})!`
          });
        }
      }
      return null;
    }
    assembly.propertyUsedUtypes.add(declared);
    assembly.propertyHolders.set(declared, { name, domains: new Set(domains) });
    return declared;
  }
  while (assembly.propertyUsedUtypes.has(assembly.propertyAutoCounter)) {
    assembly.propertyAutoCounter += 1;
  }
  const utype = assembly.propertyAutoCounter;
  assembly.propertyAutoCounter += 1;
  assembly.propertyUsedUtypes.add(utype);
  assembly.propertyHolders.set(utype, { name, domains: new Set(domains) });
  return utype;
}

/**
 * 组件槽注册(loadComponents L650-820):槽 = 一个三域属性(BASE|CELL_PUBLIC|
 * 客户端位),占属性 utype;组件类型名首见时构造 EntityComponentType 占一个
 * DataType utype(模块缓存语义,重复引用不重占);名字查重沿用 addPropertyDescription。
 * 组件 def 树(独立 ScriptDefModule)不并入实体模块,见模块头边界说明。
 */
/**
 * 组件模块域面(引擎 isComponentModule ScriptDefModule 的 hasX 近似)。
 * autoMatchCompOwn 的脚本文件面(scripts/{base,cell}/components/<name>.py)
 * 纯函数不可见,按 def 段近似:非空属性域/方法段即有对应域。与 Rust
 * message_table.rs analyze_component_module 同构(TS↔Rust 对拍一致)。
 */
interface ComponentModuleFace {
  hasBase: boolean;
  hasCell: boolean;
  hasClient: boolean;
  baseExposed: boolean;
  cellExposed: boolean;
}

function analyzeComponentModule(
  typeName: string,
  source: DefTreeSource,
  visited: Set<string>
): ComponentModuleFace | null {
  if (visited.has(typeName)) {
    return null;
  }
  const local = source.loadDef(typeName, 'component');
  if (!local) {
    return null;
  }
  visited.add(typeName);
  const face: ComponentModuleFace = {
    hasBase: false,
    hasCell: false,
    hasClient: false,
    baseExposed: false,
    cellExposed: false
  };
  for (const property of local.properties) {
    if (property.flags === undefined) {
      continue;
    }
    const bits = PROPERTY_FLAG_BITS[property.flags.trim().toUpperCase()];
    if (bits === undefined) {
      continue;
    }
    if ((bits & ENTITY_BASE_DATA_FLAGS) > 0) {
      face.hasBase = true;
    }
    if ((bits & ENTITY_CELL_DATA_FLAGS) > 0) {
      face.hasCell = true;
    }
    if ((bits & ENTITY_CLIENT_DATA_FLAGS) > 0) {
      face.hasClient = true;
    }
  }
  for (const method of local.methodsBySection.BaseMethods) {
    face.hasBase = true;
    if (method.exposed) {
      face.baseExposed = true;
    }
  }
  for (const method of local.methodsBySection.CellMethods) {
    face.hasCell = true;
    if (method.exposed) {
      face.cellExposed = true;
    }
  }
  for (const _method of local.methodsBySection.ClientMethods) {
    face.hasClient = true;
  }
  for (const iface of local.interfaces) {
    const iv = analyzeComponentModule(iface.name, source, visited);
    if (iv) {
      face.hasBase ||= iv.hasBase;
      face.hasCell ||= iv.hasCell;
      face.hasClient ||= iv.hasClient;
      face.baseExposed ||= iv.baseExposed;
      face.cellExposed ||= iv.cellExposed;
    }
  }
  if (local.parentName) {
    const pv = analyzeComponentModule(local.parentName, source, visited);
    if (pv) {
      face.hasBase ||= pv.hasBase;
      face.hasCell ||= pv.hasCell;
      face.hasClient ||= pv.hasClient;
      face.baseExposed ||= pv.baseExposed;
      face.cellExposed ||= pv.cellExposed;
    }
  }
  // autoMatchCompOwn L322-328 近似:exposed base/cell 方法在最终 hasX 上推 client
  if ((face.hasBase && face.baseExposed) || (face.hasCell && face.cellExposed)) {
    face.hasClient = true;
  }
  return face;
}

/** 引擎 loadComponents L793-808 新载分支:槽 flags 串派生(与 Rust 同构)。 */
function deriveComponentSlotFlags(hasBase: boolean, hasCell: boolean, hasClient: boolean): string {
  const parts: string[] = [];
  if (hasBase) {
    parts.push('BASE');
  }
  if (hasCell) {
    parts.push('CELL_PUBLIC');
  }
  if (hasClient) {
    if (hasBase) {
      parts.push('BASE_AND_CLIENT');
    }
    if (hasCell) {
      parts.push('ENTITY_CLIENT_DATA_FLAGS');
    }
  }
  return parts.join('|');
}

/** 槽域位注册集(引擎 addComponentProperty L864-874:cell→base→client,仅命中域登记)。 */
function slotDomains(
  hasBase: boolean,
  hasCell: boolean,
  hasClient: boolean
): ('cell' | 'base' | 'client')[] {
  const domains: ('cell' | 'base' | 'client')[] = [];
  if (hasCell) {
    domains.push('cell');
  }
  if (hasBase) {
    domains.push('base');
  }
  if (hasClient) {
    domains.push('client');
  }
  return domains;
}

function registerComponentSlot(
  moduleName: string,
  component: DefinitionComponentRef,
  source: DefTreeSource,
  assembly: ModuleAssembly
): void {
  if (LIMITED_PROPERTY_NAMES.has(component.slotName)) {
    assembly.issues.push({
      kind: 'property-name-limited',
      fatal: true,
      line: component.line,
      message: `EntityDef::loadComponents: '${component.slotName}' is limited, in module(${assembly.entityName})!`
    });
    return;
  }

  // 组件 def 域面(缺失/结构错误 → 报 issue + 既有硬编码三域回落,宽容续行
  // 与缺失 parent/interface 同口径;与 Rust register_component_slot 同构)。
  let flags: string;
  let hasClient: boolean;
  let domains: ('cell' | 'base' | 'client')[];
  const face = analyzeComponentModule(component.typeName, source, new Set<string>());
  if (face) {
    flags = deriveComponentSlotFlags(face.hasBase, face.hasCell, face.hasClient);
    hasClient = face.hasClient;
    domains = slotDomains(face.hasBase, face.hasCell, face.hasClient);
  } else {
    assembly.issues.push({
      kind: 'component-def-missing',
      fatal: true,
      line: component.line,
      message: `EntityDef::loadComponents: failed to load component:${component.typeName} (components/${component.typeName}.def).`
    });
    flags = 'BASE|CELL_PUBLIC|ENTITY_CLIENT_DATA_FLAGS';
    hasClient = true;
    domains = ['cell', 'base', 'client'];
  }

  const entry: MessagePropertyEntry = {
    name: component.slotName,
    typeName: component.typeName,
    flags,
    hasClient,
    utype: null,
    declaredUtype: null,
    aliasID: null,
    persistent: component.persistent ?? true,
    origin: originLabel(moduleName, 'own'),
    originKind: 'own',
    line: component.line
  };
  assembly.properties.push(entry);

  if (!assembly.seenComponentTypes.has(component.typeName)) {
    assembly.seenComponentTypes.add(component.typeName);
    assembly.types.push({
      name: component.typeName,
      utype: assembly.nextTypeUtype++,
      kind: 'entity-component',
      aliasedTo: null,
      line: component.line,
      origin: moduleName
    });
  }

  const declared = component.utype !== null && component.utype > 0 ? component.utype : null;
  entry.declaredUtype = declared;
  const utype = allocatePropertyUtype(declared, component.slotName, domains, component.line, assembly);
  if (utype === null) {
    return;
  }
  entry.utype = utype;

  // 引擎顺序:addComponentProperty 逐域 addPropertyDescription,名字三查命中
  // 则该域不登记(逐域独立尝试,失败仅终止本域);随后 addComponentDescription
  // 对 addComponentProperty 返回值不检查、无条件执行(entitydef.cpp L742-746),
  // 故槽名即使名字三查失败也登记进 componentDescr_——后续(父链)方法同名时
  // 报 component 冲突而非 property 冲突
  if (assembly.allMethodNames.has(component.slotName)) {
    assembly.issues.push({
      kind: 'property-method-name-conflict',
      fatal: true,
      line: component.line,
      message: `ScriptDefModule::addPropertyDescription: There is a method[${component.slotName}] name conflict! componentType=${DOMAIN_COMPONENT_TYPE.cell}.`
    });
  } else if (assembly.componentNames.has(component.slotName)) {
    assembly.issues.push({
      kind: 'property-component-name-conflict',
      fatal: true,
      line: component.line,
      message: `ScriptDefModule::addPropertyDescription: There is a component[${component.slotName}] name conflict!`
    });
  } else {
    let registered = false;
    for (const domain of domains) {
      if (assembly.propertyDomains[domain].has(component.slotName)) {
        assembly.issues.push({
          kind: 'property-name-conflict',
          fatal: true,
          line: component.line,
          message: `ScriptDefModule::addPropertyDescription: [${component.slotName}] is exist! componentType=${DOMAIN_COMPONENT_TYPE[domain]}.`
        });
        continue;
      }
      assembly.propertyDomains[domain].add(component.slotName);
      registered = true;
    }
    // 引擎 hasPropertyName 查逐域属性表:仅当至少一域登记成功才算属性名占用
    if (registered) {
      assembly.allPropertyNames.add(component.slotName);
    }
  }
  assembly.componentNames.add(component.slotName);
}

/** common.h L141-147 三域位集:域命中的属性表才会走 addPropertyDescription */
function domainBitsOf(domain: 'cell' | 'base' | 'client'): number {
  if (domain === 'cell') {
    return ENTITY_CELL_DATA_FLAGS;
  }
  return domain === 'base' ? ENTITY_BASE_DATA_FLAGS : ENTITY_CLIENT_DATA_FLAGS;
}

/**
 * 单方法装载模拟(loadDef*Methods):参数序列(Arg 文档序,ARRAY 递归)→
 * utype 分配(显式登记/冲突点名/自动取最小未占用)→ 名字三查(属性名/组件
 * 槽名/同段同名)。任一致命问题该方法不添加(utype/name 不登记)。
 */
function simulateMethod(
  moduleName: string,
  method: DefinitionMethod,
  originKind: 'own' | 'interface' | 'parent',
  assembly: ModuleAssembly
): void {
  const sectionLabel = sectionName(method.section);
  const origin = originLabel(moduleName, originKind);
  const entry: MessageMethodEntry = {
    name: method.name,
    section: method.section,
    direction: method.section === 'ClientMethods'
      ? 'server-to-client'
      : method.exposed ? 'client-to-server' : 'server-internal',
    visibleToClient: method.section === 'ClientMethods' || method.exposed,
    exposed: method.exposed,
    args: [],
    declaredUtype: null,
    utype: null,
    aliasID: null,
    status: 'ok',
    origin,
    originKind,
    line: method.line
  };
  assembly.methods.push(entry);

  let argsOk = true;
  for (const argType of method.argTypes) {
    const argEntry = parseMethodArg(method, argType, origin, assembly);
    entry.args.push(argEntry);
    if (argEntry.utype === null) {
      argsOk = false;
    }
  }
  if (!argsOk) {
    // 引擎:return false,utype 不分配、方法不添加
    entry.status = 'arg-load-failed';
    return;
  }

  // 名字三查(引擎 addXxxMethodDescription,顺序:属性名 → 组件槽名 → 同段同名)
  if (assembly.allPropertyNames.has(method.name)) {
    assembly.issues.push({
      kind: 'method-property-name-conflict',
      fatal: true,
      line: method.line,
      message: `ScriptDefModule::add${sectionLabel}MethodDescription: There is a property[${method.name}] name conflict!`
    });
    entry.status = 'name-conflict';
    return;
  }
  if (assembly.componentNames.has(method.name)) {
    assembly.issues.push({
      kind: 'method-component-name-conflict',
      fatal: true,
      line: method.line,
      message: `ScriptDefModule::add${sectionLabel}MethodDescription: There is a component[${method.name}] name conflict!`
    });
    entry.status = 'name-conflict';
    return;
  }
  if (assembly.methodNamesBySection[method.section].has(method.name)) {
    assembly.issues.push({
      kind: 'method-name-conflict',
      fatal: true,
      line: method.line,
      message: `ScriptDefModule::add${sectionLabel}MethodDescription: [${method.name}] is exist!`
    });
    entry.status = 'name-conflict';
    return;
  }

  const declared = method.utype !== null && method.utype > 0 ? method.utype : null;
  entry.declaredUtype = declared;
  let resolvedUtype: number;
  if (declared !== null) {
    if (declared > METHOD_UTYPE_MAX) {
      assembly.issues.push({
        kind: 'utype-overflow',
        fatal: true,
        line: method.line,
        message: `EntityDef::loadDef${sectionLabel}Methods: 'Utype' has overflowed(${declared} > ${METHOD_UTYPE_MAX}), is ${assembly.entityName}.${method.name}!`
      });
      entry.status = 'utype-overflow';
      return;
    }
    // 引擎先 push 再查:重复也登记(向量可含重复值,Set 语义等价)
    assembly.usedUtypes.add(declared);
    const holder = assembly.holders.get(declared);
    if (holder) {
      assembly.issues.push({
        kind: 'utype-conflict',
        fatal: true,
        line: method.line,
        message: `EntityDef::loadDef${sectionLabel}Methods: ${assembly.entityName}.${method.name}, 'Utype' ${declared} Conflict(${assembly.entityName}.${holder.name} 'Utype' ${declared})!`
      });
      entry.status = 'utype-conflict';
      return;
    }
    resolvedUtype = declared;
  } else {
    // 自动分配:计数器逐次自增跳过已占用(引擎 while 循环语义)
    while (assembly.usedUtypes.has(assembly.autoCounter)) {
      assembly.autoCounter += 1;
    }
    resolvedUtype = assembly.autoCounter;
    assembly.autoCounter += 1;
    assembly.usedUtypes.add(resolvedUtype);
  }
  entry.utype = resolvedUtype;

  assembly.holders.set(resolvedUtype, { name: method.name });
  assembly.methodNamesBySection[method.section].add(method.name);
  assembly.allMethodNames.add(method.name);
}

/**
 * 参数序列解析:直文本查注册表(区分大小写);ARRAY 走 <of> 递归。
 * 引擎报错字面:未知类型 dataType[X] not found;缺 of;of 类型未注册;
 * 嵌套失败 Array is wrong.(逐层)。内联数组类型构造即占号,嵌套级注册
 * _{名}_ArrayType 名。
 */
function parseMethodArg(
  method: DefinitionMethod,
  argType: DefinitionArgType,
  origin: string,
  assembly: ModuleAssembly
): MessageArgEntry {
  const line = method.line;
  const sectionLabel = sectionName(method.section);
  if (argType.name !== 'ARRAY') {
    const utype = lookupType(argType.name, assembly);
    if (utype === null) {
      assembly.issues.push({
        kind: 'unknown-arg-type',
        fatal: true,
        line,
        message: `EntityDef::loadDef${sectionLabel}Methods: dataType[${argType.name}] not found, in ${method.name}!`
      });
    }
    return { name: argType.name, ofType: null, utype, line };
  }

  // ARRAY:内联类型构造即占号(引擎 FixedArrayType 构造函数),
  // 名 {module}_{method} 不注册名;module 取装载实体名(引擎传参口径)
  const inlineName = `${assembly.entityName}_${method.name}`;
  const arrayUtype = assembly.nextTypeUtype++;
  assembly.types.push({
    name: inlineName,
    utype: arrayUtype,
    kind: 'inline-array',
    aliasedTo: null,
    line,
    origin
  });

  const ofType = argType.ofType ?? null;
  if (!ofType) {
    assembly.issues.push({
      kind: 'array-of-missing',
      fatal: true,
      line,
      message: 'FixedArrayType::initialize: not found "of".'
    });
    assembly.issues.push({
      kind: 'unknown-arg-type',
      fatal: true,
      line,
      message: `EntityDef::loadDef${sectionLabel}Methods: dataType[ARRAY] not found, in ${method.name}!`
    });
    return { name: 'ARRAY', ofType: null, utype: null, line };
  }

  const elementEntry = parseArrayOfType(
    method,
    ofType,
    inlineName,
    origin,
    assembly
  );
  if (elementEntry === null) {
    // 顶层统一补:loadDef*Methods 对 initialize 失败的共享报错
    assembly.issues.push({
      kind: 'unknown-arg-type',
      fatal: true,
      line,
      message: `EntityDef::loadDef${sectionLabel}Methods: dataType[ARRAY] not found, in ${method.name}!`
    });
    return { name: 'ARRAY', ofType: null, utype: null, line };
  }
  return {
    name: 'ARRAY',
    ofType: elementEntry,
    utype: arrayUtype,
    line
  };
}

/**
 * ARRAY <of> 递归:of 文本为 ARRAY → 嵌套内联类型(引擎命名
 * _{parent}_ArrayType 并注册名);否则查注册表。只报 initialize 层错误
 * (子先报、父补 Array is wrong.);顶层 loadDef*Methods 的
 * dataType[ARRAY] not found 由 parseMethodArg 统一补。
 */
function parseArrayOfType(
  method: DefinitionMethod,
  ofType: DefinitionArgType,
  parentName: string,
  origin: string,
  assembly: ModuleAssembly
): MessageArgEntry | null {
  const line = method.line;
  if (ofType.name === 'ARRAY') {
    // 嵌套数组:构造即占号(datatypes.cpp L1673-1683),childName 注册名
    const childName = `_${parentName}_ArrayType`;
    const childUtype = assembly.nextTypeUtype++;
    assembly.types.push({
      name: childName,
      utype: childUtype,
      kind: 'inline-array',
      aliasedTo: null,
      line,
      origin
    });
    // 缺内层 <of> 节点:子 initialize 先报 not found "of".(引擎顺序)
    if (!ofType.ofType) {
      assembly.issues.push({
        kind: 'array-of-missing',
        fatal: true,
        line,
        message: 'FixedArrayType::initialize: not found "of".'
      });
    }
    const nested = ofType.ofType
      ? parseArrayOfType(method, ofType.ofType, childName, origin, assembly)
      : null;
    if (nested === null) {
      // 本层 initialize 因子层失败而失败:补 Array is wrong.
      assembly.issues.push({
        kind: 'array-init-failed',
        fatal: true,
        line,
        message: 'FixedArrayType::initialize: Array is wrong.'
      });
      return null;
    }
    return { name: 'ARRAY', ofType: nested, utype: childUtype, line };
  }

  const elementUtype = lookupType(ofType.name, assembly);
  if (elementUtype === null) {
    assembly.issues.push({
      kind: 'array-of-unknown-type',
      fatal: true,
      line,
      message: `FixedArrayType::initialize: key[ARRAY] did not find type[${ofType.name}]!`
    });
    return null;
  }
  return { name: ofType.name, ofType: null, utype: elementUtype, line };
}

/**
 * aliasID 分配(scriptdef_module.cpp onLoaded L116-196,仅 entitydefAliasID
 * 开启):hasClient 属性按名升序从 4 起;ClientMethods(全部已并入模块)按名
 * 升序从 1 起。计数超 255 各自全部回退 -1(无报错静默禁用)。
 */
export function assignAliasIds(assembly: ModuleAssembly, aliasIdEnabled: boolean): void {
  if (!aliasIdEnabled) {
    return;
  }

  const clientProperties = assembly.properties
    .filter(property => property.hasClient)
    .sort((left, right) => compareByName(left.name, right.name));
  assignAliasRange(clientProperties, ALIAS_ID_PROPERTY_BASE);

  const clientMethods = assembly.methods
    .filter(method => method.section === 'ClientMethods')
    .sort((left, right) => compareByName(left.name, right.name));
  assignAliasRange(clientMethods, 1);
}

/** 顺序编号;末号超 255 时引擎静默全部回退 -1(不使用 aliasID,无报错) */
function assignAliasRange(entries: Array<{ aliasID: number | null }>, start: number): void {
  let next = start;
  for (const entry of entries) {
    entry.aliasID = next;
    next += 1;
  }
  if (entries.length > 0 && next - 1 > ALIAS_ID_MAX) {
    for (const entry of entries) {
      entry.aliasID = -1;
    }
  }
}

function compareByName(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sectionName(section: DefMethodSection): string {
  if (section === 'CellMethods') {
    return 'Cell';
  }
  if (section === 'BaseMethods') {
    return 'Base';
  }
  return 'Client';
}

function originLabel(moduleName: string, originKind: 'own' | 'interface' | 'parent'): string {
  if (originKind === 'own') {
    return moduleName;
  }
  return `${moduleName}(${originKind === 'interface' ? '接口' : '父类'})`;
}

function normalizeSourceKey(filePath: string): string {
  return filePath.replace(/\\/g, '/').toLowerCase();
}
