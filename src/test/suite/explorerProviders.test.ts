import * as assert from 'assert';
import * as path from 'path';
import {
  FakeUri,
  createVscodeStub,
  loadModuleWithMocks
} from './testUtils';

type ExplorerProvidersModule = typeof import('../../explorerProviders');
type DefinitionWorkspaceModule = typeof import('../../definitionWorkspace');

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/');
}

describe('EntityExplorerProvider', () => {
  let restoreModuleMocks: (() => void) | undefined;
  let EntityExplorerProvider: ExplorerProvidersModule['EntityExplorerProvider'];
  let parseDefinitionStructure: ExplorerProvidersModule['parseDefinitionStructure'];

  before(() => {
    const entityDefsRoot = path.join('/workspace', 'scripts', 'entity_defs');
    const interfacesRoot = path.join(entityDefsRoot, 'interfaces');
    const componentsRoot = path.join(entityDefsRoot, 'components');
    const typesXmlPath = path.join(entityDefsRoot, 'types.xml');
    const registeredTypePath = path.join('/workspace', 'scripts', 'user_type', 'RegisteredType.py');
    const entitiesXmlPath = path.join('/workspace', 'scripts', 'entities.xml');
    const avatarDefPath = path.join(entityDefsRoot, 'Avatar.def');
    const orphanDefPath = path.join(entityDefsRoot, 'Orphan.def');
    const chatInterfacePath = path.join(interfacesRoot, 'Chat.def');
    const combatComponentPath = path.join(componentsRoot, 'Combat.def');

    const fsStub = {
      existsSync(candidatePath: string): boolean {
        return [
          entityDefsRoot,
          interfacesRoot,
          componentsRoot,
          typesXmlPath,
          registeredTypePath,
          entitiesXmlPath,
          avatarDefPath,
          orphanDefPath,
          chatInterfacePath,
          combatComponentPath
        ].includes(candidatePath);
      },
      readFileSync(candidatePath: string): string {
        if (candidatePath === typesXmlPath) {
          return [
            '<root>',
            '  <ArrayType>',
            '    ARRAY',
            '    <of>RegisteredType</of>',
            '  </ArrayType>',
            '  <RegisteredType>UINT32</RegisteredType>',
            '  <BrokenType>',
            '    FIXED_DICT',
            '    <implementedBy>custom/BrokenType</implementedBy>',
            '    <Properties>',
            '      <score>',
            '        <Type>UINT8</Type>',
            '      </score>',
            '      <profile>',
            '        <Type>RegisteredType</Type>',
            '      </profile>',
            '      <owner>',
            '        <Type>Avatar</Type>',
            '      </owner>',
            '      <combat>',
            '        <Type>Combat</Type>',
            '      </combat>',
            '    </Properties>',
            '  </BrokenType>',
            '</root>'
          ].join('\n');
        }

        if (candidatePath === entitiesXmlPath) {
          return '<root><Avatar hasBase="true" hasCell="true"/></root>';
        }

        if (candidatePath === avatarDefPath) {
          return [
            '<root>',
            '  <Parent>',
            '    <Creature/>',
            '  </Parent>',
            '  <Interfaces>',
            '    <Interface>',
            '      <Chat/>',
            '    </Interface>',
            '  </Interfaces>',
            '  <Components>',
            '    <combat>',
            '      <Type>Combat</Type>',
            '    </combat>',
            '  </Components>',
            '  <Properties>',
            '    <health>',
            '      <Type>UINT32</Type>',
            '      <Flags>BASE</Flags>',
            '    </health>',
            '    <mana>',
            '      <Type>UINT16</Type>',
            '      <Flags>BASE</Flags>',
            '    </mana>',
            '  </Properties>',
            '  <BaseMethods>',
            '    <Spawn>',
            '      <Arg>UINT8</Arg>',
            '    </Spawn>',
            '  </BaseMethods>',
            '</root>'
          ].join('\n');
        }

        if (candidatePath === orphanDefPath) {
          return '<root></root>';
        }

        if (candidatePath === chatInterfacePath) {
          return '<root><ClientMethods><Ping><Arg>UINT8</Arg></Ping></ClientMethods></root>';
        }

        if (candidatePath === combatComponentPath) {
          return '<root><Properties><power><Type>UINT8</Type><Flags>BASE</Flags></power></Properties></root>';
        }

        throw new Error(`Unexpected readFileSync path: ${candidatePath}`);
      },
      readdirSync(candidatePath: string): string[] {
        if (candidatePath === entityDefsRoot) {
          return ['Avatar.def', 'Orphan.def', 'interfaces', 'components'];
        }

        if (candidatePath === interfacesRoot) {
          return ['Chat.def'];
        }

        if (candidatePath === componentsRoot) {
          return ['Combat.def'];
        }

        throw new Error(`Unexpected readdirSync path: ${candidatePath}`);
      }
    };

    const vscodeStub = createVscodeStub({
      workspace: {
        workspaceFolders: [{ uri: new FakeUri('/workspace') }],
        getConfiguration: () => ({
          get<T>(_key: string, defaultValue: T): T {
            return defaultValue;
          }
        })
      },
      EventEmitter: class FakeEventEmitter<T> {
        event = () => undefined;
        fire(value?: T): void {
          void value;
        }
      },
      TreeItem: class FakeTreeItem {
        label: string;
        description?: string;
        iconPath?: unknown;
        contextValue?: string;
        command?: unknown;
        tooltip?: string;
        collapsibleState: number;

        constructor(label: string, collapsibleState: number) {
          this.label = label;
          this.collapsibleState = collapsibleState;
        }
      },
      TreeItemCollapsibleState: {
        None: 0,
        Collapsed: 1,
        Expanded: 2
      },
      ThemeIcon: class FakeThemeIcon {
        constructor(public id: string) {}
      }
    });

    const { loadedModule: definitionWorkspaceModule, restore: restoreDefinitionWorkspace } =
      loadModuleWithMocks<DefinitionWorkspaceModule>(
        __filename,
        '../../definitionWorkspace',
        {
          vscode: vscodeStub,
          fs: fsStub
        },
        true
      );

    const { loadedModule, restore } = loadModuleWithMocks<ExplorerProvidersModule>(
      __filename,
      '../../explorerProviders',
      {
        vscode: vscodeStub,
        fs: fsStub,
        './definitionWorkspace': definitionWorkspaceModule
      },
      true
    );

    restoreModuleMocks = () => {
      restore();
      restoreDefinitionWorkspace();
    };
    EntityExplorerProvider = loadedModule.EntityExplorerProvider;
    parseDefinitionStructure = loadedModule.parseDefinitionStructure;
  });

  after(() => {
    restoreModuleMocks?.();
  });

  it('groups definitions into entities, interfaces and components', async () => {
    const provider = new EntityExplorerProvider();

    const rootItems = await provider.getChildren();
    assert.strictEqual(rootItems.length, 4);
    assert.deepStrictEqual(rootItems.map(item => item.label), ['Types', 'Entities', 'Interfaces', 'Components']);

    const typeItems = await provider.getChildren(rootItems[0] as never);
    assert.deepStrictEqual(typeItems.map(item => item.label), ['ArrayType', 'BrokenType', 'RegisteredType']);
    assert.strictEqual(typeItems[0].description, 'ARRAY, Python Missing');
    assert.strictEqual(typeItems[1].description, 'FIXED_DICT, implementedBy: custom/BrokenType, Python Missing');
    assert.strictEqual(typeItems[2].description, 'UINT32');

    const entityItems = await provider.getChildren(rootItems[1] as never);
    assert.deepStrictEqual(entityItems.map(item => item.label), ['Avatar', 'Orphan']);
    assert.strictEqual(entityItems[0].description, 'Base, Cell');
    assert.strictEqual(entityItems[1].description, 'Unregistered');

    const interfaceItems = await provider.getChildren(rootItems[2] as never);
    assert.deepStrictEqual(interfaceItems.map(item => item.label), ['Chat']);

    const componentItems = await provider.getChildren(rootItems[3] as never);
    assert.deepStrictEqual(componentItems.map(item => item.label), ['Combat']);
  });

  it('expands custom types into alias, properties and python sections', async () => {
    const provider = new EntityExplorerProvider();
    const rootItems = await provider.getChildren();
    const typeItems = await provider.getChildren(rootItems[0] as never);
    const arrayTypeItem = typeItems[0] as any;
    const brokenTypeItem = typeItems[1] as any;
    const registeredTypeItem = typeItems[2] as any;

    assert.deepStrictEqual(
      arrayTypeItem.viewModel.sections.map((section: any) => section.label),
      ['Alias']
    );

    assert.deepStrictEqual(
      brokenTypeItem.viewModel.summary.map((item: any) => [item.label, item.value]),
      [
        ['Definition', path.join('scripts', 'entity_defs', 'types.xml')],
        ['Category', 'Type'],
        ['AliasType', 'FIXED_DICT'],
        ['Python', 'Missing'],
        ['implementedBy', 'custom/BrokenType']
      ]
    );

    assert.deepStrictEqual(
      brokenTypeItem.viewModel.sections.map((section: any) => section.label),
      ['Alias', 'Properties']
    );
    assert.deepStrictEqual(
      registeredTypeItem.viewModel.sections.map((section: any) => section.label),
      ['Alias', 'Python']
    );

    const arraySections = await provider.getChildren(arrayTypeItem as never);
    const arrayAliasSection = arraySections.find(item => item.label === 'Alias');
    assert.ok(arrayAliasSection);

    const arrayAliasItems = await provider.getChildren(arrayAliasSection as never);
    assert.deepStrictEqual(arrayAliasItems.map(item => item.label), ['ARRAY', '<of>']);
    assert.strictEqual(arrayAliasItems[0].description, 'ARRAY <of>RegisteredType</of> · Built-in');
    assert.strictEqual(arrayAliasItems[1].description, 'RegisteredType · Type');
    assert.strictEqual(normalizePath((arrayAliasItems[1] as any).command.arguments[0].fsPath), '/workspace/scripts/entity_defs/types.xml');

    const brokenSections = await provider.getChildren(brokenTypeItem as never);
    const propertiesSection = brokenSections.find(item => item.label === 'Properties');
    assert.ok(propertiesSection);

    const propertiesItems = await provider.getChildren(propertiesSection as never);
    assert.deepStrictEqual(propertiesItems.map(item => item.label), ['combat', 'owner', 'profile', 'score']);
    assert.strictEqual(propertiesItems[0].description, 'Combat · Component');
    assert.strictEqual(propertiesItems[1].description, 'Avatar · Entity');
    assert.strictEqual(propertiesItems[2].description, 'RegisteredType · Type');
    assert.strictEqual(propertiesItems[3].description, 'UINT8 · Built-in');
    assert.strictEqual(normalizePath((propertiesItems[0] as any).command.arguments[0].fsPath), '/workspace/scripts/entity_defs/components/Combat.def');
    assert.strictEqual(normalizePath((propertiesItems[1] as any).command.arguments[0].fsPath), '/workspace/scripts/entity_defs/Avatar.def');
    assert.strictEqual(normalizePath((propertiesItems[2] as any).command.arguments[0].fsPath), '/workspace/scripts/entity_defs/types.xml');
    assert.strictEqual((propertiesItems[3] as any).command, undefined);
  });

  it('expands entity definitions into semantic sections', async () => {
    const provider = new EntityExplorerProvider();
    const rootItems = await provider.getChildren();
    const entityItems = await provider.getChildren(rootItems[1] as never);
    const avatarItem = entityItems[0] as any;

    assert.deepStrictEqual(
      avatarItem.viewModel.sections.map((section: any) => section.label),
      ['Parent', 'Interfaces', 'Components', 'Properties', 'BaseMethods']
    );

    const sections = await provider.getChildren(avatarItem as never);
    assert.ok(sections.map(item => item.label).includes('Summary'));

    const summaryItems = await provider.getChildren(sections[0] as never);
    assert.ok(summaryItems.some(item => item.label === 'Registered' && item.description === 'Yes'));
    assert.ok(summaryItems.some(item => item.label === 'Properties' && item.description === '2'));

    const parentSection = sections.find(item => item.label === 'Parent');
    const interfacesSection = sections.find(item => item.label === 'Interfaces');
    const componentsSection = sections.find(item => item.label === 'Components');
    const propertiesSection = sections.find(item => item.label === 'Properties');
    const baseMethodsSection = sections.find(item => item.label === 'BaseMethods');

    assert.ok(parentSection);
    assert.ok(interfacesSection);
    assert.ok(componentsSection);
    assert.ok(propertiesSection);
    assert.ok(baseMethodsSection);

    const parentItems = await provider.getChildren(parentSection as never);
    assert.deepStrictEqual(parentItems.map(item => item.label), ['Creature']);

    const interfaceItems = await provider.getChildren(interfacesSection as never);
    assert.deepStrictEqual(interfaceItems.map(item => item.label), ['Chat']);

    const componentItems = await provider.getChildren(componentsSection as never);
    assert.deepStrictEqual(componentItems.map(item => item.label), ['Combat']);
    assert.strictEqual(componentItems[0].description, 'combat -> Combat');

    const propertyItems = await provider.getChildren(propertiesSection as never);
    assert.deepStrictEqual(propertyItems.map(item => item.label), ['health', 'mana']);

    const methodItems = await provider.getChildren(baseMethodsSection as never);
    assert.deepStrictEqual(methodItems.map(item => item.label), ['Spawn']);
  });

  it('parses entity definition structure from content', () => {
    const stats = parseDefinitionStructure([
      '<root>',
      '  <Parent>',
      '    <Creature/>',
      '  </Parent>',
      '  <Interfaces>',
      '    <Interface>',
      '      <Chat/>',
      '    </Interface>',
      '  </Interfaces>',
      '  <Components>',
      '    <combat>',
      '      <Type>Combat</Type>',
      '    </combat>',
      '  </Components>',
      '  <Properties>',
      '    <health>',
      '      <Type>UINT32</Type>',
      '      <Flags>BASE</Flags>',
      '    </health>',
      '    <mana>',
      '      <Type>UINT16</Type>',
      '      <Flags>BASE</Flags>',
      '    </mana>',
      '  </Properties>',
      '  <BaseMethods>',
      '    <Spawn>',
      '      <Arg>UINT8</Arg>',
      '    </Spawn>',
      '  </BaseMethods>',
      '</root>'
    ].join('\n'));

    assert.strictEqual(stats.parent, 'Creature');
    assert.deepStrictEqual(stats.interfaces, ['Chat']);
    assert.deepStrictEqual(stats.components, [{ propertyName: 'combat', typeName: 'Combat' }]);
    assert.deepStrictEqual(stats.properties, ['health', 'mana']);
    assert.deepStrictEqual(stats.baseMethods, ['Spawn']);
    assert.deepStrictEqual(stats.cellMethods, []);
    assert.deepStrictEqual(stats.clientMethods, []);
  });
});
