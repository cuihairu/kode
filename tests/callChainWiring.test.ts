import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CallChainController } from '../src/defCallChainProvider';
import { EntityMappingManager } from '../src/entityMapping';
import {
  configurationOverrides,
  makeTextDocument,
  panelRegistry,
  Uri,
  window as stubWindow,
  workspace as stubWorkspace
} from './helpers/vscodeStub';
import * as vscode from 'vscode';

type QuickPickItem = { label: string; line: number; methodName: string };

const managers: EntityMappingManager[] = [];
const roots: string[] = [];
const originalFolders = stubWorkspace.workspaceFolders;
const originalFindFiles = stubWorkspace.findFiles;
const originalQuickPick = stubWindow.showQuickPick;

interface IndexAccessor {
  getIndexForPythonFile?: (pythonFile: string) => unknown;
  waitForInitialScan?: () => Promise<void>;
}

const makeIndex = (pythonFile: string) => ({
  rootName: 'Hero',
  rootCategory: 'entity',
  rootDefFile: join('/tmp/project', 'scripts', 'entity_defs', 'Hero.def'),
  semantics: {},
  propertyDefinitions: [],
  methodDefinitions: [{
    defFile: join('/tmp/project', 'scripts', 'entity_defs', 'Hero.def'),
    line: 2,
    section: 'BaseMethods',
    exposed: false,
    owner: { kind: 'entity', name: 'Hero', filePath: join('/tmp/project', 'scripts', 'entity_defs', 'Hero.def'), line: 1 },
    declaredArgs: ['UINT32'],
    identity: {
      ownerKind: 'entity', ownerName: 'Hero', sourceKind: 'local',
      sourceChain: ['Hero'], section: 'BaseMethods', symbolName: 'start'
    }
  }],
  pythonOwnerFiles: [],
  pythonMethods: [{
    filePath: pythonFile,
    methodName: 'start',
    line: 1,
    character: 4,
    endLine: 3,
    calls: [{ methodName: 'move', line: 2, character: 19, filePath: pythonFile }],
    binding: {
      pythonFile,
      identity: {
        ownerKind: 'entity', ownerName: 'Hero', sourceKind: 'local',
        sourceChain: ['Hero'], section: 'BaseMethods', symbolName: 'start'
      }
    }
  }]
});

const makeManager = (): EntityMappingManager => {
  const manager = new EntityMappingManager({ subscriptions: [] });
  managers.push(manager);
  const index = makeIndex('/tmp/project/scripts/base/Hero.py');
  return new Proxy(manager, {
    get(target, property, receiver) {
      if (property === 'getIndexForPythonFile') return () => index;
      if (property === 'waitForInitialScan') return async () => undefined;
      return Reflect.get(target, property, receiver);
    }
  });
};

const makePythonDocument = () => makeTextDocument('class Hero:\n    def start(self):\n        pass\n', {
  fileName: '/tmp/project/scripts/base/Hero.py',
  languageId: 'python'
});

afterEach(() => {
  managers.splice(0).forEach(manager => manager.dispose());
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
  stubWorkspace.workspaceFolders = originalFolders;
  stubWorkspace.findFiles = originalFindFiles;
  stubWindow.showQuickPick = originalQuickPick;
  configurationOverrides.delete('kbengine.python');
  panelRegistry.reset();
});

describe('call chain wiring', () => {
  it('does not create call-chain lenses when the setting is false', async () => {
    configurationOverrides.set('kbengine.python', { callChainHints: false });
    const controller = new CallChainController(makeManager());
    expect(await controller.provideCodeLenses(makePythonDocument())).toEqual([]);
  });

  it('does not build a preview when the setting is false', async () => {
    configurationOverrides.set('kbengine.python', { callChainHints: false });
    const controller = new CallChainController(makeManager());
    await controller.showForActiveEditor(Uri.file('/tmp/project/scripts/base/Hero.py'), 2, 'start');
    expect(panelRegistry.panels).toHaveLength(0);
  });

  it('creates a preview panel with the extracted chain and mermaid source', async () => {
    const controller = new CallChainController(makeManager());
    await controller.showForActiveEditor(Uri.file('/tmp/project/scripts/base/Hero.py'), 2, 'start');
    expect(panelRegistry.panels).toHaveLength(1);
    expect(panelRegistry.panels[0].viewType).toBe('kbengine.defCallChain');
    expect(panelRegistry.panels[0].webview.html).toContain('BaseMethods.start(UINT32)');
    expect(decodeURIComponent(
      /data-mermaid="([^"]+)/.exec(panelRegistry.panels[0].webview.html)?.[1] ?? ''
    )).toContain('flowchart TD');
  });

  it('reuses one panel for rapid invocations and shows the newest chain', async () => {
    const controller = new CallChainController(makeManager());
    const first = controller.showForActiveEditor(Uri.file('/tmp/project/scripts/base/Hero.py'), 2, 'start');
    const second = controller.showForActiveEditor(Uri.file('/tmp/project/scripts/base/Hero.py'), 2, 'start');
    await Promise.all([first, second]);
    await controller.showForActiveEditor(Uri.file('/tmp/project/scripts/base/Hero.py'), 2, 'start');

    expect(panelRegistry.panels).toHaveLength(1);
    expect(panelRegistry.panels[0].revealed).toBe(true);
    expect(panelRegistry.panels[0].webview.html).toContain('BaseMethods.start(UINT32)');
  });

  it('recreates the panel after an explicit close and cleans up once', async () => {
    const controller = new CallChainController(makeManager());
    await controller.showForActiveEditor(Uri.file('/tmp/project/scripts/base/Hero.py'), 2, 'start');
    panelRegistry.panels[0].dispose();

    await controller.showForActiveEditor(Uri.file('/tmp/project/scripts/base/Hero.py'), 2, 'start');
    expect(panelRegistry.panels).toHaveLength(2);

    controller.dispose();
    controller.dispose();
    expect(panelRegistry.panels[0].disposeListeners).toHaveLength(0);
    expect(panelRegistry.panels[1].disposed).toBe(true);
    expect(panelRegistry.panels[1].disposeListeners).toHaveLength(0);
  });

  it('picks one entity method when the command has no explicit target', async () => {
    const root = mkdtempSync(join(tmpdir(), 'call-chain-wiring-'));
    roots.push(root);
    mkdirSync(join(root, 'scripts', 'entity_defs'), { recursive: true });
    mkdirSync(join(root, 'scripts', 'base'), { recursive: true });
    writeFileSync(join(root, 'scripts', 'entity_defs', 'Hero.def'), [
      '<root>',
      '  <BaseMethods>',
      '    <start>',
      '      <Arg>UINT32</Arg>',
      '    </start>',
      '  </BaseMethods>',
      '</root>'
    ].join('\n'));
    stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    stubWorkspace.findFiles = async () => [Uri.file(join(root, 'scripts', 'entity_defs', 'Hero.def'))];

    const manager = new EntityMappingManager({ subscriptions: [] });
    managers.push(manager);
    for (let index = 0; index < 300; index += 1) {
    if (manager.getAllMappings().length > 0) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const realManager = manager;
    const controller = new CallChainController(realManager);
    const documentUri = Uri.file(join(root, 'scripts', 'base', 'Hero.py'));
    writeFileSync(join(root, 'scripts', 'base', 'Hero.py'), 'class Hero:\n    def start(self):\n        pass\n');
    await controller.showForActiveEditor(documentUri, 2, 'start');
    stubWindow.activeTextEditor = { document: makePythonDocument() } as never;
    try {
      await controller.showForActiveEditor();
    } finally {
      delete (stubWindow as { activeTextEditor?: unknown }).activeTextEditor;
    }
    expect(panelRegistry.panels).toHaveLength(1);
    expect(panelRegistry.panels[0].webview.html).toContain('BaseMethods.start(UINT32)');
  });

  it('uses quick pick when more than one entity method is present', async () => {
    const manager = makeManager();
    manager.resolveMethodDefinition = async (_file, methodName) => ({
      defFile: '/tmp/Hero.def',
      line: 2,
      section: methodName === 'move' ? 'CellMethods' : 'BaseMethods',
      exposed: false,
      identity: { symbolName: methodName, ownerName: 'Hero', ownerKind: 'entity', sourceKind: 'local', sourceChain: ['Hero'] }
    }) as Awaited<ReturnType<EntityMappingManager['resolveMethodDefinition']>>;
    const controller = new CallChainController(manager);
    const document = makeTextDocument('class Hero:\n    def start(self):\n    def move(self):\n', {
      fileName: '/tmp/project/scripts/base/Hero.py',
      languageId: 'python'
    });
    let picked: QuickPickItem | undefined;
    stubWindow.showQuickPick = async items => {
      picked = (items as QuickPickItem[])[0];
      return picked;
    };
    stubWindow.activeTextEditor = { document } as never;
    try {
      await controller.showForActiveEditor();
      expect(picked?.methodName).toBe('start');
    } finally {
      delete (stubWindow as { activeTextEditor?: unknown }).activeTextEditor;
    }
  });
});
