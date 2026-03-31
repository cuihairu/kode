import * as assert from 'assert';
import { createVscodeStub, loadModuleWithMocks } from './testUtils';

type CodeGeneratorModule = typeof import('../../codeGenerator');
type EntityDefinition = import('../../codeGenerator').EntityDefinition;

describe('KBEngineCodeGenerator', () => {
  let restoreModuleMocks: (() => void) | undefined;
  let KBEngineCodeGenerator: CodeGeneratorModule['KBEngineCodeGenerator'];
  let fakeFs: {
    existsSync: (candidatePath: string) => boolean;
    readFileSync: (candidatePath: string) => string;
    writeFileSync: (candidatePath: string, content: string) => void;
  };
  let writtenFiles: Record<string, string>;

  before(() => {
    writtenFiles = {};
    fakeFs = {
      existsSync(candidatePath: string): boolean {
        return candidatePath === '/workspace/config/entities/entities.xml';
      },
      readFileSync(candidatePath: string): string {
        assert.strictEqual(candidatePath, '/workspace/config/entities/entities.xml');
        return '<root>\n</root>';
      },
      writeFileSync(candidatePath: string, content: string): void {
        writtenFiles[candidatePath] = content;
      }
    };

    const vscodeStub = createVscodeStub({
      workspace: {
        workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
        getConfiguration: (section?: string) => ({
          get<T>(key: string, defaultValue: T): T {
            if (section === 'kbengine.generator') {
              const values: Record<string, unknown> = {
                defOutputPath: 'scripts/entity_defs',
                pythonOutputPath: 'scripts',
                generatePython: true,
                registerInEntitiesXml: true
              };
              return (values[key] as T | undefined) ?? defaultValue;
            }

            if (section === 'kbengine') {
              const values: Record<string, unknown> = {
                entitiesXmlPath: 'config/entities/entities.xml'
              };
              return (values[key] as T | undefined) ?? defaultValue;
            }

            return defaultValue;
          }
        })
      }
    });

    const { loadedModule, restore } = loadModuleWithMocks<CodeGeneratorModule>(
      __filename,
      '../../codeGenerator',
      { vscode: vscodeStub, fs: fakeFs },
      true
    );

    restoreModuleMocks = restore;
    KBEngineCodeGenerator = loadedModule.KBEngineCodeGenerator;
  });

  after(() => {
    restoreModuleMocks?.();
  });

  beforeEach(() => {
    writtenFiles = {};
  });

  it('writes parent information into generated def content and omits Exposed tags', () => {
    const generator = new KBEngineCodeGenerator({ subscriptions: [] } as never);
    const content = (generator as unknown as {
      generateDefContent: (entity: EntityDefinition) => string;
    }).generateDefContent({
      config: {
        name: 'Avatar',
        hasBase: true,
        hasCell: true,
        hasClient: false,
        parent: 'Entity',
        description: 'test'
      },
      baseMethods: [{ name: 'moveTo', exposed: true, args: [{ name: 'spaceID', type: 'UINT32' }] }]
    });

    assert.ok(content.includes('<Parent>Entity</Parent>'));
    assert.ok(content.includes('<Arg>UINT32 spaceID</Arg>'));
    assert.ok(!content.includes('<Exposed/>'));
  });

  it('registers entities using the configured entities.xml path', async () => {
    const generator = new KBEngineCodeGenerator({ subscriptions: [] } as never);

    await generator.registerInEntitiesXml({
      name: 'Avatar',
      hasBase: true,
      hasCell: true,
      hasClient: true,
      parent: 'Entity'
    });

    const output = writtenFiles['/workspace/config/entities/entities.xml'];
    assert.ok(output);
    assert.ok(output.includes('<Avatar parent="Entity" hasCell="true" hasBase="true" hasClient="true" />'));
  });
});
