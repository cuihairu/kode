// Keep the XML runtime parser vendored so VSIX packaging does not depend on pnpm's node_modules layout.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { XMLParser } = require('../../vendor/fast-xml-parser/fxp.cjs') as {
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

interface ParsedDocumentCacheEntry {
  document: DefDocument;
  usedAtMs: number;
}

const MAX_PARSED_DOCUMENT_CACHE_ENTRIES = 8;
/**
 * IDE-SNP-007: cache byte budget (utf8). Invariant = entries <= 8 and total
 * bytes <= budget; breaching either limit evicts by LRU. The only exception is
 * "a single document exceeding the budget on its own" -- it is kept as a lone
 * entry (the 8-entry cache is not held hostage indefinitely by arbitrarily
 * large text; oversized documents degrade to re-parsing each time).
 */
const MAX_PARSED_DOCUMENT_CACHE_BYTES = 8 * 1024 * 1024;
let parsedDocumentCacheByteBudget = MAX_PARSED_DOCUMENT_CACHE_BYTES;
const parsedDocumentCache = new Map<string, ParsedDocumentCacheEntry>();

function parsedDocumentCacheBytes(): number {
  let bytes = 0;
  for (const text of parsedDocumentCache.keys()) {
    bytes += Buffer.byteLength(text, 'utf8');
  }
  return bytes;
}

function evictParsedDocumentCacheOverflow(): void {
  while (parsedDocumentCache.size > 1
    && (parsedDocumentCache.size > MAX_PARSED_DOCUMENT_CACHE_ENTRIES
      || parsedDocumentCacheBytes() > parsedDocumentCacheByteBudget)) {
    let oldestKey: string | null = null;
    let oldestUsedAtMs = Number.POSITIVE_INFINITY;
    for (const [key, entry] of parsedDocumentCache) {
      if (entry.usedAtMs < oldestUsedAtMs) {
        oldestKey = key;
        oldestUsedAtMs = entry.usedAtMs;
      }
    }
    if (!oldestKey) {
      break;
    }
    parsedDocumentCache.delete(oldestKey);
  }
}

/** Test surface: inject the byte budget (default 8MiB) */
export function setParsedDocumentCacheByteBudgetForTests(bytes: number): void {
  parsedDocumentCacheByteBudget = bytes;
}

/** Test surface: clear the parse cache */
export function clearParsedDocumentCacheForTests(): void {
  parsedDocumentCache.clear();
}

/** RUST-221 production maintenance surface: consumed by kbengine.diagnostics.clearCaches
 * (same body as the test surface; the official alias exists for command wiring, so the
 * test-surface name does not appear at production call sites) */
export function clearParsedDocumentCache(): void {
  parsedDocumentCache.clear();
}

/** IDE-AUD-048/R2-F12: evict global parse-cache entries by source text (content-keyed, not
 *  distinguished by source root). When a root is removed, the source text of documents already
 *  released by that root is handed here, so a long session no longer holds their XML AST;
 *  other roots reusing the same content re-parse on next access (correctness unchanged,
 *  just a cache miss).
 *  Returns the number of entries actually evicted. */
export function releaseParsedDocuments(texts: Iterable<string>): number {
  let removed = 0;
  for (const text of texts) {
    if (parsedDocumentCache.delete(text)) {
      removed += 1;
    }
  }
  return removed;
}

/** Observability surface: current cache entry count and total bytes */
export function getParsedDocumentCacheStats(): { entries: number; bytes: number } {
  return { entries: parsedDocumentCache.size, bytes: parsedDocumentCacheBytes() };
}

/** IDE-REV-031: capacity surface for on-site reports -- entry count / entry cap,
 * measured utf8 bytes / byte budget (budget = current configured value, injectable
 * in tests). Verify from here after fills/evictions; capacity is what the cache
 * actually holds in entries and bytes, not a cumulative hit count. */
export function getParsedDocumentCacheGauge(): {
  entries: number;
  maxEntries: number;
  bytes: number;
  maxBytes: number;
} {
  return {
    entries: parsedDocumentCache.size,
    maxEntries: MAX_PARSED_DOCUMENT_CACHE_ENTRIES,
    bytes: parsedDocumentCacheBytes(),
    maxBytes: parsedDocumentCacheByteBudget
  };
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
  /** Owning parsed document, letting structural nodes retain the original file:line mapping */
  document: DefDocument;
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
  const cachedDocument = parsedDocumentCache.get(text)?.document;
  if (cachedDocument) {
    parsedDocumentCache.set(text, {
      document: cachedDocument,
      usedAtMs: performance.now()
    });
    return cachedDocument;
  }

  const parsed = preserveOrderParser.parse(text) as unknown[];
  const lineStarts = computeLineStarts(text);
  const nodes = normalizePreserveOrderNodes(parsed, null);
  const tokens = tokenizeXml(text);
  const state = {
    searchOffset: 0,
    tokenIndex: 0
  };

  const document: DefDocument = {
    text,
    lineStarts,
    root: findFirstElement(nodes),
    nodes
  };
  setElementDocuments(nodes, document);
  assignNodePositions(text, nodes, tokens, state);

  parsedDocumentCache.set(text, { document, usedAtMs: performance.now() });
  evictParsedDocumentCacheOverflow();
  return document;
}

function setElementDocuments(nodes: DefNode[], document: DefDocument): void {
  for (const node of nodes) {
    if (node.kind !== 'element') {
      continue;
    }
    node.document = document;
    setElementDocuments(node.children, document);
  }
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
  // Batch 92 performance optimization: replaced the per-character scan with
  // indexOf segment jumps, producing a line-start table identical to the
  // per-character version (the offset of the next character after each '\n').
  const lineStarts = [0];
  let from = 0;
  let newline = text.indexOf('\n', from);

  while (newline !== -1) {
    lineStarts.push(newline + 1);
    from = newline + 1;
    newline = text.indexOf('\n', from);
  }

  return lineStarts;
}

function normalizePreserveOrderNodes(
  rawNodes: unknown[],
  parent: DefElementNode | null
): DefNode[] {
  const nodes: DefNode[] = [];

  for (const rawNode of rawNodes) {
    // Unreachable (batch 62 characterization): under preserveOrder, the vendored
    // fxp always yields objects for array elements -- eight input shapes tested
    // (top-level comments / inline comments / xml declarations / doctype / CDATA /
    // processing instructions / plain text / mixed elements) all produce
    // {"#text":...} or {"?pi":...} shaped objects; there are no string or null
    // elements, so this guard has no trigger path.
    /* istanbul ignore start */
    if (!rawNode || typeof rawNode !== 'object') {
      continue;
    }
    /* istanbul ignore stop */

    const attributes = normalizeAttributes((rawNode as Record<string, unknown>)[':@']);

    for (const [name, value] of Object.entries(rawNode)) {
      if (name === ':@') {
        continue;
      }

      if (isNonElementXmlNode(name)) {
        continue;
      }

      if (name === '#text') {
        nodes.push({
          kind: 'text',
          // Unreachable (batch 63 characterization): under preserveOrder, fxp always
          // produces text and CDATA as {"#text":"string"}; a #text tag name is rejected
          // by fxp (Invalid tag name), and non-string values have no way to reach this
          // line; covering only the '' arm on the right requires hand-forging rawNodes,
          // which no public entry point does.
          /* istanbul ignore start */
          text: typeof value === 'string' ? value : '',
          /* istanbul ignore stop */
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
        selfClosing: false,
        document: null as unknown as DefDocument
      };

      // Unreachable (batch 63 characterization): element values from preserveOrder
      // output are always child-node arrays -- empty elements get [], text-bearing
      // ones get [{"#text":...}], mixed/nested ones get longer arrays; scalar element
      // values only appear under configurations not used in this repo such as
      // parseTagValue:true (this file pins {preserveOrder:true,
      // ignoreAttributes:false, trimValues:false, parseTagValue:false}), so the []
      // arm on the right cannot trigger.
      /* istanbul ignore start */
      element.children = Array.isArray(value)
        ? normalizePreserveOrderNodes(value, element)
        : [];
      /* istanbul ignore stop */
      nodes.push(element);
    }
  }

  return nodes;
}

function isNonElementXmlNode(name: string): boolean {
  return name === '#comment'
    || name === '#cdata'
    || name.startsWith('?')
    || name.startsWith('!');
}

function normalizeAttributes(rawAttributes: unknown): Record<string, string> {
  if (!rawAttributes || typeof rawAttributes !== 'object') {
    return {};
  }

  const attributes: Record<string, string> = {};
  for (const [name, value] of Object.entries(rawAttributes)) {
    const normalizedName = name.replace(/^@_/, '');
    // Unreachable (batch 63 characterization): fxp's :@ attribute table leaves every
    // @_ value verbatim as a string under parseTagValue:false (including empty
    // attributes @="" and entity references), and neither the non-string value nor
    // the ?? arms has any trigger path -- the same cause for all three contract
    // guards: the shape reaching the normalization layer is decided entirely by the
    // vendored fxp.
    /* istanbul ignore start */
    attributes[normalizedName] = typeof value === 'string' ? value : String(value ?? '');
    /* istanbul ignore stop */
  }

  return attributes;
}

function tokenizeXml(text: string): XmlTagToken[] {
  const tokens: XmlTagToken[] = [];
  const openTagRegex = /<\s*(\/)?\s*([A-Za-z_][A-Za-z0-9_]*)\b/;
  let cursor = 0;

  // KR-AUD-75: scan '<' one at a time instead of a whole-text regex -- a '>'
  // inside an attribute value (quoted) is not a tag boundary; comment/CDATA
  // sections are skipped wholesale, so pseudo-tags inside them no longer inject
  // tokens and cause positioning desync.
  while (cursor < text.length) {
    const lt = text.indexOf('<', cursor);
    if (lt === -1) break;

    if (text.startsWith('<!--', lt)) {
      const commentEnd = text.indexOf('-->', lt + 4);
      cursor = commentEnd === -1 ? text.length : commentEnd + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const cdataEnd = text.indexOf(']]>', lt + 9);
      cursor = cdataEnd === -1 ? text.length : cdataEnd + 3;
      continue;
    }
    if (text[lt + 1] === '!' || text[lt + 1] === '?') {
      const declEnd = text.indexOf('>', lt + 1);
      cursor = declEnd === -1 ? text.length : declEnd + 1;
      continue;
    }

    const match = openTagRegex.exec(text.slice(lt, lt + 256));
    if (match === null) {
      cursor = lt + 1;
      continue;
    }

    const tagStart = lt;
    let scan = tagStart + match[0].length;
    let quote = '';
    let tagEnd = -1;
    while (scan < text.length) {
      const ch = text[scan];
      if (quote !== '') {
        if (ch === quote) quote = '';
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        tagEnd = scan + 1;
        break;
      }
      scan++;
    }
    if (tagEnd === -1) {
      // Unclosed tag: skip, wait for the next '<'
      cursor = lt + 1;
      continue;
    }

    const isClosingTag = match[1] === '/';
    const isSelfClosingTag = !isClosingTag && /\/\s*>$/.test(text.slice(tagStart, tagEnd));
    tokens.push({
      name: match[2],
      kind: isClosingTag ? 'close' : (isSelfClosingTag ? 'self' : 'open'),
      start: tagStart,
      end: tagEnd
    });
    cursor = tagEnd;
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
