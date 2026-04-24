// Keep the XML runtime parser vendored so VSIX packaging does not depend on pnpm's node_modules layout.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { XMLParser } = require('../vendor/fast-xml-parser/fxp.cjs') as {
  XMLParser: new (options?: Record<string, unknown>) => {
    parse(text: string): unknown;
  };
};

export const DEF_METHOD_SECTIONS = ['BaseMethods', 'CellMethods', 'ClientMethods'] as const;
export type DefMethodSection = typeof DEF_METHOD_SECTIONS[number];

export interface DefDocument {
  text: string;
  lineStarts: number[];
  root: DefElementNode | null;
  nodes: DefNode[];
}

export interface DefElementNode {
  kind: 'element';
  name: string;
  attributes: Record<string, string>;
  children: DefNode[];
  parent: DefElementNode | null;
  tagStart: number;
  tagEnd: number;
  contentStart: number;
  contentEnd: number;
  closeTagStart: number;
  closeTagEnd: number;
  selfClosing: boolean;
}

export interface DefTextNode {
  kind: 'text';
  text: string;
  parent: DefElementNode | null;
  startOffset: number;
  endOffset: number;
}

export type DefNode = DefElementNode | DefTextNode;

interface XmlTagToken {
  name: string;
  kind: 'open' | 'close' | 'self';
  start: number;
  end: number;
}

const preserveOrderParser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  trimValues: false,
  parseTagValue: false
});

export function parseDefDocument(text: string): DefDocument {
  const parsed = preserveOrderParser.parse(text) as unknown[];
  const lineStarts = computeLineStarts(text);
  const nodes = normalizePreserveOrderNodes(parsed, null);
  const tokens = tokenizeXml(text);
  const state = {
    searchOffset: 0,
    tokenIndex: 0
  };

  assignNodePositions(text, nodes, tokens, state);

  return {
    text,
    lineStarts,
    root: findFirstElement(nodes),
    nodes
  };
}

export function isElementNode(node: DefNode | null | undefined): node is DefElementNode {
  return !!node && node.kind === 'element';
}

export function getDirectChildElements(node: DefElementNode | null | undefined): DefElementNode[] {
  if (!node) {
    return [];
  }

  return node.children.filter(isElementNode);
}

export function getDirectChildElement(
  node: DefElementNode | null | undefined,
  name: string
): DefElementNode | undefined {
  return getDirectChildElements(node).find(child => child.name === name);
}

export function getDirectChildElementsByName(
  node: DefElementNode | null | undefined,
  name: string
): DefElementNode[] {
  return getDirectChildElements(node).filter(child => child.name === name);
}

export function getDirectTextNodes(node: DefElementNode | null | undefined): DefTextNode[] {
  if (!node) {
    return [];
  }

  return node.children.filter((child): child is DefTextNode => child.kind === 'text');
}

export function getElementText(node: DefElementNode | null | undefined): string {
  if (!node) {
    return '';
  }

  let text = '';
  for (const child of node.children) {
    if (child.kind === 'text') {
      text += child.text;
    }
  }

  return text;
}

export function getScalarChildValue(
  node: DefElementNode | null | undefined,
  tagName: string
): string | undefined {
  const child = getDirectChildElement(node, tagName);
  if (!child) {
    return undefined;
  }

  const value = getElementText(child).trim();
  return value || undefined;
}

export function getScalarChildValues(
  node: DefElementNode | null | undefined,
  tagName: string
): string[] {
  return getDirectChildElementsByName(node, tagName)
    .map(child => getElementText(child).trim())
    .filter(Boolean);
}

export function hasTruthyChildTag(
  node: DefElementNode | null | undefined,
  tagName: string
): boolean {
  const child = getDirectChildElement(node, tagName);
  if (!child) {
    return false;
  }

  if (child.selfClosing) {
    return true;
  }

  const value = getElementText(child).trim().toLowerCase();
  return value === '' || value === 'true' || value === '1' || value === 'yes';
}

export function getLineNumberAt(document: DefDocument, offset: number): number {
  let low = 0;
  let high = document.lineStarts.length - 1;
  let answer = 0;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (document.lineStarts[mid] <= offset) {
      answer = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return answer + 1;
}

export function findDeepestElementAtOffset(
  node: DefElementNode | null | undefined,
  offset: number
): DefElementNode | null {
  if (!node || offset < node.tagStart || offset > node.closeTagEnd) {
    return null;
  }

  for (const child of getDirectChildElements(node)) {
    const matchedChild = findDeepestElementAtOffset(child, offset);
    if (matchedChild) {
      return matchedChild;
    }
  }

  return node;
}

export function findTextNodeAtOffset(
  node: DefElementNode | null | undefined,
  offset: number
): DefTextNode | null {
  if (!node || offset < node.tagStart || offset > node.closeTagEnd) {
    return null;
  }

  for (const child of node.children) {
    if (child.kind === 'text') {
      if (offset >= child.startOffset && offset <= child.endOffset) {
        return child;
      }
      continue;
    }

    const matchedChild = findTextNodeAtOffset(child, offset);
    if (matchedChild) {
      return matchedChild;
    }
  }

  return null;
}

export function findAncestorElement(
  node: DefNode | null | undefined,
  names: string | string[]
): DefElementNode | null {
  if (!node) {
    return null;
  }

  const candidateNames = Array.isArray(names) ? names : [names];
  let current: DefElementNode | null = node.kind === 'element' ? node : node.parent;

  while (current) {
    if (candidateNames.includes(current.name)) {
      return current;
    }
    current = current.parent;
  }

  return null;
}

function computeLineStarts(text: string): number[] {
  const lineStarts = [0];

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') {
      lineStarts.push(index + 1);
    }
  }

  return lineStarts;
}

function normalizePreserveOrderNodes(
  rawNodes: unknown[],
  parent: DefElementNode | null
): DefNode[] {
  const nodes: DefNode[] = [];

  for (const rawNode of rawNodes) {
    if (!rawNode || typeof rawNode !== 'object') {
      continue;
    }

     const attributes = normalizeAttributes((rawNode as Record<string, unknown>)[':@']);

    for (const [name, value] of Object.entries(rawNode)) {
      if (name === ':@') {
        continue;
      }

      if (name === '#text') {
        nodes.push({
          kind: 'text',
          text: typeof value === 'string' ? value : '',
          parent,
          startOffset: -1,
          endOffset: -1
        });
        continue;
      }

      const element: DefElementNode = {
        kind: 'element',
        name,
        attributes,
        children: [],
        parent,
        tagStart: -1,
        tagEnd: -1,
        contentStart: -1,
        contentEnd: -1,
        closeTagStart: -1,
        closeTagEnd: -1,
        selfClosing: false
      };

      element.children = Array.isArray(value)
        ? normalizePreserveOrderNodes(value, element)
        : [];
      nodes.push(element);
    }
  }

  return nodes;
}

function normalizeAttributes(rawAttributes: unknown): Record<string, string> {
  if (!rawAttributes || typeof rawAttributes !== 'object') {
    return {};
  }

  const attributes: Record<string, string> = {};
  for (const [name, value] of Object.entries(rawAttributes)) {
    const normalizedName = name.replace(/^@_/, '');
    attributes[normalizedName] = typeof value === 'string' ? value : String(value ?? '');
  }

  return attributes;
}

function tokenizeXml(text: string): XmlTagToken[] {
  const tokens: XmlTagToken[] = [];
  const tagRegex = /<\s*(\/)?\s*([A-Za-z_][A-Za-z0-9_]*)\b[^>]*?(\/)?\s*>/g;
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(text)) !== null) {
    const isClosingTag = match[1] === '/';
    const isSelfClosingTag = match[3] === '/';
    tokens.push({
      name: match[2],
      kind: isClosingTag ? 'close' : (isSelfClosingTag ? 'self' : 'open'),
      start: match.index,
      end: match.index + match[0].length
    });
  }

  return tokens;
}

function assignNodePositions(
  text: string,
  nodes: DefNode[],
  tokens: XmlTagToken[],
  state: { searchOffset: number; tokenIndex: number }
): void {
  for (const node of nodes) {
    if (node.kind === 'text') {
      assignTextNodePosition(text, node, state);
      continue;
    }

    const openToken = consumeNextToken(tokens, state, node.name, ['open', 'self']);
    node.tagStart = openToken.start;
    node.tagEnd = openToken.end;
    node.contentStart = openToken.end;
    state.searchOffset = openToken.end;

    if (openToken.kind === 'self') {
      node.selfClosing = true;
      node.contentEnd = openToken.end;
      node.closeTagStart = openToken.end;
      node.closeTagEnd = openToken.end;
      continue;
    }

    assignNodePositions(text, node.children, tokens, state);

    const closeToken = consumeNextToken(tokens, state, node.name, ['close']);
    node.selfClosing = false;
    node.contentEnd = closeToken.start;
    node.closeTagStart = closeToken.start;
    node.closeTagEnd = closeToken.end;
    state.searchOffset = closeToken.end;
  }
}

function assignTextNodePosition(
  text: string,
  node: DefTextNode,
  state: { searchOffset: number; tokenIndex: number }
): void {
  if (!node.text) {
    node.startOffset = state.searchOffset;
    node.endOffset = state.searchOffset;
    return;
  }

  const startOffset = text.indexOf(node.text, state.searchOffset);
  if (startOffset === -1) {
    node.startOffset = state.searchOffset;
    node.endOffset = state.searchOffset;
    return;
  }

  node.startOffset = startOffset;
  node.endOffset = startOffset + node.text.length;
  state.searchOffset = node.endOffset;
}

function consumeNextToken(
  tokens: XmlTagToken[],
  state: { searchOffset: number; tokenIndex: number },
  name: string,
  kinds: Array<XmlTagToken['kind']>
): XmlTagToken {
  while (state.tokenIndex < tokens.length) {
    const token = tokens[state.tokenIndex];
    state.tokenIndex += 1;

    if (token.name === name && kinds.includes(token.kind)) {
      return token;
    }
  }

  throw new Error(`Failed to locate XML token for <${name}>`);
}

function findFirstElement(nodes: DefNode[]): DefElementNode | null {
  for (const node of nodes) {
    if (node.kind === 'element') {
      return node;
    }
  }

  return null;
}
