/**
 * KSEM-DATA-06(SEM-047)空间数据读写索引 — 工作区级单例。
 *
 * 与三字典索引(GlobalDataDictIndex)分离的实现裁定:后者是经多轮审计的
 * 字节领地(commitFile/replaceFileSites/根身份键/AUD-070 追读协议),并行
 * 表穿线风险大于收益。spaceData 键族是引擎级身份(逐空间存储,无进程根
 * 语义),全工作区一张倒排即可服务补全/跳转/引用三面。
 *
 * 生命周期:首次查询 ensureStarted 幂等启动——挂 open/change/close 监听
 * (关文档回读盘版本,不丢已关文件贡献)+ 初扫全部 .py 文件(8 路有界并发
 * 读盘;星斜线 glob 落块注释会提前闭合注释,此处不写字面 glob——STRUCT-05
 * 同族坑)
 * 。v1 无文件系统 watcher(诚实边界):外部进程改盘不自动追——已打开文档
 * 经 change 事件走增量;面在查询前对当前文档 syncDocument 自愈自档。
 * 开关 kbengine.python.enableSpaceDataIndex(默认开;关闭时各面不查索引,
 * 诊断面另有独立开关)。
 */
import * as vscode from 'vscode';
import { findFilesAcrossRoots } from './scanRoots';
import { PY_SCAN_EXCLUDE } from './backend/pythonScanRules';
import { getKbeAliases } from './kbeModuleIndex';
import {
  extractModuleIntConstantBindings,
  findKbeSpaceDataCalls,
  spaceDataFamilyKey,
  type KbeSpaceDataFn
} from './backend/spaceDataIndexCore';

/** 开关(kbengine.python.enableSpaceDataIndex,默认开;接线同 enableDataDictIndex) */
export let spaceDataIndexEnabled = true;

export function setSpaceDataIndexEnabled(enabled: boolean): void {
  spaceDataIndexEnabled = enabled;
}

export function isSpaceDataIndexEnabled(): boolean {
  return spaceDataIndexEnabled;
}

/** 族内站点:set=写点/get=读点/del=删除点(fn 即 kind,引擎三函数互斥) */
export interface SpaceDataFamilySite {
  file: string;
  /** 0 基行 */
  line: number;
  fn: KbeSpaceDataFn;
  /** key 内容列区间(0 基,不含引号;与调用点对齐) */
  keyStart: number;
  keyEnd: number;
}

export interface SpaceDataFamily {
  spaceIdSignature: string;
  keySignature: string;
  sites: SpaceDataFamilySite[];
}

interface FileSpaceDataState {
  text: string;
  calls: ReturnType<typeof findKbeSpaceDataCalls>;
  intBindings: Map<string, number | null>;
}

const INITIAL_SCAN_CONCURRENCY = 8;

export class SpaceDataIndex {
  private readonly files = new Map<string, FileSpaceDataState>();
  private readonly families = new Map<string, SpaceDataFamilySite[]>();
  private started = false;
  private starting?: Promise<void>;
  private disposed = false;
  private listeners: vscode.Disposable[] = [];

  constructor(private readonly pyGlob = '**/*.py') {}

  /** 首次使用时全量扫描并挂监听(幂等;测试经 reset 复位)。 */
  async ensureStarted(): Promise<void> {
    if (this.started || this.disposed) {
      return;
    }
    const starting = this.starting ??= this.startIndex();
    try {
      await starting;
    } catch (error) {
      if (this.starting === starting) {
        this.starting = undefined;
      }
      throw error;
    }
  }

  /** 冷索引等待可取消(与 awaitDataDictIndexReady 同判据;取消=false 停查)。 */
  async awaitReady(token?: vscode.CancellationToken): Promise<boolean> {
    if (token?.isCancellationRequested) {
      return false;
    }
    const starting = this.ensureStarted();
    if (!token || typeof token.onCancellationRequested !== 'function') {
      await starting;
      return !token?.isCancellationRequested;
    }
    let onDone: (() => void) | undefined;
    const cancelWins = new Promise<null>(resolve => {
      const d = token.onCancellationRequested(() => resolve(null));
      onDone = () => d.dispose();
    });
    try {
      const winner = await Promise.race([starting.then(() => 'ready' as const), cancelWins]);
      if (winner === null) {
        return false;
      }
      return !token.isCancellationRequested;
    } finally {
      onDone?.();
    }
  }

  private async startIndex(): Promise<void> {
    this.listeners.push(
      vscode.workspace.onDidOpenTextDocument(document => {
        if (this.isIndexable(document)) {
          this.updateFile(document.uri.fsPath, document.getText());
        }
      }),
      vscode.workspace.onDidChangeTextDocument(event => {
        if (this.isIndexable(event.document)) {
          this.updateFile(event.document.uri.fsPath, event.document.getText());
        }
      }),
      vscode.workspace.onDidCloseTextDocument(document => {
        if (this.disposed || !this.isIndexable(document)) {
          return;
        }
        // 关文档回读盘版本(弃改关闭同款语义):编辑器缓冲消失,索引落盘字节
        void this.readAndIndexFile(document.uri);
      })
    );
    // 监听先挂再扫(初扫空窗不丢事件);已打开(含脏)文档以编辑器文本为准
    for (const document of vscode.workspace.textDocuments) {
      if (this.isIndexable(document)) {
        this.updateFile(document.uri.fsPath, document.getText());
      }
    }
    const files = await findFilesAcrossRoots(this.pyGlob, PY_SCAN_EXCLUDE);
    if (this.disposed) {
      return;
    }
    let next = 0;
    const workers = Array.from(
      { length: Math.min(INITIAL_SCAN_CONCURRENCY, files.length) || 1 },
      async () => {
        while (next < files.length && !this.disposed) {
          await this.readAndIndexFile(files[next++]);
          // 冷扫让出宿主:逐文件一个宏任务节拍(与字典索引同款)
          await new Promise<void>(resolve => setImmediate(resolve));
        }
      }
    );
    await Promise.all(workers);
    if (!this.disposed) {
      this.started = true;
    }
  }

  private isIndexable(document: vscode.TextDocument): boolean {
    return !this.disposed && document.languageId === 'python' && document.uri.fsPath.endsWith('.py');
  }

  private async readAndIndexFile(uri: vscode.Uri): Promise<void> {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      if (this.disposed) {
        return;
      }
      this.updateFile(uri.fsPath, Buffer.from(bytes).toString('utf8'));
    } catch {
      // 读失败(已删除/不可读):撤贡献,不假装旧态仍在
      this.removeFile(uri.fsPath);
    }
  }

  private removeFromFamilies(fsPath: string): void {
    for (const [key, sites] of this.families) {
      const filtered = sites.filter(site => site.file !== fsPath);
      if (filtered.length === 0) {
        this.families.delete(key);
      } else if (filtered.length !== sites.length) {
        this.families.set(key, filtered);
      }
    }
  }

  /** 增量提交(整文件替换;调用点全量重扫,族表逐键撤旧增新)。 */
  updateFile(fsPath: string, text: string): void {
    if (this.disposed) {
      return;
    }
    this.removeFromFamilies(fsPath);
    const intBindings = extractModuleIntConstantBindings(text);
    const calls = findKbeSpaceDataCalls(text, getKbeAliases(text), intBindings);
    this.files.set(fsPath, { text, calls, intBindings });
    for (const call of calls) {
      if (call.spaceIdSignature === null || call.keySignature === null) {
        continue; // 动态空间/非字面量键:不建族(动态空间不合并为同一确定对象)
      }
      const key = spaceDataFamilyKey(call.spaceIdSignature, call.keySignature);
      const sites = this.families.get(key) ?? [];
      sites.push({ file: fsPath, line: call.line, fn: call.fn, keyStart: call.keyStart, keyEnd: call.keyEnd });
      this.families.set(key, sites);
    }
  }

  removeFile(fsPath: string): void {
    this.files.delete(fsPath);
    this.removeFromFamilies(fsPath);
  }

  /** 查询前对当前文档同步(编辑器文本覆盖索引,自档自愈零陈旧)。 */
  syncDocument(document: vscode.TextDocument): void {
    if (this.isIndexable(document)) {
      this.updateFile(document.uri.fsPath, document.getText());
    }
  }

  /** 同空间键族(补全面输入;按键签名排序,输出稳定)。 */
  queryFamiliesForSpace(spaceIdSignature: string): SpaceDataFamily[] {
    const out: SpaceDataFamily[] = [];
    for (const [familyKey, sites] of this.families) {
      const separator = familyKey.indexOf('\u001f');
      const sid = familyKey.slice(0, separator);
      if (sid !== spaceIdSignature) {
        continue;
      }
      out.push({ spaceIdSignature: sid, keySignature: familyKey.slice(separator + 1), sites: [...sites] });
    }
    out.sort((a, b) => (a.keySignature < b.keySignature ? -1 : a.keySignature > b.keySignature ? 1 : 0));
    return out;
  }

  /** 同 (spaceID, key) 族全部站点(跳转/引用面输入)。 */
  queryFamilySites(spaceIdSignature: string, keySignature: string): SpaceDataFamilySite[] {
    return [...(this.families.get(spaceDataFamilyKey(spaceIdSignature, keySignature)) ?? [])];
  }

  /** 测试面:登记文件数。 */
  fileCountForTests(): number {
    return this.files.size;
  }

  /** 测试面:族数。 */
  familyCountForTests(): number {
    return this.families.size;
  }

  dispose(): void {
    this.disposed = true;
    for (const listener of this.listeners.splice(0)) {
      listener.dispose();
    }
    this.files.clear();
    this.families.clear();
    this.started = false;
    this.starting = undefined;
  }
}

let singleton: SpaceDataIndex | undefined;

export function getSpaceDataIndex(): SpaceDataIndex {
  singleton ??= new SpaceDataIndex();
  return singleton;
}

export function resetSpaceDataIndexForTests(): void {
  singleton?.dispose();
  singleton = undefined;
}
