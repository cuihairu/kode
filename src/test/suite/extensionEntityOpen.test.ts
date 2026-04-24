import * as assert from 'assert';
import { FakeUri, createVscodeStub, loadModuleWithMocks } from './testUtils';

type ExtensionModule = typeof import('../../extension');

describe('extension entity open command', () => {
  let restoreModuleMocks: (() => void) | undefined;
  let activate: ExtensionModule['activate'];
  let commands = new Map<string, (...args: unknown[]) => unknown>();
  let warningMessages: string[] = [];
  let openedDocumentPaths: string[] = [];
  let shownDocumentPaths: string[] = [];
  let shownSelectionStarts: Array<{ line: number; character: number } | null> = [];
  let resolvedDefinitionPath: string | null = '/workspace/scripts/entity_defs/Avatar.def';
  let databaseSchemaSnapshot: unknown = null;
  let databaseSchemaLine = 1;
  const noop = (): undefined => undefined;

  before(() => {
    commands = new Map();
    warningMessages = [];
    openedDocumentPaths = [];
    shownDocumentPaths = [];
    shownSelectionStarts = [];
    resolvedDefinitionPath = '/workspace/scripts/entity_defs/Avatar.def';
    databaseSchemaSnapshot = null;
    databaseSchemaLine = 1;

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
        registerTextDocumentContentProvider: () => noopDisposable,
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
        openTextDocument: async (uri: { fsPath: string }) => {
          openedDocumentPaths.push(uri.fsPath);
          if (uri.fsPath.includes('MissingOpen')) {
            throw new Error('ENOENT');
          }

          return { uri };
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
        showTextDocument: async (
          document: { uri: { fsPath: string } },
          options?: { selection?: { start: { line: number; character: number } } }
        ) => {
          shownDocumentPaths.push(document.uri.fsPath);
          shownSelectionStarts.push(options?.selection?.start ?? null);
          return undefined;
        }
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
      Uri: FakeUri,
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
        './definitionWorkspace': {
          findEntityDefinitionFile: (entityName: string) => {
            if (!resolvedDefinitionPath) {
              return null;
            }

            return resolvedDefinitionPath.replace('Avatar', entityName);
          }
        },
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
        },
        './databaseSchema': {
          createDatabaseSchemaUri: (entityName: string) => new FakeUri(`kbengine-db-schema:/${entityName}.schema`),
          getDatabaseSchemaSnapshot: () => databaseSchemaSnapshot,
          KBEngineDatabaseSchemaProvider: class { dispose = noop; },
          locateDatabaseSchemaLine: () => databaseSchemaLine
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

  beforeEach(() => {
    warningMessages = [];
    openedDocumentPaths = [];
    shownDocumentPaths = [];
    shownSelectionStarts = [];
    resolvedDefinitionPath = '/workspace/scripts/entity_defs/Avatar.def';
    databaseSchemaSnapshot = null;
    databaseSchemaLine = 1;
  });

  it('opens the resolved entity definition from definitionWorkspace', async () => {
    activate({ subscriptions: [], extensionUri: { fsPath: '/workspace/ext' } } as never);

    const command = commands.get('kbengine.entity.open');
    assert.ok(command);

    await command?.('Avatar');

    assert.deepStrictEqual(openedDocumentPaths, ['/workspace/scripts/entity_defs/Avatar.def']);
    assert.deepStrictEqual(shownDocumentPaths, ['/workspace/scripts/entity_defs/Avatar.def']);
    assert.deepStrictEqual(warningMessages, []);
  });

  it('warns when no entity definition can be resolved', async () => {
    resolvedDefinitionPath = null;
    activate({ subscriptions: [], extensionUri: { fsPath: '/workspace/ext' } } as never);

    const command = commands.get('kbengine.entity.open');
    assert.ok(command);

    await command?.('Avatar');

    assert.deepStrictEqual(openedDocumentPaths, []);
    assert.ok(warningMessages.some(message => message.includes('Avatar.def')));
    assert.strictEqual(warningMessages.length, 1);
  });

  it('shows the underlying error when opening an entity definition fails', async () => {
    resolvedDefinitionPath = '/workspace/scripts/entity_defs/MissingOpen.def';
    activate({ subscriptions: [], extensionUri: { fsPath: '/workspace/ext' } } as never);

    const command = commands.get('kbengine.entity.open');
    assert.ok(command);

    await command?.('MissingOpen');

    assert.ok(warningMessages.some(message => message.includes('MissingOpen.def')));
    assert.ok(warningMessages.some(message => message.includes('ENOENT')));
  });

  it('opens the virtual database schema and jumps to the requested field', async () => {
    databaseSchemaSnapshot = { tables: [] };
    databaseSchemaLine = 7;
    activate({ subscriptions: [], extensionUri: { fsPath: '/workspace/ext' } } as never);

    const command = commands.get('kbengine.database.open');
    assert.ok(command);

    await command?.('Avatar', 'tbl_Avatar', 'sm_health');

    assert.deepStrictEqual(openedDocumentPaths, ['kbengine-db-schema:/Avatar.schema']);
    assert.deepStrictEqual(shownDocumentPaths, ['kbengine-db-schema:/Avatar.schema']);
    assert.deepStrictEqual(
      shownSelectionStarts.map(position => position ? { line: position.line, character: position.character } : null),
      [{ line: 6, character: 0 }]
    );
    assert.deepStrictEqual(warningMessages, []);
  });
});
