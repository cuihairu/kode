import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { activate, deactivate } from '../src/extension';
import { commandRegistry, commands } from './fake-vscode/commandRegistry';
import { languagesRegistry } from './fake-vscode/languages';
import { messages, treeRegistrations, window as fakeWindow, windowState } from './fake-vscode/windowState';
import {
  workspace,
  workspaceEvents,
  workspaceState,
  configurationOverrides
} from './fake-vscode/workspaceState';
import { panelRegistry } from './fake-vscode/panelRegistry';
import {
  makeTextDocument,
  Position,
  Range,
  StatusBarAlignment,
  Uri,
  type ExtensionContext
} from './fake-vscode/core';

const disposeAll = (context: ExtensionContext): void => {
  for (const disposable of context.subscriptions) {
    disposable.dispose();
  }
};

const makeContext = (): ExtensionContext => ({
  subscriptions: [],
  extensionUri: Uri.file('/workspace/ext')
});

let root = '';
let defsRoot = '';

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-ext-branch-'));
  defsRoot = path.join(root, 'scripts', 'entity_defs');
  fs.mkdirSync(defsRoot, { recursive: true });
  fs.writeFileSync(
    path.join(defsRoot, 'Avatar.def'),
    [
      '<root>',
      '  <Properties>',
      '    <hp>',
      '      <Type>UINT32</Type>',
      '      <Flags>BASE_AND_CLIENT</Flags>',
      '    </hp>',
      '  </Properties>',
      '  <BaseMethods>',
      '    <respawn/>',
      '  </BaseMethods>',
      '</root>'
    ].join('\n'),
    'utf8'
  );
  fs.writeFileSync(
    path.join(root, 'scripts', 'entities.xml'),
    '<root>\n  <Avatar> <hasClient/></Avatar>\n</root>\n',
    'utf8'
  );
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  commandRegistry.reset();
  languagesRegistry.reset();
  windowState.reset();
  workspaceState.reset();
  panelRegistry.reset();
  workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
  workspace.textDocuments = [];
  workspace.findFiles = (async (pattern: string): Promise<Uri[]> => {
    if (pattern !== '**/*.def') {
      return [];
    }
    return [Uri.file(path.join(defsRoot, 'Avatar.def'))];
  });
});

describe('extension 单分支覆盖: method.open 成功侧 (didOpen true)', () => {
  it('字符串形态: didOpen true → 隐式 else 分支执行,无 warning', async () => {
    const context = makeContext();
    activate(context);

    // 等待异步索引建立
    await new Promise(resolve => setTimeout(resolve, 300));

    messages.warning.length = 0;
    await commands.executeCommand('kbengine.entity.method.open', 'Avatar', 'respawn', 'BaseMethods');

    // didOpen true → if (!didOpen) 条件假 → 隐式 else 分支(静默)被走到
    expect(messages.warning).toHaveLength(0);
    expect((workspaceState.openTextDocumentCalls.at(-1) as Uri).fsPath).toContain('Avatar.def');
    expect(windowState.showTextDocumentCalls.at(-1)?.document).toBeDefined();

    disposeAll(context);
    expect(deactivate()).toBeUndefined();
  });

  it('identity 形态: didOpen true → 隐式 else 分支执行,无 warning', async () => {
    const context = makeContext();
    activate(context);

    await new Promise(resolve => setTimeout(resolve, 300));

    messages.warning.length = 0;
    await commands.executeCommand('kbengine.entity.method.open', {
      ownerKind: 'entity',
      ownerName: 'Avatar',
      sourceKind: 'local',
      sourceChain: [],
      section: 'BaseMethods',
      symbolName: 'respawn'
    } as never);

    expect(messages.warning).toHaveLength(0);
    expect((workspaceState.openTextDocumentCalls.at(-1) as Uri).fsPath).toContain('Avatar.def');
    expect(windowState.showTextDocumentCalls.at(-1)?.document).toBeDefined();

    disposeAll(context);
    expect(deactivate()).toBeUndefined();
  });
});