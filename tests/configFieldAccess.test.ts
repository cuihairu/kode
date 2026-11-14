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
