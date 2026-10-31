/**
 * KBEngine 客户端实体 SDK 生成器（盘点 G4，已代决）
 *
 * 语言清单是需求取舍项，按用户 2026-10-16 的代决授权定首批两种目标：
 * TypeScript（js 客户端/Web/Cocos 系）与 C#（Unity 系）——经典 KBEngine 的
 * 两个主流客户端生态。GDScript/C++ 留后续增量：语言中立模型与逐语言发射器
 * 已分离，新增语言只补一个映射表加一个发射函数。
 *
 * 生成面严格收在 def 已有语义内，不发明客户端插件 API：
 * - 属性只收 Flags 含客户端域（defAnalyzer 的三域位表同源）的项，成为可写字段
 * - ClientMethods 成为虚位回调（客户端插件派发），Exposed 的 Base/Cell 方法
 *   成为包装调用，实际发送只落 `onBaseOutgoing`/`onCellOutgoing` 两个接缝
 * - 类型表取引擎注册表（kbengineMetadata 同源 17 个内置类型），引擎未注册的
 *   BOOL 等幻影类型不给映射，靠 defAnalyzer 现有诊断拦
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  getElementText,
  getDirectChildElement,
  getDirectChildElements,
  getScalarChildValue,
  getScalarChildValues,
  getDirectTextNodes,
  hasTruthyChildTag,
  parseDefDocument
} from './defParser';
import type { DefElementNode } from './defParser';
import { propertyFlagDomainList } from './defAnalyzer';
import type { PropertyFlagDomain } from './defAnalyzer';
import {
  getCustomTypeInfos,
  getDefinitionWorkspaceLayout,
  getRegisteredEntities,
  readWorkspaceTextFile
} from './definitionWorkspace';
import type { CustomTypeInfo } from './definitionWorkspace';
import { getReferenceTargetName, parseDefFileSemantics } from './defRenamer';
import { getKodeCoreShadowGate } from './kodeCoreShadowFaces';
import { formatSdkEngineTraceLines, makeSdkEngineTrace } from './sdkGenerationTrace';
import type { SdkEngineTrace } from './sdkGenerationTrace';

/** 首批目标语言（已代决，用户可推翻后增删） */
export const CLIENT_SDK_LANGUAGES = ['typescript', 'csharp'] as const;
export type ClientSdkLanguage = typeof CLIENT_SDK_LANGUAGES[number];

/** 配置段：kbengine.clientSdk.outputDir */
export const CLIENT_SDK_OUTPUT_DIR_KEY = 'clientSdk.outputDir';
export const CLIENT_SDK_DEFAULT_OUTPUT_DIR = 'scripts/client_entities';
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

export const CLIENT_SDK_LANGUAGE_EXTENSIONS: Record<ClientSdkLanguage, string> = {
  typescript: 'ts',
  csharp: 'cs'
};

/** 引擎内置类型 → TypeScript */
const TS_BUILTIN_TYPES: Record<string, string> = {
  UINT8: 'number',
  UINT16: 'number',
  UINT32: 'number',
  UINT64: 'number',
  INT8: 'number',
  INT16: 'number',
  INT32: 'number',
  INT64: 'number',
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

export interface ClientSdkProperty {
  readonly name: string;
  /** `<Type>` 直文本；ARRAY 为 `ARRAY` */
  readonly type: string;
  /** ARRAY 的 `<of>` 文本；非容器为 null */
  readonly elementType: string | null;
  readonly flags: string;
  readonly domains: PropertyFlagDomain[];
}

export interface ClientSdkMethod {
  readonly name: string;
  /** def 的 `<Arg>` 只有类型、没有名字 */
  readonly argTypes: string[];
}

export interface ClientSdkEntity {
  readonly name: string;
  /** def 的 `<Parent>` 目标名；无继承为 null */
  readonly parent: string | null;
  readonly properties: ReadonlyArray<ClientSdkProperty>;
  /** 组件槽（IDE-RUST-006）：slot 成员 + 组件类型类（客户端可见属性） */
  readonly components: ReadonlyArray<ClientSdkComponent>;
  readonly clientMethods: ReadonlyArray<ClientSdkMethod>;
  readonly exposedBaseMethods: ReadonlyArray<ClientSdkMethod>;
  readonly exposedCellMethods: ReadonlyArray<ClientSdkMethod>;
}

/** 实体组件槽：槽名 + 组件类型 + 组件模块客户端可见属性（递归含接口/父类）。 */
export interface ClientSdkComponent {
  readonly slot: string;
  readonly typeName: string;
  readonly properties: ReadonlyArray<ClientSdkProperty>;
}

/** Rust `$/kode/sdk/generate` 的 defs map：组件/接口名 → def 原文（闭包收集）。 */
export type ClientSdkComponentDefs = Readonly<Record<string, string>>;

export interface ClientSdkFixedDictProperty {
  readonly name: string;
  readonly typeName: string | null;
  /** 属性标签在 types.xml 的声明行(1 起);合成模型为 null */
  readonly sourceLine: number | null;
}

export interface ClientSdkFixedDictType {
  readonly name: string;
  readonly properties: ReadonlyArray<ClientSdkFixedDictProperty>;
  /** 类型节点在 types.xml 的声明行(1 起);合成模型为 null */
  readonly sourceLine: number | null;
}

export interface ClientSdkTypeMap {
  readonly builtin: Readonly<Record<string, string>>;
  readonly aliases: ReadonlyMap<string, string>;
  readonly fixedDicts: ReadonlyMap<string, ClientSdkFixedDictType>;
  readonly fallback: string;
}

export interface ClientSdkGenerationOptions {
  readonly languages: ReadonlyArray<ClientSdkLanguage>;
  /** 输出目录，可相对工作区根 */
  readonly outputDir: string;
  readonly overwrite: boolean;
  readonly generatedAt?: string;
  /** 引擎溯源(IDE-SDK-004):生成文件头部记录版本与提交;缺省写 unknown */
  readonly engineTrace?: SdkEngineTrace;
}

export interface ClientSdkGeneratedFile {
  readonly path: string;
  readonly kind: 'entity' | 'fixedDicts' | 'components';
  readonly language: ClientSdkLanguage;
  readonly entityName: string | null;
  readonly written: boolean;
}

export interface ClientSdkGenerationResult {
  readonly files: ReadonlyArray<ClientSdkGeneratedFile>;
  readonly entities: ReadonlyArray<ClientSdkEntity>;
  readonly skipped: number;
}

interface ClientSdkLanguagePickItem extends vscode.QuickPickItem {
  readonly value: ClientSdkLanguage;
}

interface ClientSdkOverwritePickItem extends vscode.QuickPickItem {
  readonly value: 'skip' | 'overwrite';
}

export const CLIENT_SDK_LANGUAGE_CHOICES: ReadonlyArray<ClientSdkLanguagePickItem> = [
  { label: 'TypeScript', value: 'typescript' },
  { label: 'C#', value: 'csharp' }
];

export const CLIENT_SDK_OVERWRITE_CHOICES: ReadonlyArray<ClientSdkOverwritePickItem> = [
  { label: '跳过已存在', value: 'skip' },
  { label: '覆盖已存在', value: 'overwrite' }
];

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
  componentDefs: ClientSdkComponentDefs = {}
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
  return {
    name,
    parent,
    properties,
    components,
    clientMethods,
    exposedBaseMethods: readDefMethods(root, 'BaseMethods', true),
    exposedCellMethods: readDefMethods(root, 'CellMethods', true)
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
      argTypes: getScalarChildValues(methodNode, 'Arg')
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

function resolveArgType(typeMap: ClientSdkTypeMap, type: string): string {
  return resolveClientSdkTypeName(typeMap, type, null);
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

function toPascalCase(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** def 的 `<Arg>` 只有类型没有名字，统一给 `arg0/arg1…` 编号。 */
function formatArgTypes(
  typeMap: ClientSdkTypeMap,
  argTypes: string[],
  language: ClientSdkLanguage
): string {
  return argTypes
    .map((type, index) => language === 'typescript'
      ? `_arg${index}: ${resolveArgType(typeMap, type)}`
      : `${resolveArgType(typeMap, type)} arg${index}`)
    .join(', ');
}

function formatArgIds(argTypes: string[], underscored: boolean): string {
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
    ...formatSdkEngineTraceLines(engineTrace ?? makeSdkEngineTrace(null)),
    ''
  ];
}

function generateTypeScriptEntityFile(
  entity: ClientSdkEntity,
  typeMap: ClientSdkTypeMap,
  generatedAt: string,
  engineTrace?: SdkEngineTrace
): string {
  const lines = defHeader('typescript', generatedAt, engineTrace);
  lines.push(`// 实体: ${entity.name}${entity.parent ? ` 父类: ${entity.parent}` : ''}`);
  lines.push('');

  const used = usedFixedDictTypes(entity, typeMap);
  if (used.length > 0) {
    lines.push(`import { ${used.map(type => type.name).join(', ')} } from './${CLIENT_SDK_FIXED_DICTS_BASENAME}';`);
    lines.push('');
  }
  if (entity.components.length > 0) {
    lines.push(`import { ${entity.components.map(component => component.typeName).join(', ')} } from './${CLIENT_SDK_COMPONENTS_BASENAME}';`);
    lines.push('');
  }

  lines.push(`export class ${entity.name} {`);
  lines.push(`  /** 实体 id（由 baseapp 分配） */`);
  lines.push(`  public readonly entityId: number;`);

  for (const property of clientVisibleProperties(entity)) {
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
  engineTrace?: SdkEngineTrace
): string {
  const lines = defHeader('csharp', generatedAt, engineTrace);
  lines.push(`namespace ${CLIENT_SDK_CSHARP_NAMESPACE}`);
  lines.push('{');

  const used = usedFixedDictTypes(entity, typeMap);
  lines.push(`  /// <summary>${entity.name} 客户端实体 SDK 骨架${entity.parent ? `（父类 ${entity.parent}）` : ''}${used.length > 0 ? `（固定字典: ${used.map(type => type.name).join(', ')}）` : ''}</summary>`);
  lines.push(`  public class ${entity.name}`);
  lines.push(`  {`);
  lines.push(`    /// <summary>实体 id（由 baseapp 分配）</summary>`);
  lines.push(`    public long EntityId { get; }`);

  for (const property of clientVisibleProperties(entity)) {
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
  engineTrace?: SdkEngineTrace
): string {
  return language === 'typescript'
    ? generateTypeScriptEntityFile(entity, typeMap, generatedAt, engineTrace)
    : generateCSharpEntityFile(entity, typeMap, generatedAt, engineTrace);
}

export function generateClientSdkFixedDictsFile(
  entities: ReadonlyArray<ClientSdkEntity>,
  language: ClientSdkLanguage,
  typeMap: ClientSdkTypeMap,
  generatedAt: string,
  engineTrace?: SdkEngineTrace
): string | null {
  const seen = new Set<string>();
  const used: ClientSdkFixedDictType[] = [];
  for (const entity of entities) {
    for (const property of clientVisibleProperties(entity)) {
      const type = typeMap.fixedDicts.get(property.type);
      if (type && !seen.has(type.name)) {
        seen.add(type.name);
        used.push(type);
      }
    }
  }

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
        lines.push(`  ${property.name}: ${property.typeName ? resolveArgType(typeMap, property.typeName) : 'unknown'};`);
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
        lines.push(`    public ${property.typeName ? resolveArgType(typeMap, property.typeName) : 'object'} ${toPascalCase(property.name)} { get; set; }`);
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

/** 按 entities.xml 登记序收集实体，缺 def 文件的登记项跳过。 */
export function collectClientSdkEntities(workspaceRoot: string): ClientSdkEntity[] {
  const sources = collectClientSdkEntitySources(workspaceRoot);
  const componentDefs = collectClientSdkComponentDefs(workspaceRoot, sources);
  const entities: ClientSdkEntity[] = [];

  for (const source of sources) {
    const entity = parseClientSdkEntity(source.defText, source.name, componentDefs);
    if (entity) {
      entities.push(entity);
    }
  }

  return entities;
}

function findClientSdkDefPath(workspaceRoot: string, entityName: string): string | null {
  const layout = getDefinitionWorkspaceLayout(workspaceRoot);
  // 不可达(与 defAnalyzer 批64 同因):候选列表首项恒为已解析的非空相对路径,
  // entityDefsRoot 只能是字符串,空值臂无触发路径。
  /* istanbul ignore start */
  if (!layout.entityDefsRoot) {
    return null;
  }
  /* istanbul ignore stop */

  const defPath = path.join(layout.entityDefsRoot, `${entityName}.def`);
  return fs.existsSync(defPath) ? defPath : null;
}

function writeClientSdkFile(
  descriptor: Omit<ClientSdkGeneratedFile, 'written'>,
  contentOf: () => string,
  options: Pick<ClientSdkGenerationOptions, 'overwrite'>
): ClientSdkGeneratedFile {
  if (fs.existsSync(descriptor.path) && !options.overwrite) {
    return { ...descriptor, written: false };
  }

  fs.mkdirSync(path.dirname(descriptor.path), { recursive: true });
  fs.writeFileSync(descriptor.path, contentOf(), 'utf8');
  return { ...descriptor, written: true };
}

/** Rust 核心的 RPC 入参:每个实体的原始 def 文本(名称按 entities.xml 登记序)。 */
interface ClientSdkEntitySource {
  readonly name: string;
  readonly defText: string;
}

/** Rust `$/kode/sdk/generate` 返回的单个生成文件。 */
interface ClientSdkRustFile {
  readonly fileName: string;
  readonly content: string;
}

/** 按 entities.xml 登记序收集实体原始 def 文本,缺 def 文件的登记项跳过。
 * 与 collectClientSdkEntities 同序,但保留原始文本供 Rust 核心消费。 */
function collectClientSdkEntitySources(workspaceRoot: string): ClientSdkEntitySource[] {
  const sources: ClientSdkEntitySource[] = [];
  for (const info of getRegisteredEntities(workspaceRoot)) {
    const defPath = findClientSdkDefPath(workspaceRoot, info.name);
    if (!defPath) {
      continue;
    }
    sources.push({ name: info.name, defText: readWorkspaceTextFile(defPath) });
  }
  return sources;
}

/** 组件 def 闭包收集(IDE-RUST-006):实体 `<Components>` 槽出发,组件 def 自身 +
 * 其 Interfaces(interface 类)+ Parent(组件类)递归;Rust 侧组件模块域面与 SDK
 * 组件可见性都按名查这份 defs。缺失 def 不收集(调用方跳过/报 issue)。 */
function collectClientSdkComponentDefs(
  workspaceRoot: string,
  entitySources: ReadonlyArray<ClientSdkEntitySource>
): ClientSdkComponentDefs {
  const layout = getDefinitionWorkspaceLayout(workspaceRoot);
  const defs: Record<string, string> = {};
  const queue: string[] = [];
  const enqueued = new Set<string>();
  const enqueue = (name: string): void => {
    if (name && !enqueued.has(name)) {
      enqueued.add(name);
      queue.push(name);
    }
  };
  const visit = (name: string): void => {
    if (defs[name] !== undefined) {
      return;
    }
    // 组件优先 components/,接口回落 interfaces/(两目录同名属畸形工程,取组件)
    const componentPath = layout.componentsRoot
      ? path.join(layout.componentsRoot, `${name}.def`)
      : null;
    const interfacePath = layout.interfacesRoot
      ? path.join(layout.interfacesRoot, `${name}.def`)
      : null;
    const defPath = componentPath && fs.existsSync(componentPath)
      ? componentPath
      : interfacePath && fs.existsSync(interfacePath)
        ? interfacePath
        : null;
    if (!defPath) {
      return;
    }
    const content = readWorkspaceTextFile(defPath);
    defs[name] = content;
    const semantics = parseDefFileSemantics(content);
    for (const iface of semantics?.interfaceNames ?? []) {
      enqueue(iface);
    }
    if (semantics?.parentName) {
      enqueue(semantics.parentName);
    }
    for (const typeName of semantics?.componentTypeNames ?? []) {
      enqueue(typeName);
    }
  };
  for (const source of entitySources) {
    const semantics = parseDefFileSemantics(source.defText);
    for (const typeName of semantics?.componentTypeNames ?? []) {
      enqueue(typeName);
    }
  }
  while (queue.length > 0) {
    visit(queue.shift()!);
  }
  return defs;
}

/** 读 types.xml 原始文本(无该文件时返回空串,Rust 侧等价于空类型表)。 */
function readTypesXmlText(workspaceRoot: string): string {
  const layout = getDefinitionWorkspaceLayout(workspaceRoot);
  return layout.typesXmlPath ? readWorkspaceTextFile(layout.typesXmlPath) : '';
}

/** 把 Rust 返回的文件名还原成写盘描述符(实体名 = 去扩展名基名,固定字典/
 * 组件伴随 = 基名匹配)。 */
function describeRustGeneratedFile(
  fileName: string,
  filePath: string,
  language: ClientSdkLanguage
): Omit<ClientSdkGeneratedFile, 'written'> {
  const extension = CLIENT_SDK_LANGUAGE_EXTENSIONS[language];
  const fixedDictsName = `${CLIENT_SDK_FIXED_DICTS_BASENAME}.${extension}`;
  if (fileName === fixedDictsName) {
    return { path: filePath, kind: 'fixedDicts', language, entityName: null };
  }
  const componentsName = `${CLIENT_SDK_COMPONENTS_BASENAME}.${extension}`;
  if (fileName === componentsName) {
    return { path: filePath, kind: 'components', language, entityName: null };
  }
  const entityName = fileName.slice(0, fileName.length - extension.length - 1);
  return { path: filePath, kind: 'entity', language, entityName };
}

/** 主路径:Rust 核心生成(单一来源)。Rust 不可用(无 gate/无 serverPath/调用失败)
 * 返回 null,由调用方回落到 TS 纯实现。 */
async function generateClientSdkInRust(
  root: string,
  options: ClientSdkGenerationOptions,
  generatedAt: string,
  outputDir: string
): Promise<ClientSdkGenerationResult | null> {
  const gate = getKodeCoreShadowGate();
  if (!gate) {
    return null;
  }

  const entitySources = collectClientSdkEntitySources(root);
  if (entitySources.length === 0) {
    // 与 TS 路径同口径:无登记实体时不产出任何文件。
    return { files: [], entities: [], skipped: 0 };
  }

  const typesXml = readTypesXmlText(root);
  const componentDefs = collectClientSdkComponentDefs(root, entitySources);
  const files: ClientSdkGeneratedFile[] = [];

  for (const language of options.languages) {
    const response = await gate.runInRust<ClientSdkRustFile[]>('$/kode/sdk/generate', {
      language,
      entities: entitySources,
      defs: componentDefs,
      typesXml,
      generatedAt,
      engineTrace: options.engineTrace,
      namespace: CLIENT_SDK_CSHARP_NAMESPACE
    });
    if (!response.ok) {
      return null;
    }
    for (const item of response.result) {
      const filePath = path.join(outputDir, item.fileName);
      files.push(
        writeClientSdkFile(
          describeRustGeneratedFile(item.fileName, filePath, language),
          () => item.content,
          options
        )
      );
    }
  }

  return { files, entities: [], skipped: files.filter(file => !file.written).length };
}

/** 兜底:原 TS 纯生产器。仅在主路径(Rust 核心)不可用时执行。 */
function generateClientSdkEntitiesFallback(
  options: ClientSdkGenerationOptions,
  root: string,
  generatedAt: string,
  outputDir: string
): ClientSdkGenerationResult {
  const entities = collectClientSdkEntities(root);
  const customTypes = getCustomTypeInfos(root);
  const files: ClientSdkGeneratedFile[] = [];

  for (const language of options.languages) {
    const typeMap = buildClientSdkTypeMap(customTypes, language);
    const extension = CLIENT_SDK_LANGUAGE_EXTENSIONS[language];

    for (const entity of entities) {
      const filePath = path.join(outputDir, `${entity.name}.${extension}`);
      files.push(
        writeClientSdkFile(
          { path: filePath, kind: 'entity', language, entityName: entity.name },
          () => generateClientSdkEntityFile(entity, language, typeMap, generatedAt, options.engineTrace),
          options
        )
      );
    }

    const fixedDictsContent = generateClientSdkFixedDictsFile(
      entities, language, typeMap, generatedAt, options.engineTrace
    );
    if (fixedDictsContent !== null) {
      const filePath = path.join(outputDir, `${CLIENT_SDK_FIXED_DICTS_BASENAME}.${extension}`);
      files.push(
        writeClientSdkFile(
          { path: filePath, kind: 'fixedDicts', language, entityName: null },
          () => fixedDictsContent,
          options
        )
      );
    }

    const componentsContent = generateClientSdkComponentsFile(
      entities, language, typeMap, generatedAt, options.engineTrace
    );
    if (componentsContent !== null) {
      const filePath = path.join(outputDir, `${CLIENT_SDK_COMPONENTS_BASENAME}.${extension}`);
      files.push(
        writeClientSdkFile(
          { path: filePath, kind: 'components', language, entityName: null },
          () => componentsContent,
          options
        )
      );
    }
  }

  return { files, entities, skipped: files.filter(file => !file.written).length };
}

export async function generateClientSdkEntities(
  options: ClientSdkGenerationOptions,
  workspaceRoot?: string
): Promise<ClientSdkGenerationResult> {
  const root = workspaceRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    return { files: [], entities: [], skipped: 0 };
  }

  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const outputDir = path.isAbsolute(options.outputDir)
    ? options.outputDir
    : path.join(root, options.outputDir);

  // 主路径:Rust 生成核心;不可用时回落到 TS 纯实现。
  const rustResult = await generateClientSdkInRust(root, options, generatedAt, outputDir);
  if (rustResult !== null) {
    return rustResult;
  }
  return generateClientSdkEntitiesFallback(options, root, generatedAt, outputDir);
}

  /** 命令编排：选语言 → 定输出目录 → 定覆盖策略 → 落盘 → 通知。任一步取消即无副作用返回。
   * IDE-SDK-003：profileRoot=活动 profile 资产根——实体注册序与类型数据
   * 全部取自该根（generateClientSdkEntities 的注册/类型读取都吃该根），
   * 不回落工作区根；skippedSameNameFromOtherRoots=其他根同名实体拒收
   * 点名（装配侧经 bindSdkGenerationToProfile 算出，非空时通知点名，
   * 不静默吞掉跨根歧义）。 */
export async function runClientSdkGenerateCommand(
  profileRoot?: string,
  skippedSameNameFromOtherRoots?: string[],
  engineTrace?: SdkEngineTrace
): Promise<void> {
  const workspaceRoot = profileRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    vscode.window.showErrorMessage('没有打开的工作区');
    return;
  }

  const languages = await vscode.window.showQuickPick<ClientSdkLanguagePickItem>(CLIENT_SDK_LANGUAGE_CHOICES, {
    canPickMany: true,
    placeHolder: '选择目标语言（可多选）'
  });
  if (!languages || languages.length === 0) {
    return;
  }

  const config = vscode.workspace.getConfiguration('kbengine');
  const outputDir = await vscode.window.showInputBox({
    prompt: '客户端实体 SDK 输出目录（相对生成根）',
    value: config.get<string>(CLIENT_SDK_OUTPUT_DIR_KEY, CLIENT_SDK_DEFAULT_OUTPUT_DIR)
  });
  if (outputDir === undefined) {
    return;
  }

  const overwriteChoice = await vscode.window.showQuickPick<ClientSdkOverwritePickItem>(CLIENT_SDK_OVERWRITE_CHOICES, {
    placeHolder: '输出目录里已存在的文件如何处理'
  });
  if (overwriteChoice === undefined) {
    return;
  }

  const result = await generateClientSdkEntities(
    {
      languages: languages.map(choice => choice.value as ClientSdkLanguage),
      outputDir,
      overwrite: overwriteChoice.value === 'overwrite',
      engineTrace
    },
    workspaceRoot
  );

  const written = result.files.filter(file => file.written);
  const writtenPath = written[0]?.path;
  const skippedNames = skippedSameNameFromOtherRoots ?? [];
  const skippedNote = skippedNames.length > 0 ? `；跨根同名未覆盖：${skippedNames.join('、')}` : '';
  vscode.window.showInformationMessage(
    `客户端实体 SDK 已生成 ${written.length} 个文件${writtenPath ? `（${writtenPath}）` : ''}，跳过 ${result.skipped} 个${skippedNote}`
  );
}
