// kode2 Phase2 document symbols 对拍门禁(RUST-139 批 1):用 TS defParser
// 原语复算 Rust 侧生成的 document symbols golden(crates/kode-server/tests/
// golden/document-symbols-parity.json),逐文件逐符号深等比对(def Outline
// 面;本文件只读 fixture 与 golden,不改 src/)。与 kodeReferencesParity
// 同构:生产 TS 面(KBEngineDocumentSymbolProvider,IDE-NAV-005)逐点镜像。
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { DefElementNode, parseDefDocument } from '../src/backend/defParser';

const REPO_ROOT = path.resolve(__dirname, '..');
const GOLDEN_PATH = path.join(REPO_ROOT, 'crates/kode-server/tests/golden/document-symbols-parity.json');
const CORPORA = [
  'tests/fixtures/kbengine-demo-assets',
  'tests/fixtures/parity-project',
  'tests/fixtures/electron-ws',
  'tests/fixtures/kbengine-tpl-scripts'
] as const;

interface CorpusFile {
  file: string;
  kind: 'def' | 'entities' | 'types' | 'alias';
  text: string;
  root: DefElementNode | null;
}

const collectDefCorpus = (): CorpusFile[] => {
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
        const parsed = parseDefDocument(text);
        out.push({ file: relChild, kind, text, root: parsed.root ?? null });
      }
    }
  };
  for (const corpus of CORPORA) {
    walk(path.join(REPO_ROOT, corpus), corpus);
  }
  return out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
};

const offsetToPos = (text: string, offset: number): { line: number; character: number } => {
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

// TS toSectionName 同构:8 规范段名精确匹配(大小写敏感)。
const toSectionName = (name: string): string | null => {
  switch (name) {
    case 'Parent':
    case 'Interfaces':
    case 'Components':
    case 'Properties':
    case 'BaseMethods':
    case 'CellMethods':
    case 'ClientMethods':
    case 'Volatile':
      return name;
    default:
      return null;
  }
};

// TS DEF_SYMBOL_SECTIONS 同构。
const DEF_SYMBOL_SECTIONS = new Set(['Properties', 'BaseMethods', 'CellMethods', 'ClientMethods']);

interface SymbolFace {
  name: string;
  detail: string;
  kind: 'Struct' | 'Class' | 'Field' | 'Method';
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  selectionRange: { start: { line: number; character: number }; end: { line: number; character: number } };
  children: SymbolFace[];
}

// TS elementFullRange 同构:开标签头 → 闭合标签尾;自闭合到开标签尾。
const fullRange = (text: string, node: DefElementNode): SymbolFace['range'] => ({
  start: offsetToPos(text, node.tagStart),
  end: offsetToPos(text, node.selfClosing ? node.tagEnd : node.closeTagEnd)
});

// TS elementTagRange 同构:开标签整体跨度(恒 ⊆ range)。
const tagRange = (text: string, node: DefElementNode): SymbolFace['selectionRange'] => ({
  start: offsetToPos(text, node.tagStart),
  end: offsetToPos(text, node.tagEnd)
});

// TS provideDocumentSymbols 同构:四段容器 + 段内直接元素子节点;
// 成员不再下钻(new DocumentSymbol 默认 children=[])。
const documentSymbolsMirror = (file: CorpusFile): SymbolFace[] | null => {
  if (!file.root) {
    return null;
  }
  const symbols: SymbolFace[] = [];
  for (const child of file.root.children) {
    if (child.kind !== 'element') {
      continue;
    }
    const sectionName = toSectionName(child.name);
    if (!sectionName || !DEF_SYMBOL_SECTIONS.has(sectionName)) {
      continue;
    }
    const isProperties = sectionName === 'Properties';
    symbols.push({
      name: sectionName,
      detail: '',
      kind: isProperties ? 'Struct' : 'Class',
      range: fullRange(file.text, child),
      selectionRange: tagRange(file.text, child),
      children: child.children
        .filter((member): member is DefElementNode => member.kind === 'element')
        .map(member => ({
          name: member.name,
          detail: '',
          kind: isProperties ? 'Field' : 'Method',
          range: fullRange(file.text, member),
          selectionRange: tagRange(file.text, member),
          children: []
        }))
    });
  }
  return symbols;
};

const countSymbols = (symbols: SymbolFace[]): number =>
  symbols.reduce((sum, s) => sum + 1 + countSymbols(s.children), 0);

describe('kode2 Phase2 document symbols 对拍(Rust golden ↔ TS 复算)', () => {
  const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));
  const corpus = collectDefCorpus();
  const defFiles = corpus.filter(file => file.kind === 'def');

  it('golden 语料与 TS 收集同集(def 文件序一致)', () => {
    expect(golden.files.map((f: { file: string }) => f.file)).toEqual(defFiles.map(f => f.file));
  });

  it('逐文件逐符号深等(Outline 面)', () => {
    let compared = 0;
    for (let i = 0; i < defFiles.length; i += 1) {
      const expected = documentSymbolsMirror(defFiles[i]) ?? [];
      const actual = golden.files[i].symbols ?? [];
      expect(actual).toEqual(expected);
      compared += countSymbols(expected);
    }
    expect(compared).toBe(golden.symbolCount);
  });

  it('面定义护栏:符号 kind 与段归属一致且 selectionRange ⊆ range', () => {
    for (const file of golden.files) {
      for (const section of file.symbols) {
        expect(DEF_SYMBOL_SECTIONS.has(section.name)).toBe(true);
        expect(section.detail).toBe('');
        if (section.name === 'Properties') {
          expect(section.kind).toBe('Struct');
          for (const member of section.children) {
            expect(member.kind).toBe('Field');
            expect(member.children).toEqual([]);
          }
        } else {
          expect(section.kind).toBe('Class');
          for (const member of section.children) {
            expect(member.kind).toBe('Method');
            expect(member.children).toEqual([]);
          }
        }
        const inside = (outer: SymbolFace['range'], inner: SymbolFace['selectionRange']): boolean =>
          inner.start.line > outer.start.line
          || (inner.start.line === outer.start.line && inner.start.character >= outer.start.character);
        expect(inside(section.range, section.selectionRange)).toBe(true);
      }
    }
  });
});
