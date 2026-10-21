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
      }]
    }]);
    expect(plan.content).toContain('class Avatar:');
    expect(plan.content).toContain('# source: .def:24 -> types.xml:8');
    expect(plan.content).toContain('    profile: ITEM_INFO');
  });

  it('returns no content when no properties are declared', () => {
    expect(buildEntityTypeStubPlan([], [customType]).content).toBeNull();
  });
});
