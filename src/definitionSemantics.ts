import * as fs from 'fs';
import {
  DefDocument,
  DefElementNode,
  DefMethodSection,
  DEF_METHOD_SECTIONS,
  getDirectChildElement,
  getDirectChildElements,
  getDirectChildElementsByName,
  getElementText,
  getLineNumberAt,
  getScalarChildValue,
  hasTruthyChildTag,
  parseDefDocument
} from './defParser';
import {
  DefinitionCategory,
  findDefinitionFileByCategory,
  findEntityDefinitionFile,
  getWorkspaceRootForDocument
} from './definitionWorkspace';
import { getReferenceTargetName, INTERFACE_WRAPPER_NAMES } from './defRenamer';

export type DefinitionSemanticCategory = Exclude<DefinitionCategory, 'type'>;
export type DefinitionMemberSourceKind = 'local' | 'interface' | 'parent' | 'component';

export interface DefinitionOwnerRef {
  kind: DefinitionSemanticCategory;
  name: string;
  filePath: string;
}

export interface DefinitionMemberSource {
  kind: DefinitionMemberSourceKind;
  chain: string[];
  label: string;
}

export interface DefinitionInterfaceRef {
  name: string;
  line: number;
}

export interface DefinitionComponentRef {
  slotName: string;
  typeName: string;
  line: number;
  owner: DefinitionOwnerRef;
  /** 组件槽 <Utype> 子值(批123);null = 未声明,占用属性 utype 空间 */
  utype: number | null;
}

export interface DefinitionProperty {
  name: string;
  fullPath: string;
  line: number;
  typeName?: string;
  flags?: string;
  /** <Utype> 子值(批123);null = 未声明。属性 utype 与方法 utype 是两套独立空间 */
  utype?: number | null;
  persistent?: boolean;
  identifier?: boolean;
  indexType?: string;
  databaseLength?: number;
  detailLevel?: string;
  defaultValue?: string;
  owner: DefinitionOwnerRef;
  source: DefinitionMemberSource;
  children: DefinitionProperty[];
  arrayElement?: DefinitionProperty;
}

/**
 * 结构化参数序列条目(批123)。name = <Arg> 直文本(如 UINT8 / ARRAY);
 * ARRAY 时 ofType 为 <of> 子解析结果,嵌套 ARRAY 递归(对齐引擎
 * FixedArrayType::initialize 的 <of> 递归链)。
 */
export interface DefinitionArgType {
  name: string;
  ofType?: DefinitionArgType;
}

export interface DefinitionMethod {
  name: string;
  line: number;
  section: DefMethodSection;
  args: string[];
  /** 与 args 一一对应的结构化参数序列(批123:含 ARRAY 的 of 链) */
  argTypes: DefinitionArgType[];
  exposed: boolean;
  /** <Utype> 子值(批123);null = 未声明。引擎口径:≤0 视同未设置,>65535 溢出报错 */
  utype: number | null;
  owner: DefinitionOwnerRef;
  source: DefinitionMemberSource;
}

export interface LocalDefinitionSemantics {
  category: DefinitionSemanticCategory;
  owner: DefinitionOwnerRef;
  document: DefDocument;
  parentName?: string;
  parentLine?: number;
  interfaces: DefinitionInterfaceRef[];
  components: DefinitionComponentRef[];
  properties: DefinitionProperty[];
  methods: DefinitionMethod[];
  methodsBySection: Record<DefMethodSection, DefinitionMethod[]>;
}

export interface DefinitionInheritanceGroup {
  owner: DefinitionOwnerRef;
  label: string;
  properties: DefinitionProperty[];
  methodsBySection: Record<DefMethodSection, DefinitionMethod[]>;
}

export interface ResolvedDefinitionComponentSlot {
  slotName: string;
  typeName: string;
  line: number;
  owner: DefinitionOwnerRef;
  resolved: ResolvedDefinitionSemantics | null;
  source: DefinitionMemberSource;
}

export interface ResolvedDefinitionSemantics {
  category: DefinitionSemanticCategory;
  owner: DefinitionOwnerRef;
  local: LocalDefinitionSemantics;
  parentName?: string;
  inheritanceGroups: DefinitionInheritanceGroup[];
  effectiveProperties: DefinitionProperty[];
  effectiveMethodsBySection: Record<DefMethodSection, DefinitionMethod[]>;
  components: ResolvedDefinitionComponentSlot[];
}

interface ResolutionContext {
  allowComponents: boolean;
  visited: Set<string>;
}

export class DefinitionSemanticsLoader {
  private localCache = new Map<string, LocalDefinitionSemantics | null>();
  private resolvedCache = new Map<string, ResolvedDefinitionSemantics | null>();

  constructor(private readonly workspaceRoot: string) {}

  loadLocal(
    name: string,
    category: DefinitionSemanticCategory
  ): LocalDefinitionSemantics | null {
    const cacheKey = buildCacheKey(category, name);
    if (this.localCache.has(cacheKey)) {
      return this.localCache.get(cacheKey) || null;
    }

    const filePath = this.resolveDefinitionFile(name, category);
    if (!filePath) {
      this.localCache.set(cacheKey, null);
      return null;
    }

    const content = readTextFile(filePath);
    if (!content) {
      this.localCache.set(cacheKey, null);
      return null;
    }

    try {
      const parsed = parseLocalDefinition(content, category, name, filePath);
      this.localCache.set(cacheKey, parsed);
      return parsed;
    } catch {
      this.localCache.set(cacheKey, null);
      return null;
    }
  }

  loadResolved(
    name: string,
    category: DefinitionSemanticCategory,
    allowComponents = true
  ): ResolvedDefinitionSemantics | null {
    const cacheKey = `${buildCacheKey(category, name)}::${allowComponents ? 'components' : 'plain'}`;
    if (this.resolvedCache.has(cacheKey)) {
      return this.resolvedCache.get(cacheKey) || null;
    }

    const resolved = this.loadResolvedInternal(name, category, {
      allowComponents,
      visited: new Set<string>()
    });
    this.resolvedCache.set(cacheKey, resolved);
    return resolved;
  }

  private loadResolvedInternal(
    name: string,
    category: DefinitionSemanticCategory,
    context: ResolutionContext
  ): ResolvedDefinitionSemantics | null {
    const local = this.loadLocal(name, category);
    if (!local) {
      return null;
    }

    const visitKey = normalizeLookupPath(local.owner.filePath);
    if (context.visited.has(visitKey)) {
      return null;
    }

    context.visited.add(visitKey);
    try {
      const inheritanceGroups: DefinitionInheritanceGroup[] = [];
      const effectivePropertyMap = new Map<string, DefinitionProperty>();
      const effectiveMethodMaps: Record<DefMethodSection, Map<string, DefinitionMethod>> = createMethodMapRecord();
      const componentSlots: ResolvedDefinitionComponentSlot[] = [];
      const seenComponentSlots = new Set<string>();

      for (const property of local.properties) {
        if (!effectivePropertyMap.has(property.fullPath)) {
          effectivePropertyMap.set(property.fullPath, cloneProperty(property));
        }
      }

      for (const section of DEF_METHOD_SECTIONS) {
        for (const method of local.methodsBySection[section]) {
          if (!effectiveMethodMaps[section].has(method.name)) {
            effectiveMethodMaps[section].set(method.name, cloneMethod(method));
          }
        }
      }

      if (context.allowComponents) {
        for (const component of local.components) {
          const slotKey = component.slotName.toLowerCase();
          if (seenComponentSlots.has(slotKey)) {
            continue;
          }

          seenComponentSlots.add(slotKey);
          componentSlots.push({
            slotName: component.slotName,
            typeName: component.typeName,
            line: component.line,
            owner: component.owner,
            resolved: this.loadResolvedInternal(component.typeName, 'component', {
              allowComponents: false,
              visited: context.visited
            }),
            source: createSource('local')
          });
        }
      }

      const interfaceAllowComponents = context.allowComponents && category !== 'component';
      for (const interfaceRef of local.interfaces) {
        const interfaceResolved = this.loadResolvedInternal(interfaceRef.name, 'interface', {
          allowComponents: interfaceAllowComponents,
          visited: context.visited
        });
        if (!interfaceResolved) {
          continue;
        }

        inheritanceGroups.push({
          owner: interfaceResolved.owner,
          label: buildInheritanceLabel('Mixin', [interfaceRef.name]),
          properties: interfaceResolved.local.properties.map(property => cloneProperty(
            property,
            undefined,
            createSource('interface', [interfaceRef.name])
          )),
          methodsBySection: cloneMethodSectionRecord(
            interfaceResolved.local.methodsBySection,
            createSource('interface', [interfaceRef.name])
          )
        });

        for (const property of interfaceResolved.effectiveProperties) {
          if (!effectivePropertyMap.has(property.fullPath)) {
            effectivePropertyMap.set(
              property.fullPath,
              cloneProperty(property, undefined, createSource('interface', [interfaceRef.name]))
            );
          }
        }

        for (const section of DEF_METHOD_SECTIONS) {
          for (const method of interfaceResolved.effectiveMethodsBySection[section]) {
            if (!effectiveMethodMaps[section].has(method.name)) {
              effectiveMethodMaps[section].set(
                method.name,
                cloneMethod(method, undefined, createSource('interface', [interfaceRef.name]))
              );
            }
          }
        }

        if (context.allowComponents) {
          for (const component of interfaceResolved.components) {
            const slotKey = component.slotName.toLowerCase();
            if (seenComponentSlots.has(slotKey)) {
              continue;
            }

            seenComponentSlots.add(slotKey);
            componentSlots.push({
              slotName: component.slotName,
              typeName: component.typeName,
              line: component.line,
              owner: component.owner,
              resolved: component.resolved,
              source: createSource('interface', [interfaceRef.name])
            });
          }
        }

        for (const nestedGroup of interfaceResolved.inheritanceGroups) {
          const chain = [interfaceRef.name].concat(extractSourceChain(nestedGroup.properties, nestedGroup.methodsBySection));
          inheritanceGroups.push({
            owner: nestedGroup.owner,
            label: buildInheritanceLabel('Mixin', chain),
            properties: nestedGroup.properties.map(property => cloneProperty(
              property,
              undefined,
              createSource('interface', chain)
            )),
            methodsBySection: cloneMethodSectionRecord(
              nestedGroup.methodsBySection,
              createSource('interface', chain)
            )
          });
        }
      }

      if (local.parentName) {
        const parentCategory = category === 'component' ? 'component' : 'entity';
        const parentResolved = this.loadResolvedInternal(local.parentName, parentCategory, {
          allowComponents: context.allowComponents,
          visited: context.visited
        });

        if (parentResolved) {
          const parentChain = [local.parentName];
          inheritanceGroups.push({
            owner: parentResolved.owner,
            label: buildInheritanceLabel('Parent', parentChain),
            properties: parentResolved.local.properties.map(property => cloneProperty(
              property,
              undefined,
              createSource('parent', parentChain)
            )),
            methodsBySection: cloneMethodSectionRecord(
              parentResolved.local.methodsBySection,
              createSource('parent', parentChain)
            )
          });

          for (const property of parentResolved.effectiveProperties) {
            if (!effectivePropertyMap.has(property.fullPath)) {
              effectivePropertyMap.set(
                property.fullPath,
                cloneProperty(property, undefined, createSource('parent', parentChain))
              );
            }
          }

          for (const section of DEF_METHOD_SECTIONS) {
            for (const method of parentResolved.effectiveMethodsBySection[section]) {
              if (!effectiveMethodMaps[section].has(method.name)) {
                effectiveMethodMaps[section].set(
                  method.name,
                  cloneMethod(method, undefined, createSource('parent', parentChain))
                );
              }
            }
          }

          if (context.allowComponents) {
            for (const component of parentResolved.components) {
              const slotKey = component.slotName.toLowerCase();
              if (seenComponentSlots.has(slotKey)) {
                continue;
              }

              seenComponentSlots.add(slotKey);
              componentSlots.push({
                slotName: component.slotName,
                typeName: component.typeName,
                line: component.line,
                owner: component.owner,
                resolved: component.resolved,
                source: createSource('parent', parentChain)
              });
            }
          }

          for (const nestedGroup of parentResolved.inheritanceGroups) {
            const chain = parentChain.concat(extractSourceChain(nestedGroup.properties, nestedGroup.methodsBySection));
            inheritanceGroups.push({
              owner: nestedGroup.owner,
              label: buildInheritanceLabel('Parent', chain),
              properties: nestedGroup.properties.map(property => cloneProperty(
                property,
                undefined,
                createSource('parent', chain)
              )),
              methodsBySection: cloneMethodSectionRecord(
                nestedGroup.methodsBySection,
                createSource('parent', chain)
              )
            });
          }
        }
      }

      return {
        category,
        owner: local.owner,
        local,
        parentName: local.parentName,
        inheritanceGroups,
        effectiveProperties: [...effectivePropertyMap.values()],
        effectiveMethodsBySection: mapRecordValues(effectiveMethodMaps),
        components: componentSlots
      };
    } finally {
      context.visited.delete(visitKey);
    }
  }

  private resolveDefinitionFile(
    name: string,
    category: DefinitionSemanticCategory
  ): string | null {
    if (category === 'entity') {
      return findEntityDefinitionFile(name, this.workspaceRoot);
    }

    return findDefinitionFileByCategory(name, category, this.workspaceRoot);
  }
}

export function createDefinitionSemanticsLoader(
  target?: string | Pick<{ fileName: string }, 'fileName'>
): DefinitionSemanticsLoader | null {
  const workspaceRoot = typeof target === 'string'
    ? target
    : getWorkspaceRootForDocument(target as { fileName: string } | undefined);

  return workspaceRoot ? new DefinitionSemanticsLoader(workspaceRoot) : null;
}

export function parseLocalDefinition(
  content: string,
  category: DefinitionSemanticCategory,
  name: string,
  filePath: string
): LocalDefinitionSemantics {
  const document = parseDefDocument(content);
  const root = document.root;
  const owner: DefinitionOwnerRef = { kind: category, name, filePath };
  const methodsBySection = createMethodRecord();

  if (!root) {
    return {
      category,
      owner,
      document,
      interfaces: [],
      components: [],
      properties: [],
      methods: [],
      methodsBySection
    };
  }

  const parentNode = getDirectChildElement(root, 'Parent');
  // Parent 取名同引擎 enterNode/getKey(文本取文本、元素取标签名),与
  // defRenamer 的 parseDefFileSemantics 共用同一实现,不再各写一份
  const parentName = parentNode ? getReferenceTargetName(parentNode) : '';
  const interfaceRefs = parseInterfaceRefs(document, getDirectChildElement(root, 'Interfaces'));
  const componentRefs = parseComponentRefs(document, getDirectChildElement(root, 'Components'), owner);
  const properties = parseProperties(document, getDirectChildElement(root, 'Properties'), owner);
  const methods = parseMethods(document, root, owner);

  for (const method of methods) {
    methodsBySection[method.section].push(method);
  }

  return {
    category,
    owner,
    document,
    parentName: parentName || undefined,
    parentLine: parentNode ? getLineNumberAt(document, parentNode.tagStart) : undefined,
    interfaces: interfaceRefs,
    components: componentRefs,
    properties,
    methods,
    methodsBySection
  };
}

function parseInterfaceRefs(
  document: DefDocument,
  interfacesNode?: DefElementNode
): DefinitionInterfaceRef[] {
  if (!interfacesNode) {
    return [];
  }

  const interfaces: DefinitionInterfaceRef[] = [];
  for (const child of getDirectChildElements(interfacesNode)) {
    // 引擎 loadInterfaces(entitydef.cpp L559-561)只装载 wrapper 标签为
    // interface/Interface/type/Type 四拼写的子元素(大小写敏感精确比对),
    // 其余 continue——直取形态(<MoveIface/>)引擎静默跳过,不产生混入;
    // 取名语义与 <Parent> 同:首个非注释子节点,文本取文本、元素取标签名
    if (!INTERFACE_WRAPPER_NAMES.has(child.name)) {
      continue;
    }
    const name = getReferenceTargetName(child);
    if (!name) {
      continue;
    }

    interfaces.push({
      name,
      line: getLineNumberAt(document, child.tagStart)
    });
  }

  return interfaces;
}

function parseComponentRefs(
  document: DefDocument,
  componentsNode: DefElementNode | undefined,
  owner: DefinitionOwnerRef
): DefinitionComponentRef[] {
  if (!componentsNode) {
    return [];
  }

  const components: DefinitionComponentRef[] = [];
  for (const child of getDirectChildElements(componentsNode)) {
    const typeName = getNodeValue(getDirectChildElement(child, 'Type'));
    if (!typeName) {
      continue;
    }

    components.push({
      slotName: child.name,
      typeName,
      line: getLineNumberAt(document, child.tagStart),
      owner,
      utype: parseUtypeValue(getScalarChildValue(child, 'Utype'))
    });
  }

  return components;
}

function parseProperties(
  document: DefDocument,
  sectionNode: DefElementNode | undefined,
  owner: DefinitionOwnerRef,
  prefixPath = ''
): DefinitionProperty[] {
  if (!sectionNode) {
    return [];
  }

  const properties: DefinitionProperty[] = [];
  for (const propertyNode of getDirectChildElements(sectionNode)) {
    const fullPath = prefixPath ? `${prefixPath}.${propertyNode.name}` : propertyNode.name;
    const typeName = getScalarChildValue(propertyNode, 'Type');
    const property: DefinitionProperty = {
      name: propertyNode.name,
      fullPath,
      line: getLineNumberAt(document, propertyNode.tagStart),
      typeName,
      flags: getScalarChildValue(propertyNode, 'Flags'),
      utype: parseUtypeValue(getScalarChildValue(propertyNode, 'Utype')),
      persistent: parseOptionalBoolean(getScalarChildValue(propertyNode, 'Persistent')),
      identifier: hasTruthyChildTag(propertyNode, 'Identifier'),
      indexType: getScalarChildValue(propertyNode, 'Index'),
      databaseLength: parseOptionalNumber(getScalarChildValue(propertyNode, 'DatabaseLength')),
      detailLevel: getScalarChildValue(propertyNode, 'DetailLevel'),
      defaultValue: getScalarChildValue(propertyNode, 'Default'),
      owner,
      source: createSource('local'),
      children: []
    };

    const childPropertiesNode = getDirectChildElement(propertyNode, 'Properties');
    if (childPropertiesNode) {
      property.children = parseProperties(document, childPropertiesNode, owner, fullPath);
    }

    const typeNode = getDirectChildElement(propertyNode, 'Type');
    const arrayOfType = typeNode ? getScalarChildValue(typeNode, 'of') : undefined;
    if (arrayOfType) {
      property.arrayElement = {
        name: 'value',
        fullPath: `${fullPath}[]`,
        line: property.line,
        typeName: arrayOfType,
        flags: property.flags,
        persistent: property.persistent,
        identifier: false,
        indexType: undefined,
        databaseLength: property.databaseLength,
        detailLevel: property.detailLevel,
        defaultValue: undefined,
        owner,
        source: createSource('local'),
        children: [],
        arrayElement: undefined
      };

      // 不可达(批66 定性):此处位于 `if (arrayOfType)` 块内,而 arrayOfType
      // 只能由上一行三元取 typeNode 非空臂得到(getScalarChildValue 命中才
      // 产出真值),typeNode 是不可变 const ⇒ 重检恒走真臂,`: undefined`
      // 假臂无触发路径。语句与两分支条目随区间移出分母(TESTING.md 分母
      // 口径据实登记);真臂行为已由既有 ARRAY of <Type> 内嵌 <Properties>
      // 递归用例覆盖锁定。
      /* istanbul ignore start */
      const nestedArrayPropertiesNode = typeNode ? getDirectChildElement(typeNode, 'Properties') : undefined;
      /* istanbul ignore stop */
      if (nestedArrayPropertiesNode) {
        property.arrayElement.children = parseProperties(
          document,
          nestedArrayPropertiesNode,
          owner,
          `${fullPath}[]`
        );
      }
    }

    properties.push(property);
  }

  return properties;
}

function parseMethods(
  document: DefDocument,
  root: DefElementNode,
  owner: DefinitionOwnerRef
): DefinitionMethod[] {
  const methods: DefinitionMethod[] = [];

  for (const section of DEF_METHOD_SECTIONS) {
    const sectionNode = getDirectChildElement(root, section);
    if (!sectionNode) {
      continue;
    }

    for (const methodNode of getDirectChildElements(sectionNode)) {
      // args 与 argTypes 同一循环产出,保证 1:1(空文本 Arg 两处一致剔除)
      const args: string[] = [];
      const argTypes: DefinitionArgType[] = [];
      for (const argNode of getDirectChildElementsByName(methodNode, 'Arg')) {
        const argName = getElementText(argNode).trim();
        if (!argName) {
          continue;
        }
        args.push(argName);
        argTypes.push(parseArgType(argNode, argName));
      }

      const utypeText = getScalarChildValue(methodNode, 'Utype');
      methods.push({
        name: methodNode.name,
        line: getLineNumberAt(document, methodNode.tagStart),
        section,
        args,
        argTypes,
        exposed: hasTruthyChildTag(methodNode, 'Exposed'),
        utype: parseUtypeValue(utypeText),
        owner,
        source: createSource('local')
      });
    }
  }

  return methods;
}

// 引擎 Arg 解析(entitydef.cpp loadDef*Methods):<Arg> 直文本即类型名;
// "ARRAY" 走 FixedArrayType::initialize,读 <of> 子,嵌套递归。缺 <of> 节点
// 与空 <of></of> 分开保留(ofType: {name:''}):引擎前者报 not found "of".、
// 后者报 key[ARRAY] did not find type[]!,生成侧按此分流
function parseArgType(argNode: DefElementNode, name: string): DefinitionArgType {
  if (name !== 'ARRAY') {
    return { name };
  }
  const ofNode = getDirectChildElement(argNode, 'of');
  if (!ofNode) {
    return { name };
  }
  const ofName = getElementText(ofNode).trim();
  if (!ofName) {
    return { name, ofType: { name: '' } };
  }
  return { name, ofType: parseArgType(ofNode, ofName) };
}

// 引擎 getValInt 语义:非数字文本得 0(视同未设置,自动分配);溢出判定不在
// 解析层,由生成侧按 >65535 做(uint16 截断比对,engine 层报错)
function parseUtypeValue(text: string | undefined): number | null {
  if (text === undefined) {
    return null;
  }
  const parsed = Number(text.trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function getNodeValue(node?: DefElementNode): string {
  if (!node) {
    return '';
  }

  const text = getElementText(node).trim();
  if (text) {
    return text;
  }

  const firstChild = getDirectChildElements(node)[0];
  return firstChild ? firstChild.name.trim() : '';
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
    return true;
  }

  if (normalized === 'false' || normalized === '0' || normalized === 'no') {
    return false;
  }

  return undefined;
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function buildCacheKey(category: DefinitionSemanticCategory, name: string): string {
  return `${category}:${name}`;
}

function readTextFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function createSource(
  kind: DefinitionMemberSourceKind,
  chain: string[] = []
): DefinitionMemberSource {
  return {
    kind,
    chain: [...chain],
    label: kind === 'local'
      ? 'Own'
      : buildInheritanceLabel(kind === 'interface' ? 'Mixin' : 'Parent', chain)
  };
}

function buildInheritanceLabel(prefix: 'Mixin' | 'Parent', chain: string[]): string {
  // 不可达(批62 定性):五处调用(本文件 L249/304/329/384 与 createSource)传入的
  // chain 都以字面量名打头([interfaceRef.name] / [local.parentName] / parentChain
  // .concat(...)),长度恒 ≥1;createSource 的形参默认值 [] 只与 kind='local'
  // 的调用同现(走 'Own' 分支),故空链臂无触发路径。
  /* istanbul ignore start */
  if (chain.length === 0) {
    return prefix;
  }
  /* istanbul ignore stop */

  return `${prefix} · ${chain.join(' / ')}`;
}

function cloneProperty(
  property: DefinitionProperty,
  owner?: DefinitionOwnerRef,
  source?: DefinitionMemberSource
): DefinitionProperty {
  return {
    ...property,
    owner: owner || property.owner,
    source: source || cloneSource(property.source),
    children: property.children.map(child => cloneProperty(child, owner, source)),
    arrayElement: property.arrayElement ? cloneProperty(property.arrayElement, owner, source) : undefined
  };
}

function cloneMethod(
  method: DefinitionMethod,
  owner?: DefinitionOwnerRef,
  source?: DefinitionMemberSource
): DefinitionMethod {
  return {
    ...method,
    args: [...method.args],
    owner: owner || method.owner,
    source: source || cloneSource(method.source)
  };
}

function cloneSource(source: DefinitionMemberSource): DefinitionMemberSource {
  return {
    kind: source.kind,
    chain: [...source.chain],
    label: source.label
  };
}

function createMethodRecord(): Record<DefMethodSection, DefinitionMethod[]> {
  return {
    BaseMethods: [],
    CellMethods: [],
    ClientMethods: []
  };
}

function createMethodMapRecord(): Record<DefMethodSection, Map<string, DefinitionMethod>> {
  return {
    BaseMethods: new Map<string, DefinitionMethod>(),
    CellMethods: new Map<string, DefinitionMethod>(),
    ClientMethods: new Map<string, DefinitionMethod>()
  };
}

function cloneMethodSectionRecord(
  source: Record<DefMethodSection, DefinitionMethod[]>,
  nextSource: DefinitionMemberSource
): Record<DefMethodSection, DefinitionMethod[]> {
  return {
    BaseMethods: source.BaseMethods.map(method => cloneMethod(method, undefined, nextSource)),
    CellMethods: source.CellMethods.map(method => cloneMethod(method, undefined, nextSource)),
    ClientMethods: source.ClientMethods.map(method => cloneMethod(method, undefined, nextSource))
  };
}

function mapRecordValues(
  source: Record<DefMethodSection, Map<string, DefinitionMethod>>
): Record<DefMethodSection, DefinitionMethod[]> {
  return {
    BaseMethods: [...source.BaseMethods.values()],
    CellMethods: [...source.CellMethods.values()],
    ClientMethods: [...source.ClientMethods.values()]
  };
}

function extractSourceChain(
  properties: DefinitionProperty[],
  methodsBySection: Record<DefMethodSection, DefinitionMethod[]>
): string[] {
  const firstProperty = properties[0];
  if (firstProperty?.source.chain.length) {
    return [...firstProperty.source.chain];
  }

  for (const section of DEF_METHOD_SECTIONS) {
    const firstMethod = methodsBySection[section][0];
    if (firstMethod?.source.chain.length) {
      return [...firstMethod.source.chain];
    }
  }

  return [];
}

export function normalizeLookupPath(targetPath: string): string {
  return targetPath.replace(/\\/g, '/').toLowerCase();
}
