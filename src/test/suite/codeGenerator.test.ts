import * as assert from 'assert';
import { createVscodeStub, loadModuleWithMocks } from './testUtils';

type CodeGeneratorModule = typeof import('../../codeGenerator');
type EntityDefinition = import('../../codeGenerator').EntityDefinition;

describe('KBEngineCodeGenerator', () => {
  let restoreModuleMocks: (() => void) | undefined;
  let KBEngineCodeGenerator: CodeGeneratorModule['KBEngineCodeGenerator'];
  let mkdirCalls: string[];
  let fakeFs: {
    existsSync: (candidatePath: string) => boolean;
    readFileSync: (candidatePath: string) => string;
    writeFileSync: (candidatePath: string, content: string) => void;
    mkdirSync: (candidatePath: string, options?: { recursive?: boolean }) => void;
  };
  let writtenFiles: Record<string, string>;
  let resolvedEntitiesXmlPath: string | null;
  let resolvedEntityDefsRoot: string | null;
  let generatorConfigValues: Record<string, unknown>;

  before(() => {
    mkdirCalls = [];
    writtenFiles = {};
    resolvedEntitiesXmlPath = '/workspace/config/entities/entities.xml';
    resolvedEntityDefsRoot = '/workspace/config/entity_defs';
    generatorConfigValues = {
      defOutputPath: 'scripts/entity_defs',
      pythonOutputPath: 'scripts',
      generatePython: true,
      registerInEntitiesXml: true
    };
    fakeFs = {
      existsSync(candidatePath: string): boolean {
        return [
          '/workspace/config/entities/entities.xml',
          '/workspace/config/entity_defs',
          '/workspace/custom_defs',
          '/workspace/scripts/entity_defs'
        ].includes(candidatePath);
      },
      readFileSync(candidatePath: string): string {
        assert.strictEqual(candidatePath, '/workspace/config/entities/entities.xml');
        return '<root>\n</root>';
      },
      writeFileSync(candidatePath: string, content: string): void {
        writtenFiles[candidatePath] = content;
      },
      mkdirSync(candidatePath: string): void {
        mkdirCalls.push(candidatePath);
      }
    };

    const vscodeStub = createVscodeStub({
      workspace: {
        workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
        getConfiguration: (section?: string) => ({
          get<T>(key: string, defaultValue: T): T {
            if (section === 'kbengine.generator') {
              return (generatorConfigValues[key] as T | undefined) ?? defaultValue;
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
      {
        vscode: vscodeStub,
        fs: fakeFs,
        './definitionWorkspace': {
          findEntitiesXmlFile: () => resolvedEntitiesXmlPath,
          findEntityDefinitionsRoot: () => resolvedEntityDefsRoot
        }
      },
      true
    );

    restoreModuleMocks = restore;
    KBEngineCodeGenerator = loadedModule.KBEngineCodeGenerator;
  });

  after(() => {
    restoreModuleMocks?.();
  });

  beforeEach(() => {
    mkdirCalls = [];
    writtenFiles = {};
    resolvedEntitiesXmlPath = '/workspace/config/entities/entities.xml';
    resolvedEntityDefsRoot = '/workspace/config/entity_defs';
    generatorConfigValues = {
      defOutputPath: 'scripts/entity_defs',
      pythonOutputPath: 'scripts',
      generatePython: true,
      registerInEntitiesXml: true
    };
  });

  it('writes source-backed parent, property and method structures into generated def content', () => {
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
      baseProperties: [{
        name: 'hp',
        type: 'UINT32',
        flags: 'BASE_AND_CLIENT',
        persistent: true,
        dbLength: 8,
        identifier: true,
        detailLevel: 'NEAR'
      }],
      baseMethods: [{ name: 'moveTo', exposed: true, args: [{ name: 'spaceID', type: 'UINT32' }] }]
    });

    assert.ok(content.includes('<Parent>'));
    assert.ok(content.includes('<Entity/>'));
    assert.ok(content.includes('<Properties>'));
    assert.ok(!content.includes('<CellProperties>'));
    assert.ok(content.includes('<Persistent>true</Persistent>'));
    assert.ok(content.includes('<DatabaseLength>8</DatabaseLength>'));
    assert.ok(content.includes('<Arg>UINT32</Arg>'));
    assert.ok(content.includes('<Exposed/>'));
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
    assert.ok(output.includes('<Avatar hasCell="true" hasBase="true" hasClient="true" />'));
  });

  it('prefers definitionWorkspace when resolving entities.xml', async () => {
    resolvedEntitiesXmlPath = '/workspace/config/entities/entities.xml';
    const generator = new KBEngineCodeGenerator({ subscriptions: [] } as never);

    await generator.registerInEntitiesXml({
      name: 'Hero',
      hasBase: true,
      hasCell: false,
      hasClient: false
    });

    assert.ok(writtenFiles['/workspace/config/entities/entities.xml']);
  });

  it('writes generated defs into the resolved definition workspace root by default', async () => {
    const generator = new KBEngineCodeGenerator({ subscriptions: [] } as never);

    const defFilePath = await generator.generateDefFile({
      config: {
        name: 'Avatar',
        hasBase: true,
        hasCell: false,
        hasClient: false
      }
    });

    assert.strictEqual(defFilePath, '/workspace/config/entity_defs/Avatar.def');
    assert.ok(writtenFiles['/workspace/config/entity_defs/Avatar.def']);
    assert.deepStrictEqual(mkdirCalls, []);
  });

  it('keeps explicit generator def output path higher priority than definitionWorkspace', async () => {
    generatorConfigValues.defOutputPath = 'custom_defs';
    const generator = new KBEngineCodeGenerator({ subscriptions: [] } as never);

    const defFilePath = await generator.generateDefFile({
      config: {
        name: 'Npc',
        hasBase: true,
        hasCell: false,
        hasClient: false
      }
    });

    assert.strictEqual(defFilePath, '/workspace/custom_defs/Npc.def');
    assert.ok(writtenFiles['/workspace/custom_defs/Npc.def']);
  });
});
