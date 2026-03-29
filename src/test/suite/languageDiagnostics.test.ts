import * as assert from 'assert';
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

  before(() => {
    const { loadedModule, restore } = loadModuleWithMocks<LanguageProvidersModule>(
      __filename,
      '../../languageProviders',
      { vscode: createVscodeStub() }
    );
    restoreModuleMocks = restore;
    validateDocument = loadedModule.validateDocument;
  });

  after(() => {
    restoreModuleMocks?.();
  });

  function messagesFor(text: string): string[] {
    const collection = new FakeDiagnosticCollection();
    validateDocument(
      new FakeTextDocument('/workspace/entity_defs/Hero.def', 'kbengine-def', text) as never,
      collection as never
    );
    return (collection.entries.get('/workspace/entity_defs/Hero.def') || []).map(item => item.message);
  }

  it('reports unknown scalar values and conflicting flags', () => {
    const messages = messagesFor([
      '<root>',
      '  <Properties>',
      '    <health>',
      '      <Type>UNKNOWN_TYPE</Type>',
      '      <Flags>BASE CELL_PUBLIC</Flags>',
      '      <DetailLevel>EXTREME</DetailLevel>',
      '    </health>',
      '  </Properties>',
      '</root>'
    ].join('\n'));

    assert.ok(messages.includes('未知的 KBEngine 类型: UNKNOWN_TYPE'));
    assert.ok(messages.includes('BASE 和 CELL 标志不能同时使用'));
    assert.ok(messages.includes('未知的 DetailLevel: EXTREME'));
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

    assert.ok(messages.includes('属性区块中存在重复定义: health'));
    assert.ok(messages.includes('health 在 属性区块 中已定义'));
    assert.ok(messages.includes('属性 health 缺少 <Flags> 定义'));
    assert.ok(messages.includes('属性 health 缺少 <Type> 定义'));
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

    assert.ok(messages.includes('属性 profile 中不应出现 <Arg>，允许的子标签: Type, Flags, Default, Database, DetailLevel, Identifier'));
    assert.ok(messages.includes('方法 attack 中只允许 <Arg> 子标签'));
  });
});
