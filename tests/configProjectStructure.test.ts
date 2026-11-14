/**
 * KSEM-CFG-08 项目配置结构提取(纯核心)。
 *
 * 面分组:显式 schema 条目优先(条目序在前/字段面/ref)/可证明读取
 * 约束(readers 登记,json.loads 与 json.load(open) 两 loader 面)/
 * 路径绑定冲突显式化(同表多 glob type 分歧 → pathConflicts + 来源,
 * 命中条目 readers 照登)/binding-type 分歧(同 glob 跨表不同 type →
 * 开放 + 冲突)/静态构造(字面量字段面/动态 key 开放/unknown 不入)/
 * 跨文件同名(形状一致合并来源/分歧开放+冲突+一致键保留)/诚实边界
 * (未绑定路径零声称/变量路径不入/schema=null 仅静态面/分歧键摘除)。
 * 零 vscode 依赖。
 */
import { describe, it, expect } from 'vitest';
import {
  parseSerializationSchema,
  type SerializationSchema
} from '../src/backend/jsonChainPropagation';
import {
  deriveProjectConfigStructure,
  type ProjectConfigStructure
} from '../src/backend/configProjectStructure';

const SCHEMA_JSON = {
  schema_version: 1,
  types: {
    'proj.guild.GuildConfig': {
      fields: { level: 'UINT32', members: ['UINT64'], settings: 'proj.guild.Settings' }
    },
    'proj.guild.Settings': { fields: { cap: 'UINT16' } },
    'proj.world.WorldConfig': { fields: { name: 'STRING' } }
  },
  bindings: {
    'json.loads': [{ path: 'res/guild/*.json', type: 'proj.guild.GuildConfig' }],
    'json.load': [{ path: 'res/world/*.json', type: 'proj.world.WorldConfig' }]
  }
};

const schema = (): SerializationSchema | null =>
  parseSerializationSchema(JSON.stringify(SCHEMA_JSON)).schema;

const run = (
  files: Array<{ file: string; text: string }>,
  s: SerializationSchema | null = schema()
): ProjectConfigStructure => deriveProjectConfigStructure(files, s);

const literal = (rows: string[]): { file: string; text: string } => ({
  file: rows[0] ?? 'a.py',
  text: rows.join('\n')
});

describe('KSEM-CFG-08 project config structure', () => {
  it('explicit schema bindings come first with mapped field types and refs', () => {
    const out = run([]);
    expect(out.entries).toHaveLength(2);
    const guild = out.entries[0];
    expect(guild.key).toBe('res/guild/*.json');
    expect(guild.tier).toBe('explicit-schema');
    expect(guild.face).toBe('path-binding');
    expect(guild.typeId).toBe('proj.guild.GuildConfig');
    expect(guild.fields.get('level')).toEqual({ kind: 'scalar', family: 'UINT32' });
    expect(guild.fields.get('members')).toEqual({
      kind: 'list',
      element: { kind: 'scalar', family: 'UINT64' }
    });
    expect(guild.fields.get('settings')).toEqual({ kind: 'ref', type: 'proj.guild.Settings' });
    expect(guild.open).toBe(false);
    expect(guild.sources).toEqual([{ file: '.kbengine/serialization.json', line: null }]);
    expect(guild.readers).toEqual([]);
    expect(guild.conflicts).toEqual([]);
  });

  it('provable loads reads register readers on the bound glob entry', () => {
    const out = run([
      { file: 'guild_loader.py', text: "import json\ncfg = json.loads('res/guild/g1.json')" }
    ]);
    const guild = out.entries.find((e) => e.key === 'res/guild/*.json')!;
    expect(guild.readers).toEqual([{ file: 'guild_loader.py', line: 1 }]);
    expect(out.pathConflicts).toEqual([]);
  });

  it('json.load(open(literal)) reads register readers via the load table', () => {
    const out = run([
      { file: 'world_loader.py', text: "import json\ncfg = json.load(open('res/world/w1.json'))" }
    ]);
    const world = out.entries.find((e) => e.key === 'res/world/*.json')!;
    expect(world.readers).toEqual([{ file: 'world_loader.py', line: 1 }]);
  });

  it('same path matching multiple globs with different types is an explicit conflict', () => {
    const wide = parseSerializationSchema(
      JSON.stringify({
        ...SCHEMA_JSON,
        bindings: {
          'json.loads': [
            { path: 'res/*.json', type: 'proj.world.WorldConfig' },
            { path: 'res/guild/*.json', type: 'proj.guild.GuildConfig' }
          ],
          'json.load': []
        }
      })
    ).schema;
    const out = run(
      [{ file: 'a.py', text: "import json\ncfg = json.loads('res/guild/g1.json')" }],
      wide
    );
    expect(out.pathConflicts).toHaveLength(1);
    const c = out.pathConflicts[0];
    expect(c.path).toBe('res/guild/g1.json');
    expect(c.loader).toBe('json.loads');
    expect(c.matches).toEqual([
      { glob: 'res/*.json', typeId: 'proj.world.WorldConfig' },
      { glob: 'res/guild/*.json', typeId: 'proj.guild.GuildConfig' }
    ]);
    expect(c.sources).toEqual([{ file: 'a.py', line: 1 }]);
    // 命中事实为真:两个条目的 readers 照登,冲突只是显式报出
    for (const glob of ['res/*.json', 'res/guild/*.json']) {
      const e = out.entries.find((x) => x.key === glob)!;
      expect(e.readers).toEqual([{ file: 'a.py', line: 1 }]);
    }
  });

  it('same glob declared with different types across loader tables stays open', () => {
    const split = parseSerializationSchema(
      JSON.stringify({
        ...SCHEMA_JSON,
        bindings: {
          'json.loads': [{ path: 'res/guild/*.json', type: 'proj.guild.GuildConfig' }],
          'json.load': [{ path: 'res/guild/*.json', type: 'proj.world.WorldConfig' }]
        }
      })
    ).schema;
    const out = run([], split);
    expect(out.entries).toHaveLength(1);
    const e = out.entries[0];
    expect(e.typeId).toBeNull();
    expect(e.open).toBe(true);
    expect(e.fields.size).toBe(0);
    expect(e.conflicts).toHaveLength(1);
    expect(e.conflicts[0].kind).toBe('binding-type');
    expect(e.conflicts[0].typeIds).toEqual(['proj.guild.GuildConfig', 'proj.world.WorldConfig']);
  });

  it('static dict literal becomes a construction entry with value types', () => {
    const out = run([{ file: 'a.py', text: "CFG = {'a': 1, 'b': 'x'}" }], null);
    expect(out.entries).toHaveLength(1);
    const e = out.entries[0];
    expect(e.key).toBe('CFG');
    expect(e.tier).toBe('static-construction');
    expect(e.face).toBe('dict-literal');
    expect(e.open).toBe(false);
    expect(e.fields.get('a')).toEqual({ kind: 'scalar', family: 'int' });
    expect(e.fields.get('b')).toEqual({ kind: 'scalar', family: 'str' });
    expect(e.sources).toEqual([{ file: 'a.py', line: null }]);
    expect(e.conflicts).toEqual([]);
  });

  it('dynamic keys keep the entry open with observed keys as evidence', () => {
    const out = run([
      { file: 'a.py', text: 'CFG = {\'a\': 1}\nk = "dyn"\nCFG[k] = 1' }
    ], null);
    expect(out.entries).toHaveLength(1);
    const e = out.entries[0];
    expect(e.key).toBe('CFG');
    expect(e.open).toBe(true);
    expect(e.fields.get('a')).toEqual({ kind: 'scalar', family: 'int' });
    expect(e.conflicts).toEqual([]);
  });

  it('same name with identical shapes across files merges sources', () => {
    const out = run([
      { file: 'a.py', text: "CFG = {'x': 1}" },
      { file: 'b.py', text: "CFG = {'x': 2}" }
    ], null);
    expect(out.entries).toHaveLength(1);
    const e = out.entries[0];
    expect(e.open).toBe(false);
    expect(e.fields.get('x')).toEqual({ kind: 'scalar', family: 'int' });
    expect(e.sources).toEqual([
      { file: 'a.py', line: null },
      { file: 'b.py', line: null }
    ]);
  });

  it('divergent shapes across files stay open with both sources and drop the key', () => {
    const out = run([
      { file: 'a.py', text: "CFG = {'a': 1}" },
      { file: 'b.py', text: "CFG = {'a': 's'}" }
    ], null);
    expect(out.entries).toHaveLength(1);
    const e = out.entries[0];
    expect(e.open).toBe(true);
    expect(e.fields.size).toBe(0); // a 键类型分歧 → 摘除,不取首见
    expect(e.conflicts).toHaveLength(1);
    expect(e.conflicts[0].kind).toBe('literal-shape');
    expect(e.conflicts[0].sources.map((s) => s.file)).toEqual(['a.py', 'b.py']);
  });

  it('agreed keys survive shape divergence; keys missing on one side are dropped', () => {
    const out = run([
      { file: 'a.py', text: "CFG = {'x': 1, 'y': 2}" },
      { file: 'b.py', text: "CFG = {'x': 1, 'z': 's'}" }
    ], null);
    const e = out.entries[0];
    expect(e.open).toBe(true);
    expect([...e.fields.keys()]).toEqual(['x']);
    expect(e.conflicts).toHaveLength(1);
  });

  it('reads against unbound paths make no claim anywhere', () => {
    const out = run([
      { file: 'a.py', text: "import json\ncfg = json.loads('res/other/x.json')" }
    ]);
    expect(out.pathConflicts).toEqual([]);
    for (const e of out.entries) {
      expect(e.readers).toEqual([]);
    }
  });

  it('variable paths, kwargs-only loads, and cross-line calls are not reads', () => {
    const out = run([
      {
        file: 'a.py',
        text: [
          'import json',
          "p = 'res/guild/g1.json'",
          'cfg = json.loads(p)',
          "cfg2 = json.loads('res/guild/g1.json', cls=object)",
          'cfg3 = json.loads(',
          "    'res/guild/g1.json')"
        ].join('\n')
      }
    ]);
    for (const e of out.entries) {
      expect(e.readers).toEqual([]);
    }
    expect(out.pathConflicts).toEqual([]);
  });

  it('schema=null keeps only the static construction face', () => {
    const out = run(
      [
        { file: 'a.py', text: "import json\ncfg = json.loads('res/guild/g1.json')\nCFG = {'a': 1}" }
      ],
      null
    );
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0].key).toBe('CFG');
    expect(out.entries[0].tier).toBe('static-construction');
    expect(out.pathConflicts).toEqual([]);
  });

  it('names whose module-scope end state is unknown are not structure evidence', () => {
    const out = run([{ file: 'a.py', text: 'CFG = build_config()' }], null);
    expect(out.entries).toEqual([]);
  });
});

// KSEM-CFG-10 加宽面:pathReads 路径级读取点(与 entries 的 glob 聚合
// readers 区分:改单个 json 文件的影响只列读它的点)。
describe('KSEM-CFG-08 pathReads(path-level readers, CFG-10 消费)', () => {
  it('covered reads are registered per path with sources; uncovered reads stay out', () => {
    const out = run([
      {
        file: 'a.py',
        text: "import json\nc1 = json.loads('res/guild/g1.json')\nc2 = json.loads('res/guild/g2.json')"
      },
      { file: 'b.py', text: "import json\nx = json.load(open('res/world/w1.json'))" }
    ]);
    expect(out.pathReads).toEqual([
      {
        path: 'res/guild/g1.json',
        loader: 'json.loads',
        sources: [{ file: 'a.py', line: 1 }]
      },
      {
        path: 'res/guild/g2.json',
        loader: 'json.loads',
        sources: [{ file: 'a.py', line: 2 }]
      },
      {
        path: 'res/world/w1.json',
        loader: 'json.load',
        sources: [{ file: 'b.py', line: 1 }]
      }
    ]);
    expect(out.uncoveredReads).toEqual([]);
  });

  it('uncovered reads are not path evidence (zero claim stays in uncoveredReads)', () => {
    const out = run([
      { file: 'a.py', text: "import json\nx = json.loads('res/other/x.json')" }
    ]);
    expect(out.pathReads).toEqual([]);
    expect(out.uncoveredReads).toHaveLength(1);
  });

  it('schema=null makes no path-level claim at all', () => {
    const out = run(
      [{ file: 'a.py', text: "import json\ncfg = json.loads('res/guild/g1.json')" }],
      null
    );
    expect(out.pathReads).toEqual([]);
    expect(out.uncoveredReads).toEqual([]);
  });
});
