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

  before(() => {
    const entityDefsRoot = path.join('/workspace', 'scripts', 'entity_defs');
    const typesXmlPath = path.join(entityDefsRoot, 'types.xml');
    const registeredTypePath = path.join('/workspace', 'scripts', 'user_type', 'RegisteredType.py');

    const fsStub = {
      existsSync(candidatePath: string): boolean {
        return [
          entityDefsRoot,
          typesXmlPath,
          registeredTypePath
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
});
