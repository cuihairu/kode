import * as assert from 'assert';
import { loadModuleWithMocks } from './testUtils';

class FakeUri {
  constructor(public fsPath: string) {}

  static joinPath(base: FakeUri, ...paths: string[]): FakeUri {
    return new FakeUri([base.fsPath, ...paths].join('/'));
  }

  toString(): string {
    return this.fsPath;
  }
}

class FakeEventEmitter {
  event = () => undefined;
  fire(): void {
    return;
  }
  dispose(): void {
    return;
  }
}

class FakeWatcher {
  onDidChange(): void {
    return;
  }
  onDidCreate(): void {
    return;
  }
  onDidDelete(): void {
    return;
  }
  dispose(): void {
    return;
  }
}

type DebugConfigModule = typeof import('../../debugConfig');

describe('DebugConfigManager', () => {
  let restoreModuleMocks: (() => void) | undefined;
  let DebugConfigManager: DebugConfigModule['DebugConfigManager'];

  before(() => {
    const fakeVscode = {
      workspace: {
        workspaceFolders: [{ uri: new FakeUri('/workspace') }],
        fs: {
          readFile: async () => {
            throw new Error('missing');
          },
          createDirectory: async () => undefined,
          writeFile: async () => undefined
        },
        createFileSystemWatcher: () => new FakeWatcher()
      },
      window: {
        showInformationMessage: async () => undefined,
        showWarningMessage: async () => undefined,
        showErrorMessage: async () => undefined,
        showInputBox: async () => undefined
      },
      debug: {
        startDebugging: async () => true
      },
      Uri: FakeUri,
      EventEmitter: FakeEventEmitter
    };

    const { loadedModule, restore } = loadModuleWithMocks<DebugConfigModule>(
      __filename,
      '../../debugConfig',
      { vscode: fakeVscode },
      true
    );
    restoreModuleMocks = restore;
    DebugConfigManager = loadedModule.DebugConfigManager;
  });

  after(() => {
    restoreModuleMocks?.();
  });

  it('uses source-backed telnet defaults for core components', () => {
    const manager = new DebugConfigManager({ subscriptions: [] } as never);

    assert.strictEqual(manager.getComponentConfig('baseapp').telnetPort, 40000);
    assert.strictEqual(manager.getComponentConfig('cellapp').telnetPort, 50000);
    assert.strictEqual(manager.getComponentConfig('loginapp').telnetPort, 31000);
    assert.strictEqual(manager.getComponentConfig('dbmgr').telnetPort, 32000);
    assert.strictEqual(manager.getComponentConfig('interfaces').telnetPort, 33000);
    assert.strictEqual(manager.getComponentConfig('logger').telnetPort, 34000);
    assert.strictEqual(manager.getComponentConfig('bots').telnetPort, 51000);
    assert.strictEqual(manager.getComponentConfig('baseapp').telnetDefaultLayer, 'python');
    assert.strictEqual(manager.getComponentConfig('baseapp').telnetPassword, 'pwd123456');
  });

  it('generates python attach launch configs with KBEngine grouping', () => {
    const manager = new DebugConfigManager({ subscriptions: [] } as never);
    const configs = manager.generateLaunchConfigurations();
    const baseappConfig = configs.find(item => item.name === 'KBEngine: Python attach to baseapp');

    assert.ok(baseappConfig);
    assert.strictEqual(baseappConfig.type, 'debugpy');
    assert.strictEqual(baseappConfig.request, 'attach');
    assert.strictEqual(baseappConfig.presentation.group, 'KBEngine');
    assert.strictEqual(baseappConfig.pathMappings[0].localRoot, '/workspace');
  });
});
