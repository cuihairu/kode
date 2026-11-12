import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cellDataHintPosition,
  cellDataKeyProvablyPresent,
  resolveCellDataReadType,
  scanCellDataKeyOperations,
  type CellDataKeyOperation
} from '../src/backend/cellDataReadType';
import { PythonTypeInlayHintsProvider } from '../src/typeInlayHints';
import { EntityMappingManager } from '../src/entityMapping';
import { setKodeCoreShadowGate } from '../src/backend/kodeCoreShadowFaces';
import type { KodeCoreGate } from '../src/backend/kodeCoreGate';
import { Position, Range, Uri, makeTextDocument, workspace } from './helpers/vscodeStub';
import type { MinimalTextDocument } from './helpers/vscodeStub';

// KSEM-CELL-06:cellData 下标读取/get 的类型推导(传给局部变量与表达式)、
// get 按可证明存在性与 default 算可空/联合、del 后不再沿用必有键。能推才显:
// 键宇宙无此键/类型落 Any/get default 类型未知 → 不出提示,绝不硬造。

const op = (line: number, key: string, kind: 'read' | 'write' | 'del', accessKind: 'subscript' | 'get', exprStart = 4, exprEnd = exprStart + 20): CellDataKeyOperation => ({
  key, line, kind, accessKind, exprStart, exprEnd, keyStart: exprStart + 14, keyEnd: exprStart + 17, defaultExpr: null
});

describe('scanCellDataKeyOperations(读/写/删分类)', () => {
  it('classifies subscript read/write/del and get read', () => {
    const text = [
      'a = self.cellData["hp"]',         // read subscript
      'self.cellData["hp"] = x',         // write subscript
      'del self.cellData["hp"]',         // del subscript
      'x = self.cellData.get("hp")',     // read get, no default
      'y = self.cellData.get("hp", 0)'   // read get, default 0
    ].join('\n');
    const ops = scanCellDataKeyOperations(text);
    expect(ops.map(o => [o.kind, o.accessKind])).toEqual([
      ['read', 'subscript'],
      ['write', 'subscript'],
      ['del', 'subscript'],
      ['read', 'get'],
      ['read', 'get']
    ]);
    expect(ops[3].defaultExpr).toBeNull();
    expect(ops[4].defaultExpr).toBe('0');
  });

  it('subscript in a larger expression is a read, not a write', () => {
    const text = ['x = self.cellData["hp"] + 1', 'y = self.cellData["hp"] == 5'].join('\n');
    const ops = scanCellDataKeyOperations(text);
    expect(ops.map(o => o.kind)).toEqual(['read', 'read']);
  });

  it('skips comment/string pseudo-accesses', () => {
    const text = [
      'a = self.cellData["hp"]',
      '# b = self.cellData["hp"] = 1',
      's = "self.cellData[\\"hp\\"]"'
    ].join('\n');
    const ops = scanCellDataKeyOperations(text);
    expect(ops).toHaveLength(1);
    expect(ops[0].line).toBe(0);
  });
});

describe('resolveCellDataReadType(读取类型)', () => {
  const base = { accessKind: 'subscript' as const, fieldAnnotation: 'int', hasDefault: false, defaultAnnotation: null, provablyPresent: false };

  it('subscript yields the field type (non-null)', () => {
    expect(resolveCellDataReadType({ ...base, accessKind: 'subscript' })).toBe('int');
  });

  it('get with provably present key yields the field type', () => {
    expect(resolveCellDataReadType({ ...base, accessKind: 'get', provablyPresent: true })).toBe('int');
  });

  it('get without default on a possibly-absent key is nullable', () => {
    expect(resolveCellDataReadType({ ...base, accessKind: 'get' })).toBe('int | None');
  });

  it('get with known default unions with the default type', () => {
    expect(resolveCellDataReadType({ ...base, accessKind: 'get', hasDefault: true, defaultAnnotation: 'str' })).toBe('int | str');
  });

  it('get with same-type default dedupes', () => {
    expect(resolveCellDataReadType({ ...base, accessKind: 'get', hasDefault: true, defaultAnnotation: 'int' })).toBe('int');
  });

  it('get with None default unions to None', () => {
    expect(resolveCellDataReadType({ ...base, accessKind: 'get', hasDefault: true, defaultAnnotation: 'None' })).toBe('int | None');
  });

  it('get with unknown default type yields null (no fabrication)', () => {
    expect(resolveCellDataReadType({ ...base, accessKind: 'get', hasDefault: true, defaultAnnotation: null })).toBeNull();
  });

  it('unknown field type yields null', () => {
    expect(resolveCellDataReadType({ ...base, fieldAnnotation: null })).toBeNull();
  });
});

describe('cellDataKeyProvablyPresent(存在性)', () => {
  const lines = (text: string) => text.split('\n');

  it('no mutation: in-universe keys are present, unknown keys absent', () => {
    expect(cellDataKeyProvablyPresent([], op(0, 'hp', 'read', 'get'), lines('x = self.cellData.get("hp")'), true)).toBe(true);
    expect(cellDataKeyProvablyPresent([], op(0, 'hp', 'read', 'get'), lines('x = self.cellData.get("hp")'), false)).toBe(false);
  });

  it('write makes the key present, del makes it absent', () => {
    const ops = [op(0, 'hp', 'write', 'subscript'), op(1, 'hp', 'read', 'get')];
    expect(cellDataKeyProvablyPresent(ops, ops[1], lines('self.cellData["hp"] = 1\nx = self.cellData.get("hp")'), true)).toBe(true);
    const delOps = [op(0, 'hp', 'del', 'subscript'), op(1, 'hp', 'read', 'get')];
    expect(cellDataKeyProvablyPresent(delOps, delOps[1], lines('del self.cellData["hp"]\nx = self.cellData.get("hp")'), true)).toBe(false);
  });

  it('re-write after del restores presence', () => {
    const ops = [op(0, 'hp', 'del', 'subscript'), op(1, 'hp', 'write', 'subscript'), op(2, 'hp', 'read', 'get')];
    expect(cellDataKeyProvablyPresent(ops, ops[2], lines('del self.cellData["hp"]\nself.cellData["hp"] = 1\nx = self.cellData.get("hp")'), true)).toBe(true);
  });

  it('mutation in another function does not leak across the scope boundary', () => {
    const text = lines('def a(self):\n    self.cellData["hp"] = 1\n\ndef b(self):\n    x = self.cellData.get("hp")');
    const ops = scanCellDataKeyOperations(text.join('\n'));
    const read = ops.find(o => o.line === 4)!;
    expect(cellDataKeyProvablyPresent(ops, read, text, true)).toBe(true); // no leak: initial presence (in universe)
  });

  it('same-line write before the read counts', () => {
    const ops = scanCellDataKeyOperations('self.cellData["hp"] = self.cellData.get("hp")');
    const read = ops.find(o => o.kind === 'read')!;
    expect(cellDataKeyProvablyPresent(ops, read, ['self.cellData["hp"] = self.cellData.get("hp")'], true)).toBe(true);
  });
});

describe('cellDataHintPosition(提示落点)', () => {
  it('pure assignment RHS positions the hint after the target variable', () => {
    const text = 'x = self.cellData["hp"]';
    const ops = scanCellDataKeyOperations(text);
    expect(cellDataHintPosition(text, ops[0])).toEqual({ line: 0, character: 1 });
  });

  it('non-pure position (larger expression) hints after the read expression', () => {
    const text = 'foo(self.cellData["hp"])';
    const ops = scanCellDataKeyOperations(text);
    const hint = cellDataHintPosition(text, ops[0]);
    expect(hint.line).toBe(0);
    expect(hint.character).toBe(ops[0].exprEnd);
  });

  it('mixed assignment (read is not the whole RHS) hints after the expression', () => {
    const text = 'x = self.cellData["hp"] + 1';
    const ops = scanCellDataKeyOperations(text);
    const hint = cellDataHintPosition(text, ops[0]);
    expect(hint.character).toBe(ops[0].exprEnd);
  });
});

describe('KSEM-CELL-06 provider 全链(inlay 读取类型)', () => {
  const ORIGINAL_FOLDERS = workspace.workspaceFolders;

  let root = '';

  const put = (relative: string, content: string) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
  };

  const CANNED_KEYS = [
    { key: 'hp', kind: 'defField', typeLabel: 'UINT16', sourceFile: 'Avatar.def', sourceLine: 5 },
    { key: 'position', kind: 'builtin', typeLabel: 'VECTOR3', sourceFile: 'server/baseapp/entity.cpp:250', sourceLine: null }
  ];

  const installGate = (keys: typeof CANNED_KEYS | null): void => {
    const fakeGate = {
      serveFromRust: () => false,
      runInRust: async () => {
        if (keys === null) {
          return { ok: false, result: null };
        }
        return { ok: true, result: { keys } };
      }
    } as unknown as KodeCoreGate;
    setKodeCoreShadowGate(fakeGate);
  };

  const managerOf = () =>
    ({
      resolvePropertyDefinitionInfo: () => Promise.resolve(null),
      resolveMethodDefinition: () => Promise.resolve(null)
    }) as unknown as EntityMappingManager;

  const provider = () => new PythonTypeInlayHintsProvider(managerOf());

  const doc = (text: string, fileName = ''): MinimalTextDocument =>
    makeTextDocument(text, { fileName: fileName || path.join(root, 'scripts', 'cell', 'Avatar.py'), languageId: 'python' });

  const allRange = (lines: number) => new Range(new Position(0, 0), new Position(lines, 0));

  const collect = async (text: string, fileName = ''): Promise<Array<{ position: { line: number; character: number }; label: unknown }>> => {
    const document = doc(text, fileName);
    const hints = (await provider().provideInlayHints(document as never, allRange(text.split('\n').length))) as unknown as Array<{
      position: { line: number; character: number };
      label: unknown;
    }>;
    return hints;
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-cell06-'));
    put('scripts/entity_defs/Avatar.def', [
      '<root>',
      '  <Parent>Monster</Parent>',
      '  <Properties><hp><Type>UINT16</Type><Flags>CELL_PUBLIC</Flags></hp></Properties>',
      '</root>'
    ].join('\n'));
    put('scripts/entity_defs/Monster.def', '<root></root>');
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'cell06', index: 0 }];
    installGate(CANNED_KEYS);
  });

  afterEach(() => {
    workspace.workspaceFolders = ORIGINAL_FOLDERS;
    setKodeCoreShadowGate(null);
    if (root) {
      fs.rmSync(root, { recursive: true, force: true });
      root = '';
    }
  });

  it('subscript read propagates the field type to the target variable', async () => {
    const hints = await collect('def tick(self):\n    x = self.cellData["hp"]');
    expect(hints).toHaveLength(1);
    expect(hints[0].position).toEqual({ line: 1, character: 5 }); // after x
    expect(hints[0].label).toBe(': int'); // UINT16 → int
  });

  it('get on a provably-present def field is non-null', async () => {
    const hints = await collect('def tick(self):\n    x = self.cellData.get("hp")');
    expect(hints).toHaveLength(1);
    expect(hints[0].label).toBe(': int');
  });

  it('get after del is nullable (no longer provably present)', async () => {
    const hints = await collect('def tick(self):\n    del self.cellData["hp"]\n    x = self.cellData.get("hp")');
    expect(hints).toHaveLength(1);
    expect(hints[0].position.line).toBe(2);
    expect(hints[0].label).toBe(': int | None');
  });

  it('get with default after del unions field with the default type', async () => {
    const hints = await collect('def tick(self):\n    del self.cellData["hp"]\n    x = self.cellData.get("hp", "none")');
    expect(hints).toHaveLength(1);
    expect(hints[0].label).toBe(': int | str');
  });

  it('re-write after del restores non-null presence', async () => {
    const hints = await collect('def tick(self):\n    del self.cellData["hp"]\n    self.cellData["hp"] = 1\n    x = self.cellData.get("hp")');
    expect(hints).toHaveLength(1);
    expect(hints[0].label).toBe(': int');
  });

  it('bare expression (not pure RHS) hints after the read expression', async () => {
    const hints = await collect('def tick(self):\n    foo(self.cellData["hp"])');
    expect(hints).toHaveLength(1);
    // 实际行含 4 空格缩进:表达式尾后一列(闭 `]` 之后)
    const line = '    foo(self.cellData["hp"])';
    expect(hints[0].position.line).toBe(1);
    expect(hints[0].position.character).toBe(line.indexOf('self.cellData["hp"]') + 'self.cellData["hp"]'.length);
  });

  it('unknown key yields no fabricated hint', async () => {
    const hints = await collect('def tick(self):\n    x = self.cellData["nope"]');
    expect(hints).toHaveLength(0);
  });

  it('client script (cellData unreachable) yields no hint', async () => {
    const hints = await collect('def tick(self):\n    x = self.cellData["hp"]', path.join(root, 'scripts', 'client', 'Avatar.py'));
    expect(hints).toHaveLength(0);
  });

  it('no Rust gate yields no fabricated hint', async () => {
    setKodeCoreShadowGate(null);
    const hints = await collect('def tick(self):\n    x = self.cellData["hp"]');
    expect(hints).toHaveLength(0);
  });
});
