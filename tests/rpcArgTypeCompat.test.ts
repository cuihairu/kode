import { describe, expect, it } from 'vitest';

import {
  RPC_ARG_TYPE_DIAGNOSTIC_CODE,
  RPC_ARG_TYPE_DIAGNOSTICS_ENABLED_DEFAULT,
  computeRpcArgTypeCompatFindings,
  inferArgumentLiteralKind,
  resolveDeclaredArgTypes
} from '../src/backend/rpcArgTypeCompat';
import type { EntityMapping } from '../src/entityMapping';

// RUST-176/KBE-PY-009b:RPC 参数序列化类型兼容 lint。调用点字面量实参 ×
// 调用所属 section 声明的 <Arg> 内建类型族对账(整数族静默打 0、FLOAT/
// STRING 族 return 不写流、BLOB 无检强转、VECTOR 序列协议逐分量——引擎锚
// 见核心头注);字面量推不出/非内建类型/声明未就绪保留未知一律不报,数量
// 不符归 rpcArgCount(KBE-PY-009)不重复。

const mappingWithMethods = (
  methods: Record<string, Array<{ section: string; declaredArgs?: string[] }>>
): EntityMapping => ({
  methods: Object.fromEntries(
    Object.entries(methods).map(([name, defs]) => [
      name,
      defs.map(def => ({
        defFile: 'avatar.def',
        line: 10,
        section: def.section,
        exposed: false,
        declaredArgs: def.declaredArgs,
        identity: {
          ownerKind: 'method' as never,
          ownerName: 'Avatar',
          sourceKind: 'def' as never,
          sourceChain: [],
          symbolName: name
        }
      }))
    ])
  )
}) as unknown as EntityMapping;

describe('inferArgumentLiteralKind(字面量形态判定)', () => {
  it('整数形态:十进制/正负号/下划线/0x 0o 0b 前缀', () => {
    expect(inferArgumentLiteralKind('42')).toBe('int');
    expect(inferArgumentLiteralKind('-7')).toBe('int');
    expect(inferArgumentLiteralKind('+3')).toBe('int');
    expect(inferArgumentLiteralKind('1_000')).toBe('int');
    expect(inferArgumentLiteralKind('0x1F')).toBe('int');
    expect(inferArgumentLiteralKind('0b101')).toBe('int');
    expect(inferArgumentLiteralKind('0o17')).toBe('int');
  });

  it('浮点形态:1.5 / 1. / .5 / 1e3 / 1.5e-3,含正负号', () => {
    expect(inferArgumentLiteralKind('1.5')).toBe('float');
    expect(inferArgumentLiteralKind('1.')).toBe('float');
    expect(inferArgumentLiteralKind('.5')).toBe('float');
    expect(inferArgumentLiteralKind('-2.5e3')).toBe('float');
    expect(inferArgumentLiteralKind('1e10')).toBe('float');
    expect(inferArgumentLiteralKind('+.5')).toBe('float');
  });

  it('bool/None', () => {
    expect(inferArgumentLiteralKind('True')).toBe('bool');
    expect(inferArgumentLiteralKind('False')).toBe('bool');
    expect(inferArgumentLiteralKind('None')).toBe('none');
  });

  it('字符串/bytes:前缀 r/b/u/f 组合 + 首尾同引号;f-string 归 str', () => {
    expect(inferArgumentLiteralKind("'x'")).toBe('str');
    expect(inferArgumentLiteralKind('"abc"')).toBe('str');
    expect(inferArgumentLiteralKind("u'x'")).toBe('str');
    expect(inferArgumentLiteralKind("f'{a}'")).toBe('str');
    expect(inferArgumentLiteralKind("b'x'")).toBe('bytes');
    expect(inferArgumentLiteralKind("B'x'")).toBe('bytes');
    expect(inferArgumentLiteralKind("rb'x'")).toBe('bytes');
    expect(inferArgumentLiteralKind('"""triple"""')).toBe('str');
  });

  it('容器:[]list、{:}dict、{}空 dict、{,}set、顶层逗号元组;纯括号表达式不猜', () => {
    expect(inferArgumentLiteralKind('[1, 2]')).toBe('list');
    expect(inferArgumentLiteralKind('[]')).toBe('list');
    expect(inferArgumentLiteralKind('{1: 2}')).toBe('dict');
    expect(inferArgumentLiteralKind('{}')).toBe('dict');
    expect(inferArgumentLiteralKind('{1, 2}')).toBe('set');
    expect(inferArgumentLiteralKind("{'a': {1: 2}}")).toBe('dict');
    expect(inferArgumentLiteralKind('{(1, 2)}')).toBe('set');
    expect(inferArgumentLiteralKind('(1, 2)')).toBe('tuple');
    expect(inferArgumentLiteralKind('(1,)')).toBe('tuple');
    expect(inferArgumentLiteralKind('(1)')).toBeNull();
    expect(inferArgumentLiteralKind('(x)')).toBeNull();
  });

  it('Vector 构造调用:Vector2/3/4 与 KBEngine. 前缀;前缀外不认', () => {
    expect(inferArgumentLiteralKind('Vector3(1, 2, 3)')).toBe('vector3');
    expect(inferArgumentLiteralKind('Vector3()')).toBe('vector3');
    expect(inferArgumentLiteralKind('KBEngine.Vector3()')).toBe('vector3');
    expect(inferArgumentLiteralKind('Vector2(1, 2)')).toBe('vector2');
    expect(inferArgumentLiteralKind('Vector4(1, 2, 3, 4)')).toBe('vector4');
    expect(inferArgumentLiteralKind('SomeVector3(1)')).toBeNull();
    expect(inferArgumentLiteralKind('makeVector3()')).toBeNull();
  });

  it('推不出的形态一律 null(诚实未知):名字/调用/星号/表达式/空', () => {
    expect(inferArgumentLiteralKind('hp')).toBeNull();
    expect(inferArgumentLiteralKind('self.hp')).toBeNull();
    expect(inferArgumentLiteralKind('foo(1)')).toBeNull();
    expect(inferArgumentLiteralKind('*args')).toBeNull();
    expect(inferArgumentLiteralKind('x + 1')).toBeNull();
    expect(inferArgumentLiteralKind('')).toBeNull();
  });
});

describe('resolveDeclaredArgTypes(声明侧逐槽类型)', () => {
  const decl = (section: string, declaredArgs?: string[]) => ({ section, declaredArgs });

  it('同 section 单来源 → 类型序列;无匹配 section → null', () => {
    expect(resolveDeclaredArgTypes([decl('CellMethods', ['INT32'])], 'CellMethods')).toEqual(['INT32']);
    expect(resolveDeclaredArgTypes([decl('BaseMethods', ['INT32'])], 'CellMethods')).toBeNull();
  });

  it('声明未就绪(undefined/空数组)与星号形参 → null', () => {
    expect(resolveDeclaredArgTypes([decl('CellMethods')], 'CellMethods')).toBeNull();
    expect(resolveDeclaredArgTypes([decl('CellMethods', [])], 'CellMethods')).toBeNull();
    expect(resolveDeclaredArgTypes([decl('CellMethods', ['*args'])], 'CellMethods')).toBeNull();
  });

  it('多来源一致 → 序列;不一致 → null(歧义不猜)', () => {
    expect(resolveDeclaredArgTypes(
      [decl('CellMethods', ['INT32', 'STRING']), decl('CellMethods', ['INT32', 'STRING'])],
      'CellMethods'
    )).toEqual(['INT32', 'STRING']);
    expect(resolveDeclaredArgTypes(
      [decl('CellMethods', ['INT32']), decl('CellMethods', ['STRING'])],
      'CellMethods'
    )).toBeNull();
  });
});

describe('computeRpcArgTypeCompatFindings(端到端对账)', () => {
  it('code 与开关缺省常量', () => {
    expect(RPC_ARG_TYPE_DIAGNOSTIC_CODE).toBe('kbengine.rpcArgType');
    expect(RPC_ARG_TYPE_DIAGNOSTICS_ENABLED_DEFAULT).toBe(true);
  });

  it('INT32 声明 + 字符串字面量 → 整数族 mismatch(静默打 0 语义 + 锚)', () => {
    const text = 'self.cell.hit("abc")';
    const findings = computeRpcArgTypeCompatFindings(
      text,
      mappingWithMethods({ hit: [{ section: 'CellMethods', declaredArgs: ['INT32'] }] })
    );
    expect(findings).toHaveLength(1);
    const finding = findings[0];
    expect(finding.methodName).toBe('hit');
    expect(finding.receiver).toBe('cell');
    expect(finding.section).toBe('CellMethods');
    expect(finding.argIndex).toBe(1);
    expect(finding.declaredType).toBe('INT32');
    expect(finding.inferredKind).toBe('str');
    expect(finding.character).toBe(text.indexOf('"abc"'));
    expect(finding.length).toBe('"abc"'.length);
    expect(finding.message).toContain('packs 0');
    expect(finding.message).toContain('datatype.h:875-898');
  });

  it('整数族兼容形态不报:int 与 bool 是 PyLong 合法;十六进制同', () => {
    const mapping = mappingWithMethods({ hit: [{ section: 'CellMethods', declaredArgs: ['INT32'] }] });
    expect(computeRpcArgTypeCompatFindings('self.cell.hit(42)', mapping)).toEqual([]);
    expect(computeRpcArgTypeCompatFindings('self.cell.hit(True)', mapping)).toEqual([]);
    expect(computeRpcArgTypeCompatFindings('self.cell.hit(0x1F)', mapping)).toEqual([]);
  });

  it('UINT32 + float → mismatch;锚 uint32 专类', () => {
    const findings = computeRpcArgTypeCompatFindings(
      'self.cell.hit(1.5)',
      mappingWithMethods({ hit: [{ section: 'CellMethods', declaredArgs: ['UINT32'] }] })
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain('packs 0');
    expect(findings[0].message).toContain('datatype.cpp:324-341');
  });

  it('FLOAT + int → mismatch(return 不写流语义);FLOAT + float 不报', () => {
    const mapping = mappingWithMethods({ jump: [{ section: 'BaseMethods', declaredArgs: ['FLOAT'] }] });
    const findings = computeRpcArgTypeCompatFindings('self.base.jump(10)', mapping);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain('leaves this argument out of the stream');
    expect(findings[0].message).toContain('datatype.cpp:540-549');
    expect(computeRpcArgTypeCompatFindings('self.base.jump(1.5)', mapping)).toEqual([]);
  });

  it('STRING + bytes → mismatch(引擎 bytes 同样失败);UNICODE + str 不报', () => {
    const stringFindings = computeRpcArgTypeCompatFindings(
      'self.base.jump(b"x")',
      mappingWithMethods({ jump: [{ section: 'BaseMethods', declaredArgs: ['STRING'] }] })
    );
    expect(stringFindings).toHaveLength(1);
    expect(stringFindings[0].message).toContain('datatype.cpp:1050-1062');
    const unicodeMapping = mappingWithMethods({ jump: [{ section: 'BaseMethods', declaredArgs: ['UNICODE'] }] });
    expect(computeRpcArgTypeCompatFindings('self.base.jump("x")', unicodeMapping)).toEqual([]);
    expect(computeRpcArgTypeCompatFindings('self.base.jump("x")', mappingWithMethods({ jump: [{ section: 'BaseMethods', declaredArgs: ['STRING'] }] }))).toEqual([]);
  });

  it('BLOB:bytes 不报;str → 无检强转面 mismatch', () => {
    const blob = mappingWithMethods({ send: [{ section: 'CellMethods', declaredArgs: ['BLOB'] }] });
    expect(computeRpcArgTypeCompatFindings('self.cell.send(b"raw")', blob)).toEqual([]);
    const findings = computeRpcArgTypeCompatFindings("self.cell.send('text')", blob);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain('BLOB shape');
    expect(findings[0].message).toContain('datatype.cpp:1448-1468');
  });

  it('VECTOR3:str → 序列协议失败 mismatch;Vector3() 构造不报;list/tuple 结构上存疑留未知', () => {
    const vector = mappingWithMethods({ land: [{ section: 'CellMethods', declaredArgs: ['VECTOR3'] }] });
    const findings = computeRpcArgTypeCompatFindings('self.cell.land("abc")', vector);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain('sequence protocol');
    expect(findings[0].message).toContain('datatype.cpp:841-856');
    expect(computeRpcArgTypeCompatFindings('self.cell.land(Vector3(1, 2, 3))', vector)).toEqual([]);
    expect(computeRpcArgTypeCompatFindings('self.cell.land(KBEngine.Vector3())', vector)).toEqual([]);
    expect(computeRpcArgTypeCompatFindings('self.cell.land((1, 2, 3))', vector)).toEqual([]);
    expect(computeRpcArgTypeCompatFindings('self.cell.land([1, 2, 3])', vector)).toEqual([]);
  });

  it('不声称族:PYTHON/PY_DICT/PY_LIST/ENTITYCALL 与非内建类型一律零声称', () => {
    const anyMapping = mappingWithMethods({ push: [{ section: 'CellMethods', declaredArgs: ['PYTHON'] }] });
    expect(computeRpcArgTypeCompatFindings('self.cell.push([1])', anyMapping)).toEqual([]);
    expect(computeRpcArgTypeCompatFindings('self.cell.push("x")', anyMapping)).toEqual([]);
    expect(computeRpcArgTypeCompatFindings('self.cell.push(7)', anyMapping)).toEqual([]);
    const pickleMapping = mappingWithMethods({ push: [{ section: 'CellMethods', declaredArgs: ['PY_DICT'] }] });
    expect(computeRpcArgTypeCompatFindings('self.cell.push(7)', pickleMapping)).toEqual([]);
    const callMapping = mappingWithMethods({ peer: [{ section: 'CellMethods', declaredArgs: ['ENTITYCALL'] }] });
    expect(computeRpcArgTypeCompatFindings('self.cell.peer(7)', callMapping)).toEqual([]);
    const aliasMapping = mappingWithMethods({ hit: [{ section: 'CellMethods', declaredArgs: ['HP_MAX'] }] });
    expect(computeRpcArgTypeCompatFindings("self.cell.hit('x')", aliasMapping)).toEqual([]);
    const arrayMapping = mappingWithMethods({ bag: [{ section: 'CellMethods', declaredArgs: ['ARRAY'] }] });
    expect(computeRpcArgTypeCompatFindings('self.cell.bag([1])', arrayMapping)).toEqual([]);
  });

  it('分面:声明按调用所属 section 过滤;跨面声明不裁;cell 面命中', () => {
    const baseOnly = mappingWithMethods({ hit: [{ section: 'BaseMethods', declaredArgs: ['INT32'] }] });
    expect(computeRpcArgTypeCompatFindings("self.client.hit('x')", baseOnly)).toEqual([]);
    const cellMapping = mappingWithMethods({ hit: [{ section: 'CellMethods', declaredArgs: ['INT32'] }] });
    const cellFindings = computeRpcArgTypeCompatFindings("self.cell.hit('x')", cellMapping);
    expect(cellFindings).toHaveLength(1);
    expect(cellFindings[0].section).toBe('CellMethods');
  });

  it('声明未就绪/无映射 → 零发现', () => {
    expect(computeRpcArgTypeCompatFindings(
      "self.cell.hit('x')",
      mappingWithMethods({})
    )).toEqual([]);
    expect(computeRpcArgTypeCompatFindings(
      "self.cell.hit('x')",
      mappingWithMethods({ hit: [{ section: 'CellMethods' }] })
    )).toEqual([]);
    expect(computeRpcArgTypeCompatFindings("self.cell.hit('x')")).toEqual([]);
  });

  it('第二槽位锚定:character/length 落实参段,argIndex 2', () => {
    const text = 'self.cell.hit("a", 2)';
    const findings = computeRpcArgTypeCompatFindings(
      text,
      mappingWithMethods({ hit: [{ section: 'CellMethods', declaredArgs: ['STRING', 'FLOAT'] }] })
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].argIndex).toBe(2);
    expect(findings[0].character).toBe(text.indexOf('2'));
    expect(findings[0].declaredType).toBe('FLOAT');
    expect(findings[0].message).toContain('leaves this argument out of the stream');
  });

  it('槽位文本面走原文:字符串内逗号不当分隔(引号内逗号不影响切分)', () => {
    const text = 'self.cell.hit("x,y", 3)';
    const findings = computeRpcArgTypeCompatFindings(
      text,
      mappingWithMethods({ hit: [{ section: 'CellMethods', declaredArgs: ['STRING', 'FLOAT'] }] })
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].argIndex).toBe(2);
    expect(findings[0].character).toBe(text.indexOf('3'));
  });

  it('发现面走掩码:字符串/注释里的伪调用不产出发现', () => {
    const text = 's = "self.cell.hit(42)"\nt = 1  # self.cell.hit("x")';
    expect(computeRpcArgTypeCompatFindings(
      text,
      mappingWithMethods({ hit: [{ section: 'CellMethods', declaredArgs: ['INT32'] }] })
    )).toEqual([]);
  });

  it('跨行调用/星号实参/f-string 均按诚实口径:f-string 归 str 报 str mismatch', () => {
    const intMapping = mappingWithMethods({ hit: [{ section: 'CellMethods', declaredArgs: ['INT32'] }] });
    expect(computeRpcArgTypeCompatFindings('self.cell.hit(\n  "abc"\n)', intMapping)).toEqual([]);
    expect(computeRpcArgTypeCompatFindings('self.cell.hit(*vals)', intMapping)).toEqual([]);
    const findings = computeRpcArgTypeCompatFindings('self.cell.hit(f"{x}")', intMapping);
    expect(findings).toHaveLength(1);
    expect(findings[0].inferredKind).toBe('str');
    expect(findings[0].message).toContain('packs 0');
  });

  it('多来源一致仍报;歧义不报;无参数声明(0 槽)不归本面', () => {
    const agree = mappingWithMethods({
      hit: [
        { section: 'CellMethods', declaredArgs: ['INT32'] },
        { section: 'CellMethods', declaredArgs: ['INT32'] }
      ]
    });
    expect(computeRpcArgTypeCompatFindings("self.cell.hit('x')", agree)).toHaveLength(1);
    const disagree = mappingWithMethods({
      hit: [
        { section: 'CellMethods', declaredArgs: ['INT32'] },
        { section: 'CellMethods', declaredArgs: ['STRING'] }
      ]
    });
    expect(computeRpcArgTypeCompatFindings("self.cell.hit('x')", disagree)).toEqual([]);
    const noArgs = mappingWithMethods({ ping: [{ section: 'CellMethods', declaredArgs: [] }] });
    expect(computeRpcArgTypeCompatFindings('self.cell.ping()', noArgs)).toEqual([]);
  });

  it('数量不符归 rpcArgCount 不重复:超声明槽位的类型面不声称', () => {
    // 声明 1 槽 UINT32,实传 2 参(int, int):数量面报 2≠1,类型面两槽都放行
    const mapping = mappingWithMethods({ move: [{ section: 'CellMethods', declaredArgs: ['UINT32'] }] });
    expect(computeRpcArgTypeCompatFindings('self.cell.move(1, 2)', mapping)).toEqual([]);
  });

  it('float 负数字面量 + 整数族 → mismatch;负整数放行', () => {
    const intMapping = mappingWithMethods({ hit: [{ section: 'CellMethods', declaredArgs: ['INT32'] }] });
    expect(computeRpcArgTypeCompatFindings('self.cell.hit(-3)', intMapping)).toEqual([]);
    expect(computeRpcArgTypeCompatFindings('self.cell.hit(-1.5)', intMapping)).toHaveLength(1);
  });
});
