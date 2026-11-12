import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CELL_DATA_KEYS_METHOD,
  cellDataKeyCompletionContext,
  cellScriptRoleAndEntity,
  collectCellDataDefUniverse,
  fetchCellDataKeys
} from '../src/backend/cellDataCompletion';
import { KBEngineCompletionProvider } from '../src/languageProviders';
import { setKodeCoreShadowGate } from '../src/backend/kodeCoreShadowFaces';
import type { KodeCoreGate } from '../src/backend/kodeCoreGate';
import { Position, Uri, makeTextDocument, workspace } from './helpers/vscodeStub';

// KSEM-CELL-04 键补全:`self.cellData["…"` / `self.cellData.get("…")` 字符串
// 键位 → Rust 键宇宙($/kode/semantics/cellDataKeys:CELL-01 字段集 +
// CELL-02 内建键 + CELL-03 组件槽)。验收:[] 和 get 的字符串键位补全键;
// 替换范围准确(引号内片段,不含引号);不混入其他实体/角色。

describe('cellDataKeyCompletionContext(键位上下文探测)', () => {
  const ctx = (lines: readonly string[], line: number, character: number) =>
    cellDataKeyCompletionContext(lines, line, character);

  it('bracket + double quote: partial and exact replace start', () => {
    const line = 'hp = self.cellData["h';
    expect(ctx([line], 0, 21)).toEqual({ partial: 'h', replaceStart: 20 });
  });

  it('get + single quote: partial and exact replace start', () => {
    const line = "x = self.cellData.get('tim";
    expect(ctx([line], 0, 27)).toEqual({ partial: 'tim', replaceStart: 24 });
  });

  it('spaces between cellData/[/get/( are tolerated', () => {
    expect(ctx(['self.cellData[  "m'], 0, 18)).toEqual({ partial: 'm', replaceStart: 17 });
    expect(ctx(['self.cellData.get ( "h'], 0, 23)).toEqual({ partial: 'h', replaceStart: 22 });
  });

  it('cursor right after the opening quote or bracket: empty partial insert range', () => {
    expect(ctx(['self.cellData["'], 0, 15)).toEqual({ partial: '', replaceStart: 15 });
    expect(ctx(['self.cellData['], 0, 14)).toEqual({ partial: '', replaceStart: 14 });
  });

  it('position after the closing quote or paren is not a key position', () => {
    expect(ctx(['self.cellData["hp"]'], 0, 19)).toBeNull();
    expect(ctx(["self.cellData.get('hp')"], 0, 23)).toBeNull();
  });

  it('non-self receiver and backslash fragment are not key positions', () => {
    expect(ctx(['other.cellData["h'], 0, 17)).toBeNull();
    // 片段含反斜杠(转义域):探测不接管
    expect(ctx(['self.cellData["a\\b'], 0, 18)).toBeNull();
  });

  it('line index resolves into a multi-line array; out-of-range is null', () => {
    expect(ctx(['pass', 'pass', 'hp = self.cellData["h'], 2, 21)).toEqual({ partial: 'h', replaceStart: 20 });
    expect(ctx(['pass'], 9, 3)).toBeNull();
  });
});

describe('cellScriptRoleAndEntity(角色/实体隔离)', () => {
  it('cell and base faces resolve with entity name', () => {
    expect(cellScriptRoleAndEntity('/home/ws/scripts/cell/Avatar.py')).toEqual({ role: 'cell', entity: 'Avatar' });
    expect(cellScriptRoleAndEntity('/home/ws/scripts/base/Monster.py')).toEqual({ role: 'base', entity: 'Monster' });
  });

  it('windows backslash paths normalize to the same answer', () => {
    expect(cellScriptRoleAndEntity('D:\\ws\\scripts\\cell\\Avatar.py')).toEqual({ role: 'cell', entity: 'Avatar' });
  });

  it('entity names may contain underscores and digits', () => {
    expect(cellScriptRoleAndEntity('/home/ws/scripts/cell/Boss_2x.py')).toEqual({ role: 'cell', entity: 'Boss_2x' });
  });

  it('client/bots faces and non-script paths are not taken over', () => {
    expect(cellScriptRoleAndEntity('/home/ws/scripts/client/Avatar.py')).toBeNull();
    expect(cellScriptRoleAndEntity('/home/ws/scripts/bots/Avatar.py')).toBeNull();
    expect(cellScriptRoleAndEntity('/home/ws/scripts/entity_defs/Avatar.def')).toBeNull();
    expect(cellScriptRoleAndEntity('/home/ws/src/Avatar.py')).toBeNull();
  });
});

describe('collectCellDataDefUniverse(def 宇宙闭包)', () => {
  interface Call {
    name: string;
    category: 'entity' | 'interface' | 'component';
  }

  const makeUniverse = (defs: Record<string, string>) => {
    const calls: Call[] = [];
    const findDefText = (name: string, category: 'entity' | 'interface' | 'component'): string | null => {
      calls.push({ name, category });
      return defs[`${category}:${name}`] ?? null;
    };
    return { calls, collect: (entity: string) => collectCellDataDefUniverse(entity, findDefText) };
  };

  it('BFS closure over parent/interfaces/component edges keeps discovery order', () => {
    const { calls, collect } = makeUniverse({
      'entity:Avatar':
        '<root><Parent>Monster</Parent><Interfaces><Interface>Mixin</Interface></Interfaces><Components><weapon><Type>Weapon</Type></weapon></Components></root>',
      'entity:Monster': '<root></root>',
      'interface:Mixin': '<root><Parent>IgnoredFace</Parent></root>',
      'component:Weapon': '<root><Parent>Mount</Parent></root>',
      'component:Mount': '<root></root>'
    });
    const defs = collect('Avatar');
    expect(defs.map(d => d.name)).toEqual(['Avatar', 'Monster', 'Mixin', 'Weapon', 'Mount']);
    // 接口 def 不走 Parent 边(引擎 loadInterfaces 不读 Parent)
    expect(calls.some(c => c.name === 'IgnoredFace')).toBe(false);
    // 组件 def 的父也是组件
    expect(calls).toContainEqual({ name: 'Mount', category: 'component' });
    expect(calls).not.toContainEqual({ name: 'Mount', category: 'entity' });
  });

  it('missing files are skipped without fabrication', () => {
    const { collect } = makeUniverse({
      'entity:Ghost': '<root><Parent>None</Parent><Interfaces><Interface>Nowhere</Interface></Interfaces></root>'
    });
    const defs = collect('Ghost');
    expect(defs.map(d => d.name)).toEqual(['Ghost']);
  });

  it('parent cycles terminate with both sides collected once', () => {
    const { collect } = makeUniverse({
      'entity:A': '<root><Parent>B</Parent></root>',
      'entity:B': '<root><Parent>A</Parent></root>'
    });
    const defs = collect('A');
    expect(defs.map(d => d.name)).toEqual(['A', 'B']);
  });

  it('unparseable def text still reaches Rust (TS parse failure withholds nothing)', () => {
    const { collect } = makeUniverse({
      'entity:Avatar': 'not-xml-at-all'
    });
    const defs = collect('Avatar');
    expect(defs).toHaveLength(1);
    expect(defs[0].text).toBe('not-xml-at-all');
  });
});

describe('fetchCellDataKeys(Rust 键宇宙查询)', () => {
  afterEach(() => {
    setKodeCoreShadowGate(null);
  });

  it('no gate → null (no completion, no fabrication)', async () => {
    setKodeCoreShadowGate(null);
    expect(await fetchCellDataKeys('Avatar', [])).toBeNull();
  });

  it('ok result maps keys and passes entity/defs through the exact method', async () => {
    let calledMethod = '';
    let calledParams: unknown = null;
    const fakeGate = {
      runInRust: async (method: string, params: unknown) => {
        calledMethod = method;
        calledParams = params;
        return {
          ok: true,
          result: {
            // wire 形状:Rust CellDataKeyKind 带 serde tag="kind"(内嵌标签对象)
            keys: [{ key: 'hp', kind: { kind: 'defField' }, typeLabel: 'UINT16', sourceFile: 'Avatar.def', sourceLine: 5 }]
          }
        };
      }
    } as unknown as KodeCoreGate;
    setKodeCoreShadowGate(fakeGate);
    const keys = await fetchCellDataKeys('Avatar', [{ name: 'Avatar', text: '<root></root>' }]);
    expect(calledMethod).toBe(CELL_DATA_KEYS_METHOD);
    expect(calledParams).toEqual({ entity: 'Avatar', defs: [{ name: 'Avatar', text: '<root></root>' }] });
    expect(keys).toEqual([{ key: 'hp', kind: 'defField', typeLabel: 'UINT16', sourceFile: 'Avatar.def', sourceLine: 5 }]);
  });

  it('failed call, non-array keys, or malformed entries void the whole result', async () => {
    const gate = (result: unknown, ok = true) =>
      ({ runInRust: async () => ({ ok, result }) }) as unknown as KodeCoreGate;
    setKodeCoreShadowGate(gate(null, false));
    expect(await fetchCellDataKeys('Avatar', [])).toBeNull();
    setKodeCoreShadowGate(gate({}));
    expect(await fetchCellDataKeys('Avatar', [])).toBeNull();
    setKodeCoreShadowGate(gate({ keys: [{ kind: { kind: 'defField' } }] }));
    expect(await fetchCellDataKeys('Avatar', [])).toBeNull();
    setKodeCoreShadowGate(gate({ keys: [{ key: 'hp', kind: { kind: 'nope' } }] }));
    expect(await fetchCellDataKeys('Avatar', [])).toBeNull();
  });
});

describe('KBEngineCompletionProvider cellData 键位分支(CELL-04 全链)', () => {
  const ORIGINAL_FOLDERS = workspace.workspaceFolders;

  let root = '';

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-celldata-'));
    const put = (relative: string, content: string) => {
      const file = path.join(root, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, 'utf8');
    };
    // 闭包边:Avatar → Parent Monster / Interface Mixin / 组件 Weapon;
    // Weapon 的父 Mount 也是组件(引擎 loadComponents 口径)。
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
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'celldata', index: 0 }];
  });

  afterEach(() => {
    workspace.workspaceFolders = ORIGINAL_FOLDERS;
    setKodeCoreShadowGate(null);
    if (root) {
      fs.rmSync(root, { recursive: true, force: true });
      root = '';
    }
  });

  // wire 形状(Rust serde tag="kind" 内嵌标签对象;fetchCellDataKeys 解包为
  // 平面串后下游才见 kind: 'defField')
  const CANNED_KEYS = [
    { key: 'hp', kind: { kind: 'defField' }, typeLabel: 'UINT16', sourceFile: 'Avatar.def', sourceLine: 5 },
    { key: 'position', kind: { kind: 'builtin' }, typeLabel: 'Vector3Like', sourceFile: 'server/baseapp/entity.cpp:250', sourceLine: null },
    { key: 'weapon', kind: { kind: 'componentSlot' }, typeLabel: 'Weapon', sourceFile: 'Avatar.def', sourceLine: 7 }
  ];

  const installGate = (
    keys: typeof CANNED_KEYS | null
  ): { method: string; params: unknown } => {
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

  const complete = async (
    fileName: string,
    lineText: string
  ): Promise<Array<{ label: string; detail?: string; range?: { start: { line: number; character: number }; end: { line: number; character: number } } }>> => {
    const provider = new KBEngineCompletionProvider();
    const document = makeTextDocument(`${lineText}\n`, { fileName, languageId: 'python' });
    const items = (await provider.provideCompletionItems(document, new Position(0, lineText.length))) as
      | Array<{ label: string; detail?: string; range?: { start: { line: number; character: number }; end: { line: number; character: number } } }>
      | undefined;
    return items ?? [];
  };

  it('completes defField/builtin/componentSlot keys with exact replace range', async () => {
    installGate(CANNED_KEYS);
    const items = await complete(path.join(root, 'scripts', 'cell', 'Avatar.py'), 'hp = self.cellData["h');
    expect(items.map(item => item.label).sort()).toEqual(['hp', 'position', 'weapon']);
    const hp = items.find(item => item.label === 'hp');
    expect(hp?.detail).toBe('UINT16 · Avatar.def:5');
    const position = items.find(item => item.label === 'position');
    expect(position?.detail).toBe('Vector3Like · server/baseapp/entity.cpp:250');
    // 替换范围 = 引号内片段精确区间(不含引号):"h" 的 h 位
    for (const item of items) {
      expect(item.range?.start).toEqual({ line: 0, character: 20 });
      expect(item.range?.end).toEqual({ line: 0, character: 21 });
    }
  });

  it('empty partial in get-quote is an insert range at the cursor', async () => {
    installGate(CANNED_KEYS);
    const items = await complete(path.join(root, 'scripts', 'base', 'Avatar.py'), "v = self.cellData.get('");
    expect(items.map(item => item.label).sort()).toEqual(['hp', 'position', 'weapon']);
    for (const item of items) {
      expect(item.range?.start).toEqual({ line: 0, character: 23 });
      expect(item.range?.end).toEqual({ line: 0, character: 23 });
    }
  });

  it('rpc params carry the entity and the real on-disk def closure', async () => {
    const capture = installGate(CANNED_KEYS);
    await complete(path.join(root, 'scripts', 'cell', 'Avatar.py'), 'self.cellData["');
    expect(capture.method).toBe(CELL_DATA_KEYS_METHOD);
    const params = capture.params as { entity: string; defs: Array<{ name: string; text: string }> };
    expect(params.entity).toBe('Avatar');
    expect(params.defs.map(d => d.name)).toEqual(['Avatar', 'Monster', 'Mixin', 'Weapon', 'Mount']);
    // 接口 def 的 Parent 不产生边(引擎口径)
    expect(params.defs.some(d => d.name === 'IgnoredFace')).toBe(false);
  });

  it('client face is not hijacked (no other-role leakage)', async () => {
    installGate(CANNED_KEYS);
    const items = await complete(path.join(root, 'scripts', 'client', 'Avatar.py'), 'hp = self.cellData["h');
    // 分支不接管:客户端面 cellData 不可达,罐头键绝不漏出
    expect(items).toEqual([]);
  });

  it('rust unavailable yields empty list, never fabricated keys', async () => {
    installGate(null);
    const items = await complete(path.join(root, 'scripts', 'cell', 'Avatar.py'), 'self.cellData["h');
    expect(items).toEqual([]);
  });

  it('non-key positions keep the existing chain (reloadScript)', async () => {
    installGate(CANNED_KEYS);
    const items = await complete(path.join(root, 'scripts', 'cell', 'Avatar.py'), 'self.cellData = KBEngine.');
    expect(items.map(item => item.label)).toContain('reloadScript');
  });
});
