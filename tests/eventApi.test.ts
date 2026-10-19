import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { EventCodeLensProvider, eventDefinitionAt, findEventCalls } from '../src/eventApi';
import { makeTextDocument } from './helpers/vscodeStub';

describe('KBEngine event API parsing', () => {
  it('recognizes literal callbacks from both registration APIs', () => {
    expect(findEventCalls('self.addEvent(PLAYER_EVENT, "on_player")\nself.registerEvent(PLAYER_EVENT, \'on_player\')')
      .filter(call => call.callback).map(call => call.callback)).toEqual(['on_player', 'on_player']);
  });

  it.each(['addEvent', 'registerEvent'] as const)('jumps from %s literal callback to its method', async api => {
    const source = `self.${api}(PLAYER_EVENT, "on_player")\ndef on_player(self):\n    pass`;
    const doc = makeTextDocument(source, { fileName: '/ws/entity.py', languageId: 'python' }) as vscode.TextDocument;
    const location = await eventDefinitionAt(doc, new vscode.Position(0, source.indexOf('"on_player"') + 2));
    expect(location?.uri.fsPath).toBe('/ws/entity.py');
    expect(location?.range.start.line).toBe(1);
  });

  it('merges addEvent and registerEvent listeners for an emitEvent event', () => {
    const calls = findEventCalls('self.addEvent(PLAYER_EVENT, "a")\nself.registerEvent(PLAYER_EVENT, "b")\nself.emitEvent(PLAYER_EVENT)');
    const emit = calls.find(call => call.api === 'emitEvent');
    expect(calls.filter(call => (call.api === 'addEvent' || call.api === 'registerEvent') && call.event === emit?.event)).toHaveLength(2);
  });

  it('shows one merged, clickable listener count on emitEvent', async () => {
    const originalFindFiles = vscode.workspace.findFiles;
    const originalOpen = vscode.workspace.openTextDocument;
    const listenerA = vscode.Uri.file('/ws/a.py');
    const listenerB = vscode.Uri.file('/ws/b.py');
    vscode.workspace.findFiles = async () => [listenerA, listenerB];
    vscode.workspace.openTextDocument = async (uri: vscode.Uri) => makeTextDocument(
      uri.fsPath === listenerA.fsPath ? 'self.addEvent(EVT, "one")' : 'self.registerEvent(EVT, "two")',
      { fileName: uri.fsPath, languageId: 'python' }
    ) as vscode.TextDocument;
    try {
      const doc = makeTextDocument('self.emitEvent(EVT)', { fileName: '/ws/emit.py', languageId: 'python' }) as vscode.TextDocument;
      const lenses = await new EventCodeLensProvider().provideCodeLenses(doc);
      expect(lenses.map(lens => (lens.command as { title: string }).title)).toContain('2 处监听');
      expect((lenses.find(lens => (lens.command as { title: string }).title === '2 处监听')?.command as { command: string }).command).toBe('vscode.open');
    } finally {
      vscode.workspace.findFiles = originalFindFiles;
      vscode.workspace.openTextDocument = originalOpen;
    }
  });

  it('does not infer callback names from variables', () => {
    const calls = findEventCalls('self.addEvent(PLAYER_EVENT, handler_var)');
    expect(calls[0].callback).toBeUndefined();
    expect(calls.some(call => call.callback)).toBe(false);
  });

  it('recognizes bare event constants for cross-file resolution', () => {
    expect(findEventCalls('self.emitEvent(PLAYER_EVENT + suffix)')).toEqual([]);
    expect(findEventCalls('self.emitEvent(PLAYER_EVENT)')[0].event).toBe('PLAYER_EVENT');
  });

  it('resolves a Python event constant assignment in another project file', async () => {
    const originalFindFiles = vscode.workspace.findFiles;
    const originalOpen = vscode.workspace.openTextDocument;
    const target = vscode.Uri.file('/ws/events.py');
    vscode.workspace.findFiles = async () => [target];
    vscode.workspace.openTextDocument = async () => makeTextDocument('PLAYER_EVENT = "player_ready"', { fileName: target.fsPath, languageId: 'python' }) as vscode.TextDocument;
    try {
      const doc = makeTextDocument('self.emitEvent(PLAYER_EVENT)', { fileName: '/ws/use.py', languageId: 'python' }) as vscode.TextDocument;
      const location = await eventDefinitionAt(doc, new vscode.Position(0, 17));
      expect(location?.uri.fsPath).toBe(target.fsPath);
      expect(location?.range.start.line).toBe(0);
    } finally {
      vscode.workspace.findFiles = originalFindFiles;
      vscode.workspace.openTextDocument = originalOpen;
    }
  });
});
