/**
 * 组合根派生(用户 2026-10-16 纠正:「只假设 Avatar 文件是 mixin 的是不对的,
 * entities.xml 文件里的字段对应的对象都可能是 mixin 的,所有需要查找的」)。
 *
 * 三输入交叉:
 *  - entities.xml:实体清单 → 每个实体是组合根;
 *  - 各实体 .def:Parent 父链 / Interfaces 接口 / Components 组件 → 归到该根的
 *    def 声明 mixin 名单;Properties 字段类型(含 ARRAY OF 链)→ 经 types.xml
 *    解析到 implementedBy 的字段对象类 → 这些对象类本身也是组合根;
 *  - Python 类继承关系由消费方(PythonClassIndex)与本表交叉,
 *    得出「类 X 被哪些组合根收录」。
 *
 * 本模块为纯函数(文件内容注入),便于单测;文件枚举在 PythonClassIndex 侧。
 * 解析入口:复用 defParser 的 XML 解析(defParser.ts:58 parseDefDocument)。
 */

import {
  getDirectChildElement,
  getDirectChildElements,
  getElementText,
  getScalarChildValue,
  parseDefDocument,
  type DefElementNode
} from './defParser';

/** entities.xml 的实体名(根的直接元素子节点;注释是文本节点天然被排除) */
export function parseEntityNames(content: string): string[] {
  const document = parseDefDocument(content);
  if (!document.root) {
    return [];
  }
  return getDirectChildElements(document.root).map(element => element.name);
}

/** 单个实体 .def 的组合信息:父链、接口、组件、字段类型引用名 */
export interface DefComposition {
  parent: string | null;
  interfaces: string[];
  components: string[];
  /** Properties 里 <Type> 引用的类型名(ARRAY 的元素经 <of> 收录,不收 'ARRAY' 字面) */
  fieldTypes: string[];
}

/** 接口标签的四种拼写(引擎 <Interfaces> 包裹,批118 同口径) */
const INTERFACE_TAG_NAMES = new Set(['interface', 'Interface', 'type', 'Type']);

/** <Type> 节点引用名:直文本 + <of> 子文本;容器字面不入表 */
function collectTypeReferences(typeNode: DefElementNode): string[] {
  const names: string[] = [];
  const direct = getElementText(typeNode)
    .split(/\s+/)
    .map(token => token.trim())
    .filter(token => token.length > 0);
  for (const token of direct) {
    if (token !== 'ARRAY' && token !== 'FIXED_DICT') {
      names.push(token);
    }
  }
  for (const child of getDirectChildElements(typeNode)) {
    if (child.name === 'of') {
      const ofName = getElementText(child).trim();
      if (ofName) {
        names.push(ofName);
      }
    }
  }
  return names;
}

export function parseDefComposition(content: string): DefComposition | null {
  const document = parseDefDocument(content);
  if (!document.root) {
    return null;
  }
  const root = document.root;
  const composition: DefComposition = { parent: null, interfaces: [], components: [], fieldTypes: [] };

  const parentNode = getDirectChildElement(root, 'Parent');
  if (parentNode) {
    const parentName = getElementText(parentNode).trim();
    if (parentName) {
      composition.parent = parentName;
    }
  }

  const interfacesNode = getDirectChildElement(root, 'Interfaces');
  if (interfacesNode) {
    for (const child of getDirectChildElements(interfacesNode)) {
      if (INTERFACE_TAG_NAMES.has(child.name)) {
        const name = getElementText(child).trim();
        if (name) {
          composition.interfaces.push(name);
        }
      }
    }
  }

  const componentsNode = getDirectChildElement(root, 'Components');
  if (componentsNode) {
    for (const componentNode of getDirectChildElements(componentsNode)) {
      const typeName = getScalarChildValue(componentNode, 'Type');
      if (typeName) {
        composition.components.push(typeName.trim());
      }
    }
  }

  const propertiesNode = getDirectChildElement(root, 'Properties');
  if (propertiesNode) {
    for (const propertyNode of getDirectChildElements(propertiesNode)) {
      const typeNode = getDirectChildElement(propertyNode, 'Type');
      if (typeNode) {
        composition.fieldTypes.push(...collectTypeReferences(typeNode));
      }
    }
  }

  return composition;
}

/** types.xml 单条类型声明(对齐引擎 DataTypes::loadTypes:条目标签即类型名) */
export interface TypeDeclaration {
  kind: 'fixedDict' | 'array' | 'builtin';
  /** FIXED_DICT 的序列化实现对象:MODULE.Symbol → 实现对象符号 Symbol(实例,类由消费方在 Python 侧解析) */
  implementedBySymbol: string | null;
  /** FIXED_DICT 的键字段类型引用(递归解析用) */
  fieldRefs: string[];
  /** ARRAY 的元素类型引用 */
  elementRef: string | null;
}

/**
 * 解析 types.xml:别名/复合类型表。
 * FIXED_DICT → implementedBy 与键字段;ARRAY → <of> 元素;其余文本 → builtin。
 */
export function parseTypesXml(content: string): Map<string, TypeDeclaration> {
  const table = new Map<string, TypeDeclaration>();
  const document = parseDefDocument(content);
  if (!document.root) {
    return table;
  }
  for (const item of getDirectChildElements(document.root)) {
    const textDirective = getElementText(item).trim().split(/\s+/)[0] ?? '';
    // 属性式条目(`<JSONDATA type="UINT32"/>`):无文本指引时回落 `type` 属性值
    // (与 Rust parse_types 同口径;PR-012 门 §1.3-① 属性式注册面关闭)。
    const directive = textDirective || (item.attributes['type'] ?? '').trim();
    if (directive === 'FIXED_DICT') {
      const implementedBy = getScalarChildValue(item, 'implementedBy');
      const symbol = implementedBy
        ? ((implementedBy.trim().split('.').pop() ?? '').trim() || null)
        : null;
      const fieldRefs: string[] = [];
      const propertiesNode = getDirectChildElement(item, 'Properties');
      if (propertiesNode) {
        for (const propertyNode of getDirectChildElements(propertiesNode)) {
          const typeNode = getDirectChildElement(propertyNode, 'Type');
          if (typeNode) {
            fieldRefs.push(...collectTypeReferences(typeNode));
          }
        }
      }
      table.set(item.name, { kind: 'fixedDict', implementedBySymbol: symbol, fieldRefs, elementRef: null });
    } else if (directive === 'ARRAY') {
      const ofNode = getDirectChildElement(item, 'of');
      const ofText = ofNode ? getElementText(ofNode).trim() || null : null;
      table.set(item.name, {
        kind: 'array',
        implementedBySymbol: null,
        fieldRefs: [],
        // 属性式 ARRAY 的元素类型回落 `of` 属性(与 Rust parse_types 同口径)。
        elementRef: ofText ?? ((item.attributes['of'] ?? '').trim() || null)
      });
    } else if (directive) {
      table.set(item.name, { kind: 'builtin', implementedBySymbol: null, fieldRefs: [], elementRef: null });
    }
  }
  return table;
}

/**
 * 字段类型引用名 → 经 types 表递归解析出的 implementedBy 实现对象符号(字段对象;engine 实例形态)。
 * 别名链/嵌套 ARRAY/FD 键字段均展开;环与超深降级返回已收集部分。
 */
export function resolveFieldClassSymbols(typeNames: string[], table: Map<string, TypeDeclaration>): string[] {
  const symbols: string[] = [];
  const seen = new Set<string>();
  const visit = (name: string, depth: number): void => {
    if (depth > 8 || seen.has(name)) {
      return;
    }
    seen.add(name);
    const declaration = table.get(name);
    if (!declaration || declaration.kind === 'builtin') {
      return;
    }
    if (declaration.implementedBySymbol) {
      symbols.push(declaration.implementedBySymbol);
    }
    if (declaration.kind === 'array' && declaration.elementRef) {
      visit(declaration.elementRef, depth + 1);
    }
    for (const ref of declaration.fieldRefs) {
      visit(ref, depth + 1);
    }
  };
  for (const name of typeNames) {
    visit(name, 0);
  }
  return [...new Set(symbols)];
}

export interface CompositionRootDerivationInput {
  /** 全部 entities.xml 内容(工作区可能同时存在多份) */
  entitiesXmlContents: string[];
  /** 实体 .def(路径含 components/、interfaces/ 的不在此列) */
  entityDefs: Array<{ entity: string; content: string }>;
  /** 全部 types.xml 内容(按序合并,先出现者优先) */
  typesXmlContents: string[];
}

export interface CompositionRootMap {
  /** 组合根类名:实体(entities.xml 序)→ 字段对象类 → 组件;去重保序 */
  roots: string[];
  /** 组合根 → 该根 .def 声明的 mixin 类名(Parent → Interfaces → Components) */
  defMixins: Map<string, string[]>;
}

export function deriveCompositionRoots(input: CompositionRootDerivationInput): CompositionRootMap {
  const roots: string[] = [];
  const seenRoots = new Set<string>();
  const pushRoot = (name: string): void => {
    if (name && !seenRoots.has(name)) {
      seenRoots.add(name);
      roots.push(name);
    }
  };

  const typeTable = new Map<string, TypeDeclaration>();
  for (const content of input.typesXmlContents) {
    for (const [name, declaration] of parseTypesXml(content)) {
      if (!typeTable.has(name)) {
        typeTable.set(name, declaration);
      }
    }
  }

  const entityNames: string[] = [];
  for (const content of input.entitiesXmlContents) {
    for (const name of parseEntityNames(content)) {
      if (!entityNames.includes(name)) {
        entityNames.push(name);
      }
    }
  }
  for (const name of entityNames) {
    pushRoot(name);
  }

  const defMixins = new Map<string, string[]>();
  const appendMixins = (root: string, names: string[]): void => {
    const current = defMixins.get(root) ?? [];
    for (const name of names) {
      if (name && name !== root && !current.includes(name)) {
        current.push(name);
      }
    }
    defMixins.set(root, current);
  };

  for (const { entity, content } of input.entityDefs) {
    const composition = parseDefComposition(content);
    if (!composition) {
      continue;
    }
    // 字段对象类 = 组合根(用户点名:字段对应的对象都可能是 mixin 的)
    for (const symbol of resolveFieldClassSymbols(composition.fieldTypes, typeTable)) {
      pushRoot(symbol);
    }
    // 组件实例随实体组合(明细组件)
    for (const component of composition.components) {
      pushRoot(component);
    }
    // def 声明的 mixin 归到该实体根
    appendMixins(entity, [
      ...(composition.parent ? [composition.parent] : []),
      ...composition.interfaces,
      ...composition.components
    ]);
  }

  return { roots, defMixins };
}
