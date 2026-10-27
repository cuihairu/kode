import * as vscode from 'vscode';
import { findEventCalls, type EventCall } from './eventApi';

// 本地索引缓存（用户令 2026-10-20：跳转/CodeLens 不得每次全仓重扫）。
// 一次性建索引 + watcher 增量失效；实例由 provider 持有（测试各自全新实例，互不污染）。
// 范围（第一片）：.py 的 def/class/事件调用；后续片再并入 .def 常量与类型面。

export interface IndexedEventCall {
  readonly file: string;
  readonly call: EventCall;
  /** eventOffset 所在行（建索引时算好，消费端不再读盘换算） */
  readonly line: number;
}

interface IndexedFile {
  version: number;
  methods: Array<{ name: string; line: number }>;
  eventCalls: EventCall[];
  eventLines: number[];
}

export class WorkspaceIndex {
  private readonly cache = new Map<string, IndexedFile>();
  private readonly building = new Map<string, Promise<IndexedFile | null>>();
  private watchers: vscode.Disposable[] = [];
  private started = false;
  private starting?: Promise<void>;
  private disposed = false;
  private documentListener?: vscode.Disposable;
  private readonly revisions = new Map<string, number>();

  constructor(private readonly pyGlob = '**/*.py') {}

  /** 首次使用时建全量索引并挂 watcher（幂等）。 */
  async ensureStarted(): Promise<void> {
    if (this.started || this.disposed) return;
    const starting = this.starting ??= this.startIndex();
    try {
      await starting;
    } catch (error) {
      if (this.starting === starting) this.starting = undefined;
      throw error;
    }
  }

  private async startIndex(): Promise<void> {
    this.documentListener ??= vscode.workspace.onDidChangeTextDocument(event => {
      this.noteSaved(event.document);
    });
    for (const document of vscode.workspace.textDocuments) {
      if (document.isDirty) this.noteSaved(document);
    }
    const files = await vscode.workspace.findFiles(this.pyGlob, '**/{.git,node_modules}/**');
    if (this.disposed) return;
    await Promise.all(files.map(uri => this.indexFile(uri)));
    if (this.disposed) return;
    const watcher = vscode.workspace.createFileSystemWatcher(this.pyGlob);
    watcher.onDidCreate(uri => { void this.indexFile(uri); });
    watcher.onDidChange(uri => { void this.indexFile(uri); });
    watcher.onDidDelete(uri => { this.cache.delete(uri.fsPath); });
    this.watchers.push(watcher);
    this.started = true;
  }

  dispose(): void {
    this.disposed = true;
    this.documentListener?.dispose();
    this.documentListener = undefined;
    for (const w of this.watchers) w.dispose();
    this.watchers = [];
    this.cache.clear();
    this.revisions.clear();
  }

  /** 单文件建/重建索引；并发去重（同一文件不重复读）。 */
  private indexFile(uri: vscode.Uri): Promise<IndexedFile | null> {
    if (this.disposed) return Promise.resolve(null);
    const inflight = this.building.get(uri.fsPath);
    if (inflight) return inflight;
    const revision = this.revisions.get(uri.fsPath) ?? 0;
    const task = (async () => {
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        if (this.disposed) return null;
        if ((this.revisions.get(uri.fsPath) ?? 0) !== revision) return this.cache.get(uri.fsPath) ?? null;
        const dirty = vscode.workspace.textDocuments.find(document => document.uri.fsPath === uri.fsPath && document.isDirty);
        if (dirty) {
          this.noteSaved(dirty);
          return this.cache.get(uri.fsPath) ?? null;
        }
        const text = Buffer.from(bytes).toString('utf8');
        const lineStarts = [0];
        for (let i = 0; i < text.length; i += 1) {
          if (text[i] === '\n') lineStarts.push(i + 1);
        }
        const lineAt = (offset: number): number => {
          let low = 0;
          let high = lineStarts.length;
          while (low + 1 < high) {
            const mid = Math.floor((low + high) / 2);
            if (lineStarts[mid] <= offset) low = mid;
            else high = mid;
          }
          return low;
        };
        const methods = [...text.matchAll(/^[ \t]*(?:async[ \t]+)?def[ \t]+(\w+)[ \t]*\(/gm)].map(m => ({
          name: m[1],
          line: lineAt(m.index || 0),
        }));
        const eventCalls = findEventCalls(text);
        const indexed: IndexedFile = { version: 0, methods, eventCalls, eventLines: eventCalls.map(c => lineAt(c.eventOffset)) };
        this.cache.set(uri.fsPath, indexed);
        return indexed;
      } catch {
        if ((this.revisions.get(uri.fsPath) ?? 0) === revision) this.cache.delete(uri.fsPath);
        return null;
      } finally {
        this.building.delete(uri.fsPath);
      }
    })();
    this.building.set(uri.fsPath, task);
    return task;
  }

  /** 保存时由编辑器路径直接刷新（免读盘）。 */
  noteSaved(document: vscode.TextDocument): void {
    if (this.disposed) return;
    if (!document.uri.fsPath.endsWith('.py')) return;
    this.revisions.set(document.uri.fsPath, (this.revisions.get(document.uri.fsPath) ?? 0) + 1);
    const text = document.getText();
    const calls = findEventCalls(text);
    this.cache.set(document.uri.fsPath, {
      version: document.version,
      methods: [...text.matchAll(/^[ \t]*(?:async[ \t]+)?def[ \t]+(\w+)[ \t]*\(/gm)].map(m => ({
        name: m[1],
        line: document.positionAt(m.index || 0).line,
      })),
      eventCalls: calls,
      eventLines: calls.map(c => document.positionAt(c.eventOffset).line),
    });
  }

  /** 全仓事件调用（走缓存，不再每次读盘）。 */
  async allEventCalls(): Promise<IndexedEventCall[]> {
    await this.ensureStarted();
    const out: IndexedEventCall[] = [];
    for (const [file, indexed] of this.cache) {
      indexed.eventCalls.forEach((call, i) => out.push({ file, call, line: indexed.eventLines[i] ?? 0 }));
    }
    return out;
  }

  /** 某文件的方法行（当前编辑文件走内存文本，外部文件走缓存）。 */
  async methodsOf(document: vscode.TextDocument): Promise<Array<{ name: string; line: number }>> {
    const text = document.getText();
    return [...text.matchAll(/^[ \t]*(?:async[ \t]+)?def[ \t]+(\w+)[ \t]*\(/gm)].map(m => ({
      name: m[1],
      line: document.positionAt(m.index || 0).line,
    }));
  }
}
