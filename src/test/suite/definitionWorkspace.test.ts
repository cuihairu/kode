import * as assert from 'assert';
import * as path from 'path';
import {
  FakeUri,
  createVscodeStub,
  loadModuleWithMocks
} from './testUtils';

type DefinitionWorkspaceModule = typeof import('../../definitionWorkspace');

describe('definitionWorkspace', () => {
  let restoreModuleMocks: (() => void) | undefined;
  let getRegisteredCustomTypes: DefinitionWorkspaceModule['getRegisteredCustomTypes'];
  let getCustomTypeInfos: DefinitionWorkspaceModule['getCustomTypeInfos'];
  let getDefinitionEntries: DefinitionWorkspaceModule['getDefinitionEntries'];
  let getRegisteredEntities: DefinitionWorkspaceModule['getRegisteredEntities'];
  let getEntityRuntimeProfile: DefinitionWorkspaceModule['getEntityRuntimeProfile'];
  let findEntityDefinitionsRoot: DefinitionWorkspaceModule['findEntityDefinitionsRoot'];

  before(() => {
    const entityDefsRoot = path.join('/workspace', 'scripts', 'entity_defs');
    const typesXmlPath = path.join(entityDefsRoot, 'types.xml');
    const entitiesXmlPath = path.join('/workspace', 'scripts', 'entities.xml');
    const registeredTypePath = path.join('/workspace', 'scripts', 'user_type', 'RegisteredType.py');
    const avatarBasePath = path.join('/workspace', 'scripts', 'base', 'Avatar.py');
    const avatarClientPath = path.join('/workspace', 'scripts', 'client', 'Avatar.py');
    const spaceCellPath = path.join('/workspace', 'scripts', 'cell', 'Space.py');

    const fsStub = {
      existsSync(candidatePath: string): boolean {
        return [
          entityDefsRoot,
          typesXmlPath,
          entitiesXmlPath,
          registeredTypePath,
          avatarBasePath,
          avatarClientPath,
          spaceCellPath
        ].includes(candidatePath);
      },
      readFileSync(candidatePath: string): string {
        if (candidatePath === typesXmlPath) {
          return [
            '<root>',
            '  <RegisteredType>UINT32</RegisteredType>',
            '  <BagType>',
            '    FIXED_DICT',
            '    <implementedBy>custom/BagType</implementedBy>',
            '    <Properties>',
            '      <count>',
            '        <Type>UINT32</Type>',
            '      </count>',
            '    </Properties>',
            '  </BagType>',
            '  <ArrayType>',
            '    ARRAY',
            '    <of>RegisteredType</of>',
            '  </ArrayType>',
            '</root>'
          ].join('\n');
        }

        if (candidatePath === entitiesXmlPath) {
          return [
            '<root>',
            '  <Avatar hasBase="true" hasClient="true" />',
            '  <Space hasCell="true" />',
            '  <Pet />',
            '</root>'
          ].join('\n');
        }

        throw new Error(`Unexpected readFileSync path: ${candidatePath}`);
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
      }
    });

    const { loadedModule, restore } = loadModuleWithMocks<DefinitionWorkspaceModule>(
      __filename,
      '../../definitionWorkspace',
      {
        vscode: vscodeStub,
        fs: fsStub
      },
      true
    );

    restoreModuleMocks = restore;
    getRegisteredCustomTypes = loadedModule.getRegisteredCustomTypes;
    getCustomTypeInfos = loadedModule.getCustomTypeInfos;
    getDefinitionEntries = loadedModule.getDefinitionEntries;
    getRegisteredEntities = loadedModule.getRegisteredEntities;
    getEntityRuntimeProfile = loadedModule.getEntityRuntimeProfile;
    findEntityDefinitionsRoot = loadedModule.findEntityDefinitionsRoot;
  });

  after(() => {
    restoreModuleMocks?.();
  });

  function normalizePath(value: string | undefined): string | undefined {
    return value?.replace(/\\/g, '/');
  }

  it('parses only top-level custom types from types.xml', () => {
    const customTypes = [...getRegisteredCustomTypes('/workspace')].sort();
    assert.deepStrictEqual(customTypes, ['ArrayType', 'BagType', 'RegisteredType']);
  });

  it('extracts alias, implementedBy and property metadata for custom types', () => {
    const customTypes = getCustomTypeInfos('/workspace');
    const bagType = customTypes.find(item => item.name === 'BagType');
    const arrayType = customTypes.find(item => item.name === 'ArrayType');
    const registeredType = customTypes.find(item => item.name === 'RegisteredType');

    assert.ok(bagType);
    assert.strictEqual(bagType?.aliasType, 'FIXED_DICT');
    assert.strictEqual(bagType?.implementedBy, 'custom/BagType');
    assert.deepStrictEqual(bagType?.properties, [{ name: 'count', typeName: 'UINT32' }]);

    assert.ok(registeredType);
    assert.strictEqual(registeredType?.aliasType, 'UINT32');
    assert.strictEqual(
      normalizePath(registeredType?.pythonFilePath),
      '/workspace/scripts/user_type/RegisteredType.py'
    );

    assert.ok(arrayType);
    assert.strictEqual(arrayType?.aliasType, 'ARRAY');
    assert.strictEqual(arrayType?.structure.name, 'ARRAY');
    assert.deepStrictEqual(
      arrayType?.structure.children.map(child => [child.tag, child.value.name]),
      [['of', 'RegisteredType']]
    );
  });

  it('exposes custom types through definition entries', () => {
    const entries = getDefinitionEntries('/workspace', 'type');
    assert.deepStrictEqual(entries.map(entry => entry.name), ['ArrayType', 'BagType', 'RegisteredType']);
    assert.strictEqual(normalizePath(entries[0].filePath), '/workspace/scripts/entity_defs/types.xml');
    assert.strictEqual(entries[0].aliasType, 'ARRAY');
    assert.strictEqual(entries[0].typeStructure?.children[0].value.name, 'RegisteredType');
    assert.strictEqual(entries[0].line, 12);
    assert.strictEqual(entries[1].line, 3);
    assert.strictEqual(entries[2].line, 2);
  });

  it('exposes the resolved entity definition root for shared path resolution', () => {
    assert.strictEqual(
      normalizePath(findEntityDefinitionsRoot('/workspace') || undefined),
      '/workspace/scripts/entity_defs'
    );
  });

  it('captures declared runtime flags from entities.xml and keeps undeclared facets distinct', () => {
    const entities = getRegisteredEntities('/workspace');
    const avatar = entities.find(item => item.name === 'Avatar');
    const space = entities.find(item => item.name === 'Space');
    const pet = entities.find(item => item.name === 'Pet');

    assert.deepStrictEqual(avatar, {
      name: 'Avatar',
      hasBaseDeclared: true,
      hasCellDeclared: false,
      hasClientDeclared: true,
      hasBase: true,
      hasCell: false,
      hasClient: true
    });

    assert.deepStrictEqual(space, {
      name: 'Space',
      hasBaseDeclared: false,
      hasCellDeclared: true,
      hasClientDeclared: false,
      hasBase: false,
      hasCell: true,
      hasClient: false
    });

    assert.deepStrictEqual(pet, {
      name: 'Pet',
      hasBaseDeclared: false,
      hasCellDeclared: false,
      hasClientDeclared: false,
      hasBase: false,
      hasCell: false,
      hasClient: false
    });
  });

  it('derives runtime visibility from declared flags and script presence', () => {
    const avatar = getEntityRuntimeProfile('Avatar', '/workspace');
    const space = getEntityRuntimeProfile('Space', '/workspace');
    const pet = getEntityRuntimeProfile('Pet', '/workspace');

    assert.ok(avatar);
    assert.deepStrictEqual(avatar?.runtimeRoles, ['BaseApp', 'Client']);
    assert.strictEqual(avatar?.registrationSummary, 'Registered on BaseApp / Client');
    assert.strictEqual(avatar?.visibilitySummary, 'Has client entity definition');
    assert.strictEqual(avatar?.base.source, 'declared');
    assert.strictEqual(avatar?.client.source, 'declared');
    assert.strictEqual(avatar?.cell.source, 'disabled');

    assert.ok(space);
    assert.deepStrictEqual(space?.runtimeRoles, ['CellApp']);
    assert.strictEqual(space?.visibilitySummary, 'Server only (no client entity)');
    assert.strictEqual(space?.cell.source, 'declared');

    assert.ok(pet);
    assert.deepStrictEqual(pet?.runtimeRoles, []);
    assert.strictEqual(pet?.visibilitySummary, 'Server only (no client entity)');
    assert.strictEqual(pet?.base.source, 'disabled');
    assert.strictEqual(pet?.client.source, 'disabled');
  });
});
