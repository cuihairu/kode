import { describe, expect, it } from 'vitest';
import { buildEntityTypeStubPlan } from '../src/entityTypeStubs';
import type { CustomTypeInfo } from '../src/definitionWorkspace';
import type { EntityMapping } from '../src/entityMapping';

const customType: CustomTypeInfo = {
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

const avatarMapping = {
  name: 'Avatar',
  defFile: '/ws/scripts/entity_defs/Avatar.def',
  pythonFile: '/ws/scripts/entity/Avatar.py',
  pythonFiles: ['/ws/scripts/entity/Avatar.py'],
  properties: {
    profile: { defFile: '/ws/scripts/entity_defs/Avatar.def', line: 24 }
  },
  methods: {},
  propertyDefinitions: [{
    defFile: '/ws/scripts/entity_defs/Avatar.def',
    line: 24,
    identity: { symbolName: 'profile' },
    domains: [],
    persistent: false,
    typeName: 'ITEM_INFO'
  }]
} as unknown as EntityMapping;

const guardMapping = {
  name: 'Guard',
  defFile: '/ws/scripts/entity_defs/Guard.def',
  pythonFile: '/ws/scripts/cell/Guard.py',
  pythonFiles: ['/ws/scripts/cell/Guard.py'],
  properties: {},
  methods: {
    respawn: [{
      defFile: '/ws/scripts/entity_defs/Guard.def',
      line: 17,
      section: 'CellMethods',
      exposed: true,
      declaredArgs: ['UINT32']
    }]
  }
} as unknown as EntityMapping;

describe('buildEntityTypeStubPlan', () => {
  it('creates per-entity declarations for custom .def property types', () => {
    const plan = buildEntityTypeStubPlan([avatarMapping], [customType]);
    expect(plan.entries).toEqual([{
      entity: 'Avatar',
      properties: [{
        name: 'profile',
        annotation: 'ITEM_INFO',
        customTypeLine: 8,
        sourceLine: 24
      }],
      methods: []
    }]);
    expect(plan.content).toContain('class Avatar:');
    expect(plan.content).toContain('# source: .def:24 -> types.xml:8');
    expect(plan.content).toContain('    profile: ITEM_INFO');
  });

  it('adds per-section methods and built-in argument annotations', () => {
    const plan = buildEntityTypeStubPlan([guardMapping], []);
    expect(plan.entries).toEqual([{
      entity: 'Guard',
      properties: [],
      methods: [{
        name: 'respawn',
        args: ['UINT32'],
        section: 'CellMethods',
        exposed: true,
        sourceLine: 17
      }]
    }]);
    expect(plan.content).toContain('class Guard:');
    expect(plan.content).toContain('# source: .def:17 (CellMethods)');
    expect(plan.content).toContain('def respawn(arg1: int) -> None: ...');
  });

  it('returns no content when neither properties nor methods are declared', () => {
    expect(buildEntityTypeStubPlan([], [customType]).content).toBeNull();
  });
});
