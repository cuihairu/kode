import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cellDataKeyAccessAtPosition,
  isCellDataKeyInsideLineComment,
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
