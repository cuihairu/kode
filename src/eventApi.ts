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
  const definitions: Array<{ location: vscode.Location; scope?: string }> = [];
  const sourcePrefix = text.slice(0, selected.eventOffset);
  const sourceClasses = [...sourcePrefix.matchAll(/^\s*class\s+(\w+)\b/gm)];
  const sourceScope = sourceClasses.length ? sourceClasses[sourceClasses.length - 1][1] : undefined;
  for (const uri of candidates) {
    const doc = await vscode.workspace.openTextDocument(uri);
    const lines = doc.getText().split(/\r?\n/);
    const escaped = selected.event.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    lines.forEach((value, line) => {
      let match: RegExpMatchArray | null = null;
      if (uri.fsPath.endsWith('.py')) {
        // Module/class constants and self constants in __init__; only string literals qualify.
        match = new RegExp(`^\\s*(?:(?:self\\.)?${escaped})\\s*(?::\\s*str)?\\s*=\\s*(['"])([^'"\\n]*)\\1\\s*(?:#.*)?$`).exec(value);
      } else if (uri.fsPath.endsWith('.def')) {
        // KBEngine def files declare entity methods as XML-like nodes, e.g. <CellMethods><onFire>.
        match = new RegExp(`^\\s*<${escaped}>\\s*$`).exec(value);
      }
      if (match) {
        const priorClasses = uri.fsPath.endsWith('.py') ? [...lines.slice(0, line + 1).join('\n').matchAll(/^\s*class\s+(\w+)\b/gm)] : [];
        const scope = priorClasses.length ? priorClasses[priorClasses.length - 1][1] : undefined;
        definitions.push({ location: new vscode.Location(uri, new vscode.Position(line, Math.max(0, value.indexOf(selected.event)))), scope });
      }
    });
  }
  // A same-file duplicate or cross-file duplicate is ambiguous; do not guess.
  const scoped = sourceScope ? definitions.filter(definition => definition.scope === sourceScope) : [];
  if (scoped.length === 1) return scoped[0].location;
  return definitions.length === 1 ? definitions[0].location : null;
}

export class EventCodeLensProvider implements vscode.CodeLensProvider {
  async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    const text = document.getText();
    const calls = findEventCalls(text);
    const all = await scanEventCalls();
    const methods = [...text.matchAll(/^[ \t]*(?:async[ \t]+)?def[ \t]+(\w+)[ \t]*\(/gm)];
    const lenses: vscode.CodeLens[] = [];
    const eventsByCallback = new Map<string, string[]>();
    for (const call of calls) {
      if ((call.api !== 'addEvent' && call.api !== 'registerEvent') || !call.callback) continue;
      const events = eventsByCallback.get(call.callback) ?? [];
      if (!events.includes(call.event)) events.push(call.event);
      eventsByCallback.set(call.callback, events);
    }
    for (const method of methods) {
      const name = method[1];
      const events = eventsByCallback.get(name);
      if (!events) continue;
      const line = document.positionAt(method.index || 0).line;
      const target = document.positionAt(method.index || 0);
      const title = events.length > 3
        ? `事件回调 · ${events[0]} 等 ${events.length} 个`
        : `事件回调 · ${events.join('、')}`;
      const lineStart = new vscode.Position(line, 0);
      lenses.push(new vscode.CodeLens(new vscode.Range(lineStart, lineStart), { title, command: 'vscode.open', arguments: [document.uri, { selection: new vscode.Range(target, target) }] }));
    }
    for (const call of calls.filter(c => c.api === 'emitEvent')) {
      const listeners = all.filter(item => (item.call.api === 'addEvent' || item.call.api === 'registerEvent') && item.call.event === call.event);
      if (!listeners.length) continue;
      const line = document.positionAt(call.eventOffset).line;
      const first = listeners[0];
      const targetLine = first.text.slice(0, first.call.eventOffset).split(/\r?\n/).length - 1;
      const target = new vscode.Position(targetLine, 0);
      const lineStart = new vscode.Position(line, 0);
      lenses.push(new vscode.CodeLens(new vscode.Range(lineStart, lineStart), { title: `${listeners.length} 处监听`, command: 'vscode.open', arguments: [vscode.Uri.file(first.file), { selection: new vscode.Range(target, target) }] }));
    }
    return lenses;
  }
}
