import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KBEngineHoverProvider, KBEngineReferencesProvider } from '../src/languageProviders';
import { EntityMappingManager } from '../src/entityMapping';
import { resetScanRootCache } from '../src/scanRoots';
import {
  configurationOverrides,
  makeTextDocument,
  Position,
  Uri,
  workspace as stubWorkspace
} from './helpers/vscodeStub';

// IFACE-MERGE:<Interfaces> 成员并入宿主实体面验收(①-③)。
// 宿主 Hero.def 经 <Interfaces><interface>IEquip</interface> 引用接口,
// 接口 IEquip.def 声明 equip_track_list(类型 EQUIP_TRACK_LIST);
// Hero.py 以 self.equip_track_list 使用(继承面)。验收:①宿主实体属性索引
// 并入接口成员(补全出、def 定位到 IEquip.def);②补全/hover/F12/Shift+F12/
// 引用计数对接口成员与本体成员行为一致;③TYP-ARRAY 类型推导对接口属性
// 同源生效(容器注解+元素型)。prove-red=接口属性补全/引用用例红。

let root = '';
let heroPyPath = '';
let heroDefPath = '';
let ifaceDefPath = '';

const HERO_DEF = [
  '<root>',
  '  <Interfaces>',
  '    <interface>IEquip</interface>',
  '  </Interfaces>',
  '</root>'
].join('\n');

// 接口 def 声明属性+方法(无 <Properties> 的宿主 def 经接口获得成员)
const IFACE_DEF = [
  '<root>',
  '  <Properties>',
  '    <equip_track_list>',
  '      <Type>EQUIP_TRACK_LIST</Type>',
  '      <Flags>CELL_PUBLIC</Flags>',
  '    </equip_track_list>',
  '  </Properties>',
  '  <BaseMethods>',
  '    <add_equip>',
  '      <Arg>INT32</Arg>',
  '    </add_equip>',
  '  </BaseMethods>',
  '</root>'
].join('\n');

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
  '    def add_equip(self, n):',
  '        print(n)',
  '',
  '    def use(self):',
  '        for item in self.equip_track_list:',
  '            print(item)',
  '        first = self.equip_track_list[0]',
  '        print(first)',
  '        self.add_equip(1)',
  '        self.base.add_equip(2)'
].join('\n');

// `        for item in self.equip_track_list:` — equip_track_list 区间 [25,41]
const PROPERTY_POSITION = new Position(8, 30);

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
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-ifacemerge-'));
  const ifaceDir = path.join(root, 'scripts', 'entity_defs', 'interfaces');
  fs.mkdirSync(ifaceDir, { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts', 'base'), { recursive: true });
  heroDefPath = path.join(root, 'scripts', 'entity_defs', 'Hero.def');
  ifaceDefPath = path.join(ifaceDir, 'IEquip.def');
  fs.writeFileSync(heroDefPath, HERO_DEF);
  fs.writeFileSync(ifaceDefPath, IFACE_DEF);
  fs.writeFileSync(path.join(root, 'scripts', 'entity_defs', 'types.xml'), TYPES_XML);
  heroPyPath = path.join(root, 'scripts', 'base', 'Hero.py');
  fs.writeFileSync(heroPyPath, HERO_PY);
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

const makeManager = (): EntityMappingManager => {
  manager = new EntityMappingManager({ subscriptions: [] } as never);
  return manager;
};

describe('IFACE-MERGE: 接口属性并入宿主实体索引(①)', () => {
  it('宿主补全面出接口属性,def 定位到接口 def', async () => {
    setupWorkspace();
    const m = makeManager();
    await (m as unknown as { waitForInitialScan(): Promise<void> }).waitForInitialScan();
    const mapping = m.getMappingForPythonFile(heroPyPath)!;
    expect(mapping).toBeDefined();
    const prop = mapping.properties['equip_track_list'];
    expect(prop, '宿主补全面(properties)含接口属性').toBeDefined();
    expect(prop!.defFile).toBe(ifaceDefPath);
  });

  it('宿主 F12 面:resolvePropertyDefinitionInfo 定位到接口 def 声明', async () => {
    setupWorkspace();
    const m = makeManager();
    await (m as unknown as { waitForInitialScan(): Promise<void> }).waitForInitialScan();
    const located = await m.resolvePropertyDefinitionInfo(heroPyPath, 'equip_track_list');
    expect(located).not.toBeNull();
    expect(located!.defFile).toBe(ifaceDefPath);
    expect(located!.line).toBeGreaterThan(0);
  });
});

describe('IFACE-MERGE: 接口属性补全(prove-red 面)', () => {
  it('self.equi 前缀补全出 equip_track_list', async () => {
    setupWorkspace();
    const m = makeManager();
    await (m as unknown as { waitForInitialScan(): Promise<void> }).waitForInitialScan();
    const mapping = m.getMappingForPythonFile(heroPyPath)!;
    // 补全面来源=properties 键;同前缀过滤后仍见接口属性
    const names = Object.keys(mapping.properties).filter(name => name.startsWith('equi'));
    expect(names).toContain('equip_track_list');
  });
});

describe('IFACE-MERGE: 接口属性 TYP-ARRAY 同源推导(③)', () => {
  it('self.<接口属性> hover → 容器注解(别名断内建)', async () => {
    setupWorkspace();
    const m = makeManager();
    await (m as unknown as { waitForInitialScan(): Promise<void> }).waitForInitialScan();
    const provider = new KBEngineHoverProvider(m);
    const result = await provider.provideHover(
      makeTextDocument(HERO_PY, { fileName: heroPyPath, languageId: 'python' }),
      PROPERTY_POSITION
    );
    expect(result).not.toBeNull();
    const text = JSON.stringify(result);
    expect(text).toContain('self.equip_track_list: FixedArray[EQUIP_INFO]');
    expect(text).toContain('IEquip.def');
  });
});

describe('IFACE-MERGE: 接口属性 Shift+F12 引用(②)', () => {
  it('接口 def 属性位 Shift+F12 → 宿主 py self 使用处', async () => {
    setupWorkspace();
    const m = makeManager();
    await (m as unknown as { waitForInitialScan(): Promise<void> }).waitForInitialScan();
    const provider = new KBEngineReferencesProvider(m);
    const ifaceDoc = makeTextDocument(IFACE_DEF, { fileName: ifaceDefPath }) as never;
    const result = await provider.provideReferences(
      ifaceDoc,
      new Position(2, 6),
      { includeDeclaration: false },
      undefined
    );
    expect(result).not.toBeNull();
    expect(result!.length).toBeGreaterThanOrEqual(1);
    for (const location of result!) {
      expect(location.uri.fsPath).toBe(heroPyPath);
    }
  });
});

describe('IFACE-MERGE: 接口方法面一致性(②)', () => {
  it('宿主补全面出接口方法,F12 定位到接口 def', async () => {
    setupWorkspace();
    const m = makeManager();
    await (m as unknown as { waitForInitialScan(): Promise<void> }).waitForInitialScan();
    const mapping = m.getMappingForPythonFile(heroPyPath)!;
    expect(mapping.methods['add_equip'], '宿主补全面(methods)含接口方法').toBeDefined();
    const located = await m.resolveMethodDefinitionForClass('Hero', 'add_equip', undefined, heroPyPath);
    expect(located).not.toBeNull();
    expect(located!.defFile).toBe(ifaceDefPath);
  });

  it('getIncomingPythonReceiverCalls 自接口 def 命中宿主 self.base 调用', async () => {
    setupWorkspace();
    const m = makeManager();
    await (m as unknown as { waitForInitialScan(): Promise<void> }).waitForInitialScan();
    const calls = await m.getIncomingPythonReceiverCalls(ifaceDefPath, 'add_equip', 'base');
    expect(calls.length).toBeGreaterThanOrEqual(1);
    // `        self.base.add_equip(2)` — 0 基行 13 → 1 基行 14
    expect(calls.some(call => call.filePath === heroPyPath && call.line === 14)).toBe(true);
  });

  it('接口 def 方法位 Shift+F12 → 宿主 py self 调用处', async () => {
    setupWorkspace();
    const m = makeManager();
    await (m as unknown as { waitForInitialScan(): Promise<void> }).waitForInitialScan();
    const provider = new KBEngineReferencesProvider(m);
    const ifaceDoc = makeTextDocument(IFACE_DEF, { fileName: ifaceDefPath }) as never;
    // `<add_equip>` 在行 8(0 基),名区间 [4,13]
    const result = await provider.provideReferences(
      ifaceDoc,
      new Position(8, 6),
      { includeDeclaration: false },
      undefined
    );
    expect(result).not.toBeNull();
    expect(result!.length).toBeGreaterThanOrEqual(1);
    for (const location of result!) {
      expect(location.uri.fsPath).toBe(heroPyPath);
    }
  });
});
