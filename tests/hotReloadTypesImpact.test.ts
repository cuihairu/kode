import { describe, expect, it } from 'vitest';

import {
  analyzeTypesImpact,
  collectDefCustomTypeRefs,
  formatTypesImpactReport,
  parseCustomTypes
} from '../src/backend/hotReloadTypesImpact';

// RUST-398(HR-HASH-011):types.xml 自定义类型变化 → 受影响全部 .def 的
// reverse-dependency 影响报告。判据:
// - 自定义类型声明 = <root> 子元素,kind 在 type 属性或内容;
// - 形状规范化(去注释/空白/子序排序+属性)变=结构性变化;
// - 变化沿类型依赖图传递闭包传播(B 变 → 依赖 B 的 A 语义变 → 引用 A 的 .def 受影响);
// - .def 引用 = <Type>/<Arg>/<of> token ∩ 声明集(内建类型不入集);
// - 新增类型不使既有 .def 受影响;删除/形状变按闭包传播;
// - 任何受影响 .def → restartRequired(不作为普通 Python reload 自动发送)。

const TYPES_XML = [
  '<root>',
  '  <ITEM_ID> UINT16 </ITEM_ID>',
  '  <ITEM_DESC> STRING </ITEM_DESC>',
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
  '    </Properties>',
  '    <implementedBy> SKILL_SLOT_DATA.inst </implementedBy>',
  '  </SKILL_SLOT>',
  '  <BAG>',
  '    FIXED_DICT',
  '    <Properties>',
  '      <slots>',
  '        <Type> ARRAY <of> ITEM_ID </of> </Type>',
  '      </slots>',
  '    </Properties>',
  '  </BAG>',
  '</root>'
].join('\n');

const DEF_USING_BAG = [
  '<root>',
  '  <Properties>',
  '    <bag>',
  '      <Type> BAG </Type>',
  '    </bag>',
  '  </Properties>',
  '</root>'
].join('\n');

const DEF_USING_ITEM_DESC = [
  '<root>',
  '  <Properties>',
  '    <desc>',
  '      <Type> ITEM_DESC </Type>',
  '    </desc>',
  '  </Properties>',
  '</root>'
].join('\n');

const DEF_USING_PRIMITIVE = [
  '<root>',
  '  <Properties>',
  '    <hp>',
  '      <Type> UINT32 </Type>',
  '    </hp>',
  '  </Properties>',
  '</root>'
].join('\n');

describe('RUST-398 parseCustomTypes(types.xml 声明表)', () => {
  it('解析声明表:名→形状+依赖引用', () => {
    const table = parseCustomTypes(TYPES_XML);
    expect([...table.keys()].sort()).toEqual(['BAG', 'ITEM_DESC', 'ITEM_ID', 'SKILL_SLOT']);
    // 别名:内容首 token 为内建,无自定义依赖
    expect(table.get('ITEM_ID')!.references).toEqual([]);
    expect(table.get('ITEM_DESC')!.references).toEqual([]);
    // FIXED_DICT:依赖 ITEM_ID(BAG 的属性 ARRAY<ITEM_ID>)
    expect(table.get('BAG')!.references).toEqual(['ITEM_ID']);
    // SKILL_SLOT:of 是 UINT32(内建),无自定义依赖
    expect(table.get('SKILL_SLOT')!.references).toEqual([]);
  });

  it('解析不了根 → 空表(如实不造)', () => {
    expect(parseCustomTypes('not xml').size).toBe(0);
    expect(parseCustomTypes('').size).toBe(0);
  });

  it('type 属性式声明也入表(kind 在属性,形状含属性)', () => {
    const table = parseCustomTypes('<root>\n  <JOB type="UINT32"/>\n</root>');
    expect(table.get('JOB')!).toBeDefined();
    expect(table.get('JOB')!.shape).toContain('type=UINT32');
  });

  it('重复声明名首见保留(BTreeMap entry/or_insert 同口径)', () => {
    const table = parseCustomTypes('<root>\n  <DUP> UINT16 </DUP>\n  <DUP> UINT32 </DUP>\n</root>');
    expect([...table.keys()]).toEqual(['DUP']);
    expect(table.get('DUP')!.shape).toBe('UINT16');
  });

  it('空 <Type/> token 不入集(无文本 token 即跳过)', () => {
    const table = parseCustomTypes(
      '<root>\n  <EMPTY> FIXED_DICT <Properties><k><Type/></k></Properties> </EMPTY>\n</root>'
    );
    expect(table.get('EMPTY')!.references).toEqual([]);
  });
});

describe('RUST-398 collectDefCustomTypeRefs(.def 自定义类型引用)', () => {
  it('BAG/ITEM_DESC 命中声明集;内建不入集;注释与顺序无关', () => {
    const names = new Set(['BAG', 'ITEM_DESC', 'ITEM_ID', 'SKILL_SLOT']);
    expect([...collectDefCustomTypeRefs(DEF_USING_BAG, names)]).toEqual(['BAG']);
    expect([...collectDefCustomTypeRefs(DEF_USING_ITEM_DESC, names)]).toEqual(['ITEM_DESC']);
    // 内建 UINT32 不在声明集 → 空
    expect(collectDefCustomTypeRefs(DEF_USING_PRIMITIVE, names).size).toBe(0);
  });

  it('解析不了的 .def → 空集(如实,不造引用;解析失败另有诊断面)', () => {
    expect(collectDefCustomTypeRefs('not xml at all', new Set(['BAG'])).size).toBe(0);
  });
});

describe('RUST-398 analyzeTypesImpact(影响报告)', () => {
  it('无变化 → 无 changed/无 affected', () => {
    const report = analyzeTypesImpact({
      beforeTypesXml: TYPES_XML,
      afterTypesXml: TYPES_XML,
      defs: [{ name: 'Monster.def', text: DEF_USING_BAG }]
    });
    expect(report.changedTypes).toEqual([]);
    expect(report.affectedDefs).toEqual([]);
    expect(report.anyAffected).toBe(false);
  });

  it('ITEM_ID 结构变化 → 经类型依赖传播到引用 BAG 的 .def(闭包)', () => {
    // ITEM_ID 是 BAG 的依赖(BAG 引用 ITEM_ID);ITEM_ID 形状变化 → BAG 语义变
    // → 引用 BAG 的 .def 受影响(传播臂)。
    const after = TYPES_XML.replace('<ITEM_ID> UINT16 </ITEM_ID>', '<ITEM_ID> UINT32 </ITEM_ID>');
    const report = analyzeTypesImpact({
      beforeTypesXml: TYPES_XML,
      afterTypesXml: after,
      defs: [
        { name: 'Monster.def', text: DEF_USING_BAG },
        { name: 'Item.def', text: DEF_USING_ITEM_DESC }
      ]
    });
    expect(report.changedTypes.map(change => `${change.name}:${change.change}`)).toEqual([
      'ITEM_ID:changed'
    ]);
    expect(report.anyAffected).toBe(true);
    // Monster.def 引用 BAG,BAG 依赖 ITEM_ID → 受影响(传播);Item.def 引用
    // ITEM_DESC(不依赖 ITEM_ID)不受影响。
    expect(report.affectedDefs.map(def => def.name)).toEqual(['Monster.def']);
    expect(report.affectedDefs[0]!.reasons).toEqual(['经类型依赖传播受影响: BAG 依赖 ITEM_ID']);
  });

  it('ITEM_ID 变化直接命中引用它的 .def(直接臂)', () => {
    const after = TYPES_XML.replace('<ITEM_ID> UINT16 </ITEM_ID>', '<ITEM_ID> UINT32 </ITEM_ID>');
    // BAG 引用了 ITEM_ID;一个 def 直接引用 ITEM_ID(内联 ARRAY<ITEM_ID>)时走直接臂
    const defDirect = [
      '<root>',
      '  <Properties>',
      '    <ids>',
      '      <Type> ARRAY <of> ITEM_ID </of> </Type>',
      '    </ids>',
      '  </Properties>',
      '</root>'
    ].join('\n');
    const report = analyzeTypesImpact({
      beforeTypesXml: TYPES_XML,
      afterTypesXml: after,
      defs: [{ name: 'Direct.def', text: defDirect }]
    });
    expect(report.affectedDefs[0]!.reasons).toContain('直接引用受影响类型: ITEM_ID');
  });

  it('类型删除 → 引用它的 .def 受影响;新增类型不使既有 .def 受影响', () => {
    const afterRemoved = TYPES_XML.replace('  <ITEM_DESC> STRING </ITEM_DESC>\n', '');
    const reportRemoved = analyzeTypesImpact({
      beforeTypesXml: TYPES_XML,
      afterTypesXml: afterRemoved,
      defs: [{ name: 'Item.def', text: DEF_USING_ITEM_DESC }]
    });
    expect(reportRemoved.changedTypes.map(change => `${change.name}:${change.change}`)).toEqual([
      'ITEM_DESC:removed'
    ]);
    expect(reportRemoved.anyAffected).toBe(true);
    expect(reportRemoved.affectedDefs[0]!.reasons).toContain('直接引用受影响类型: ITEM_DESC');

    // 新增类型:既有 def 无从引用,不受影响
    const afterAdded = TYPES_XML.replace(
      '</root>',
      '  <NEW_TYPE> FIXED_DICT <Properties><x><Type>UINT8</Type></x></Properties> </NEW_TYPE>\n</root>'
    );
    const reportAdded = analyzeTypesImpact({
      beforeTypesXml: TYPES_XML,
      afterTypesXml: afterAdded,
      defs: [{ name: 'Monster.def', text: DEF_USING_BAG }]
    });
    expect(reportAdded.changedTypes.map(change => `${change.name}:${change.change}`)).toEqual([
      'NEW_TYPE:added'
    ]);
    expect(reportAdded.anyAffected).toBe(false);
    expect(reportAdded.affectedDefs).toEqual([]);
  });

  it('纯注释/空白变化 → 形状不变,非结构性(不产生 changed)', () => {
    const after = TYPES_XML.replace(
      '  <ITEM_ID> UINT16 </ITEM_ID>',
      '  <!-- 改注释 -->\n  <ITEM_ID>\n    UINT16\n  </ITEM_ID>'
    );
    const report = analyzeTypesImpact({
      beforeTypesXml: TYPES_XML,
      afterTypesXml: after,
      defs: [{ name: 'Monster.def', text: DEF_USING_BAG }]
    });
    expect(report.changedTypes).toEqual([]);
    expect(report.anyAffected).toBe(false);
  });

  it('类型依赖成环 → 闭包迭代终止(不动点),传播仍如实点名', () => {
    const cyclicTypes = [
      '<root>',
      '  <TYPE_A>',
      '    FIXED_DICT',
      '    <Properties><k><Type> TYPE_B </Type></k></Properties>',
      '  </TYPE_A>',
      '  <TYPE_B>',
      '    FIXED_DICT',
      '    <Properties><k><Type> TYPE_A </Type></k></Properties>',
      '  </TYPE_B>',
      '</root>'
    ].join('\n');
    const defUsingA = [
      '<root>',
      '  <Properties>',
      '    <a>',
      '      <Type> TYPE_A </Type>',
      '    </a>',
      '  </Properties>',
      '</root>'
    ].join('\n');
    // 只改 TYPE_A 自身结构(环保持闭合:TYPE_B 仍依赖 TYPE_A)——
    // 闭包迭代 TYPE_A→TYPE_B→TYPE_A 命中「已可达」臂后终止(不动点)
    const after = cyclicTypes.replace(
      '<Properties><k><Type> TYPE_B </Type></k></Properties>',
      '<Properties><k><Type> TYPE_B </Type></k><extra><Type> UINT8 </Type></extra></Properties>'
    );
    // 环内可达(不无限迭代):TYPE_A 可达 {TYPE_A, TYPE_B}
    const report = analyzeTypesImpact({
      beforeTypesXml: cyclicTypes,
      afterTypesXml: after,
      defs: [{ name: 'C.def', text: defUsingA }]
    });
    expect(report.anyAffected).toBe(true);
    expect(report.affectedDefs[0]!.reasons.join(' ')).toContain('直接引用受影响类型: TYPE_A');
  });
});

describe('RUST-398 formatTypesImpactReport(报告回显)', () => {
  it('有变化有影响 → 点名受影响 def + 需重启;无影响 → 无 .def 受影响', () => {
    const after = TYPES_XML.replace('<ITEM_ID> UINT16 </ITEM_ID>', '<ITEM_ID> UINT32 </ITEM_ID>');
    const report = analyzeTypesImpact({
      beforeTypesXml: TYPES_XML,
      afterTypesXml: after,
      defs: [{ name: 'Monster.def', text: DEF_USING_BAG }]
    });
    const text = formatTypesImpactReport(report);
    expect(text).toContain('ITEM_ID');
    expect(text).toContain('Monster.def');
    expect(text).toContain('需重启');

    const quiet = analyzeTypesImpact({
      beforeTypesXml: TYPES_XML,
      afterTypesXml: after,
      defs: [{ name: 'Hp.def', text: DEF_USING_PRIMITIVE }]
    });
    expect(formatTypesImpactReport(quiet)).toContain('无 .def 受影响');
  });

  it('零变化 → 无自定义类型结构变化,无影响', () => {
    const report = analyzeTypesImpact({
      beforeTypesXml: TYPES_XML,
      afterTypesXml: TYPES_XML,
      defs: [{ name: 'Monster.def', text: DEF_USING_BAG }]
    });
    expect(formatTypesImpactReport(report)).toBe('types.xml 无自定义类型结构变化,无影响');
  });
});
