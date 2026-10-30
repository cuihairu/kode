import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { PythonTypeInlayHintsProvider } from '../src/typeInlayHints';
import { EntityMappingManager } from '../src/entityMapping';
import {
  InlayHint,
  InlayHintKind,
  Position,
  Range,
  Uri,
  configurationOverrides,
  makeTextDocument,
  workspace
} from './helpers/vscodeStub';
import type { MinimalTextDocument } from './helpers/vscodeStub';

// types.xml 数据类型 inlay hints(批154 用户令 todo:7):python 侧
// self.<属性> 访问处原位渲染 def 声明的 <Type> 取值。解析走属性 F12 同一
// 索引(假例注入),开关 kbengine.inlayHints.typeData 现读,视图口外不出。

interface HintLike {
  position: { line: number; character: number };
  label: unknown;
  kind?: unknown;
}

const doc = (text: string, fileName = '/tmp/ws/scripts/base/Hero.py'): MinimalTextDocument =>
  makeTextDocument(text, { fileName, languageId: 'python' });

const lineRange = (startLine: number, endLine: number): Range =>
  new Range(new Position(startLine, 0), new Position(endLine, 0));

describe('PythonTypeInlayHintsProvider(批154)', () => {
  const calls: Array<{ file: string; fullPath: string; rootSymbol: string }> = [];

  const managerOf = (byPath: Record<string, { typeName?: string } | null>) =>
    ({
      resolvePropertyDefinitionInfo: (file: string, fullPath: string, rootSymbol: string) => {
        calls.push({ file, fullPath, rootSymbol });
        const location = byPath[fullPath];
        if (location === null || location === undefined) {
          return Promise.resolve(null);
        }
        return Promise.resolve({
          defFile: '/tmp/ws/scripts/entity_defs/Hero.def',
          line: 3,
          typeName: location.typeName,
          domains: ['base'],
          persistent: false,
          identity: { symbolName: rootSymbol }
        });
      }
    }) as unknown as EntityMappingManager;

  it('resolved access renders an inline type hint at the root symbol tail', async () => {
    calls.length = 0;
    const provider = new PythonTypeInlayHintsProvider(managerOf({ hp: { typeName: 'UINT32' } }));
    const hints = (await provider.provideInlayHints(
      doc('def tick(self):\n    self.hp = 1\n') as never,
      lineRange(0, 5)
    )) as unknown as HintLike[];

    expect(hints).toHaveLength(1);
    expect(hints[0].position).toEqual({ line: 1, character: 11 });
    // 2026-10-29 用户定口径:解析到底(与 RPC 实参 inlay 同链)——UINT32→int
    expect(hints[0].label).toBe(': int');
    expect(hints[0].kind).toBe(InlayHintKind.Type);
    expect(hints[0]).toBeInstanceOf(InlayHint);
    expect(calls).toEqual([
      { file: '/tmp/ws/scripts/base/Hero.py', fullPath: 'hp', rootSymbol: 'hp' }
    ]);
  });

  it('resolves once per distinct path and renders one hint per access site', async () => {
    calls.length = 0;
    const provider = new PythonTypeInlayHintsProvider(managerOf({ hp: { typeName: 'UINT32' } }));
    const hints = (await provider.provideInlayHints(
      doc('def a(self):\n    self.hp = 1\n\ndef b(self):\n    self.hp = 2\n') as never,
      lineRange(0, 5)
    )) as unknown as HintLike[];

    expect(hints.map(hint => hint.position.line)).toEqual([1, 4]);
    expect(calls).toHaveLength(1);
  });

  it('skips accesses outside the requested viewport range', async () => {
    calls.length = 0;
    const provider = new PythonTypeInlayHintsProvider(managerOf({ hp: { typeName: 'UINT32' } }));
    const hints = (await provider.provideInlayHints(
      doc('def a(self):\n    self.hp = 1\n\ndef b(self):\n    self.hp = 2\n') as never,
      lineRange(3, 5)
    )) as unknown as HintLike[];

    expect(hints.map(hint => hint.position.line)).toEqual([4]);
    expect(calls).toHaveLength(1);
  });

  it('解析到底口径:VECTOR3→定长 tuple;PYTHON/未知类型落 Any 按「能推才显」闸不出(2026-10-29)', async () => {
    calls.length = 0;
    const provider = new PythonTypeInlayHintsProvider(
      managerOf({
        direction: { typeName: 'VECTOR3' },
        payload: { typeName: 'PYTHON' },
        ghost: { typeName: 'NOT_A_TYPE' }
      })
    );
    const hints = (await provider.provideInlayHints(
      doc('def a(self):\n    self.direction = 1\n    self.payload = 2\n    self.ghost = 3\n') as never,
      lineRange(0, 5)
    )) as unknown as HintLike[];

    // PYTHON=任意可 pickle 对象(datatype.cpp PythonType),最终型 Any 无信息量;
    // 未知类型同落 Any——两者都不渲染(与 RPC 实参 inlay 的 Any 闸同口径)
    expect(hints.map(hint => hint.label)).toEqual([': Tuple[float, float, float]']);
  });

  it('renders nothing for unresolved accesses and for declarations without a Type', async () => {
    calls.length = 0;
    const provider = new PythonTypeInlayHintsProvider(
      managerOf({ bag: null, items: {}, plain: { typeName: undefined } })
    );
    const hints = (await provider.provideInlayHints(
      doc('def a(self):\n    self.bag.count = 1\n    self.items = 2\n    self.plain = 3\n') as never,
      lineRange(0, 5)
    )) as unknown as HintLike[];

    expect(hints).toEqual([]);
    // 三条访问都问过索引(bag/items/plain 各一,组件槽子键 bag.count 算一条)
    expect(calls.map(call => call.fullPath)).toEqual(['bag.count', 'items', 'plain']);
  });

  it('inlayHints.typeData off renders nothing (switch read per call)', async () => {
    const provider = new PythonTypeInlayHintsProvider(managerOf({ hp: { typeName: 'UINT32' } }));
    const document = doc('def tick(self):\n    self.hp = 1\n');

    // 正对照:默认开启时出 hint
    expect(await provider.provideInlayHints(document as never, lineRange(0, 5))).toHaveLength(1);

    configurationOverrides.set('kbengine', { 'inlayHints.typeData': false });
    try {
      expect(await provider.provideInlayHints(document as never, lineRange(0, 5))).toEqual([]);
    } finally {
      configurationOverrides.delete('kbengine');
    }
  });
});

// RPC 调用点形参 inlay(用户令 2026-10-21 第 3 问;2026-10-29 用户定形态
// 只显类型):self.base/cell/client.X(...) 每实参后插 `: <类型>`(不带
// argN——.def <Arg> 无形参名,合成名是噪音;名字留给签名帮助/存根面),
// 只做 def 已声明的(不做任何推导):解析走
// resolveMethodDefinition 第三参段闸(段不符/解析不出 → null,不给),类型走
// resolveEntityAnnotationType 同一解析链(内建 UINT8→int 等,与声明面
// formatDefMethodSignature 同源),形参名 argN 与存根生成器同口径。
// manager 用真实 EntityMappingManager + 临时目录真 .def(pythonReceiverSection
// 同款装配)。
describe('RPC 调用点形参 inlay(真实索引装配)', () => {
  const originalFolders = workspace.workspaceFolders;
  const originalFindFiles = workspace.findFiles;
  const managers: EntityMappingManager[] = [];
  const roots: string[] = [];

  // reborn 声明两个 <Arg>;purge 无 <Arg>;oops 的 <Arg> 类型不可解析;heal
  // 只在 BaseMethods 段
  const setupWorkspace = (): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-rpc-inlay-'));
    roots.push(root);
    const put = (relative: string, content: string): string => {
      const file = path.join(root, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, 'utf8');
      return file;
    };
    const defFile = put('scripts/entity_defs/Avatar.def', [
      '<root>',
      '  <Properties>',
      '    <serverID><Type>SERVER_ID</Type></serverID>',
      '    <direction><Type>VECTOR3</Type></direction>',
      '    <payload><Type>PYTHON</Type></payload>',
      // FIXED_DICT 子成员面(2026-10-30 用户令):.def 只声明属性引用,
      // 字段在 types.xml 类型条目下;bonus 带 values 字段测「字段名优先」
      '    <reward><Type>REWARD_DICT</Type></reward>',
      '    <bonus><Type>BONUS_DICT</Type></bonus>',
      '  </Properties>',
      '  <CellMethods>',
      '    <reborn>',
      '      <Arg>UINT8</Arg>',
      '      <Arg>UINT16</Arg>',
      '    </reborn>',
      '    <purge/>',
      '    <oops>',
      '      <Arg>NOT_A_REAL_TYPE</Arg>',
      '    </oops>',
      '  </CellMethods>',
      '  <BaseMethods>',
      '    <heal>',
      '      <Arg>INT32</Arg>',
      '    </heal>',
      '  </BaseMethods>',
      '</root>'
    ].join('\n'));
    const basePy = put('scripts/base/Avatar.py', 'class Avatar(kbe.KBEntity):\n    pass\n');
    put('scripts/cell/Avatar.py', 'class Avatar(kbe.KBEntity):\n    pass\n');
    // SERVER_ID:types.xml 别名 → UINT16(2026-10-29 用户口径:属性 inlay 解析到底);
    // REWARD_DICT/BONUS_DICT:FIXED_DICT 结构条目(引擎形态「条目名 FIXED_DICT
    // + <Properties> 子键」,def-pyi-stubs.md §1.4 同构)
    put('scripts/entity_defs/types.xml', [
      '<root>',
      '  <SERVER_ID> UINT16 </SERVER_ID>',
      '  <REWARD_DICT> FIXED_DICT',
      '    <Properties>',
      '      <gold><Type>UINT32</Type></gold>',
      '      <name><Type>STRING</Type></name>',
      '    </Properties>',
      '  </REWARD_DICT>',
      '  <BONUS_DICT> FIXED_DICT',
      '    <Properties>',
      '      <values><Type>UINT16</Type></values>',
      '    </Properties>',
      '  </BONUS_DICT>',
      '</root>'
    ].join('\n'));
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'rpc-inlay', index: 0 }];
    workspace.findFiles = async (glob?: string) => (glob === '**/*.def' || glob === `**/${path.basename(defFile)}` ? [Uri.file(defFile)] : []);
    return basePy;
  };

  const makeManager = (): EntityMappingManager => {
    const manager = new EntityMappingManager({ subscriptions: [] });
    managers.push(manager);
    return manager;
  };

  afterEach(() => {
    managers.splice(0).forEach(manager => manager.dispose());
    roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }));
    workspace.workspaceFolders = originalFolders;
    workspace.findFiles = originalFindFiles;
  });

  const rpcHintsOf = async (
    provider: PythonTypeInlayHintsProvider,
    text: string,
    fileName: string,
    range = lineRange(0, 99)
  ): Promise<HintLike[]> =>
    (await provider.provideInlayHints(
      makeTextDocument(text, { fileName, languageId: 'python' }) as never,
      range
    )) as unknown as HintLike[];

  it('正例:self.cell.reborn(37) → 实参后 `: int`(kind=Parameter,不带 argN)', async () => {
    const basePy = setupWorkspace();
    const provider = new PythonTypeInlayHintsProvider(makeManager());
    const line = '        self.cell.reborn(37)';
    const text = `class Avatar(kbe.KBEntity):\n    def tick(self):\n${line}\n`;
    const hints = await rpcHintsOf(provider, text, basePy);
    expect(hints).toHaveLength(1);
    expect(hints[0].position).toEqual({ line: 2, character: line.indexOf('37') + 2 });
    // 类型与声明面签名 formatter 同源:UINT8 内建直查 → int(不显原词)
    expect(hints[0].label).toBe(': int');
    expect(hints[0].kind).toBe(InlayHintKind.Parameter);
    // 真身断言经 makeTextDocument 文档走 stub 类
    const raw = await provider.provideInlayHints(
      makeTextDocument(text, { fileName: basePy, languageId: 'python' }) as never,
      lineRange(0, 99)
    );
    expect(raw?.[0]).toBeInstanceOf(InlayHint);
  });

  it('正例:self.cell.reborn(1, 2) 双实参逐位出 `: int`', async () => {
    const basePy = setupWorkspace();
    const provider = new PythonTypeInlayHintsProvider(makeManager());
    const line = '        self.cell.reborn(1, 2)';
    const text = `class Avatar(kbe.KBEntity):\n    def tick(self):\n${line}\n`;
    const hints = await rpcHintsOf(provider, text, basePy);
    expect(hints.map(hint => hint.label)).toEqual([': int', ': int']);
    expect(hints[0].position).toEqual({ line: 2, character: line.indexOf('1') + 1 });
    expect(hints[1].position).toEqual({ line: 2, character: line.indexOf('2') + 1 });
  });

  it('数量错位按位置对齐:声明两参实参一个 → 只出首参类型', async () => {
    const basePy = setupWorkspace();
    const provider = new PythonTypeInlayHintsProvider(makeManager());
    const line = '        self.cell.reborn(7)';
    const text = `class Avatar(kbe.KBEntity):\n    def tick(self):\n${line}\n`;
    const hints = await rpcHintsOf(provider, text, basePy);
    expect(hints).toHaveLength(1);
    expect(hints[0].label).toBe(': int');
    expect(hints[0].position).toEqual({ line: 2, character: line.indexOf('7') + 1 });
  });

  it('属性面解析到底:SERVER_ID(types.xml 别名)→int,PYTHON→Any 不出(2026-10-29 用户定口径)', async () => {
    const basePy = setupWorkspace();
    const provider = new PythonTypeInlayHintsProvider(makeManager());
    const text = [
      'class Avatar(kbe.KBEntity):',
      '    def tick(self):',
      '        self.serverID = 1',
      '        self.payload = 2',
      ''
    ].join('\n');
    const hints = await rpcHintsOf(provider, text, basePy);
    // 别名经注册表解析到底层内建 UINT16→int(与 RPC 实参 inlay 同一链);
    // PYTHON 最终型 Any(任意可 pickle 对象)按「能推才显」闸不出
    expect(hints.map(hint => hint.label)).toEqual([': int']);
  });

  it('段不符/def 未声明/类型解析不出 → 一律不给提示', async () => {
    const basePy = setupWorkspace();
    const provider = new PythonTypeInlayHintsProvider(makeManager());
    const text = [
      'class Avatar(kbe.KBEntity):',
      '    def tick(self):',
      '        self.base.reborn(1)', // 段不符:reborn 只在 CellMethods
      '        self.cell.purge()', // def 无 <Arg> 声明 → 不硬造
      "        self.cell.oops('x')", // <Arg> 类型解析落 Any → 该位不出
      ''
    ].join('\n');
    expect(await rpcHintsOf(provider, text, basePy)).toEqual([]);
  });

  it('跨行调用(同行括号不闭合)→ 不给提示', async () => {
    const basePy = setupWorkspace();
    const provider = new PythonTypeInlayHintsProvider(makeManager());
    const text = [
      'class Avatar(kbe.KBEntity):',
      '    def tick(self):',
      '        self.cell.reborn(',
      '            1, 2)',
      ''
    ].join('\n');
    expect(await rpcHintsOf(provider, text, basePy)).toEqual([]);
  });

  it('开关:inlayHints.typeData=false → 不给(默认开正对照)', async () => {
    const basePy = setupWorkspace();
    const provider = new PythonTypeInlayHintsProvider(makeManager());
    const text = 'class Avatar(kbe.KBEntity):\n    def tick(self):\n        self.cell.reborn(1)\n';

    // 正对照:默认开启出提示
    expect(await rpcHintsOf(provider, text, basePy)).toHaveLength(1);

    configurationOverrides.set('kbengine', { 'inlayHints.typeData': false });
    try {
      expect(await rpcHintsOf(provider, text, basePy)).toEqual([]);
    } finally {
      configurationOverrides.delete('kbengine');
    }
  });

  // FIXED_DICT 子成员面(2026-10-30 用户令):属性类型是 FIXED_DICT 时,
  // self.<属性>.<字段> 读字段注解,self.<属性>.items()/keys()/values()/get()
  // 出字典视图方法注解,位置贴完整路径后;字段名优先于字典方法。
  it('FIXED_DICT 子成员:字段读 → 字段注解,位置贴完整路径后', async () => {
    const basePy = setupWorkspace();
    const provider = new PythonTypeInlayHintsProvider(makeManager());
    const line = '        self.reward.gold = 1';
    const text = `class Avatar(kbe.KBEntity):\n    def tick(self):\n${line}\n`;
    const hints = await rpcHintsOf(provider, text, basePy);
    expect(hints).toHaveLength(1);
    // 根段命中标在根段后(旧口径)会错位到 reward 后;子成员必须标 gold 后
    expect(hints[0].position).toEqual({
      line: 2,
      character: line.indexOf('reward') + 'reward.gold'.length
    });
    expect(hints[0].label).toBe(': int');
  });

  it('FIXED_DICT 子成员:items() → ItemsView[str, int | str](值并集)', async () => {
    const basePy = setupWorkspace();
    const provider = new PythonTypeInlayHintsProvider(makeManager());
    const line = '        self.reward.items()';
    const text = `class Avatar(kbe.KBEntity):\n    def tick(self):\n${line}\n`;
    const hints = await rpcHintsOf(provider, text, basePy);
    expect(hints).toHaveLength(1);
    // 位置贴 items 后(方法名后,不占括号位)
    expect(hints[0].position).toEqual({
      line: 2,
      character: line.indexOf('reward') + 'reward.items'.length
    });
    expect(hints[0].label).toBe(': ItemsView[str, int | str]');
  });

  it('FIXED_DICT 子成员:keys() → KeysView[str],values() → ValuesView[int | str]', async () => {
    const basePy = setupWorkspace();
    const provider = new PythonTypeInlayHintsProvider(makeManager());
    const text = [
      'class Avatar(kbe.KBEntity):',
      '    def tick(self):',
      '        self.reward.keys()',
      '        self.reward.values()',
      ''
    ].join('\n');
    const hints = await rpcHintsOf(provider, text, basePy);
    expect(hints.map(hint => hint.label)).toEqual([
      ': KeysView[str]',
      ': ValuesView[int | str]'
    ]);
    expect(hints.map(hint => hint.position.line)).toEqual([2, 3]);
  });

  it('FIXED_DICT 子成员:get() → 值并集 | None', async () => {
    const basePy = setupWorkspace();
    const provider = new PythonTypeInlayHintsProvider(makeManager());
    const line = '        self.reward.get(1)';
    const text = `class Avatar(kbe.KBEntity):\n    def tick(self):\n${line}\n`;
    const hints = await rpcHintsOf(provider, text, basePy);
    expect(hints[0].label).toBe(': int | str | None');
  });

  it('FIXED_DICT 子成员:字段名优先(无括号 values 字段读,不出 ValuesView)', async () => {
    const basePy = setupWorkspace();
    const provider = new PythonTypeInlayHintsProvider(makeManager());
    const line = '        self.bonus.values = 1';
    const text = `class Avatar(kbe.KBEntity):\n    def tick(self):\n${line}\n`;
    const hints = await rpcHintsOf(provider, text, basePy);
    // bonus 是 BONUS_DICT(字段 values:UINT16):values 字段读 → int,不是
    // 字典方法 ValuesView[..](TypedDict 运行时字段遮蔽 dict 方法同口径)
    expect(hints).toHaveLength(1);
    expect(hints[0].position).toEqual({
      line: 2,
      character: line.indexOf('bonus') + 'bonus.values'.length
    });
    expect(hints[0].label).toBe(': int');
  });

  it('FIXED_DICT 子成员:未知成员(非字段/非方法)落回根注解', async () => {
    const basePy = setupWorkspace();
    const provider = new PythonTypeInlayHintsProvider(makeManager());
    const line = '        self.reward.unknown = 1';
    const text = `class Avatar(kbe.KBEntity):\n    def tick(self):\n${line}\n`;
    const hints = await rpcHintsOf(provider, text, basePy);
    // 未命中子成员不硬造:落回根段注解(REWARD_DICT → 存根类名),位置回根段后
    expect(hints).toHaveLength(1);
    expect(hints[0].label).toBe(': REWARD_DICT');
    expect(hints[0].position).toEqual({
      line: 2,
      character: line.indexOf('reward') + 'reward'.length
    });
  });
});
