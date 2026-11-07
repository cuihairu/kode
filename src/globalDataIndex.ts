import * as path from 'path';
import * as vscode from 'vscode';
import { performance } from 'perf_hooks';
import { findFilesAcrossRoots, getExternalScanRoots } from './scanRoots';
import { PY_SCAN_EXCLUDE } from './pythonScanRules';
import { getKbeAliases } from './kbeModuleIndex';

// GLOBDATA-001(2026-10-30 用户令):KBEngine.globalData / baseAppData /
// cellAppData 三个跨进程数据字典的键访问索引。引擎侧事实(源码核验,
// /home/cui/workspaces/kbengine):三者为 GlobalDataClient(Dict[str, Any])
// 模块属性,key/value 经 script::Pickler(pickle.dumps)序列化→dbmgr
// GlobalDataServer 广播→接收侧 Pickler::unpickle 还原同一 Python 对象
// (globaldata_client.cpp:98-104、entity_app.h:1261-1308)——一侧设置的
// 类型在另一侧可恢复,故写点值类型可在读点推导。拓扑:globalData→全部
// 进程、baseAppData→仅 baseapp、cellAppData→仅 cellapp(globaldata_
// server.cpp:60-110)。
//
// 键粒度(用户定口径):字符串字面量按键值、标识符按键名文本;计算键
// `"SERVER_" + str(id)` / f"SERVER_{id}" 归一化为「字面量骨架 + `*` 通配」
// 签名(如 SERVER_*),同签名即同键族互链;全动态(a + b,无字面量锚点)
// 不索引。写点 `[K] = RHS`(增强赋值算写但无值类型)、读点 `[K]` 与
// `.get(K[, default])`。纯逻辑扫描面不依赖 vscode,索引类仿 WorkspaceIndex
// (cache/revisions/building + findFilesAcrossRoots + watcher + noteSaved)。

import {
  EDIT_ASYNC_THRESHOLD_BYTES,
  EDIT_COMMIT_ACCESS_SLICE,
  EDIT_SCAN_LINE_SLICE,
  diffFunctionDefs,
  yieldToHost,
  extractFunctionReturns,
  findKbeDataDictAccesses,
  findKbeDataDictAccessesSliced,
  resolveFunctionReturns,
  type KbeDataDictAccess,
  type KbeDataDictSite,
  type SlicedScanStats
} from './globalDataIndexCore';

export {
  KBENGINE_DATA_DICTS,
  buildPythonCodeMask,
  extractFunctionReturns,
  findKbeDataDictAccesses,
  findKbeDataDictAccessesSliced,
  findLineCommentIndex,
  getDataDictAccessInCodeContext,
  getKbeDataDictAccessAtPosition,
  inferDataDictValueType,
  isKeyInsideLineComment,
  normalizeKeySignature,
  resolveFunctionReturns,
  type KbeDataDictAccess,
  type KbeDataDictName,
  type KbeDataDictSite,
  type SlicedScanStats
} from './globalDataIndexCore';

/**
 * AUD-068:文件所属作用域根(跨进程字典不跨工程/集群共享命名空间)。
 * 最深的 workspace 根前缀,否则外部扫描根(assetsRoot)前缀,否则 ''(独立
 * 作用域)。倒排键与查询都带根身份,不同根同名键不再互跳。
 */
export function resolveScopeRoot(fsPath: string): string {
  let best: string | null = null;
  const consider = (root: string): void => {
    const base = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
    if (fsPath === root || fsPath.startsWith(base)) {
      if (best === null || root.length > best.length) {
        best = root;
      }
    }
  };
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    consider(folder.uri.fsPath);
  }
  if (best === null) {
    for (const root of getExternalScanRoots()) {
      consider(root);
    }
  }
  return best ?? '';
}

const siteKey = (root: string, dict: string, keySignature: string): string =>
  `${root}\u0000${dict}\u0000${keySignature}`;

/**
 * AUD-076(R4-F11):预算化倒排提交——移除旧访问 + 新增新访问,每片
 * `EDIT_COMMIT_ACCESS_SLICE` 个访问让出一个宏任务节拍。提交本身
 * 不可中途取消(中断会留半提交状态),但片间让路保证宿主不被连续
 * 占用;是否放行由调用方在提交前一次性复核(仅最新代进提交)。
 */
export async function replaceFileSitesSliced(
  byKey: Map<string, KbeDataDictSite[]>,
  fsPath: string,
  previous: KbeDataDictAccess[],
  next: KbeDataDictAccess[],
  accessSlice = EDIT_COMMIT_ACCESS_SLICE
): Promise<SlicedScanStats> {
  const root = resolveScopeRoot(fsPath);
  let sliceCount = 0;
  let maxSliceMs = 0;
  for (let start = 0; start < previous.length; start += accessSlice) {
    const t0 = performance.now();
    const end = Math.min(start + accessSlice, previous.length);
    for (let i = start; i < end; i += 1) {
      const access = previous[i];
      if (access.keySignature === null) {
        continue;
      }
      const key = siteKey(root, access.dict, access.keySignature);
      const sites = byKey.get(key);
      if (!sites) {
        continue;
      }
      const kept = sites.filter(site => site.file !== fsPath);
      if (kept.length === 0) {
        byKey.delete(key);
      } else {
        byKey.set(key, kept);
      }
    }
    sliceCount += 1;
    maxSliceMs = Math.max(maxSliceMs, performance.now() - t0);
    if (end < previous.length) {
      await yieldToHost();
    }
  }
  for (let start = 0; start < next.length; start += accessSlice) {
    const t0 = performance.now();
    const end = Math.min(start + accessSlice, next.length);
    for (let i = start; i < end; i += 1) {
      const access = next[i];
      if (access.keySignature === null) {
        continue;
      }
      const key = siteKey(root, access.dict, access.keySignature);
      const sites = byKey.get(key) ?? [];
      sites.push({ ...access, file: fsPath });
      byKey.set(key, sites);
    }
    sliceCount += 1;
    maxSliceMs = Math.max(maxSliceMs, performance.now() - t0);
    if (end < next.length) {
      await yieldToHost();
    }
  }
  return { sliceCount, maxSliceMs };
}

export const INITIAL_SCAN_CONCURRENCY = 8;
export const REBUILD_SCAN_CONCURRENCY = 8;

/** 单文件的索引缓存项:访问记录 + 该文件调用键引用的函数名集(依赖追踪) */
interface FileIndexEntry {
  accesses: KbeDataDictAccess[];
  callFns: Set<string>;
}

/**
 * 跨文件字典键索引(仿 WorkspaceIndex):首次查询建全量索引 +
 * watcher 增量失效,`noteSaved` 走编辑器路径免读盘;查询走内存
 * `(dict, 键签名) → 访问点[]`,不每次重扫。单实例由 extension 装配,
 * references/definition 共用。
 */
export class GlobalDataDictIndex {
  private readonly cache = new Map<string, FileIndexEntry>();
  private readonly building = new Map<string, Promise<{ accesses: KbeDataDictAccess[] } | null>>();
  private readonly byKey = new Map<string, KbeDataDictSite[]>();
  /** 每文件 `def Fn` → return 表达式列表(函数调用键跨文件解析用) */
  private readonly fnDefsByFile = new Map<string, Map<string, string[]>>();
  /** 函数名 → 引用它的调用键文件集(函数定义变化时重扫这些文件) */
  private readonly callKeyDependents = new Map<string, Set<string>>();
  /** 待处理调用键依赖重扫(冷启动/重建时一并等待,防查询时索引未收敛) */
  private readonly pendingDependentIndexes = new Set<Promise<unknown>>();
  private readonly revisions = new Map<string, number>();
  private watchers: vscode.Disposable[] = [];
  private documentListener?: vscode.Disposable;
  private saveListener?: vscode.Disposable;
  private closeListener?: vscode.Disposable;
  private foldersListener?: vscode.Disposable;
  private renameListener?: vscode.Disposable;
  /** 当前脏(未保存)编辑的 .py 文档;弃改关闭时据此回读盘版本。 */
  private readonly dirtyDocs = new Set<string>();
  /** 根集世代:removeRoot/invalidate 前进,在飞旧读不得发布旧根(AUD-071)。 */
  private generation = 0;
  private started = false;
  private starting?: Promise<void>;
  private disposed = false;
  /**
   * AUD-076:大文件编辑路径的最新缓冲快照(noteSaved 登记,异步重扫
   * 迭代开始时读——同一文件的连续编辑自然合并为最新一份)。
   */
  private readonly editBuffers = new Map<string, string>();
  /** AUD-076:每文件在飞异步重扫(合并窗:在飞时新编辑只更新缓冲+revision) */
  private readonly editInProgress = new Set<string>();
  /** AUD-076:最近一次大文件编辑重扫统计(测试与诊断取证最大执行片) */
  readonly lastEditStats = {
    commits: 0,
    scansCancelled: 0,
    maxSliceMs: 0,
    sliceCount: 0
  };

  /** KODE-PERF-003:测试面——编辑缓冲残留条目数(收敛提交后应归零)。 */
  editBufferEntryCountForTests(): number {
    return this.editBuffers.size;
  }

  constructor(private readonly pyGlob = '**/*.py') {}

  /** 首次使用时建全量索引并挂 watcher(幂等)。 */
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

  private async startIndex(): Promise<void> {
    this.documentListener ??= vscode.workspace.onDidChangeTextDocument(event => {
      this.noteSaved(event.document);
    });
    this.saveListener ??= vscode.workspace.onDidSaveTextDocument(document => {
      this.dirtyDocs.delete(document.uri.fsPath);
    });
    this.closeListener ??= vscode.workspace.onDidCloseTextDocument(document => {
      if (this.disposed) {
        return;
      }
      const fsPath = document.uri.fsPath;
      if (!fsPath.endsWith('.py')) {
        return;
      }
      // KODE-AUD-005:关文档释放异步缓冲——在飞异步扫描若仍持旧文本,源已清,
      // 其提交前源复核不一致将跳过,不把已关闭文件的缓冲文本回写进索引。
      this.editBuffers.delete(fsPath);
      // 弃改关闭:缓冲消失,回读盘版本覆盖索引(干净关闭为 no-op 不丢正确索引)
      if (this.dirtyDocs.delete(fsPath)) {
        this.revisions.set(fsPath, (this.revisions.get(fsPath) ?? 0) + 1);
        void this.indexFile(document.uri);
      }
    });
    this.foldersListener ??= vscode.workspace.onDidChangeWorkspaceFolders(event => {
      // AUD-071:根集变化——移除根立即撤回其贡献;添加根/资产根切换整库重建
      const removed = (event as { removed?: ReadonlyArray<{ uri: { fsPath: string } }> }).removed ?? [];
      const added = (event as { added?: ReadonlyArray<{ uri: { fsPath: string } }> }).added ?? [];
      for (const folder of removed) {
        this.removeRoot(folder.uri.fsPath);
      }
      if (added.length > 0) {
        this.invalidate();
      }
    });
    this.renameListener ??= vscode.workspace.onDidRenameFiles(event => {
      for (const { oldUri, newUri } of event.files) {
        this.revisions.set(oldUri.fsPath, (this.revisions.get(oldUri.fsPath) ?? 0) + 1);
        this.revisions.set(newUri.fsPath, (this.revisions.get(newUri.fsPath) ?? 0) + 1);
        const entry = this.cache.get(oldUri.fsPath);
        this.replaceFileSites(oldUri.fsPath, entry?.accesses ?? [], []);
        this.cache.delete(oldUri.fsPath);
        if (newUri.fsPath.endsWith('.py')) {
          if (entry) {
            this.cache.set(newUri.fsPath, entry);
            this.replaceFileSites(newUri.fsPath, [], entry.accesses);
            // 函数定义表随文件移动;调用键依赖表键从旧路径改新路径
            const defs = this.fnDefsByFile.get(oldUri.fsPath);
            if (defs) {
              this.fnDefsByFile.delete(oldUri.fsPath);
              this.fnDefsByFile.set(newUri.fsPath, defs);
            }
            for (const fn of entry.callFns) {
              const deps = this.callKeyDependents.get(fn);
              if (deps) {
                deps.delete(oldUri.fsPath);
                deps.add(newUri.fsPath);
              }
            }
          } else {
            void this.indexFile(newUri);
          }
        } else {
          this.fnDefsByFile.delete(oldUri.fsPath);
        }
      }
    });
    for (const document of vscode.workspace.textDocuments) {
      if (document.isDirty) {
        this.noteSaved(document);
      }
    }
    const initialRevisions = new Map(this.revisions);
    // AUD-074(R4-F09):监听先挂——初扫到挂 watcher 之间的空窗会让真实
    // create/change/delete 事件丢失(捕获旧字节后删文件→幽灵写点,捕获后
    // 改文件→旧内容发布)。watcher 先于 findFiles/扫描创建:变更升 revision
    // 使在飞旧读作废(AUD-070 追读接手),删除撤 cache+revision;扫描 worker
    // 对升过 revision 的文件跳过交由监听器,监听与全扫互不覆盖(最新者胜)。
    const watcher = vscode.workspace.createFileSystemWatcher(this.pyGlob);
    watcher.onDidCreate(uri => {
      void this.indexFile(uri);
    });
    watcher.onDidChange(uri => {
      // AUD-070:变更升 revision——在飞读盘若读到旧字节即作废,由追读接手
      this.revisions.set(uri.fsPath, (this.revisions.get(uri.fsPath) ?? 0) + 1);
      void this.indexFile(uri);
    });
    watcher.onDidDelete(uri => {
      this.revisions.set(uri.fsPath, (this.revisions.get(uri.fsPath) ?? 0) + 1);
      const entry = this.cache.get(uri.fsPath);
      this.replaceFileSites(uri.fsPath, entry?.accesses ?? [], []);
      this.cache.delete(uri.fsPath);
    });
    this.watchers.push(watcher);
    const files = await findFilesAcrossRoots(this.pyGlob, PY_SCAN_EXCLUDE);
    if (this.disposed) {
      return;
    }
    let nextFile = 0;
    // KR-AUD-29:循环头捕获扫描起始 generation——初扫中 removeRoot/invalidate
    // 升代后,尚未认领的文件不得再以新一代身份提交(空根身份复活,AUD-071)。
    // 在飞 indexFile 已按各自调用时 generation 守卫,这里补循环头同口径复核。
    const scanGeneration = this.generation;
    const scanWorker = async (): Promise<void> => {
      while (!this.disposed && nextFile < files.length) {
        const uri = files[nextFile++];
        if (this.generation !== scanGeneration) {
          continue;
        }
        if ((this.revisions.get(uri.fsPath) ?? 0) !== (initialRevisions.get(uri.fsPath) ?? 0)) {
          continue;
        }
        await this.indexFile(uri);
      }
    };
    await Promise.all(Array.from({ length: Math.min(INITIAL_SCAN_CONCURRENCY, files.length) }, scanWorker));
    if (this.disposed) {
      return;
    }
    // 调用键依赖重扫(函数定义晚到触发的重扫)收敛后才算索引就绪
    await this.drainPendingDependents();
    if (this.disposed) {
      return;
    }
    this.started = true;
  }

  dispose(): void {
    this.disposed = true;
    this.documentListener?.dispose();
    this.documentListener = undefined;
    this.saveListener?.dispose();
    this.saveListener = undefined;
    this.closeListener?.dispose();
    this.closeListener = undefined;
    this.foldersListener?.dispose();
    this.foldersListener = undefined;
    this.renameListener?.dispose();
    this.renameListener = undefined;
    for (const watcher of this.watchers) {
      watcher.dispose();
    }
    this.watchers = [];
    this.cache.clear();
    this.byKey.clear();
    this.revisions.clear();
    this.dirtyDocs.clear();
    this.editBuffers.clear();
    this.editInProgress.clear();
    this.fnDefsByFile.clear();
    this.callKeyDependents.clear();
    this.pendingDependentIndexes.clear();
  }

  /** 单文件建/重建索引;并发去重(同文件不重复读)。 */
  private indexFile(uri: vscode.Uri): Promise<{ accesses: KbeDataDictAccess[] } | null> {
    if (this.disposed) {
      return Promise.resolve(null);
    }
    const fsPath = uri.fsPath;
    // AUD-070:在飞读盘期间又来变更——不吞,等先前读结束后核对 revision,
    // 有更新版本(升过)则由本读追赶重读最新;无更新版本则直接沿用先前结果。
    const prior = this.building.get(fsPath) ?? null;
    const revision = this.revisions.get(fsPath) ?? 0;
    // AUD-071:根集变化(removeRoot/invalidate)升 generation,旧读作废不发布旧根
    const generation = this.generation;
    const holder: { task: Promise<{ accesses: KbeDataDictAccess[] } | null> } = {
      task: Promise.resolve(null)
    };
    holder.task = (async (): Promise<{ accesses: KbeDataDictAccess[] } | null> => {
      try {
        if (prior) {
          await prior.catch(() => undefined);
          if (this.disposed || (this.revisions.get(fsPath) ?? 0) !== revision) {
            return this.cache.get(fsPath) ?? null;
          }
        }
        const bytes = await vscode.workspace.fs.readFile(uri);
        if (this.disposed) {
          return null;
        }
        if ((this.revisions.get(fsPath) ?? 0) !== revision || this.generation !== generation) {
          return this.cache.get(fsPath) ?? null;
        }
        const dirty = vscode.workspace.textDocuments.find(
          document => document.uri.fsPath === fsPath && document.isDirty
        );
        if (dirty) {
          this.noteSaved(dirty);
          return this.cache.get(fsPath) ?? null;
        }
        const text = Buffer.from(bytes).toString('utf8');
        // 冷扫让出宿主:正则扫描轻,逐文件一个宏任务节拍即可
        await new Promise<void>(resolve => setImmediate(resolve));
        if (
          this.disposed ||
          (this.revisions.get(fsPath) ?? 0) !== revision ||
          this.generation !== generation
        ) {
          return this.cache.get(fsPath) ?? null;
        }
        this.commitFile(fsPath, text);
        return this.cache.get(fsPath) ?? null;
      } catch {
        if ((this.revisions.get(fsPath) ?? 0) === revision) {
          const entry = this.cache.get(fsPath);
          this.replaceFileSites(fsPath, entry?.accesses ?? [], []);
          this.cache.delete(fsPath);
        }
        return null;
      } finally {
        // 只清自己占位的项(后到变更会覆盖 slot,不得误删其追读)
        if (this.building.get(fsPath) === holder.task) {
          this.building.delete(fsPath);
        }
      }
    })();
    this.building.set(fsPath, holder.task);
    return holder.task;
  }

  /** 重扫文件文本并同步倒排(byKey)+ 函数定义表 + 调用键依赖刷新 */
  private commitFile(fsPath: string, text: string): void {
    // 先落函数定义表(解析器据此现解;同文件调用链也可见),差异函数记下
    const changedFns = this.updateFnDefs(fsPath, text);
    const aliases = getKbeAliases(text);
    const newCallFns = new Set<string>();
    const accesses =
      aliases.size > 0
        ? findKbeDataDictAccesses(
            text,
            aliases,
            this.buildCallKeyResolver(),
            fn => {
              newCallFns.add(fn);
            }
          )
        : [];
    const previous = this.cache.get(fsPath);
    this.updateCallKeyDependents(fsPath, previous?.callFns ?? new Set<string>(), newCallFns);
    this.cache.set(fsPath, { accesses, callFns: newCallFns });
    this.replaceFileSites(fsPath, previous?.accesses ?? [], accesses);
    this.reindexCallKeyDependents(changedFns, fsPath);
  }

  /** 函数调用键的现解解析器(跨文件;闭包现读 fnDefsByFile,不缓存) */
  private buildCallKeyResolver(): (fn: string) => string[] | null {
    return (fn: string) => resolveFunctionReturns(fn, this.fnDefsByFile, 0, new Set());
  }

  /** 更新文件函数定义表,返回与旧表差异的函数名集(新增/删除/return 变) */
  private updateFnDefs(fsPath: string, text: string): string[] {
    const fnDefs = extractFunctionReturns(text);
    const prev = this.fnDefsByFile.get(fsPath);
    const changed = diffFunctionDefs(prev, fnDefs);
    this.fnDefsByFile.set(fsPath, fnDefs);
    return changed;
  }

  /** 调用键依赖表:文件不再引用某 fn → 移除;新引用 → 加入 */
  private updateCallKeyDependents(
    fsPath: string,
    previousCallFns: ReadonlySet<string>,
    newCallFns: ReadonlySet<string>
  ): void {
    for (const fn of previousCallFns) {
      if (newCallFns.has(fn)) {
        continue;
      }
      const deps = this.callKeyDependents.get(fn);
      deps?.delete(fsPath);
      if (deps && deps.size === 0) {
        this.callKeyDependents.delete(fn);
      }
    }
    for (const fn of newCallFns) {
      const deps = this.callKeyDependents.get(fn) ?? new Set<string>();
      deps.add(fsPath);
      this.callKeyDependents.set(fn, deps);
    }
  }

  /** 函数定义变化 → 重扫引用该函数调用键的其它文件(签名已变/变可解) */
  private reindexCallKeyDependents(
    changedFns: ReadonlySet<string> | readonly string[],
    exceptFile: string
  ): void {
    if (this.disposed) {
      return;
    }
    for (const fn of changedFns) {
      for (const dep of this.callKeyDependents.get(fn) ?? []) {
        if (dep === exceptFile) {
          continue;
        }
        this.revisions.set(dep, (this.revisions.get(dep) ?? 0) + 1);
        const task = this.indexFile(vscode.Uri.file(dep));
        this.pendingDependentIndexes.add(task);
        void task.finally(() => this.pendingDependentIndexes.delete(task));
      }
    }
  }

  /** 冷启动/重建时等待所有在飞调用键依赖重扫收敛(防查询时索引未定) */
  private async drainPendingDependents(): Promise<void> {
    while (!this.disposed && this.pendingDependentIndexes.size > 0) {
      await Promise.all([...this.pendingDependentIndexes]);
    }
  }

  /**
   * 函数调用键的现解签名(跨文件,现算不缓存);Fn 不在工作区/无静态可求
   * return/递归自指/深度超限 → null(不硬猜)。查询面与索引面共用。
   */
  resolveCallSignatures(fn: string): string[] | null {
    return resolveFunctionReturns(fn, this.fnDefsByFile, 0, new Set());
  }

  /**
   * 保存时由编辑器路径直接刷新(免读盘);脏标记随之维护。
   * AUD-076(R4-F11):超过预算的文档改走异步预算化重扫(合并连续编辑/
   * 取消旧代/切片限阻塞),预算内的小文件保持同步即时刷新。
   */
  noteSaved(document: vscode.TextDocument): void {
    if (this.disposed) {
      return;
    }
    if (!document.uri.fsPath.endsWith('.py')) {
      return;
    }
    if (document.isDirty) {
      this.dirtyDocs.add(document.uri.fsPath);
    } else {
      this.dirtyDocs.delete(document.uri.fsPath);
    }
    this.revisions.set(document.uri.fsPath, (this.revisions.get(document.uri.fsPath) ?? 0) + 1);
    const text = document.getText();
    if (text.length > EDIT_ASYNC_THRESHOLD_BYTES) {
      this.editBuffers.set(document.uri.fsPath, text);
      this.scheduleEditRecompute(document.uri.fsPath);
      return;
    }
    // KODE-AUD-005:同步提交前释放异步缓冲。同文件此前曾超阈值(在飞异步扫描
    // 持有旧文本于 editBuffers),缩为小文件改走同步路径时若不清,在飞循环
    // (runEditRecompute 顶部)重读 editBuffers 旧文本并回写,覆盖本处刚提交的
    // 新内容。清后:在飞循环下轮读 undefined 即返回,或提交前源复核不一致而跳过。
    this.editBuffers.delete(document.uri.fsPath);
    this.commitFile(document.uri.fsPath, text);
  }

  /**
   * AUD-076:调度大文件异步重扫。合并窗 = 同文件在飞时只更新缓冲+revision,
   * 由在飞循环复核后重扫(取消旧代);无在飞则启动一个(逐代最新者胜)。
   */
  private scheduleEditRecompute(fsPath: string): void {
    if (this.disposed) {
      return;
    }
    if (this.editInProgress.has(fsPath)) {
      return;
    }
    this.editInProgress.add(fsPath);
    void this.runEditRecompute(fsPath);
  }

  /**
   * AUD-076:预算化编辑重扫循环。每次迭代捕获 revision/generation 与最新
   * 缓冲,切片扫描(片间让路+复核取消);扫描被取消(旧代)则循环重扫;
   * 扫描完成后一次性复核,最新者才进倒排提交(提交自身不可中途取消)。
   * 提交期间又来新编辑 → 提交完成(书账不可中断)后循环重扫,最终收敛最新。
   */
  private async runEditRecompute(fsPath: string): Promise<void> {
    try {
      // 扫描被取消(又来新编辑)时定义表已前进但依赖未重扫;函数差异跨迭代
      // 累积,提交成功后统一重扫一次,避免取消轮次丢失依赖刷新
      const pendingReindex = new Set<string>();
      while (!this.disposed) {
        const text = this.editBuffers.get(fsPath);
        if (text === undefined) {
          return;
        }
        const revision = this.revisions.get(fsPath) ?? 0;
        const generation = this.generation;
        const isCancelled = (): boolean =>
          this.disposed ||
          (this.revisions.get(fsPath) ?? 0) !== revision ||
          this.generation !== generation;
        // 先落函数定义表(解析器据此现解;同文件调用链也可见),差异记入
        // pendingReindex——取消轮次不丢,提交成功后统一重扫引用方
        const changedFns = this.updateFnDefs(fsPath, text);
        for (const fn of changedFns) {
          pendingReindex.add(fn);
        }
        const aliases = getKbeAliases(text);
        const newCallFns = new Set<string>();
        const scanned = await findKbeDataDictAccessesSliced(
          text,
          aliases,
          isCancelled,
          EDIT_SCAN_LINE_SLICE,
          this.buildCallKeyResolver(),
          fn => {
            newCallFns.add(fn);
          }
        );
        if (scanned.accesses === null) {
          this.lastEditStats.scansCancelled += 1;
          this.lastEditStats.maxSliceMs = Math.max(this.lastEditStats.maxSliceMs, scanned.maxSliceMs);
          continue;
        }
        if (isCancelled()) {
          this.lastEditStats.scansCancelled += 1;
          this.lastEditStats.maxSliceMs = Math.max(this.lastEditStats.maxSliceMs, scanned.maxSliceMs);
          continue;
        }
        this.lastEditStats.maxSliceMs = Math.max(this.lastEditStats.maxSliceMs, scanned.maxSliceMs);
        this.lastEditStats.sliceCount = Math.max(this.lastEditStats.sliceCount, scanned.sliceCount);
        // KODE-AUD-005:提交前复核缓冲源——同步提交已清缓冲/新编辑已换缓冲时,
        // 本迭代扫描结果基于旧 text,提交会回写旧内容覆盖新内容。源不一致则
        // 丢弃本轮(下轮重读最新缓冲),封住「旧任务继续回写」竞态窗口。
        if (this.editBuffers.get(fsPath) !== text) {
          this.lastEditStats.scansCancelled += 1;
          continue;
        }
        const previous = this.cache.get(fsPath);
        this.updateCallKeyDependents(
          fsPath,
          previous?.callFns ?? new Set<string>(),
          newCallFns
        );
        this.cache.set(fsPath, { accesses: scanned.accesses, callFns: newCallFns });
        const committed = await replaceFileSitesSliced(
          this.byKey,
          fsPath,
          previous?.accesses ?? [],
          scanned.accesses
        );
        this.lastEditStats.maxSliceMs = Math.max(this.lastEditStats.maxSliceMs, committed.maxSliceMs);
        this.lastEditStats.commits += 1;
        this.reindexCallKeyDependents(pendingReindex, fsPath);
        pendingReindex.clear();
        // 提交期间又来新编辑(revision/代际前进)→ 循环重扫,否则本轮完成
        if ((this.revisions.get(fsPath) ?? 0) === revision && this.generation === generation) {
          // KODE-PERF-003:收敛提交后文本已全部索引进 cache,释放大文件快照,
          // 不再为已收敛的打开文档积压完整文本(后续新编辑 noteSaved 重新登记,
          // 不丢编辑;KODE-AUD-005 同步路径/关文档清缓冲不受影响)。
          this.editBuffers.delete(fsPath);
          return;
        }
      }
    } finally {
      this.editInProgress.delete(fsPath);
    }
  }

  /** (作用域根, 字典, 键签名) 的全部写+读点(走内存索引,不重扫)。 */
  query(dict: string, keySignature: string, root = ''): KbeDataDictSite[] {
    return this.byKey.get(siteKey(root, dict, keySignature)) ?? [];
  }

  /**
   * AUD-071:整根移除(workspace 根或外部 assetsRoot)。立即撤回该根下各文件
   * 贡献(按该根身份键),并升 generation 使在飞旧读不得重新发布旧根;文件仍属
   * 其他根(嵌套根)或外部根则重建,否则保持撤回。
   */
  removeRoot(rootPath: string): void {
    if (this.disposed) {
      return;
    }
    this.generation += 1;
    const base = rootPath.endsWith(path.sep) ? rootPath : `${rootPath}${path.sep}`;
    for (const [fsPath, entry] of [...this.cache]) {
      if (fsPath !== rootPath && !fsPath.startsWith(base)) {
        continue;
      }
      // 撤回该文件在 rootPath 身份下的贡献(嵌套根文件本就不挂 rootPath 键,无项可撤)
      for (const access of entry.accesses) {
        if (access.keySignature === null) {
          continue;
        }
        const key = siteKey(rootPath, access.dict, access.keySignature);
        const sites = this.byKey.get(key);
        if (sites) {
          const kept = sites.filter(site => site.file !== fsPath);
          if (kept.length === 0) {
            this.byKey.delete(key);
          } else {
            this.byKey.set(key, kept);
          }
        }
      }
      // 撤回调用键依赖与函数定义表贡献
      this.fnDefsByFile.delete(fsPath);
      for (const fn of entry.callFns) {
        const deps = this.callKeyDependents.get(fn);
        deps?.delete(fsPath);
        if (deps && deps.size === 0) {
          this.callKeyDependents.delete(fn);
        }
      }
      this.cache.delete(fsPath);
      // 仍属其他根 → 立即重建;脏文档 → 缓冲优先;无根 → 保持撤回
      const dirty = vscode.workspace.textDocuments.find(
        document => document.uri.fsPath === fsPath && document.isDirty
      );
      if (dirty) {
        this.noteSaved(dirty);
      } else if (resolveScopeRoot(fsPath)) {
        void this.indexFile(vscode.Uri.file(fsPath));
      }
    }
  }

  /**
   * AUD-071:根集添加/资产根切换——整库失效后重建,新根下文件按新根身份入键;
   * 旧任务(若在飞)经 generation 作废,不发布旧根。
   */
  invalidate(): void {
    if (this.disposed) {
      return;
    }
    this.generation += 1;
    this.byKey.clear();
    this.cache.clear();
    this.fnDefsByFile.clear();
    this.callKeyDependents.clear();
    void this.rebuild();
  }

  /** 按当前根集重扫全部(重建覆盖;根再变则放弃,由新 invalidate 接手)。 */
  private async rebuild(): Promise<void> {
    const generation = this.generation;
    if (this.disposed) {
      return;
    }
    const files = await findFilesAcrossRoots(this.pyGlob, PY_SCAN_EXCLUDE);
    if (this.disposed || this.generation !== generation) {
      return;
    }
    // KR-AUD-35:有界并发 worker 池(与初扫 INITIAL_SCAN_CONCURRENCY 同口径)——
    // 原 Promise.all(files.map(indexFile)) 无界,大库 invalidate 一次性打满
    // 数千 readFile。循环头复核 generation(与初扫 KR-AUD-29 同口径)。
    let nextFile = 0;
    const rebuildWorker = async (): Promise<void> => {
      while (!this.disposed && this.generation === generation && nextFile < files.length) {
        await this.indexFile(files[nextFile++]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(REBUILD_SCAN_CONCURRENCY, files.length) }, rebuildWorker));
    await this.drainPendingDependents();
  }

  /** 文件重扫后替换其贡献的倒排项(先撤旧再进新)。 */
  private replaceFileSites(
    fsPath: string,
    previous: KbeDataDictAccess[],
    next: KbeDataDictAccess[]
  ): void {
    const root = resolveScopeRoot(fsPath);
    for (const access of previous) {
      if (access.keySignature === null) {
        continue;
      }
      const key = siteKey(root, access.dict, access.keySignature);
      const sites = this.byKey.get(key);
      if (!sites) {
        continue;
      }
      const kept = sites.filter(site => site.file !== fsPath);
      if (kept.length === 0) {
        this.byKey.delete(key);
      } else {
        this.byKey.set(key, kept);
      }
    }
    for (const access of next) {
      if (access.keySignature === null) {
        continue;
      }
      const key = siteKey(root, access.dict, access.keySignature);
      const sites = this.byKey.get(key) ?? [];
      sites.push({ ...access, file: fsPath });
      this.byKey.set(key, sites);
    }
  }
}

/**
 * 查询面统一路由:普通键 → 单键查询;函数调用键(callFn)→ 现解全部签名
 * 并对每签名查询取并集(一访问点对应多签名);未解出 → 空数组(保持现状
 * null 口径,不硬猜)。definition/references/hover/inlay 同源。
 */
export function queryDataDictSitesForAccess(
  index: GlobalDataDictIndex,
  access: KbeDataDictAccess,
  root = ''
): KbeDataDictSite[] {
  if (!access.callFn) {
    if (access.keySignature === null) {
      return [];
    }
    return index.query(access.dict, access.keySignature, root);
  }
  const sigs = index.resolveCallSignatures(access.callFn);
  if (sigs === null) {
    return [];
  }
  const seen = new Set<string>();
  const sites: KbeDataDictSite[] = [];
  for (const sig of sigs) {
    for (const site of index.query(access.dict, sig, root)) {
      const id = `${site.file}\u0000${site.dict}\u0000${site.keySignature ?? ''}\u0000${site.line}\u0000${site.keyStart}`;
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      sites.push(site);
    }
  }
  return sites;
}
