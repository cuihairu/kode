import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { activate, deactivate } from '../src/extension';
import { commandRegistry, commands } from './fake-vscode/commandRegistry';
import { commands as vscodeCommands } from './fake-vscode/commandRegistry';
import { window as fakeWindow } from './fake-vscode/windowState';
import { Uri, type ExtensionContext } from './fake-vscode/core';

beforeEach(() => {
  commandRegistry.reset();
});

afterEach(() => {
  fakeWindow.showQuickPick = async (): Promise<undefined> => undefined;
});

describe('kbengine.workbench.show', () => {
  it('registers and dispatches a grouped workflow entry', async () => {
    const context: ExtensionContext = { subscriptions: [], extensionUri: Uri.file('/tmp') };
    activate(context);
    await new Promise(resolve => setTimeout(resolve, 100));

    const executed: string[] = [];
    const originalExecute = vscodeCommands.executeCommand;
    vscodeCommands.executeCommand = (async command => {
      executed.push(command);
      return undefined;
    }) as typeof vscode.commands.executeCommand;
    vscode.window.showQuickPick = (async (items: unknown) => {
      const list = items as Array<{ label: string; command: string }>;
      expect(list.map(item => item.command)).toEqual([
        'kbengine.discovery.report',
        'kbengine.project.doctor',
        'kbengine.symbolReferences.show',
        'kbengine.monitoring.show',
        'kbengine.profile.start',
        'kbengine.runtimeQuery.show',
        'kbengine.spaces.query',
        'kbengine.database.open',
        'kbengine.database.checkAllDrift',
        'kbengine.clientSdk.generate',
        'kbengine.compatibility.check'
      ]);
      return list[1];
    }) as typeof vscode.window.showQuickPick;

    await commandRegistry.registrations.get('kbengine.workbench.show')!.handler();
    expect(executed).toEqual(['kbengine.project.doctor']);

    vscodeCommands.executeCommand = originalExecute;
    for (const disposable of context.subscriptions) disposable.dispose();
    expect(deactivate()).toBeUndefined();
  });
});
