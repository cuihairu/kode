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
    expect(hints[0].label).toBe(': UINT32');
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
});
