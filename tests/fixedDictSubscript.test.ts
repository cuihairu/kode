// KSEM-STRUCT-02:FIXED_DICT 子字段下标链验收——纯核心三件(行内探测/
// 逐层解析/别名接收者)+ Provider 三面(补全/跳转/悬停)接线。
//
// 引擎真源锚定(fixeddict.h:pyscript::Map):字符串下标与 items/keys/values/
// get 是引擎实际支持的读取面;整数下标打在 FD 上、字符串键打在数组上都是
// 引擎不支持的访问,解析期诚实断链(不猜)。数据保真走 CustomTypeInfo
// 高保真面(字段名/typeStructure 内联数组树/声明行)。
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  fixedDictChainRootType,
  fixedDictSubscriptContextAt,
  resolveFixedDictSubscriptKey,
  type FixedDictChainSegment
} from '../src/backend/fixedDictSubscript';
import type {
  CustomTypeInfo,
  CustomTypePropertyInfo,
  CustomTypeStructureChild,
  CustomTypeStructureNode
} from '../src/definitionWorkspace';
import { KBEngineCompletionProvider } from '../src/languageProviders';
import { KBEngineHoverProvider } from '../src/languageProviders/hover';
import { PythonDefinitionProvider } from '../src/languageProviders/pythonDefinition';
import { EntityMappingManager } from '../src/entityMapping';
import { Position, Uri, makeTextDocument, workspace } from './helpers/vscodeStub';

/** 键串内容中列(引号内首字符列),跳过同行更早的同名形态。 */
const keyCol = (line: string, key: string, occurrence = 0): number => {
  let from = 0;
  for (let i = 0; i <= occurrence; i += 1) {
    const found = line.indexOf(`"${key}"`, from);
    if (i === occurrence) {
      return found + 1;
    }
    from = found + 1;
  }
  return -1;
};

// ---------------------------------------------------------------------------
// 内联注册表夹具(镜像 types.xml 高保真形状:字段名/内联数组结构树/声明行)
// ---------------------------------------------------------------------------

const TYPES_FILE = '/entity_defs/types.xml';

function node(name: string, line: number, children: CustomTypeStructureChild[] = []): CustomTypeStructureNode {
  return { name, rawValue: name, children, line };
}

function scalarField(name: string, typeName: string, line: number): CustomTypePropertyInfo {
  return { name, typeName, line };
}

function inlineArrayField(name: string, element: string, line: number): CustomTypePropertyInfo {
  return {
    name,
    typeName: 'ARRAY',
    typeStructure: node('ARRAY', line, [{ tag: 'of', value: node(element, line) }]),
    line
  };
}

function customType(
  name: string,
  aliasType: string,
  properties: CustomTypePropertyInfo[],
  line: number,
  structure?: CustomTypeStructureNode
): CustomTypeInfo {
  return {
    name,
    filePath: TYPES_FILE,
    line,
    implementedByLine: line,
    startOffset: 0,
    endOffset: 0,
    aliasType,
    rawValue: '',
    structure: structure ?? node(aliasType, line),
    properties
  };
}

const POSITION = customType('POSITION', 'FIXED_DICT', [
  scalarField('x', 'FLOAT', 12),
  scalarField('y', 'FLOAT', 14),
  scalarField('z', 'FLOAT', 16)
], 10);

const SKILL_SLOT = customType('SKILL_SLOT', 'FIXED_DICT', [
  inlineArrayField('slot_list', 'UINT32', 22),
  scalarField('count', 'UINT32', 24)
], 20);

const AVATAR_INFO = customType('AVATAR_INFO', 'FIXED_DICT', [
  scalarField('pos', 'POSITION', 31),
  scalarField('slot', 'SKILL_SLOT', 32),
  scalarField('label', 'STRING', 33)
], 30);

// 环形类型图(病态但合法 XML):链深度有界的终止性证据
const LOOP_B = customType('LOOP_B', 'FIXED_DICT', [], 60);
const LOOP_A = customType('LOOP_A', 'FIXED_DICT', [scalarField('b', 'LOOP_B', 59)], 58);
LOOP_B.properties = [scalarField('a', 'LOOP_A', 63)];

const POS_BAG = customType('POS_BAG', 'ARRAY', [], 40, node('ARRAY', 40, [{ tag: 'of', value: node('POSITION', 41) }]));

const WEIRD = customType('WEIRD', 'FIXED_DICT', [
  { name: 'missing', line: 51 }, // 无 <Type>:诚实 Any
  scalarField('ok', 'STRING', 52)
], 50);

const REGISTRY: CustomTypeInfo[] = [POSITION, SKILL_SLOT, AVATAR_INFO, POS_BAG, WEIRD, LOOP_A, LOOP_B];

const keySeg = (key: string): FixedDictChainSegment => ({
  kind: 'key', key, keyStart: -1, keyEnd: 0, form: 'subscript'
});
const indexSeg: FixedDictChainSegment = { kind: 'index', form: 'subscript' };

// ---------------------------------------------------------------------------
// 行内探测 fixedDictSubscriptContextAt
// ---------------------------------------------------------------------------

describe('fixedDictSubscriptContextAt 行内探测', () => {
  it('嵌套开键串:前段闭键+当前开键,替换起点=片段首列', () => {
    const line = 'value = data["pos"]["x';
    const hit = fixedDictSubscriptContextAt(line, line.length);
    expect(hit).not.toBeNull();
    expect(hit?.cursor).toBe('open-key');
    expect(hit?.receiver).toBe('data');
    expect(hit?.segments).toHaveLength(2);
    expect(hit?.segments[0]).toMatchObject({ kind: 'key', key: 'pos', form: 'subscript', keyEnd: expect.any(Number) });
    expect(hit?.segments[1]).toMatchObject({ kind: 'key', key: 'x', keyEnd: null });
    expect(hit?.replaceStart).toBe(line.length - 1);
  });

  it('空开键串(光标紧跟开引号)与裸 `[`/`.get(` 位:空片段接管', () => {
    const quoted = 'self.pos["';
    const hitQ = fixedDictSubscriptContextAt(quoted, quoted.length);
    expect(hitQ?.cursor).toBe('open-key');
    expect(hitQ?.replaceStart).toBe(quoted.length);
    expect(hitQ?.segments).toHaveLength(1);

    const bare = 'self.pos[';
    const hitB = fixedDictSubscriptContextAt(bare, bare.length);
    expect(hitB?.cursor).toBe('open-key');
    expect(hitB?.replaceStart).toBe(bare.length);

    const bareGet = 'data.get(';
    const hitG = fixedDictSubscriptContextAt(bareGet, bareGet.length);
    expect(hitG?.cursor).toBe('open-key');
    expect(hitG?.segments[0]).toMatchObject({ kind: 'key', form: 'get' });

    const quotedGet = 'self.pos.get("';
    const hitQG = fixedDictSubscriptContextAt(quotedGet, quotedGet.length);
    expect(hitQG?.cursor).toBe('open-key');
    expect(hitQG?.segments[0]).toMatchObject({ kind: 'key', form: 'get' });
  });

  it('裸 `[` 后键入中的表达式片段不接管(防表达式位弹键补全)', () => {
    const line = 'data[variable';
    expect(fixedDictSubscriptContextAt(line, line.length)).toBeNull();
  });

  it('闭键串内容位:key 态,段含光标键为止(后段丢弃)', () => {
    const line = 'x = self.info["pos"]["x"] + 1';
    const hit = fixedDictSubscriptContextAt(line, keyCol(line, 'x'));
    expect(hit?.cursor).toBe('key');
    expect(hit?.receiver).toBe('self.info');
    expect(hit?.segments).toHaveLength(2);
    expect(hit?.segments[0]).toMatchObject({ kind: 'key', key: 'pos' });
    expect(hit?.segments[1]).toMatchObject({ kind: 'key', key: 'x' });

    const first = fixedDictSubscriptContextAt(line, keyCol(line, 'pos'));
    expect(first?.cursor).toBe('key');
    expect(first?.segments).toHaveLength(1);
    expect(first?.segments[0]).toMatchObject({ kind: 'key', key: 'pos' });
  });

  it('.get 闭形也是键段;index 段入链但 index 内容位不接管', () => {
    const line = 'v = data.get("pos")["x"]';
    const hit = fixedDictSubscriptContextAt(line, keyCol(line, 'x'));
    expect(hit?.cursor).toBe('key');
    expect(hit?.segments[0]).toMatchObject({ kind: 'key', key: 'pos', form: 'get' });
    expect(hit?.segments[1]).toMatchObject({ kind: 'key', key: 'x' });

    const bagLine = 'p = bag[0]["x"]';
    expect(fixedDictSubscriptContextAt(bagLine, keyCol(bagLine, 'x'))?.segments[0]).toMatchObject({ kind: 'index' });
    expect(fixedDictSubscriptContextAt(bagLine, bagLine.indexOf('0'))).toBeNull();
  });

  it('闭引号已打、收括号未打的行尾形态按闭段收(键串内仍可分类)', () => {
    const line = 'x = data["pos"';
    expect(fixedDictSubscriptContextAt(line, keyCol(line, 'pos'))?.cursor).toBe('key');
    // 闭引号之后(含闭引号列)不是键位
    expect(fixedDictSubscriptContextAt(line, line.length)).toBeNull();
  });

  it('行内注释位不接管;链外位置(等号/闭括号后)不接管', () => {
    expect(fixedDictSubscriptContextAt('# data["pos"]["x', 16)).toBeNull();
    const line = 'x = data["pos"] + 1';
    expect(fixedDictSubscriptContextAt(line, 0)).toBeNull();
    expect(fixedDictSubscriptContextAt(line, line.indexOf(']'))).toBeNull();
  });

  it('属性中段不误作接收者(self.<prop> 整体形态接管)', () => {
    const line = 'x = self.info["pos"]["x"]';
    const hit = fixedDictSubscriptContextAt(line, keyCol(line, 'pos'));
    expect(hit?.receiver).toBe('self.info');
    expect(hit?.receiverStart).toBe(line.indexOf('self'));
  });
});

// ---------------------------------------------------------------------------
// 逐层解析 resolveFixedDictSubscriptKey
// ---------------------------------------------------------------------------

describe('resolveFixedDictSubscriptKey 逐层解析', () => {
  it('首层键:容器+字段+值注解', () => {
    const hit = resolveFixedDictSubscriptKey('POSITION', [], 'x', REGISTRY);
    expect(hit?.container.name).toBe('POSITION');
    expect(hit?.field?.name).toBe('x');
    expect(hit?.annotation).toBe('float');
  });

  it('嵌套键:前段全解析后落在内层容器', () => {
    const hit = resolveFixedDictSubscriptKey('AVATAR_INFO', [keySeg('pos')], 'x', REGISTRY);
    expect(hit?.container.name).toBe('POSITION');
    expect(hit?.annotation).toBe('float');
  });

  it('嵌套容器键的值注解=FIXED_DICT 类名(与存根/hover 同链)', () => {
    const hit = resolveFixedDictSubscriptKey('AVATAR_INFO', [], 'pos', REGISTRY);
    expect(hit?.annotation).toBe('POSITION');
  });

  it('内联数组字段注解=FixedArray[元素型](STRUCT-03 下标面接管元素)', () => {
    const hit = resolveFixedDictSubscriptKey('SKILL_SLOT', [], 'slot_list', REGISTRY);
    expect(hit?.annotation).toBe('FixedArray[int]');
  });

  it('诚实断链:链中未知键/数组上的字符串键/FD 上的整数下标', () => {
    expect(resolveFixedDictSubscriptKey('AVATAR_INFO', [keySeg('nope')], 'x', REGISTRY)).toBeNull();
    expect(resolveFixedDictSubscriptKey('POS_BAG', [keySeg('k')], 'x', REGISTRY)).toBeNull();
    expect(resolveFixedDictSubscriptKey('POSITION', [indexSeg], 'x', REGISTRY)).toBeNull();
    expect(resolveFixedDictSubscriptKey('SKILL_SLOT', [keySeg('slot_list')], 'x', REGISTRY)).toBeNull();
  });

  it('数组元素 FD:整数下标段后继续键解析', () => {
    const hit = resolveFixedDictSubscriptKey('POS_BAG', [indexSeg], 'x', REGISTRY);
    expect(hit?.container.name).toBe('POSITION');
    expect(hit?.annotation).toBe('float');
  });

  it('非 FD 根/空根:不接管', () => {
    expect(resolveFixedDictSubscriptKey('UINT16', [], 'x', REGISTRY)).toBeNull();
    expect(resolveFixedDictSubscriptKey('', [], 'x', REGISTRY)).toBeNull();
    expect(resolveFixedDictSubscriptKey(undefined, [], 'x', REGISTRY)).toBeNull();
  });

  it('未知键:容器给出(补全面供全字段),字段/注解落空', () => {
    const hit = resolveFixedDictSubscriptKey('POSITION', [], 'nope', REGISTRY);
    expect(hit?.container.name).toBe('POSITION');
    expect(hit?.field).toBeNull();
    expect(hit?.annotation).toBeNull();
  });

  it('无 <Type> 字段:命中字段但注解 Any → null(能推才显)', () => {
    const hit = resolveFixedDictSubscriptKey('WEIRD', [], 'missing', REGISTRY);
    expect(hit?.field?.name).toBe('missing');
    expect(hit?.annotation).toBeNull();
  });

  it('环形类型图:链深度有界(8 段上限)终止,不无限下钻', () => {
    // LOOP_A.b: LOOP_B, LOOP_B.a: LOOP_A —— 7 段(b 起,奇数段后落 LOOP_B)可解析,9 段超界断链
    const seven: FixedDictChainSegment[] = [];
    for (let i = 0; i < 7; i += 1) {
      seven.push(keySeg(i % 2 === 0 ? 'b' : 'a'));
    }
    const hit = resolveFixedDictSubscriptKey('LOOP_A', seven, 'a', REGISTRY);
    expect(hit?.container.name).toBe('LOOP_B');
    const nine: FixedDictChainSegment[] = [];
    for (let i = 0; i < 9; i += 1) {
      nine.push(keySeg(i % 2 === 0 ? 'b' : 'a'));
    }
    expect(resolveFixedDictSubscriptKey('LOOP_A', nine, 'a', REGISTRY)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 别名接收者 fixedDictChainRootType
// ---------------------------------------------------------------------------

describe('fixedDictChainRootType 接收者定型', () => {
  const locator = async (prop: string) => (prop === 'pos' ? 'POSITION' : prop === 'info' ? 'AVATAR_INFO' : null);

  it('self.<属性> 直达与裸名别名一层', async () => {
    expect(await fixedDictChainRootType('self.pos', ['v = self.pos["x"]'], 0, locator)).toBe('POSITION');
    const lines = ['data = self.pos', 'v = data["x"]'];
    expect(await fixedDictChainRootType('data', lines, 1, locator)).toBe('POSITION');
  });

  it('别名间接一层(别名之别名),深度有界', async () => {
    const lines = ['a = self.pos', 'b = a', 'v = b["x"]'];
    expect(await fixedDictChainRootType('b', lines, 2, locator)).toBe('POSITION');
    const deep = ['a = self.pos', 'b = a', 'c = b', 'v = c["x"]'];
    expect(await fixedDictChainRootType('c', deep, 3, locator)).toBeNull();
  });

  it('链式/调用 RHS 不追;无赋值/注释赋值不认;未声明属性落 null', async () => {
    expect(await fixedDictChainRootType('d', ['d = self.pos["x"]', 'v = d["y"]'], 1, locator)).toBeNull();
    expect(await fixedDictChainRootType('data', ['v = data["x"]'], 0, locator)).toBeNull();
    expect(await fixedDictChainRootType('data', ['# data = self.pos', 'v = data["x"]'], 1, locator)).toBeNull();
    expect(await fixedDictChainRootType('self.unknown', ['v = self.unknown["x"]'], 0, locator)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Provider 三面接线(真实 EntityMappingManager + 真实 types.xml 解析)
// ---------------------------------------------------------------------------

describe('KSEM-STRUCT-02 Provider 三面(补全/跳转/悬停)', () => {
  const ORIGINAL_FOLDERS = workspace.workspaceFolders;
  // 默认桩 findFiles 恒返回 [](tests/fake-vscode/workspaceState.ts):EntityMappingManager
  // 的定向 .def 首解析靠 glob 发现 Avatar.def,必须按真实盘遍历补齐
  // (口径同 tests/entityMappingManager.test.ts 的扫描桩)。
  const ORIGINAL_FIND_FILES = workspace.findFiles;

  let root = '';
  let typesXmlLines: string[] = [];

  const put = (relative: string, content: string) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-struct02-'));
    const typesXml = [
      '<root>',
      '  <POSITION>',
      '    FIXED_DICT',
      '    <Properties>',
      '      <x>',
      '        <Type> FLOAT </Type>',
      '      </x>',
      '      <y>',
      '        <Type> FLOAT </Type>',
      '      </y>',
      '      <z>',
      '        <Type> FLOAT </Type>',
      '      </z>',
      '    </Properties>',
      '  </POSITION>',
      '  <SKILL_SLOT>',
      '    FIXED_DICT',
      '    <Properties>',
      '      <slot_list>',
      '        <Type>',
      '          ARRAY',
      '          <of> UINT32 </of>',
      '        </Type>',
      '      </slot_list>',
      '      <count>',
      '        <Type> UINT32 </Type>',
      '      </count>',
      '      <!-- 无 <Type> 字段:解析器如实留空 → 值注解 Any -->',
      '      <missing/>',
      '    </Properties>',
      '  </SKILL_SLOT>',
      '  <AVATAR_INFO>',
      '    FIXED_DICT',
      '    <Properties>',
      '      <pos>',
      '        <Type> POSITION </Type>',
      '      </pos>',
      '      <slot>',
      '        <Type> SKILL_SLOT </Type>',
      '      </slot>',
      '    </Properties>',
      '  </AVATAR_INFO>',
      '  <POS_BAG>',
      '    ARRAY',
      '    <of> POSITION </of>',
      '  </POS_BAG>',
      '</root>'
    ].join('\n');
    put('scripts/entity_defs/types.xml', typesXml);
    put('scripts/entities.xml', '<root>\n  <Avatar hasBase="true" hasCell="true"/>\n</root>');
    // python 实文件落盘:EntityMappingManager 的 def 归属索引按磁盘存在性
    // 建立 Avatar.py → Avatar.def 映射(entities.xml hasCell 面)
    put('scripts/cell/Avatar.py', 'class Avatar(object):\n    pass\n');
    put(
      'scripts/entity_defs/Avatar.def',
      [
        '<root>',
        '  <Properties>',
        '    <pos><Type>POSITION</Type><Flags>CELL_PUBLIC</Flags></pos>',
        '    <info><Type>AVATAR_INFO</Type><Flags>CELL_PUBLIC</Flags></info>',
        '    <skills><Type>SKILL_SLOT</Type><Flags>CELL_PUBLIC</Flags></skills>',
        '    <bag><Type>POS_BAG</Type><Flags>CELL_PUBLIC</Flags></bag>',
        '    <hp><Type>UINT16</Type><Flags>CELL_PUBLIC</Flags></hp>',
        '  </Properties>',
        '</root>'
      ].join('\n')
    );
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'struct02', index: 0 }];
    const walkDefs = (dir: string, results: Uri[]): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walkDefs(full, results);
        } else if (entry.name.endsWith('.def')) {
          results.push(Uri.file(full));
        }
      }
    };
    workspace.findFiles = (async () => {
      const results: Uri[] = [];
      walkDefs(root, results);
      return results;
    }) as unknown as typeof workspace.findFiles;
    typesXmlLines = typesXml.split('\n');
  });

  afterEach(() => {
    workspace.workspaceFolders = ORIGINAL_FOLDERS;
    workspace.findFiles = ORIGINAL_FIND_FILES;
    if (root) {
      fs.rmSync(root, { recursive: true, force: true });
      root = '';
    }
  });

  /** types.xml 里标记行(1 起)——跳转/补全 detail 的期望行号单一来源 */
  const xmlLine = (marker: string): number => typesXmlLines.findIndex(line => line.includes(marker)) + 1;

  const cellDoc = (text: string) =>
    makeTextDocument(`${text}\n`, { fileName: path.join(root, 'scripts', 'cell', 'Avatar.py'), languageId: 'python' });

  const manager = () => new EntityMappingManager({ subscriptions: [] } as never);

  // ---- 补全面 ----

  type CompletionLike = { label: string; detail?: string };

  const complete = async (lineText: string, managerOverride?: EntityMappingManager) => {
    const provider = new KBEngineCompletionProvider(managerOverride ?? manager());
    const document = cellDoc(lineText);
    const items = (await provider.provideCompletionItems(document, new Position(0, lineText.length))) as
      | CompletionLike[]
      | undefined;
    return items ?? [];
  };

  it('首层开键串:FIXED_DICT 属性逐字段补全,detail=值注解 · types.xml 声明行', async () => {
    const items = await complete('v = self.pos["');
    expect(items.map(item => item.label).sort()).toEqual(['x', 'y', 'z']);
    const x = items.find(item => item.label === 'x');
    expect(x?.detail).toBe(`float · types.xml:${xmlLine('<x>')}`);
  });

  it('嵌套开键串:前段解析后的内层容器字段;数组元素 FD 同面', async () => {
    const nested = await complete('v = self.info["pos"]["');
    expect(nested.map(item => item.label).sort()).toEqual(['x', 'y', 'z']);
    const throughArray = await complete('p = self.bag[0]["');
    expect(throughArray.map(item => item.label).sort()).toEqual(['x', 'y', 'z']);
  });

  it('别名接收者与 .get 形态同面', async () => {
    const document = cellDoc('data = self.pos\nv = data["');
    const provider = new KBEngineCompletionProvider(manager());
    const items = (await provider.provideCompletionItems(document, new Position(1, 'v = data["'.length))) as
      | CompletionLike[]
      | undefined;
    expect((items ?? []).map(item => item.label).sort()).toEqual(['x', 'y', 'z']);
    const viaGet = await complete('g = self.pos.get("');
    expect(viaGet.map(item => item.label).sort()).toEqual(['x', 'y', 'z']);
  });

  it('非 FD 根/未知字段:不接管不造键', async () => {
    const scalar = await complete('n = self.hp["');
    expect(scalar.map(item => item.label)).not.toContain('x');
    const brokenChain = await complete('v = self.info["nope"]["');
    expect(brokenChain.map(item => item.label)).not.toContain('x');
  });

  it('无 manager 注入:诚实落空(不接管)', async () => {
    const provider = new KBEngineCompletionProvider();
    const items = (await provider.provideCompletionItems(cellDoc('v = self.pos["'), new Position(0, 14))) as
      | CompletionLike[]
      | undefined;
    expect((items ?? []).map(item => item.label)).not.toContain('x');
  });

  // ---- 跳转面 ----

  it('F12 嵌套键 → types.xml 字段声明行(逐层容器归位)', async () => {
    const line = 'v = self.info["pos"]["x"]';
    const doc = cellDoc(line);
    const provider = new PythonDefinitionProvider(manager(), undefined, undefined);
    const traced = await provider.provideDefinitionTraced(doc, new Position(0, keyCol(line, 'x')));
    expect(traced.location?.uri.fsPath).toBe(path.join(root, 'scripts', 'entity_defs', 'types.xml'));
    expect(traced.location?.range.start.line).toBe(xmlLine('<x>') - 1);
    expect(traced.layers[0]).toMatchObject({ layer: 'fixeddict-key', status: 'hit' });

    const outer = await provider.provideDefinitionTraced(doc, new Position(0, keyCol(line, 'pos')));
    expect(outer.location?.range.start.line).toBe(xmlLine('<pos>') - 1);
  });

  it('F12 未知键/数组元素位:不造跳转,交回常规链', async () => {
    const provider = new PythonDefinitionProvider(manager(), undefined, undefined);
    const unknown = 'v = self.pos["nope"]';
    const tracedUnknown = await provider.provideDefinitionTraced(
      cellDoc(unknown),
      new Position(0, keyCol(unknown, 'nope'))
    );
    expect(tracedUnknown.layers.some(layer => layer.layer === 'fixeddict-key')).toBe(false);

    const indexPos = 'p = self.bag[0]';
    const tracedIndex = await provider.provideDefinitionTraced(
      cellDoc(indexPos),
      new Position(0, indexPos.indexOf('0'))
    );
    expect(tracedIndex.layers.some(layer => layer.layer === 'fixeddict-key')).toBe(false);
  });

  // ---- 悬停面 ----

  const hoverAt = async (lines: string[], line: number, character: number) => {
    const document = makeTextDocument(`${lines.join('\n')}\n`, {
      fileName: path.join(root, 'scripts', 'cell', 'Avatar.py'),
      languageId: 'python'
    });
    const provider = new KBEngineHoverProvider(manager());
    const hover = (await provider.provideHover(document as never, new Position(line, character))) as
      | { contents?: unknown }
      | null;
    const contents = hover?.contents as unknown;
    const parts = Array.isArray(contents) ? contents : contents !== undefined ? [contents] : [];
    const first = parts[0] as { value?: string } | undefined;
    return first?.value ?? null;
  };

  it('键悬停:值注解 + types.xml 声明位置(嵌套层与别名接收者)', async () => {
    const nested = await hoverAt(['v = self.info["pos"]["x"]'], 0, keyCol('v = self.info["pos"]["x"]', 'x'));
    expect(nested).toContain('**x: float**');
    expect(nested).toContain(`types.xml:${xmlLine('<x>')}`);

    const containerKey = await hoverAt(['v = self.info["pos"]'], 0, keyCol('v = self.info["pos"]', 'pos'));
    expect(containerKey).toContain('**pos: POSITION**');

    const alias = await hoverAt(['data = self.pos', 'v = data["x"]'], 1, keyCol('v = data["x"]', 'x'));
    expect(alias).toContain('**x: float**');
  });

  it('键悬停诚实面:未知键/Any 字段不显示类型(能推才显)', async () => {
    const unknown = 'v = self.pos["nope"]';
    const unknownKey = (await hoverAt([unknown], 0, keyCol(unknown, 'nope'))) ?? '';
    expect(unknownKey).not.toContain('**nope:');

    // 字段在盘上但无 <Type> → 值注解 Any,标注不冒充实类型
    const anyField = 'v = self.skills["missing"]';
    const anyHover = (await hoverAt([anyField], 0, keyCol(anyField, 'missing'))) ?? '';
    expect(anyHover).not.toContain('**missing:');
  });
});
