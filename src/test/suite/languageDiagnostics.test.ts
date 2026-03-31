import * as assert from 'assert';
import * as path from 'path';
import {
  FakeDiagnosticCollection,
  FakeTextDocument,
  createVscodeStub,
  loadModuleWithMocks
} from './testUtils';

type LanguageProvidersModule = typeof import('../../languageProviders');

describe('validateDocument', () => {
  let restoreModuleMocks: (() => void) | undefined;
  let validateDocument: LanguageProvidersModule['validateDocument'];
  let observedExistsPaths: string[] = [];

  before(() => {
    const typesXmlPath = path.join('/workspace', 'scripts', 'entity_defs', 'types.xml');
    const registeredTypePath = path.join('/workspace', 'scripts', 'user_type', 'RegisteredType.py');

    const fsStub = {
      existsSync(candidatePath: string): boolean {
        observedExistsPaths.push(candidatePath);
        return [
          typesXmlPath,
          registeredTypePath
        ].includes(candidatePath);
      },
      readFileSync(candidatePath: string): string {
        if (candidatePath === typesXmlPath) {
          return '<root><RegisteredType/><BrokenType/></root>';
        }

        throw new Error(`Unexpected readFileSync path: ${candidatePath}`);
      }
    };

    const { loadedModule, restore } = loadModuleWithMocks<LanguageProvidersModule>(
      __filename,
      '../../languageProviders',
      { vscode: createVscodeStub(), fs: fsStub }
    );
    restoreModuleMocks = restore;
    validateDocument = loadedModule.validateDocument;
  });

  after(() => {
    restoreModuleMocks?.();
  });

  function messagesFor(text: string): string[] {
    observedExistsPaths = [];
    const collection = new FakeDiagnosticCollection();
    validateDocument(
      new FakeTextDocument('/workspace/entity_defs/Hero.def', 'kbengine-def', text) as never,
      collection as never
    );
    return (collection.entries.get('/workspace/entity_defs/Hero.def') || []).map(item => item.message);
  }

  it('reports unresolved custom types and conflicting flags', () => {
    const messages = messagesFor([
      '<root>',
      '  <Properties>',
      '    <health>',
      '      <Type>MissingType</Type>',
      '      <Flags>BASE CELL_PUBLIC</Flags>',
      '      <DetailLevel>EXTREME</DetailLevel>',
      '    </health>',
      '  </Properties>',
      '</root>'
    ].join('\n'));

    assert.ok(messages.some(message => message.includes('MissingType') && message.includes('types.xml')));
    assert.ok(messages.some(message => message.includes('BASE') && message.includes('CELL')));
    assert.ok(messages.some(message => message.includes('EXTREME')));
  });

  it('accepts registered custom types and warns when the backing python type is missing', () => {
    const messages = messagesFor([
      '<root>',
      '  <Properties>',
      '    <registered>',
      '      <Type>RegisteredType</Type>',
      '      <Flags>BASE</Flags>',
      '    </registered>',
      '    <broken>',
      '      <Type>BrokenType</Type>',
      '      <Flags>BASE</Flags>',
      '    </broken>',
      '  </Properties>',
      '</root>'
    ].join('\n'));

    assert.ok(!messages.some(message => message.includes('RegisteredType')));
    assert.ok(messages.some(message => (
      message.includes('BrokenType') &&
      message.includes('types.xml') &&
      message.includes('user_type')
    )));
  });

  it('does not resolve builtin types through types.xml or user_type', () => {
    const messages = messagesFor([
      '<root>',
      '  <Properties>',
      '    <health>',
      '      <Type>UINT32</Type>',
      '      <Flags>BASE</Flags>',
      '    </health>',
      '  </Properties>',
      '</root>'
    ].join('\n'));

    assert.deepStrictEqual(messages, []);
    assert.ok(!observedExistsPaths.some(candidatePath => candidatePath.includes('UINT32')));
  });

  it('reports duplicate property definitions and missing required property fields', () => {
    const messages = messagesFor([
      '<root>',
      '  <Properties>',
      '    <health>',
      '      <Type>UINT32</Type>',
      '    </health>',
      '    <health>',
      '      <Flags>BASE</Flags>',
      '    </health>',
      '  </Properties>',
      '</root>'
    ].join('\n'));

    assert.ok(messages.some(message => message.includes('health') && message.includes('重复')));
    assert.ok(messages.some(message => message.includes('health') && message.includes('已定义')));
    assert.ok(messages.some(message => message.includes('health') && message.includes('<Flags>')));
    assert.ok(messages.some(message => message.includes('health') && message.includes('<Type>')));
  });

  it('reports invalid nested tags in property and method sections', () => {
    const messages = messagesFor([
      '<root>',
      '  <Properties>',
      '    <profile>',
      '      <Type>STRING</Type>',
      '      <Arg>UINT32</Arg>',
      '      <Flags>BASE</Flags>',
      '    </profile>',
      '  </Properties>',
      '  <BaseMethods>',
      '    <attack>',
      '      <Type>UINT32</Type>',
      '    </attack>',
      '  </BaseMethods>',
      '</root>'
    ].join('\n'));

    assert.ok(messages.some(message => message.includes('profile') && message.includes('<Arg>') && message.includes('Identifier')));
    assert.ok(messages.some(message => message.includes('attack') && message.includes('<Arg>')));
  });
});
