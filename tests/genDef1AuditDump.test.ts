import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { beforeAll, afterEach, describe, it } from 'vitest';
import type * as vscode from 'vscode';
import { EntityMappingManager } from '../src/entityMapping';
import { buildEntityTypeStubPlan, buildEntityTypeStubLineMap } from '../src/entityTypeStubs';
import { getCustomTypeInfos } from '../src/definitionWorkspace';
import { buildPythonTypeStubPlan, buildPythonTypeStubLineMap } from '../src/pythonTypeStubs';
import { configurationOverrides, Uri, workspace as stubWorkspace } from './helpers/vscodeStub';
import { resetScanRootCache } from '../src/scanRoots';
import { resolveFantasyRoot } from './helpers/fantasyRoot';
import type { CustomTypeInfo } from '../src/definitionWorkspace';
import type { EntityMapping } from '../src/entityMapping';

/**
 * GEN-DEF-1 重生成 diff 审计(用户令:现有生成物全量重生成 diff 审计):
 * ① 真实夹具 kbengine-demo-assets;② 真实 fantasydemo 树(KODE_FANTASY_ROOT/
 * 同级检出,缺树跳过);③ 合成容器夹具(ARRAY/FIXED_DICT 属性,守卫口径
 * 的唯一预期 diff 面)。产物落 GEN_DEF_1_OUT_DIR 供跨提交 diff。
 */
const OUT_DIR = process.env.GEN_DEF_1_OUT_DIR ?? '/tmp/gen-def-1-audit/current';
const DEMO_ROOT = join(__dirname, 'fixtures/kbengine-demo-assets');
const FANTASY_ROOT = resolveFantasyRoot();

/** 合成容器夹具:与单测同构——FixedDict 自定义类型 + ARRAY/FIXED_DICT/简单三态实体 */
const syntheticFixedDict: CustomTypeInfo = {
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
const syntheticPlainAlias: CustomTypeInfo = {
  ...syntheticFixedDict,
  name: 'PLAYER_ID',
  aliasType: 'UINT32',
  rawValue: 'UINT32',
  structure: { name: 'UINT32', rawValue: 'UINT32', children: [], line: 2 },
  properties: []
};
const syntheticMappingOf = (
  entity: string,
  properties: Record<string, { line: number }>,
  definitions: Array<{ name: string; line: number; typeName: string }>
) => ({
  name: entity,
  defFile: `/ws/scripts/entity_defs/${entity}.def`,
  pythonFile: `/ws/scripts/entity/${entity}.py`,
  pythonFiles: [`/ws/scripts/entity/${entity}.py`],
  properties,
  methods: {
    shout: [{
      defFile: `/ws/scripts/entity_defs/${entity}.def`,
      line: 40,
      section: 'CellMethods' as const,
      exposed: true,
      declaredArgs: ['UINT32']
    }]
  },
  propertyDefinitions: definitions.map(definition => ({
    defFile: `/ws/scripts/entity_defs/${entity}.def`,
    line: definition.line,
    identity: { symbolName: definition.name },
    domains: [],
    persistent: false,
    typeName: definition.typeName
  }))
}) as unknown as EntityMapping;

const syntheticMappings: EntityMapping[] = [
  syntheticMappingOf(
    'Hero',
    {
      hp: { line: 5 },
      talent: { line: 6 },
      'talent[]': { line: 6 },
      profile: { line: 7 }
    },
    [
      { name: 'hp', line: 5, typeName: 'UINT32' },
      { name: 'talent', line: 6, typeName: 'ARRAY' },
      { name: 'talent[]', line: 6, typeName: 'TALENT_NODE' },
      { name: 'profile', line: 7, typeName: 'ITEM_INFO' }
    ]
  )
];
const syntheticTypes: CustomTypeInfo[] = [
  syntheticFixedDict,
  syntheticPlainAlias,
  {
    ...syntheticFixedDict,
    name: 'TALENT_NODE',
    aliasType: 'UINT32',
    rawValue: 'UINT32',
    structure: { name: 'UINT32', rawValue: 'UINT32', children: [], line: 3 },
    properties: []
  }
];

const dumpEntityArtifacts = (
  label: string,
  mappings: readonly EntityMapping[],
  customTypes: readonly CustomTypeInfo[],
  workspaceRoot: string | undefined
): void => {
  const plan = buildEntityTypeStubPlan(mappings, customTypes, { workspaceRoot });
  writeFileSync(join(OUT_DIR, `${label}_entity_types.pyi`), plan.content ?? '');
  const modules = new Map<string, string>();
  const typePlan = buildPythonTypeStubPlan(customTypes);
  for (const entry of typePlan.entries) {
    modules.set(entry.name, 'scripts.entity_defs.kbe_types');
  }
  const lineMap = buildEntityTypeStubLineMap(plan.entries, customTypes, modules);
  writeFileSync(join(OUT_DIR, `${label}_entity_line_map.json`), JSON.stringify(lineMap, null, 2));
  const text = plan.content ?? '';
  writeFileSync(join(OUT_DIR, `${label}_guard_audit.txt`), [
    `is None guards = ${(text.match(/is None/g) ?? []).length}`,
    `if not self. = ${(text.match(/if not self\./g) ?? []).length}`,
    `__init__ blocks = ${(text.match(/def __init__/g) ?? []).length}`
  ].join('\n'));
};

const withWorkspace = async (
  assetsRoot: string,
  defNames: readonly string[],
  action: (mappings: readonly EntityMapping[]) => void
): Promise<void> => {
  configurationOverrides.clear();
  configurationOverrides.set('kbengine', { assetsRoot });
  stubWorkspace.workspaceFolders = [{
    uri: Uri.file(assetsRoot),
    name: 'audit',
    index: 0
  } as vscode.WorkspaceFolder];
  stubWorkspace.findFiles = async () =>
    defNames.map(name => Uri.file(join(assetsRoot, 'scripts/entity_defs', name)));
  resetScanRootCache();
  const manager = new EntityMappingManager({ subscriptions: [] } as vscode.ExtensionContext);
  await new Promise(resolve => setTimeout(resolve, 100));
  action(manager.getAllMappings());
  configurationOverrides.delete('kbengine');
  stubWorkspace.findFiles = async () => [];
  resetScanRootCache();
};

describe('GEN-DEF-1 regeneration audit dump', () => {
  beforeAll(() => {
    rmSync(OUT_DIR, { recursive: true, force: true });
    mkdirSync(OUT_DIR, { recursive: true });
  });

  it('dumps kbengine-demo-assets regeneration', async () => {
    await withWorkspace(DEMO_ROOT, [
      'Account.def', 'Avatar.def', 'Critical.def', 'EliteMonster.def',
      'Monster.def', 'TrainingAvatar.def', 'TrainingMonster.def'
    ], mappings => {
      dumpEntityArtifacts('demo', mappings, getCustomTypeInfos(DEMO_ROOT), DEMO_ROOT);
    });
    const typePlan = buildPythonTypeStubPlan(getCustomTypeInfos(DEMO_ROOT));
    writeFileSync(join(OUT_DIR, 'demo_kbe_types.pyi'), typePlan.content ?? '');
    writeFileSync(
      join(OUT_DIR, 'demo_kbe_types_line_map.json'),
      JSON.stringify(buildPythonTypeStubLineMap(typePlan.entries), null, 2)
    );
  });

  it.skipIf(!FANTASY_ROOT)('dumps fantasydemo real-tree regeneration', async () => {
    const fantasyRoot = FANTASY_ROOT!;
    await withWorkspace(fantasyRoot, [
      'Account.def', 'Avatar.def', 'ClientOnly.def', 'Guard.def', 'Space.def'
    ], mappings => {
      dumpEntityArtifacts('fantasydemo', mappings, getCustomTypeInfos(fantasyRoot), fantasyRoot);
    });
    const typePlan = buildPythonTypeStubPlan(getCustomTypeInfos(fantasyRoot));
    writeFileSync(join(OUT_DIR, 'fantasydemo_kbe_types.pyi'), typePlan.content ?? '');
    writeFileSync(
      join(OUT_DIR, 'fantasydemo_kbe_types_line_map.json'),
      JSON.stringify(buildPythonTypeStubLineMap(typePlan.entries), null, 2)
    );
  });

  it('dumps synthetic container-fixture regeneration', () => {
    dumpEntityArtifacts('synthetic', syntheticMappings, syntheticTypes, undefined);
    const typePlan = buildPythonTypeStubPlan(syntheticTypes);
    writeFileSync(join(OUT_DIR, 'synthetic_kbe_types.pyi'), typePlan.content ?? '');
  });
});
