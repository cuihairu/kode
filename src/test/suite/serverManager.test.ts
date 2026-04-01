import * as assert from 'assert';
import { createVscodeStub, loadModuleWithMocks } from './testUtils';

type ServerManagerModule = typeof import('../../serverManager');

describe('KBEngineServerManager', () => {
  let restoreModuleMocks: (() => void) | undefined;
  let KBEngineServerManager: ServerManagerModule['KBEngineServerManager'];
  let SERVER_COMPONENTS: ServerManagerModule['SERVER_COMPONENTS'];
  let errorMessages: string[];
  const noop = (): undefined => undefined;

  before(() => {
    errorMessages = [];

    const fakeFs = {
      existsSync(candidatePath: string): boolean {
        return [
          '/workspace/bin/logger',
          '/workspace/bin/logger-config'
        ].includes(candidatePath);
      },
      statSync(candidatePath: string): { isDirectory: () => boolean } {
        assert.strictEqual(candidatePath, '/workspace/bin/logger-config');
        return {
          isDirectory: () => false
        };
      }
    };

    const vscodeStub = createVscodeStub({
      workspace: {
        workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
        getConfiguration: (section?: string) => ({
          get<T>(key: string, defaultValue: T): T {
            if (section === 'kbengine') {
              const values: Record<string, unknown> = {
                binPath: '/workspace/bin',
                configPath: '/workspace/bin/logger-config'
              };
              return (values[key] as T | undefined) ?? defaultValue;
            }
            return defaultValue;
          }
        })
      },
      window: {
        createOutputChannel: () => ({
          show: noop,
          appendLine: noop,
          append: noop,
          dispose: noop
        }),
        showErrorMessage: (message: string) => {
          errorMessages.push(message);
          return undefined;
        },
        showWarningMessage: () => undefined,
        showInformationMessage: () => undefined
      },
      EventEmitter: class FakeEventEmitter<T> {
        event = () => undefined;
        fire(value?: T): void {
          void value;
        }
        dispose = noop;
      }
    });

    const { loadedModule, restore } = loadModuleWithMocks<ServerManagerModule>(
      __filename,
      '../../serverManager',
      {
        vscode: vscodeStub,
        fs: fakeFs,
        child_process: {
          spawn: () => {
            throw new Error('spawn should not be called when configPath is invalid');
          }
        }
      },
      true
    );

    restoreModuleMocks = restore;
    KBEngineServerManager = loadedModule.KBEngineServerManager;
    SERVER_COMPONENTS = loadedModule.SERVER_COMPONENTS;
  });

  after(() => {
    restoreModuleMocks?.();
  });

  beforeEach(() => {
    errorMessages = [];
  });

  it('fails fast when kbengine.configPath is not a directory', async () => {
    const manager = new KBEngineServerManager({ subscriptions: [] } as never);
    const logger = SERVER_COMPONENTS.find(component => component.name === 'logger');

    assert.ok(logger);

    const result = await manager.startComponent(logger);

    assert.strictEqual(result, false);
    assert.ok(errorMessages.some(message => message.includes('不是目录')));
  });
});
