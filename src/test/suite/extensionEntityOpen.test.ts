import * as assert from 'assert';
import { createVscodeStub, loadModuleWithMocks } from './testUtils';

type ExtensionModule = typeof import('../../extension');

describe('extension entity open command', () => {
  let restoreModuleMocks: (() => void) | undefined;
  let activate: ExtensionModule['activate'];
  let commands = new Map<string, (...args: unknown[]) => unknown>();
  let warningMessages: string[] = [];
  const noop = (): undefined => undefined;

  before(() => {
    commands = new Map();
    warningMessages = [];

    const noopDisposable = { dispose: noop };
    const vscodeStub = createVscodeStub({
      languages: {
        registerCompletionItemProvider: () => noopDisposable,
        registerHoverProvider: () => noopDisposable,
        registerDefinitionProvider: () => noopDisposable,
        createDiagnosticCollection: () => ({
          set: noop,
          delete: noop,
          dispose: noop
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
        createStatusBarItem: () => ({ show: noop, hide: noop, dispose: noop, text: '', command: '' }),
        createOutputChannel: () => ({ appendLine: noop, append: noop, show: noop, dispose: noop }),
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
        fire(value?: T): void {
          void value;
        }
        dispose = noop;
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
            onDidChangeStatus = noop;
            getRunningServers() { return new Map(); }
            dispose = noop;
          },
          SERVER_COMPONENTS: []
        },
        './logCollector': {
          KBEngineLogCollector: class {
            static PROTOCOL_WARNING = 'protocol warning';
            onLogEntry = noop;
            connect() { return Promise.resolve(); }
            disconnect = noop;
            dispose = noop;
          }
        },
        './logWebView': { LogViewerWebView: class { show = noop; clearLogs = noop; exportLogs = noop; dispose = noop; } },
        './debugConfig': { DebugConfigManager: class { updateLaunchJson = noop; createExampleConfig = noop; startDebugging = noop; attachToComponent = noop; dispose = noop; } },
        './monitoringWebView': { MonitoringWebView: class { show = noop; dispose = noop; } },
        './monitoringCollector': { MonitoringCollector: class { dispose = noop; } },
        './entityMapping': { EntityMappingManager: class { dispose = noop; } },
        './entityDependencyWebView': { EntityDependencyWebView: class { show = noop; dispose = noop; } },
        './codeGenerator': { KBEngineCodeGenerator: class { showWizard = noop; showTemplates = noop; dispose = noop; } },
        './explorerProviders': {
          EntityExplorerProvider: class { refresh = noop; },
          pickServerComponent: async () => undefined,
          ServerControlProvider: class { refresh = noop; }
        },
        './serverCommandTarget': { resolveServerComponent: () => undefined },
        './languageProviders': {
          KBEngineCompletionProvider: class {},
          KBEngineDefinitionProvider: class {},
          KBEngineHoverProvider: class {},
          PythonCompletionProvider: class {},
          PythonDefinitionProvider: class {},
          validateDocument: noop
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
