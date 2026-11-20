// RUST-139 批 3 接线(kode-server textDocument/documentSymbol)TS 侧钉子:
// ①桥契约:serveDocumentSymbolsFromRust 的文档门/载荷/回包校验与降级;
// ②provider 切流:Rust 命中 → 段符号来自 Rust 面(golden 真值驱动 + 故意
//   漂移面证真消费);Rust 失败/无门 → 回 TS 既有实现且与基线同树;
// ③面守恒:Rust 面不含面包屑合成根,provider 侧装配不变。
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { makeTextDocument, SymbolKind } from './helpers/vscodeStub';
import { KBEngineDocumentSymbolProvider } from '../src/languageProviders';
import {
  serveDocumentSymbolsFromRust,
  setKodeCoreShadowGate
} from '../src/backend/kodeCoreShadowFaces';
import type { LspDocumentSymbolFace } from '../src/backend/kodeCoreShadowFaces';
import type { KodeCoreGate } from '../src/backend/kodeCoreGate';

const REPO_ROOT = path.resolve(__dirname, '..');

/** 桩 gate:serveInRust 按 scripted 回包;记录调用面供载荷断言。 */
const makeServingGate = (
  scripted: unknown,
  options?: { serving?: boolean; serveError?: boolean }
): {
  gate: KodeCoreGate;
  served: Array<{ method: string; params: unknown }>;
  mirrored: Array<{ uri: string; languageId: string; version: number | undefined; text: string }>;
} => {
  const served: Array<{ method: string; params: unknown }> = [];
  const mirrored: Array<{
    uri: string;
    languageId: string;
    version: number | undefined;
    text: string;
  }> = [];
  const gate = {
    serveFromRust: () => options?.serving ?? true,
    mirrorDocument: async (
      uri: string,
      languageId: string,
      version: number | undefined,
      text: string
    ) => {
      mirrored.push({ uri, languageId, version, text });
    },
    serveInRust: async (method: string, params: unknown) => {
      served.push({ method, params });
      if (options?.serveError) {
        throw new Error('rust serve failed');
      }
      return scripted;
    }
  } as unknown as KodeCoreGate;
  return { gate, served, mirrored };
};

const DEF_DOC = makeTextDocument('<root>\n\t<Properties>\n\t\t<hp>\n\t\t\t<Type>UINT32</Type>\n\t\t</hp>\n\t</Properties>\n</root>\n', {
  fileName: '/tmp/ws/scripts/entity_defs/Avatar.def',
  version: 3
});

describe('serveDocumentSymbolsFromRust 桥契约(①载荷与回包)', () => {
  const FACES: LspDocumentSymbolFace[] = [
    {
      name: 'Properties',
      detail: '',
      kind: 'Struct',
      range: { start: { line: 1, character: 1 }, end: { line: 3, character: 13 } },
      selectionRange: { start: { line: 1, character: 1 }, end: { line: 1, character: 13 } },
      children: [
        {
          name: 'hp',
          detail: '',
          kind: 'Field',
          range: { start: { line: 2, character: 2 }, end: { line: 2, character: 6 } },
          selectionRange: { start: { line: 2, character: 2 }, end: { line: 2, character: 4 } },
          children: []
        }
      ]
    }
  ];

  it('ok:先镜像文档再请求,载荷只有 textDocument.uri,面原样透传', async () => {
    const { gate, served, mirrored } = makeServingGate(FACES);
    setKodeCoreShadowGate(gate);
    const result = await serveDocumentSymbolsFromRust(DEF_DOC);
    expect(result).toEqual(FACES);
    expect(mirrored).toEqual([
      {
        uri: '/tmp/ws/scripts/entity_defs/Avatar.def',
        languageId: 'kbengine-def',
        version: 3,
        text: DEF_DOC.getText()
      }
    ]);
    expect(served).toEqual([
      {
        method: 'textDocument/documentSymbol',
        params: { textDocument: { uri: '/tmp/ws/scripts/entity_defs/Avatar.def' } }
      }
    ]);
    setKodeCoreShadowGate(null);
  });

  it('无门/非服务轨道/python 文档 → null 且零请求', async () => {
    setKodeCoreShadowGate(null);
    expect(await serveDocumentSymbolsFromRust(DEF_DOC)).toBeNull();
    const { gate, served } = makeServingGate(FACES, { serving: false });
    setKodeCoreShadowGate(gate);
    expect(await serveDocumentSymbolsFromRust(DEF_DOC)).toBeNull();
    const pyDoc = makeTextDocument('class Avatar:\n    pass\n', {
      fileName: '/tmp/ws/scripts/cell/Avatar.py',
      languageId: 'python'
    });
    expect(await serveDocumentSymbolsFromRust(pyDoc)).toBeNull();
    expect(served).toEqual([]);
    setKodeCoreShadowGate(null);
  });

  it('应答非数组/条目畸形(kind 越界、区间缺位、children 非数组)→ 整面作废', async () => {
    const badCases: unknown[] = [
      null,
      { symbols: FACES },
      [{ ...FACES[0], kind: 'Namespace' }],
      [{ ...FACES[0], range: { start: { line: 1, character: 1 } } }],
      [{ ...FACES[0], children: 'nope' }],
      [{ ...FACES[0], children: [{ ...FACES[0].children[0], kind: 'Event' }] }]
    ];
    for (const bad of badCases) {
      const { gate } = makeServingGate(bad);
      setKodeCoreShadowGate(gate);
      expect(await serveDocumentSymbolsFromRust(DEF_DOC)).toBeNull();
      setKodeCoreShadowGate(null);
    }
  });

  it('取消位先置 → 零请求直接回落', async () => {
    const { gate, served } = makeServingGate(FACES);
    setKodeCoreShadowGate(gate);
    expect(await serveDocumentSymbolsFromRust(DEF_DOC, () => true)).toBeNull();
    expect(served).toEqual([]);
    setKodeCoreShadowGate(null);
  });
});

// ---- ②provider 切流面 ------------------------------------------------------

const SECTION_KINDS = new Set([SymbolKind.Struct, SymbolKind.Class]);

/** 段容器视图:面包屑合成根(非段 kind 头节点)在场时取其段 children */
const sectionSymbols = (symbols: vscode.DocumentSymbol[]): vscode.DocumentSymbol[] => {
  const [head] = symbols;
  if (symbols.length === 1 && head && !SECTION_KINDS.has(head.kind)) {
    return head.children.filter(child => SECTION_KINDS.has(child.kind));
  }
  return symbols;
};

/** vscode.DocumentSymbol → 与 Rust face 同形的纯视图(对拍媒介) */
const toFace = (symbol: vscode.DocumentSymbol): LspDocumentSymbolFace => {
  const kind: LspDocumentSymbolFace['kind'] =
    symbol.kind === SymbolKind.Struct
      ? 'Struct'
      : symbol.kind === SymbolKind.Class
        ? 'Class'
        : symbol.kind === SymbolKind.Field
          ? 'Field'
          : 'Method';
  const positionFace = (position: { line: number; character: number }) => ({
    line: position.line,
    character: position.character
  });
  return {
    name: symbol.name,
    detail: symbol.detail ?? '',
    kind,
    range: {
      start: positionFace(symbol.range.start),
      end: positionFace(symbol.range.end)
    },
    selectionRange: {
      start: positionFace(symbol.selectionRange.start),
      end: positionFace(symbol.selectionRange.end)
    },
    children: symbol.children.map(toFace)
  };
};

interface GoldenFile {
  file: string;
  kind: string;
  symbols: LspDocumentSymbolFace[];
}

const GOLDEN = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'crates/kode-server/tests/golden/document-symbols-parity.json'), 'utf8')
) as { files: GoldenFile[] };

/** golden 真值驱动的语料文档(读真盘文本,与 Rust dump 同输入) */
const corpusDoc = (entry: GoldenFile): vscode.TextDocument => {
  const text = fs.readFileSync(path.join(REPO_ROOT, entry.file), 'utf8');
  return makeTextDocument(text, { fileName: path.join(REPO_ROOT, entry.file), version: 7 }) as never;
};

describe('provider 切流(②Rust 命中/失败回落)', () => {
  it('Rust 命中:golden 真值面 → provider 段符号逐点深等(Rust dump 与 TS 复算同树)', async () => {
    const provider = new KBEngineDocumentSymbolProvider();
    // 取有符号段且含方法段前 3 个语料文件(面包屑/空档两种形态都覆盖)。
    const entries = GOLDEN.files.filter(entry => entry.symbols.length > 0);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries.slice(0, 3)) {
      const { gate } = makeServingGate(entry.symbols);
      setKodeCoreShadowGate(gate);
      const symbols = await provider.provideDocumentSymbols(corpusDoc(entry), undefined);
      setKodeCoreShadowGate(null);
      expect(symbols).not.toBeNull();
      expect(sectionSymbols(symbols!).map(toFace)).toEqual(entry.symbols);
    }
  });

  it('Rust 面被真消费:故意漂移的合法面原样出镜(证明不是 TS 兜底自算)', async () => {
    const entry = GOLDEN.files.find(file => file.symbols.length > 0)!;
    const drifted: LspDocumentSymbolFace[] = JSON.parse(JSON.stringify(entry.symbols));
    drifted[0].children.push({
      name: 'RUST_ONLY_MARKER',
      detail: '',
      kind: 'Field',
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      children: []
    });
    const { gate } = makeServingGate(drifted);
    setKodeCoreShadowGate(gate);
    const symbols = await new KBEngineDocumentSymbolProvider().provideDocumentSymbols(
      corpusDoc(entry),
      undefined
    );
    setKodeCoreShadowGate(null);
    const names = sectionSymbols(symbols!)[0].children.map(child => child.name);
    expect(names).toContain('RUST_ONLY_MARKER');
  });

  it('Rust 失败/无门 → 回 TS 既有实现,结果与无门基线同树', async () => {
    const entry = GOLDEN.files.find(file => file.symbols.length > 0)!;
    const provider = new KBEngineDocumentSymbolProvider();
    setKodeCoreShadowGate(null);
    const baseline = await provider.provideDocumentSymbols(corpusDoc(entry), undefined);
    const { gate } = makeServingGate(null, { serveError: true });
    setKodeCoreShadowGate(gate);
    const fallback = await provider.provideDocumentSymbols(corpusDoc(entry), undefined);
    setKodeCoreShadowGate(null);
    expect(baseline).not.toBeNull();
    expect(sectionSymbols(fallback!).map(toFace)).toEqual(sectionSymbols(baseline!).map(toFace));
  });
});
