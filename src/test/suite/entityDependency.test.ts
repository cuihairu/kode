import * as assert from 'assert';
import { createVscodeStub, loadModuleWithMocks } from './testUtils';

type EntityDependencyModule = typeof import('../../entityDependency');

describe('EntityDependencyAnalyzer', () => {
  let restoreModuleMocks: (() => void) | undefined;
  let EntityDependencyAnalyzer: EntityDependencyModule['EntityDependencyAnalyzer'];

  before(() => {
    const fakeFs = {
      existsSync(candidatePath: string): boolean {
        return [
          '/workspace/config/entity_defs/Hero.def',
          '/workspace/config/entities/entities.xml'
        ].includes(candidatePath);
      },
      readFileSync(candidatePath: string): string {
        assert.strictEqual(candidatePath, '/workspace/config/entities/entities.xml');
        return '<root>\n  <Hero hasBase="true" hasCell="true" hasClient="false" />\n</root>';
      }
    };

    const vscodeStub = createVscodeStub({
      workspace: {
        workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
        fs: {
          readFile: async () => Buffer.from('<root>\n  <Parent><Avatar/></Parent>\n  <Properties></Properties>\n</root>', 'utf8')
        },
        findFiles: async () => [{ fsPath: '/workspace/config/entity_defs/Hero.def' }],
        getConfiguration: (section?: string) => ({
          get<T>(key: string, defaultValue: T): T {
            if (section === 'kbengine') {
              const values: Record<string, unknown> = {
                entityDefsPath: 'config/entity_defs',
                entitiesXmlPath: 'config/entities/entities.xml'
              };
              return (values[key] as T | undefined) ?? defaultValue;
            }
            return defaultValue;
          }
        })
      }
    });

    const { loadedModule, restore } = loadModuleWithMocks<EntityDependencyModule>(
      __filename,
      '../../entityDependency',
      { vscode: vscodeStub, fs: fakeFs },
      true
    );

    restoreModuleMocks = restore;
    EntityDependencyAnalyzer = loadedModule.EntityDependencyAnalyzer;
  });

  after(() => {
    restoreModuleMocks?.();
  });

  it('uses configured entity paths and resolves source-backed parent syntax during analyze', async () => {
    const analyzer = new EntityDependencyAnalyzer({} as never);

    const graph = await analyzer.analyze();
    const hero = graph.nodes.find(node => node.name === 'Hero');

    assert.ok(hero);
    assert.strictEqual(hero?.defFile, '/workspace/config/entity_defs/Hero.def');
    assert.strictEqual(hero?.parent, 'Avatar');
  });
});
