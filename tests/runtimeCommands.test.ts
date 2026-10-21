import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { activate, deactivate } from '../src/extension';
import { commandRegistry, commands } from './fake-vscode/commandRegistry';
import { messages, windowState } from './fake-vscode/windowState';
import { Uri, type ExtensionContext } from './fake-vscode/core';

beforeEach(() => {
  commandRegistry.reset();
  windowState.channels.length = 0;
  messages.info.length = 0;
  messages.warning.length = 0;
  messages.error.length = 0;
});

afterEach(() => {
  // extension activate registers cleanup disposables; each test creates one.
});

describe('runtime command surface', () => {
  it('warns when no runtime components are discovered', async () => {
    const context: ExtensionContext = { subscriptions: [], extensionUri: Uri.file('/tmp') };
    activate(context);
    await new Promise(resolve => setTimeout(resolve, 100));

    await commands.executeCommand('kbengine.profile.start', 'baseapp', 'pyprofile');
    expect(messages.warning.at(-1)).toBe('未发现可查询的 KBEngine 组件');

    await commands.executeCommand('kbengine.spaces.query');
    expect(messages.warning.at(-1)).toBe('未发现可查询的 KBEngine 组件');

    for (const disposable of context.subscriptions) disposable.dispose();
    expect(deactivate()).toBeUndefined();
  });
});
