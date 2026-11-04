import { describe, expect, it } from 'vitest';
import { classifyDefChange, defChangeVerdictDetail } from '../src/hotReloadDefStructure';

// IDE-HOT-005 将结构性 def 变更标记需重启:影响序列化(Properties 的
// Type/Flags/增删)或 RPC 参数(三方法段方法的增删/Arg 类型签名)的变
// 化=结构性,标需重启、不作为普通 Python reload 自动发送;注释/空白/
// 重排/描述文本/默认值变化=非结构性;任一侧解析不了=保守按结构性处理
// (证明不了无结构变化就不自动发)。

const BASE = [
  '<root>',
  '  <Properties>',
  '    <hp>',
  '      <Type> UINT32 </Type>',
  '      <Flags> CELL_PUBLIC </Flags>',
  '      <Default> 100 </Default>',
  '    </hp>',
  '    <level>',
  '      <Type> UINT16 </Type>',
  '    </level>',
  '  </Properties>',
  '  <CellMethods>',
  '    <reqMove>',
  '      <Arg>',
  '        <Type> VECTOR3 </Type>',
  '      </Arg>',
  '    </reqMove>',
  '  </CellMethods>',
  '  <BaseMethods>',
  '    <login />',
  '  </BaseMethods>',
  '</root>'
].join('\n');

const withBase = (overrides: { properties?: string; methods?: string }): string => [
  '<root>',
  '  <Properties>',
  overrides.properties ??
    '    <hp><Type> UINT32 </Type><Flags> CELL_PUBLIC </Flags><Default> 100 </Default></hp>\n    <level><Type> UINT16 </Type></level>',
  '  </Properties>',
  '  <CellMethods>',
  overrides.methods ?? '    <reqMove><Arg><Type> VECTOR3 </Type></Arg></reqMove>',
  '  </CellMethods>',
  '  <BaseMethods>',
  '    <login />',
  '  </BaseMethods>',
  '</root>'
].join('\n');

describe('classifyDefChange(结构指纹:序列化面+RPC 面)', () => {
  it('属性 Type 变化 → 结构性(序列化面)', () => {
    const after = withBase({ properties: '    <hp><Type> UINT64 </Type><Flags> CELL_PUBLIC </Flags><Default> 100 </Default></hp>' +
      '    <level><Type> UINT16 </Type></level>' });
    const verdict = classifyDefChange(BASE, after);
    expect(verdict.structural).toBe(true);
    expect(verdict.restartRequired).toBe(true);
    expect(verdict.reasons.join('\n')).toContain('hp');
  });

  it('属性 Flags 变化 → 结构性', () => {
    const after = withBase({ properties: '    <hp><Type> UINT32 </Type><Flags> BASE_PUBLIC </Flags><Default> 100 </Default></hp>' +
      '    <level><Type> UINT16 </Type></level>' });
    expect(classifyDefChange(BASE, after).structural).toBe(true);
  });

  it('属性增/删 → 结构性', () => {
    const added = withBase({ properties: '    <hp><Type> UINT32 </Type><Flags> CELL_PUBLIC </Flags></hp>\n    <mp><Type> UINT8 </Type></mp>' +
      '    <level><Type> UINT16 </Type></level>' });
    expect(classifyDefChange(BASE, added).structural).toBe(true);
    const removed = withBase({ properties: '    <hp><Type> UINT32 </Type><Flags> CELL_PUBLIC </Flags></hp>' });
    expect(classifyDefChange(BASE, removed).structural).toBe(true);
  });

  it('方法增/删与 Arg 类型/数量变化 → 结构性(RPC 面)', () => {
    const methodChanged = withBase({ methods: '    <reqMove><Arg><Type> UNICODE </Type></Arg></reqMove>' });
    expect(classifyDefChange(BASE, methodChanged).structural).toBe(true);
    const argCountChanged = withBase({ methods: '    <reqMove><Arg><Type> VECTOR3 </Type></Arg><Arg><Type> UINT32 </Type></Arg></reqMove>' });
    expect(classifyDefChange(BASE, argCountChanged).structural).toBe(true);
    const methodRemoved = withBase({ methods: '' });
    expect(classifyDefChange(BASE, methodRemoved).structural).toBe(true);
  });

  it('注释/空白/属性顺序重排/描述文本/默认值变化 → 非结构性', () => {
    const cosmetic = [
      '<root>',
      '  <!-- 只是注释 -->',
      '  <Properties>',
      '    <level>',
      '      <Type> UINT16 </Type>',
      '    </level>',
      '    <hp>',
      '      <Default> 999 </Default>',
      '      <Flags> CELL_PUBLIC </Flags>',
      '      <Type> UINT32 </Type>',
      '      <Description> 改了描述 </Description>',
      '    </hp>',
      '  </Properties>',
      '  <CellMethods>',
      '    <reqMove>',
      '      <Arg>',
      '        <Type> VECTOR3 </Type>',
      '      </Arg>',
      '    </reqMove>',
      '  </CellMethods>',
      '  <BaseMethods>',
      '    <login />',
      '  </BaseMethods>',
      '</root>'
    ].join('\n');
    const verdict = classifyDefChange(BASE, cosmetic);
    expect(verdict.structural).toBe(false);
    expect(verdict.reasons).toEqual([]);
    expect(verdict.restartRequired).toBe(false);
  });

  it('任一侧解析不了 → 保守按结构性处理(不自动发)', () => {
    expect(classifyDefChange('not xml', BASE).structural).toBe(true);
    expect(classifyDefChange(BASE, '').structural).toBe(true);
    expect(classifyDefChange('', BASE).restartRequired).toBe(true);
  });

  it('identical → 非结构性', () => {
    expect(classifyDefChange(BASE, BASE).structural).toBe(false);
  });
});

describe('IDE-AUD-014 装载面:Parent/接口/组件/Persistent/Utype/未建模段', () => {
  // 装载面与未建模段基准:真实 def 形态(Parent/Interfaces/Components 在
  // wt/wire fixtures 实证:Parent 单文本、interface 小写子元素、组件槽
  // <槽名><Type><Persistent>)。装载面任一变化=核验结构性(继承/接口合并/
  // 组件装载都改有效结构);未建模顶段变=保守按结构性;注释/空白/重排
  // 不进指纹仍可通过。
  const LOADING_BASE = [
    '<root>',
    '  <Parent> Avatar </Parent>',
    '  <Interfaces>',
    '    <interface> ROLE </interface>',
    '    <interface> TALK </interface>',
    '  </Interfaces>',
    '  <Properties>',
    '    <hp>',
    '      <Type> UINT32 </Type>',
    '      <Flags> CELL_PUBLIC </Flags>',
    '      <Persistent> true </Persistent>',
    '      <Utype> 101 </Utype>',
    '    </hp>',
    '  </Properties>',
    '  <Components>',
    '    <bag>',
    '      <Type> Inventory </Type>',
    '      <Persistent> true </Persistent>',
    '    </bag>',
    '  </Components>',
    '  <DetailLevels>',
    '    <NEAR>',
    '      <radius> 10 </radius>',
    '    </NEAR>',
    '  </DetailLevels>',
    '</root>'
  ].join('\n');

  it('Parent 改 → 结构性(装载面)', () => {
    const after = LOADING_BASE.replace('<Parent> Avatar </Parent>', '<Parent> Monster </Parent>');
    const verdict = classifyDefChange(LOADING_BASE, after);
    expect(verdict.structural).toBe(true);
    expect(verdict.reasons.join('\n')).toContain('parent');
  });

  it('接口增/删 → 结构性(装载面)', () => {
    const added = LOADING_BASE.replace(
      '</Interfaces>',
      '    <interface> COMBAT </interface>\n  </Interfaces>'
    );
    expect(classifyDefChange(LOADING_BASE, added).structural).toBe(true);
    const removed = LOADING_BASE.replace('    <interface> TALK </interface>\n', '');
    expect(classifyDefChange(LOADING_BASE, removed).structural).toBe(true);
  });

  it('接口顺序重排 → 非结构性(集合语义,顺序无关)', () => {
    const reordered = LOADING_BASE.replace(
      '    <interface> ROLE </interface>\n    <interface> TALK </interface>',
      '    <interface> TALK </interface>\n    <interface> ROLE </interface>'
    );
    const verdict = classifyDefChange(LOADING_BASE, reordered);
    expect(verdict.structural).toBe(false);
    expect(verdict.reasons).toEqual([]);
  });

  it('组件槽 Type/Persistent 改 → 结构性(装载面)', () => {
    const typeChanged = LOADING_BASE.replace('<Type> Inventory </Type>', '<Type> WeaponSlot </Type>');
    expect(classifyDefChange(LOADING_BASE, typeChanged).structural).toBe(true);
    const persistentChanged = LOADING_BASE.replace(
      '<Persistent> true </Persistent>\n    </bag>',
      '<Persistent> false </Persistent>\n    </bag>'
    );
    expect(classifyDefChange(LOADING_BASE, persistentChanged).structural).toBe(true);
  });

  it('属性 Persistent 改 → 结构性(序列化面)', () => {
    const after = LOADING_BASE.replace(
      '<Persistent> true </Persistent>\n      <Utype>',
      '<Persistent> false </Persistent>\n      <Utype>'
    );
    const verdict = classifyDefChange(LOADING_BASE, after);
    expect(verdict.structural).toBe(true);
    expect(verdict.reasons.join('\n')).toContain('hp');
  });

  it('属性 Utype 改 → 结构性(序列化面)', () => {
    const after = LOADING_BASE.replace('<Utype> 101 </Utype>', '<Utype> 202 </Utype>');
    expect(classifyDefChange(LOADING_BASE, after).structural).toBe(true);
  });

  it('ClientMethods 方法 Arg 改 → 结构性(RPC 面,既有能力补测)', () => {
    const withClient = [
      '<root>',
      '  <ClientMethods>',
      '    <onBattleResult>',
      '      <Arg> UINT16 </Arg>',
      '    </onBattleResult>',
      '  </ClientMethods>',
      '</root>'
    ].join('\n');
    const changed = withClient.replace('<Arg> UINT16 </Arg>', '<Arg> UINT32 </Arg>');
    expect(classifyDefChange(withClient, changed).structural).toBe(true);
  });

  it('未建模段(DetailLevels)内容改 → 保守按结构性', () => {
    const after = LOADING_BASE.replace('<radius> 10 </radius>', '<radius> 20 </radius>');
    const verdict = classifyDefChange(LOADING_BASE, after);
    expect(verdict.structural).toBe(true);
    expect(verdict.reasons.join('\n')).toContain('DetailLevels');
  });

  it('未建模段新增 → 保守按结构性', () => {
    const after = LOADING_BASE.replace(
      '</root>',
      '  <Volatile>\n    <position> true </position>\n  </Volatile>\n</root>'
    );
    const verdict = classifyDefChange(LOADING_BASE, after);
    expect(verdict.structural).toBe(true);
    expect(verdict.reasons.join('\n')).toContain('Volatile');
  });

  it('未建模段注释/空白改 → 仍可通过(非结构性)', () => {
    const after = LOADING_BASE.replace(
      '    <NEAR>\n      <radius>',
      '    <NEAR>\n      <!-- lod 调整 -->\n      <radius>'
    );
    const verdict = classifyDefChange(LOADING_BASE, after);
    expect(verdict.structural).toBe(false);
    expect(verdict.reasons).toEqual([]);
  });

  it('装载面注释/空白改 → 非结构性', () => {
    const after = LOADING_BASE.replace(
      '  <Parent> Avatar </Parent>',
      '  <!-- 继承根 -->\n  <Parent>   Avatar   </Parent>'
    );
    const verdict = classifyDefChange(LOADING_BASE, after);
    expect(verdict.structural).toBe(false);
    expect(verdict.reasons).toEqual([]);
  });

  it('identical(含装载面/未建模段) → 非结构性', () => {
    expect(classifyDefChange(LOADING_BASE, LOADING_BASE).structural).toBe(false);
  });
});

describe('defChangeVerdictDetail(需重启标注文案)', () => {
  it('结构性给需重启+原因;非结构性给可走普通 reload 文案', () => {
    const structural = classifyDefChange(BASE, withBase({ properties: '    <hp><Type> FLOAT </Type><Flags> CELL_PUBLIC </Flags></hp>' +
      '    <level><Type> UINT16 </Type></level>' }));
    expect(defChangeVerdictDetail(structural)).toContain('需重启');
    expect(defChangeVerdictDetail(structural)).toContain('hp');

    const cosmetic = classifyDefChange(BASE, BASE);
    expect(defChangeVerdictDetail(cosmetic)).toContain('非结构性');
  });
});
