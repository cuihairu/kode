/**
 * KODE-DICTTYPE-001: consumer surface wiring (hover / inlay / completion).
 * Prove-red perturbations (restore after each run):
 *   R1: remove the hover arm in KBEngineHoverProvider → hover case fails.
 *   R2: remove the inlay collect call → inlay case fails.
 *   R3: remove the completion arm → completion case fails.
 */
import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { DictValueTypeStore } from '../src/dictValueTypes';
import { KBEngineHoverProvider } from '../src/languageProviders/hover';
import { KBEngineCompletionProvider } from '../src/languageProviders/completion';
import { PythonTypeInlayHintsProvider } from '../src/typeInlayHints';

const FILE = '/demo/scripts/cell/Test.py';
const TEXT = [
  'CONFIG = {',
  "    'PORT': 7000,",
  "    'NAME': 'test',",
  '}',
  'port = CONFIG["PORT"]',
  ''
].join('\n');

function makeDoc(text = TEXT): vscode.TextDocument {
  return vscode.makeTextDocument(text, { fileName: FILE, languageId: 'python', version: 1 });
}

describe('KODE-DICTTYPE-001 provider surfaces', () => {
  it('1. hover at ordinary dict read shows inferred type + frozen tag', async () => {
    const store = new DictValueTypeStore();
    const provider = new KBEngineHoverProvider(undefined, undefined, store);
    const doc = makeDoc();
    const hover = await provider.provideHover(doc, new vscode.Position(4, 17));
    const md = String((hover?.contents as vscode.MarkdownString)?.value ?? '');
    expect(md).toContain('CONFIG');
    expect(md).toContain('int');
    expect(md).toContain('固定类型');
    expect(md).toContain('Test.py:2');
  });

  it('2. inlay hint at read point shows : int, nothing at write key', async () => {
    const store = new DictValueTypeStore();
    const provider = new PythonTypeInlayHintsProvider(
      undefined as never,
      undefined,
      store
    );
    const doc = makeDoc();
    const range = new vscode.Range(0, 0, 4, 30);
    const hints = await provider.provideInlayHints(doc, range);
    const labels = hints.map(hint => String(hint.label));
    expect(labels).toContain(': int');
    // no hint on 'NAME' init key (write face not ours)
    expect(hints.filter(h => h.position.line === 1)).toHaveLength(0);
  });

  it('3. completion inside ordinary dict key position offers known keys with types', async () => {
    const provider = new KBEngineCompletionProvider(undefined, undefined, new DictValueTypeStore());
    const text = 'CONFIG = {"PORT": 7000, "NAME": "x"}\nx = CONFIG["PO';
    const doc = makeDoc(text);
    const items = await provider.provideCompletionItems(doc, new vscode.Position(1, 14));
    const list = Array.isArray(items) ? items : [];
    expect(list.map(item => item.label)).toContain('PORT');
    const port = list.find(item => item.label === 'PORT');
    expect(port?.detail).toContain('int');
    expect(port?.detail).toContain('frozen');
  });

  it('4. GLOBDATA-002 hover still works when no store is injected', async () => {
    const provider = new KBEngineHoverProvider();
    const doc = makeDoc();
    // no crash on ordinary dict read without store; the ordinary chain answers
    await provider.provideHover(doc, new vscode.Position(4, 17));
  });

  // Prove-red: resolve the self receiver against classAtLine[0] (a file-wide
  // guess) instead of the cursor line → this case fails with A_KEY.
  it('5. self.<attr> key completion resolves the enclosing class, not line 0', async () => {
    const provider = new KBEngineCompletionProvider(
      undefined,
      undefined,
      new DictValueTypeStore()
    );
    const text = [
      '# -*- coding: utf-8 -*-',
      'class A:',
      '    def __init__(self):',
      '        self.config = {"A_KEY": 1}',
      '',
      'class B:',
      '    def __init__(self):',
      '        self.config = {"B_KEY": "x"}',
      '',
      '    def use(self):',
      '        v = self.config["'
    ].join('\n');
    const doc = makeDoc(text);
    const items = await provider.provideCompletionItems(doc, new vscode.Position(10, 25));
    const list = Array.isArray(items) ? items : [];
    expect(list.map(item => item.label)).toContain('B_KEY');
    expect(list.map(item => item.label)).not.toContain('A_KEY');
  });
});
