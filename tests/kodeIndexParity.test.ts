// kode2 PR-007 对拍门禁:用 TS 现有 defParser 原语复算 Rust 侧生成的符号
// golden(crates/kode-index/tests/golden/symbol-parity.json),逐文件逐符号比对
// (实体/属性/方法/类型/别名/组件能力面;本文件只读 fixture 与 golden,不改 src/,
// 对拍语义 = 双实现同输入同符号面)。与 kodeParserParity.test.ts 同构。
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  DefDocument,
  DefElementNode,
  getDirectChildElement,
  getDirectChildElements,
  getElementText,
  getLineNumberAt,
  isElementNode,
  parseDefDocument
} from '../src/defParser';

// 与 Rust model::canonical_tag 同口径:小写 + 去空格/下划线/连字符
const canonicalTagOf = (name: string): string =>
  name.toLowerCase().replace(/[\s_-]/g, '');

const REPO_ROOT = path.resolve(__dirname, '..');
const GOLDEN_PATH = path.join(REPO_ROOT, 'crates/kode-index/tests/golden/symbol-parity.json');
const CORPORA = [
  'tests/fixtures/kbengine-demo-assets',
  'tests/fixtures/parity-project',
  'tests/fixtures/electron-ws',
  'tests/fixtures/kbengine-tpl-scripts'
] as const;

interface GoldenSymbol {
  name: string;
  kind: 'entity' | 'property' | 'method' | 'type' | 'alias' | 'component';
  line: number;
  facet: 'base' | 'cell' | 'client' | null;
  detail: string | null;
}

interface GoldenFile {
  file: string;
  kind: 'def' | 'entities' | 'types' | 'alias';
  symbols: GoldenSymbol[];
}

interface SymbolRecord {
  name: string;
  kind: GoldenSymbol['kind'];
  line: number;
  facet: GoldenSymbol['facet'];
  detail: string | null;
}

const loadGolden = (): { fileCount: number; symbolCount: number; files: GoldenFile[] } =>
  JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));

// ---- defParser 原语上的小助手(与 Rust 抽取口径逐条对应) ----

const firstTextToken = (node: DefElementNode): string | undefined => {
  const token = getElementText(node).trim().split(/\s+/)[0];
  return token ? token : undefined;
};

const scalarChildByCanon = (
  document: DefDocument,
  node: DefElementNode,
  canon: string
): string | undefined => {
  for (const child of getDirectChildElements(node)) {
    if (canonicalTagOf(child.name) === canon) {
      const value = getElementText(child).trim();
      if (value) {
        return value;
      }
    }
  }
  return undefined;
};

const directTextTokens = (node: DefElementNode): string[] =>
  node.children
    .filter(c => !isElementNode(c))
    .map(c => ('text' in c ? c.text.trim() : ''))
    .filter(Boolean);

const sectionByCanon = (
  document: DefDocument,
  root: DefElementNode,
  canon: string
): DefElementNode[] => {
  const section = getDirectChildElements(root).find(n => canonicalTagOf(n.name) === canon);
  return section ? getDirectChildElements(section) : [];
};

const defEntityName = (file: string): string =>
  path.basename(file).replace(/\.def$/i, '');

// ---- 各文件种类的符号抽取(与 kode_index::symbol::extract_records 逐字段一致) ----

const symbolsOfDef = (file: string, text: string): SymbolRecord[] => {
  const document = parseDefDocument(text);
  const root = document.root;
  const out: SymbolRecord[] = [{ name: defEntityName(file), kind: 'entity', line: 1, facet: null, detail: null }];
  if (!root) {
    return out;
  }
  for (const prop of sectionByCanon(document, root, 'properties')) {
    const typeNode = getDirectChildElements(prop).find(n => canonicalTagOf(n.name) === 'type');
    out.push({
      name: prop.name,
      kind: 'property',
      line: getLineNumberAt(document, prop.tagStart),
      facet: null,
      detail: typeNode ? firstTextToken(typeNode) ?? null : null
    });
  }
  for (const comp of sectionByCanon(document, root, 'components')) {
    out.push({
      name: comp.name,
      kind: 'component',
      line: getLineNumberAt(document, comp.tagStart),
      facet: null,
      detail: scalarChildByCanon(document, comp, 'type') ?? null
    });
  }
  const facets: Array<['base' | 'cell' | 'client', string]> = [
    ['base', 'basemethods'],
    ['cell', 'cellmethods'],
    ['client', 'clientmethods']
  ];
  for (const [facet, canon] of facets) {
    for (const method of sectionByCanon(document, root, canon)) {
      const args = getDirectChildElements(method)
        .filter(arg => canonicalTagOf(arg.name) === 'arg')
        .map(arg => getElementText(arg).trim())
        .filter(Boolean);
      out.push({
        name: method.name,
        kind: 'method',
        line: getLineNumberAt(document, method.tagStart),
        facet,
        detail: args.length > 0 ? args.join(',') : null
      });
    }
  }
  return out;
};

const symbolsOfEntities = (text: string): SymbolRecord[] => {
  const document = parseDefDocument(text);
  const root = document.root;
  const out: SymbolRecord[] = [];
  if (root) {
    for (const node of getDirectChildElements(root)) {
      if (node.name === 'root') {
        continue;
      }
      out.push({ name: node.name, kind: 'entity', line: getLineNumberAt(document, node.tagStart), facet: null, detail: null });
    }
  }
  return out;
};

const symbolsOfTypes = (text: string): SymbolRecord[] => {
  const document = parseDefDocument(text);
  const root = document.root;
  const out: SymbolRecord[] = [];
  if (root) {
    for (const item of getDirectChildElements(root)) {
      // 属性式条目回落 `type` 属性(与 Rust parse_types 同口径;PR-012 门 §1.3-①);
      // 纯空条目仍不产符号。
      const directive = firstTextToken(item) ?? ((item.attributes['type'] ?? '').trim() || undefined);
      if (!directive) {
        continue;
      }
      const detail = directive === 'FIXED_DICT' ? 'fixed_dict' : directive === 'ARRAY' ? 'array' : 'builtin';
      out.push({ name: item.name, kind: 'type', line: getLineNumberAt(document, item.tagStart), facet: null, detail });
    }
  }
  return out;
};

const symbolsOfAlias = (text: string): SymbolRecord[] => {
  // 与 Rust parse_alias / TS buildAliasXmlCustomTypeInfo 同口径:
  // 无 Type 子、无非 Type 子元素、直接文本全空白 → 不产符号(属性式跳过)。
  const document = parseDefDocument(text);
  const root = document.root;
  const out: SymbolRecord[] = [];
  if (root) {
    for (const node of getDirectChildElements(root)) {
      const typeChild = getDirectChildElement(node, 'Type');
      const otherChild = getDirectChildElements(node).find(n => n.name !== 'Type');
      const texts = directTextTokens(node);
      if (!typeChild && !otherChild && texts.length === 0) {
        continue;
      }
      let detail: string;
      if (typeChild) {
        detail = directTextTokens(typeChild)[0] ?? 'ALIAS';
      } else if (otherChild) {
        detail = otherChild.name;
      } else {
        detail = texts[0] ?? 'ALIAS';
      }
      out.push({ name: node.name, kind: 'alias', line: getLineNumberAt(document, node.tagStart), facet: null, detail });
    }
  }
  return out;
};

const symbolsOf = (kind: GoldenFile['kind'], file: string, text: string): SymbolRecord[] => {
  switch (kind) {
    case 'def':
      return symbolsOfDef(file, text);
    case 'entities':
      return symbolsOfEntities(text);
    case 'types':
      return symbolsOfTypes(text);
    case 'alias':
      return symbolsOfAlias(text);
  }
};

const computeCorpusSymbols = (): Map<string, SymbolRecord[]> => {
  const out = new Map<string, SymbolRecord[]>();
  const walk = (dir: string, rel: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const childPath = path.join(dir, entry.name);
      const relChild = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(childPath, relChild);
        continue;
      }
      const kind = entry.name.endsWith('.def')
        ? 'def'
        : entry.name === 'entities.xml'
          ? 'entities'
          : entry.name === 'types.xml'
            ? 'types'
            : entry.name === 'alias.xml'
              ? 'alias'
              : null;
      if (!kind) {
        continue;
      }
      out.set(relChild, symbolsOf(kind, relChild, fs.readFileSync(childPath, 'utf8')));
    }
  };
  for (const corpus of CORPORA) {
    walk(path.join(REPO_ROOT, corpus), corpus);
  }
  return out;
};

describe('kode-index 与 TS defParser 符号面对拍(PR-007)', () => {
  const golden = loadGolden();
  const computed = computeCorpusSymbols();

  it('golden 覆盖面与语料一致(文件集合相同)', () => {
    expect(golden.files.length).toBe(computed.size);
    for (const file of golden.files) {
      expect(computed.has(file.file), `语料缺少 ${file.file}`).toBe(true);
    }
  });

  it('逐文件逐符号一致(名称/种类/行号/分面/详注)', () => {
    const mismatches: string[] = [];
    let total = 0;
    let matched = 0;
    for (const file of golden.files) {
      const actual = computed.get(file.file) ?? [];
      total += file.symbols.length;
      const maxLength = Math.max(file.symbols.length, actual.length);
      for (let i = 0; i < maxLength; i += 1) {
        const expected = file.symbols[i];
        const got = actual[i];
        if (!expected || !got || expected.name !== got.name || expected.kind !== got.kind
          || expected.line !== got.line || expected.facet !== got.facet || expected.detail !== got.detail) {
          mismatches.push(`${file.file}[${i}]: golden=${JSON.stringify(expected)} ts=${JSON.stringify(got ?? null)}`);
          continue;
        }
        matched += 1;
      }
    }
    if (mismatches.length > 0) {
      console.error(`对拍不一致 ${mismatches.length}/${total}:\n${mismatches.slice(0, 20).join('\n')}`);
    }
    console.error(`符号对拍: ${matched}/${total} = ${((matched / total) * 100).toFixed(1)}%`);
    expect(matched).toBe(total);
    expect(matched).toBe(golden.symbolCount);
    expect(mismatches).toStrictEqual([]);
  });
});
