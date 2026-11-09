/**
 * KBEngine 客户端实体 SDK 纯生成逻辑（SRC-012 拆分）。
 *
 * 与 clientSdkGenerator.ts（控制器：类型 + I/O + 命令编排）分离：本模块只含
 * 语言中立模型解析、类型映射与逐语言发射，不触 vscode/fs/工作区。纯函数可
 * 独立单测；hub 经 re-export 保持既有 `from './clientSdkGenerator'` 路径。
 */

import {
  getElementText,
  getDirectChildElement,
  getDirectChildElements,
  getDirectChildElementsByName,
  getScalarChildValue,
  getDirectTextNodes,
  hasTruthyChildTag,
  parseDefDocument
} from '../backend/defParser';
import type { DefElementNode } from '../backend/defParser';
import { propertyFlagDomainList } from '../backend/defAnalyzer';
import type { CustomTypeInfo } from '../definitionWorkspace';
import { getReferenceTargetName, parseDefFileSemantics } from '../backend/defRenamer';
import { formatSdkEngineTraceLines, makeSdkEngineTrace } from './sdkGenerationTrace';
import type { SdkEngineTrace } from './sdkGenerationTrace';
import type {
  ClientSdkArgType,
  ClientSdkComponent,
  ClientSdkComponentDefs,
  ClientSdkEntity,
  ClientSdkFixedDictType,
  ClientSdkLanguage,
  ClientSdkMethod,
  ClientSdkProperty,
  ClientSdkTypeMap
} from './clientSdkGenerator';

/** C# 输出命名空间，Unity 客户端工程可自行改 */
export const CLIENT_SDK_CSHARP_NAMESPACE = 'KbEngineClient';
/** SDK 内置类型映射覆盖的名字集(TS/C# 键并集,IDE-SDK-005 对拍面) */
export function listClientSdkBuiltinTypeNames(): string[] {
  return [...new Set([...Object.keys(TS_BUILTIN_TYPES), ...Object.keys(CS_BUILTIN_TYPES)])]
    .sort((left, right) => left.localeCompare(right));
}
/** FIXED_DICT 伴随文件基名（无扩展名） */
export const CLIENT_SDK_FIXED_DICTS_BASENAME = 'ClientSdkFixedDicts';
/** 组件类型类伴随文件基名（无扩展名；IDE-RUST-006 组件槽 SDK 面） */
export const CLIENT_SDK_COMPONENTS_BASENAME = 'ClientSdkComponents';
/** 引擎内置类型 → TypeScript */
const TS_BUILTIN_TYPES: Record<string, string> = {
  UINT8: 'number',
  UINT16: 'number',
  UINT32: 'number',
  UINT64: 'bigint',
  INT8: 'number',
  INT16: 'number',
  INT32: 'number',
  INT64: 'bigint',
  FLOAT: 'number',
  DOUBLE: 'number',
  STRING: 'string',
  UNICODE: 'string',
  VECTOR2: '[number, number]',
  VECTOR3: '[number, number, number]',
  VECTOR4: '[number, number, number, number]',
  ENTITYCALL: 'unknown',
  PYTHON: 'unknown',
  PY_DICT: 'unknown',
  PY_TUPLE: 'unknown',
  PY_LIST: 'unknown',
  BLOB: 'unknown'
};
/** 引擎内置类型 → C#（向量默认 Vector2/3/4，Unity 自带；非 Unity 工程自行改名） */
const CS_BUILTIN_TYPES: Record<string, string> = {
  UINT8: 'byte',
  UINT16: 'ushort',
  UINT32: 'uint',
  UINT64: 'ulong',
  INT8: 'sbyte',
  INT16: 'short',
  INT32: 'int',
  INT64: 'long',
  FLOAT: 'float',
  DOUBLE: 'double',
  STRING: 'string',
  UNICODE: 'string',
  VECTOR2: 'Vector2',
  VECTOR3: 'Vector3',
  VECTOR4: 'Vector4',
  ENTITYCALL: 'object',
  PYTHON: 'object',
  PY_DICT: 'object',
  PY_TUPLE: 'object',
  PY_LIST: 'object',
  BLOB: 'object'
};
const CLIENT_SDK_TYPE_FALLBACKS: Record<ClientSdkLanguage, string> = {
  typescript: 'unknown',
  csharp: 'object'
};
/** 按引擎 `ARRAY<of>类型</of>` 口径读 `<Type>`：直文本 + 元素类型分两栏。 */
function readDefTypeNode(typeNode: DefElementNode | undefined): { type: string; elementType: string | null } {
  if (!typeNode) {
    return { type: '', elementType: null };
  }

  const type = getDirectTextNodes(typeNode).map(node => node.text).join('').trim();
  const ofNode = getDirectChildElement(typeNode, 'of');
  if (ofNode) {
    return { type, elementType: getElementText(ofNode).trim() || null };
  }

  return { type, elementType: null };
}

function parseDefDocumentSafely(content: string): ReturnType<typeof parseDefDocument> | null {
  try {
    return parseDefDocument(content);
  } catch {
    return null;
  }
}

/** 从 def 内容解析 SDK 生成模型。名字来自 entities.xml/def 文件名，不从内容推断。
 * 组件槽解析依赖 componentDefs（组件 def 原文，闭包收集）；缺 def 的槽跳过
 * （宽容，与 Rust 侧同口径）。 */
export function parseClientSdkEntity(
  content: string,
  name: string,
  componentDefs: ClientSdkComponentDefs = {},
  relatedDefs: ClientSdkComponentDefs = {}
): ClientSdkEntity | null {
  const document = parseDefDocumentSafely(content);
  if (!document || !document.root) {
    return null;
  }
  const root = document.root;
  const parent = parseDefFileSemantics(content)?.parentName ?? null;

  const properties: ClientSdkProperty[] = [];
  for (const propertyNode of getDirectChildElements(getDirectChildElement(root, 'Properties'))) {
    const { type, elementType } = readDefTypeNode(getDirectChildElement(propertyNode, 'Type'));
    const flags = getScalarChildValue(propertyNode, 'Flags') ?? '';
    properties.push({
      name: propertyNode.name,
      type,
      elementType,
      flags,
      domains: propertyFlagDomainList(flags)
    });
  }

  const components: ClientSdkComponent[] = [];
  const componentsNode = getDirectChildElement(root, 'Components');
  for (const slot of getDirectChildElements(componentsNode)) {
    const typeName = readSlotTypeName(slot);
    if (!typeName) {
      continue;
    }
    const slotProperties = parseClientSdkComponentProperties(typeName, componentDefs, new Set());
    if (slotProperties !== null) {
      components.push({ slot: slot.name, typeName, properties: slotProperties });
    }
  }

  const clientMethods = readDefMethods(root, 'ClientMethods', false);
  const exposedBaseMethods = readDefMethods(root, 'BaseMethods', true);
  const exposedCellMethods = readDefMethods(root, 'CellMethods', true);

  // KR-AUD-73:引擎对实体 def 依序装载 Interfaces 与 Parent,并把两者的成员
  // 并入同一模块(entitydef.cpp:371-372 loadInterfaces → loadParentClass)。
  // SDK 骨架镜像合并面:自身成员优先(子覆盖同名成员),Interfaces 先于 Parent,
  // 递归接口/父链;接口 def 不装 Parent(KR-AUD-72,entitydef.cpp:611-638)。
  const seenProperties = new Set(properties.map(property => property.name));
  const seenClientMethods = new Set(clientMethods.map(method => method.name));
  const seenBaseMethods = new Set(exposedBaseMethods.map(method => method.name));
  const seenCellMethods = new Set(exposedCellMethods.map(method => method.name));
  const visited = new Set<string>([name]);

  const mergeFrom = (defName: string, allowParent: boolean, viaParent: boolean): void => {
    if (visited.has(defName)) {
      return;
    }
    visited.add(defName);
    const defText = relatedDefs[defName];
    if (defText === undefined) {
      return;
    }
    const defDocument = parseDefDocumentSafely(defText);
    if (!defDocument?.root) {
      return;
    }
    const defRoot = defDocument.root;

    for (const propertyNode of getDirectChildElements(getDirectChildElement(defRoot, 'Properties'))) {
      if (seenProperties.has(propertyNode.name)) {
        continue;
      }
      seenProperties.add(propertyNode.name);
      const { type, elementType } = readDefTypeNode(getDirectChildElement(propertyNode, 'Type'));
      const flags = getScalarChildValue(propertyNode, 'Flags') ?? '';
      properties.push({
        name: propertyNode.name,
        type,
        elementType,
        flags,
        domains: propertyFlagDomainList(flags),
        inheritedFrom: defName,
        inheritedViaParent: viaParent || undefined
      });
    }

    const mergeMethods = (
      sectionName: string,
      onlyExposed: boolean,
      bucket: ClientSdkMethod[],
      seen: Set<string>
    ): void => {
      for (const method of readDefMethods(defRoot, sectionName, onlyExposed)) {
        if (seen.has(method.name)) {
          continue;
        }
        seen.add(method.name);
        bucket.push({
          ...method,
          inheritedFrom: defName,
          inheritedViaParent: viaParent || undefined
        });
      }
    };
    mergeMethods('ClientMethods', false, clientMethods, seenClientMethods);
    mergeMethods('BaseMethods', true, exposedBaseMethods, seenBaseMethods);
    mergeMethods('CellMethods', true, exposedCellMethods, seenCellMethods);

    // 接口 def 内部继续递归其 Interfaces(引擎 loadInterfaces 再入),
    // 但不递归其 Parent(KR-AUD-72:引擎对接口 def 不调 loadParentClass)
    for (const iface of getDirectChildElements(getDirectChildElement(defRoot, 'Interfaces'))) {
      const refName = getReferenceTargetName(iface);
      if (refName) {
        mergeFrom(refName, false, viaParent);
      }
    }
    if (allowParent) {
      const defParentNode = getDirectChildElement(defRoot, 'Parent');
      const parentRef = defParentNode ? getReferenceTargetName(defParentNode) : '';
      if (parentRef) {
        mergeFrom(parentRef, true, true);
      }
    }
  };

  for (const iface of getDirectChildElements(getDirectChildElement(root, 'Interfaces'))) {
    const refName = getReferenceTargetName(iface);
    if (refName) {
      mergeFrom(refName, false, false);
    }
  }
  if (parent) {
    mergeFrom(parent, true, true);
  }

  return {
    name,
    parent,
    properties,
    components,
    clientMethods,
    exposedBaseMethods,
    exposedCellMethods
  };
}

/** 组件槽的 `<Type>` 目标名：直文本，缺文本回落首个子元素名（Rust slot_type_name 同口径）。 */
function readSlotTypeName(slot: DefElementNode): string {
  const typeNode = getDirectChildElement(slot, 'Type');
  if (!typeNode) {
    return '';
  }
  const text = getDirectTextNodes(typeNode).map(node => node.text).join('').trim();
  if (text) {
    return text;
  }
  return getDirectChildElements(typeNode)[0]?.name ?? '';
}

/** 组件模块客户端可见属性：自身 + 接口 + 父类（components/ 下）递归按名去重
 * （首个即自身优先）；缺失 def 返回 null（调用方跳过该槽/该引用）。 */
function parseClientSdkComponentProperties(
  typeName: string,
  componentDefs: ClientSdkComponentDefs,
  visited: Set<string>
): ClientSdkProperty[] | null {
  const defText = componentDefs[typeName];
  if (defText === undefined) {
    return null;
  }
  const document = parseDefDocumentSafely(defText);
  if (!document?.root) {
    return null;
  }
  visited.add(typeName);
  const out: ClientSdkProperty[] = [];
  const seen = new Set<string>();

  const collectFrom = (def: DefElementNode): void => {
    const propertiesNode = getDirectChildElement(def, 'Properties');
    for (const propertyNode of getDirectChildElements(propertiesNode)) {
      const { type, elementType } = readDefTypeNode(getDirectChildElement(propertyNode, 'Type'));
      const flags = getScalarChildValue(propertyNode, 'Flags') ?? '';
      const domains = propertyFlagDomainList(flags);
      if (domains.includes('client') && !seen.has(propertyNode.name)) {
        seen.add(propertyNode.name);
        out.push({ name: propertyNode.name, type, elementType, flags, domains });
      }
    }
  };
  collectFrom(document.root);

  const interfacesNode = getDirectChildElement(document.root, 'Interfaces');
  for (const iface of getDirectChildElements(interfacesNode)) {
    const refName = getReferenceTargetName(iface);
    if (refName && !visited.has(refName)) {
      const ifaceProps = parseClientSdkComponentProperties(refName, componentDefs, visited);
      if (ifaceProps) {
        for (const property of ifaceProps) {
          if (!seen.has(property.name)) {
            seen.add(property.name);
            out.push(property);
          }
        }
      }
    }
  }
  const parentNode = getDirectChildElement(document.root, 'Parent');
  if (parentNode) {
    const refName = getReferenceTargetName(parentNode);
    if (refName && !visited.has(refName)) {
      const parentProps = parseClientSdkComponentProperties(refName, componentDefs, visited);
      if (parentProps) {
        for (const property of parentProps) {
          if (!seen.has(property.name)) {
            seen.add(property.name);
            out.push(property);
          }
        }
      }
    }
  }
  return out;
}

function readDefMethods(root: DefElementNode, sectionName: string, onlyExposed: boolean): ClientSdkMethod[] {
  const methods: ClientSdkMethod[] = [];
  for (const methodNode of getDirectChildElements(getDirectChildElement(root, sectionName))) {
    if (onlyExposed && !hasTruthyChildTag(methodNode, 'Exposed')) {
      continue;
    }

    methods.push({
      name: methodNode.name,
      // KR-AUD-79:逐 Arg 走 readDefTypeNode——ARRAY 的 <of> 子元素一并收;
      // 空文本 Arg 照旧剔除(与 definitionSemantics 口径一致,保持 1:1)
      argTypes: getDirectChildElementsByName(methodNode, 'Arg')
        .map(argNode => readDefTypeNode(argNode))
        .filter(arg => arg.type !== '')
    });
  }
  return methods;
}

export function isClientVisibleProperty(property: ClientSdkProperty): boolean {
  return property.domains.includes('client');
}

/** 语言中立类型表：内置表逐语言，别名与 FIXED_DICT 与工程 types.xml 同源。 */
export function buildClientSdkTypeMap(
  customTypes: ReadonlyArray<CustomTypeInfo>,
  language: ClientSdkLanguage
): ClientSdkTypeMap {
  const aliases = new Map<string, string>();
  const fixedDicts = new Map<string, ClientSdkFixedDictType>();

  for (const customType of customTypes) {
    aliases.set(customType.name, customType.aliasType);
    if (customType.properties.length > 0) {
      fixedDicts.set(customType.name, {
        name: customType.name,
        sourceLine: customType.line,
        properties: customType.properties.map(property => ({
          name: property.name,
          typeName: property.typeName ?? null,
          sourceLine: property.typeLine ?? property.line
        }))
      });
    }
  }

  return {
    builtin: language === 'typescript' ? TS_BUILTIN_TYPES : CS_BUILTIN_TYPES,
    aliases,
    fixedDicts,
    fallback: CLIENT_SDK_TYPE_FALLBACKS[language]
  };
}

/** 类型名解析：内置 → FIXED_DICT 名字 → 别名递归 → 兜底。 */
export function resolveClientSdkTypeName(
  typeMap: ClientSdkTypeMap,
  type: string,
  elementType: string | null
): string {
  if (elementType) {
    return `${resolveClientSdkTypeName(typeMap, elementType, null)}[]`;
  }

  const builtin = typeMap.builtin[type];
  if (builtin !== undefined) {
    return builtin;
  }

  if (typeMap.fixedDicts.has(type)) {
    return type;
  }

  const alias = typeMap.aliases.get(type);
  if (alias && alias !== type && !typeMap.aliases.has(alias)) {
    return resolveClientSdkTypeName(typeMap, alias, null);
  }

  return typeMap.fallback;
}

function resolvePropertyType(typeMap: ClientSdkTypeMap, property: ClientSdkProperty): string {
  return resolveClientSdkTypeName(typeMap, property.type, property.elementType);
}

/** 无 `<of>` 的裸类型名(FIXED_DICT 字段等)。 */
function resolveNamedType(typeMap: ClientSdkTypeMap, type: string): string {
  return resolveClientSdkTypeName(typeMap, type, null);
}

function resolveArgType(typeMap: ClientSdkTypeMap, arg: ClientSdkArgType): string {
  return resolveClientSdkTypeName(typeMap, arg.type, arg.elementType);
}

function clientVisibleProperties(entity: ClientSdkEntity): ClientSdkProperty[] {
  return entity.properties.filter(isClientVisibleProperty);
}

function usedFixedDictTypes(
  entity: ClientSdkEntity,
  typeMap: ClientSdkTypeMap
): ClientSdkFixedDictType[] {
  const seen = new Set<string>();
  const used: ClientSdkFixedDictType[] = [];

  for (const property of clientVisibleProperties(entity)) {
    const name = property.type;
    if (typeMap.fixedDicts.has(name) && !seen.has(name)) {
      seen.add(name);
      used.push(typeMap.fixedDicts.get(name)!);
    }
  }

  return used;
}

/** 全部实体(属性 + 组件槽属性)引用的 FIXED_DICT 类型,按 types.xml 序去重。
 * 组件属性引用也计入(与 generateClientSdkComponentsFile 的 import 同源),
 * 避免「仅组件属性引用」时 FIXED_DICT 伴随文件缺失导致断裂导入。 */
function collectClientSdkFixedDictTypes(
  entities: ReadonlyArray<ClientSdkEntity>,
  typeMap: ClientSdkTypeMap
): ClientSdkFixedDictType[] {
  const seen = new Set<string>();
  const used: ClientSdkFixedDictType[] = [];
  const add = (typeName: string): void => {
    const type = typeMap.fixedDicts.get(typeName);
    if (type && !seen.has(type.name)) {
      seen.add(type.name);
      used.push(type);
    }
  };
  for (const entity of entities) {
    for (const property of clientVisibleProperties(entity)) {
      add(property.type);
    }
    for (const component of entity.components) {
      for (const property of component.properties) {
        add(property.type);
      }
    }
  }
  return used;
}

function toPascalCase(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** def 的 `<Arg>` 只有类型没有名字，统一给 `arg0/arg1…` 编号。 */
function formatArgTypes(
  typeMap: ClientSdkTypeMap,
  argTypes: readonly ClientSdkArgType[],
  language: ClientSdkLanguage
): string {
  return argTypes
    .map((arg, index) => language === 'typescript'
      ? `_arg${index}: ${resolveArgType(typeMap, arg)}`
      : `${resolveArgType(typeMap, arg)} arg${index}`)
    .join(', ');
}

function formatArgIds(argTypes: readonly ClientSdkArgType[], underscored: boolean): string {
  return argTypes
    .map((_, index) => `${underscored ? '_' : ''}arg${index}`)
    .join(', ');
}

function defHeader(
  language: ClientSdkLanguage,
  generatedAt: string,
  engineTrace?: SdkEngineTrace
): string[] {
  return [
    '// 由 kode 客户端实体 SDK 生成器生成，手动修改会在下次生成时被覆盖',
    `// 目标语言: ${language === 'typescript' ? 'TypeScript' : 'C#'}`,
    `// 生成时间: ${generatedAt}`,
    // IDE-AUD-063:TS 64 位整数表示与编解码边界——UINT64/INT64 用 bigint 保全域精确,
    // 消费方工程需 ES2020+;bigint 不进 JSON.stringify,序列化须走 BigInt 感知通道。
    ...(language === 'typescript'
      ? ['// 64 位整数: UINT64/INT64 → bigint(全精确域);TS 编译目标需 ES2020+;bigint 不进 JSON.stringify,编解码按 BigInt 感知通道实现']
      : []),
    ...formatSdkEngineTraceLines(engineTrace ?? makeSdkEngineTrace(null)),
    ''
  ];
}

function generateTypeScriptEntityFile(
  entity: ClientSdkEntity,
  typeMap: ClientSdkTypeMap,
  generatedAt: string,
  engineTrace?: SdkEngineTrace,
  knownEntities?: ReadonlySet<string>
): string {
  const lines = defHeader('typescript', generatedAt, engineTrace);
  lines.push(`// 实体: ${entity.name}${entity.parent ? ` 父类: ${entity.parent}` : ''}`);
  lines.push('');

  // KR-AUD-73:父实体在同一 SDK 生成集内 → extends(基类成员经继承承载);
  // 否则父链成员平铺(见 parseClientSdkEntity 合并),不 extends 防止断链导入。
  const extendsName = entity.parent !== null && knownEntities?.has(entity.parent)
    ? entity.parent
    : null;
  const declaredHere = (member: { readonly inheritedViaParent?: boolean }): boolean =>
    extendsName === null || member.inheritedViaParent !== true;

  const used = usedFixedDictTypes(entity, typeMap);
  if (used.length > 0) {
    lines.push(`import { ${used.map(type => type.name).join(', ')} } from './${CLIENT_SDK_FIXED_DICTS_BASENAME}';`);
    lines.push('');
  }
  if (entity.components.length > 0) {
    lines.push(`import { ${entity.components.map(component => component.typeName).join(', ')} } from './${CLIENT_SDK_COMPONENTS_BASENAME}';`);
    lines.push('');
  }
  if (extendsName !== null) {
    lines.push(`import { ${extendsName} } from './${extendsName}';`);
    lines.push('');
  }

  lines.push(`export class ${entity.name}${extendsName !== null ? ` extends ${extendsName}` : ''} {`);
  lines.push(`  /** 实体 id（由 baseapp 分配） */`);
  lines.push(`  public readonly entityId: number;`);

  for (const property of clientVisibleProperties(entity)) {
    if (!declaredHere(property)) {
      continue;
    }
    lines.push('');
    lines.push(`  /** Flags: ${property.flags} */`);
    lines.push(`  public ${property.name}: ${resolvePropertyType(typeMap, property)};`);
  }

  for (const component of entity.components) {
    lines.push('');
    lines.push(`  /** 组件槽: ${component.typeName} */`);
    lines.push(`  public ${component.slot}: ${component.typeName};`);
  }

  lines.push('');
  lines.push(`  public constructor(entityId: number) {`);
  lines.push(`    this.entityId = entityId;`);
  lines.push(`  }`);

  for (const method of entity.clientMethods) {
    if (!declaredHere(method)) {
      continue;
    }
    lines.push('');
    lines.push(`  /** ClientMethods 回调: ${method.name}(${method.argTypes.map(type => resolveArgType(typeMap, type)).join(', ')}) */`);
    const args = formatArgTypes(typeMap, method.argTypes, 'typescript');
    lines.push(`  public ${method.name}(${args}): void {`);
    lines.push(`    // TODO: 实现客户端回调`);
    lines.push(`  }`);
  }

  for (const section of [
    { methods: entity.exposedBaseMethods, label: 'Exposed BaseMethods（客户端可请求）', seam: 'onBaseOutgoing' } as const,
    { methods: entity.exposedCellMethods, label: 'Exposed CellMethods（客户端可请求）', seam: 'onCellOutgoing' } as const
  ]) {
    for (const method of section.methods) {
      if (!declaredHere(method)) {
        continue;
      }
      lines.push('');
      lines.push(`  /** ${section.label}: ${method.name} */`);
      const args = formatArgTypes(typeMap, method.argTypes, 'typescript');
      const callArgs = formatArgIds(method.argTypes, true);
      lines.push(`  public ${section.seam === 'onBaseOutgoing' ? 'baseCall' : 'cellCall'}${toPascalCase(method.name)}(${args}): void {`);
      lines.push(`    this.${section.seam}('${method.name}', [${callArgs}]);`);
      lines.push(`  }`);
    }
  }

  lines.push('');
  lines.push(`  /** 发送接缝: 按客户端插件的 base 调用通道实现 */`);
  lines.push(`  protected onBaseOutgoing(_method: string, _args: unknown[]): void {`);
  lines.push(`  }`);
  lines.push(`  /** 发送接缝: 按客户端插件的 cell 调用通道实现 */`);
  lines.push(`  protected onCellOutgoing(_method: string, _args: unknown[]): void {`);
  lines.push(`  }`);
  lines.push('}');
  lines.push('');

  return lines.join('\n');
}

function generateCSharpEntityFile(
  entity: ClientSdkEntity,
  typeMap: ClientSdkTypeMap,
  generatedAt: string,
  engineTrace?: SdkEngineTrace,
  knownEntities?: ReadonlySet<string>
): string {
  const lines = defHeader('csharp', generatedAt, engineTrace);
  lines.push(`namespace ${CLIENT_SDK_CSHARP_NAMESPACE}`);
  lines.push('{');

  // KR-AUD-73:同 TS 口径——父实体在生成集内则走基类列表,继承成员不重复声明。
  const extendsName = entity.parent !== null && knownEntities?.has(entity.parent)
    ? entity.parent
    : null;
  const declaredHere = (member: { readonly inheritedViaParent?: boolean }): boolean =>
    extendsName === null || member.inheritedViaParent !== true;

  const used = usedFixedDictTypes(entity, typeMap);
  lines.push(`  /// <summary>${entity.name} 客户端实体 SDK 骨架${entity.parent ? `（父类 ${entity.parent}）` : ''}${used.length > 0 ? `（固定字典: ${used.map(type => type.name).join(', ')}）` : ''}</summary>`);
  lines.push(`  public class ${entity.name}${extendsName !== null ? ` : ${extendsName}` : ''}`);
  lines.push(`  {`);
  lines.push(`    /// <summary>实体 id（由 baseapp 分配）</summary>`);
  lines.push(`    public long EntityId { get; }`);

  for (const property of clientVisibleProperties(entity)) {
    if (!declaredHere(property)) {
      continue;
    }
    lines.push(`    /// <summary>Flags: ${property.flags}</summary>`);
    lines.push(`    public ${resolvePropertyType(typeMap, property)} ${toPascalCase(property.name)} { get; set; }`);
  }

  for (const component of entity.components) {
    lines.push(`    /// <summary>组件槽: ${component.typeName}</summary>`);
    lines.push(`    public ${component.typeName} ${toPascalCase(component.slot)} { get; set; }`);
  }

  lines.push(`    public ${entity.name}(long entityId)`);
  lines.push(`    {`);
  lines.push(`      EntityId = entityId;`);
  lines.push(`    }`);

  for (const method of entity.clientMethods) {
    if (!declaredHere(method)) {
      continue;
    }
    const args = formatArgTypes(typeMap, method.argTypes, 'csharp');
    lines.push(`    /// <summary>ClientMethods 回调: ${method.name}</summary>`);
    lines.push(`    public virtual void ${toPascalCase(method.name)}(${args})`);
    lines.push(`    {`);
    lines.push(`      // TODO: 实现客户端回调`);
    lines.push(`    }`);
  }

  for (const section of [
    { methods: entity.exposedBaseMethods, prefix: 'BaseCall', seam: 'OnBaseOutgoing' } as const,
    { methods: entity.exposedCellMethods, prefix: 'CellCall', seam: 'OnCellOutgoing' } as const
  ]) {
    for (const method of section.methods) {
      if (!declaredHere(method)) {
        continue;
      }
      const args = formatArgTypes(typeMap, method.argTypes, 'csharp');
      const callArgs = formatArgIds(method.argTypes, false);
      lines.push(`    /// <summary>${section.seam === 'OnBaseOutgoing' ? 'Exposed BaseMethods' : 'Exposed CellMethods'}: ${method.name}</summary>`);
      lines.push(`    public void ${section.prefix}${toPascalCase(method.name)}(${args})`);
      lines.push(`    {`);
      lines.push(`      ${section.seam}("${method.name}", new object[] { ${callArgs} });`);
      lines.push(`    }`);
    }
  }

  lines.push(`    /// <summary>发送接缝: 按客户端插件的 base 调用通道实现</summary>`);
  lines.push(`    protected virtual void OnBaseOutgoing(string method, object[] args)`);
  lines.push(`    {`);
  lines.push(`    }`);
  lines.push(`    /// <summary>发送接缝: 按客户端插件的 cell 调用通道实现</summary>`);
  lines.push(`    protected virtual void OnCellOutgoing(string method, object[] args)`);
  lines.push(`    {`);
  lines.push(`    }`);
  lines.push(`  }`);
  lines.push('}');
  lines.push('');

  return lines.join('\n');
}

export function generateClientSdkEntityFile(
  entity: ClientSdkEntity,
  language: ClientSdkLanguage,
  typeMap: ClientSdkTypeMap,
  generatedAt: string,
  engineTrace?: SdkEngineTrace,
  knownEntities?: ReadonlySet<string>
): string {
  return language === 'typescript'
    ? generateTypeScriptEntityFile(entity, typeMap, generatedAt, engineTrace, knownEntities)
    : generateCSharpEntityFile(entity, typeMap, generatedAt, engineTrace, knownEntities);
}

// ---------------------------------------------------------------------------
// IDE-AUD-062:辅助固定成员与业务成员重名预检。
// 生成器固定输出 entityId / onBaseOutgoing / onCellOutgoing(TS)与
// EntityId / OnBaseOutgoing / OnCellOutgoing(C#),外加 baseCall*/cellCall* 包装;
// 业务属性/组件槽/ClientMethods 回调与这些固定名字撞名时,生成产物含重复成员
// 无法编译(TS 2300/2687/2717)。策略=落盘前提前拒绝并说明原因,绝不静默覆盖。
// ---------------------------------------------------------------------------

/** IDE-AUD-062:单个重名冲突。name=发射后的成员名;sources=各来源说明。 */
export interface ClientSdkMemberConflict {
  readonly entity: string;
  readonly language: ClientSdkLanguage;
  readonly name: string;
  readonly sources: readonly string[];
}

/** IDE-AUD-062:生成前预检拒绝,消息指明冲突实体、语言、成员与全部来源。 */
export class ClientSdkMemberConflictError extends Error {
  constructor(conflicts: readonly ClientSdkMemberConflict[]) {
    super(formatClientSdkMemberConflictMessage(conflicts));
    this.name = 'ClientSdkMemberConflictError';
  }
}

/** 收集单实体在目标语言下全部发射成员(辅助固定 + 业务)。成员名→来源说明。 */
function collectEmittedClientSdkMembers(
  entity: ClientSdkEntity,
  language: ClientSdkLanguage
): Map<string, string[]> {
  const members = new Map<string, string[]>();
  const add = (name: string, source: string) => {
    const list = members.get(name);
    if (list) {
      list.push(source);
    } else {
      members.set(name, [source]);
    }
  };

  if (language === 'typescript') {
    add('entityId', '辅助字段 entityId（实体 id）');
    add('onBaseOutgoing', '辅助方法 onBaseOutgoing（发送接缝）');
    add('onCellOutgoing', '辅助方法 onCellOutgoing（发送接缝）');
  } else {
    add('EntityId', '辅助字段 EntityId（实体 id）');
    add('OnBaseOutgoing', '辅助方法 OnBaseOutgoing（发送接缝）');
    add('OnCellOutgoing', '辅助方法 OnCellOutgoing（发送接缝）');
  }

  for (const property of clientVisibleProperties(entity)) {
    const name = language === 'typescript' ? property.name : toPascalCase(property.name);
    add(name, `业务属性 ${property.name}`);
  }
  for (const component of entity.components) {
    const name = language === 'typescript' ? component.slot : toPascalCase(component.slot);
    add(name, `组件槽 ${component.slot}`);
  }
  for (const method of entity.clientMethods) {
    const name = language === 'typescript' ? method.name : toPascalCase(method.name);
    add(name, `ClientMethods 回调 ${method.name}`);
  }
  for (const method of entity.exposedBaseMethods) {
    const name = language === 'typescript'
      ? `baseCall${toPascalCase(method.name)}`
      : `BaseCall${toPascalCase(method.name)}`;
    add(name, `Exposed BaseMethods 包装 ${method.name}`);
  }
  for (const method of entity.exposedCellMethods) {
    const name = language === 'typescript'
      ? `cellCall${toPascalCase(method.name)}`
      : `CellCall${toPascalCase(method.name)}`;
    add(name, `Exposed CellMethods 包装 ${method.name}`);
  }

  return members;
}

/** 检查实体组在各目标语言下发射成员的重名。空=可安全生成;非空=必须提前拒绝。 */
export function findClientSdkMemberConflicts(
  entities: ReadonlyArray<ClientSdkEntity>,
  languages: ReadonlyArray<ClientSdkLanguage>
): ClientSdkMemberConflict[] {
  const conflicts: ClientSdkMemberConflict[] = [];
  for (const entity of entities) {
    for (const language of languages) {
      for (const [name, sources] of collectEmittedClientSdkMembers(entity, language)) {
        if (sources.length > 1) {
          conflicts.push({ entity: entity.name, language, name, sources });
        }
      }
    }
  }
  return conflicts;
}

export function formatClientSdkMemberConflictMessage(
  conflicts: readonly ClientSdkMemberConflict[]
): string {
  const lines = conflicts.map(conflict => {
    const lang = conflict.language === 'typescript' ? 'TypeScript' : 'C#';
    return `实体 ${conflict.entity} 的 ${lang} SDK 成员 "${conflict.name}" 由 ${conflict.sources.length} 个来源生成：${conflict.sources.join('、')}`;
  });
  return [
    '客户端实体 SDK 生成已拒绝：辅助成员与业务成员重名。',
    ...lines,
    '请重命名业务成员或调整 SDK 配置后重试。'
  ].join('\n');
}

export function generateClientSdkFixedDictsFile(
  entities: ReadonlyArray<ClientSdkEntity>,
  language: ClientSdkLanguage,
  typeMap: ClientSdkTypeMap,
  generatedAt: string,
  engineTrace?: SdkEngineTrace
): string | null {
  const used = collectClientSdkFixedDictTypes(entities, typeMap);

  if (used.length === 0) {
    return null;
  }

  const lines = defHeader(language, generatedAt, engineTrace);

  if (language === 'typescript') {
    for (const type of used) {
      lines.push(`/** source: types.xml:${type.sourceLine ?? 'unknown'} */`);
      lines.push(`/** ${type.name} FIXED_DICT 别名 */`);
      lines.push(`export interface ${type.name} {`);
      for (const property of type.properties) {
        lines.push(`  /** source: types.xml:${property.sourceLine ?? 'unknown'} */`);
        lines.push(`  ${property.name}: ${property.typeName ? resolveNamedType(typeMap, property.typeName) : 'unknown'};`);
      }
      lines.push('}');
      lines.push('');
    }
  } else {
    lines.push(`namespace ${CLIENT_SDK_CSHARP_NAMESPACE}`);
    lines.push('{');
    for (const type of used) {
      lines.push(`  // source: types.xml:${type.sourceLine ?? 'unknown'}`);
      lines.push(`  /// <summary>${type.name} FIXED_DICT 别名</summary>`);
      lines.push(`  public class ${type.name}`);
      lines.push(`  {`);
      for (const property of type.properties) {
        lines.push(`    // source: types.xml:${property.sourceLine ?? 'unknown'}`);
        lines.push(`    public ${property.typeName ? resolveNamedType(typeMap, property.typeName) : 'object'} ${toPascalCase(property.name)} { get; set; }`);
      }
      lines.push(`  }`);
    }
    lines.push('}');
    lines.push('');
  }

  return lines.join('\n');
}

/** 组件类型类伴随文件（逐语言；引用为空 → null 不产文件）。
 * 与 FIXED_DICT 伴随同模式：每组件类型一 class（客户端可见属性）。 */
export function generateClientSdkComponentsFile(
  entities: ReadonlyArray<ClientSdkEntity>,
  language: ClientSdkLanguage,
  typeMap: ClientSdkTypeMap,
  generatedAt: string,
  engineTrace?: SdkEngineTrace
): string | null {
  const seen = new Set<string>();
  const used: ClientSdkComponent[] = [];
  for (const entity of entities) {
    for (const component of entity.components) {
      if (!seen.has(component.typeName)) {
        seen.add(component.typeName);
        used.push(component);
      }
    }
  }
  if (used.length === 0) {
    return null;
  }

  const lines = defHeader(language, generatedAt, engineTrace);

  if (language === 'typescript') {
    const dictSeen = new Set<string>();
    const fixedNames: string[] = [];
    for (const component of used) {
      for (const property of component.properties) {
        const dict = typeMap.fixedDicts.get(property.type);
        if (dict && !dictSeen.has(dict.name)) {
          dictSeen.add(dict.name);
          fixedNames.push(dict.name);
        }
      }
    }
    if (fixedNames.length > 0) {
      lines.push(`import { ${fixedNames.join(', ')} } from './${CLIENT_SDK_FIXED_DICTS_BASENAME}';`);
      lines.push('');
    }
    for (const component of used) {
      lines.push(`/** 实体组件: ${component.typeName} */`);
      lines.push(`export class ${component.typeName} {`);
      for (const property of component.properties) {
        lines.push(`  /** Flags: ${property.flags} */`);
        lines.push(`  public ${property.name}: ${resolvePropertyType(typeMap, property)};`);
      }
      lines.push('}');
      lines.push('');
    }
  } else {
    lines.push(`namespace ${CLIENT_SDK_CSHARP_NAMESPACE}`);
    lines.push('{');
    for (const component of used) {
      lines.push(`  /// <summary>实体组件: ${component.typeName}</summary>`);
      lines.push(`  public class ${component.typeName}`);
      lines.push('  {');
      for (const property of component.properties) {
        lines.push(`    /// <summary>Flags: ${property.flags}</summary>`);
        lines.push(`    public ${resolvePropertyType(typeMap, property)} ${toPascalCase(property.name)} { get; set; }`);
      }
      lines.push('  }');
    }
    lines.push('}');
    lines.push('');
  }

  return lines.join('\n');
}
