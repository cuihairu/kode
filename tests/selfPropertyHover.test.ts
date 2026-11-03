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
  '        print(first)'
].join('\n');

// `        for item in self.equip_track_list:` — equip_track_list 区间 [25,41]
const PROPERTY_POSITION = new Position(5, 30);
// `        for item in self.equip_track_list:` — item 区间 [12,16]
const FOR_TARGET_POSITION = new Position(5, 14);
// `        first = self.equip_track_list[0]` — first 区间 [8,13]
const SUBSCRIPT_VAR_POSITION = new Position(7, 10);

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
