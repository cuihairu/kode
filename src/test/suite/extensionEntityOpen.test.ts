import * as assert from 'assert';
import { createVscodeStub, loadModuleWithMocks } from './testUtils';

type ExtensionModule = typeof import('../../extension');

describe('extension entity open command', () => {
  let restoreModuleMocks: (() => void) | undefined;
  let activate: ExtensionModule['activate'];
  let commands = new Map<string, (...args: unknown[]) => unknown>();
  let warningMessages: string[] = [];

  before(() => {
    commands = new Map();
    warningMessages = [];

    const noopDisposable = { dispose() {} };
    const vscodeStub = createVscodeStub({
      languages: {
        registerCompletionItemProvider: () => noopDisposable,
        registerHoverProvider: () => noopDisposable,
        registerDefinitionProvider: () => noopDisposable,
        createDiagnosticCollection: () => ({
          set() {},
          delete() {},
          dispose() {}
        })
      },
      workspace: {
        workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
        textDocuments: [],
        getConfiguration: (section?: string) => ({
          get<T>(key: string, defaultValue: T): T {
            if (section === 'kbengine') {
              const values: Record<string, unknown> = {
                entityDefsPath: 'scripts/entity_defs',
                loggerPort: 20022,
                maxLogEntries: 10000,
                logAutoConnect: false
              };
              return (values[key] as T | undefined) ?? defaultValue;
            }
            return defaultValue;
          }
        }),
        onDidChangeTextDocument: () => noopDisposable,
        onDidOpenTextDocument: () => noopDisposable,
        onDidChangeConfiguration: () => noopDisposable,
        openTextDocument: async () => {
          throw new Error('ENOENT');
        }
      },
      window: {
        registerTreeDataProvider: () => noopDisposable,
        createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {}, text: '', command: '' }),
        createOutputChannel: () => ({ appendLine() {}, append() {}, show() {}, dispose() {} }),
        showWarningMessage: (message: string) => {
          warningMessages.push(message);
          return undefined;
        },
        showErrorMessage: () => undefined,
        showInformationMessage: () => Promise.resolve(undefined),
        showTextDocument: async () => undefined
      },
      commands: {
        registerCommand: (name: string, handler: (...args: unknown[]) => unknown) => {
          commands.set(name, handler);
          return noopDisposable;
        }
      },
      debug: {
        startDebugging: async () => true
      },
      EventEmitter: class FakeEventEmitter<T> {
        event = () => undefined;
        fire(_value?: T): void {}
        dispose(): void {}
      },
      Uri: {
        joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ fsPath: [base.fsPath, ...parts].join('/') })
      },
      StatusBarAlignment: { Right: 2 },
      ViewColumn: { Two: 2 }
    });

    const { loadedModule, restore } = loadModuleWithMocks<ExtensionModule>(
      __filename,
      '../../extension',
      {
        vscode: vscodeStub,
        './serverManager': {
          KBEngineServerManager: class {
            onDidChangeStatus() {}
            getRunningServers() { return new Map(); }
            dispose() {}
          },
          SERVER_COMPONENTS: []
        },
        './logCollector': {
          KBEngineLogCollector: class {
            static PROTOCOL_WARNING = 'protocol warning';
            onLogEntry() {}
            connect() { return Promise.resolve(); }
            disconnect() {}
            dispose() {}
          }
        },
        './logWebView': { LogViewerWebView: class { show() {}; clearLogs() {}; exportLogs() {}; dispose() {} } },
        './debugConfig': { DebugConfigManager: class { updateLaunchJson() {}; createExampleConfig() {}; startDebugging() {}; attachToComponent() {}; dispose() {} } },
        './monitoringWebView': { MonitoringWebView: class { show() {}; dispose() {} } },
        './monitoringCollector': { MonitoringCollector: class { dispose() {} } },
        './entityMapping': { EntityMappingManager: class { dispose() {} } },
        './entityDependencyWebView': { EntityDependencyWebView: class { show() {}; dispose() {} } },
        './codeGenerator': { KBEngineCodeGenerator: class { showWizard() {}; showTemplates() {}; dispose() {} } },
        './explorerProviders': {
          EntityExplorerProvider: class { refresh() {} },
          pickServerComponent: async () => undefined,
          ServerControlProvider: class { refresh() {} }
        },
        './serverCommandTarget': { resolveServerComponent: () => undefined },
        './languageProviders': {
          KBEngineCompletionProvider: class {},
          KBEngineDefinitionProvider: class {},
          KBEngineHoverProvider: class {},
          PythonCompletionProvider: class {},
          PythonDefinitionProvider: class {},
          validateDocument() {}
        }
      },
      true
    );

    restoreModuleMocks = restore;
    activate = loadedModule.activate;
  });

  after(() => {
    restoreModuleMocks?.();
  });

  it('shows the underlying error when opening an entity definition fails', async () => {
    activate({ subscriptions: [], extensionUri: { fsPath: '/workspace/ext' } } as never);

    const command = commands.get('kbengine.entity.open');
    assert.ok(command);

    await command?.('Avatar');

    assert.ok(warningMessages.some(message => message.includes('Avatar.def')));
    assert.ok(warningMessages.some(message => message.includes('ENOENT')));
  });
});
