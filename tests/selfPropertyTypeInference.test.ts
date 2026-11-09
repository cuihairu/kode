import { describe, expect, it } from 'vitest';
import { resolveSelfPropertyAnnotation } from '../src/selfPropertyTypeInference';
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
  matrix: { typeName: 'EQUIP_TRACK_LIST_MATRIX', line: 18, defFile: '/ws/scripts/entity_defs/Hero.def' }
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
  int: { annotation: 'int', reason: null }
};

const annotate = (raw: string): { annotation: string; reason: string | null } =>
  TYPES[raw] ?? { annotation: 'Any', reason: `类型 ${raw} 未在 types.xml/alias.xml 解析到,回退 Any` };

const selfAccess = (fullPath: string): PythonSelfAccess => ({
  rootSymbol: fullPath.split('.')[0],
  currentSymbol: fullPath,
  fullPath
});

const run = (lines: string[], hoverLine: number, word: string, access: PythonSelfAccess | null) =>
  resolveSelfPropertyAnnotation(lines, hoverLine, word, access, locator, annotate);

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
