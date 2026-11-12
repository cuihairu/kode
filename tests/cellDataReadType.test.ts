import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cellDataAliasNames,
  cellDataAliasState,
  cellDataHintPosition,
  cellDataKeyProvablyPresent,
  resolveCellDataConstantKey,
  resolveCellDataReadType,
  scanCellDataKeyOperations,
  type CellDataKeyOperation
} from '../src/backend/cellDataReadType';
import { scanCellDataKeyAccesses } from '../src/backend/cellDataKeyAccess';
import { PythonTypeInlayHintsProvider } from '../src/typeInlayHints';
import { EntityMappingManager } from '../src/entityMapping';
import { setKodeCoreShadowGate } from '../src/backend/kodeCoreShadowFaces';
import type { KodeCoreGate } from '../src/backend/kodeCoreGate';
import { Position, Range, Uri, makeTextDocument, workspace } from './helpers/vscodeStub';
import type { MinimalTextDocument } from './helpers/vscodeStub';

// KSEM-CELL-06/07:cellData 下标读取/get 的类型推导(传给局部变量与表达式)、
// get 按可证明存在性与 default 算可空/联合、del 后不再沿用必有键;CELL-07
// 字典别名传播(data = self.cellData 后透过别名的同形访问)与可确定常量键
// (k = "hp" 后 self.cellData[k]);重绑定/动态逃逸后降低确定性。能推才显:
// 键宇宙无此键/类型落 Any/get default 类型未知 → 不出提示,绝不硬造。

const op = (line: number, key: string, kind: 'read' | 'write' | 'del', accessKind: 'subscript' | 'get', exprStart = 4, exprEnd = exprStart + 20): CellDataKeyOperation => ({
  key, line, kind, accessKind, exprStart, exprEnd, keyStart: exprStart + 14, keyEnd: exprStart + 17, defaultExpr: null, receiver: 'self.cellData'
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
  it('no mutation: in-universe keys are present, unknown keys absent', () => {
    expect(cellDataKeyProvablyPresent([], op(0, 'hp', 'read', 'get'), 'x = self.cellData.get("hp")', true)).toBe(true);
    expect(cellDataKeyProvablyPresent([], op(0, 'hp', 'read', 'get'), 'x = self.cellData.get("hp")', false)).toBe(false);
  });

  it('write makes the key present, del makes it absent', () => {
    const ops = [op(0, 'hp', 'write', 'subscript'), op(1, 'hp', 'read', 'get')];
    expect(cellDataKeyProvablyPresent(ops, ops[1], 'self.cellData["hp"] = 1\nx = self.cellData.get("hp")', true)).toBe(true);
    const delOps = [op(0, 'hp', 'del', 'subscript'), op(1, 'hp', 'read', 'get')];
    expect(cellDataKeyProvablyPresent(delOps, delOps[1], 'del self.cellData["hp"]\nx = self.cellData.get("hp")', true)).toBe(false);
  });

  it('re-write after del restores presence', () => {
    const ops = [op(0, 'hp', 'del', 'subscript'), op(1, 'hp', 'write', 'subscript'), op(2, 'hp', 'read', 'get')];
    expect(cellDataKeyProvablyPresent(ops, ops[2], 'del self.cellData["hp"]\nself.cellData["hp"] = 1\nx = self.cellData.get("hp")', true)).toBe(true);
  });

  it('mutation in another function does not leak across the scope boundary', () => {
    const text = 'def a(self):\n    self.cellData["hp"] = 1\n\ndef b(self):\n    x = self.cellData.get("hp")';
    const ops = scanCellDataKeyOperations(text);
    const read = ops.find(o => o.line === 4)!;
    expect(cellDataKeyProvablyPresent(ops, read, text, true)).toBe(true); // no leak: initial presence (in universe)
  });

  it('same-line write before the read counts', () => {
    const text = 'self.cellData["hp"] = self.cellData.get("hp")';
    const ops = scanCellDataKeyOperations(text);
    const read = ops.find(o => o.kind === 'read')!;
    expect(cellDataKeyProvablyPresent(ops, read, text, true)).toBe(true);
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

// ---------------------------------------------------------------------------
// KSEM-CELL-07:常量键 + 字典别名(纯模块面)
// ---------------------------------------------------------------------------

describe('cellDataAliasNames(别名候选)', () => {
  it('collects NAME = self.cellData in order, excluding comments/docstrings/self', () => {
    const text = [
      '"""',
      'data = self.cellData',
      '"""',
      'data = self.cellData',
      '# ghost = self.cellData',
      'cache = self.cellData',
      'other = self.cellData  # 尾注释不影响'
    ].join('\n');
    expect(cellDataAliasNames(text)).toEqual(['data', 'cache', 'other']);
  });

  it('non-cellData assignments and augmented forms are not aliases', () => {
    const text = [
      'data = {}',
      'cache += self.cellData',
      'x, y = self.cellData, 1'
    ].join('\n');
    expect(cellDataAliasNames(text)).toEqual([]);
  });
});

describe('cellDataAliasState(别名有效性与逃逸)', () => {
  const state = (text: string, name: string, targetLine: number) => cellDataAliasState(text, name, targetLine);

  it('valid between alias line and target, with aliasLine recorded', () => {
    const text = 'data = self.cellData\nx = data["hp"]';
    expect(state(text, 'data', 1)).toEqual({ valid: true, escaped: false, escapedLine: null, aliasLine: 0 });
  });

  it('invalid after plain rebind', () => {
    const text = 'data = self.cellData\ndata = {}\nx = data["hp"]';
    expect(state(text, 'data', 2).valid).toBe(false);
  });

  it('invalid for rebind forms: for-target / with-as / augmented / walrus', () => {
    expect(state('for data in items:\n    x = data["hp"]', 'data', 1).valid).toBe(false);
    expect(state('with ctx() as data:\n    x = data["hp"]', 'data', 1).valid).toBe(false);
    expect(state('data = self.cellData\ndata += extra\nx = data["hp"]', 'data', 2).valid).toBe(false);
    expect(state('if (data := make()):\n    x = data["hp"]', 'data', 1).valid).toBe(false);
  });

  it('alias in a sibling method does not reach across the scope boundary', () => {
    const text = [
      'class A:',
      '    def a(self):',
      '        data = self.cellData',
      '    def b(self):',
      '        x = data["hp"]'
    ].join('\n');
    expect(state(text, 'data', 4).valid).toBe(false);
  });

  it('escape via call argument / return / attribute store / non-get method', () => {
    expect(state('data = self.cellData\nsubmit(data)\nx = data["hp"]', 'data', 2)).toEqual(
      { valid: true, escaped: true, escapedLine: 1, aliasLine: 0 }
    );
    expect(state('data = self.cellData\nreturn data\nx = data["hp"]', 'data', 2).escaped).toBe(true);
    expect(state('data = self.cellData\nself.cache = data\nx = data["hp"]', 'data', 2).escaped).toBe(true);
    expect(state('data = self.cellData\ndata.clear()\nx = data["hp"]', 'data', 2).escaped).toBe(true);
  });

  it('cellData-shaped occurrences and bare local references are not escapes', () => {
    expect(state('data = self.cellData\nx = data["hp"]', 'data', 1).escaped).toBe(false);
    expect(state('data = self.cellData\nx = data.get("hp")', 'data', 1).escaped).toBe(false);
    expect(state('data = self.cellData\nb = data\nx = b["hp"]', 'data', 2).escaped).toBe(false);
  });

  it('def/class bodies are not escapes (uncalled = not escaped), any indent', () => {
    // 模块级 def 体(头缩进 == 别名缩进)
    const moduleCase = 'data = self.cellData\ndef foo():\n    submit(data)\nx = data.get("hp")';
    expect(state(moduleCase, 'data', 3).escaped).toBe(false);
    // 方法体内嵌 def(头缩进 == 别名缩进,体更深)
    const methodCase = [
      'def tick(self):',
      '    data = self.cellData',
      '    def inner():',
      '        submit(data)',
      '    x = data.get("hp")'
    ].join('\n');
    expect(state(methodCase, 'data', 4).escaped).toBe(false);
  });

  it('escape still detected after a nested def closes', () => {
    const text = [
      'data = self.cellData',
      'def foo():',
      '    pass',
      'submit(data)',
      'x = data["hp"]'
    ].join('\n');
    expect(state(text, 'data', 4).escaped).toBe(true);
    expect(state(text, 'data', 4).escapedLine).toBe(3);
  });

  it('name occurrences inside strings/comments do not count', () => {
    const text = 'data = self.cellData\ns = "submit(data)"\n# submit(data)\nx = data["hp"]';
    expect(state(text, 'data', 3).escaped).toBe(false);
  });
});

describe('resolveCellDataConstantKey(常量键)', () => {
  it('resolves identifier keys via the nearest string-literal assignment', () => {
    expect(resolveCellDataConstantKey('k = "hp"\nx = self.cellData[k]', 'k', 1)).toBe('hp');
    expect(resolveCellDataConstantKey('k = "hp"\nk = "mp"\nx = self.cellData[k]', 'k', 2)).toBe('mp');
  });

  it('string literals resolve directly regardless of context', () => {
    expect(resolveCellDataConstantKey('', '"hp"', 0)).toBe('hp');
    expect(resolveCellDataConstantKey("", "'hp'", 0)).toBe('hp');
  });

  it('rebind forms, non-literal RHS, missing assignment, non-identifiers yield null', () => {
    expect(resolveCellDataConstantKey('for k in keys:\n    x = self.cellData[k]', 'k', 1)).toBeNull();
    expect(resolveCellDataConstantKey('k = "hp"\nk += "x"\nx = self.cellData[k]', 'k', 2)).toBeNull();
    expect(resolveCellDataConstantKey('k = build_key()\nx = self.cellData[k]', 'k', 1)).toBeNull();
    expect(resolveCellDataConstantKey('x = self.cellData[name]', 'name', 0)).toBeNull();
    expect(resolveCellDataConstantKey('k = "hp"\nx = self.cellData[k + "1"]', 'k + "1"', 1)).toBeNull();
  });
});

describe('scanCellDataKeyOperations(别名与常量键入列)', () => {
  it('includes alias ops with receiver recorded, keys resolved via constants', () => {
    const text = [
      'data = self.cellData',
      'k = "hp"',
      'x = data[k]',
      'y = data.get("mp", 0)'
    ].join('\n');
    const ops = scanCellDataKeyOperations(text, ['self.cellData', ...cellDataAliasNames(text)]);
    expect(ops).toHaveLength(2);
    expect(ops[0]).toMatchObject({ key: 'hp', receiver: 'data', line: 2, kind: 'read', accessKind: 'subscript' });
    expect(ops[1]).toMatchObject({ key: 'mp', receiver: 'data', line: 3, kind: 'read', accessKind: 'get' });
    expect(ops[1].defaultExpr).toBe('0');
  });

  it('ops from all receivers merge back into document order', () => {
    const text = [
      'y = data["hp"]',
      'x = self.cellData["hp"]',
      'data = self.cellData'
    ].join('\n');
    const ops = scanCellDataKeyOperations(text, ['self.cellData', 'data']);
    expect(ops.map(o => [o.line, o.receiver])).toEqual([[0, 'data'], [1, 'self.cellData']]);
  });

  it('unresolvable constant keys drop the op (no fabricated keys)', () => {
    const text = 'x = self.cellData[name]\ny = self.cellData["hp"]';
    const ops = scanCellDataKeyOperations(text);
    expect(ops).toHaveLength(1);
    expect(ops[0].key).toBe('hp');
  });

  it('alias accesses never enter the CELL-05 jump/reference index', () => {
    const text = 'data = self.cellData\nx = data["hp"]';
    expect(scanCellDataKeyAccesses(text)).toEqual([]);
  });
});

describe('cellDataKeyProvablyPresent(别名流存在性)', () => {
  const scan = (text: string) => scanCellDataKeyOperations(text, ['self.cellData', ...cellDataAliasNames(text)]);

  it('write through a valid alias counts as evidence', () => {
    const text = 'data = self.cellData\ndata["hp"] = 1\nx = data.get("hp")';
    const ops = scan(text);
    const read = ops.find(o => o.kind === 'read')!;
    expect(cellDataKeyProvablyPresent(ops, read, text, true)).toBe(true);
  });

  it('write through an invalid alias is skipped, universe presence holds', () => {
    const text = 'data = self.cellData\ndata = {}\ndata["hp"] = 1\nx = self.cellData.get("hp")';
    const ops = scan(text);
    const read = ops.find(o => o.receiver === 'self.cellData')!;
    expect(cellDataKeyProvablyPresent(ops, read, text, true)).toBe(true);
  });

  it('escape supersedes an older write; a newer write overrides escape', () => {
    const older = 'data = self.cellData\ndata["hp"] = 1\nsubmit(data)\nx = data.get("hp")';
    const opsOlder = scan(older);
    const readOlder = opsOlder.find(o => o.kind === 'read')!;
    // escape 由消费方核定后传入(provider 同参):别名态先行
    const aliasOlder = cellDataAliasState(older, 'data', readOlder.line);
    expect(aliasOlder.escaped).toBe(true);
    expect(cellDataKeyProvablyPresent(opsOlder, readOlder, older, true, { line: aliasOlder.escapedLine! })).toBe(false);
    const newer = 'data = self.cellData\nsubmit(data)\ndata["hp"] = 1\nx = data.get("hp")';
    const opsNewer = scan(newer);
    const readNewer = opsNewer.find(o => o.kind === 'read')!;
    const aliasNewer = cellDataAliasState(newer, 'data', readNewer.line);
    expect(aliasNewer.escaped).toBe(true);
    expect(cellDataKeyProvablyPresent(opsNewer, readNewer, newer, true, { line: aliasNewer.escapedLine! })).toBe(true);
  });
});

describe('KSEM-CELL-06/07 provider 全链(inlay 读取类型)', () => {
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

  // --- KSEM-CELL-07:别名传播 / 常量键 ---

  it('alias subscript read propagates the field type to the target variable', async () => {
    const hints = await collect('def tick(self):\n    data = self.cellData\n    x = data["hp"]');
    expect(hints).toHaveLength(1);
    expect(hints[0].position).toEqual({ line: 2, character: 5 }); // after x
    expect(hints[0].label).toBe(': int');
  });

  it('alias get with no escape stays non-null (universe presence)', async () => {
    const hints = await collect('def tick(self):\n    data = self.cellData\n    x = data.get("hp")');
    expect(hints).toHaveLength(1);
    expect(hints[0].label).toBe(': int');
  });

  it('alias escape downgrades get to nullable, subscript type unchanged', async () => {
    const hints = await collect([
      'def tick(self):',
      '    data = self.cellData',
      '    submit(data)',
      '    x = data.get("hp")',
      '    y = data["hp"]'
    ].join('\n'));
    expect(hints).toHaveLength(2);
    expect(hints[0].position).toEqual({ line: 3, character: 5 });
    expect(hints[0].label).toBe(': int | None');
    expect(hints[1].position).toEqual({ line: 4, character: 5 });
    expect(hints[1].label).toBe(': int');
  });

  it('rebound alias (plain) yields no hint', async () => {
    const hints = await collect('def tick(self):\n    data = self.cellData\n    data = {}\n    x = data["hp"]');
    expect(hints).toHaveLength(0);
  });

  it('rebound alias (for-target) yields no hint', async () => {
    const hints = await collect('def tick(self):\n    data = self.cellData\n    for data in items:\n        pass\n    x = data["hp"]');
    expect(hints).toHaveLength(0);
  });

  it('constant key resolves through the subscript', async () => {
    const hints = await collect('def tick(self):\n    k = "hp"\n    x = self.cellData[k]');
    expect(hints).toHaveLength(1);
    expect(hints[0].position).toEqual({ line: 2, character: 5 });
    expect(hints[0].label).toBe(': int');
  });

  it('del through a constant key makes the later get nullable', async () => {
    const hints = await collect('def tick(self):\n    k = "hp"\n    del self.cellData[k]\n    x = self.cellData.get(k)');
    expect(hints).toHaveLength(1);
    expect(hints[0].label).toBe(': int | None');
  });

  it('write through a valid alias restores presence after del', async () => {
    const hints = await collect([
      'def tick(self):',
      '    data = self.cellData',
      '    del self.cellData["hp"]',
      '    data["hp"] = 1',
      '    x = data.get("hp")'
    ].join('\n'));
    expect(hints).toHaveLength(1);
    expect(hints[0].label).toBe(': int');
  });

  it('write through an invalid alias is not evidence (universe presence holds)', async () => {
    const hints = await collect([
      'def tick(self):',
      '    data = self.cellData',
      '    data = {}',
      '    data["hp"] = 1',
      '    x = self.cellData.get("hp")'
    ].join('\n'));
    expect(hints).toHaveLength(1);
    expect(hints[0].label).toBe(': int');
  });

  it('alias-of-alias does not propagate', async () => {
    const hints = await collect('def tick(self):\n    data = self.cellData\n    alias2 = data\n    x = alias2["hp"]');
    expect(hints).toHaveLength(0);
  });
});
