/**
 * KSEM-CFG-07 配置读取结果类型传播(纯核心)。
 *
 * 面分组:schema 绑定 loader(json.loads 串实参 / json.load(open(串))
 * 下标访问类型与嵌套 ref 链 / 列表字段与整数下标 / get 缺省值联合
 * (无默认=none,有默认=默认值类型)/ 别名透传 / 诚实边界(未知键
 * fieldType=null、变量键、写位点、参数遮蔽、体内写点、模块级终态漂移、
 * 重绑后访问、属性接收者、open 变量路径、无绑定路径)/ derived 面
 * (SER-09 字典经别名透传)。零 vscode 依赖。
 */
import { describe, it, expect } from 'vitest';
import {
  parseSerializationSchema,
  type SerializationSchema
} from '../src/backend/jsonChainPropagation';
import {
  deriveConfigFieldAccesses,
  type ConfigFieldAccess
} from '../src/backend/configFieldAccess';

const GUILD_SCHEMA = {
  schema_version: 1,
  types: {
    'proj.guild.GuildConfig': {
      fields: {
        level: 'UINT32',
        members: ['UINT64'],
        notice: 'STRING',
        settings: 'proj.guild.GuildSettings'
      }
    },
    'proj.guild.GuildSettings': {
      fields: { cap: 'UINT16', open: 'STRING' }
    }
  },
  bindings: {
    'json.loads': [{ path: 'res/guild_configs/*.json', type: 'proj.guild.GuildConfig' }],
    'json.load': [{ path: 'res/guild_configs/*.json', type: 'proj.guild.GuildConfig' }]
  }
};

const guildSchema = (): SerializationSchema | null =>
  parseSerializationSchema(JSON.stringify(GUILD_SCHEMA)).schema;

const access = (
  rows: string[],
  schema: SerializationSchema | null = guildSchema()
): ConfigFieldAccess[] => deriveConfigFieldAccesses(rows.join('\n'), schema);

describe('KSEM-CFG-07 config field access types', () => {
  it('json.loads binding: subscript access carries schema field type', () => {
    const out = access([
      'import json',
      "cfg = json.loads('res/guild_configs/g1.json')",
      "x = cfg['level']"
    ]);
    expect(out).toHaveLength(1);
    const f = out[0];
    expect(f.line).toBe(2);
    expect(f.receiver).toBe('cfg');
    expect(f.keys).toEqual(['level']);
    expect(f.origin).toBe('schema');
    expect(f.typeId).toBe('proj.guild.GuildConfig');
    expect(f.fieldType).toEqual({ kind: 'scalar', family: 'UINT32' });
    expect(f.unionWith).toEqual([]);
  });

  it('nested chain walks ref fields (cfg[settings][cap])', () => {
    const out = access([
      'import json',
      "cfg = json.loads('res/guild_configs/g1.json')",
      "x = cfg['settings']['cap']"
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].keys).toEqual(['settings', 'cap']);
    expect(out[0].fieldType).toEqual({ kind: 'scalar', family: 'UINT16' });
  });

  it('list field types and integer subscript element', () => {
    const out = access([
      'import json',
      "cfg = json.loads('res/guild_configs/g1.json')",
      "lst = cfg['members']",
      "first = cfg['members'][0]"
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].fieldType).toEqual({ kind: 'list', element: { kind: 'scalar', family: 'UINT64' } });
    expect(out[1].fieldType).toEqual({ kind: 'scalar', family: 'UINT64' });
    expect(out[1].keys).toEqual(['members']);
  });

  it('get without default unions none; get with default unions the default type', () => {
    const out = access([
      'import json',
      "cfg = json.loads('res/guild_configs/g1.json')",
      "a = cfg.get('level')",
      "b = cfg.get('level', 0)",
      "c = cfg.get('notice', 'none-set')"
    ]);
    expect(out).toHaveLength(3);
    expect(out[0].fieldType).toEqual({ kind: 'scalar', family: 'UINT32' });
    expect(out[0].unionWith).toEqual([{ kind: 'scalar', family: 'none' }]);
    expect(out[1].unionWith).toEqual([{ kind: 'scalar', family: 'int' }]);
    expect(out[2].fieldType).toEqual({ kind: 'scalar', family: 'STRING' });
    expect(out[2].unionWith).toEqual([{ kind: 'scalar', family: 'str' }]);
  });

  it('alias keeps the schema origin through bare-name assignment', () => {
    const out = access([
      'import json',
      "cfg = json.loads('res/guild_configs/g1.json')",
      'y = cfg',
      "n = y['notice']"
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].receiver).toBe('y');
    expect(out[0].origin).toBe('schema');
    expect(out[0].typeId).toBe('proj.guild.GuildConfig');
    expect(out[0].fieldType).toEqual({ kind: 'scalar', family: 'STRING' });
  });

  it('json.load(open(literal)) binds via bindings["json.load"], tolerating encoding kwarg', () => {
    const out = access([
      'import json',
      "cfg = json.load(open('res/guild_configs/g2.json'))",
      "x = cfg['level']",
      "cfg2 = json.load(open('res/guild_configs/g3.json', encoding='utf-8'))",
      "y = cfg2['notice']"
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].typeId).toBe('proj.guild.GuildConfig');
    expect(out[0].fieldType).toEqual({ kind: 'scalar', family: 'UINT32' });
    expect(out[1].fieldType).toEqual({ kind: 'scalar', family: 'STRING' });
  });

  it('json.load with variable path or unbound path makes no claim', () => {
    const out = access([
      'import json',
      'p = "res/guild_configs/g9.json"',
      'cfg = json.load(open(p))',
      "x = cfg['level']",
      "cfg2 = json.load(open('res/other/x.ini'))",
      "y = cfg2['level']"
    ]);
    expect(out).toHaveLength(0);
  });

  it('unknown keys report fieldType null; get still unions none', () => {
    const out = access([
      'import json',
      "cfg = json.loads('res/guild_configs/g1.json')",
      "x = cfg['nope']",
      "y = cfg.get('nope')"
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].keys).toEqual(['nope']);
    expect(out[0].fieldType).toBeNull();
    expect(out[0].unionWith).toEqual([]);
    expect(out[1].fieldType).toBeNull();
    expect(out[1].unionWith).toEqual([{ kind: 'scalar', family: 'none' }]);
  });

  it('dynamic keys, attribute receivers, and write sites are not accesses', () => {
    const out = access([
      'import json',
      "cfg = json.loads('res/guild_configs/g1.json')",
      "k = 'level'",
      "x = cfg[k]",
      "cfg['level'] = 5",
      "y = self.cfg['level']"
    ]);
    expect(out).toHaveLength(0);
  });

  it('in-function reads resolve against the entering module state', () => {
    const out = access([
      'import json',
      "cfg = json.loads('res/guild_configs/g1.json')",
      'def read():',
      "    return cfg['level']"
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].line).toBe(3);
    expect(out[0].fieldType).toEqual({ kind: 'scalar', family: 'UINT32' });
  });

  it('parameter shadowing and body writes skip the site', () => {
    const shadow = access([
      'import json',
      "cfg = json.loads('res/guild_configs/g1.json')",
      'def read(cfg):',
      "    return cfg['level']"
    ]);
    expect(shadow).toHaveLength(0);
    const bodyWrite = access([
      'import json',
      "cfg = json.loads('res/guild_configs/g1.json')",
      'def read():',
      '    cfg = {}',
      "    return cfg['level']"
    ]);
    expect(bodyWrite).toHaveLength(0);
  });

  it('module-level rebinding after the def makes the body read unprovable', () => {
    const out = access([
      'import json',
      "cfg = json.loads('res/guild_configs/g1.json')",
      'def read():',
      "    return cfg['level']",
      'cfg = 3'
    ]);
    expect(out).toHaveLength(0);
  });

  it('rebinding before a module-scope access kills the site', () => {
    const out = access([
      'import json',
      "cfg = json.loads('res/guild_configs/g1.json')",
      'cfg = 3',
      "x = cfg['level']"
    ]);
    expect(out).toHaveLength(0);
  });

  it('conditional loader (if-guarded) makes no claim', () => {
    const out = access([
      'import json',
      'if True:',
      "    cfg = json.loads('res/guild_configs/g1.json')",
      "x = cfg['level']"
    ]);
    expect(out).toHaveLength(0);
  });

  it('schema=null keeps only the derived face; loader face is silent', () => {
    const out = access([
      'import json',
      "cfg = json.loads('res/guild_configs/g1.json')",
      "raw = {'cap': 3, 'open': 'x'}",
      'd = raw',
      "c = d['cap']"
    ], null);
    expect(out).toHaveLength(1);
    expect(out[0].origin).toBe('derived');
    expect(out[0].typeId).toBeNull();
    expect(out[0].fieldType).toEqual({ kind: 'scalar', family: 'int' });
  });

  it('derived face resolves dict literal fields through alias', () => {
    const out = access([
      "raw = {'cap': 3, 'open': 'x'}",
      'd = raw',
      "o = d['open']",
      "g = d.get('cap', 0)"
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].fieldType).toEqual({ kind: 'scalar', family: 'str' });
    expect(out[1].fieldType).toEqual({ kind: 'scalar', family: 'int' });
    expect(out[1].unionWith).toEqual([{ kind: 'scalar', family: 'int' }]);
  });

  it('class body writes shadow the module name (class scope is honest)', () => {
    const out = access([
      'import json',
      "cfg = json.loads('res/guild_configs/g1.json')",
      'class Guild:',
      '    cfg = 1',
      "    level = cfg['level']"
    ]);
    expect(out).toHaveLength(0);
  });
});

// COV-98-TS-BACKEND 批 1:分支/容错臂补测(77.77%→98 档)。
// 全部走公开入口 deriveConfigFieldAccesses,不 mock 内部件;断言面=
// 实现的真实语义(诚实边界各臂断言零声称,不硬造期望)。
describe('KSEM-CFG-07 sweep: chain fallbacks and def-scope guards', () => {
  it('schema 链容错:根整数下标/键打列表/键打标量/ref 字段本体', () => {
    const out = access([
      'import json',
      "cfg = json.loads('res/guild_configs/g1.json')",
      'a = cfg[0]',
      "b = cfg['members']['x']",
      "c = cfg['level']['x']",
      "s = cfg['settings']"
    ]);
    expect(out).toHaveLength(4);
    expect(out[0].keys).toEqual([]);
    expect(out[0].fieldType).toBeNull();
    expect(out[1].keys).toEqual(['members', 'x']);
    expect(out[1].fieldType).toBeNull();
    expect(out[2].keys).toEqual(['level', 'x']);
    expect(out[2].fieldType).toBeNull();
    expect(out[3].keys).toEqual(['settings']);
    expect(out[3].fieldType).toEqual({ kind: 'ref', type: 'proj.guild.GuildSettings' });
  });

  it('derived 嵌套面:dict/list/tuple 值的键访问与整数下标', () => {
    const out = access([
      "raw = {'outer': {'a': 1}, 'lst': [1, 2], 'tup': (1, 2)}",
      'd = raw',
      "n = d['outer']",
      "na = d['outer']['a']",
      "l = d['lst']",
      'li = d[0]',
      "lk = d['lst']['x']",
      "ti = d['tup'][0]",
      "t = d['tup']",
      "sk = d['outer']['a']['x']"
    ], null);
    expect(out).toHaveLength(8);
    expect(out[0].fieldType).toEqual({
      kind: 'dict',
      fields: new Map([['a', { kind: 'scalar', family: 'int' }]])
    });
    expect(out[1].fieldType).toEqual({ kind: 'scalar', family: 'int' });
    expect(out[2].fieldType).toEqual({ kind: 'list', element: { kind: 'scalar', family: 'int' } });
    expect(out[3].keys).toEqual([]);
    expect(out[3].fieldType).toBeNull();
    expect(out[4].keys).toEqual(['lst', 'x']);
    expect(out[4].fieldType).toBeNull();
    expect(out[5].fieldType).toEqual({ kind: 'scalar', family: 'int' });
    expect(out[6].fieldType).toEqual({ kind: 'tuple', element: { kind: 'scalar', family: 'int' } });
    expect(out[7].keys).toEqual(['outer', 'a', 'x']);
    expect(out[7].fieldType).toBeNull();
  });

  it('get 形态容错:3 实参/关键字/括号默认值/未知默认值/段间空白', () => {
    const out = access([
      'import json',
      "cfg = json.loads('res/guild_configs/g1.json')",
      "a = cfg.get('level', 0, 1)",
      "b = cfg.get(key='level')",
      "c = cfg.get('notice', [0])",
      "d = cfg.get('level', fallback)",
      "e = cfg ['level']"
    ]);
    expect(out).toHaveLength(3);
    expect(out[0].keys).toEqual(['notice']);
    expect(out[0].fieldType).toEqual({ kind: 'scalar', family: 'STRING' });
    expect(out[0].unionWith).toEqual([{ kind: 'list', element: { kind: 'scalar', family: 'int' } }]);
    expect(out[1].keys).toEqual(['level']);
    expect(out[1].fieldType).toEqual({ kind: 'scalar', family: 'UINT32' });
    expect(out[1].unionWith).toEqual([]);
    expect(out[2].keys).toEqual(['level']);
    expect(out[2].fieldType).toEqual({ kind: 'scalar', family: 'UINT32' });
    expect(out[2].unionWith).toEqual([]);
  });

  it('未闭合括号/get:链到此为止不产出位点(行级有状态掩码,各例独立解析)', () => {
    const bracket = access([
      'import json',
      "cfg = json.loads('res/guild_configs/g1.json')",
      "x = cfg['level"
    ]);
    expect(bracket).toHaveLength(0);
    const get = access([
      'import json',
      "cfg = json.loads('res/guild_configs/g1.json')",
      "y = cfg.get('level'"
    ]);
    expect(get).toHaveLength(0);
  });

  it('def 头形态:多参数单行/多行参数表/体末空行', () => {
    const multi = access([
      'import json',
      "cfg = json.loads('res/guild_configs/g1.json')",
      'def read(other, third):',
      "    return cfg['level']"
    ]);
    expect(multi).toHaveLength(1);
    expect(multi[0].fieldType).toEqual({ kind: 'scalar', family: 'UINT32' });

    const header = access([
      'import json',
      "cfg = json.loads('res/guild_configs/g1.json')",
      'def read(a,',
      '         b):',
      "    return cfg['level']",
      '',
      'x = 1'
    ]);
    expect(header).toHaveLength(1);
    expect(header[0].fieldType).toEqual({ kind: 'scalar', family: 'UINT32' });

    const headerShadow = access([
      'import json',
      "cfg = json.loads('res/guild_configs/g1.json')",
      'def read(cfg,',
      '         b):',
      "    return cfg['level']"
    ]);
    expect(headerShadow).toHaveLength(0);
  });

  it('体内遮蔽粗扫:下标写/增量/变异调用/for 目标/with-as/import/del', () => {
    const arms: Array<{ name: string; body: string[] }> = [
      { name: 'subscript write', body: ["    cfg['level'] = 5", "    return cfg['level']"] },
      { name: 'augmented assign', body: ['    cfg += 1', "    return cfg['level']"] },
      { name: 'mutation call', body: ["    cfg.update({'x': 1})", "    return cfg['level']"] },
      { name: 'for target', body: ['    for cfg, b in pairs:', '        pass', "    return cfg['level']"] },
      { name: 'with as', body: ['    with open(p) as cfg:', '        pass', "    return cfg['level']"] },
      { name: 'import', body: ['    import cfg', "    return cfg['level']"] },
      { name: 'del', body: ['    del cfg', "    return cfg['level']"] }
    ];
    for (const arm of arms) {
      const out = access([
        'import json',
        "cfg = json.loads('res/guild_configs/g1.json')",
        'def read():',
        ...arm.body
      ]);
      expect(out, arm.name).toHaveLength(0);
    }
  });

  it('derived 条件合并:键成 optional 仍可声称;推导式开放结构零声称', () => {
    const merged = access([
      'flag = True',
      "raw = {'a': 1} if flag else {'b': 2}",
      'd = raw',
      "x = d['a']",
      "y = d.get('a', 0)"
    ], null);
    expect(merged).toHaveLength(2);
    expect(merged[0].keys).toEqual(['a']);
    expect(merged[0].fieldType).toEqual({ kind: 'scalar', family: 'int' });
    expect(merged[1].unionWith).toEqual([{ kind: 'scalar', family: 'int' }]);

    const open = access([
      'keys = [1]',
      'raw = {k: 1 for k in keys}',
      'd = raw',
      "x = d['a']",
      "y = d.get('a', 0)"
    ], null);
    expect(open).toHaveLength(0);

    const topSpread = access([
      'x = {}',
      "raw = {**x, 'a': 1}",
      'd = raw',
      "n = d['a']"
    ], null);
    expect(topSpread).toHaveLength(0);
  });

  it('derived 嵌套展开值与不可解析值:open observed 键面/unknown 空键面', () => {
    const spread = access([
      'x = {}',
      "raw = {'outer': {**x, 'a': 1}}",
      'd = raw',
      "n = d['outer']"
    ], null);
    expect(spread).toHaveLength(1);
    expect(spread[0].fieldType).toEqual({
      kind: 'dict',
      fields: new Map([['a', { kind: 'scalar', family: 'int' }]])
    });

    const hex = access([
      "raw = {'x': 0x1F}",
      'd = raw',
      "v = d['x']"
    ], null);
    expect(hex).toHaveLength(1);
    expect(hex[0].fieldType).toEqual({ kind: 'dict', fields: new Map() });
  });
});
