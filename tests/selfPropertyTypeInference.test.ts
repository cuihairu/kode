import { describe, expect, it } from 'vitest';
import { resolveSelfPropertyAnnotation } from '../src/backend/selfPropertyTypeInference';
import type { PythonSelfAccess } from '../src/backend/pythonLanguageUtils';

// TYP-ARRAY:def 属性访问的类型推导与数组元素类型(2026-10-30 用户反馈
// self.equip_track_list 仍 Any;EQUIP_TRACK_LIST 是 list,取出元素应能推导元素
// 类型而不是 Any)。验收 ①-④:容器注解/元素类型/赋值延续/诚实 Any+reason。
// prove-red:元素类型推导用例(测试 2/3)在修复前无此推导面——旧 hover 只走
// 内建属性面,`for x in self.a` / `x = self.a[i]` 取不出 <of> 元素型(回普通
// hover 链,无类型显示);本文件锁住修复后行为。

// —— 注入面:def 属性定位(与 entityMappingManager.resolvePropertyDefinitionInfo 同形)
const DEF_PROPERTIES: Record<string, { typeName: string | null; line: number; defFile: string }> = {
  equip_track_list: { typeName: 'EQUIP_TRACK_LIST', line: 12, defFile: '/ws/scripts/entity_defs/Hero.def' },
  equip_track_list_empty: { typeName: 'EQUIP_TRACK_LIST_EMPTY', line: 13, defFile: '/ws/scripts/entity_defs/Hero.def' },
  cycle_attr: { typeName: 'CYCLE_TYPE', line: 14, defFile: '/ws/scripts/entity_defs/Hero.def' },
  missing_attr: { typeName: 'NO_SUCH_TYPE', line: 15, defFile: '/ws/scripts/entity_defs/Hero.def' },
  single_attr: { typeName: 'int', line: 16, defFile: '/ws/scripts/entity_defs/Hero.def' },
  no_type_attr: { typeName: null, line: 17, defFile: '/ws/scripts/entity_defs/Hero.def' },
  matrix: { typeName: 'EQUIP_TRACK_LIST_MATRIX', line: 18, defFile: '/ws/scripts/entity_defs/Hero.def' },
  funnel_list: { typeName: 'FUNNEL_LIST', line: 19, defFile: '/ws/scripts/entity_defs/Hero.def' },
  mixed_list: { typeName: 'MIXED_LIST', line: 20, defFile: '/ws/scripts/entity_defs/Hero.def' },
  empty_dict: { typeName: 'EMPTY_DICT', line: 21, defFile: '/ws/scripts/entity_defs/Hero.def' },
  string_map: { typeName: 'STRING_MAP', line: 22, defFile: '/ws/scripts/entity_defs/Hero.def' },
  nested_map: { typeName: 'NESTED_MAP', line: 23, defFile: '/ws/scripts/entity_defs/Hero.def' },
  track_dict: { typeName: 'TRACK_DICT', line: 24, defFile: '/ws/scripts/entity_defs/Hero.def' },
  py_map: { typeName: 'PY_DICT', line: 25, defFile: '/ws/scripts/entity_defs/Hero.def' }
};

const locator = async (fullPath: string, _root: string) =>
  DEF_PROPERTIES[fullPath] ?? null;

// —— 注入面:类型名 → 注解(与 definitionWorkspace.resolveEntityAnnotationTypeWithReason 同形)
const TYPES: Record<string, { annotation: string; reason: string | null }> = {
  EQUIP_TRACK_LIST: { annotation: 'FixedArray[EQUIP_INFO]', reason: null },
  EQUIP_TRACK_LIST_EMPTY: { annotation: 'FixedArray[Any]', reason: null },
  EQUIP_TRACK_LIST_MATRIX: { annotation: 'FixedArray[FixedArray[EQUIP_INFO]]', reason: null },
  CYCLE_TYPE: { annotation: 'Any', reason: '别名链成环,无法排出依赖序,整链跳过' },
  NO_SUCH_TYPE: { annotation: 'Any', reason: '类型 NO_SUCH_TYPE 未在 types.xml/alias.xml 解析到,回退 Any' },
  int: { annotation: 'int', reason: null },
  // FIXED_DICT → 注解落 TypedDict 类名本身(resolveTypeName 口径)
  FUNNEL_LIST: { annotation: 'FUNNEL_LIST', reason: null },
  MIXED_LIST: { annotation: 'MIXED_LIST', reason: null },
  EMPTY_DICT: { annotation: 'EMPTY_DICT', reason: null },
  STRING_MAP: { annotation: 'Dict[str, EQUIP_INFO]', reason: null },
  NESTED_MAP: { annotation: 'Dict[str, FixedArray[EQUIP_INFO]]', reason: null },
  TRACK_DICT: { annotation: 'TRACK_DICT', reason: null },
  PY_DICT: { annotation: 'dict', reason: null }
};

const annotate = (raw: string): { annotation: string; reason: string | null } =>
  TYPES[raw] ?? { annotation: 'Any', reason: `类型 ${raw} 未在 types.xml/alias.xml 解析到,回退 Any` };

// TYP-DICTGET 注入面:容器注解 → dict 值型(与 hover 接线 resolveEntityFixedDictMember
// 'get' 面 `${union} | None` 剥 None 尾同形);非 FIXED_DICT 名 → null(诚实)
const DICT_VALUES: Record<string, string> = {
  FUNNEL_LIST: 'FUNNEL',
  MIXED_LIST: 'FUNNEL | OTHER',
  EMPTY_DICT: 'Any',
  TRACK_DICT: 'FixedArray[EQUIP_INFO]'
};

const selfAccess = (fullPath: string): PythonSelfAccess => ({
  rootSymbol: fullPath.split('.')[0],
  currentSymbol: fullPath,
  fullPath
});

const dictValue = (annotation: string): string | null => DICT_VALUES[annotation] ?? null;

const run = (
  lines: string[],
  hoverLine: number,
  word: string,
  access: PythonSelfAccess | null,
  getDictValue?: (annotation: string) => string | null
) => resolveSelfPropertyAnnotation(lines, hoverLine, word, access, locator, annotate, getDictValue);

describe('TYP-ARRAY def 属性类型推导(容器注解,①)', () => {
  it('self.<def 属性> → 声明类型别名断到内建(容器注解)', async () => {
    const result = await run(
      ['item = self.equip_track_list[0]'],
      0,
      'equip_track_list',
      selfAccess('equip_track_list')
    );
    expect(result).not.toBeNull();
    expect(result!.annotation).toBe('FixedArray[EQUIP_INFO]');
    expect(result!.kind).toBe('def-property');
    expect(result!.propertyName).toBe('equip_track_list');
    expect(result!.defFile).toBe('/ws/scripts/entity_defs/Hero.def');
    expect(result!.defLine).toBe(12);
    expect(result!.expr).toBe('self.equip_track_list');
  });

  it('def 属性未声明 <Type> → 诚实 Any + reason(不伪造)', async () => {
    const result = await run(
      ['x = self.no_type_attr'],
      0,
      'no_type_attr',
      selfAccess('no_type_attr')
    );
    expect(result).not.toBeNull();
    expect(result!.annotation).toBe('Any');
    expect(result!.reason).toContain('未声明 <Type>');
  });
});

describe('TYP-ARRAY 元素类型推导(②,prove-red 面)', () => {
  it('for x in self.<def 属性>: → <of> 元素类型', async () => {
    const result = await run(['for item in self.equip_track_list:'], 0, 'item', null);
    expect(result).not.toBeNull();
    expect(result!.annotation).toBe('EQUIP_INFO');
    expect(result!.kind).toBe('element');
    expect(result!.expr).toBe('item');
  });

  it('x = self.<def 属性>[i] → <of> 元素类型', async () => {
    const result = await run(['first = self.equip_track_list[0]'], 0, 'first', null);
    expect(result).not.toBeNull();
    expect(result!.annotation).toBe('EQUIP_INFO');
    expect(result!.kind).toBe('element');
    expect(result!.expr).toBe('first');
  });

  it('赋值局部变量延续推导:items = self.a; first = items[0] → 元素型', async () => {
    const result = await run(
      ['items = self.equip_track_list', 'first = items[0]'],
      1,
      'first',
      null
    );
    expect(result).not.toBeNull();
    expect(result!.annotation).toBe('EQUIP_INFO');
    expect(result!.kind).toBe('element');
  });

  it('for 迭代变量延续推导:items = self.a; for item in items: → 元素型', async () => {
    const result = await run(
      ['items = self.equip_track_list', 'for item in items:'],
      1,
      'item',
      null
    );
    expect(result).not.toBeNull();
    expect(result!.annotation).toBe('EQUIP_INFO');
    expect(result!.kind).toBe('element');
  });

  it('嵌套下标 self.matrix[i][j] → 元素型的元素型(嵌套 ARRAY)', async () => {
    const result = await run(
      ['cell = self.matrix[0][0]'],
      0,
      'cell',
      null
    );
    expect(result).not.toBeNull();
    expect(result!.annotation).toBe('EQUIP_INFO');
    expect(result!.kind).toBe('element');
  });

  it('非数组下标(x = self.single_attr; y = x[0])→ 不接管,诚实 null', async () => {
    const result = await run(
      ['x = self.single_attr', 'y = x[0]'],
      1,
      'y',
      null
    );
    expect(result).toBeNull();
  });

  it('变量间接超界(a=b=c=self.a; y=c[0])→ 不接管,诚实 null(防环/长链)', async () => {
    const result = await run(
      ['a = self.equip_track_list', 'b = a', 'c = b', 'y = c[0]'],
      3,
      'y',
      null
    );
    expect(result).toBeNull();
  });
});

describe('TYP-ARRAY 诚实 Any + reason(④)', () => {
  it('空 <of>(FixedArray[Any])取元素 → Any + reason', async () => {
    const result = await run(['for item in self.equip_track_list_empty:'], 0, 'item', null);
    expect(result).not.toBeNull();
    expect(result!.annotation).toBe('Any');
    expect(result!.reason).toContain('缺 <of>');
  });

  it('别名链成环 → Any + reason(不伪造)', async () => {
    const result = await run(['x = self.cycle_attr'], 0, 'cycle_attr', selfAccess('cycle_attr'));
    expect(result).not.toBeNull();
    expect(result!.annotation).toBe('Any');
    expect(result!.reason).toContain('成环');
  });

  it('类型缺失(未注册)→ Any + reason(不伪造)', async () => {
    const result = await run(['x = self.missing_attr'], 0, 'missing_attr', selfAccess('missing_attr'));
    expect(result).not.toBeNull();
    expect(result!.annotation).toBe('Any');
    expect(result!.reason).toContain('未在 types.xml/alias.xml 解析到');
  });
});

describe('TYP-ARRAY 不接管面(能推才显)', () => {
  it('非 def 属性(self.unknown)→ null(落回普通 hover 链)', async () => {
    const result = await run(['x = self.unknown'], 0, 'unknown', selfAccess('unknown'));
    expect(result).toBeNull();
  });

  it('FIXED_DICT 子成员(self.a.field)→ 不接管(子成员面另管)', async () => {
    const result = await run(
      ['name = self.equip_track_list[0].name'],
      0,
      'name',
      null
    );
    expect(result).toBeNull();
  });

  it('普通赋值非 def 来源(x = 5)→ null(不伪造)', async () => {
    const result = await run(['x = 5'], 0, 'x', null);
    expect(result).toBeNull();
  });
});

// TYP-DICTGET(2026-11-24 用户令):def 属性 dict.get() 赋值的类型推导——
// `funnel = self.funnel_list.get(id)` → funnel 推 FUNNEL(FIXED_DICT 值并)。
// prove-red:修复前 resolveExpr 只认下标后缀形态(splitSubscripts),.get(...)
// 调用形态不认,hover 是空。
describe('TYP-DICTGET dict.get() 赋值类型推导', () => {
  it('funnel = self.funnel_list.get(id) → funnel 推 FUNNEL(FIXED_DICT 值并)', async () => {
    const result = await run(['funnel = self.funnel_list.get(id)'], 0, 'funnel', null, dictValue);
    expect(result).not.toBeNull();
    expect(result!.annotation).toBe('FUNNEL');
    expect(result!.kind).toBe('element');
    expect(result!.expr).toBe('funnel');
    expect(result!.propertyName).toBe('funnel_list');
    expect(result!.defFile).toBe('/ws/scripts/entity_defs/Hero.def');
    expect(result!.defLine).toBe(19);
    // 诚实面:get 键可能不存在,值可能 None
    expect(result!.reason).toContain('None');
  });

  it('Dict[K, V] 文本形态 → 取 V', async () => {
    const result = await run(['info = self.string_map.get("k")'], 0, 'info', null, dictValue);
    expect(result).not.toBeNull();
    expect(result!.annotation).toBe('EQUIP_INFO');
    expect(result!.kind).toBe('element');
  });

  it('Dict[K, V] 嵌套值型(顶层逗号不误切)→ 取 V 整体', async () => {
    const result = await run(['tracks = self.nested_map.get("k")'], 0, 'tracks', null, dictValue);
    expect(result).not.toBeNull();
    expect(result!.annotation).toBe('FixedArray[EQUIP_INFO]');
  });

  it('组合形态 self.a.get(k)[0] → 值型再剥下标(与既有下标循环按序组合)', async () => {
    const result = await run(['first = self.track_dict.get(k)[0]'], 0, 'first', null, dictValue);
    expect(result).not.toBeNull();
    expect(result!.annotation).toBe('EQUIP_INFO');
    expect(result!.kind).toBe('element');
  });

  it('变量间接延续:items = self.funnel_list; funnel = items.get(id) → FUNNEL', async () => {
    const result = await run(
      ['items = self.funnel_list', 'funnel = items.get(id)'],
      1,
      'funnel',
      null,
      dictValue
    );
    expect(result).not.toBeNull();
    expect(result!.annotation).toBe('FUNNEL');
  });

  it('异构字段值并(FUNNEL | OTHER)→ 推并集不猜单型', async () => {
    const result = await run(['v = self.mixed_list.get(id)'], 0, 'v', null, dictValue);
    expect(result).not.toBeNull();
    expect(result!.annotation).toBe('FUNNEL | OTHER');
  });

  it('FIXED_DICT 无字段声明(值并 Any)→ Any + reason 诚实', async () => {
    const result = await run(['v = self.empty_dict.get(id)'], 0, 'v', null, dictValue);
    expect(result).not.toBeNull();
    expect(result!.annotation).toBe('Any');
    expect(result!.reason).toContain('None');
  });

  it('PY_DICT 负向(内建 dict 无键值声明)→ 诚实 null 不猜', async () => {
    const result = await run(['v = self.py_map.get(id)'], 0, 'v', null, dictValue);
    expect(result).toBeNull();
  });

  it('容器类型缺失(注解 Any)→ 诚实 null(不猜)', async () => {
    const result = await run(['v = self.missing_attr.get(id)'], 0, 'v', null, dictValue);
    expect(result).toBeNull();
  });

  it('注入缺失(不传 dictValue)→ .get 形态不接管,诚实 null', async () => {
    const result = await run(['funnel = self.funnel_list.get(id)'], 0, 'funnel', null);
    expect(result).toBeNull();
  });

  it('.get 非尾随调用(x = self.funnel_list.get)→ 不剥,诚实 null', async () => {
    const result = await run(['x = self.funnel_list.get'], 0, 'x', null, dictValue);
    expect(result).toBeNull();
  });

  it('.get 后接成员(x = self.funnel_list.get(k).name)→ 不接管(子成员面另管)', async () => {
    const result = await run(['x = self.funnel_list.get(k).name'], 0, 'x', null, dictValue);
    expect(result).toBeNull();
  });
});
