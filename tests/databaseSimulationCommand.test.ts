import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { activate } from '../src/extension';
import { KBENGINE_DATABASE_SIMULATION_SCHEME } from '../src/databaseSimulator';
import { commandRegistry, commands } from './fake-vscode/commandRegistry';
import { messages, window as fakeWindow, windowState } from './fake-vscode/windowState';
import { workspace, workspaceState } from './fake-vscode/workspaceState';
import { makeTextDocument, Uri, type ExtensionContext } from './fake-vscode/core';
import { window as stubWindow } from './helpers/vscodeStub';

// 数据库模拟(批122)命令装配层:kbengine.database.simulate(显式实体名 /
// 活动 .def 推断 / 无源提示 / openTextDocument 失败)与
// kbengine.database.exportSimulation(取消 / 落盘 / 写失败)。纯逻辑由
// tests/databaseSimulator.test.ts 覆盖。

const makeContext = (): ExtensionContext => ({
  subscriptions: [],
  extensionUri: Uri.file('/workspace/ext')
});

const windowish = stubWindow as unknown as Record<string, unknown>;

let root = '';

const writeDef = (relative: string, lines: string[]): void => {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, lines.join('\n'), 'utf8');
};

const SHIP_DEF = [
  '<root>',
  '  <Properties>',
  '    <hp>',
  '      <Type>UINT32</Type>',
  '      <Flags>BASE</Flags>',
  '      <Persistent>true</Persistent>',
  '    </hp>',
  '  </Properties>',
  '</root>'
].join('\n');

const activateAndWait = async (): Promise<ExtensionContext> => {
  const context = makeContext();
  activate(context);
  await new Promise(resolve => setTimeout(resolve, 300));
  return context;
};

const simulationEditor = (): unknown => ({
  document: makeTextDocument('# KBEngine Database Simulation: Ship', {
    uri: Uri.parse(`${KBENGINE_DATABASE_SIMULATION_SCHEME}://Ship.dbsim`)
  }),
  selection: { isEmpty: true, start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }
});

describe('kbengine.database.simulate 命令', () => {
  let originalOpenTextDocument: unknown;
  let originalActiveTextEditor: unknown;

  beforeEach(() => {
    commandRegistry.reset();
    windowState.reset();
    workspaceState.reset();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-db-sim-cmd-'));
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    workspace.textDocuments = [];
    originalOpenTextDocument = workspace.openTextDocument;
    originalActiveTextEditor = windowish.activeTextEditor;
  });

  afterEach(() => {
    workspace.openTextDocument = originalOpenTextDocument as typeof workspace.openTextDocument;
    if (originalActiveTextEditor === undefined) {
      delete windowish.activeTextEditor;
    } else {
      windowish.activeTextEditor = originalActiveTextEditor;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('显式实体名打开模拟虚拟文档', async () => {
    writeDef('scripts/entity_defs/Ship.def', SHIP_DEF.split('\n'));
    await activateAndWait();

    await commands.executeCommand('kbengine.database.simulate', 'Ship');

    expect(workspaceState.openTextDocumentCalls).toHaveLength(1);
    expect((workspaceState.openTextDocumentCalls[0] as Uri).scheme).toBe(KBENGINE_DATABASE_SIMULATION_SCHEME);
    expect(windowState.showTextDocumentCalls).toHaveLength(1);
    expect(messages.info).toEqual([]);
    expect(messages.warning).toEqual([]);
  });

  it('无参时从活动 .def 编辑器推断实体名', async () => {
    writeDef('scripts/entity_defs/Ship.def', SHIP_DEF.split('\n'));
    windowish.activeTextEditor = {
      document: makeTextDocument(SHIP_DEF, { fileName: path.join(root, 'scripts', 'entity_defs', 'Ship.def'), languageId: 'kbengine-def' })
    };
    await activateAndWait();

    await commands.executeCommand('kbengine.database.simulate');

    expect((workspaceState.openTextDocumentCalls[0] as Uri).fsPath).toBe('Ship.dbsim');
  });

  it('无参且无活动 .def 时如实提示,不静默空转', async () => {
    await activateAndWait();

    await commands.executeCommand('kbengine.database.simulate');

    expect(workspaceState.openTextDocumentCalls).toHaveLength(0);
    expect(messages.info.at(-1)).toContain('请先打开一个实体 .def 文件');
  });

  it('活动编辑器非 .def 语言时不推断', async () => {
    windowish.activeTextEditor = {
      document: makeTextDocument('print(1)', { fileName: path.join(root, 'main.py'), languageId: 'python' })
    };
    await activateAndWait();

    await commands.executeCommand('kbengine.database.simulate');

    expect(messages.info.at(-1)).toContain('请先打开一个实体 .def 文件');
  });

  it('openTextDocument 失败时警告并带实体名', async () => {
    writeDef('scripts/entity_defs/Ship.def', SHIP_DEF.split('\n'));
    workspace.openTextDocument = (async (): Promise<never> => {
      throw new Error('boom');
    }) as typeof workspace.openTextDocument;
    await activateAndWait();

    await commands.executeCommand('kbengine.database.simulate', 'Ship');

    expect(messages.warning.at(-1)).toContain('打开数据库模拟失败: Ship');
    expect(messages.warning.at(-1)).toContain('boom');
  });
});

describe('kbengine.database.exportSimulation 命令', () => {
  const windowish2 = windowish;
  let originalSaveDialog: unknown;
  let originalActiveTextEditor: unknown;
  let originalFs: typeof workspace.fs;

  beforeEach(() => {
    commandRegistry.reset();
    windowState.reset();
    workspaceState.reset();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-db-sim-exp-'));
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    workspace.textDocuments = [];
    originalSaveDialog = windowish2.showSaveDialog;
    originalActiveTextEditor = windowish2.activeTextEditor;
    originalFs = workspace.fs;
  });

  afterEach(() => {
    windowish2.showSaveDialog = originalSaveDialog;
    if (originalActiveTextEditor === undefined) {
      delete windowish2.activeTextEditor;
    } else {
      windowish2.activeTextEditor = originalActiveTextEditor;
    }
    workspace.fs = originalFs;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('活动编辑器非模拟文档时提示先打开,不弹保存框', async () => {
    windowish2.activeTextEditor = {
      document: makeTextDocument(SHIP_DEF, { fileName: path.join(root, 'Ship.def') })
    };
    await activateAndWait();

    await commands.executeCommand('kbengine.database.exportSimulation');

    expect(messages.warning.at(-1)).toContain('请先打开数据库模拟文档');
  });

  it('保存框取消时不写盘', async () => {
    windowish2.activeTextEditor = simulationEditor();
    let writes = 0;
    workspace.fs = {
      ...originalFs,
      writeFile: (async (): Promise<void> => {
        writes += 1;
      }) as typeof workspace.fs.writeFile
    };
    await activateAndWait();

    await commands.executeCommand('kbengine.database.exportSimulation');

    expect(writes).toBe(0);
    expect(messages.error).toEqual([]);
  });

  it('确认保存后把模拟文档全文写入 workspace.fs', async () => {
    windowish2.activeTextEditor = simulationEditor();
    const target = path.join(root, 'ship-simulation.md');
    windowish2.showSaveDialog = (async () => Uri.file(target)) as typeof windowish2.showSaveDialog;
    const writes: Array<{ path: string; text: string }> = [];
    workspace.fs = {
      ...originalFs,
      writeFile: (async (uri: Uri, content: Uint8Array): Promise<void> => {
        writes.push({ path: uri.fsPath, text: Buffer.from(content).toString('utf8') });
      }) as typeof workspace.fs.writeFile
    };
    await activateAndWait();

    await commands.executeCommand('kbengine.database.exportSimulation');

    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe(target);
    expect(writes[0].text).toContain('# KBEngine Database Simulation: Ship');
    expect(messages.error).toEqual([]);
  });

  it('写盘失败进错误通道,不裸抛', async () => {
    windowish2.activeTextEditor = simulationEditor();
    windowish2.showSaveDialog = (async () => Uri.file(path.join(root, 'out.md'))) as typeof windowish2.showSaveDialog;
    workspace.fs = {
      ...originalFs,
      writeFile: (async (): Promise<never> => {
        throw new Error('EACCES: denied');
      }) as typeof workspace.fs.writeFile
    };
    await activateAndWait();

    await commands.executeCommand('kbengine.database.exportSimulation');

    expect(messages.error.at(-1)).toContain('导出数据库模拟失败');
    expect(messages.error.at(-1)).toContain('EACCES');
  });

  it('无活动编辑器时提示先打开', async () => {
    await activateAndWait();

    await commands.executeCommand('kbengine.database.exportSimulation');

    expect(messages.warning.at(-1)).toContain('请先打开数据库模拟文档');
  });
});
