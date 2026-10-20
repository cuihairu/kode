import { describe, expect, it } from 'vitest';
import { PythonTypeInlayHintsProvider } from '../src/typeInlayHints';
import { EntityMappingManager } from '../src/entityMapping';
import {
  InlayHint,
  InlayHintKind,
  Position,
  Range,
  configurationOverrides,
  makeTextDocument
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
