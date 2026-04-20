import * as assert from 'assert';
import { createVscodeStub, loadModuleWithMocks } from './testUtils';

type ServerManagerModule = typeof import('../../serverManager');

describe('KBEngineServerManager', () => {
  let restoreModuleMocks: (() => void) | undefined;
  let KBEngineServerManager: ServerManagerModule['KBEngineServerManager'];
  let SERVER_COMPONENTS: ServerManagerModule['SERVER_COMPONENTS'];
  let errorMessages: string[];
  let infoMessages: string[];
  let spawnCalls: Array<{ cmd: string; args: string[]; options: { cwd: string; env: NodeJS.ProcessEnv } }>;
  const noop = (): undefined => undefined;

  before(() => {
    errorMessages = [];
    infoMessages = [];
    spawnCalls = [];

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
        showInformationMessage: (message: string) => {
          infoMessages.push(message);
          return undefined;
        }
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
    infoMessages = [];
    spawnCalls = [];
  });

  it('fails fast when kbengine.configPath is not a directory', async () => {
    const manager = new KBEngineServerManager({ subscriptions: [] } as never);
    const logger = SERVER_COMPONENTS.find(component => component.name === 'logger');

    assert.ok(logger);

    const result = await manager.startComponent(logger);

    assert.strictEqual(result, false);
    assert.ok(errorMessages.some(message => message.includes('不是目录')));
  });

  it('contains source-backed interfaces component metadata', () => {
    const interfaces = SERVER_COMPONENTS.find(component => component.name === 'interfaces');

    assert.ok(interfaces);
    assert.strictEqual(interfaces?.order, 3);
    assert.deepStrictEqual(interfaces?.defaultArgs, ['--cid=1129652375332859700', '--gus=3']);
  });

  it('passes template-style args and environment when launching a component', async () => {
    const fakeFs = {
      existsSync(candidatePath: string): boolean {
        return [
          '/workspace/bin/interfaces',
          '/workspace/assets'
        ].includes(candidatePath);
      },
      statSync(candidatePath: string): { isDirectory: () => boolean } {
        assert.strictEqual(candidatePath, '/workspace/assets');
        return {
          isDirectory: () => true
        };
      }
    };

    restoreModuleMocks?.();
    const vscodeStub = createVscodeStub({
      workspace: {
        workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
        getConfiguration: (section?: string) => ({
          get<T>(key: string, defaultValue: T): T {
            if (section === 'kbengine') {
              const values: Record<string, unknown> = {
                binPath: '/workspace/bin',
                configPath: '/workspace/assets'
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
        showErrorMessage: () => undefined,
        showWarningMessage: () => undefined,
        showInformationMessage: (message: string) => {
          infoMessages.push(message);
          return undefined;
        }
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
          spawn: (cmd: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => {
            spawnCalls.push({ cmd, args, options });
            return {
              pid: 4321,
              stdout: { on: noop },
              stderr: { on: noop },
              on: noop,
              kill: noop
            };
          }
        }
      },
      true
    );

    restoreModuleMocks = restore;
    KBEngineServerManager = loadedModule.KBEngineServerManager;
    SERVER_COMPONENTS = loadedModule.SERVER_COMPONENTS;

    const manager = new KBEngineServerManager({ subscriptions: [] } as never);
    const interfaces = SERVER_COMPONENTS.find(component => component.name === 'interfaces');

    assert.ok(interfaces);
    if (!interfaces) {
      throw new Error('interfaces component should exist');
    }

    const result = await manager.startComponent(interfaces);

    assert.strictEqual(result, true);
    assert.strictEqual(spawnCalls.length, 1);
    assert.strictEqual(spawnCalls[0].cmd, '/workspace/bin/interfaces');
    assert.deepStrictEqual(spawnCalls[0].args, ['--cid=1129652375332859700', '--gus=3']);
    assert.strictEqual(spawnCalls[0].options.cwd, '/workspace/assets');
    assert.strictEqual(spawnCalls[0].options.env.KBE_BIN_PATH, `/workspace/bin${process.platform === 'win32' ? '\\' : '/'}`);
  });

  it('does not keep a component running after the child process emits an error', async () => {
    let childErrorHandler: ((error: Error) => void) | undefined;

    restoreModuleMocks?.();
    const fakeFs = {
      existsSync(candidatePath: string): boolean {
        return [
          '/workspace/bin/interfaces',
          '/workspace/assets'
        ].includes(candidatePath);
      },
      statSync(candidatePath: string): { isDirectory: () => boolean } {
        assert.strictEqual(candidatePath, '/workspace/assets');
        return {
          isDirectory: () => true
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
                configPath: '/workspace/assets'
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
        showErrorMessage: () => undefined,
        showWarningMessage: () => undefined,
        showInformationMessage: (message: string) => {
          infoMessages.push(message);
          return undefined;
        }
      },
      EventEmitter: class FakeEventEmitter<T> {
        event = () => undefined;
        fire(value?: T): void {
          void value;
        }
        dispose = noop;
      }
    });

    const originalSetTimeout = global.setTimeout;
    const originalClearTimeout = global.clearTimeout;
    const pendingTimers = new Set<ReturnType<typeof setTimeout>>();

    global.setTimeout = ((handler: (...args: unknown[]) => void) => {
      const timer = originalSetTimeout((...args: unknown[]) => {
        pendingTimers.delete(timer);
        handler(...args);
      }, 0);
      pendingTimers.add(timer);
      return timer;
    }) as typeof setTimeout;

    global.clearTimeout = ((timer: ReturnType<typeof setTimeout>) => {
      pendingTimers.delete(timer);
      return originalClearTimeout(timer);
    }) as typeof clearTimeout;

    try {
      const { loadedModule, restore } = loadModuleWithMocks<ServerManagerModule>(
        __filename,
        '../../serverManager',
        {
          vscode: vscodeStub,
          fs: fakeFs,
          child_process: {
            spawn: () => ({
              pid: 4321,
              stdout: { on: noop },
              stderr: { on: noop },
              on: (event: string, handler: (...args: unknown[]) => void) => {
                if (event === 'error') {
                  childErrorHandler = handler as (error: Error) => void;
                }
              },
              kill: noop
            })
          }
        },
        true
      );

      restoreModuleMocks = restore;
      KBEngineServerManager = loadedModule.KBEngineServerManager;
      SERVER_COMPONENTS = loadedModule.SERVER_COMPONENTS;

      const manager = new KBEngineServerManager({ subscriptions: [] } as never);
      const interfaces = SERVER_COMPONENTS.find(component => component.name === 'interfaces');
      assert.ok(interfaces);
      if (!interfaces) {
        throw new Error('interfaces component should exist');
      }

      const result = await manager.startComponent(interfaces);
      assert.strictEqual(result, true);
      assert.ok(childErrorHandler);

      childErrorHandler?.(new Error('spawn failed'));
      await new Promise(resolve => originalSetTimeout(resolve, 10));

      assert.strictEqual(manager.getRunningServers().has('interfaces'), false);
      assert.deepStrictEqual(infoMessages, []);
    } finally {
      pendingTimers.forEach(timer => originalClearTimeout(timer));
      global.setTimeout = originalSetTimeout;
      global.clearTimeout = originalClearTimeout;
    }
  });
});
