import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { activate, deactivate } from '../src/extension';
import { commandRegistry, commands } from './fake-vscode/commandRegistry';
import { messages, windowState } from './fake-vscode/windowState';
import { workspace } from './fake-vscode/workspaceState';
import { makeTextDocument, Uri, type ExtensionContext } from './fake-vscode/core';

let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-project-doctor-'));
  commandRegistry.reset();
  windowState.channels.length = 0;
  messages.info.length = 0;
  messages.warning.length = 0;
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('kbengine.project.doctor', () => {
  it('reports connected entity inheritance and dangling references', async () => {
    fs.writeFileSync(path.join(root, 'entities.xml'), '<root><Hero><hasBase/></Hero></root>');
    const defs = path.join(root, 'entity_defs');
    fs.mkdirSync(defs);
    fs.writeFileSync(path.join(defs, 'Hero.def'), '<root><Properties><hp><Type>UINT8</Type></hp></Properties></root>');
    fs.writeFileSync(path.join(defs, 'Monster.def'), '<root><Parent>Hero</Parent><Properties><mp><Type>UINT8</Type></mp></Properties></root>');
    fs.writeFileSync(path.join(defs, 'Broken.def'), '<root><Parent>Missing</Parent></root>');

    workspace.findFiles = (async () => [Uri.file(path.join(defs, 'Hero.def'))]) as typeof workspace.findFiles;
    workspace.openTextDocument = (async (uri: unknown) => {
      const fsPath = (uri as Uri).fsPath;
      return makeTextDocument(fs.readFileSync(fsPath), { uri: uri as Uri, fileName: fsPath });
    }) as typeof workspace.openTextDocument;

    const context: ExtensionContext = { subscriptions: [], extensionUri: Uri.file(root) };
    activate(context);
    await new Promise(resolve => setTimeout(resolve, 100));

    await commands.executeCommand('kbengine.project.doctor');

    const channel = windowState.channels.find(entry => entry.name === 'KBEngine Project Doctor');
    const report = channel?.lines.join('\n') ?? '';
    expect(report).toContain('Project Doctor:');
    expect(report).toContain('Unresolved inherit reference');
    expect(messages.warning.at(-1)).toContain('Project Doctor 发现 1 项错误');

    for (const disposable of context.subscriptions) disposable.dispose();
    expect(deactivate()).toBeUndefined();
  });
});
