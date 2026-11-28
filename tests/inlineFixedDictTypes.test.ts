import { describe, expect, it } from 'vitest';

import { extractInlineFixedDictTypes, inlineFixedDictSyntheticName, isInlineFixedDictProperty } from '../src/backend/inlineFixedDictTypes';
import { getDirectChildElement, getDirectChildElements, parseDefDocument } from '../src/backend/defParser';

// Canonical .def shape: properties are tagged by name directly under
// <Properties> (engine loadDefPropertys reads the tag name)
const DEF_TEXT = `<root>
  <Properties>
    <bag>
      <Type>
        FIXED_DICT
        <Properties>
          <slot_list>
            <Type>
              ARRAY
              <of>SKILL_SLOT</of>
            </Type>
          </slot_list>
          <size>
            <Type>UINT16</Type>
            <Default>4</Default>
          </size>
        </Properties>
      </Type>
      <Flags>AllServers</Flags>
      <Persistent>true</Persistent>
      <Identifier>true</Identifier>
    </bag>
    <hp>
      <Type>UINT16</Type>
    </hp>
    <plain>
      <Type>
        FIXED_DICT
        <implementedBy>mods.plain_impl</implementedBy>
      </Type>
    </plain>
  </Properties>
</root>`;

describe('inlineFixedDictTypes', () => {
  const extractAvatarBag = () =>
    extractInlineFixedDictTypes(DEF_TEXT, 'Avatar', '/ws/entity_defs/Avatar.def');

  it('synthesizes registry entries for inline FIXED_DICT properties with def metadata', () => {
    const entries = extractAvatarBag();
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    // Flattened identifier: the registry name doubles as the annotation text
    // and the emitted TypedDict class name (single name form everywhere)
    expect(entry.name).toBe('Avatar_bag');
    expect(entry.aliasType).toBe('FIXED_DICT');
    expect(entry.synthetic).toBe(true);
    expect(entry.filePath).toBe('/ws/entity_defs/Avatar.def');
    expect(entry.line).toBe(3);
    expect(entry.flags).toBe('AllServers');
    expect(entry.persistent).toBe(true);
    expect(entry.identifier).toBe(true);
    expect(entry.pythonFilePath).toBeUndefined();
    // The inline <Properties> children become registry properties (declaration order)
    expect(entry.properties.map(property => property.name)).toEqual(['size', 'slot_list']);
    const size = entry.properties.find(property => property.name === 'size')!;
    expect(size.defaultValue).toBe('4');
    expect(size.typeName).toBe('UINT16');
    const slotList = entry.properties.find(property => property.name === 'slot_list')!;
    expect(slotList.typeStructure?.children.some(child => child.tag === 'of')).toBe(true);
  });

  it('skips non-FD properties and FD without an inline Properties section', () => {
    const entries = extractInlineFixedDictTypes(DEF_TEXT, 'Avatar', 'Avatar.def');
    // 'hp' is builtin; 'plain' is FIXED_DICT but without inline <Properties>
    expect(entries.map(entry => entry.name)).toEqual(['Avatar_bag']);
  });

  it('handles empty and malformed documents without crash', () => {
    expect(extractInlineFixedDictTypes('', 'E', 'E.def')).toEqual([]);
    expect(extractInlineFixedDictTypes('<root/>', 'E', 'E.def')).toEqual([]);
    expect(
      extractInlineFixedDictTypes(
        '<root><Properties><Property><Type>FIXED_DICT<Properties><x><Type>UINT8</Type></x></Properties></Type></Property></Properties></root>',
        'E', 'E.def'
      ).length
    ).toBeGreaterThanOrEqual(0);
  });

  it('unparseable def (mismatched tags) yields no entries instead of throwing', () => {
    // batch111 corpus keeps deliberately broken defs; the rest of the def
    // pipeline tolerates them, so synthetic extraction must too.
    const broken = '<root><Properties></Properties></other>';
    expect(() => parseDefDocument(broken)).toThrow();
    expect(extractInlineFixedDictTypes(broken, 'E', 'E.def')).toEqual([]);
  });

  it('isInlineFixedDictProperty gates on both the FIXED_DICT token and the nested Properties', () => {
    const document = parseDefDocument(DEF_TEXT);
    const section = getDirectChildElement(document.root!, 'Properties')!;
    const list = getDirectChildElements(section);
    expect(list).toHaveLength(3);
    expect(isInlineFixedDictProperty(list[0])).toBe(true);
    expect(isInlineFixedDictProperty(list[1])).toBe(false);
    expect(isInlineFixedDictProperty(list[2])).toBe(false);
  });

  it('synthetic names flatten to legal python identifiers', () => {
    expect(inlineFixedDictSyntheticName('Avatar', 'bag')).toBe('Avatar_bag');
    expect(inlineFixedDictSyntheticName('Avatar', 'bag list')).toBe('Avatar_bag_list');
  });

  it('synthetic entries colliding with declared type names give way', async () => {
    const { filterSyntheticNameCollisions } = await import('../src/definitionWorkspace');
    const declared = [{ name: 'Avatar_bag', filePath: 'types.xml', line: 1, aliasType: 'UINT32', structure: { name: 'x', value: null, children: [] }, properties: [] }];
    const synthetic = [
      { name: 'Avatar_bag', filePath: 'Avatar.def', line: 3, aliasType: 'FIXED_DICT', structure: { name: 'x', value: null, children: [] }, properties: [], synthetic: true },
      { name: 'Monster_bag', filePath: 'Monster.def', line: 5, aliasType: 'FIXED_DICT', structure: { name: 'x', value: null, children: [] }, properties: [], synthetic: true }
    ];
    const kept = filterSyntheticNameCollisions(synthetic as never, declared as never);
    expect(kept.map(info => info.name)).toEqual(['Monster_bag']);
  });

  it('def parse marks inline FIXED_DICT properties (substitution source)', async () => {
    const { parseLocalDefinition } = await import('../src/backend/definitionSemantics');
    const semantics = parseLocalDefinition(DEF_TEXT, 'entity', 'Avatar', '/ws/entity_defs/Avatar.def');
    const byName = new Map(semantics.properties.map(property => [property.name, property]));
    expect(byName.get('bag')?.inlineFixedDict).toBe(true);
    expect(byName.get('hp')?.inlineFixedDict).toBe(false);
    expect(byName.get('plain')?.inlineFixedDict).toBe(false);
  });

  it('stub plan emits synthetic entries as TypedDict classes in the root module', async () => {
    const { buildPythonTypeStubPlan, groupCustomTypesByModule } = await import('../src/pythonTypeStubs');
    const info = extractAvatarBag()[0];
    const plan = buildPythonTypeStubPlan([info], {});
    const classEntry = plan.entries.find(entry => entry.kind === 'class' && entry.name === 'Avatar_bag');
    expect(classEntry).toBeDefined();
    expect((classEntry as { synthetic?: boolean }).synthetic).toBe(true);
    expect(plan.content).toContain('# inline FIXED_DICT');
    expect(plan.content).toContain('class Avatar_bag(TypedDict):');
    expect(plan.content).toContain('    size: int');
    // slot_list is ARRAY of SKILL_SLOT (undeclared here) -> FixedArray[Any]
    expect(plan.content).toContain('    slot_list: FixedArray[Any]');
    expect(plan.skipped).toHaveLength(0);
    // synthetic entries always join the root kbe_types module
    const groups = groupCustomTypesByModule([info], '/ws');
    expect([...groups.keys()]).toEqual(['']);
  });
});
