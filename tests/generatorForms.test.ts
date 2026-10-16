import { describe, expect, it } from 'vitest';
import {
  COMPONENT_SAMPLE_PROPERTY,
  FIXED_DICT_SAMPLE_PROPERTY,
  GENERATOR_FORM_CHOICES,
  GENERATOR_FORM_KINDS,
  PROXY_METHOD_SECTION_CHOICES,
  buildComponentDefContent,
  buildComponentPropertySnippet,
  buildFixedDictTypeContent,
  buildProxyDefContent,
  buildSpaceDefContent,
  buildSpaceRegistrationLine,
  resolveGeneratorFormTarget,
  type GeneratorFormInput
} from '../src/generatorForms';
import type { DefinitionWorkspaceLayout } from '../src/definitionWorkspace';

// 批139(盘点 G7)纯内容层:四种定义形态的文本产物与落点解析。
// 落盘/登记/挂载与命令编排在 tests/generatorFormsFiles.test.ts。

const TS = '2026-10-16T00:00:00.000Z';

const layoutFor = (overrides: Partial<DefinitionWorkspaceLayout> = {}): DefinitionWorkspaceLayout => ({
  workspaceRoot: '/ws',
  entityDefsRoot: '/ws/scripts/entity_defs',
  entityScriptsRoot: '/ws/scripts',
  interfacesRoot: '/ws/scripts/entity_defs/interfaces',
  componentsRoot: '/ws/scripts/entity_defs/components',
  entitiesXmlPath: '/ws/scripts/entities.xml',
  typesXmlPath: '/ws/scripts/entity_defs/types.xml',
  userTypeRoots: ['/ws/scripts/user_type'],
  ...overrides
});

describe('GENERATOR_FORM_CHOICES', () => {
  it('四种形态各一项且取值域与 GENERATOR_FORM_KINDS 一致', () => {
    expect(GENERATOR_FORM_CHOICES.map(item => item.value)).toEqual([...GENERATOR_FORM_KINDS]);
    for (const choice of GENERATOR_FORM_CHOICES) {
      expect(choice.label.length).toBeGreaterThan(0);
      expect(choice.description.length).toBeGreaterThan(0);
    }
    expect(PROXY_METHOD_SECTION_CHOICES.map(item => item.value)).toEqual(['BaseMethods', 'CellMethods']);
  });
});

describe('buildProxyDefContent', () => {
  it('Parent 指向同名 Proxy,方法按所选段落 BaseMethods', () => {
    const content = buildProxyDefContent(
      { entityName: 'Avatar', methodSection: 'BaseMethods', methodNames: ['onTargetChanged', 'syncState'] },
      TS
    );

    expect(content).toContain('  代理: AvatarProxy');
    expect(content).toContain('  生成时间: 2026-10-16T00:00:00.000Z');
    expect(content).toContain('  <Parent>\n    <AvatarProxy/>\n  </Parent>');
    expect(content).toContain('  <BaseMethods>\n    <onTargetChanged>\n    </onTargetChanged>\n    <syncState>\n    </syncState>\n  </BaseMethods>');
    expect(content).not.toContain('CellMethods');
  });

  it('方法段选 CellMethods 时落到 CellMethods,描述进文件头', () => {
    const content = buildProxyDefContent(
      { entityName: 'Monster', methodSection: 'CellMethods', methodNames: ['roar'], description: '怪物代理' },
      TS
    );

    expect(content).toContain('  描述: 怪物代理');
    expect(content).toContain('  <CellMethods>');
    expect(content).not.toContain('<BaseMethods>');
  });

  it('无方法名时不出方法段', () => {
    const content = buildProxyDefContent({ entityName: 'Avatar', methodSection: 'BaseMethods', methodNames: [] }, TS);

    expect(content).toContain('  <Parent>\n    <AvatarProxy/>\n  </Parent>\n');
    expect(content).not.toContain('Methods>');
    expect(content.trimEnd().endsWith('</root>')).toBe(true);
  });

  it('未注入时间戳时用当前时间', () => {
    const content = buildProxyDefContent({ entityName: 'Avatar', methodSection: 'BaseMethods', methodNames: [] });

    expect(content).toMatch(/生成时间: \d{4}-\d{2}-\d{2}T/);
  });
});

describe('buildSpaceDefContent', () => {
  it('父类 Space + 进出空间回调', () => {
    const content = buildSpaceDefContent({ name: 'MySpace', description: '主城' }, TS);

    expect(content).toContain('  空间: MySpace');
    expect(content).toContain('  <Parent>\n    <Space/>\n  </Parent>');
    expect(content).toContain('    <onEnterSpace>\n      <Arg>VECTOR3</Arg>\n    </onEnterSpace>');
    expect(content).toContain('    <onLeaveSpace>\n      <Arg>ENTITYCALL</Arg>\n    </onLeaveSpace>');
    expect(content).toContain('  </CellMethods>');
  });

  it('无描述时文件头不带描述行', () => {
    const content = buildSpaceDefContent({ name: 'BareSpace' }, TS);

    expect(content).toContain('<!--\n  空间: BareSpace\n  生成时间:');
    expect(content).not.toContain('  描述:');
  });

  it('entities.xml 登记行固定 hasBase + hasCell', () => {
    expect(buildSpaceRegistrationLine('MySpace')).toBe('  <MySpace hasBase="true" hasCell="true" />');
  });
});

describe('buildComponentDefContent', () => {
  it('属性段与 CellMethods 段都出', () => {
    const content = buildComponentDefContent(
      {
        name: 'Inventory',
        properties: [{ name: 'gold', type: 'UINT32', flags: 'CELL_PUBLIC', default: '0', persistent: true }],
        methodNames: ['onItemGained'],
        description: '背包组件'
      },
      TS
    );

    expect(content).toContain('  组件: Inventory');
    expect(content).toContain('  描述: 背包组件');
    expect(content).toContain(
      '    <gold>\n      <Type>UINT32</Type>\n      <Flags>CELL_PUBLIC</Flags>\n      <Default>0</Default>\n      <Persistent>true</Persistent>\n    </gold>'
    );
    expect(content).toContain('  <CellMethods>\n    <onItemGained>\n    </onItemGained>\n  </CellMethods>');
  });

  it('属性段可空:无属性无方法时只出两段空结构', () => {
    const content = buildComponentDefContent({ name: 'Empty', properties: [] }, TS);

    expect(content).toContain('  <Properties>\n  </Properties>');
    expect(content).toContain('  <CellMethods>\n  </CellMethods>');
    expect(content).not.toContain('<value>');
  });

  it('示例属性口径:CELL_PUBLIC + UINT32;固定字典示例字段不带 Flags', () => {
    expect(COMPONENT_SAMPLE_PROPERTY).toEqual({ name: 'value', type: 'UINT32', flags: 'CELL_PUBLIC' });
    expect(FIXED_DICT_SAMPLE_PROPERTY).toEqual({ name: 'value', type: 'UINT32' });

    const content = buildComponentDefContent(
      { name: 'Inventory', properties: [COMPONENT_SAMPLE_PROPERTY], methodNames: [COMPONENT_SAMPLE_PROPERTY.name] },
      TS
    );
    expect(content).toContain('    <value>\n      <Type>UINT32</Type>\n      <Flags>CELL_PUBLIC</Flags>\n    </value>');
  });

  it('组件属性片段:COMPONENT 类型 + 默认 CELL_PUBLIC 可见域', () => {
    expect(buildComponentPropertySnippet('inventory')).toBe(
      '    <inventory>\n      <Type>COMPONENT</Type>\n      <Flags>CELL_PUBLIC</Flags>\n    </inventory>'
    );
    expect(buildComponentPropertySnippet('skill', 'CELL_PRIVATE')).toContain('<Flags>CELL_PRIVATE</Flags>');
  });
});

describe('buildFixedDictTypeContent', () => {
  it('FIXED_DICT + Properties + implementedBy', () => {
    const content = buildFixedDictTypeContent({
      name: 'MY_DATA',
      properties: [{ name: 'value', type: 'UINT32' }],
      implementedBy: 'MY_DATA_DATA.my_data_inst'
    });

    expect(content).toBe(
      [
        '  <MY_DATA>',
        '    FIXED_DICT',
        '    <Properties>',
        '      <value>',
        '        <Type>UINT32</Type>',
        '      </value>',
        '    </Properties>',
        '    <implementedBy>MY_DATA_DATA.my_data_inst</implementedBy>',
        '  </MY_DATA>',
        ''
      ].join('\n')
    );
  });

  it('implementedBy 缺省时不写该行', () => {
    const content = buildFixedDictTypeContent({ name: 'MY_DATA', properties: [] });

    expect(content).not.toContain('implementedBy');
    expect(content).toContain('    <Properties>\n    </Properties>');
  });
});

describe('resolveGeneratorFormTarget', () => {
  const inputs: GeneratorFormInput[] = [
    { kind: 'proxy', value: { entityName: 'Avatar', methodSection: 'BaseMethods', methodNames: [] } },
    { kind: 'space', value: { name: 'MySpace' } },
    { kind: 'component', value: { name: 'Inventory', properties: [] } },
    { kind: 'fixedDict', value: { name: 'MY_DATA', properties: [] } }
  ];

  it('四形态按布局解析落点:proxy_defs / defs / components / types.xml', () => {
    const layout = layoutFor();

    expect(resolveGeneratorFormTarget(inputs[0], layout).filePath).toBe('/ws/scripts/proxy_defs/AvatarProxy.def');
    expect(resolveGeneratorFormTarget(inputs[1], layout).filePath).toBe('/ws/scripts/entity_defs/MySpace.def');
    expect(resolveGeneratorFormTarget(inputs[2], layout).filePath).toBe(
      '/ws/scripts/entity_defs/components/Inventory.def'
    );
    expect(resolveGeneratorFormTarget(inputs[3], layout).filePath).toBe('/ws/scripts/entity_defs/types.xml');
  });

  it('目录缺失时 filePath 为 null(逐形态)', () => {
    expect(resolveGeneratorFormTarget(inputs[0], layoutFor({ entityScriptsRoot: null })).filePath).toBeNull();
    expect(resolveGeneratorFormTarget(inputs[1], layoutFor({ entityDefsRoot: null })).filePath).toBeNull();
    expect(resolveGeneratorFormTarget(inputs[2], layoutFor({ componentsRoot: null })).filePath).toBeNull();
    expect(resolveGeneratorFormTarget(inputs[3], layoutFor({ typesXmlPath: null })).filePath).toBe(
      '/ws/scripts/entity_defs/types.xml'
    );
    expect(
      resolveGeneratorFormTarget(inputs[3], layoutFor({ typesXmlPath: null, entityDefsRoot: null })).filePath
    ).toBeNull();
  });
});