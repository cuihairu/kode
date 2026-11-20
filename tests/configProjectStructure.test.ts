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
// 读取点拒绝面(掩码-原文双判的容错拒绝,CFG-07 同律):
// 变量/f 串/跨行/非 open 形态一律不入(零声称),不猜路径。
//
// 论证为不可达的防御行(不写空账测试):
// - 行 157(掩码判定为串字面量后,原文 isQuotedLiteral 复核失败):
//   pythonCodeLines 的掩码逐字符等宽(blank 保列),掩码串 token 与原文同
//   列区间完全对齐 —— 掩码段 trim 后是 `_+`(整段恰为一个串 token)时,
//   原文同区间就是那个引号串,isQuotedLiteral 必真;前缀(f/r/b)或裸标识符
//   会让掩码段含非 `_` 字符,早在行 148 拒绝。故该守卫对 collectPathReads
//   的两个调用点均为纯防御。
describe('KSEM-CFG-08 path reads rejection face', () => {
  it('string prefixes, f-strings, and r-strings are not provable paths', () => {
    const out = run([
      {
        file: 'a.py',
        text: [
          'import json',
          "cfg = json.loads(f'res/guild/g1.json')",
          "cfg2 = json.loads(r'res/guild/g2.json')",
          "cfg3 = json.loads(b'res/guild/g3.json')"
        ].join('\n')
      }
    ]);
    for (const e of out.entries) {
      expect(e.readers).toEqual([]);
    }
    expect(out.pathReads).toEqual([]);
    expect(out.uncoveredReads).toEqual([]);
  });

  it('json.load(open( split across lines is not a read (single-line v1)', () => {
    const out = run([
      {
        file: 'a.py',
        text: ['import json', 'cfg = json.load(open(', "    'res/world/w1.json'))"].join('\n')
      }
    ]);
    expect(out.pathReads).toEqual([]);
    expect(out.uncoveredReads).toEqual([]);
    for (const e of out.entries) {
      expect(e.readers).toEqual([]);
    }
  });

  it('json.load with a non-open first argument is not a read', () => {
    const out = run([
      { file: 'a.py', text: ['import json', 'cfg = json.load(fp)'].join('\n') },
      { file: 'b.py', text: ['import json', 'cfg = json.load(open(name))'].join('\n') }
    ]);
    expect(out.pathReads).toEqual([]);
    expect(out.uncoveredReads).toEqual([]);
  });

  it('load(open(...)) with a trailing encoding kwarg still is a read', () => {
    const out = run([
      {
        file: 'a.py',
        text: ["import json", "cfg = json.load(open('res/world/w1.json', encoding='utf-8'))"].join('\n')
      }
    ]);
    expect(out.pathReads).toEqual([
      { path: 'res/world/w1.json', loader: 'json.load', sources: [{ file: 'a.py', line: 1 }] }
    ]);
  });
});

// 跨文件同名形状的判等矩阵(sameValueKind/sameFormat/sameKindMap)。
//
// 论证为不可达的防御行(不写空账测试):
// - 行 238(sameFormat 的 unknown 臂)与行 273(fmtKeyKind 的 unknown 兜底):
//   DictFormat 的 `{ kind: 'unknown' }` 变体在整个 dictFormatDerivation
//   里没有生产者 —— resolveShape 只返回 literal / open / null(源码实跑
//   核过),文件内所有 `kind: 'unknown'` 字面量都落在 DictValueKind 侧;
//   故 fmt.kind 只有 'literal'/'open' 两态,行 267/270 已全收口,
//   unknown 臂永假。
// - 行 461(同名合并循环里跳过 unknown 模块形态):deriveDictFormats 因此
//   从不产出该形态,nameRows 里不会出现。
// (注:行 222/223 的 DictValueKind 'unknown' 臂是另一类型,可经
//  `{'x': make()}` 这类不可解析值到达,已在本矩阵钉住;嵌套 dict 的
//  open 形态由 `{**extra}` 开放宇宙表达——推导式作值会让整模块形状
//  判不出来,反而不入表。)
describe('KSEM-CFG-08 static shape comparison matrix', () => {
  const same = (a: string, b: string) => [
    { file: 'a.py', text: a },
    { file: 'b.py', text: b }
  ];

  it('value kind mismatch on the same key is a shape divergence (open + conflict)', () => {
    const out = run(same("CFG = {'x': 1}", "CFG = {'x': [1]}"), null);
    const e = out.entries[0];
    expect(e.open).toBe(true);
    expect(e.fields.size).toBe(0);
    expect(e.conflicts).toHaveLength(1);
    expect(e.conflicts[0].kind).toBe('literal-shape');
  });

  it('unparseable values on both sides agree (unknown is not a divergence)', () => {
    const out = run(same("CFG = {'x': make()}", "CFG = {'x': other()}"), null);
    const e = out.entries[0];
    expect(e.open).toBe(false);
    expect(e.conflicts).toEqual([]);
    expect([...e.fields.keys()]).toEqual(['x']);
  });

  it('sequence element kinds are compared recursively (consistent vs mixed)', () => {
    const consistent = run(same("CFG = {'x': [1]}", "CFG = {'x': [2]}"), null);
    expect(consistent.entries[0].open).toBe(false);
    expect(consistent.entries[0].fields.get('x')).toEqual({
      kind: 'list',
      element: { kind: 'scalar', family: 'int' }
    });

    const diverged = run(same("CFG = {'x': [1]}", "CFG = {'x': [1, 'a']}"), null);
    expect(diverged.entries[0].open).toBe(true);
    expect(diverged.entries[0].conflicts).toHaveLength(1);
  });

  it('tuple literals compare by element kind like lists', () => {
    const out = run(same("CFG = {'t': (1,)}", "CFG = {'t': (2,)}"), null);
    const e = out.entries[0];
    expect(e.open).toBe(false);
    expect([...e.fields.keys()]).toEqual(['t']);
  });

  it('nested dict shapes are compared recursively (same vs diverged)', () => {
    const sameShape = run(same("CFG = {'d': {'k': 1}}", "CFG = {'d': {'k': 2}}"), null);
    expect(sameShape.entries[0].open).toBe(false);
    expect(sameShape.entries[0].fields.size).toBe(1);

    const diverged = run(same("CFG = {'d': {'k': 1}}", "CFG = {'d': {'k': 's'}}"), null);
    expect(diverged.entries[0].open).toBe(true);
    expect(diverged.entries[0].fields.size).toBe(0);
  });

  it('literal vs open on the nested value is a shape divergence', () => {
    // 嵌套 `{**extra}` = 开放宇宙 → 内层格式 open,与字面量格式不同类
    const out = run(
      same("CFG = {'d': {'k': 1}}", "CFG = {'d': {'k': 1, **extra}}"),
      null
    );
    expect(out.entries[0].open).toBe(true);
    expect(out.entries[0].conflicts).toHaveLength(1);
  });

  it('open vs open nested values compare by observed key maps', () => {
    const out = run(
      same("CFG = {'d': {'k': 1, **extra}}", "CFG = {'d': {'k': 2, **extra}}"),
      null
    );
    const e = out.entries[0];
    expect(e.open).toBe(false);
    expect(e.conflicts).toEqual([]);
    expect([...e.fields.keys()]).toEqual(['d']);
  });

  it('different key counts on both sides never merge (size guard)', () => {
    const out = run(same("CFG = {'x': 1}", "CFG = {'x': 1, 'y': 2}"), null);
    const e = out.entries[0];
    expect(e.open).toBe(true);
    expect(e.conflicts).toHaveLength(1);
  });

  it('conditional writes contribute optional keys to the agreed field face', () => {
    const out = run(
      [{
        file: 'a.py',
        text: ["CFG = {'a': 1}", 'if cond:', "    CFG['b'] = 2"].join('\n')
      }],
      null
    );
    const e = out.entries[0];
    expect(e.open).toBe(false);
    expect([...e.fields.keys()]).toEqual(['a', 'b']);
    expect(e.conflicts).toEqual([]);
  });
});

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

// 读面拒绝臂:这些写法**不**构成 path 读取证据。分三类——
// 非字面量首实参 / json.load 首实参不是 open(...) / 跨行调用。
describe('KSEM-CFG-08 read-side rejection arms', () => {
  const noReads = (text: string): void => {
    const out = run([{ file: 'a.py', text }]);
    expect(out.pathReads).toEqual([]);
    expect(out.pathConflicts).toEqual([]);
  };

  it('json.loads first arg that is a bare name is not a read', () => {
    noReads('import json\ncfg = json.loads(_)');
    noReads('import json\ncfg = json.loads(p)');
  });

  it('json.loads first arg that is an f-string or concatenation is not a read', () => {
    // 掩码把串 token 折成 '_',原文复核按段全距切后仍非法 → 拒(容错边界)
    noReads("import json\ncfg = json.loads(f'res/guild/g1.json')");
    noReads("import json\ncfg = json.loads('res/guild/g1.json' 'x')");
  });

  it('json.load whose first arg is not an open(...) call is not a read', () => {
    noReads('import json\ncfg = json.load(p)');
    noReads("import json\ncfg = json.load('res/world/w1.json')");
  });

  it('cross-line json.load calls are not reads (v1 is same-line only)', () => {
    noReads('import json\ncfg = json.load(\n    open("res/world/w1.json"))');
  });

  it('json.load(open(literal, encoding=...)) is still a read (trailing args tolerated)', () => {
    const out = run([
      { file: 'a.py', text: 'import json\ncfg = json.load(open("res/world/w1.json", encoding="utf-8"))' }
    ]);
    expect(out.pathReads).toEqual([
      { path: 'res/world/w1.json', loader: 'json.load', sources: [{ file: 'a.py', line: 1 }] }
    ]);
  });
});

// 值类型等价面:跨文件同名变量合并时,只有**全等**的值类型才算一致键。
// 逐臂钉:种类不同 / 两侧 unknown / list·tuple 元素面 / dict 形状面
// (字面量 vs 开放 / 开放 vs 开放 / 键集大小)/ required∪optional 面。
// 不可达防御臂定性(公共入口不可达,不硬凑):src/backend/configProjectStructure.ts
// 238(sameFormat unknown 形状)/273(fmtKeyKind unknown 形状)/461(模块级 unknown 形状
// 并入)三行都只对 DictFormat 的 {kind:'unknown'} 变体成立;而 deriveDictFormats 的
// 合并路径(:732 返回 DictFormat|null)只产出 literal/open,unknown 基一律 return null
// (空形状声称)。故该变体经公共入口不可产,三行为防御性死码。
describe('KSEM-CFG-08 value-kind agreement arms', () => {
  const merged = (a: string, b: string): ReturnType<typeof run> => {
    return run([{ file: 'a.py', text: a }, { file: 'b.py', text: b }], null);
  };

  it('different value kinds diverge: key dropped, entry open, conflict reported', () => {
    const e = merged("CFG = {'x': 1}", "CFG = {'x': [1]}").entries[0];
    expect(e.open).toBe(true);
    expect(e.fields.size).toBe(0);
    expect(e.conflicts).toHaveLength(1);
  });

  it('unknown on both sides agrees as an empty field face (no guess)', () => {
    const e = merged("CFG = {'x': f(1)}", "CFG = {'x': g(2)}").entries[0];
    expect(e.open).toBe(false);
    expect([...e.fields.keys()]).toEqual(['x']);
    // unknown → 空字段面:键在,类型面不猜
    expect(e.fields.get('x')).toEqual({ kind: 'dict', fields: new Map() });
  });

  it('list elements compare structurally: same ok, empty vs non-empty diverge', () => {
    const same = merged("CFG = {'x': [1]}", "CFG = {'x': [2]}").entries[0];
    expect(same.open).toBe(false);
    expect(same.fields.get('x')).toEqual({
      kind: 'list',
      element: { kind: 'scalar', family: 'int' }
    });
    const both = merged("CFG = {'x': []}", "CFG = {'x': []}").entries[0];
    expect(both.open).toBe(false);
    expect(both.fields.get('x')).toEqual({ kind: 'list', element: null });
    const mixed = merged("CFG = {'x': [1]}", "CFG = {'x': []}").entries[0];
    expect(mixed.open).toBe(true);
    expect(mixed.fields.size).toBe(0);
  });

  it('tuple elements compare structurally like lists', () => {
    const same = merged("CFG = {'x': (1, 2)}", "CFG = {'x': (3, 4)}").entries[0];
    expect(same.open).toBe(false);
    expect(same.fields.get('x')).toEqual({
      kind: 'tuple',
      element: { kind: 'scalar', family: 'int' }
    });
  });

  it('nested dict shapes compare: identical ok, literal-vs-open diverges', () => {
    const same = merged("CFG = {'x': {'k': 1}}", "CFG = {'x': {'k': 2}}").entries[0];
    expect(same.open).toBe(false);
    expect([...same.fields.keys()]).toEqual(['x']);

    const diverged = merged("CFG = {'x': {'k': 1}}", "CFG = {'x': {k: 1}}").entries[0];
    expect(diverged.open).toBe(true);
    expect(diverged.conflicts).toHaveLength(1);
  });

  it('open shapes compare by observed key set: same ok, different size diverges', () => {
    // **spread 让内层 dict 成开放面(观察键集),对拍走 observed 分支
    const same = merged("CFG = {'x': {'k': 1, **r}}", "CFG = {'x': {'k': 2, **r}}").entries[0];
    expect(same.open).toBe(false);
    expect([...same.fields.keys()]).toEqual(['x']);

    const sized = merged(
      "CFG = {'x': {'k': 1, **r}}",
      "CFG = {'x': {'k': 1, 'j': 2, **r}}"
    ).entries[0];
    expect(sized.open).toBe(true);
    expect(sized.fields.size).toBe(0);
  });

  it('optional keys from branch writes participate in the agreement face', () => {
    const e = merged(
      "CFG = {'x': 1}\nif c:\n    CFG['y'] = 2",
      "CFG = {'x': 1}\nif c:\n    CFG['y'] = 3"
    ).entries[0];
    expect(e.open).toBe(false);
    expect([...e.fields.keys()]).toEqual(['x', 'y']);
    expect(e.fields.get('y')).toEqual({ kind: 'scalar', family: 'int' });
  });
});
