// fixedDictSubscript 残余缺口臂(逐行定性,非补测刷分):
// - 行内探测的容差/健壮性形态:引号内转义、`[`/`(` 后空白、闭引号后尾随、
//   下标/`.get(` 表达式段的字符串扫描与括号配平(诚实断链面);
// - wire 链状态(KSEM-SER-04):嵌套 FD 字段 / 数组字段两态 / 标量注解不产状态;
// - 别名 RHS 下标链的退化臂(KSEM-STRUCT-03):base 杂质/注解 Any/元素 Any/
//   FD 上切片——全部诚实落空,不猜。
import { describe, expect, it } from 'vitest';
import {
  fixedDictChainRootType,
  fixedDictSubscriptContextAt,
  resolveWireDictSubscriptKeyFromContainer,
  type FixedDictChainSegment
} from '../src/backend/fixedDictSubscript';
import type {
  CustomTypeInfo,
  CustomTypePropertyInfo,
  CustomTypeStructureChild,
  CustomTypeStructureNode
} from '../src/definitionWorkspace';

// ---------------------------------------------------------------------------
// 内联注册表夹具(镜像 types.xml 高保真形状)
// ---------------------------------------------------------------------------

const TYPES_FILE = '/entity_defs/types.xml';

function node(name: string, line: number, children: CustomTypeStructureChild[] = []): CustomTypeStructureNode {
  return { name, rawValue: name, children, line };
}

function scalarField(name: string, typeName: string, line: number): CustomTypePropertyInfo {
  return { name, typeName, line };
}

function inlineArrayField(name: string, element: string, line: number): CustomTypePropertyInfo {
  return {
    name,
    typeName: 'ARRAY',
    typeStructure: node('ARRAY', line, [{ tag: 'of', value: node(element, line) }]),
    line
  };
}

function customType(
  name: string,
  aliasType: string,
  properties: CustomTypePropertyInfo[],
  line: number
): CustomTypeInfo {
  return {
    name,
    filePath: TYPES_FILE,
    line,
    implementedByLine: line,
    startOffset: 0,
    endOffset: 0,
    aliasType,
    rawValue: '',
    structure: node(aliasType, line),
    properties
  };
}

const POSITION = customType('POSITION', 'FIXED_DICT', [
  scalarField('x', 'FLOAT', 12),
  scalarField('y', 'FLOAT', 14)
], 10);

const HOST = customType('HOST', 'FIXED_DICT', [
  scalarField('pos', 'POSITION', 31),
  scalarField('label', 'STRING', 33)
], 30);

const BAG_OF = customType('BAG_OF', 'FIXED_DICT', [
  inlineArrayField('bags', 'POSITION', 41),
  scalarField('uid', 'UINT32', 43)
], 40);

const REGISTRY: CustomTypeInfo[] = [POSITION, HOST, BAG_OF];

const keySeg = (key: string): FixedDictChainSegment => ({
  kind: 'key', key, keyStart: -1, keyEnd: 0, form: 'subscript'
});
const indexSeg: FixedDictChainSegment = { kind: 'index', form: 'subscript' };

/** 键串内容中列(引号内首字符列)。 */
const keyCol = (line: string, key: string): number => line.indexOf(`"${key}"`) + 1;

// ---------------------------------------------------------------------------
// 行内探测:容差/健壮性形态
// ---------------------------------------------------------------------------

describe('fixedDictSubscriptContextAt 健壮性臂', async () => {
  it('光标越界(负列/超行尾):不接管', async () => {
    const line = 'v = self.pos["x"]';
    expect(fixedDictSubscriptContextAt(line, -1)).toBeNull();
    expect(fixedDictSubscriptContextAt(line, line.length + 5)).toBeNull();
  });

  it('转义闭串后的行内注释位:注释态照判', async () => {
    // 源码级 `"a\\"`(闭串,内含转义反斜杠):注释态扫描必须跳过转义位,
    // 否则闭引号被误吞、`#` 落进"字符串"里 → 注释判定失真
    const line = 'v = self.pos["a\\\\"] # note';
    expect(fixedDictSubscriptContextAt(line, line.indexOf('#'))).toBeNull();
  });

  it('下标内字符串字面量:表达式段照扫,索引段断链', async () => {
    // `d["k"]` 是表达式下标:内容里的字符串由 skipStringLiteral 扫过,
    // 整段归 index(静态不可知)→ 断链不接管
    expect(fixedDictSubscriptContextAt('v = self.pos[d["k"]]', 0)).toBeNull();
  });

  it('下标内字符串含转义引号:跳过转义位不误判闭串', async () => {
    expect(fixedDictSubscriptContextAt('v = self.pos[d["a\\\\"]]', 0)).toBeNull();
  });

  it('下标内字符串未闭:诚实断链', async () => {
    expect(fixedDictSubscriptContextAt('v = self.pos[d["k]]', 0)).toBeNull();
  });

  it('`[` 后空白:跳过空白仍收键位', async () => {
    const line = 'v = self.pos[ "x"]';
    const context = fixedDictSubscriptContextAt(line, keyCol(line, 'x'));
    expect(context).not.toBeNull();
    expect(context!.receiver).toBe('self.pos');
    expect(context!.cursor).toBe('key');
    expect(context!.segments[0]).toMatchObject({ kind: 'key', key: 'x', form: 'subscript' });
  });

  it('闭引号后空白:跳过空白仍配 `]`', async () => {
    const line = 'v = self.pos["x" ]';
    const context = fixedDictSubscriptContextAt(line, keyCol(line, 'x'));
    expect(context).not.toBeNull();
    expect(context!.cursor).toBe('key');
  });

  it('闭引号后尾随非 `]`:不收(条件表达式键不猜)', async () => {
    const line = 'v = self.pos["x" if flag else "y"]';
    expect(fixedDictSubscriptContextAt(line, keyCol(line, 'x'))).toBeNull();
  });

  it('下标内嵌套 `[`:深度计数不错位断链', async () => {
    // `grid[i][j]` 嵌套括号:深度归零前不得提前闭合
    expect(fixedDictSubscriptContextAt('v = self.pos[grid[i][j]]', 0)).toBeNull();
  });

  it('`.get(` 后空白:跳过空白仍收键位', async () => {
    const line = 'v = self.talents.get( "x")';
    const context = fixedDictSubscriptContextAt(line, keyCol(line, 'x'));
    expect(context).not.toBeNull();
    expect(context!.cursor).toBe('key');
    expect(context!.segments[0]).toMatchObject({ kind: 'key', key: 'x', form: 'get' });
  });

  it('`.get(` 闭引号后空白:跳过空白仍配 `)`', async () => {
    const line = 'v = self.talents.get("x" )';
    const context = fixedDictSubscriptContextAt(line, keyCol(line, 'x'));
    expect(context).not.toBeNull();
    expect(context!.cursor).toBe('key');
    expect(context!.segments[0]).toMatchObject({ kind: 'key', key: 'x', form: 'get' });
  });

  it('`.get(` 闭引号行尾未闭括号:按闭段收,链止于行尾', async () => {
    const line = 'v = self.talents.get("x"';
    const context = fixedDictSubscriptContextAt(line, keyCol(line, 'x'));
    expect(context).not.toBeNull();
    expect(context!.segments).toHaveLength(1);
    expect(context!.segments[0]).toMatchObject({ kind: 'key', key: 'x', form: 'get' });
  });

  it('`.get(` 闭引号后尾随非 `)`:不收', async () => {
    const line = 'v = self.talents.get("x" if c else "y")';
    expect(fixedDictSubscriptContextAt(line, keyCol(line, 'x'))).toBeNull();
  });

  it('`.get(裸名`:键静态不可知 → 索引段断链', async () => {
    expect(fixedDictSubscriptContextAt('v = self.talents.get(other)', 0)).toBeNull();
  });

  it('`.get(嵌套调用`:括号深度配平', async () => {
    expect(fixedDictSubscriptContextAt('v = self.talents.get(inner(x))', 0)).toBeNull();
  });

  it('`.get(` 表达式内字符串字面量:照扫不误配 `)`', async () => {
    expect(fixedDictSubscriptContextAt('v = self.talents.get(d["k"])', 0)).toBeNull();
  });

  it('`.get(` 表达式内字符串未闭:诚实断链', async () => {
    expect(fixedDictSubscriptContextAt('v = self.talents.get(d["k', 0)).toBeNull();
  });

  it('`.get(括号未闭行尾`:诚实断链', async () => {
    expect(fixedDictSubscriptContextAt('v = self.talents.get(other', 0)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// wire 链状态面(KSEM-SER-04):不设 implementedBy 门的传输字典形态
// ---------------------------------------------------------------------------

describe('wire 链状态', async () => {
  it('嵌套 FD 字段:prefix 步进后末键落位', async () => {
    const hit = resolveWireDictSubscriptKeyFromContainer(HOST, [keySeg('pos')], 'x', REGISTRY);
    expect(hit).not.toBeNull();
    expect(hit!.container.name).toBe('POSITION');
    expect(hit!.field?.name).toBe('x');
  });

  it('数组字段:字符串键断链;整数下标进元素 FD', async () => {
    // 数组上的字符串键是引擎不支持的访问(引擎 Map 键是串、数组下标是整数)
    expect(resolveWireDictSubscriptKeyFromContainer(BAG_OF, [keySeg('bags')], 'x', REGISTRY))
      .toBeNull();
    // 整数下标剥一层 → 元素 FD,末键落位
    const hit = resolveWireDictSubscriptKeyFromContainer(
      BAG_OF, [keySeg('bags'), indexSeg], 'x', REGISTRY
    );
    expect(hit).not.toBeNull();
    expect(hit!.container.name).toBe('POSITION');
    expect(hit!.field?.name).toBe('x');
  });

  it('标量字段注解:不产链状态,prefix 断链', async () => {
    expect(resolveWireDictSubscriptKeyFromContainer(HOST, [keySeg('label')], 'x', REGISTRY))
      .toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 别名 RHS 下标链退化臂(KSEM-STRUCT-03):非简单链一律诚实落空
// ---------------------------------------------------------------------------

const selfResolverOf = (
  mappings: Record<string, string | null>
): (propertyName: string) => Promise<string | null> =>
  async propertyName => mappings[propertyName] ?? null;

describe('别名 RHS 下标链退化臂', async () => {
  it('`self.` 属性名非法:不追', async () => {
    expect(await fixedDictChainRootType('self.x.y', [], 0, selfResolverOf({}), REGISTRY)).toBeNull();
  });

  it('base 含字符串字面量:非简单链不追', async () => {
    expect(await fixedDictChainRootType('x', ['x = "a"[0]'], 1, selfResolverOf({}), REGISTRY)).toBeNull();
  });

  it('base 字符串内转义:同断', async () => {
    expect(await fixedDictChainRootType('x', ['x = "a\\\\b"[0]'], 1, selfResolverOf({}), REGISTRY))
      .toBeNull();
  });

  it('空下标内容 `bags[]`:断链', async () => {
    expect(await fixedDictChainRootType('x', ['x = bags[]'], 1, selfResolverOf({}), REGISTRY)).toBeNull();
  });

  it('键串内转义引号:配平与分类不串位,字符串键断链', async () => {
    expect(await fixedDictChainRootType('x', ['x = bags["a\\\\b"][0]'], 1, selfResolverOf({}), REGISTRY))
      .toBeNull();
  });

  it('baseSelf 属性解析不到:不追', async () => {
    expect(await fixedDictChainRootType('x', ['x = self.bag[0]'], 1, selfResolverOf({}), REGISTRY))
      .toBeNull();
  });

  it('裸名 base 无绑定:不追', async () => {
    expect(await fixedDictChainRootType('x', ['x = y[0]'], 1, selfResolverOf({}), REGISTRY)).toBeNull();
  });

  it('baseSelf 注解 Any:断链', async () => {
    expect(
      await fixedDictChainRootType('x', ['x = self.bag[0]'], 1, selfResolverOf({ bag: 'Any' }), REGISTRY)
    ).toBeNull();
  });

  it('数组元素 Any:取元素断链,后续段不追', async () => {
    // 元素型 Any 的注解须经「裸名绑定 → annotateRootText 原文直通」进入原子
    // 循环(baseSelf 路径过 resolveAnnotationTypeWithReason 会先落 Any 退出),
    // 取元素得 Any → 断链,第二段撞 !current 守卫
    expect(
      await fixedDictChainRootType(
        'x',
        ['bag = self.items', 'x = bag[0][0]'],
        2,
        selfResolverOf({ items: 'FixedArray[Any]' }),
        REGISTRY
      )
    ).toBeNull();
  });

  it('FD 上切片:非数组不保留原形,断链', async () => {
    expect(
      await fixedDictChainRootType('x', ['x = self.bag[1:]'], 1, selfResolverOf({ bag: 'POSITION' }), REGISTRY)
    ).toBeNull();
  });
});