import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KBEngineHoverProvider } from '../src/languageProviders';
import { PythonTypeInlayHintsProvider } from '../src/typeInlayHints';
import { EntityMappingManager } from '../src/entityMapping';
import { resetScanRootCache } from '../src/scanRoots';
import {
  configurationOverrides,
  makeTextDocument,
  Position,
  Range,
  Uri,
  workspace as stubWorkspace
} from './helpers/vscodeStub';

// TYP-ARRAY:hover 面 def 属性/数组元素类型(验收 ①-②)。真实 workspace +
// 真实 EntityMappingManager + 真实 types.xml 注册表,驱动 KBEngineHoverProvider
// 端到端:① self.<def 属性> hover 出容器注解(别名断到内建);② for-target /
// 下标赋值局部变量 hover 出 <of> 元素类型。prove-red:修复前元素类型推导无此
// 面(旧 hover 只走内建属性面,for/下标取不出元素型,回普通链无类型显示)。

let root = '';
let pyPath = '';

const HERO_DEF = [
  '<root>',
  '  <Properties>',
  '    <equip_track_list>',
  '      <Type>EQUIP_TRACK_LIST</Type>',
  '      <Flags>CELL_PUBLIC</Flags>',
  '    </equip_track_list>',
  '    <funnel_list>',
  '      <Type>FUNNEL_LIST</Type>',
  '      <Flags>CELL_PUBLIC</Flags>',
  '    </funnel_list>',
  '  </Properties>',
  '</root>'
].join('\n');

// types.xml 别名是直文形态(ARRAY 为裸文本 + <of> 子节点;alias.xml 才有
// <Type> 包裹形态)——getTypesXmlCustomTypeInfos 的 aliasType 取裸前缀
const TYPES_XML = [
  '<root>',
  '  <EQUIP_TRACK_LIST>',
  '    ARRAY',
  '    <of>EQUIP_INFO</of>',
  '  </EQUIP_TRACK_LIST>',
  '  <EQUIP_INFO>',
  '    FIXED_DICT',
  '    <Properties>',
  '      <name><Type>STRING</Type></name>',
  '    </Properties>',
  '  </EQUIP_INFO>',
  // TYP-DICTGET:FIXED_DICT 全字段 FUNNEL → get 值并去重单型 FUNNEL
  '  <FUNNEL_LIST>',
  '    FIXED_DICT',
  '    <Properties>',
  '      <fontain><Type>FUNNEL</Type></fontain>',
  '      <overflow><Type>FUNNEL</Type></overflow>',
  '    </Properties>',
  '  </FUNNEL_LIST>',
  '  <FUNNEL>',
  '    FIXED_DICT',
  '    <Properties>',
  '      <capacity><Type>UINT32</Type></capacity>',
  '    </Properties>',
  '  </FUNNEL>',
  '</root>'
].join('\n');

const HERO_PY = [
  'class Hero:',
  '    def __init__(self):',
  '        self.equip_track_list = []',
  '',
  '    def use(self):',
  '        for item in self.equip_track_list:',
  '            print(item)',
  '        first = self.equip_track_list[0]',
  '        print(first)',
  '',
  '    def funnel(self, ident):',
  '        funnel = self.funnel_list.get(ident)',
  '        print(funnel)'
].join('\n');

// `        for item in self.equip_track_list:` — equip_track_list 区间 [25,41]
const PROPERTY_POSITION = new Position(5, 30);
// `        for item in self.equip_track_list:` — item 区间 [12,16]
const FOR_TARGET_POSITION = new Position(5, 14);
// `        first = self.equip_track_list[0]` — first 区间 [8,13]
const SUBSCRIPT_VAR_POSITION = new Position(7, 10);
// `        funnel = self.funnel_list.get(ident)` — funnel 区间 [8,14]
const DICTGET_VAR_POSITION = new Position(11, 10);

const ORIGINAL_FOLDERS = stubWorkspace.workspaceFolders;
const ORIGINAL_FIND_FILES = stubWorkspace.findFiles;

let manager: EntityMappingManager | null = null;

const walkDefs = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkDefs(full));
    } else if (entry.isFile() && entry.name.endsWith('.def')) {
      out.push(full);
    }
  }
  return out;
};

const setupWorkspace = (): void => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-selfprop-'));
  fs.mkdirSync(path.join(root, 'scripts', 'entity_defs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts', 'base'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'entity_defs', 'Hero.def'), HERO_DEF);
  fs.writeFileSync(path.join(root, 'scripts', 'entity_defs', 'types.xml'), TYPES_XML);
  pyPath = path.join(root, 'scripts', 'base', 'Hero.py');
  fs.writeFileSync(pyPath, HERO_PY);
  stubWorkspace.workspaceFolders = [
    { uri: Uri.file(root), name: 'ws', index: 0 }
  ];
  stubWorkspace.findFiles = (async () =>
    walkDefs(root).map(file => Uri.file(file))) as typeof stubWorkspace.findFiles;
  resetScanRootCache();
};

beforeEach(() => {
  configurationOverrides.delete('kbengine');
});

afterEach(() => {
  manager?.dispose();
  manager = null;
  if (root) {
    fs.rmSync(root, { recursive: true, force: true });
    root = '';
  }
  stubWorkspace.workspaceFolders = ORIGINAL_FOLDERS;
  stubWorkspace.findFiles = ORIGINAL_FIND_FILES;
  resetScanRootCache();
});

const makeProvider = (): { provider: KBEngineHoverProvider; manager: EntityMappingManager } => {
  manager = new EntityMappingManager({ subscriptions: [] } as never);
  return { provider: new KBEngineHoverProvider(manager), manager };
};

describe('TYP-ARRAY hover: def 属性容器注解(①)', () => {
  it('self.<def 属性> hover → 声明类型别名断到内建(容器注解)', async () => {
    setupWorkspace();
    const { provider } = makeProvider();
    const result = await provider.provideHover(
      makeTextDocument(HERO_PY, { fileName: pyPath, languageId: 'python' }),
      PROPERTY_POSITION
    );
    expect(result).not.toBeNull();
    const text = JSON.stringify(result);
    expect(text).toContain('self.equip_track_list: FixedArray[EQUIP_INFO]');
    expect(text).toContain('def 属性声明');
  });
});

describe('TYP-ARRAY hover: 元素类型推导(②,prove-red 面)', () => {
  it('for-target hover → <of> 元素类型', async () => {
    setupWorkspace();
    const { provider } = makeProvider();
    const result = await provider.provideHover(
      makeTextDocument(HERO_PY, { fileName: pyPath, languageId: 'python' }),
      FOR_TARGET_POSITION
    );
    expect(result).not.toBeNull();
    const text = JSON.stringify(result);
    expect(text).toContain('item: EQUIP_INFO');
    expect(text).toContain('元素类型推导自');
    expect(text).toContain('Hero.def');
  });

  it('下标赋值局部变量 hover → <of> 元素类型', async () => {
    setupWorkspace();
    const { provider } = makeProvider();
    const result = await provider.provideHover(
      makeTextDocument(HERO_PY, { fileName: pyPath, languageId: 'python' }),
      SUBSCRIPT_VAR_POSITION
    );
    expect(result).not.toBeNull();
    const text = JSON.stringify(result);
    expect(text).toContain('first: EQUIP_INFO');
    expect(text).toContain('元素类型推导自');
  });
});

describe('TYP-ARRAY inlay: 数组元素类型行内提示(② 视觉面)', () => {
  const inlayProvider = (): PythonTypeInlayHintsProvider => {
    manager = new EntityMappingManager({ subscriptions: [] } as never);
    return new PythonTypeInlayHintsProvider(manager);
  };

  it('for-target 与下标赋值局部变量 → 元素型 inlay', async () => {
    setupWorkspace();
    const provider = inlayProvider();
    const hints = await provider.provideInlayHints(
      makeTextDocument(HERO_PY, { fileName: pyPath, languageId: 'python' }),
      new Range(new Position(0, 0), new Position(8, 200))
    );
    const elementHints = hints.filter(h => h.label === ': EQUIP_INFO');
    // 元素型两枚:for-target item(行 5,列 16)与下标赋值 first(行 7,列 13)
    expect(elementHints.length).toBe(2);
    const positions = elementHints.map(h => `${h.position.line}:${h.position.character}`).sort();
    expect(positions).toEqual(['5:16', '7:13']);
    // 容器面仍在(自属性 inlay 与元素面共存,不互斥)
    const containerHints = hints.filter(h => h.label === ': FixedArray[EQUIP_INFO]');
    expect(containerHints.length).toBeGreaterThanOrEqual(1);
  });
});

describe('TYP-DICTGET hover: dict.get() 赋值类型推导(2026-11-24 用户令)', () => {
  it('funnel = self.funnel_list.get(ident) 悬停 funnel → FUNNEL 注解 + def 来源', async () => {
    setupWorkspace();
    const { provider } = makeProvider();
    const result = await provider.provideHover(
      makeTextDocument(HERO_PY, { fileName: pyPath, languageId: 'python' }),
      DICTGET_VAR_POSITION
    );
    expect(result).not.toBeNull();
    const text = JSON.stringify(result);
    expect(text).toContain('funnel: FUNNEL');
    expect(text).toContain('元素类型推导自');
    expect(text).toContain('Hero.def');
    // 诚实面:get 键可能不存在,值可能 None(非 Any 注记,不带「类型未解析」尾)
    expect(text).toContain('None');
    expect(text).not.toContain('类型未解析');
  });

  it('PY_DICT 属性 .get 赋值 → 无注解(不猜,落回普通链)', async () => {
    setupWorkspace();
    fs.mkdirSync(path.join(root, 'scripts', 'entity_defs'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'scripts', 'entity_defs', 'Hero.def'),
      HERO_DEF.replace('FUNNEL_LIST</Type>', 'PY_DICT</Type>').replace('<funnel_list>', '<py_map>').replace('</funnel_list>', '</py_map>')
    );
    const py = HERO_PY.replace('self.funnel_list.get(ident)', 'self.py_map.get(ident)');
    fs.writeFileSync(pyPath, py);
    const { provider } = makeProvider();
    const result = await provider.provideHover(
      makeTextDocument(py, { fileName: pyPath, languageId: 'python' }),
      DICTGET_VAR_POSITION
    );
    // 内建 dict 无键值声明 → 诚实不推;普通链也无 def 属性容器注解(dict 非
    // TypedDict 名,正常落回空 hover 或普通面,绝无 `py_map 值` 形态注解)
    if (result !== null) {
      const text = JSON.stringify(result);
      expect(text).not.toContain('元素类型推导自');
    }
  });
});

describe('HOOK-TIMING-001:def 属性 hover 注入时序注', () => {
  it('self.<def 属性> hover 带 .def 注入时机与 cellData 路由语义', async () => {
    setupWorkspace();
    const { provider } = makeProvider();
    const result = await provider.provideHover(
      makeTextDocument(HERO_PY, { fileName: pyPath, languageId: 'python' }),
      PROPERTY_POSITION
    );
    expect(result).not.toBeNull();
    const text = JSON.stringify(result);
    // 注入时序注:时机锚 + cellData 路由 + 语料出处。
    expect(text).toContain('注入时序');
    expect(text).toContain('`.def` 注入');
    expect(text).toContain('cellData');
    expect(text).toContain('api-baseapp.md');
  });
});
