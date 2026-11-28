/**
 * RUST-177/KBE-007:types.xml 结构完整性检查(纯模块面)。
 * 判据全部按引擎装载真源(datatypes.cpp loadTypes 单遍序敏/xml.cpp getValStr
 * 只认文本节点/datatype.cpp FixedArrayType+FixedDictType initialize):
 * - 前向引用/循环/自引用/元素形态指引 → kbengine.types.forwardRef(引擎
 *   getDataType 查不到 → 中止);
 * - `_` 保留前缀 → kbengine.types.reservedPrefix;
 * - 重定义(大小写不敏感,先注册者胜)→ kbengine.types.duplicateAlias Warning;
 * - ARRAY `<of>` 兄弟链缺失/嵌套缺下一个 of/目标未知/FIXED_DICT 关键字 →
 *   kbengine.types.arrayOf;
 * - FIXED_DICT 缺 Properties/无字段/全字段被丢弃 → kbengine.types.fixedDictStructure;
 * - 字段缺 Type(Warning 非致命)/字段类型未知 → fieldNoType/fieldType;
 * - FD 字段 ENTITYCALL 静默降持久化(显式关断是大小写敏感的 'false')→
 *   kbengine.types.fdEntityCallPersistent。
 * 诚实边界钉:空条目引擎静默跳过(不注册);名字解析大小写敏感精确匹配
 * (大小写笔误出对照提示);致命条目不入表(后文引用照常如实检出)。
 */
import { describe, expect, it } from 'vitest';
import { computeTypesXmlStructureFindings } from '../src/backend/typesXmlStructureCheck';
import { validateTypesXmlDocument } from '../src/languageProviders/validation';
import {
  Diagnostic,
  DiagnosticCollection,
  DiagnosticSeverity,
  Position,
  Range,
  configurationOverrides,
  makeTextDocument
} from './helpers/vscodeStub';

const check = (text: string) => computeTypesXmlStructureFindings(text);
const codesOf = (text: string) => check(text).map(f => f.code);

/** demo 模板真实形态(templates/assets/scripts/entity_defs/types.xml)——合法基线零发现 */
const DEMO_SHAPED = [
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
  '  <ITEM_IDS>',
  '    ARRAY',
  '    <of> ITEM_ID </of>',
  '  </ITEM_IDS>',
  '</root>'
].join('\n');

describe('RUST-177 types.xml 结构完整性(纯核)', () => {
  it('demo 模板形态基线:零发现', () => {
    expect(check(DEMO_SHAPED)).toEqual([]);
  });

  it('前向引用:目标在后文声明 → forwardRef(消息含「前向引用」)', () => {
    const text = ['<root>', '  <A>Item</A>', '  <Item>UINT32</Item>', '</root>'].join('\n');
    const findings = check(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe('kbengine.types.forwardRef');
    expect(findings[0].severity).toBe('error');
    expect(findings[0].message).toContain('前向引用');
    // 锚 = 条目首文本(目标指引)
    expect(text.slice(findings[0].offset, findings[0].offset + findings[0].length)).toContain('Item');
  });

  it('自引用与两元循环:同落「此刻未知」(引擎无循环检测,单遍序敏)', () => {
    const selfRef = ['<root>', '  <A>A</A>', '</root>'].join('\n');
    expect(codesOf(selfRef)).toEqual(['kbengine.types.forwardRef']);
    const cycle = ['<root>', '  <A>B</A>', '  <B>A</B>', '</root>'].join('\n');
    expect(codesOf(cycle)).toEqual(['kbengine.types.forwardRef', 'kbengine.types.forwardRef']);
  });

  it('顺序反转后零发现:装载序敏(先声明先注册)', () => {
    const text = ['<root>', '  <Item>UINT32</Item>', '  <A>Item</A>', '</root>'].join('\n');
    expect(check(text)).toEqual([]);
  });

  it('未知目标(后文也没有):forwardRef 无「前向引用」字样', () => {
    const text = ['<root>', '  <A>Ghost</A>', '</root>'].join('\n');
    const findings = check(text);
    expect(findings[0].code).toBe('kbengine.types.forwardRef');
    expect(findings[0].message).not.toContain('前向引用');
    expect(findings[0].message).toContain('此刻不可解');
  });

  it('名字解析大小写敏感(gold vs Gold):forwardRef + 大小写对照提示', () => {
    const text = ['<root>', '  <Gold>UINT32</Gold>', '  <Bag>gold</Bag>', '</root>'].join('\n');
    const findings = check(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe('kbengine.types.forwardRef');
    expect(findings[0].message).toContain('大小写不一致');
    expect(findings[0].message).toContain('「Gold」');
    expect(findings[0].message).not.toContain('前向引用');
  });

  it('元素形态指引:getValStr 得空串 → forwardRef(引擎中止路径)', () => {
    const text = ['<root>', '  <A>', '    <Type>UINT32</Type>', '  </A>', '</root>'].join('\n');
    const findings = check(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe('kbengine.types.forwardRef');
    expect(findings[0].message).toContain('元素形态');
  });

  it('空条目:引擎整条静默跳过(零发现且不注册,后文引用照常检出)', () => {
    const text = ['<root>', '  <Empty></Empty>', '  <A>Empty</A>', '</root>'].join('\n');
    const findings = check(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe('kbengine.types.forwardRef');
  });

  it('保留前缀 _:reservedPrefix 且本条不注册', () => {
    const text = ['<root>', '  <_Tmp>UINT32</_Tmp>', '</root>'].join('\n');
    const findings = check(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe('kbengine.types.reservedPrefix');
    expect(findings[0].severity).toBe('error');
  });

  it('重定义(精确重名):duplicateAlias Warning,先注册者胜', () => {
    const text = ['<root>', '  <Gold>UINT32</Gold>', '  <Gold>UINT16</Gold>', '  <Bag>Gold</Bag>', '</root>'].join('\n');
    const findings = check(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe('kbengine.types.duplicateAlias');
    expect(findings[0].severity).toBe('warning');
    expect(findings[0].message).toContain('先注册者胜');
  });

  it('重定义(大小写不敏感 Item/ITEM):同码;被拒条目名不在注册表,后文引它按精确名如实检出', () => {
    const text = ['<root>', '  <Item>UINT32</Item>', '  <ITEM>UINT16</ITEM>', '  <Bag>ITEM</Bag>', '</root>'].join('\n');
    const findings = check(text);
    expect(findings.map(f => f.code)).toEqual([
      'kbengine.types.duplicateAlias',
      'kbengine.types.forwardRef'
    ]);
    // 第二条消息给大小写对照(注册表里有 Item,ITEM 不命中)
    expect(findings[1].message).toContain('大小写不一致');
  });

  it('ARRAY 缺 <of>:arrayOf', () => {
    const text = ['<root>', '  <LIST>ARRAY</LIST>', '</root>'].join('\n');
    const findings = check(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe('kbengine.types.arrayOf');
    expect(findings[0].message).toContain('not found');
  });

  it('ARRAY <of> 目标未知/前向/FIXED_DICT 关键字:arrayOf', () => {
    const unknown = ['<root>', '  <LIST>', '    ARRAY', '    <of>Ghost</of>', '  </LIST>', '</root>'].join('\n');
    expect(codesOf(unknown)).toEqual(['kbengine.types.arrayOf']);
    const forward = ['<root>', '  <LIST>', '    ARRAY', '    <of>Item</of>', '  </LIST>', '  <Item>UINT32</Item>', '</root>'].join('\n');
    const forwardFindings = check(forward);
    expect(forwardFindings[0].code).toBe('kbengine.types.arrayOf');
    expect(forwardFindings[0].message).toContain('前向引用');
    const keyword = ['<root>', '  <LIST>', '    ARRAY', '    <of>FIXED_DICT</of>', '  </LIST>', '</root>'].join('\n');
    expect(codesOf(keyword)).toEqual(['kbengine.types.arrayOf']);
  });

  it('嵌套 ARRAY = 同级下一个 <of> 兄弟:合法两层级零发现', () => {
    const text = [
      '<root>',
      '  <PAIR>',
      '    ARRAY',
      '    <of>ARRAY</of>',
      '    <of>UINT32</of>',
      '  </PAIR>',
      '</root>'
    ].join('\n');
    expect(check(text)).toEqual([]);
  });

  it('嵌套 ARRAY 缺下一个 <of> 兄弟:arrayOf(嵌套层 not found of)', () => {
    const text = [
      '<root>',
      '  <PAIR>',
      '    ARRAY',
      '    <of>ARRAY</of>',
      '  </PAIR>',
      '</root>'
    ].join('\n');
    const findings = check(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe('kbengine.types.arrayOf');
    expect(findings[0].message).toContain('下一个 <of>');
  });

  it('FD 缺 Properties:fixedDictStructure', () => {
    const text = ['<root>', '  <POS>', '    FIXED_DICT', '  </POS>', '</root>'].join('\n');
    const findings = check(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe('kbengine.types.fixedDictStructure');
    expect(findings[0].severity).toBe('error');
  });

  it('FD Properties 下无字段:no keys 中止面', () => {
    const text = ['<root>', '  <POS>', '    FIXED_DICT', '    <Properties>', '    </Properties>', '  </POS>', '</root>'].join('\n');
    const findings = check(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe('kbengine.types.fixedDictStructure');
    expect(findings[0].message).toContain('no keys');
  });

  it('FD 全部字段缺 Type:fieldNoType Warning + no keys Error', () => {
    const text = [
      '<root>',
      '  <POS>',
      '    FIXED_DICT',
      '    <Properties>',
      '      <x/>',
      '      <y/>',
      '    </Properties>',
      '  </POS>',
      '</root>'
    ].join('\n');
    const findings = check(text);
    expect(findings.map(f => f.code)).toEqual([
      'kbengine.types.fieldNoType',
      'kbengine.types.fieldNoType',
      'kbengine.types.fixedDictStructure'
    ]);
    expect(findings[0].severity).toBe('warning');
  });

  it('FD 字段缺 Type 非致命:其余字段健在时 FD 照常注册(无 no keys)', () => {
    const text = [
      '<root>',
      '  <POS>',
      '    FIXED_DICT',
      '    <Properties>',
      '      <bad/>',
      '      <x>',
      '        <Type>FLOAT</Type>',
      '      </x>',
      '    </Properties>',
      '  </POS>',
      '  <REF>POS</REF>',
      '</root>'
    ].join('\n');
    const findings = check(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe('kbengine.types.fieldNoType');
  });

  it('FD 字段类型未知/前向/FIXED_DICT 关键字:fieldType(致命,FD 不注册)', () => {
    const unknown = [
      '<root>',
      '  <POS>',
      '    FIXED_DICT',
      '    <Properties>',
      '      <x>',
      '        <Type>Ghost</Type>',
      '      </x>',
      '    </Properties>',
      '  </POS>',
      '</root>'
    ].join('\n');
    expect(codesOf(unknown)).toEqual(['kbengine.types.fieldType']);
    const forward = [
      '<root>',
      '  <POS>',
      '    FIXED_DICT',
      '    <Properties>',
      '      <x>',
      '        <Type>Unit</Type>',
      '      </x>',
      '    </Properties>',
      '  </POS>',
      '  <Unit>UINT32</Unit>',
      '</root>'
    ].join('\n');
    const forwardFindings = check(forward);
    expect(forwardFindings[0].code).toBe('kbengine.types.fieldType');
    expect(forwardFindings[0].message).toContain('前向引用');
    // 致命:FD 不注册,后文引用 FD 的条目照常如实检出前向引用
    const after = [
      '<root>',
      '  <POS>',
      '    FIXED_DICT',
      '    <Properties>',
      '      <x>',
      '        <Type>Ghost</Type>',
      '      </x>',
      '    </Properties>',
      '  </POS>',
      '  <REF>POS</REF>',
      '</root>'
    ].join('\n');
    expect(codesOf(after)).toEqual(['kbengine.types.fieldType', 'kbengine.types.forwardRef']);
    const keyword = [
      '<root>',
      '  <POS>',
      '    FIXED_DICT',
      '    <Properties>',
      '      <x>',
      '        <Type>FIXED_DICT</Type>',
      '      </x>',
      '    </Properties>',
      '  </POS>',
      '</root>'
    ].join('\n');
    expect(codesOf(keyword)).toEqual(['kbengine.types.fieldType']);
  });

  it('FD 字段类型元素形态指引(<Type> 内是元素无文本):fieldType', () => {
    const text = [
      '<root>',
      '  <POS>',
      '    FIXED_DICT',
      '    <Properties>',
      '      <x>',
      '        <Type><Ghost/></Type>',
      '      </x>',
      '    </Properties>',
      '  </POS>',
      '</root>'
    ].join('\n');
    expect(codesOf(text)).toEqual(['kbengine.types.fieldType']);
  });

  it('FD 字段类型解析到 ENTITYCALL 且未显式关断:fdEntityCallPersistent Warning', () => {
    const text = [
      '<root>',
      '  <HOME>',
      '    FIXED_DICT',
      '    <Properties>',
      '      <target>',
      '        <Type>ENTITYCALL</Type>',
      '      </target>',
      '    </Properties>',
      '  </HOME>',
      '</root>'
    ].join('\n');
    const findings = check(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe('kbengine.types.fdEntityCallPersistent');
    expect(findings[0].severity).toBe('warning');
    expect(findings[0].message).toContain('datatype.cpp:2141-2144');
  });

  it('FD 字段别名链末端 ENTITYCALL:同码;显式 false 关断不报;False(大小写敏感)照报', () => {
    const base = [
      '<root>',
      '  <TARGET_OF>ENTITYCALL</TARGET_OF>',
      '  <HOME>',
      '    FIXED_DICT',
      '    <Properties>',
      '      <target>',
      '        <Type>TARGET_OF</Type>',
      '        <Persistent>{{PERSISTENT}}</Persistent>',
      '      </target>',
      '    </Properties>',
      '  </HOME>',
      '</root>'
    ].join('\n');
    const on = check(base.replace('{{PERSISTENT}}', 'true'));
    expect(on.map(f => f.code)).toEqual(['kbengine.types.fdEntityCallPersistent']);
    const off = check(base.replace('{{PERSISTENT}}', 'false'));
    expect(off).toEqual([]);
    // 引擎 :2068-2075 大小写敏感 == 'false':'False' 不关断 → 照报
    const wrongCase = check(base.replace('{{PERSISTENT}}', 'False'));
    expect(wrongCase.map(f => f.code)).toEqual(['kbengine.types.fdEntityCallPersistent']);
  });

  it('FD ARRAY 字段元素末端 ENTITYCALL:fdEntityCallPersistent(ARRAY 元素臂)', () => {
    const text = [
      '<root>',
      '  <HOME>',
      '    FIXED_DICT',
      '    <Properties>',
      '      <targets>',
      '        <Type>',
      '          ARRAY',
      '          <of>ENTITYCALL</of>',
      '        </Type>',
      '      </targets>',
      '    </Properties>',
      '  </HOME>',
      '</root>'
    ].join('\n');
    const findings = check(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe('kbengine.types.fdEntityCallPersistent');
    expect(findings[0].message).toContain('datatype.cpp:2104-2107');
  });

  it('FD 数组字段嵌套链(ARRAY of 别名):正常解析零发现;别名链末端 ENTITYCALL 照报', () => {
    const clean = [
      '<root>',
      '  <ITEM_ID>UINT32</ITEM_ID>',
      '  <HOME>',
      '    FIXED_DICT',
      '    <Properties>',
      '      <ids>',
      '        <Type>',
      '          ARRAY',
      '          <of>ITEM_ID</of>',
      '        </Type>',
      '      </ids>',
      '    </Properties>',
      '  </HOME>',
      '</root>'
    ].join('\n');
    expect(check(clean)).toEqual([]);
    const trap = clean.replace('<ITEM_ID>UINT32</ITEM_ID>', '<ITEM_ID>ENTITYCALL</ITEM_ID>');
    expect(check(trap).map(f => f.code)).toEqual(['kbengine.types.fdEntityCallPersistent']);
  });
});

describe('KODE-SYN-003 alias.xml 文档域(预载 types.xml 注册名)', () => {
  const preload = [
    { name: 'ITEM_ID', target: 'UINT16' },
    { name: 'BASE_REF', target: 'STRING' },
    { name: 'SLOT', target: 'FIXED_DICT' }
  ];
  const checkPre = (text: string) => computeTypesXmlStructureFindings(text, preload);

  it('types.xml 预载名在 alias 文档域可解(引擎先载 types.xml)', () => {
    const aliasDoc = [
      '<root>',
      '  <CUR_ID> ITEM_ID </CUR_ID>',
      '  <WHO> BASE_REF </WHO>',
      '</root>'
    ].join('\n');
    expect(checkPre(aliasDoc)).toEqual([]);
    // 对照:不预载同文档即前向引用口径的「此刻不可解」(预载正是差异本体)
    expect(check(aliasDoc).map(f => f.code)).toEqual([
      'kbengine.types.forwardRef',
      'kbengine.types.forwardRef'
    ]);
  });

  it('本文件先声明条目照常可解;后文条目仍是前向引用', () => {
    const chain = [
      '<root>',
      '  <A> ITEM_ID </A>',
      '  <B> A </B>',
      '  <C> B </C>',
      '</root>'
    ].join('\n');
    expect(checkPre(chain)).toEqual([]);
    const forward = [
      '<root>',
      '  <C> B </C>',
      '  <B> A </B>',
      '  <A> ITEM_ID </A>',
      '</root>'
    ].join('\n');
    expect(checkPre(forward).map(f => f.code)).toEqual([
      'kbengine.types.forwardRef',
      'kbengine.types.forwardRef'
    ]);
  });

  it('本文件环链逐条报前向引用(引擎单遍装载必然中止)', () => {
    const cycle = [
      '<root>',
      '  <A> B </A>',
      '  <B> A </B>',
      '</root>'
    ].join('\n');
    expect(checkPre(cycle).map(f => f.code)).toEqual([
      'kbengine.types.forwardRef',
      'kbengine.types.forwardRef'
    ]);
  });

  it('与 types.xml 重名:duplicateAlias Warning(先注册者胜,本条不生效)', () => {
    const dup = ['<root>', '  <ITEM_ID> UINT32 </ITEM_ID>', '</root>'].join('\n');
    const findings = checkPre(dup);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe('kbengine.types.duplicateAlias');
    expect(findings[0].severity).toBe('warning');
    // 本条不入表(types.xml 的 UINT16 版仍在表):后文引用照常可解——
    // 引擎先注册者胜,引用解析到的就是先注册那条
    const useDoc = ['<root>', '  <ITEM_ID> UINT32 </ITEM_ID>', '  <USE> ITEM_ID </USE>', '</root>'].join('\n');
    expect(checkPre(useDoc).map(f => f.code)).toEqual(['kbengine.types.duplicateAlias']);
  });

  it('预载带 _ 前缀名不入表:引用它如实报不可解(引擎 validTypeName 拒注册)', () => {
    const preloadWithReserved = [...preload, { name: '_TEMP', target: 'UINT8' }];
    const doc = ['<root>', '  <X> _TEMP </X>', '</root>'].join('\n');
    const findings = computeTypesXmlStructureFindings(doc, preloadWithReserved);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe('kbengine.types.forwardRef');
    expect(findings[0].message).toContain('此刻不可解');
  });

  it('FD 字段类型=预载名照常可解;预载复合名链末端 null 与在册条目行为一致', () => {
    const fdDoc = [
      '<root>',
      '  <PAYLOAD>',
      '    FIXED_DICT',
      '    <Properties>',
      '      <ref>',
      '        <Type> ITEM_ID </Type>',
      '      </ref>',
      '      <slot>',
      '        <Type> SLOT </Type>',
      '      </slot>',
      '    </Properties>',
      '  </PAYLOAD>',
      '</root>'
    ].join('\n');
    // SLOT 预载指引 FIXED_DICT:可解性走精确表命中;链末端 null=复合名
    // 不出 ENTITYCALL 误报(与在册复合条目同口径)
    expect(checkPre(fdDoc)).toEqual([]);
  });
});

describe('RUST-177 validateTypesXmlDocument(装配面)', () => {
  const doc = (text: string) =>
    makeTextDocument(text, { fileName: '/tmp/ws/scripts/entity_defs/types.xml', languageId: 'xml' });

  it('发现映射:severity/code/区间落在目标指引文本上', () => {
    const collection = new DiagnosticCollection();
    const text = ['<root>', '  <A>Ghost</A>', '</root>'].join('\n');
    const document = doc(text);
    validateTypesXmlDocument(document, collection);
    const items = collection.get(document.uri);
    expect(items).toHaveLength(1);
    expect(items[0].code).toBe('kbengine.types.forwardRef');
    expect(items[0].severity).toBe(DiagnosticSeverity.Error);
    expect(document.offsetAt(items[0].range.start)).toBe(text.indexOf('Ghost'));
  });

  it('enableDiagnostics=false:delete 旧诊断', () => {
    configurationOverrides.set('kbengine', { enableDiagnostics: false });
    const collection = new DiagnosticCollection();
    const text = ['<root>', '  <A>Ghost</A>', '</root>'].join('\n');
    const document = doc(text);
    collection.set(document.uri, [
      new Diagnostic(new Range(new Position(0, 0), new Position(0, 1)), 'x', DiagnosticSeverity.Warning)
    ]);
    try {
      validateTypesXmlDocument(document, collection);
      expect(collection.get(document.uri)).toEqual([]);
    } finally {
      configurationOverrides.clear();
    }
  });
});

// ---------------------------------------------------------------------------
// 批 20 容错臂:ARRAY <of> 链解析三退路(空指引/断链/循环)、FD 字段 <Type>
// 空指引与 ARRAY 装载失败中止、畸形 XML 零发现(解析器抛 → 不声称)。
// ---------------------------------------------------------------------------
describe('批 20:ARRAY 链与 FD 字段容错臂', () => {
  it('<of> 无指引 → arrayOf error(did not find type 路径)', () => {
    const text = [
      '<root>',
      '  <ITEMS>',
      '    ARRAY',
      '    <of></of>',
      '  </ITEMS>',
      '</root>'
    ].join('\n');
    const findings = check(text);
    expect(codesOf(text)).toContain('kbengine.types.arrayOf');
    const target = findings.find(f => f.code === 'kbengine.types.arrayOf')!;
    expect(target.severity).toBe('error');
    expect(target.message).toContain('did not find type');
  });

  it('<of> 指向未知名 → 链尾不可解,arrayOf error', () => {
    const text = [
      '<root>',
      '  <ITEMS>',
      '    ARRAY',
      '    <of> GHOST </of>',
      '  </ITEMS>',
      '</root>'
    ].join('\n');
    expect(codesOf(text)).toContain('kbengine.types.arrayOf');
  });

  it('别名链成环 → 不可解,不悬挂', () => {
    const text = [
      '<root>',
      '  <ITEMS>',
      '    ARRAY',
      '    <of> LOOP_A </of>',
      '  </ITEMS>',
      '  <LOOP_A>LOOP_B</LOOP_A>',
      '  <LOOP_B>LOOP_A</LOOP_B>',
      '</root>'
    ].join('\n');
    expect(codesOf(text)).toContain('kbengine.types.arrayOf');
  });

  it('FD 字段 <Type> 空指引 → fieldType error + 中止装载', () => {
    const text = [
      '<root>',
      '  <SLOT>',
      '    FIXED_DICT',
      '    <Properties>',
      '      <count>',
      '        <Type></Type>',
      '      </count>',
      '    </Properties>',
      '  </SLOT>',
      '</root>'
    ].join('\n');
    expect(codesOf(text)).toContain('kbengine.types.fieldType');
    const target = check(text).find(f => f.code === 'kbengine.types.fieldType')!;
    expect(target.severity).toBe('error');
    expect(target.message).toContain('did not find type');
  });

  it('FD 字段 ARRAY 链断 → 装载失败中止(fatal),不再继续判该字段', () => {
    const text = [
      '<root>',
      '  <SLOT>',
      '    FIXED_DICT',
      '    <Properties>',
      '      <items>',
      '        <Type>',
      '          ARRAY',
      '          <of> GHOST </of>',
      '        </Type>',
      '      </items>',
      '    </Properties>',
      '  </SLOT>',
      '</root>'
    ].join('\n');
    // 装载失败的中止路径本身不产新发现码;断链的 arrayOf 已由 <of> 解析报出
    expect(codesOf(text)).toContain('kbengine.types.arrayOf');
  });

  it('畸形 XML(不可解析)→ 零发现(不声称)', () => {
    expect(check('<root')).toEqual([]);
    expect(check('')).toEqual([]);
  });
});

describe('批 20 续:别名链断与环(preload 精确构造,FD 字段装载面)', () => {
  // FD 字段 ARRAY 元素类型经别名链解析:链断/成环 → 字段装载失败(fatal),
  // 可观察后果 = 即便链首指向 ENTITYCALL 也不出静默降持久化警告
  const fdOf = [
    '<root>',
    '  <SLOT>',
    '    FIXED_DICT',
    '    <Properties>',
    '      <calls>',
    '        <Type>',
    '          ARRAY',
    '          <of> EC_ALIAS </of>',
    '        </Type>',
    '      </calls>',
    '    </Properties>',
    '  </SLOT>',
    '</root>'
  ].join('\n');

  it('链尾目标未注册(悬空别名)→ 字段装载失败,零 ENTITYCALL 警告', () => {
    const preload = [
      { name: 'EC_ALIAS', target: 'GHOST_TYPE' }
    ];
    expect(computeTypesXmlStructureFindings(fdOf, preload)).toEqual([]);
  });

  it('别名链成环(preload CA→CB→CA)→ 不可解不悬挂,零 ENTITYCALL 警告', () => {
    const preload = [
      { name: 'EC_ALIAS', target: 'CA' },
      { name: 'CA', target: 'CB' },
      { name: 'CB', target: 'CA' }
    ];
    expect(computeTypesXmlStructureFindings(fdOf, preload)).toEqual([]);
  });

  it('对照:链首直连 ENTITYCALL(链通)→ 静默降持久化警告照出', () => {
    const preload = [{ name: 'EC_ALIAS', target: 'ENTITYCALL' }];
    const findings = computeTypesXmlStructureFindings(fdOf, preload);
    expect(findings.map(f => f.code)).toEqual(['kbengine.types.fdEntityCallPersistent']);
  });
});


// 预载链末端与畸形域:别名链末端不可解/成环 → resolveAliasChainEnd null
// (条目不注册,后文引用照常如实检出);解析失败的文档不在本文面声称(零发现)。
describe('别名链末端不可解与解析失败域', () => {
  it('预载别名链末端指向未注册名:ARRAY 条目不注册,后文引用如实检出', () => {
    // 预载表无目标校验(KODE-SYN-003 预载 = types.xml 已注册名带指引),
    // 引用面沿链走末端 → GHOST 既非内建也不在册 → 链末端 null,ARRAY 装载失败
    const findings = computeTypesXmlStructureFindings(
      ['<root>', '  <LIST>', '    ARRAY', '    <of> GHOSTREF </of>', '  </LIST>', '  <USE> LIST </USE>', '</root>'].join('\n'),
      [{ name: 'GHOSTREF', target: 'GHOST' }]
    );
    expect(codesOf).toBeDefined();
    expect(findings.map(f => f.code)).toEqual(['kbengine.types.forwardRef']);
    expect(findings[0].message).toContain('LIST');
  });

  it('预载别名链成环(X→Y→X):ARRAY 条目同样不注册', () => {
    // 引擎单遍装载不可能成环注册,但预载表按指引原样入账——环链末端解析
    // 有界防环,返回 null 与不可解同口径(条目不注册)
    const findings = computeTypesXmlStructureFindings(
      ['<root>', '  <LIST>', '    ARRAY', '    <of> X </of>', '  </LIST>', '  <USE> LIST </USE>', '</root>'].join('\n'),
      [{ name: 'X', target: 'Y' }, { name: 'Y', target: 'X' }]
    );
    expect(findings.map(f => f.code)).toEqual(['kbengine.types.forwardRef']);
  });

  it('FD 字段别名链末端不可解:零发现(链末端 null 不冒充 ENTITYCALL 误报)', () => {
    // 对照:链末端解析到 ENTITYCALL 会报静默降持久化;末端不可解 → 不报
    const findings = computeTypesXmlStructureFindings(
      ['<root>', '  <PAYLOAD>', '    FIXED_DICT', '    <Properties>', '      <ref>', '        <Type> GHOSTREF </Type>', '      </ref>', '    </Properties>', '  </PAYLOAD>', '</root>'].join('\n'),
      [{ name: 'GHOSTREF', target: 'GHOST' }]
    );
    expect(findings).toEqual([]);
  });

  it('<of> 无元素类型指引(空元素):arrayOf error', () => {
    const text = ['<root>', '  <LIST>', '    ARRAY', '    <of></of>', '  </LIST>', '</root>'].join('\n');
    const findings = check(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe('kbengine.types.arrayOf');
    expect(findings[0].severity).toBe('error');
    expect(findings[0].message).toContain('没有元素类型指引');
    // 无(非空白)子节点 → 锚回落整个 <of> 元素区间
    expect(text.slice(findings[0].offset, findings[0].offset + findings[0].length)).toBe('<of></of>');
  });

  it('FD 字段 <Type> 无类型指引(空元素):fieldType 致命,FD 不注册', () => {
    const text = [
      '<root>',
      '  <PAYLOAD>',
      '    FIXED_DICT',
      '    <Properties>',
      '      <ref>',
      '        <Type></Type>',
      '      </ref>',
      '      <count>',
      '        <Type> UINT32 </Type>',
      '      </count>',
      '    </Properties>',
      '  </PAYLOAD>',
      '  <USE> PAYLOAD </USE>',
      '</root>'
    ].join('\n');
    const findings = check(text);
    expect(findings.map(f => f.code)).toEqual(['kbengine.types.fieldType', 'kbengine.types.forwardRef']);
    expect(findings[0].severity).toBe('error');
    expect(findings[0].message).toContain('没有类型指引');
    // 致命条目不入表:后文引用 PAYLOAD 照常如实检出(第二条 forwardRef)
    expect(findings[1].message).toContain('PAYLOAD');
  });

  it('FD ARRAY 字段元素链不可解:装载失败,FD 不注册', () => {
    const text = [
      '<root>',
      '  <PAYLOAD>',
      '    FIXED_DICT',
      '    <Properties>',
      '      <slots>',
      '        <Type>',
      '          ARRAY',
      '          <of> GHOST </of>',
      '        </Type>',
      '      </slots>',
      '    </Properties>',
      '  </PAYLOAD>',
      '  <USE> PAYLOAD </USE>',
      '</root>'
    ].join('\n');
    const findings = check(text);
    expect(findings.map(f => f.code)).toEqual(['kbengine.types.arrayOf', 'kbengine.types.forwardRef']);
    expect(findings[1].message).toContain('PAYLOAD');
  });

  it('畸形 XML(元素未闭合):解析失败不在本文面声称,零发现', () => {
    // 解析器对定位失败抛错(defParser consumeNextToken);本文面只在可解析
    // 文档上声称 → catch 兜底零发现
    expect(check(['<root>', '  <A> UINT32', '</root>'].join('\n'))).toEqual([]);
  });
});
