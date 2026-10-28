import * as vscode from 'vscode';
import type { EntityMappingManager } from './entityMapping';
import { WorkspaceIndex } from './workspaceIndex';
import { KBENGINE_SOURCE_REVEAL_COMMAND } from './sourceRevealCommand';

export type EventCall = { api: 'addEvent' | 'registerEvent' | 'emitEvent' | 'removeEvent' | 'deregisterEvent'; event: string; eventOffset: number; callback?: string; callbackOffset?: number }

// 只认三种实参形态：标识符/点名（self.EV_X、on_ready）与字符串字面量；表达式保持沉默。
const ARG_TOKEN = /(?:[A-Za-z_]\w*\.)*[A-Za-z_]\w*|'[^'\n]*'|"[^"\n]*"/;
type ParsedArg = { value: string; offset: number; end: number; dotted: boolean };

// 解析单个实参：点名取末段（self.EV_X → EV_X，偏移落在末段上，跳转即常量名）。
function parseArg(text: string, from: number): ParsedArg | null {
  const ws = /^[ \t]*/.exec(text.slice(from))![0];
  const start = from + ws.length;
  const m = ARG_TOKEN.exec(text.slice(start));
  if (!m || m.index !== 0) return null;
  const token = m[0];
  if (token.startsWith("'") || token.startsWith('"')) {
    return { value: token.slice(1, -1), offset: start + 1, end: start + token.length, dotted: false, quoted: true } as ParsedArg & { quoted: boolean };
  }
  const lastDot = token.lastIndexOf('.');
  return { value: token.slice(lastDot + 1), offset: start + lastDot + 1, end: start + token.length, dotted: lastDot >= 0 };
}

// 实参后必须紧跟逗号或右括号才算落在真实调用里（防误配相邻表达式）。
function atCallBoundary(text: string, end: number): boolean {
  const next = text[end];
  return next === ',' || next === ')';
}

// Parse only literal/identifier event names and literal or attribute callbacks.
// Expressions and variables stay silent.
export function findEventCalls(text: string): EventCall[] {
  const result: EventCall[] = [];
  const re = /\b(addEvent|registerEvent|emitEvent|removeEvent|deregisterEvent)\s*\(/g;
  for (const m of text.matchAll(re)) {
    const api = m[1] as EventCall['api'];
    const after = (m.index || 0) + m[0].length;
    const event = parseArg(text, after);
    if (!event?.value || !atCallBoundary(text, event.end)) continue;
    let callback: ParsedArg | null = null;
    if ((api === 'addEvent' || api === 'registerEvent') && text[event.end] === ',') {
      const candidate = parseArg(text, event.end + 1);
      // 回调只认点名（self.onFoo）或字符串字面量；裸变量按纪律保持沉默。
      if (candidate?.value && atCallBoundary(text, candidate.end) && (candidate.dotted || (candidate as ParsedArg & { quoted?: boolean }).quoted)) callback = candidate;
    }
    result.push({ api, event: event.value, eventOffset: event.offset, ...(callback ? { callback: callback.value, callbackOffset: callback.offset } : {}) });
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
  private disposed = false;

  /** IDE-EVT-012:索引由扩展宿主统一持有一份并注入(共享缓存);provider
   * 不再自持实例,全仓扫描入口只有共享索引一个。索引生命周期归注入方。 */
  constructor(private readonly sharedIndex: WorkspaceIndex) {}

  private readonly onDidChangeCodeLensesEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.onDidChangeCodeLensesEmitter.event;

  // 批154:事件回调镜链拆成独立注册,配一枚独立开关
  // (kbengine.codeLens.eventCallbacks),不再搭在 RPC 镜链返回值里
  fireConfigurationChanged(): void {
    this.onDidChangeCodeLensesEmitter.fire();
  }

  dispose(): void {
    this.disposed = true;
    this.onDidChangeCodeLensesEmitter.dispose();
  }

  async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    if (this.disposed || !vscode.workspace.getConfiguration('kbengine').get<boolean>('codeLens.eventCallbacks', true)) {
      return [];
    }
    const text = document.getText();
    const calls = findEventCalls(text);
    if (calls.length === 0) return [];
    // IDE-EVT-012:事件记录来源只走注入的共享索引(不每次全仓读盘)。
    const all = await this.sharedIndex.allEventCalls();
    if (this.disposed) return [];
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
      lenses.push(new vscode.CodeLens(new vscode.Range(lineStart, lineStart), { title, command: KBENGINE_SOURCE_REVEAL_COMMAND, arguments: [document.uri, { selection: new vscode.Range(target, target) }] }));
    }
    for (const call of calls.filter(c => c.api === 'emitEvent')) {
      const listeners = all.filter(item => (item.call.api === 'addEvent' || item.call.api === 'registerEvent') && item.call.event === call.event);
      if (!listeners.length) continue;
      const line = document.positionAt(call.eventOffset).line;
      const first = listeners[0];
      const target = new vscode.Position(first.line, 0);
      const lineStart = new vscode.Position(line, 0);
      lenses.push(new vscode.CodeLens(new vscode.Range(lineStart, lineStart), { title: `${listeners.length} 处监听`, command: KBENGINE_SOURCE_REVEAL_COMMAND, arguments: [vscode.Uri.file(first.file), { selection: new vscode.Range(target, target) }] }));
    }
    return lenses;
  }
}
