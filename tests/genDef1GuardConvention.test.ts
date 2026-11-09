import { describe, expect, it } from 'vitest';
import {
  buildEntityTypeStubLineMap,
  buildEntityTypeStubPlan
} from '../src/entityTypeStubs';
import { buildPythonTypeStubPlan } from '../src/pythonTypeStubs';
import {
  buildEntityPartPythonContent,
  type EntityPropertyTemplate
} from '../src/backend/entityWizard';
import { KBEngineCodeGenerator } from '../src/codeGenerator';
import { generatePythonContent } from '../src/backend/codeGeneratorRender';
import type { CustomTypeInfo } from '../src/definitionWorkspace';
import type { EntityMapping } from '../src/entityMapping';

/**
 * GEN-DEF-1(用户令 2026-11-02,源码已核实):__init__ 初始化守卫口径——
 * `if self.<prop> is None:`(防手工改库/迁移缺列/外部 delattr/stub 脱离引擎);
 * 仅对 FIXED_DICT/ARRAY 等引用型生成;简单类型不生成;禁 `if not self.<prop>:`
 * (falsy 判断会把引擎合法默认 0/""/[] 误判并重建,引用失效)。
 * 本文件按此口径锁生成器:entity_types.pyi 实体类与 codeGenerator 实体脚本。
 */

// private 生成器经实例直调(与 tests/codeGenerator.test.ts 同款口径)
const internals = new KBEngineCodeGenerator({} as never) as unknown as {
  generatePythonContent: (
    entity: {
      config: { name: string; hasBase?: boolean; hasCell?: boolean; hasClient?: boolean };
      baseProperties?: Array<{ name: string; type: string; flags: string }>;
      cellProperties?: Array<{ name: string; type: string; flags: string }>;
      clientProperties?: Array<{ name: string; type: string; flags: string }>;
    },
    part: 'base' | 'cell' | 'client'
  ) => string;
};

const fixedDictType: CustomTypeInfo = {
  name: 'ITEM_INFO',
  filePath: '/ws/scripts/entity_defs/types.xml',
  line: 8,
  implementedByLine: 8,
  startOffset: 0,
  endOffset: 1,
  aliasType: 'FIXED_DICT',
  rawValue: 'FIXED_DICT',
  structure: { name: 'FIXED_DICT', rawValue: 'FIXED_DICT', children: [], line: 8 },
  properties: [{ name: 'ownerId', typeName: 'PLAYER_ID', line: 9, typeLine: 10 }]
};

const plainAlias: CustomTypeInfo = {
  ...fixedDictType,
  name: 'PLAYER_ID',
  aliasType: 'UINT32',
  rawValue: 'UINT32',
  structure: { name: 'UINT32', rawValue: 'UINT32', children: [], line: 2 },
  properties: []
};

const mappingOf = (
  entity: string,
  properties: Record<string, { line: number }>,
  definitions: Array<{ name: string; line: number; typeName: string }>
) => ({
  name: entity,
  defFile: `/ws/scripts/entity_defs/${entity}.def`,
  pythonFile: `/ws/scripts/entity/${entity}.py`,
  pythonFiles: [`/ws/scripts/entity/${entity}.py`],
  properties,
  methods: {},
  propertyDefinitions: definitions.map(definition => ({
    defFile: `/ws/scripts/entity_defs/${entity}.def`,
    line: definition.line,
    identity: { symbolName: definition.name },
    domains: [],
    persistent: false,
    typeName: definition.typeName
  }))
}) as unknown as EntityMapping;

const avatarMapping = mappingOf(
  'Avatar',
  { profile: { line: 24 } },
  [{ name: 'profile', line: 24, typeName: 'ITEM_INFO' }]
);

const arrayMapping = mappingOf(
  'Soldier',
  {
    foo: { line: 30 },
    'foo[]': { line: 30 }
  },
  [
    { name: 'foo', line: 30, typeName: 'ARRAY' },
    { name: 'foo[]', line: 30, typeName: 'ITEM_INFO' }
  ]
);

const warriorMapping = mappingOf(
  'Warrior',
  { hp: { line: 12 } },
  [{ name: 'hp', line: 12, typeName: 'UINT32' }]
);

/** 成环别名(pythonTypeStubs 口径:整链不发射 → 实体侧诚实落 Any) */
const cyclicTypes: CustomTypeInfo[] = [
  {
    ...fixedDictType,
    name: 'CY_A',
    aliasType: 'CY_B',
    rawValue: 'CY_B',
    structure: { name: 'CY_B', rawValue: 'CY_B', children: [], line: 1 },
    properties: []
  },
  {
    ...fixedDictType,
    name: 'CY_B',
    aliasType: 'CY_A',
    rawValue: 'CY_A',
    structure: { name: 'CY_A', rawValue: 'CY_A', children: [], line: 2 },
    properties: []
  }
];

describe('GEN-DEF-1: entity_types.pyi 实体类 __init__ is None 守卫', () => {
  it('FIXED_DICT 属性生成 is None 守卫', () => {
    const plan = buildEntityTypeStubPlan([avatarMapping], [fixedDictType]);
    expect(plan.content).toContain('    profile: ITEM_INFO');
    expect(plan.content).toContain('    def __init__(self) -> None:');
    expect(plan.content).toContain('        if self.profile is None:');
    expect(plan.content).toContain('            self.profile = {}');
    // 守卫在属性声明之后(类体:属性面 → __init__)
    expect(plan.content!.indexOf('    profile: ITEM_INFO'))
      .toBeLessThan(plan.content!.indexOf('    def __init__(self) -> None:'));
  });

  it('ARRAY 属性同口径守卫(FixedArray → [] 复位)', () => {
    const plan = buildEntityTypeStubPlan([arrayMapping], [fixedDictType]);
    expect(plan.content).toContain('    foo: FixedArray[ITEM_INFO]');
    expect(plan.content).toContain('        if self.foo is None:');
    expect(plan.content).toContain('            self.foo = []');
  });

  it('简单类型无守卫、不生成空 __init__', () => {
    const plan = buildEntityTypeStubPlan([warriorMapping], [fixedDictType]);
    expect(plan.content).toContain('    hp: int');
    expect(plan.content).not.toContain('__init__');
    expect(plan.content).not.toContain('is None');
  });

  it('poisoned FIXED_DICT 落 Any 后按简单类型处理(不守卫)', () => {
    const poisoned = mappingOf(
      'Trap',
      { profile: { line: 24 } },
      [{ name: 'profile', line: 24, typeName: 'CY_A' }]
    );
    const plan = buildEntityTypeStubPlan([poisoned], cyclicTypes);
    expect(plan.content).toContain('    profile: Any');
    expect(plan.content).not.toContain('if self.profile is None:');
    expect(plan.content).not.toContain('__init__');
  });

  it('守卫不漂移属性行映射', () => {
    const plan = buildEntityTypeStubPlan([avatarMapping], [fixedDictType]);
    // 行映射与 plan.content 同语境(同 customTypeModules → 同头部导入),索引才可比
    const modules = new Map([['ITEM_INFO', 'kbe_types']]);
    const lineMap = buildEntityTypeStubLineMap(plan.entries, [fixedDictType], modules);
    const mapped = lineMap?.propertyLines.get('Avatar')?.profile;
    expect(mapped).toBeDefined();
    expect(plan.content!.split('\n')[mapped!]).toBe('    profile: ITEM_INFO');
    // 守卫段在属性行之后:属性行索引不受 __init__ 守卫影响(同一渲染内复核)
    const withoutGuards = plan.entries.map(entry => ({
      ...entry,
      properties: entry.properties.map(property => {
        const { guardNoneEmpty: _dropped, ...rest } = property;
        return rest;
      })
    }));
    const baselineMap = buildEntityTypeStubLineMap(withoutGuards, [fixedDictType], modules);
    expect(baselineMap?.propertyLines.get('Avatar')?.profile).toBe(mapped);
  });

  it('混合实体:只有容器属性守卫,其余属性不进 __init__', () => {
    const mixed = mappingOf(
      'Hero',
      {
        hp: { line: 5 },
        talent: { line: 6 },
        'talent[]': { line: 6 },
        tree: { line: 7 }
      },
      [
        { name: 'hp', line: 5, typeName: 'UINT32' },
        { name: 'talent', line: 6, typeName: 'ARRAY' },
        { name: 'talent[]', line: 6, typeName: 'TALENT_NODE' },
        { name: 'tree', line: 7, typeName: 'ITEM_INFO' }
      ]
    );
    const talentNode: CustomTypeInfo = {
      ...fixedDictType,
      name: 'TALENT_NODE',
      aliasType: 'UINT32',
      rawValue: 'UINT32',
      structure: { name: 'UINT32', rawValue: 'UINT32', children: [], line: 3 },
      properties: []
    };
    const plan = buildEntityTypeStubPlan([mixed], [fixedDictType, talentNode, plainAlias]);
    expect(plan.content).toContain('        if self.talent is None:');
    expect(plan.content).toContain('            self.talent = []');
    expect(plan.content).toContain('        if self.tree is None:');
    expect(plan.content).toContain('            self.tree = {}');
    expect(plan.content).not.toContain('if self.hp is None');
  });

  it('kbe_types.pyi TypedDict/别名不生成 __init__ 守卫(口径只覆盖实体类)', () => {
    const plan = buildPythonTypeStubPlan([fixedDictType, plainAlias]);
    expect(plan.content).not.toContain('__init__');
    expect(plan.content).not.toContain('is None');
  });

  it('ARRAY 别名属性同口径守卫(别名链解析到容器)', () => {
    // 用户令口径「FIXED_DICT/ARRAY 等引用型」含命名别名:ROOM_LIST 别名
    // ARRAY<of UINT32>,kbe_types 发射 ROOM_LIST = FixedArray[int],运行时
    // 容器是引擎 FixedArray——实体侧必须同守卫,不得因「注解是别名名」漏守。
    const arrayAlias: CustomTypeInfo = {
      ...fixedDictType,
      name: 'ROOM_LIST',
      aliasType: 'ARRAY',
      rawValue: 'ARRAY',
      structure: { name: 'ARRAY', rawValue: 'ARRAY', children: [], line: 4 },
      properties: []
    };
    const mapping = mappingOf(
      'Gatekeeper',
      { rooms: { line: 11 } },
      [{ name: 'rooms', line: 11, typeName: 'ROOM_LIST' }]
    );
    const plan = buildEntityTypeStubPlan([mapping], [arrayAlias, plainAlias]);
    expect(plan.content).toContain('    rooms: ROOM_LIST');
    expect(plan.content).toContain('        if self.rooms is None:');
    expect(plan.content).toContain('            self.rooms = []');
  });

  it('FIXED_DICT 别名(别名指向命名类型)同口径守卫', () => {
    // 别名链 CHAR_PROFILE → ITEM_INFO(FIXED_DICT):kbe_types 发射
    // CHAR_PROFILE = ITEM_INFO,运行时 FixedDict——实体侧同守卫 '{}'.
    const dictAlias: CustomTypeInfo = {
      ...fixedDictType,
      name: 'CHAR_PROFILE',
      aliasType: 'ITEM_INFO',
      rawValue: 'ITEM_INFO',
      structure: { name: 'ITEM_INFO', rawValue: 'ITEM_INFO', children: [], line: 5 },
      properties: []
    };
    const mapping = mappingOf(
      'Knight',
      { profile: { line: 13 } },
      [{ name: 'profile', line: 13, typeName: 'CHAR_PROFILE' }]
    );
    const plan = buildEntityTypeStubPlan([mapping], [fixedDictType, dictAlias]);
    expect(plan.content).toContain('    profile: CHAR_PROFILE');
    expect(plan.content).toContain('        if self.profile is None:');
    expect(plan.content).toContain('            self.profile = {}');
  });

  it('简单别名(UINT32)不守卫(别名链解析到简单类型)', () => {
    const mapping = mappingOf(
      'Squire',
      { hp: { line: 9 } },
      [{ name: 'hp', line: 9, typeName: 'PLAYER_ID' }]
    );
    const plan = buildEntityTypeStubPlan([mapping], [fixedDictType, plainAlias]);
    expect(plan.content).toContain('    hp: PLAYER_ID');
    expect(plan.content).not.toContain('__init__');
  });
});

describe('GEN-DEF-1: codeGenerator 实体脚本 __init__ 守卫', () => {
  it('base 段 ARRAY 属性生成 is None 守卫,简单类型不守卫', () => {
    const py = generatePythonContent({
      config: { name: 'Hero', hasBase: true, hasCell: true },
      baseProperties: [
        { name: 'skills', type: 'ARRAY<of>UINT32</of>', flags: 'BASE' },
        { name: 'hp', type: 'UINT32', flags: 'BASE' }
      ]
    }, 'base');
    expect(py).toContain('    def __init__(self):');
    expect(py).toContain('        KBEngine.Entity.__init__(self)');
    expect(py).toContain('        if self.skills is None:');
    expect(py).toContain('            self.skills = []');
    expect(py).not.toContain('if self.hp is None');
  });

  it('cell 段 FIXED_DICT 命名类型属性生成 is None 守卫', () => {
    const py = generatePythonContent({
      config: { name: 'Hero', hasBase: true, hasCell: true },
      cellProperties: [
        { name: 'state', type: 'HeroState', flags: 'CELL_PUBLIC' },
        { name: 'level', type: 'UINT32', flags: 'CELL_PUBLIC' }
      ]
    }, 'cell');
    expect(py).toContain('        if self.state is None:');
    expect(py).toContain('            self.state = {}');
    expect(py).not.toContain('if self.level is None');
  });

  it('守卫只落在该属性所在段(段间不越域)', () => {
    const base = generatePythonContent({
      config: { name: 'Hero', hasBase: true, hasCell: true },
      baseProperties: [{ name: 'skills', type: 'ARRAY<of>UINT32</of>', flags: 'BASE' }],
      cellProperties: [{ name: 'state', type: 'HeroState', flags: 'CELL_PUBLIC' }]
    }, 'base');
    expect(base).toContain('if self.skills is None:');
    expect(base).not.toContain('if self.state is None');
    const cell = generatePythonContent({
      config: { name: 'Hero', hasBase: true, hasCell: true },
      baseProperties: [{ name: 'skills', type: 'ARRAY<of>UINT32</of>', flags: 'BASE' }],
      cellProperties: [{ name: 'state', type: 'HeroState', flags: 'CELL_PUBLIC' }]
    }, 'cell');
    expect(cell).toContain('if self.state is None:');
    expect(cell).not.toContain('if self.skills is None');
  });

  it('无容器属性时保持原骨架(不生成空守卫)', () => {
    const py = generatePythonContent({
      config: { name: 'Ghost', hasBase: true },
      baseProperties: [{ name: 'hp', type: 'UINT32', flags: 'BASE' }]
    }, 'base');
    expect(py).not.toContain('is None');
  });
});

describe('GEN-DEF-1: 全生成物无 `if not self.` 形态守卫', () => {
  const wizardInputs: Array<{ template: EntityPropertyTemplate }> = [
    { template: 'simple' },
    { template: 'fixedArray' },
    { template: 'fixedDict' }
  ];

  const buildCorpus = (): string[] => {
    const corpus: string[] = [];
    // entity_types.pyi
    corpus.push(
      buildEntityTypeStubPlan([avatarMapping, arrayMapping, warriorMapping], [fixedDictType, plainAlias])
        .content ?? ''
    );
    // kbe_types.pyi
    corpus.push(buildPythonTypeStubPlan([fixedDictType, plainAlias]).content ?? '');
    // 新建实体向导三模板 × 三段
    for (const { template } of wizardInputs) {
      for (const part of ['base', 'cell', 'client'] as const) {
        corpus.push(buildEntityPartPythonContent({
          name: 'Hero',
          hasBase: true,
          hasCell: true,
          hasClient: true,
          propertyTemplate: template,
          description: ''
        }, part));
      }
    }
    // codeGenerator 实体脚本三段
    for (const part of ['base', 'cell', 'client'] as const) {
      corpus.push(generatePythonContent({
        config: { name: 'Hero', hasBase: true, hasCell: true, hasClient: true },
        baseProperties: [
          { name: 'skills', type: 'ARRAY<of>UINT32</of>', flags: 'BASE' },
          { name: 'hp', type: 'UINT32', flags: 'BASE' }
        ],
        cellProperties: [{ name: 'state', type: 'HeroState', flags: 'CELL_PUBLIC' }]
      }, part));
    }
    return corpus;
  };

  it('生成物语料零 `if not self.`', () => {
    const corpus = buildCorpus();
    expect(corpus.length).toBeGreaterThan(10);
    for (const document of corpus) {
      expect(document).not.toMatch(/if not self\./);
    }
  });

  it('语料内容器守卫全为 is None 形态', () => {
    for (const document of buildCorpus()) {
      for (const line of document.split('\n')) {
        if (/^\s*if self\..+:$/.test(line)) {
          expect(line.trim()).toMatch(/^if self\.[A-Za-z_][A-Za-z0-9_]* is None:$/);
        }
      }
    }
  });

  it('向导生成物守卫形态回归(fixedArray base / fixedDict cell)', () => {
    const base = buildEntityPartPythonContent({
      name: 'Hero', hasBase: true, hasCell: true, hasClient: true,
      propertyTemplate: 'fixedArray', description: ''
    }, 'base');
    expect(base).toContain('\t\tif self.skillIds is None:');
    const cell = buildEntityPartPythonContent({
      name: 'Hero', hasBase: true, hasCell: true, hasClient: true,
      propertyTemplate: 'fixedDict', description: ''
    }, 'cell');
    expect(cell).toContain('\t\tif self.state is None:');
  });
});
