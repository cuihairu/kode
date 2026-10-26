import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { EventCodeLensProvider, eventDefinitionAt, findEventCalls } from '../src/eventApi';
import { configurationOverrides, makeTextDocument } from './helpers/vscodeStub';

describe('KBEngine event API parsing', () => {

it('supports object-bound string events with attribute callbacks', () => {
  const calls = findEventCalls('self.addEvent("ev_ready", self.on_ready)');
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ api: 'addEvent', event: 'ev_ready', callback: 'on_ready' });
});

it('normalizes dotted event constants and anchors offsets on the final segment', () => {
  const src = 'self.removeEvent(self.EV_CLEANUP)';
  const calls = findEventCalls(src);
  expect(calls).toHaveLength(1);
  expect(calls[0].event).toBe('EV_CLEANUP');
  expect(src.slice(calls[0].eventOffset, calls[0].eventOffset + 'EV_CLEANUP'.length)).toBe('EV_CLEANUP');
});

it('pairs dotted self.addEvent with self.emitEvent for the listener CodeLens', async () => {
  const originalFindFiles = vscode.workspace.findFiles;
  const originalOpen = vscode.workspace.openTextDocument;
  const listener = vscode.Uri.file('/ws/entity.py');
  vscode.workspace.findFiles = async () => [listener];
  vscode.workspace.openTextDocument = async () => makeTextDocument(
    'self.addEvent("ev_ready", self.on_ready)\ndef on_ready(self):\n    pass',
    { fileName: listener.fsPath, languageId: 'python' }
  ) as vscode.TextDocument;
  try {
    const doc = makeTextDocument('self.emitEvent("ev_ready")', { fileName: '/ws/emit.py', languageId: 'python' }) as vscode.TextDocument;
    const lenses = await new EventCodeLensProvider().provideCodeLenses(doc);
    const titles = lenses.map(lens => (lens.command as { title: string }).title);
    expect(titles).toContain('1 处监听');
  } finally {
    vscode.workspace.findFiles = originalFindFiles;
    vscode.workspace.openTextDocument = originalOpen;
  }
});

it('stays silent when the event name is an expression', () => {
  expect(findEventCalls('self.addEvent(f"ev_{kind}", self.on_ready)')).toHaveLength(0);
});

it('keeps the call without callback when the callback is an expression', () => {
  const calls = findEventCalls('self.addEvent(EV_X, lambda *_args: None)');
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ api: 'addEvent', event: 'EV_X' });
  expect(calls[0].callback).toBeUndefined();
});

  it('shows the event name on a single callback CodeLens', async () => {
    const originalFindFiles = vscode.workspace.findFiles;
    vscode.workspace.findFiles = async () => [];
    try {
      const doc = makeTextDocument('self.addEvent(PLAYER_EVENT, "on_player")\ndef on_player(self):\n    pass', { fileName: '/ws/entity.py', languageId: 'python' }) as vscode.TextDocument;
      const lenses = await new EventCodeLensProvider().provideCodeLenses(doc);
      expect((lenses[0].command as { title: string }).title).toBe('事件回调 · PLAYER_EVENT');
    } finally { vscode.workspace.findFiles = originalFindFiles; }
  });

  it('lists up to three distinct registered events in first-seen order', async () => {
    const originalFindFiles = vscode.workspace.findFiles;
    vscode.workspace.findFiles = async () => [];
    try {
      const source = 'self.addEvent(A_EVENT, "on_ready")\nself.registerEvent(B_EVENT, "on_ready")\nself.addEvent(A_EVENT, "on_ready")\nself.addEvent(C_EVENT, "on_ready")\ndef on_ready(self):\n    pass';
      const doc = makeTextDocument(source, { fileName: '/ws/entity.py', languageId: 'python' }) as vscode.TextDocument;
      const lenses = await new EventCodeLensProvider().provideCodeLenses(doc);
      expect((lenses[0].command as { title: string }).title).toBe('事件回调 · A_EVENT、B_EVENT、C_EVENT');
    } finally { vscode.workspace.findFiles = originalFindFiles; }
  });

  it('folds more than three events into the first event and total count', async () => {
    const originalFindFiles = vscode.workspace.findFiles;
    vscode.workspace.findFiles = async () => [];
    try {
      const source = ['A_EVENT', 'B_EVENT', 'C_EVENT', 'D_EVENT', 'E_EVENT'].map(event => `self.addEvent(${event}, "on_ready")`).join('\n') + '\ndef on_ready(self):\n    pass';
      const doc = makeTextDocument(source, { fileName: '/ws/entity.py', languageId: 'python' }) as vscode.TextDocument;
      const lenses = await new EventCodeLensProvider().provideCodeLenses(doc);
      expect((lenses[0].command as { title: string }).title).toBe('事件回调 · A_EVENT 等 5 个');
    } finally { vscode.workspace.findFiles = originalFindFiles; }
  });

  it('merges and deduplicates event names across addEvent and registerEvent', async () => {
    const originalFindFiles = vscode.workspace.findFiles;
    vscode.workspace.findFiles = async () => [];
    try {
      const source = 'self.addEvent(PLAYER_EVENT, "on_ready")\nself.registerEvent(PLAYER_EVENT, "on_ready")\nself.registerEvent(OTHER_EVENT, "on_ready")\ndef on_ready(self):\n    pass';
      const doc = makeTextDocument(source, { fileName: '/ws/entity.py', languageId: 'python' }) as vscode.TextDocument;
      const lenses = await new EventCodeLensProvider().provideCodeLenses(doc);
      expect((lenses[0].command as { title: string }).title).toBe('事件回调 · PLAYER_EVENT、OTHER_EVENT');
    } finally { vscode.workspace.findFiles = originalFindFiles; }
  });

  it('anchors the callback CodeLens to the def line and emits only one lens for repeated registrations', async () => {
    const originalFindFiles = vscode.workspace.findFiles;
    vscode.workspace.findFiles = async () => [];
    try {
      const source = 'self.addEvent(FIRST_EVENT, "on_ready")\nself.registerEvent(SECOND_EVENT, "on_ready")\n\ndef on_ready(self):\n    self.work()';
      const doc = makeTextDocument(source, { fileName: '/ws/entity.py', languageId: 'python' }) as vscode.TextDocument;
      const lenses = await new EventCodeLensProvider().provideCodeLenses(doc);
      expect(lenses).toHaveLength(1);
      expect(lenses[0].range.start.line).toBe(3);
    } finally { vscode.workspace.findFiles = originalFindFiles; }
  });

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
      expect((lenses.find(lens => (lens.command as { title: string }).title === '2 处监听')?.command as { command: string }).command).toBe('kbengine.source.reveal');
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

  it.each([
    ['class attribute', 'class Foo:\n    PLAYER_EVENT = "ready"', 1],
    ['annotated module assignment', 'PLAYER_EVENT: str = "ready"', 0],
    ['single-quoted module assignment', "PLAYER_EVENT = 'ready'", 0],
    ['def entity method declaration', '<root>\n\t<CellMethods>\n\t\t<PLAYER_EVENT>\n\t\t</PLAYER_EVENT>\n\t</CellMethods>\n</root>', 2],
    ['self assignment in __init__', 'class Foo:\n    def __init__(self):\n        self.PLAYER_EVENT = "ready"', 2],
  ])('resolves %s', async (_name, content, expectedLine) => {
    const originalFindFiles = vscode.workspace.findFiles;
    const originalOpen = vscode.workspace.openTextDocument;
    const target = vscode.Uri.file('/ws/definitions.' + (content.startsWith('<root>') ? 'def' : 'py'));
    vscode.workspace.findFiles = async () => [target];
    vscode.workspace.openTextDocument = async () => makeTextDocument(content, { fileName: target.fsPath, languageId: 'python' }) as vscode.TextDocument;
    try {
      const source = 'self.emitEvent(PLAYER_EVENT)';
      const doc = makeTextDocument(source, { fileName: '/ws/use.py', languageId: 'python' }) as vscode.TextDocument;
      const location = await eventDefinitionAt(doc, new vscode.Position(0, source.indexOf('PLAYER_EVENT') + 1));
      expect(location?.uri.fsPath).toBe(target.fsPath);
      expect(location?.range.start.line).toBe(expectedLine);
    } finally {
      vscode.workspace.findFiles = originalFindFiles;
      vscode.workspace.openTextDocument = originalOpen;
    }
  });

  it('resolves a unique same-file definition at its actual position', async () => {
    const originalFindFiles = vscode.workspace.findFiles;
    const originalOpen = vscode.workspace.openTextDocument;
    const target = vscode.Uri.file('/ws/use.py');
    const content = 'class Other:\n    OTHER_EVENT = "x"\n\nPLAYER_EVENT: str = "ready"\nself.emitEvent(PLAYER_EVENT)';
    vscode.workspace.findFiles = async () => [target];
    vscode.workspace.openTextDocument = async () => makeTextDocument(content, { fileName: target.fsPath, languageId: 'python' }) as vscode.TextDocument;
    try {
      const doc = makeTextDocument(content, { fileName: target.fsPath, languageId: 'python' }) as vscode.TextDocument;
      const location = await eventDefinitionAt(doc, new vscode.Position(4, content.split('\n')[4].indexOf('PLAYER_EVENT') + 1));
      expect(location?.range.start.line).toBe(3);
    } finally {
      vscode.workspace.findFiles = originalFindFiles;
      vscode.workspace.openTextDocument = originalOpen;
    }
  });

  it('selects the matching class definition when a file has same-named class constants', async () => {
    const originalFindFiles = vscode.workspace.findFiles;
    const originalOpen = vscode.workspace.openTextDocument;
    const target = vscode.Uri.file('/ws/use.py');
    const content = 'class First:\n    PLAYER_EVENT = "first"\n\nclass Second:\n    PLAYER_EVENT = "second"\n    def run(self):\n        self.emitEvent(PLAYER_EVENT)';
    vscode.workspace.findFiles = async () => [target];
    vscode.workspace.openTextDocument = async () => makeTextDocument(content, { fileName: target.fsPath, languageId: 'python' }) as vscode.TextDocument;
    try {
      const doc = makeTextDocument(content, { fileName: target.fsPath, languageId: 'python' }) as vscode.TextDocument;
      const offset = content.lastIndexOf('PLAYER_EVENT');
      const location = await eventDefinitionAt(doc, doc.positionAt(offset + 1));
      expect(location?.range.start.line).toBe(4);
    } finally {
      vscode.workspace.findFiles = originalFindFiles;
      vscode.workspace.openTextDocument = originalOpen;
    }
  });

  it('skips numeric and other non-string event definitions', async () => {
    const originalFindFiles = vscode.workspace.findFiles;
    const originalOpen = vscode.workspace.openTextDocument;
    const target = vscode.Uri.file('/ws/events.py');
    vscode.workspace.findFiles = async () => [target];
    vscode.workspace.openTextDocument = async () => makeTextDocument('PLAYER_EVENT = 42', { fileName: target.fsPath, languageId: 'python' }) as vscode.TextDocument;
    try {
      const source = 'self.emitEvent(PLAYER_EVENT)';
      const doc = makeTextDocument(source, { fileName: '/ws/use.py', languageId: 'python' }) as vscode.TextDocument;
      expect(await eventDefinitionAt(doc, new vscode.Position(0, source.indexOf('PLAYER_EVENT') + 1))).toBeNull();
    } finally {
      vscode.workspace.findFiles = originalFindFiles;
      vscode.workspace.openTextDocument = originalOpen;
    }
  });
});

describe('EventCodeLensProvider 独立开关(批154)', () => {
  it('codeLens.eventCallbacks 关闭时整类不出镜,默认开启不受影响', async () => {
    const source = "self.addEvent('ev_ready', self.on_ready)\ndef on_ready(self):\n    pass";
    const document = makeTextDocument(source, {
      fileName: '/ws/base/Hero.py',
      languageId: 'python'
    }) as vscode.TextDocument;

    // 正对照:默认开启时回调声明行出镜
    const lenses = await new EventCodeLensProvider().provideCodeLenses(document);
    expect(lenses.length).toBeGreaterThan(0);

    configurationOverrides.set('kbengine', { 'codeLens.eventCallbacks': false });
    try {
      expect(await new EventCodeLensProvider().provideCodeLenses(document)).toEqual([]);
    } finally {
      configurationOverrides.delete('kbengine');
    }
  });
});
