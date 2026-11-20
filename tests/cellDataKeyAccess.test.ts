import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cellDataKeyAccessAtPosition,
  decodeStringLiteral,
  isCellDataKeyInsideLineComment,
  parseCellDataKeyAccess,
  scanCellDataKeyAccesses
} from '../src/backend/cellDataKeyAccess';
import {
  CELL_DATA_KEYS_METHOD,
  cellScriptRoleAndEntity,
  collectCellDataDefUniverseWithCategory,
  fetchCellDataKeys
} from '../src/backend/cellDataCompletion';
import { PythonDefinitionProvider, KBEngineReferencesProvider } from '../src/languageProviders';
import { EntityMappingManager } from '../src/entityMapping';
import { setKodeCoreShadowGate } from '../src/backend/kodeCoreShadowFaces';
import type { KodeCoreGate } from '../src/backend/kodeCoreGate';
import { Position, Uri, makeTextDocument, workspace } from './helpers/vscodeStub';

// KSEM-CELL-05:cellData 字符串键的跳转(F12,键来源 def 声明)与引用
// (Shift+F12,当前实体脚本内同键访问点)。诚实边界:内建键(引擎文件不在
// workspace)不跳转;未知键不伪造声明;实体身份隔离只扫当前实体脚本。

/** 键内容中心列(键区间 [开引号+1, 闭引号),中心必在内)。 */
const keyCenter = (line: string, key: string, quote = '"'): number => {
  const at = line.indexOf(`${quote}${key}${quote}`);
  return at + 1 + Math.floor(key.length / 2);
};

describe('cellDataKeyAccessAtPosition(键落点探测)', () => {
  const probe = (lineText: string, character: number) => cellDataKeyAccessAtPosition(lineText, character);

  it('bracket subscript: character inside the key content resolves', () => {
    const line = 'hp = self.cellData["hp"]';
    expect(probe(line, keyCenter(line, 'hp'))).toEqual({
      key: 'hp',
      keyStart: line.indexOf('"hp"') + 1,
      keyEnd: line.indexOf('"hp"') + 3,
      kind: 'subscript'
    });
  });

  it('get form resolves with kind get', () => {
    const line = "x = self.cellData.get('hp')";
    const res = probe(line, keyCenter(line, 'hp', "'"));
    expect(res?.key).toBe('hp');
    expect(res?.kind).toBe('get');
    expect(res?.keyStart).toBe(line.indexOf("'hp'") + 1);
  });

  it('spaces between cellData and bracket/paren are tolerated', () => {
    const line = 'a = self.cellData[  "hp"]';
    const res = probe(line, keyCenter(line, 'hp'));
    expect(res?.key).toBe('hp');
    expect(res?.kind).toBe('subscript');
  });

  it('single and double quotes both decode', () => {
    const single = "x = self.cellData['hp']";
    const double = 'x = self.cellData["hp"]';
    expect(probe(single, keyCenter(single, 'hp', "'"))?.key).toBe('hp');
    expect(probe(double, keyCenter(double, 'hp'))?.key).toBe('hp');
  });

  it('position on the receiver or the closing quote is not a key hit', () => {
    const line = 'hp = self.cellData["hp"]';
    expect(probe(line, 6)).toBeNull(); // on self
    expect(probe(line, line.indexOf('"hp"'))).toBeNull(); // on opening quote
    expect(probe(line, line.indexOf('"hp"') + 3)).toBeNull(); // on closing quote
    expect(probe(line, line.indexOf('"hp"') + 4)).toBeNull(); // on closing bracket
  });

  it('dynamic key (identifier/computed) is not statically resolved', () => {
    expect(probe('x = self.cellData[var]', 20)).toBeNull();
    expect(probe('x = self.cellData[var + "a"]', 22)).toBeNull();
  });

  it('escape sequences decode to the python literal value', () => {
    const line = 'x = self.cellData["a\\nb"]';
    const res = probe(line, line.indexOf('a\\nb') + 2);
    expect(res?.key).toBe('a\nb');
  });

  it('illegal escape skips the access (no fabricated key)', () => {
    const line = 'x = self.cellData["a\\q"]';
    expect(probe(line, line.indexOf('a\\q') + 2)).toBeNull();
  });
});

describe('scanCellDataKeyAccesses(全文引用扫描)', () => {
  it('collects literal key accesses and skips comment/string pseudo-accesses', () => {
    const text = [
      'a = self.cellData["hp"]',
      '# b = self.cellData["hp"]',
      'c = self.cellData.get("hp")',
      's = "self.cellData[\\"hp\\"]"',
      "d = '''self.cellData[\"hp\"]'''",
      'e = self.cellData.get("position")'
    ].join('\n');
    const sites = scanCellDataKeyAccesses(text);
    expect(sites.map(s => s.key)).toEqual(['hp', 'hp', 'position']);
    expect(sites.map(s => s.line)).toEqual([0, 2, 5]);
    expect(sites[0].kind).toBe('subscript');
    expect(sites[1].kind).toBe('get');
    expect(sites[0].keyStart).toBe(text.split('\n')[0].indexOf('"hp"') + 1);
  });

  it('dynamic keys are skipped; escapes decode', () => {
    const text = ['a = self.cellData[var]', 'b = self.cellData["a\\nb"]'].join('\n');
    const sites = scanCellDataKeyAccesses(text);
    expect(sites).toHaveLength(1);
    expect(sites[0].key).toBe('a\nb');
  });

  it('isCellDataKeyInsideLineComment flags a key inside a trailing comment', () => {
    const line = 'x = self.cellData["hp"]  # pseudo';
    const keyStart = line.indexOf('"hp"') + 1;
    expect(isCellDataKeyInsideLineComment(line, keyStart)).toBe(false);
    expect(isCellDataKeyInsideLineComment('# self.cellData["hp"]', 20)).toBe(true);
  });
});

describe('collectCellDataDefUniverseWithCategory(带类别宇宙)', () => {
  it('carries the source category for jump resolution', () => {
    const findDefText = (name: string, category: 'entity' | 'interface' | 'component'): string | null => {
      const table: Record<string, string | null> = {
        'entity:Avatar': '<root><Parent>Monster</Parent></root>',
        'entity:Monster': '<root></root>'
      };
      return table[`${category}:${name}`] ?? null;
    };
    const defs = collectCellDataDefUniverseWithCategory('Avatar', findDefText);
    expect(defs.map(d => [d.name, d.category])).toEqual([['Avatar', 'entity'], ['Monster', 'entity']]);
  });
});

describe('KSEM-CELL-05 provider 全链(跳转/引用)', () => {
  const ORIGINAL_FOLDERS = workspace.workspaceFolders;

  let root = '';

  const put = (relative: string, content: string) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-cell05-'));
    put(
      'scripts/entity_defs/Avatar.def',
      [
        '<root>',
        '  <Parent>Monster</Parent>',
        '  <Interfaces><Interface>Mixin</Interface></Interfaces>',
        '  <Components><weapon><Type>Weapon</Type></weapon></Components>',
        '  <Properties><hp><Type>UINT16</Type><Flags>CELL_PUBLIC</Flags></hp></Properties>',
        '</root>'
      ].join('\n')
    );
    put('scripts/entity_defs/Monster.def', '<root><Properties><level><Type>UINT8</Type></level></Properties></root>');
    put('scripts/entity_defs/interfaces/Mixin.def', '<root><Parent>IgnoredFace</Parent></root>');
    put('scripts/entity_defs/components/Weapon.def', '<root><Parent>Mount</Parent></root>');
    put('scripts/entity_defs/components/Mount.def', '<root></root>');
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'cell05', index: 0 }];
  });

  afterEach(() => {
    workspace.workspaceFolders = ORIGINAL_FOLDERS;
    setKodeCoreShadowGate(null);
    if (root) {
      fs.rmSync(root, { recursive: true, force: true });
      root = '';
    }
  });

  // wire 形状(Rust serde tag="kind" 内嵌标签对象)
  const CANNED_KEYS = [
    { key: 'hp', kind: { kind: 'defField' }, typeLabel: 'UINT16', sourceFile: 'Avatar.def', sourceLine: 5 },
    { key: 'position', kind: { kind: 'builtin' }, typeLabel: 'Vector3Like', sourceFile: 'server/baseapp/entity.cpp:250', sourceLine: null },
    { key: 'weapon', kind: { kind: 'componentSlot' }, typeLabel: 'Weapon', sourceFile: 'Avatar.def', sourceLine: 7 }
  ];

  const installGate = (keys: typeof CANNED_KEYS | null): { method: string; params: unknown } => {
    const capture = { method: '', params: null as unknown };
    const fakeGate = {
      serveFromRust: () => false,
      runInRust: async (method: string, params: unknown) => {
        capture.method = method;
        capture.params = params;
        if (keys === null) {
          return { ok: false, result: null };
        }
        return { ok: true, result: { keys } };
      }
    } as unknown as KodeCoreGate;
    setKodeCoreShadowGate(fakeGate);
    return capture;
  };

  const cellDoc = (text: string) =>
    makeTextDocument(`${text}\n`, { fileName: path.join(root, 'scripts', 'cell', 'Avatar.py'), languageId: 'python' });

  const define = () =>
    new PythonDefinitionProvider(new EntityMappingManager({ subscriptions: [] } as never), undefined, undefined);
  const refs = () =>
    new KBEngineReferencesProvider(new EntityMappingManager({ subscriptions: [] } as never), undefined);

  it('F12 on a defField key jumps to the declaring def file at the source line', async () => {
    installGate(CANNED_KEYS);
    const text = 'hp = self.cellData["hp"]';
    const doc = cellDoc(text);
    const pos = new Position(0, keyCenter(text, 'hp'));
    const result = (await define().provideDefinition(doc, pos)) as { uri: { fsPath: string }; range: { start: { line: number } } } | null;
    expect(result?.uri.fsPath).toBe(path.join(root, 'scripts', 'entity_defs', 'Avatar.def'));
    expect(result?.range.start.line).toBe(4); // sourceLine 5 (1-based) → 0-based 4
  });

  it('F12 on a builtin key yields no jump (engine file is not in the workspace)', async () => {
    installGate(CANNED_KEYS);
    const text = 'p = self.cellData["position"]';
    const doc = cellDoc(text);
    const pos = new Position(0, keyCenter(text, 'position'));
    const result = await define().provideDefinition(doc, pos);
    expect(result).toBeNull();
  });

  it('F12 on an unknown key yields no fabricated declaration', async () => {
    installGate(CANNED_KEYS);
    const text = 'x = self.cellData["nope"]';
    const doc = cellDoc(text);
    const pos = new Position(0, keyCenter(text, 'nope'));
    const result = await define().provideDefinition(doc, pos);
    expect(result).toBeNull();
  });

  it('F12 outside an entity script face yields no jump', async () => {
    installGate(CANNED_KEYS);
    const text = 'hp = self.cellData["hp"]';
    const doc = makeTextDocument(`${text}\n`, {
      fileName: path.join(root, 'scripts', 'client', 'Avatar.py'),
      languageId: 'python'
    });
    const pos = new Position(0, keyCenter(text, 'hp'));
    const result = await define().provideDefinition(doc, pos);
    expect(result).toBeNull();
  });

  it('Shift+F12 returns same-key accesses in the entity script, skipping pseudo-accesses', async () => {
    const capture = installGate(CANNED_KEYS);
    const text = [
      'a = self.cellData["hp"]',
      '# b = self.cellData["hp"]',
      'c = self.cellData.get("hp")',
      'p = self.cellData.get("position")'
    ].join('\n');
    put('scripts/cell/Avatar.py', text);
    const doc = cellDoc(text);
    const pos = new Position(0, keyCenter(text.split('\n')[0], 'hp'));
    const locations = (await refs().provideReferences(doc, pos, { includeDeclaration: false })) as
      | Array<{ uri: { fsPath: string }; range: { start: { line: number; character: number } } }>
      | null;
    expect(capture.method).toBe(CELL_DATA_KEYS_METHOD);
    expect(locations).toHaveLength(2);
    expect(locations![0].uri.fsPath).toBe(path.join(root, 'scripts', 'cell', 'Avatar.py'));
    expect(locations![0].range.start.line).toBe(0);
    expect(locations![0].range.start.character).toBe(text.split('\n')[0].indexOf('"hp"') + 1);
    expect(locations![1].range.start.line).toBe(2);
    expect(locations![1].range.start.character).toBe(text.split('\n')[2].indexOf('"hp"') + 1);
  });

  it('Shift+F12 on an unknown key yields no fabricated reference', async () => {
    installGate(CANNED_KEYS);
    const text = 'x = self.cellData["nope"]';
    put('scripts/cell/Avatar.py', text);
    const doc = cellDoc(text);
    const pos = new Position(0, keyCenter(text, 'nope'));
    const result = await refs().provideReferences(doc, pos, { includeDeclaration: false });
    expect(result).toBeNull();
  });

  it('fetchCellDataKeys no gate yields null (no fabrication)', async () => {
    setKodeCoreShadowGate(null);
    expect(await fetchCellDataKeys('Avatar', [{ name: 'Avatar', text: '<root></root>' }])).toBeNull();
  });

  it('cellScriptRoleAndEntity isolates role/entity for the reference scan', () => {
    expect(cellScriptRoleAndEntity(path.join(root, 'scripts', 'base', 'Monster.py'))).toEqual({ role: 'base', entity: 'Monster' });
    expect(cellScriptRoleAndEntity(path.join(root, 'scripts', 'client', 'Monster.py'))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// COV-98-TS-BACKEND 批 5:转义解码族全谱(八进制/\x/\u/\U/单字符)与
// 下标/get 形态容错臂。85(字面量尾反斜杠)为死码:末字符为 `\` 时必不
// 等于闭引号,149 先行返回,decodeEscape 的 next===undefined 不可达。
// ---------------------------------------------------------------------------

describe('KSEM-CELL-05 sweep: 转义解码族与形态容错臂', () => {
  it('decodeStringLiteral:八进制/十六进制/Unicode 转义族与非法面', () => {
    expect(decodeStringLiteral('"\\101"')).toBe('A');
    expect(decodeStringLiteral('"\\7"')).toBe('\x07');
    expect(decodeStringLiteral('"\\1010"')).toBe('A0');
    expect(decodeStringLiteral('"\\777"')).toBeNull();
    expect(decodeStringLiteral('"\\x41"')).toBe('A');
    expect(decodeStringLiteral('"\\xZZ"')).toBeNull();
    expect(decodeStringLiteral('"\\x4"')).toBeNull();
    expect(decodeStringLiteral('"\\u0041"')).toBe('A');
    expect(decodeStringLiteral('"\\uZZZZ"')).toBeNull();
    expect(decodeStringLiteral('"\\u41"')).toBeNull();
    expect(decodeStringLiteral('"\\U0001F600"')).toBe('😀');
    expect(decodeStringLiteral('"\\U0001F60"')).toBeNull();
    expect(decodeStringLiteral('"\\t\\r\\a\\b\\f\\v\\\\\\"\\\'"')).toBe('\t\r\x07\x08\x0c\x0b\\"\'');
  });

  it('decodeStringLiteral 容错:残引/未转义同引号/非引号开头', () => {
    expect(decodeStringLiteral('"')).toBeNull();
    expect(decodeStringLiteral("''")).toBe('');
    expect(decodeStringLiteral("'it's'")).toBeNull();
    expect(decodeStringLiteral('hp')).toBeNull();
  });

  it('parseCellDataKeyAccess:接收者后空白与键段空白/空段', () => {
    const spaced = parseCellDataKeyAccess('self.cellData [ "hp" ]', 13);
    expect(spaced).toMatchObject({ key: 'hp', keyLiteral: true, kind: 'subscript' });
    expect(parseCellDataKeyAccess('self.cellData[  ]', 13)).toBeNull();
    expect(parseCellDataKeyAccess('self.cellData[]', 13)).toBeNull();
  });

  it('parseCellDataKeyAccess:下标串内转义与同行未闭合', () => {
    expect(parseCellDataKeyAccess("self.cellData['a\\'b']", 13)).toMatchObject({ key: "a'b" });
    expect(parseCellDataKeyAccess('self.cellData["hp', 13)).toBeNull();
  });

  it('parseCellDataKeyAccess:get 形态边界(head 失配/未闭合/空首参/尾逗号)', () => {
    expect(parseCellDataKeyAccess('self.cellData.getx("hp")', 13)).toBeNull();
    expect(parseCellDataKeyAccess('self.cellData.get("hp"', 13)).toBeNull();
    expect(parseCellDataKeyAccess('self.cellData.get( )', 13)).toBeNull();
    expect(parseCellDataKeyAccess('self.cellData.get("hp", )', 13)).toMatchObject({
      key: 'hp',
      defaultExpr: null
    });
  });

  it('parseCellDataKeyAccess:get 首参扫描深度/串态与 default 提取', () => {
    expect(parseCellDataKeyAccess("self.cellData.get('a\\'b', 0)", 13)).toMatchObject({
      key: "a'b",
      defaultExpr: '0'
    });
    expect(parseCellDataKeyAccess('self.cellData.get(d["hp"], 0)', 13)).toMatchObject({
      key: null,
      rawKey: 'd["hp"]',
      defaultExpr: '0'
    });
    expect(parseCellDataKeyAccess('self.cellData.get("hp", 5)', 13)).toMatchObject({
      key: 'hp',
      defaultExpr: '5'
    });
  });

  it('parseCellDataKeyAccess:嵌套括号/括号键的深度臂(动态键不猜)', () => {
    expect(parseCellDataKeyAccess('self.cellData[d["hp"]]', 13)).toMatchObject({
      key: null,
      rawKey: 'd["hp"]'
    });
    expect(parseCellDataKeyAccess('self.cellData.get(make("hp"), 0)', 13)).toMatchObject({
      key: null,
      rawKey: 'make("hp")',
      defaultExpr: '0'
    });
  });

  it('parseCellDataKeyAccess:既非下标也非 get 的后继 → null', () => {
    expect(parseCellDataKeyAccess('self.cellData = {}', 13)).toBeNull();
    expect(parseCellDataKeyAccess('self.cellData.hp', 13)).toBeNull();
  });

  it('cellDataKeyAccessAtPosition:多访问行循环推进与收尾 break', () => {
    const line = 'self.cellData["hp"] + self.cellData["mp"]';
    const second = line.indexOf('"mp"') + 1;
    expect(cellDataKeyAccessAtPosition(line, second)).toMatchObject({ key: 'mp' });
    // 尾随内容让末次推进后再进一轮扫描 → 无匹配 break
    const trailing = 't = self.cellData["hp"] + 1';
    expect(cellDataKeyAccessAtPosition(trailing, 3)).toBeNull();
  });
});

  });
});

// ---------------------------------------------------------------------------
// 转义解引族(decodeStringLiteral):CELL-05 键字面量解引的四族转义(八进制/
// 十六进制/Unicode/非法)——本批前零覆盖。诚实边界:decodeEscape 的
// 「反斜杠收尾无下一字符」臂按当前调用图不可达(decodeStringLiteral 先验
// 证 trimmed 以引号收尾,转义下标恒 ≤ len-3,下一字符必存在),不硬凑。
// ---------------------------------------------------------------------------

describe('decodeStringLiteral 转义解引族', () => {
  it('八进制 1-3 位:\\101 解出 A', () => {
    expect(decodeStringLiteral('"\\101"')).toBe('A');
    expect(decodeStringLiteral('"\\7"')).toBe('\x07');
    expect(decodeStringLiteral('"a\\101b"')).toBe('aAb');
  });

  it('八进制越界(\\777 > 0xff):该键跳过,不改写键值', () => {
    expect(decodeStringLiteral('"\\777"')).toBeNull();
  });

  it('十六进制 \\xNN:合法解出,残缺两位跳过', () => {
    expect(decodeStringLiteral('"\\x41"')).toBe('A');
    expect(decodeStringLiteral('"\\x4"')).toBeNull();
    expect(decodeStringLiteral('"\\xzz"')).toBeNull();
  });

  it('Unicode \\uNNNN:合法解出,不足四位跳过', () => {
    expect(decodeStringLiteral('"\\u4e2d"')).toBe('中');
    expect(decodeStringLiteral('"\\u12"')).toBeNull();
    expect(decodeStringLiteral('"\\uzzzz"')).toBeNull();
  });

  it('扩展 \\UNNNNNNNN:合法解出,不足八位跳过', () => {
    expect(decodeStringLiteral('"\\U0001F600"')).toBe('\u{1F600}');
    expect(decodeStringLiteral('"\\U0001F6"')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 键访问解析边界(parseCellDataKeyAccess):未闭合/空段/嵌套深度/转义——
// 跳转与引用两个消费面共享的解析真源,边界落 null(不是可关联访问)。
// ---------------------------------------------------------------------------

describe('parseCellDataKeyAccess 边界面', () => {
  /** 从 receiver 尾后解析(receiver 恒取行内首处 self.cellData)。 */
  const parse = (line: string) => {
    const m = /self\.cellData/.exec(line)!;
    return parseCellDataKeyAccess(line, m.index + m[0].length);
  };

  it('空下标段 self.cellData[]:空区间 → null', () => {
    expect(parse('a = self.cellData[]')).toBeNull();
    expect(cellDataKeyAccessAtPosition('a = self.cellData[]', 17)).toBeNull();
  });

  it('下标段尾随空白:trimSpan 收尾,键位不含空白', () => {
    const line = 'a = self.cellData["hp"   ]';
    const res = parse(line);
    expect(res).toMatchObject({ key: 'hp', rawKey: '"hp"', kind: 'subscript' });
    expect(res?.keyStart).toBe(line.indexOf('"hp"') + 1);
    expect(res?.keyEnd).toBe(line.indexOf('"hp"') + 3);
  });

  it('get 段尾随空白同口径;无第二实参 defaultExpr 为 null', () => {
    const res = parse('a = self.cellData.get("hp" )');
    expect(res).toMatchObject({ key: 'hp', kind: 'get', defaultExpr: null });
  });

  it('嵌套下标 self.cellData[d["hp"]]:闭括号深度回账,动态键不跳转', () => {
    const res = parse('a = self.cellData[d["hp"]]');
    expect(res).toMatchObject({ key: null, keyLiteral: false, rawKey: 'd["hp"]' });
    // 引用面同口径:动态键不入索引
    expect(scanCellDataKeyAccesses('a = self.cellData[d["hp"]]')).toEqual([]);
  });

  it('下标未闭合(跨行):null', () => {
    expect(parse('a = self.cellData["hp"')).toBeNull();
  });

  it('get 嵌套括号(("hp"), 0):闭括号取最外配对,动态键/default 照常两分', () => {
    const res = parse('a = self.cellData.get(("hp"), 0)');
    expect(res).toMatchObject({ key: null, keyLiteral: false, rawKey: '("hp")', defaultExpr: '0', kind: 'get' });
  });

  it('get 括号未闭合(跨行):null', () => {
    expect(parse('a = self.cellData.get("hp"')).toBeNull();
  });

  it('get 空实参 self.cellData.get():空区间 → null', () => {
    expect(parse('a = self.cellData.get()')).toBeNull();
  });

  it('get 实参内转义:配对扫描不误断串,键值按转义解引', () => {
    const res = parse('a = self.cellData.get("a\\nb", 1)');
    expect(res?.key).toBe('a\nb');
    expect(res?.keyLiteral).toBe(true);
    expect(res?.defaultExpr).toBe('1');
  });

  it('get 首实参为调用 pick():括号抬深度不误切逗号,动态键不跳转', () => {
    const res = parse('a = self.cellData.get(pick(), 0)');
    expect(res).toMatchObject({ key: null, keyLiteral: false, rawKey: 'pick()', defaultExpr: '0' });
