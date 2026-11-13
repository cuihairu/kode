/**
 * KSEM-SER-07:isSameType 契约边界面(纯核心)。
 *
 * 引擎真源:impl 判定经 PyObject_CallFunction(pyIsSameType, "(O)", obj)
 * ——self 之外恰好一个形参,不符恒 TypeError(arity 面,Warning);判真
 * = 指针恒等只认 True(:2458),impl True 短路免检、False 恒被无视回落
 * 内建校验(:2497-2512);impl_createObjFromDict 后置校验(:2421)。
 *
 * 面与锚:arity 锚 def 行方法名;证明状态面锚返回 token 内容列
 * (raw 取位,掩码核验,优先级聚合 acceptAll > pending > fallback,每
 * 方法至多一条)。isinstance(obj, X) 全元素可解析(内建类型名/本文件
 * 类名)→ 该位已证明零产出;任一元素不可解析 → pending 锚该元素。
 * 嵌套 def 域跳过;注释/字符串位不判。
 *
 * 夹具镜像 SER-04/05/06 同构(implBindingsForDocument +
 * resolveImplMethodInputs 双面绑定)。真值字面量(True/False/None/
 * isinstance/契约方法名)经 chr 码构造,杜绝转录漂移。
 */

import { describe, it, expect } from 'vitest';
import {
  computeSameTypeFindings,
  sameTypeFindingToItem,
  renderArityMsg,
  renderAcceptAllMsg,
  renderFallbackMsg,
  renderPendingMsg,
  SAME_TYPE_CONTRACT_CODE
} from '../src/backend/isSameTypeContract';
import {
  implBindingsForDocument,
  resolveImplMethodInputs
} from '../src/backend/createObjFromDictInput';
import type {
  CustomTypeInfo,
  CustomTypePropertyInfo
} from '../src/definitionWorkspace';

/** 真值字面量 chr 码构造(本车道防标识符漂移;字节即引擎真源)。 */
const PY_TRUE = String.fromCharCode(84, 114, 117, 101);
const PY_FALSE = String.fromCharCode(70, 97, 108, 115, 101);
const PY_NONE = String.fromCharCode(78, 111, 110, 101);
const ISINSTANCE = String.fromCharCode(105, 115, 105, 110, 115, 116, 97, 110, 99, 101);
const METHOD = String.fromCharCode(105, 115, 83, 97, 109, 101, 84, 121, 112, 101);

const TYPES_FILE = '/entity_defs/types.xml';
const IMPL_FILE = '/serializers_impl.py';

function scalarField(name: string, typeName: string, line: number): CustomTypePropertyInfo {
  return { name, typeName, line };
}

function customType(
  name: string,
  aliasType: string,
  properties: CustomTypePropertyInfo[],
  line: number,
  implementedBy?: string,
  pythonFilePath?: string
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
    structure: { name: aliasType, rawValue: aliasType, children: [], line },
    implementedBy,
    pythonFilePath,
    properties
  };
}

const BAG = customType('BAG', 'FIXED_DICT', [
  scalarField('x', 'UINT8', 32)
], 30, 'serializers_impl.BagSer', IMPL_FILE);

const BAG2 = customType('BAG2', 'FIXED_DICT', [
  scalarField('x', 'UINT8', 62)
], 60, 'serializers_impl.Bag2Ser', IMPL_FILE);

const REGISTRY: CustomTypeInfo[] = [BAG, BAG2];

const bindingsFor = (): ReturnType<typeof implBindingsForDocument> =>
  implBindingsForDocument(REGISTRY, IMPL_FILE);

// 第 4 参 true:SER-07 arity 面需要缺 obj 形参的绑定(缺 obj 恰是裁定面)
const findingsOf = (text: string) =>
  computeSameTypeFindings(
    text,
    resolveImplMethodInputs(text, bindingsFor(), METHOD, true)
  );

/** 方法体缩进(8 空格)。 */
const BODY_INDENT = 8;
const DEF_COL = 4 + 'def '.length;

const lines = (rows: string[]): string => rows.join('\n');

/** 单类骨架:class 0 / def 1 / body 自 2 起。 */
const single = (sigText: string, bodyRows: string[]): string =>
  lines([
    'class BagSer:',
    `    ${sigText}`,
    ...bodyRows.map(row => `        ${row}`),
    ''
  ]);

const sig = (params: string): string => `def ${METHOD}(${params})`;
const col = (row: string, needle: string): number => BODY_INDENT + row.indexOf(needle);

// ---------------------------------------------------------------------------
// arity 面(签名对引擎单位置实参绑定)
// ---------------------------------------------------------------------------

describe('computeSameTypeFindings arity', () => {
  it('零 obj 形参(self 之外无参)→ arity 锚 def 行方法名', () => {
    const text = single(sig('self'), [`return ${PY_TRUE}`]);
    const findings = findingsOf(text);
    expect(findings).toHaveLength(1);
    const [f] = findings;
    expect(f.face).toBe('arity');
    expect(f.container).toBe('BAG');
    expect(f.line).toBe(1);
    expect(f.character).toBe(DEF_COL);
    expect(f.length).toBe(METHOD.length);
    expect(f.message).toContain('TypeError');
  });

  it('多余必需位置形参 → arity', () => {
    const text = single(sig('self, obj, extra'), [`return ${PY_TRUE}`]);
    expect(findingsOf(text).map(f => f.face)).toEqual(['arity']);
  });

  it('多余形参带默认 → 合法,走证明状态面', () => {
    const text = single(sig('self, obj, extra=1'), [`return ${PY_TRUE}`]);
    const findings = findingsOf(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].face).toBe('acceptAll');
    expect(findings[0].line).toBe(2);
  });

  it('仅关键字必需形参(* 后无默认)→ arity', () => {
    const text = single(sig('self, obj, *, key'), [`return ${PY_TRUE}`]);
    expect(findingsOf(text).map(f => f.face)).toEqual(['arity']);
  });

  it('*args 承接单位置实参 → 合法', () => {
    const text = single(sig('self, *args'), [`return ${PY_TRUE}`]);
    expect(findingsOf(text).map(f => f.face)).toEqual(['acceptAll']);
  });

  it('**kwargs 不承接位置实参 → arity', () => {
    const text = single(sig('self, **kwargs'), [`return ${PY_TRUE}`]);
    expect(findingsOf(text).map(f => f.face)).toEqual(['arity']);
  });

  it('签名不可解析(收括号未闭)→ 零产出不猜', () => {
    const text = single(`def ${METHOD}(self, obj`, [`return ${PY_TRUE}`]);
    expect(findingsOf(text)).toHaveLength(0);
  });

  it('obj 带注解/默认仍按 obj 承接', () => {
    const text = single(sig('self, obj: int = 0'), [`return ${PY_TRUE}`]);
    expect(findingsOf(text).map(f => f.face)).toEqual(['acceptAll']);
  });
});

// ---------------------------------------------------------------------------
// 证明状态面(acceptAll / fallback / pending,优先级聚合)
// ---------------------------------------------------------------------------

describe('computeSameTypeFindings proof faces', () => {
  it('return True → acceptAll 锚 True 内容列', () => {
    const row = `return ${PY_TRUE}`;
    const text = single(sig('self, obj'), [row]);
    const findings = findingsOf(text);
    expect(findings).toHaveLength(1);
    const [f] = findings;
    expect(f.face).toBe('acceptAll');
    expect(f.line).toBe(2);
    expect(f.character).toBe(col(row, PY_TRUE));
    expect(f.length).toBe(PY_TRUE.length);
    expect(f.message).toContain('True');
    expect(f.message).toContain('types.xml:30');
  });

  it.each([
    ['False 常量', `return ${PY_FALSE}`],
    ['None 常量', `return ${PY_NONE}`],
    ['数值常量', 'return 1'],
    ['字符串常量', "return 'no'"]
  ])('%s → fallback', (_name, row) => {
    const text = single(sig('self, obj'), [row]);
    const findings = findingsOf(text);
    expect(findings).toHaveLength(1);
    const [f] = findings;
    expect(f.face).toBe('fallback');
    expect(f.line).toBe(2);
    expect(f.character).toBe(col(row, row.split(' ')[1]));
    expect(f.message).toContain('never count');
  });

  it('表达式 return → pending 锚首 token', () => {
    const row = 'return obj.hp > 10';
    const text = single(sig('self, obj'), [row]);
    const [f] = findingsOf(text);
    expect(f.face).toBe('pending');
    expect(f.character).toBe(col(row, 'obj.hp'));
    expect(f.length).toBe('obj.hp'.length);
    expect(f.message).toContain('unverified');
  });

  it('裸名 return → pending', () => {
    const row = 'return flag';
    const text = single(sig('self, obj'), [row]);
    const [f] = findingsOf(text);
    expect(f.face).toBe('pending');
    expect(f.character).toBe(col(row, 'flag'));
    expect(f.length).toBe('flag'.length);
  });

  it('yield 位不算 return → 零产出', () => {
    const text = single(sig('self, obj'), [`yield ${PY_TRUE}`]);
    expect(findingsOf(text)).toHaveLength(0);
  });

  it('无 return(pass)→ 零产出', () => {
    const text = single(sig('self, obj'), ['pass']);
    expect(findingsOf(text)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// isinstance 证明域
// ---------------------------------------------------------------------------

describe('computeSameTypeFindings isinstance', () => {
  it('全元素可解析(内建)→ 已证明零产出', () => {
    const text = single(sig('self, obj'), [`return ${ISINSTANCE}(obj, int)`]);
    expect(findingsOf(text)).toHaveLength(0);
  });

  it('全元素可解析(本文件类名)→ 已证明零产出', () => {
    const text = lines([
      'class Vec3:',
      '    pass',
      '',
      'class BagSer:',
      `    ${sig('self, obj')}`,
      `        return ${ISINSTANCE}(obj, Vec3)`,
      ''
    ]);
    expect(findingsOf(text)).toHaveLength(0);
  });

  it('未解析类名 → pending 锚该元素', () => {
    const row = `return ${ISINSTANCE}(obj, Matrix)`;
    const text = single(sig('self, obj'), [row]);
    const [f] = findingsOf(text);
    expect(f.face).toBe('pending');
    expect(f.character).toBe(col(row, 'Matrix'));
    expect(f.length).toBe('Matrix'.length);
  });

  it('元组形态任一未解析 → pending 锚未解析元素', () => {
    const row = `return ${ISINSTANCE}(obj, (int, Matrix))`;
    const text = single(sig('self, obj'), [row]);
    const [f] = findingsOf(text);
    expect(f.face).toBe('pending');
    expect(f.character).toBe(col(row, 'Matrix'));
  });

  it('缺第二实参 → pending 锚 isinstance', () => {
    const row = `return ${ISINSTANCE}(obj)`;
    const text = single(sig('self, obj'), [row]);
    const [f] = findingsOf(text);
    expect(f.face).toBe('pending');
    expect(f.character).toBe(col(row, ISINSTANCE));
    expect(f.length).toBe(ISINSTANCE.length);
  });
});

// ---------------------------------------------------------------------------
// 优先级聚合 / 域诚实
// ---------------------------------------------------------------------------

describe('computeSameTypeFindings aggregation', () => {
  it('acceptAll 胜 fallback(每方法至多一条)', () => {
    const text = single(sig('self, obj'), [
      'if obj:',
      `    return ${PY_FALSE}`,
      `return ${PY_TRUE}`
    ]);
    const findings = findingsOf(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].face).toBe('acceptAll');
    expect(findings[0].line).toBe(4);
    expect(findings[0].character).toBe(col(`return ${PY_TRUE}`, PY_TRUE));
  });

  it('acceptAll 胜 pending', () => {
    const text = single(sig('self, obj'), [
      'return check(obj)',
      `return ${PY_TRUE}`
    ]);
    const [f] = findingsOf(text);
    expect(f.face).toBe('acceptAll');
    expect(f.line).toBe(3);
  });

  it('pending 胜 fallback', () => {
    const text = single(sig('self, obj'), [
      'return check(obj)',
      `return ${PY_FALSE}`
    ]);
    const [f] = findingsOf(text);
    expect(f.face).toBe('pending');
    expect(f.line).toBe(2);
    expect(f.character).toBe(col('return check(obj)', 'check(obj)'));
  });

  it('嵌套 def 域 return 跳过(域诚实)', () => {
    const text = single(sig('self, obj'), [
      'def helper(x):',
      `    return ${PY_FALSE}`,
      `return ${PY_TRUE}`
    ]);
    const findings = findingsOf(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].face).toBe('acceptAll');
    expect(findings[0].line).toBe(4);
  });

  it('注释/字符串位不判(掩码核验)', () => {
    const text = single(sig('self, obj'), [
      `# return ${PY_FALSE}`,
      'log("return False")',
      `return ${PY_TRUE}`
    ]);
    const findings = findingsOf(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].face).toBe('acceptAll');
    expect(findings[0].line).toBe(4);
  });

  it('双类双面:各自一条,互不串域', () => {
    const text = lines([
      'class Bag2Ser:',
      `    ${sig('self, obj')}`,
      `        return ${PY_FALSE}`,
      '',
      'class BagSer:',
      `    ${sig('self, obj')}`,
      `        return ${PY_TRUE}`,
      ''
    ]);
    const findings = findingsOf(text);
    expect(findings).toHaveLength(2);
    const faces = findings.map(f => f.face).sort();
    expect(faces).toEqual(['acceptAll', 'fallback']);
    const fallback = findings.find(f => f.face === 'fallback');
    expect(fallback?.container).toBe('BAG2');
    expect(fallback?.line).toBe(2);
    const accept = findings.find(f => f.face === 'acceptAll');
    expect(accept?.container).toBe('BAG');
    expect(accept?.line).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// 消息模板与 finding → item
// ---------------------------------------------------------------------------

describe('sameTypeFindingToItem', () => {
  it('消息模板单一来源:占位符渲染', () => {
    expect(renderArityMsg(`BagSer.${METHOD}`)).toContain(`BagSer.${METHOD}`);
    expect(renderAcceptAllMsg('BAG', `BagSer.${METHOD}`, 'types.xml:30'))
      .toContain('BAG');
    expect(renderAcceptAllMsg('BAG', `BagSer.${METHOD}`, 'types.xml:30'))
      .toContain('types.xml:30');
    expect(renderFallbackMsg('BAG', `BagSer.${METHOD}`, 'types.xml:30'))
      .toContain('pointer identity');
    expect(renderPendingMsg('BAG', `BagSer.${METHOD}`, 'types.xml:30'))
      .toContain('runtime samples');
  });

  it('finding → item:arity Warning / 证明状态 Information / code 常量', () => {
    const text = single(sig('self'), [`return ${PY_TRUE}`]);
    const [arity] = findingsOf(text);
    const item = sameTypeFindingToItem(arity);
    expect(Object.keys(item).sort())
      .toEqual(['code', 'message', 'range', 'severity', 'source']);
    expect(item.severity).toBe('Warning');
    expect(item.code).toBe(SAME_TYPE_CONTRACT_CODE);
    expect(SAME_TYPE_CONTRACT_CODE).toBe('kbengine.isSameTypeBinding');
    expect(item.range.end.character).toBe(
      item.range.start.character + METHOD.length
    );

    const okText = single(sig('self, obj'), [`return ${PY_TRUE}`]);
    const [accept] = findingsOf(okText);
    const acceptItem = sameTypeFindingToItem(accept);
    expect(acceptItem.severity).toBe('Information');
    expect(acceptItem.range.end.character).toBe(
      acceptItem.range.start.character + PY_TRUE.length
    );
  });
});
