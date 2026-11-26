// SRC-005 (stage 1): leaf functions for pure XML / custom-type parsing moved out
// of definitionWorkspace.ts. A pure move: 9 module-level parsing / structure-building /
// text-normalizing functions (parseCustomTypeProperties/
// extractCustomTypeRawValue/extractCustomTypeAliasType/parseCustomTypeStructure/
// attachStructureSourceLines/renderStructureNode/getInnerXml/normalizeXmlText/
// isTrueAttributeValue) moved out as module-level exports; no fs/path/vscode
// dependencies, only defParser value functions plus type imports (type-only from
// definitionWorkspace, so no runtime cycle). The file-reading surface
// (getTypesXmlCustomTypeInfos/buildAliasXmlCustomTypeInfo) and buildCustomTypeInfo
// (which depends on findCustomTypePythonFileByImplementation) stay in
// definitionWorkspace.ts.
import type { CustomTypePropertyInfo, CustomTypeStructureNode } from '../definitionWorkspace';
import { DefElementNode, getDirectChildElement, getDirectChildElements, getLineNumberAt, getScalarChildValue, parseDefDocument, type DefDocument } from './defParser';

export function parseCustomTypeProperties(
  document: DefDocument,
  typeNode: DefElementNode
): CustomTypePropertyInfo[] {
  const propertiesNode = getDirectChildElement(typeNode, 'Properties');
  if (!propertiesNode) {
    return [];
  }

  return getDirectChildElements(propertiesNode)
    .map(property => {
      const typeNode = getDirectChildElement(property, 'Type');
      return {
        name: property.name,
        typeName: getScalarChildValue(property, 'Type'),
        // 属性面内联结构(ARRAY<of>X</of>)与类型条目顶层同一解析器:
        // 直文本 typeName 只并文本节点(ARRAY),元素型只在结构树里
        typeStructure: typeNode
          ? parseCustomTypeStructure(getInnerXml(typeNode))
          : undefined,
        defaultValue: getScalarChildValue(property, 'Default'),
        line: getLineNumberAt(document, property.tagStart),
        typeLine: typeNode
          ? getLineNumberAt(document, typeNode.tagStart)
          : undefined
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function extractCustomTypeRawValue(typeNode: DefElementNode): string {
  const chunks: string[] = [];

  for (const child of typeNode.children) {
    if (child.kind === 'text') {
      const normalized = normalizeXmlText(child.text);
      if (normalized) {
        chunks.push(normalized);
      }
      continue;
    }

    if (child.name === 'implementedBy' || child.name === 'Properties') {
      continue;
    }

    chunks.push(renderStructureNode(child));
  }

  return chunks.join(' ').trim() || 'ALIAS';
}

export function extractCustomTypeAliasType(rawValue: string): string {
  const match = rawValue.match(/^[A-Za-z_][A-Za-z0-9_]*/);
  return match?.[0] || 'ALIAS';
}

export function parseXmlDocument(content: string): DefDocument | null {
  try {
    return parseDefDocument(content);
  } catch {
    return null;
  }
}

export function parseCustomTypeStructure(rawValue: string): CustomTypeStructureNode {
  const document = parseXmlDocument(`<root>${rawValue}</root>`);
  const root = document?.root;
  const normalizedRawValue = normalizeXmlText(rawValue) || 'ALIAS';

  return {
    name: extractCustomTypeAliasType(normalizedRawValue),
    rawValue: normalizedRawValue,
    line: null,
    children: root
      ? getDirectChildElements(root).map(node => ({
          tag: node.name,
          value: parseCustomTypeStructure(getInnerXml(node))
        }))
      : []
  };
}

export function attachStructureSourceLines(node: DefElementNode, target: CustomTypeStructureNode): void {
  target.rawValue = normalizeXmlText(getInnerXml(node)) || target.rawValue;
  target.line = getLineNumberAt(node.document, node.tagStart);
  const childElements = getDirectChildElements(node);
  for (let index = 0; index < target.children.length; index += 1) {
    const childElement = childElements[index];
    const child = target.children[index];
    if (!childElement) {
      continue;
    }
    child.value.line = getLineNumberAt(node.document, childElement.tagStart);
    const grandchildElements = getDirectChildElements(childElement);
    for (let nestedIndex = 0; nestedIndex < child.value.children.length; nestedIndex += 1) {
      const grandchild = grandchildElements[nestedIndex];
      const nested = child.value.children[nestedIndex];
      if (grandchild) {
        attachStructureSourceLines(grandchild, nested.value);
      }
    }
  }
}

export function renderStructureNode(node: DefElementNode): string {
  if (node.selfClosing) {
    return `<${node.name}/>`;
  }

  return `<${node.name}>${getInnerXml(node)}</${node.name}>`;
}

export function getInnerXml(node: DefElementNode): string {
  return node.children
    .map(child => {
      if (child.kind === 'text') {
        return child.text;
      }

      return renderStructureNode(child);
    })
    .join('');
}

export function normalizeXmlText(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  return normalized || undefined;
}

export function isTrueAttributeValue(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true';
}
