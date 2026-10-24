// kode2 Phase2 首片对拍门禁:用 parseDefDocument + kbengineMetadata 词表
// 复算 Rust 侧生成的 diagnostics golden(crates/kode-server/tests/golden/
// diagnostics-parity.json),逐文件逐条比对(消息/严重级/区间/顺序;
// 对拍面定义与划归边界见 docs/kode2/phase2-slice-a.md §面定义)。
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  DefElementNode,
  getDirectChildElement,
  getDirectChildElements,
  getElementText,
  parseDefDocument
} from '../src/defParser';
import { KBENGINE_FLAGS, KBENGINE_TYPES } from '../src/kbengineMetadata';

const REPO_ROOT = path.resolve(__dirname, '..');
const GOLDEN_PATH = path.join(REPO_ROOT, 'crates/kode-server/tests/golden/diagnostics-parity.json');
const CORPORA = [
  'tests/fixtures/kbengine-demo-assets',
  'tests/fixtures/parity-project',
  'tests/fixtures/electron-ws',
  'tests/fixtures/kbengine-tpl-scripts'
] as const;

// ---- 语料收集(与 Rust collect_corpus 同序) -------------------------------

interface CorpusFile {
  file: string;
  kind: 'def' | 'entities' | 'types' | 'alias';
  text: string;
  parsed: ReturnType<typeof parseDefDocument>;
}

const collectCorpus = (): CorpusFile[] => {
  const out: CorpusFile[] = [];
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
      if (kind) {
        const text = fs.readFileSync(childPath, 'utf8');
        out.push({ file: relChild, kind, text, parsed: parseDefDocument(text) });
      }
    }
  };
  for (const corpus of CORPORA) {
    walk(path.join(REPO_ROOT, corpus), corpus);
  }
  return out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
};

// ---- 词表(与 kbengineMetadata / Rust diagnostics.rs 同源) ----------------

const KNOWN_FLAGS = new Set(KBENGINE_FLAGS.map(flag => flag.name));
const BUILTIN_TYPES = new Set(KBENGINE_TYPES.map(type => type.name));
const DETAIL_LEVELS = new Set(['NEAR', 'MEDIUM', 'FAR']);
const BASE_FLAGS = new Set(['BASE', 'BASE_AND_CLIENT']);
const CELL_FLAGS = new Set([
  'CELL_PUBLIC', 'CELL_PRIVATE', 'ALL_CLIENTS', 'CELL_PUBLIC_AND_OWN', 'OWN_CLIENT', 'OTHER_CLIENTS'
]);
const CLIENT_FLAGS = new Set([
  'BASE_AND_CLIENT', 'ALL_CLIENTS', 'CELL_PUBLIC_AND_OWN', 'OWN_CLIENT', 'OTHER_CLIENTS'
]);
const SCOPE_LABELS: Record<string, string> = { base: 'Base', cell: 'Cell', client: 'Client' };
const SECTION_LABELS: Record<string, string> = {
  Parent: '父类区块',
  Interfaces: '接口区块',
  Components: '组件区块',
  Properties: '属性区块',
  BaseMethods: '方法区块',
  CellMethods: '方法区块',
  ClientMethods: '方法区块',
  Volatile: '易变同步区块'
};
const ALLOWED_SECTIONS = new Set(Object.keys(SECTION_LABELS));

// ---- 语料类型环境(已入库并集口径,与 Rust type_context 同) ----------------

interface CorpusEnv {
  entityTypes: Set<string>;
  customTypes: Set<string>;
}

const buildEnv = (corpus: CorpusFile[]): CorpusEnv => {
  const env: CorpusEnv = { entityTypes: new Set(), customTypes: new Set() };
  for (const file of corpus) {
    const root = file.parsed.root;
    if (!root) {
      continue;
    }
    if (file.kind === 'entities') {
      for (const child of getDirectChildElements(root)) {
        if (child.name !== 'root') {
          env.entityTypes.add(child.name);
        }
      }
    }
    if (file.kind === 'types') {
      for (const child of getDirectChildElements(root)) {
        const textDirective = getElementText(child).trim().split(/\s+/)[0] ?? '';
        const attrDirective = (child.attributes as Record<string, string> | undefined)?.type?.trim() ?? '';
        if (textDirective || attrDirective) {
          env.customTypes.add(child.name);
        }
      }
    }
    if (file.kind === 'alias') {
      for (const child of getDirectChildElements(root)) {
        const typeChild = getDirectChildElement(child, 'Type');
        const otherChild = getDirectChildElements(child).find(n => n.name !== 'Type');
        const directText = getElementText(child).trim().split(/\s+/)[0] ?? '';
        if (typeChild || otherChild || directText) {
          env.customTypes.add(child.name);
        }
      }
    }
  }
  return env;
};

// ---- 坐标换算 --------------------------------------------------------------

interface Pos { line: number; character: number }
interface Face { range: { start: Pos; end: Pos }; severity: number; message: string }

const offsetToPos = (text: string, offset: number): Pos => {
  const clamped = Math.min(offset, text.length);
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < clamped; i += 1) {
    if (text[i] === '\n') {
      line += 1;
      lineStart = i + 1;
    }
  }
  let character = 0;
  for (let i = lineStart; i < clamped; i += 1) {
    character += text.charCodeAt(i) >= 0x10000 ? 2 : 1;
  }
  return { line, character };
};

const nodeRange = (text: string, node: DefElementNode) => ({
  start: offsetToPos(text, node.tagStart),
  end: offsetToPos(text, node.closeTagEnd)
});

const valueRange = (text: string, node: DefElementNode, value: string) => {
  const found = text.indexOf(value, node.contentStart);
  if (found >= 0 && found <= node.contentEnd) {
    return { start: offsetToPos(text, found), end: offsetToPos(text, found + value.length) };
  }
  return { start: offsetToPos(text, node.contentStart), end: offsetToPos(text, node.contentEnd) };
};

const nodeValue = (node: DefElementNode): string => getElementText(node).trim();

const scalarChildValue = (node: DefElementNode, tagName: string): string | undefined => {
  const child = getDirectChildElement(node, tagName);
  if (!child) {
    return undefined;
  }
  const value = getElementText(child).trim();
  return value || undefined;
};

// ---- 面复算(与 Rust diagnostics.rs 同序同文案) ----------------------------

const normalizePropertyFlag = (raw: string | undefined): string | undefined => {
  const normalized = raw?.trim().toUpperCase();
  if (!normalized) {
    return undefined;
  }
  switch (normalized) {
    case 'CELL_AND_CLIENT':
      return 'CELL_PUBLIC_AND_OWN';
    case 'CELL_AND_CLIENTS':
      return 'ALL_CLIENTS';
    case 'CELL_AND_OTHER_CLIENTS':
      return 'OTHER_CLIENTS';
    default:
      return normalized;
  }
};

const propertyScopes = (node: DefElementNode): string[] => {
  const normalized = normalizePropertyFlag(scalarChildValue(node, 'Flags'));
  if (!normalized) {
    return [];
  }
  const scopes: string[] = [];
  if (BASE_FLAGS.has(normalized)) {
    scopes.push('base');
  }
  if (CELL_FLAGS.has(normalized)) {
    scopes.push('cell');
  }
  if (CLIENT_FLAGS.has(normalized)) {
    scopes.push('client');
  }
  return scopes;
};

const wordTokens = (value: string): string[] => {
  const matches = value.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g);
  return matches ?? [];
};

const recomputeDiagnostics = (file: CorpusFile, env: CorpusEnv): Face[] => {
  const out: Face[] = [];
  const { text, parsed } = file;
  const root = parsed.root;
  if (!root) {
    return out;
  }

  // ①标量扫描:全树 DFS 先序,Type/Flags/DetailLevel 三分支互斥。
  const visit = (node: DefElementNode): void => {
    if (node.name === 'Type') {
      const value = nodeValue(node);
      if (value && getDirectChildElements(node).length === 0) {
        for (const candidate of wordTokens(value)) {
          if (BUILTIN_TYPES.has(candidate) || env.entityTypes.has(candidate) || env.customTypes.has(candidate)) {
            continue;
          }
          out.push({
            range: valueRange(text, node, candidate),
            severity: 1,
            message: `自定义类型 ${candidate} 未在 types.xml 中注册，请先在 types.xml 注册后再引用`
          });
        }
      }
    } else if (node.name === 'Flags') {
      const raw = nodeValue(node);
      const normalized = raw.toUpperCase();
      if (normalized && !KNOWN_FLAGS.has(normalized)) {
        out.push({
          range: valueRange(text, node, raw),
          severity: 1,
          message: `未知的 KBEngine Flags 值: ${raw}。KBEngine 源码按单个映射值解析 <Flags>，不支持此写法。`
        });
      }
    } else if (node.name === 'DetailLevel') {
      const value = nodeValue(node);
      if (value && !DETAIL_LEVELS.has(value)) {
        out.push({
          range: valueRange(text, node, value),
          severity: 1,
          message: `未知的 DetailLevel: ${value}`
        });
      }
    }
    for (const child of getDirectChildElements(node)) {
      visit(child);
    }
  };
  visit(root);

  // ②结构扫描:按段白名单逐段,先重复判定再属性结构判定。
  for (const section of getDirectChildElements(root)) {
    const label = SECTION_LABELS[section.name];
    if (!label || !ALLOWED_SECTIONS.has(section.name)) {
      continue;
    }
    const isProperties = section.name === 'Properties';
    const seenSymbols = new Map<string, { start: Pos; end: Pos }>();
    const seenScopes = new Map<string, Map<string, { start: Pos; end: Pos }>>();
    for (const symbol of getDirectChildElements(section)) {
      const symbolRange = nodeRange(text, symbol);
      if (isProperties) {
        const scopes = propertyScopes(symbol);
        if (scopes.length > 0) {
          const known = seenScopes.get(symbol.name) ?? new Map<string, { start: Pos; end: Pos }>();
          for (const scope of scopes) {
            const existing = known.get(scope);
            if (!existing) {
              continue;
            }
            out.push({
              range: symbolRange,
              severity: 2,
              message: `${label}中存在重复定义: ${symbol.name} (${SCOPE_LABELS[scope]})`
            });
            out.push({
              range: existing,
              severity: 3,
              message: `${symbol.name} 在 ${label} 中已在 ${SCOPE_LABELS[scope]} 作用域定义`
            });
          }
          for (const scope of scopes) {
            if (!known.has(scope)) {
              known.set(scope, symbolRange);
            }
          }
          seenScopes.set(symbol.name, known);
        }
      } else if (seenSymbols.has(symbol.name)) {
        const existing = seenSymbols.get(symbol.name)!;
        out.push({
          range: symbolRange,
          severity: 2,
          message: `${label}中存在重复定义: ${symbol.name}`
        });
        out.push({
          range: existing,
          severity: 3,
          message: `${symbol.name} 在 ${label} 中已定义`
        });
      } else {
        seenSymbols.set(symbol.name, symbolRange);
      }
      if (isProperties) {
        if (!getDirectChildElement(symbol, 'Type')) {
          out.push({
            range: symbolRange,
            severity: 1,
            message: `属性 ${symbol.name} 缺少 <Type> 定义`
          });
        }
        if (!getDirectChildElement(symbol, 'Flags')) {
          out.push({
            range: symbolRange,
            severity: 1,
            message: `属性 ${symbol.name} 缺少 <Flags> 定义`
          });
        }
      }
    }
  }
  return out;
};

// ---- 门禁 -------------------------------------------------------------------

describe('kode2 Phase2 diagnostics 对拍(Rust golden ↔ TS 复算)', () => {
  const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));
  const corpus = collectCorpus().filter(file => file.kind === 'def');
  const env = buildEnv(collectCorpus());

  it('golden 语料与 TS 收集同集(.def 文件序一致)', () => {
    expect(golden.files.map((f: { file: string }) => f.file)).toEqual(corpus.map(f => f.file));
  });

  it('逐文件逐条比对(validateDocument 语料子集面)', () => {
    let compared = 0;
    for (let i = 0; i < corpus.length; i += 1) {
      const expected = recomputeDiagnostics(corpus[i], env);
      const actual = golden.files[i].diagnostics ?? [];
      expect(actual).toEqual(expected);
      compared += actual.length;
    }
    expect(compared).toBe(golden.diagnosticCount);
  });

  it('面定义护栏:消息均为 TS validateDocument 同源文案族', () => {
    const families = [
      /未在 types\.xml 中注册/,
      /未知的 KBEngine Flags 值/,
      /未知的 DetailLevel/,
      /中存在重复定义/,
      /缺少 <Type> 定义/,
      /缺少 <Flags> 定义/,
      /中已(在 .* 作用域)?定义/
    ];
    for (const file of golden.files) {
      for (const diagnostic of file.diagnostics ?? []) {
        expect(families.some(family => family.test(diagnostic.message))).toBe(true);
      }
    }
  });
});
