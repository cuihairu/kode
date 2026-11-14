/**
 * KSEM-SER-10:JSON dumps/loads 链传播(纯核心)。
 *
 * 面分组:schema 解析与校验(json.loads 绑定)/ schema 绑定路径命中
 * (fnmatch 语义、歧义不猜)/ dumps→loads 链传播(tuple→list 转换)/
 * import 证据绑定(属性形/裸名别名/括号续行)/ 流敏感诚实边界(重绑/
 * 条件体/函数体/行序)。全部纯函数直查,零 vscode 依赖。
 */

import { describe, it, expect } from 'vitest';
import {
  parseSerializationSchema,
  deriveJsonChainStructures,
  type SerializationSchema,
  type DictFormat,
  type DictValueKind
} from '../src/backend/jsonChainPropagation';

type LiteralFormat = Extract<DictFormat, { kind: 'literal' }>;

const scalar = (s: 'str' | 'int' | 'float' | 'bool' | 'none'): DictValueKind =>
  ({ kind: 'scalar', scalar: s });

const GUILD_SCHEMA = {
  schema_version: 1,
  types: {
    'proj.guild.GuildConfig': {
      fields: {
        level: 'UINT32',
        members: ['UINT32'],
        notice: 'STRING',
        settings: 'proj.guild.GuildSettings'
      }
    },
    'proj.guild.GuildSettings': {
      fields: { cap: 'UINT16', open: 'STRING' }
    }
  },
  bindings: {
    'json.loads': [
      { path: 'res/guild_configs/*.json', type: 'proj.guild.GuildConfig' }
    ]
  }
};

const schemaFrom = (doc: unknown): ReturnType<typeof parseSerializationSchema> =>
  parseSerializationSchema(JSON.stringify(doc));

const guildSchema = (): SerializationSchema | null => schemaFrom(GUILD_SCHEMA).schema;

const chains = (
  rows: string[],
  schema: SerializationSchema | null = guildSchema()
): Map<string, DictFormat> => deriveJsonChainStructures(rows.join('\n'), schema);

function asLiteral(map: Map<string, DictFormat>, name: string): LiteralFormat {
  const fmt = map.get(name);
  if (!fmt || fmt.kind !== 'literal') {
    throw new Error(`${name} expected literal, got ${fmt?.kind ?? 'absent'}`);
  }
  return fmt;
}

// ---------------------------------------------------------------------------
// schema 解析与校验
// ---------------------------------------------------------------------------

describe('parseSerializationSchema', () => {
  it('合法 schema:types/bindings 全收,errors 空,version 保留', () => {
    const result = schemaFrom(GUILD_SCHEMA);
    expect(result.errors).toEqual([]);
    const schema = result.schema;
    if (!schema) {
      throw new Error('schema expected non-null');
    }
    expect(schema.version).toBe(1);
    expect(schema.types.get('proj.guild.GuildSettings')?.get('cap'))
      .toEqual({ kind: 'scalar', family: 'UINT16' });
    expect(schema.loadsBindings).toEqual([
      { path: 'res/guild_configs/*.json', type: 'proj.guild.GuildConfig' }
    ]);
  });

  it('非 JSON → schema null + error', () => {
    const result = parseSerializationSchema('{bad json');
    expect(result.schema).toBeNull();
    expect(result.errors.length).toBe(1);
  });

  it('顶层非对象(数组)→ schema null', () => {
    const result = parseSerializationSchema('[1, 2]');
    expect(result.schema).toBeNull();
  });

  it('schema_version 缺失 → version null + error,types 仍解析', () => {
    const doc = { types: { T: { fields: { a: 'UINT32' } } }, bindings: {} };
    const result = schemaFrom(doc);
    expect(result.schema?.version).toBeNull();
    expect(result.errors.some(e => e.includes('schema_version'))).toBe(true);
    expect(result.schema?.types.has('T')).toBe(true);
  });

  it('标量族名不在 SCALAR_FAMILIES(BOOL/DBID 不在真源表)→ 字段丢弃 + error', () => {
    const doc = { schema_version: 1, types: { T: { fields: { flag: 'BOOL', db: 'DBID' } } } };
    const result = schemaFrom(doc);
    const fields = result.schema?.types.get('T');
    expect(fields?.has('flag')).toBe(false);
    expect(fields?.has('db')).toBe(false);
    expect(result.errors.filter(e => e.includes('unknown type name')).length).toBe(2);
  });

  it('引用未定义 type → 字段丢弃 + error;前向引用合法', () => {
    const bad = schemaFrom({
      schema_version: 1,
      types: { T: { fields: { g: 'Ghost' } } }
    });
    expect(bad.schema?.types.get('T')?.has('g')).toBe(false);
    expect(bad.errors.some(e => e.includes('Ghost'))).toBe(true);
    const forward = schemaFrom({
      schema_version: 1,
      types: {
        A: { fields: { b: 'B' } },
        B: { fields: { x: 'UINT8' } }
      }
    });
    expect(forward.errors).toEqual([]);
    expect(forward.schema?.types.get('A')?.get('b')).toEqual({ kind: 'ref', type: 'B' });
  });

  it('list 形状非法([] / 双元素)→ error', () => {
    const result = schemaFrom({
      schema_version: 1,
      types: { T: { fields: { a: [], b: ['UINT8', 'UINT16'] } } }
    });
    expect(result.schema?.types.get('T')?.size ?? 0).toBe(0);
    expect(result.errors.length).toBe(2);
  });

  it('字段 spec 非串非数组(数字)→ error', () => {
    const result = schemaFrom({
      schema_version: 1,
      types: { T: { fields: { a: 42 } } }
    });
    expect(result.schema?.types.get('T')?.has('a')).toBe(false);
    expect(result.errors.length).toBe(1);
  });

  it('环引用 type 淘汰:级联引用者一并零声称,绑定到环型丢弃', () => {
    const result = schemaFrom({
      schema_version: 1,
      types: {
        A: { fields: { b: 'B' } },
        B: { fields: { a: 'A' } },
        C: { fields: { a: 'A' } }
      },
      bindings: { 'json.loads': [{ path: 'p.json', type: 'A' }] }
    });
    expect(result.schema?.types.size ?? 1).toBe(0);
    expect(result.schema?.loadsBindings.length ?? 1).toBe(0);
    expect(result.errors.filter(e => e.includes('cyclic')).length).toBe(3);
    expect(result.errors.filter(e => e.includes('binding p.json')).length).toBe(1);
  });

  it('绑定条目形状错(缺 path / 非数组)→ error + 好条目保留', () => {
    const result = schemaFrom({
      schema_version: 1,
      types: { T: { fields: { x: 'UINT8' } } },
      bindings: {
        'json.loads': [
          { type: 'T' },
          { path: 'ok.json', type: 'T' }
        ]
      }
    });
    expect(result.schema?.loadsBindings).toEqual([{ path: 'ok.json', type: 'T' }]);
    expect(result.errors.length).toBe(1);
    const notArray = schemaFrom({
      schema_version: 1,
      types: { T: { fields: { x: 'UINT8' } } },
      bindings: { 'json.loads': { path: 'p', type: 'T' } }
    });
    expect(notArray.schema?.loadsBindings.length ?? 1).toBe(0);
    expect(notArray.errors.length).toBe(1);
  });

  it('全同绑定条目去重(同 path 同 type 不算歧义)', () => {
    const binding = { path: 'a.json', type: 'T' };
    const result = schemaFrom({
      schema_version: 1,
      types: { T: { fields: { x: 'UINT8' } } },
      bindings: { 'json.loads': [binding, { ...binding }] }
    });
    expect(result.schema?.loadsBindings.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// schema 绑定:loads 路径命中
// ---------------------------------------------------------------------------

describe('loads schema 绑定', () => {
  it('路径命中 → type 闭字面量(标量/list/嵌套 ref 全收,全必有)', () => {
    const back = asLiteral(chains([
      'import json',
      "cfg = json.loads('res/guild_configs/g1.json')"
    ]), 'cfg');
    expect(back.required.get('level')).toEqual(scalar('int'));
    expect(back.required.get('members')).toEqual({ kind: 'list', element: scalar('int') });
    expect(back.required.get('notice')).toEqual(scalar('str'));
    expect(back.required.get('settings')).toEqual({
      kind: 'dict',
      dict: {
        kind: 'literal',
        required: new Map([['cap', scalar('int')], ['open', scalar('str')]]),
        optional: new Map()
      }
    });
    expect(back.optional.size).toBe(0);
  });

  it('无 schema → loads 零声称(三禁)', () => {
    const out = chains([
      'import json',
      "cfg = json.loads('res/guild_configs/g1.json')"
    ], null);
    expect(out.has('cfg')).toBe(false);
  });

  it('路径不命中绑定 → 零声称', () => {
    const out = chains([
      'import json',
      "cfg = json.loads('res/other/x.json')"
    ]);
    expect(out.has('cfg')).toBe(false);
  });

  it('两条绑定同中 → 歧义不猜,零声称', () => {
    const result = schemaFrom({
      schema_version: 1,
      types: {
        A: { fields: { x: 'UINT8' } },
        B: { fields: { y: 'UINT8' } }
      },
      bindings: {
        'json.loads': [
          { path: 'res/*.json', type: 'A' },
          { path: 'res/g.json', type: 'B' }
        ]
      }
    });
    const out = chains(['import json', "c = json.loads('res/g.json')"], result.schema);
    expect(out.has('c')).toBe(false);
  });

  it("fnmatch '*' 跨目录(Python fnmatch 语义,无目录感知)", () => {
    const result = schemaFrom({
      schema_version: 1,
      types: { T: { fields: { x: 'UINT8' } } },
      bindings: { 'json.loads': [{ path: '*.json', type: 'T' }] }
    });
    const out = chains(['import json', "c = json.loads('deep/nested/x.json')"], result.schema);
    expect(out.has('c')).toBe(true);
  });

  it("fnmatch '?' 单字符;注释/串位假形态不判", () => {
    const result = schemaFrom({
      schema_version: 1,
      types: { T: { fields: { x: 'UINT8' } } },
      bindings: { 'json.loads': [{ path: 'g?.json', type: 'T' }] }
    });
    expect(chains(['import json', "c = json.loads('g1.json')"], result.schema).has('c')).toBe(true);
    expect(chains(['import json', "c = json.loads('g12.json')"], result.schema).has('c')).toBe(false);
    expect(chains([
      'import json',
      "# c = json.loads('g1.json')",
      "s = 'c = json.loads(\\'g1.json\\')'"
    ], result.schema).has('c')).toBe(false);
  });

  it('BLOB 字段 → unknown(bytes 非 JSON 值不声称);VECTOR3 → 开放元素 list', () => {
    const result = schemaFrom({
      schema_version: 1,
      types: { T: { fields: { blob: 'BLOB', pos: 'VECTOR3' } } },
      bindings: { 'json.loads': [{ path: 't.json', type: 'T' }] }
    });
    const t = asLiteral(chains(['import json', "c = json.loads('t.json')"], result.schema), 'c');
    expect(t.required.get('blob')).toEqual({ kind: 'unknown' });
    expect(t.required.get('pos')).toEqual({ kind: 'list', element: null });
  });

  it('注解赋值形态同样命中', () => {
    const back = asLiteral(chains([
      'import json',
      "cfg: dict = json.loads('res/guild_configs/g1.json')"
    ]), 'cfg');
    expect(back.required.has('level')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// dumps → loads 链传播与 JSON 转换
// ---------------------------------------------------------------------------

describe('dumps/loads 链传播', () => {
  it('SER-09 推导变量 → dumps → loads:tuple→list 转换落地', () => {
    const back = asLiteral(chains([
      'import json',
      'd = {"name": "g", "pos": (1, 2)}',
      's = json.dumps(d)',
      'back = json.loads(s)'
    ]), 'back');
    expect(back.required.get('name')).toEqual(scalar('str'));
    expect(back.required.get('pos')).toEqual({ kind: 'list', element: scalar('int') });
  });

  it('内联字典字面量实参:dumps({...}) → loads 链面,元组转换', () => {
    const back = asLiteral(chains([
      'import json',
      's = json.dumps({"a": 1, "t": (1, 2)})',
      'back = json.loads(s)'
    ]), 'back');
    expect(back.required.get('a')).toEqual(scalar('int'));
    expect(back.required.get('t')).toEqual({ kind: 'list', element: scalar('int') });
  });

  it('多行内联字面量实参整体消费', () => {
    const back = asLiteral(chains([
      'import json',
      's = json.dumps({',
      '    "a": 1,',
      '    "b": "x"',
      '})',
      'back = json.loads(s)'
    ]), 'back');
    expect(back.required.get('a')).toEqual(scalar('int'));
    expect(back.required.get('b')).toEqual(scalar('str'));
  });

  it('嵌套 dict/list 深转换递归;混合元素元组 element null 转换后仍是 null', () => {
    const back = asLiteral(chains([
      'import json',
      'd = {"f": 1.5, "xs": [(1, "a")], "nest": {"k": (True, None)}}',
      's = json.dumps(d)',
      'back = json.loads(s)'
    ]), 'back');
    expect(back.required.get('f')).toEqual(scalar('float'));
    expect(back.required.get('xs')).toEqual({
      kind: 'list',
      element: { kind: 'list', element: null } // (1, "a") 混合元素未收敛,不猜
    });
    const nest = back.required.get('nest');
    if (!nest || nest.kind !== 'dict' || nest.dict.kind !== 'literal') {
      throw new Error('nest expected literal dict');
    }
    expect(nest.dict.required.get('k')).toEqual({
      kind: 'list',
      element: null // bool/none 混合元素未收敛,不猜
    });
  });

  it('开放结构(open)透传:dumps 增量写点变量 → observed 面保留', () => {
    const back = asLiteral(chains([
      'import json',
      'd = {"a": 1}',
      'd["b"] = 2',
      's = json.dumps(d)',
      'back = json.loads(s)'
    ]), 'back');
    expect(back.kind === 'open' || back.kind === 'literal').toBe(true);
    if (back.kind === 'open') {
      expect(back.observed.get('a')).toEqual(scalar('int'));
      expect(back.observed.get('b')).toEqual(scalar('int'));
    } else {
      expect(back.required.get('a')).toEqual(scalar('int'));
      expect(back.required.get('b')).toEqual(scalar('int'));
    }
  });
});

// ---------------------------------------------------------------------------
// 链诚实边界:不可证明即未知
// ---------------------------------------------------------------------------

describe('链诚实边界', () => {
  it('dumps 实参不可证明(未知来源名)→ 零声称', () => {
    const out = chains([
      'import json',
      'x = load()',
      's = json.dumps(x)',
      'back = json.loads(s)'
    ]);
    expect(out.has('back')).toBe(false);
    expect(out.has('s')).toBe(false);
  });

  it('非字典顶层实参(列表字面量/串字面量)→ 零声称(只承载 dict 面)', () => {
    const out = chains([
      'import json',
      's = json.dumps([1, 2])',
      't = json.dumps("x")',
      'back = json.loads(s)'
    ]);
    expect(out.has('back')).toBe(false);
    expect(out.has('t')).toBe(false);
  });

  it('无 import 证据 → json.dumps/loads 不绑定,零声称', () => {
    const out = chains([
      'd = {"a": 1}',
      's = json.dumps(d)',
      'back = json.loads(s)'
    ]);
    expect(out.has('back')).toBe(false);
  });

  it("from json import dumps as jd, loads as jl 别名裸名链", () => {
    const back = asLiteral(chains([
      'from json import dumps as jd, loads as jl',
      'd = {"a": 1}',
      's = jd(d)',
      'back = jl(s)'
    ]), 'back');
    expect(back.required.get('a')).toEqual(scalar('int'));
  });

  it('括号续行 import 形态收整绑定', () => {
    const back = asLiteral(chains([
      'from json import (',
      '    dumps,',
      '    loads',
      ')',
      'd = {"a": 1}',
      's = dumps(d)',
      'back = loads(s)'
    ]), 'back');
    expect(back.required.get('a')).toEqual(scalar('int'));
  });

  it('import json as j → j.dumps 绑定;未导入的 json.loads 不声称', () => {
    const out = chains([
      'import json as j',
      'd = {"a": 1}',
      's = j.dumps(d)',
      'back = json.loads(s)'
    ]);
    expect(out.has('back')).toBe(false);
    const ok = chains([
      'import json as j',
      'd = {"a": 1}',
      's = j.dumps(d)',
      'back = j.loads(s)'
    ]);
    expect(asLiteral(ok, 'back').required.get('a')).toEqual(scalar('int'));
  });

  it('绑定名被重绑定(json = 3)→ 后续调用不绑', () => {
    const out = chains([
      'import json',
      'json = 3',
      'd = {"a": 1}',
      's = json.dumps(d)',
      'back = json.loads(s)'
    ]);
    expect(out.has('back')).toBe(false);
  });

  it('carrier 被重绑定(串值)→ 后续 loads 零声称', () => {
    const out = chains([
      'import json',
      'd = {"a": 1}',
      's = json.dumps(d)',
      's = "other"',
      'back = json.loads(s)'
    ]);
    expect(out.has('back')).toBe(false);
  });

  it('增量写点(+=)作废 carrier', () => {
    const out = chains([
      'import json',
      'd = {"a": 1}',
      's = json.dumps(d)',
      's += "x"',
      'back = json.loads(s)'
    ]);
    expect(out.has('back')).toBe(false);
  });

  it('多目标赋值作废全部目标', () => {
    const out = chains([
      'import json',
      'd = {"a": 1}',
      's = json.dumps(d)',
      'a, s = 1, 2',
      'back = json.loads(s)'
    ]);
    expect(out.has('back')).toBe(false);
  });

  it('loads 实参 f 串/表达式 → 零声称', () => {
    const out = chains([
      'import json',
      "base = 'res'",
      'c = json.loads(f"{base}/g.json")',
      'e = json.loads(read_text())'
    ]);
    expect(out.has('c')).toBe(false);
    expect(out.has('e')).toBe(false);
  });

  it('loads 只吃 JSON 串:dict 变量实参不声称', () => {
    const out = chains([
      'import json',
      'd = {"a": 1}',
      'back = json.loads(d)'
    ]);
    expect(out.has('back')).toBe(false);
  });

  it('条件体链可能不执行 → 零声称', () => {
    const out = chains([
      'import json',
      'd = {"a": 1}',
      'if flag:',
      '    s = json.dumps(d)',
      'back = json.loads(s)'
    ]);
    expect(out.has('back')).toBe(false);
  });

  it('import 在分支体内(try)仍绑定;except 重绑定即死', () => {
    const ok = chains([
      'try:',
      '    import json',
      'except ImportError:',
      '    raise',
      'd = {"a": 1}',
      's = json.dumps(d)',
      'back = json.loads(s)'
    ]);
    expect(asLiteral(ok, 'back').required.get('a')).toEqual(scalar('int'));
    const dead = chains([
      'try:',
      '    import json',
      'except ImportError:',
      '    json = None',
      'd = {"a": 1}',
      's = json.dumps(d)',
      'back = json.loads(s)'
    ]);
    expect(dead.has('back')).toBe(false);
  });

  it('函数体链不入模块 map(同名跨作用域合流是谎报)', () => {
    const out = chains([
      'import json',
      'def f():',
      '    d = {"a": 1}',
      '    s = json.dumps(d)',
      '    back = json.loads(s)',
      '    return back'
    ]);
    expect(out.size).toBe(0);
  });

  it('行序流敏感:loads 先于 carrier → 零声称(后置定义不回填)', () => {
    const out = chains([
      'import json',
      'back = json.loads(s)',
      'd = {"a": 1}',
      's = json.dumps(d)'
    ]);
    expect(out.has('back')).toBe(false);
  });

  it('关键字实参/多实参形态(dumps kwargs)→ v1 未知', () => {
    const out = chains([
      'import json',
      's = json.dumps({"a": 1}, indent=2)',
      'back = json.loads(s)'
    ]);
    expect(out.has('back')).toBe(false);
  });

  it('调用带后缀(方法链/三元)→ 未知', () => {
    const out = chains([
      'import json',
      'd = {"a": 1}',
      's = json.dumps(d).strip()',
      't = json.dumps(d) if flag else ""',
      'back = json.loads(s)',
      'back2 = json.loads(t)'
    ]);
    expect(out.has('back')).toBe(false);
    expect(out.has('back2')).toBe(false);
  });

  it('别名透传:carrier 别名可 loads;value 别名入 map', () => {
    const out = chains([
      'import json',
      'd = {"a": 1}',
      's = json.dumps(d)',
      't = s',
      'back = json.loads(t)',
      'back2 = back'
    ]);
    expect(asLiteral(out, 'back').required.get('a')).toEqual(scalar('int'));
    expect(asLiteral(out, 'back2').required.get('a')).toEqual(scalar('int'));
  });

  it('schema → dumps → loads 全链:value 实参可传,结构全等', () => {
    const out = chains([
      'import json',
      "cfg = json.loads('res/guild_configs/g1.json')",
      's = json.dumps(cfg)',
      'back = json.loads(s)'
    ]);
    const cfg = asLiteral(out, 'cfg');
    const back = asLiteral(out, 'back');
    expect(back.required.get('level')).toEqual(cfg.required.get('level'));
    expect(back.required.get('settings')).toEqual(cfg.required.get('settings'));
    expect(back.required.get('members')).toEqual({
      kind: 'list', element: scalar('int')
    });
  });
});
