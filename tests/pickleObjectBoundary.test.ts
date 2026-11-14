/**
 * KSEM-SER-11:pickle/PYTHON 边界(纯核心)。
 *
 * 面分组:pickle 族内存形式登记(SER-02 §3)/ 边界闸(裸 PYTHON 恒不落
 * FIXED_DICT 类声称,引擎族名优先于同名注册;对象/FD/数组/标量证据面
 * 全数放行)/ GEN-DEF-1c <Default> 声明精化透传(def 侧证据非运行时产物)/
 * pickle 反序列化零声称(import 证据绑定识别形态,声称恒零——对照
 * json.loads SER-10 schema 命中才声称)。全部纯函数直查,零 vscode 依赖。
 */

import { describe, it, expect } from 'vitest';
import {
  pickleFamilyMemoryFormOf,
  pickleObjectEvidence,
  structureClaimGate,
  scanPickleDeserialization,
  type PickleMemoryForm
} from '../src/backend/pickleObjectBoundary';
import { PYTHON_FAMILY_BASE } from '../src/backend/pythonLiteralTypes';
import type { CustomTypeInfo } from '../src/definitionWorkspace';

/** 最小 FIXED_DICT 别名注册(带一个 UINT32 字段)。 */
const fdType = (name: string, implementedBy?: string): CustomTypeInfo => ({
  name,
  filePath: '/defs/types.xml',
  line: 1,
  implementedByLine: 1,
  startOffset: 0,
  endOffset: 0,
  aliasType: 'FIXED_DICT',
  rawValue: '',
  structure: { name: 'Type', rawValue: '', children: [], line: null },
  properties: [{ name: 'x', typeName: 'UINT32', line: 2 }],
  ...(implementedBy ? { implementedBy } : {})
});

const scan = (rows: string[]): ReturnType<typeof scanPickleDeserialization> =>
  scanPickleDeserialization(rows.join('\n'));

// ---------------------------------------------------------------------------
// pickle 族内存形式登记(SER-02 §3;单一真源=GEN-DEF-1c 基类表)
// ---------------------------------------------------------------------------

describe('pickle 族内存形式登记', () => {
  it('四族 → any/dict/tuple/list', () => {
    expect(pickleFamilyMemoryFormOf('PYTHON')).toBe('any');
    expect(pickleFamilyMemoryFormOf('PY_DICT')).toBe('dict');
    expect(pickleFamilyMemoryFormOf('PY_TUPLE')).toBe('tuple');
    expect(pickleFamilyMemoryFormOf('PY_LIST')).toBe('list');
  });

  it('大小写敏感/非族名 → null', () => {
    expect(pickleFamilyMemoryFormOf('python')).toBeNull();
    expect(pickleFamilyMemoryFormOf('Python')).toBeNull();
    expect(pickleFamilyMemoryFormOf('UINT32')).toBeNull();
    expect(pickleFamilyMemoryFormOf('FIXED_DICT')).toBeNull();
    expect(pickleFamilyMemoryFormOf('BLOB')).toBeNull();
    expect(pickleFamilyMemoryFormOf('')).toBeNull();
  });

  it('族表单一真源:键集恰为 GEN-DF-1c 基类表四键,每键可归一', () => {
    expect(new Set(Object.keys(PYTHON_FAMILY_BASE))).toEqual(
      new Set(['PYTHON', 'PY_DICT', 'PY_TUPLE', 'PY_LIST'])
    );
    for (const name of Object.keys(PYTHON_FAMILY_BASE)) {
      const form: PickleMemoryForm | null = pickleFamilyMemoryFormOf(name);
      expect(['any', 'dict', 'tuple', 'list']).toContain(form);
    }
  });
});

// ---------------------------------------------------------------------------
// 边界闸:不把裸 PYTHON 当 FIXED_DICT(验收②)
// ---------------------------------------------------------------------------

describe('structureClaimGate 边界闸', () => {
  it('裸四族 + 同名 FIXED_DICT 注册并存 → 恒 pickleOpaque(引擎族名优先)', () => {
    const customTypes = [
      fdType('PYTHON', 'proj.impl.PyObj'),
      fdType('PY_DICT'),
      fdType('PY_TUPLE'),
      fdType('PY_LIST')
    ];
    for (const [name, form] of [
      ['PYTHON', 'any'],
      ['PY_DICT', 'dict'],
      ['PY_TUPLE', 'tuple'],
      ['PY_LIST', 'list']
    ] as const) {
      const gate = structureClaimGate(name, customTypes);
      expect(gate).toEqual({ kind: 'pickleOpaque', memoryForm: form, fieldClaims: 'none' });
    }
  });

  it('implementedBy 类型 → object(STRUCT-07:内存形式=实现类,对象契约面放行)', () => {
    const info = fdType('AvatarData', 'proj.avatar_data.Data');
    const gate = structureClaimGate('AvatarData', [info]);
    if (gate.kind !== 'object') {
      throw new Error(`expected object, got ${gate.kind}`);
    }
    expect(gate.info).toBe(info);
    expect(gate.info.implementedBy).toBe('proj.avatar_data.Data');
  });

  it('非 impl FIXED_DICT → fixedDict(键位面接管,既有面放行)', () => {
    const gate = structureClaimGate('GuildConfig', [fdType('GuildConfig')]);
    expect(gate.kind).toBe('fixedDict');
  });

  it('FixedArray[非 impl FD] → array 带元素;impl FD/标量元素/畸形 → element null / unknown', () => {
    const element = fdType('Item');
    const withArray = structureClaimGate('FixedArray[Item]', [element]);
    expect(withArray).toEqual({ kind: 'array', element });
    expect(structureClaimGate('FixedArray[PyItems]', [fdType('PyItems', 'proj.i.Items')]))
      .toEqual({ kind: 'array', element: null });
    expect(structureClaimGate('FixedArray[UINT32]', [])).toEqual({ kind: 'array', element: null });
    expect(structureClaimGate('FixedArray[Item', [element]).kind).toBe('unknown');
  });

  it('引擎标量真源成员(含 BLOB/VECTOR 定长族)→ scalar;ENTITYCALL/未注册名 → unknown', () => {
    expect(structureClaimGate('UINT32', []).kind).toBe('scalar');
    expect(structureClaimGate('BLOB', []).kind).toBe('scalar');
    expect(structureClaimGate('VECTOR3', []).kind).toBe('scalar');
    expect(structureClaimGate('ENTITYCALL', []).kind).toBe('unknown');
    expect(structureClaimGate('Ghost', []).kind).toBe('unknown');
  });

  it('交叉:结构化类型永不落 pickleOpaque(四族永不侵占证据面)', () => {
    const customTypes = [fdType('AvatarData', 'proj.a.Data'), fdType('GuildConfig')];
    for (const label of ['AvatarData', 'GuildConfig', 'FixedArray[GuildConfig]', 'UINT32', 'VECTOR3']) {
      expect(structureClaimGate(label, customTypes).kind).not.toBe('pickleOpaque');
    }
  });
});

// ---------------------------------------------------------------------------
// GEN-DEF-1c 声明精化透传(验收①:def 侧证据,非运行时反序列化产物)
// ---------------------------------------------------------------------------

describe('pickleObjectEvidence 声明精化透传', () => {
  it('PYTHON <Default>123 → int;PY_DICT → dict[str, int];PY_LIST → list[int];PY_TUPLE → tuple[int, str]', () => {
    expect(pickleObjectEvidence('PYTHON', '123')?.declaredAnnotation).toBe('int');
    expect(pickleObjectEvidence('PY_DICT', "{'hp': 1}")?.declaredAnnotation).toBe('dict[str, int]');
    expect(pickleObjectEvidence('PY_LIST', '[1, 2]')?.declaredAnnotation).toBe('list[int]');
    expect(pickleObjectEvidence('PY_TUPLE', "(1, 'a')")?.declaredAnnotation).toBe('tuple[int, str]');
  });

  it('无 Default → 基类注解;内存形式与零声称标记恒在', () => {
    expect(pickleObjectEvidence('PYTHON')).toEqual({
      kind: 'pickleOpaque',
      memoryForm: 'any',
      declaredAnnotation: 'Any',
      fieldClaims: 'none'
    });
    expect(pickleObjectEvidence('PY_DICT')?.declaredAnnotation).toBe('dict');
  });

  it('None 默认/解不出名/基类形态不符 → 基类(既有 GEN-DF-1c 面原样)', () => {
    expect(pickleObjectEvidence('PYTHON', 'None')?.declaredAnnotation).toBe('Any');
    expect(pickleObjectEvidence('PYTHON', 'SOME_CONST')?.declaredAnnotation).toBe('Any');
    expect(pickleObjectEvidence('PY_DICT', '[1, 2]')?.declaredAnnotation).toBe('dict');
  });

  it('非族名 → null(闸路由到别类证据面)', () => {
    expect(pickleObjectEvidence('UINT32', '1')).toBeNull();
    expect(pickleObjectEvidence('GuildConfig')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// pickle 反序列化零声称(验收③:形态可识别,结构声称恒零)
// ---------------------------------------------------------------------------

describe('scanPickleDeserialization 反序列化零声称', () => {
  it('import pickle + 赋值形/语句形调用 → 识别 1,声称恒空', () => {
    expect(scan(['import pickle', 'b = pickle.loads(raw)'])).toEqual({
      recognizedCalls: 1,
      structureClaims: []
    });
    expect(scan(['import pickle', 'pickle.loads(raw)']).recognizedCalls).toBe(1);
  });

  it('cPickle 与 as 别名属性形;from-import 裸名/别名形', () => {
    expect(scan(['import cPickle as cp', 'b = cp.loads(raw)']).recognizedCalls).toBe(1);
    expect(scan(['from pickle import loads', 'b = loads(raw)']).recognizedCalls).toBe(1);
    expect(scan(['from cPickle import loads as cl', 'b = cl(raw)']).recognizedCalls).toBe(1);
  });

  it('括号续行 from-import 收整绑定', () => {
    expect(scan([
      'from pickle import (',
      '    loads',
      ')',
      'b = loads(raw)'
    ]).recognizedCalls).toBe(1);
  });

  it('下标目标赋值形态计数;实参形态不影响计数(嵌套调用/kwargs/多行括号)', () => {
    expect(scan(['from pickle import loads', 'd[k] = loads(raw)']).recognizedCalls).toBe(1);
    expect(scan(['import pickle', 'b = pickle.loads(f.read())']).recognizedCalls).toBe(1);
    expect(scan(['import pickle', 'b = pickle.loads(raw, fix_imports=True)']).recognizedCalls).toBe(1);
    expect(scan(['import pickle', 'b = pickle.loads(', '    raw)']).recognizedCalls).toBe(1);
    expect(scan(['import pickle', 'b = pickle.loads(raw).strip()']).recognizedCalls).toBe(1);
  });

  it('多次调用点计数累计', () => {
    expect(scan([
      'import pickle',
      'a = pickle.loads(x)',
      'pickle.loads(y)',
      'c = pickle.loads(z)'
    ]).recognizedCalls).toBe(3);
  });

  it('无 import 证据 → 不计(json.loads 车道同样不计)', () => {
    expect(scan(['b = pickle.loads(raw)']).recognizedCalls).toBe(0);
    expect(scan(['b = loads(raw)']).recognizedCalls).toBe(0);
    expect(scan(["import json", "c = json.loads('p.json')"]).recognizedCalls).toBe(0);
  });

  it('绑定名重绑即死(模块别名/裸名/多目标)', () => {
    expect(scan(['import pickle', 'pickle = 3', 'b = pickle.loads(raw)']).recognizedCalls).toBe(0);
    expect(scan(['from pickle import loads', 'loads = 5', 'b = loads(raw)']).recognizedCalls).toBe(0);
    expect(scan(['from pickle import loads', 'a, loads = 1, 2', 'b = loads(raw)']).recognizedCalls).toBe(0);
  });

  it('未绑定接收者(obj.loads / 别的模块)与 dumps 序列化方向不计', () => {
    expect(scan(['import pickle', 'b = obj.loads(raw)']).recognizedCalls).toBe(0);
    expect(scan(['import pickle', 'pickle.dumps(obj)']).recognizedCalls).toBe(0);
    expect(scan(['from pickle import dumps', 's = dumps(obj)']).recognizedCalls).toBe(0);
  });

  it('注释/字符串位形态不认(掩码行);引用/callback 无调用括号不计', () => {
    expect(scan(['import pickle', '# b = pickle.loads(raw)']).recognizedCalls).toBe(0);
    expect(scan(['import pickle', "s = 'b = pickle.loads(raw)'"]).recognizedCalls).toBe(0);
    expect(scan(['import pickle', 'xs = map(pickle.loads, rows)']).recognizedCalls).toBe(0);
  });

  it('函数体内调用不入模块面(scope 诚实);属性目标/增量赋值形态不入识别面', () => {
    expect(scan([
      'import pickle',
      'def f():',
      '    return pickle.loads(raw)'
    ]).recognizedCalls).toBe(0);
    expect(scan(['import pickle', 'self.data = pickle.loads(raw)']).recognizedCalls).toBe(0);
    expect(scan(['import pickle', 's += pickle.loads(raw)']).recognizedCalls).toBe(0);
  });

  it('dumps→loads 往返:carrier 可证,loads 识别 1,结构声称恒零(json 同形得全结构,pickle 桶零)', () => {
    const result = scan([
      'import pickle',
      'd = {"a": 1, "pos": (1, 2)}',
      's = pickle.dumps(d)',
      'back = pickle.loads(s)'
    ]);
    expect(result.recognizedCalls).toBe(1);
    expect(result.structureClaims).toEqual([]);
  });

  it('def 声明 <Default> 精化与运行时 loads 零声称并存(声明证据 ≠ 反序列化推断)', () => {
    const evidence = pickleObjectEvidence('PY_LIST', '[1, 2]');
    const result = scan(['import pickle', 'cfg = pickle.loads(blob)']);
    expect(evidence?.declaredAnnotation).toBe('list[int]');
    expect(result.structureClaims).toEqual([]);
  });
});
