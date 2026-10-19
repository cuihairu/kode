import * as vscode from 'vscode';
import type { EntityMappingManager } from './entityMapping';

export type EventCall = { api: 'addEvent' | 'registerEvent' | 'emitEvent' | 'removeEvent' | 'deregisterEvent'; event: string; eventOffset: number; callback?: string; callbackOffset?: number };

// Parse only bare event constants and literal callback names. Expressions and variables stay silent.
export function findEventCalls(text: string): EventCall[] {
  const result: EventCall[] = [];
  const re = /\b(addEvent|registerEvent|emitEvent|removeEvent|deregisterEvent)\s*\(\s*([A-Za-z_]\w*)(?=\s*[,)])/g;
  for (const m of text.matchAll(re)) {
    const api = m[1] as EventCall['api'];
    const start = (m.index || 0) + m[0].indexOf(m[2]);
    const rest = text.slice((m.index || 0) + m[0].length);
    const cb = (api === 'addEvent' || api === 'registerEvent') ? /^\s*,\s*(['"])([A-Za-z_]\w*)\1/.exec(rest) : null;
    result.push({ api, event: m[2], eventOffset: start, ...(cb ? { callback: cb[2], callbackOffset: start + m[2].length + cb[0].indexOf(cb[2]) + 1 } : {}) });
  }
  return result;
}

export async function scanEventCalls(): Promise<Array<{ file: string; call: EventCall; text: string }>> {
  const files = await vscode.workspace.findFiles('**/*.py', '**/{.git,node_modules}/**');
  const result: Array<{ file: string; call: EventCall; text: string }> = [];
  for (const uri of files) {
    try { const text = (await vscode.workspace.openTextDocument(uri)).getText(); for (const call of findEventCalls(text)) result.push({ file: uri.fsPath, call, text }); } catch { /* unreadable files are ignored */ }
  }
  return result;
}

export async function eventDefinitionAt(document: vscode.TextDocument, position: vscode.Position, manager?: EntityMappingManager): Promise<vscode.Location | null> {
  const text = document.getText();
  const calls = findEventCalls(text);
  const offset = document.offsetAt(position);
  const callback = calls.find(c => c.callback && c.callbackOffset !== undefined && offset >= c.callbackOffset && offset <= c.callbackOffset + (c.callback?.length || 0));
  if (callback?.callback) {
    const resolved = manager ? await manager.resolveMethodDefinition(document.fileName, callback.callback) : null;
    if (resolved) return new vscode.Location(vscode.Uri.file(resolved.defFile), new vscode.Position(resolved.line, 0));
    const method = new RegExp(`^\\s*(?:async\\s+)?def\\s+${callback.callback}\\s*\\(`, 'm').exec(text);
    if (method) return new vscode.Location(document.uri, document.positionAt(method.index || 0));
  }
  const selected = calls.find(c => offset >= c.eventOffset && offset <= c.eventOffset + c.event.length);
  if (!selected) return null;
  const candidates = await vscode.workspace.findFiles('**/*.{py,def}', '**/{.git,node_modules}/**');
  for (const uri of candidates) {
    const doc = await vscode.workspace.openTextDocument(uri);
    const lines = doc.getText().split(/\r?\n/);
    const escaped = selected.event.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = uri.fsPath.endsWith('.py')
      ? new RegExp(`^\\s*${escaped}\\s*=\\s*(['"])([^'"]+)\\1\\s*(?:#.*)?$`)
      : new RegExp(`^\\s*(?:${escaped}\\s*=|<${escaped}\\s*>|${escaped}\\s*:)`);
    const line = lines.findIndex(value => re.test(value));
    if (line >= 0) return new vscode.Location(uri, new vscode.Position(line, Math.max(0, lines[line].indexOf(selected.event))));
  }
  return null;
}

export class EventCodeLensProvider implements vscode.CodeLensProvider {
  async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    const text = document.getText();
    const calls = findEventCalls(text);
    const all = await scanEventCalls();
    const methods = [...text.matchAll(/^\s*(?:async\s+)?def\s+(\w+)\s*\(/gm)];
    const lenses: vscode.CodeLens[] = [];
    for (const method of methods) {
      const name = method[1];
      if (!calls.some(c => c.callback === name)) continue;
      const line = document.positionAt(method.index || 0).line;
      const target = document.positionAt(method.index || 0);
      lenses.push(new vscode.CodeLens(new vscode.Range(line, 0, line, 0), { title: '事件回调', command: 'vscode.open', arguments: [document.uri, { selection: new vscode.Range(target, target) }] }));
    }
    for (const call of calls.filter(c => c.api === 'emitEvent')) {
      const listeners = all.filter(item => (item.call.api === 'addEvent' || item.call.api === 'registerEvent') && item.call.event === call.event);
      if (!listeners.length) continue;
      const line = document.positionAt(call.eventOffset).line;
      const first = listeners[0];
      const targetLine = first.text.slice(0, first.call.eventOffset).split(/\r?\n/).length - 1;
      const target = new vscode.Position(targetLine, 0);
      lenses.push(new vscode.CodeLens(new vscode.Range(line, 0, line, 0), { title: `${listeners.length} 处监听`, command: 'vscode.open', arguments: [vscode.Uri.file(first.file), { selection: new vscode.Range(target, target) }] }));
    }
    return lenses;
  }
}
