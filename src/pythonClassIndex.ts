import * as fs from 'fs';
import * as path from 'path';
import { performance } from 'perf_hooks';
import * as vscode from 'vscode';
import { deriveCompositionRoots, type CompositionRootMap } from './compositionRoots';
import { findFilesAcrossRoots } from './scanRoots';
import { PY_SCAN_EXCLUDE, PY_SCAN_EXCLUDED_DIRS } from './pythonScanRules';
import { parsePythonFile } from './pythonParser';
import type { PythonClassDef, ParsedPythonFile } from './pythonParser';
import { parsePythonFileResponsive } from './pythonParserWorkerHost';
import { IndexScheduler, IndexTaskPriority } from './indexScheduler';
import { SemanticDependencyGraph } from './dependencyGraph';
import { INTERACTIVE_INDEX_WAIT_MS, raceWithBudget } from './hoverBudget';
import { jumpLog, jumpTimeStart } from './navigationLog';
import {
  recordLanguageServiceOperation,
  startLanguageServiceOperation
} from './languageServiceMetrics';

/**
 * Python 类层级索引(mixin/跨类跳转根因修复)。
 *
 * 既有跳转把方法归属交给 `.def` 派生索引(entityMapping.ts:573 对非 `.def`
 * 映射文件直接 return null;有 `.def` 也只按文件名 basename 当 owner 去 `.def`
 * 声明里查),导致「由基类/mixin 提供、不在任何 .def 里的方法」完全解析不到。
 * 本模块补上真正缺失的一层:**读 Python 类定义与基类、按 C3 MRO 解析
 * `self.<method>` 的真实实现位置**。跳转与 CodeLens 共用本索引。
 */

/**
 * 扫描排除面:官方三件套之外再排引擎构建/依赖/临时树。
 * 依据(2026-10-16 本机实测,D:\workspaces\kbengine):只排 node_modules/
 * third_party/.git 时命中 14,245 个 .py(vcpkg 10,108 + build 3,614 + …),
 * 平均 10.13ms/文件的顺序读 ≈ 144 秒——即用户实测的「跳转前加载很久」;
 * 收窄后同仓 117 个文件 ≈ 1.2 秒。业务脚本(scripts/tools 等)不受影响。
 */
export { PY_SCAN_EXCLUDE } from './pythonScanRules';

export { parsePythonFile, isPythonCodePosition, getPythonBaseExpressionAtPosition } from './pythonParser';
export type { PythonClassDef, ParsedPythonFile } from './pythonParser';

/** C3 线性化(Python3 真实 MRO):l(X) = X + merge(l(B1), l(B2), …, [B1,B2,…]) */
export function linearizeC3(name: string, resolve: (base: string) => PythonClassDef[]): string[] {
  const c3merge = (lists: string[][]): string[] => {
    const out: string[] = [];
    const work = lists.filter(list => list.length > 0).map(list => list.slice());
    let guard = 0;
    while (work.some(list => list.length > 0) && guard < 5000) {
      guard += 1;
      let chosen = '';
      let found = false;
      for (const list of work) {
        if (list.length === 0) {
          continue; // 被 splice 清空的列表必须跳过:list[0] 为 undefined
        }
        const candidate = list[0];
        // 候选不得出现在任何列表的尾部(除首个位置)
        const inTail = work.some(other => other.length > 0 && other.indexOf(candidate) > 0);
        if (!inTail) {
          chosen = candidate;
          found = true;
          break;
        }
      }
      if (!found) {
        // 不可线性化(非法继承图):平铺剩余去重,不丢类
        for (const list of work) {
          for (const n of list) {
            if (!out.includes(n)) {
              out.push(n);
            }
          }
        }
        return out;
      }
      out.push(chosen);
      for (let i = 0; i < work.length; i += 1) {
        const idx = work[i].indexOf(chosen);
        if (idx >= 0) {
          work[i].splice(idx, 1);
        }
      }
    }
    return out;
  };

  const memo = new Map<string, string[]>();
  const inProgress = new Set<string>();
  const lin = (n: string): string[] => {
    const cached = memo.get(n);
    if (cached) {
      return cached;
    }
    if (inProgress.has(n)) {
      return [n]; // 循环继承护栏:退化为含自身,不无限递归
    }
    inProgress.add(n);
    const defs = resolve(n);
    const bases = defs.length > 0 ? defs[0].bases : [];
    const seqs = bases.map(b => lin(b));
    if (bases.length > 0) {
      seqs.push(bases.slice());
    }
    const result = [n, ...c3merge(seqs)];
    inProgress.delete(n);
    memo.set(n, result);
    return result;
  };

  return lin(name);
}

export interface PythonMethodLocation {
  filePath: string;
  line: number;
  character: number;
  /** 提供该方法的类名(MRO 中首个命中) */
  className: string;
  /** MRO 序(用于 CodeLens/多实现呈现) */
  mro: string[];
  /** 解析所锚定的类:祖先解到 = 静态类自身;反向解到 = 继承静态类的类(主形态) */
  anchorClass?: string;
  /** 命中的组合根(entities.xml × .def × Python 继承交叉派生;①祖先直解可缺省) */
  compositionRoot?: string;
}

/**
 * IDE-IDX-018:self 方法解析结果。partial=true 表示预算到期/取消,枚举不完整
 * (仅 ① 静态 MRO 目标或空集,② 组合根与 ③ 反向后代未查全)——消费端不得
 * 据此发布「完整枚举无命中」的权威负结论;partial=false 才是查全口径。
 */
export interface SelfMethodResolution {
  readonly candidates: PythonMethodLocation[];
  readonly partial: boolean;
}

/**
 * 工作区 Python 类索引:按需扫描 *.py 建 className → 定义列表,
 * 变更时按文件失效。所有查询走缓存,不在热点路径重复解析。
 *
 * PR5(去全仓阻塞):
 * - 文件发现/解析迁入 IndexScheduler:首扫 = 后台全量任务(发现 keyed 任务 +
 *   分块 full-reindex 任务),受交互限流,不再让首个请求等待全量完成;
 * - Definition 先查快照 + 已建索引,请求所需文件(查询文件/同目录/import 候选/
 *   同名类文件)以 RequestLocal 单文件任务按需解析,后台补全量;
 * - 组合根派生带 mtime 内容缓存(未变更 XML/def 重派生不重读)并把来源文件
 *   记入 SemanticDependencyGraph(PR4),失效按图裁断,不推导全仓重建;
 * - 显式版本号:classes/bases/methods/mro/compositionRoots 五轴各自递增,
 *   供测试与调用方断言「哪类变更动了哪层派生」。
 */
export type PythonIndexVersionKey =
  | 'classes'
  | 'bases'
  | 'methods'
  | 'mro'
  | 'compositionRoots';

export type PythonIndexVersions = Record<PythonIndexVersionKey, number>;

/** 组合根派生物在依赖图里的节点键(PR4 SemanticDependencyGraph) */
export const COMPOSITION_ROOTS_NODE = 'python:composition-roots';

/** 全扫分块大小(对齐 PR1 基线的 16 路并发读;机械盘更高并发反而增加寻道) */
const SCAN_CHUNK_SIZE = 16;
/** 分块失败遗留文件的待补解析重试上限(永久不可读文件不无限重试) */
const MAX_SCAN_RETRY_ATTEMPTS = 3;

export class PythonClassIndex {
  private fileCache = new Map<string, { version: number; parsed: ParsedPythonFile }>();
  private byName = new Map<string, PythonClassDef[]>();
  /** 后台全量扫描协调 Promise(发现+分块解析;失败置空允许重试,不缓存假象) */
  private scanPromise: Promise<void> | null = null;
  /** PR3/PR5:调度器注入(扩展共享实例;独立构造自建一份) */
  private readonly scheduler: IndexScheduler;
  /** PR4:Python 侧依赖图(组合根派生物 → xml/def/带实例赋值的 py 来源) */
  private readonly dependencyGraph = new SemanticDependencyGraph();
  /** 组合根派生结果(懒建;实体注册/类型/实体定义变化时置空重派) */
  private rootsMap: CompositionRootMap | null = null;
  private rootsByScope = new Map<string, CompositionRootMap>();
  private rootsPromise: Promise<void> | null = null;
  private revisions = new Map<string, number>();
  private generation = 0;
  private scanGeneration = 0;
  private documents = new Map<string, vscode.TextDocument>();
  private mroCache = new Map<string, PythonClassDef[]>();
  /** 按需单文件解析(RequestLocal)进行中去重:同文件并发请求合并为一次入队 */
  private stagedRequests = new Map<string, Promise<void>>();
  /** 组合根派生纪元:每次 resetRoots 递增(派生并发判稳用) */
  private rootsEpoch = 0;
  /** 最近一次发现任务的全仓 .py 清单(discovery 序;staging 排序与扫描共用) */
  private discoveredFiles: vscode.Uri[] | null = null;
  /** discoveredFiles 所属扫描代(换代后强制重新发现) */
  private discoveredGeneration = -1;
  /**
   * 文件发现序(装载入口同步记号):③ 反向候选的跨文件排序用。分块装载是
   * Promise.all 并发(:837),完成序随 IO 时序翻动——不记号的话候选顺序
   * 不确定(CI 40470720225 红例:同两候选仅顺序翻)。按发现序定死。
   */
  private readonly fileOrder = new Map<string, number>();
  private nextFileOrder = 0;
  /**
   * 全扫中被取消/失败的分块遗留文件 → 已尝试次数。分块失败不再静默吞掉后
   * 照旧标记扫描代完成(那会让这批文件从未解析就永久缺席且无后续重试);
   * 后续查询按此表定向补解析,只重跑这几个文件,不全仓重扫。
   */
  private pendingScanRetries = new Map<string, number>();
  /** 待补重试是否已有分块在队列里(防每次查询重复入队) */
  private scanRetryInFlight = false;
  /** 组合根来源内容缓存(mtime+size 指纹;未变更文件重派生不再重读) */
  private rootsContentCache = new Map<string, { mtimeMs: number; size: number; content: string }>();
  /** 显式派生版本轴(④):断言「哪类变更动了哪层」 */
  private indexVersions: PythonIndexVersions = {
    classes: 0, bases: 0, methods: 0, mro: 0, compositionRoots: 0
  };

  constructor(scheduler?: IndexScheduler) {
    this.scheduler = scheduler ?? new IndexScheduler();
  }

  /** 显式版本查询(测试/遥测):断言变更只动受影响的派生层 */
  getIndexVersion(key: PythonIndexVersionKey): number {
    return this.indexVersions[key];
  }

  getIndexVersions(): PythonIndexVersions {
    return { ...this.indexVersions };
  }

  /** PR4 依赖图访问面(失效计划取证/测试) */
  getDependencyGraph(): SemanticDependencyGraph {
    return this.dependencyGraph;
  }

  /** 首扫后台化入口:调度器接管发现+分块解析,立即返回不等完成 */
  scheduleBackgroundScan(): void {
    void this.ensureScanned();
  }

  /**
   * 等待全量扫描完成(验收清单/测试面;对齐 EntityMappingManager.waitForInitialScan
   * 语义)。生产请求路径不调用它——Definition 首查不等全量,只有需要全仓口径
   * 结果的调用方(验收断言/类名枚举)才等待。
   */
  waitForInitialScan(): Promise<void> {
    return this.ensureScanned();
  }

  private classKey(cls: PythonClassDef): string {
    return `${cls.filePath}::${cls.qualifiedName ?? cls.name}::${cls.startLine}`;
  }

  private compatibleContext(candidate: PythonClassDef, context: PythonClassDef): boolean {
    const parts = (file: string) => file.replace(/\\/g, '/').match(/^(.*\/scripts)\/([^/]+)\//);
    const left = parts(candidate.filePath), right = parts(context.filePath);
    if (left && right) {
      if (left[1] !== right[1]) { return false; }
      const roles = new Set(['base', 'cell', 'client', 'bots']);
      if (roles.has(left[2]) && roles.has(right[2])) { return left[2] === right[2]; }
    }
    return true;
  }

  /** Resolve an import against module paths, never against unrelated class names. */
  private resolveSymbol(filePath: string, expression: string, seen = new Set<string>(), owner?: PythonClassDef): PythonClassDef | null {
    const key = `${filePath}::${expression}`;
    if (seen.has(key)) { return null; }
    seen.add(key);
    const importedLookup = seen.size > 1;
    const parsed = this.fileCache.get(filePath)?.parsed;
    if (!parsed) { return null; }
    const scope = owner?.qualifiedName?.split('.').slice(0, -1).join('.');
    const localNames = scope ? [`${scope}.${expression}`, expression] : [expression];
    for (const localName of localNames) {
      const local = parsed.classes.filter(cls => cls !== owner &&
        (!owner || cls.startLine < owner.startLine) && (cls.qualifiedName ?? cls.name) === localName).pop();
      if (local) { return local; }
    }
    const [head, ...tail] = expression.split('.');
    const binding = parsed.imports?.get(head);
    if (binding) {
      const symbol = [binding.symbol, ...tail].filter(Boolean).join('.');
      // Python imports the first matching module; an absent symbol must not
      // fall through to another role's module with the same basename.
      for (const target of this.importModuleCandidates(filePath, binding.module)) {
        if (!this.fileCache.has(target)) { continue; }
        const resolved = this.resolveSymbol(target, symbol, seen);
        return resolved ?? null;
      }
      return null;
    }
    // A package may expose a child module without re-exporting its classes:
    // `import pkg.mix` and `from pkg import mix` both bind a module receiver.
    if (path.basename(filePath) === '__init__.py' && tail.length) {
      const child = path.join(path.dirname(filePath), head);
      for (const target of [child + '.py', path.join(child, '__init__.py')]) {
        if (this.fileCache.has(target)) { return this.resolveSymbol(target, tail.join('.'), seen); }
      }
    }
    // Compatibility for implicit KBEngine script bindings: only an unambiguous
    // definition in this runtime context is eligible.
    if (importedLookup) { return null; }
    const context = parsed.classes[0];
    const candidates = (this.byName.get(expression) ?? []).filter(cls => cls !== owner &&
      (!context || this.compatibleContext(cls, context)));
    const nearby = candidates.filter(cls => path.dirname(cls.filePath) === path.dirname(filePath));
    return nearby.length === 1 ? nearby[0] : candidates.length === 1 ? candidates[0] : null;
  }

  /** import 模块名 → 候选文件路径(解析与按需 staging 共用同一口径,保序) */
  private importModuleCandidates(filePath: string, rawModuleName: string): string[] {
    let moduleName = rawModuleName;
    const roots: string[] = [];
    const relative = /^\.+/.exec(moduleName)?.[0].length ?? 0;
    if (relative) {
      let root = path.dirname(filePath);
      for (let i = 1; i < relative; i += 1) { root = path.dirname(root); }
      roots.push(root);
      moduleName = moduleName.slice(relative);
    } else {
      roots.push(path.dirname(filePath));
      const scripts = filePath.replace(/\\/g, '/').match(/^(.*\/scripts)(?:\/|$)/)?.[1];
      if (scripts) {
        const role = filePath.slice(scripts.length).split(/[\\/]/)[1];
        roots.push(path.join(scripts, role), path.join(scripts, 'common'), path.join(scripts, 'user_type'), scripts);
      }
      for (let root = path.dirname(filePath); ; root = path.dirname(root)) {
        roots.push(root);
        if (root === path.dirname(root)) { break; }
      }
    }
    const targets: string[] = [];
    for (const root of [...new Set(roots)]) {
      const modulePath = path.join(root, ...moduleName.split('.').filter(Boolean));
      targets.push(modulePath + '.py', path.join(modulePath, '__init__.py'));
    }
    return targets;
  }

  private mroClasses(cls: PythonClassDef): PythonClassDef[] {
    const cached = this.mroCache.get(this.classKey(cls));
    if (cached) { return cached; }
    const graph = new Map<string, PythonClassDef>();
    const visit = (current: PythonClassDef): void => {
      const key = this.classKey(current);
      if (graph.has(key)) { return; }
      const bases = current.bases.map(base => this.resolveSymbol(current.filePath, base, new Set(), current)).filter((base): base is PythonClassDef => !!base);
      graph.set(key, { ...current, bases: bases.map(base => this.classKey(base)) });
      bases.forEach(visit);
    };
    visit(cls);
    const result = linearizeC3(this.classKey(cls), key => graph.has(key) ? [graph.get(key)!] : [])
      .map(key => graph.get(key)!).filter(Boolean);
    this.mroCache.set(this.classKey(cls), result);
    return result;
  }

  private lookupClass(cls: PythonClassDef, methodName: string): PythonMethodLocation | null {
    const mro = this.mroClasses(cls);
    for (const provider of mro) {
      const loc = provider.methods.get(methodName);
      if (loc) { return { ...loc, filePath: provider.filePath, className: provider.name,
        mro: mro.map(item => item.name), anchorClass: cls.name }; }
    }
    return null;
  }

  /** Filesystem/configuration events invalidate the scan; open buffers survive. */
  invalidate(filePath?: string, changeKind: 'change' | 'create' | 'delete' = 'change'): void {
    // An unindexed Python file has no class/MRO entry to remove. In particular,
    // create/change notifications during discovery must not restart the scan.
    if (filePath?.toLowerCase().endsWith('.py') && !this.fileCache.has(filePath)) { return; }
    this.generation += 1;
    if (!filePath) {
      // 全量失效(工作区根切换/关停面):五轴全部递增
      for (const key of Object.keys(this.indexVersions) as PythonIndexVersionKey[]) {
        this.indexVersions[key] += 1;
      }
      this.resetRoots();
      this.rootsContentCache.clear();
    }
    if (filePath && !filePath.toLowerCase().endsWith('.py')) {
      // ④ 显式失效条件:只有依赖图记录在案的来源(entities.xml/.def/types.xml/
      // 带实例赋值的 py)才作废组合根;无关文件变更不再波及派生结果。
      const plan = this.dependencyGraph.planInvalidation(filePath, changeKind);
      if (plan.invalidateFiles.includes(COMPOSITION_ROOTS_NODE)) {
        this.indexVersions.compositionRoots += 1;
        this.resetRoots();
      }
      return;
    }
    this.scanGeneration += 1;
    this.mroCache.clear();
    this.stagedRequests.clear();
    this.indexVersions.mro += 1;
    if (filePath) {
      this.revisions.set(filePath, (this.revisions.get(filePath) ?? 0) + 1);
      this.unindexFile(filePath);
      this.fileCache.delete(filePath);
      this.fileOrder.delete(filePath);
      this.indexVersions.classes += 1;
    } else {
      for (const file of this.revisions.keys()) {
        this.revisions.set(file, (this.revisions.get(file) ?? 0) + 1);
      }
      this.fileCache.clear(); this.byName.clear(); this.fileOrder.clear(); this.nextFileOrder = 0;
    }
    this.scanPromise = null;
    this.resetRoots();
  }

  /**
   * IDE-SNP-009:统一移除根通知的消费面——定向摘除该根下全部记录,其余根
   * 原样保留(区别于整库 invalidate+重扫自愈)。返回摘除的 py 文件数;未知
   * 根是空操作,不虚进任何版本。
   */
  removeRoot(rootPath: string): number {
    if (!rootPath) { return 0; }
    // 前缀判定带分隔符:/ws 不误伤 /wsX;两种分隔符都认(键可能是任意拼写)
    const underRoot = (filePath: string): boolean =>
      filePath === rootPath ||
      filePath.startsWith(rootPath + '/') ||
      filePath.startsWith(rootPath + '\\');
    const removedFiles: string[] = [];
    for (const filePath of this.fileCache.keys()) {
      if (underRoot(filePath)) { removedFiles.push(filePath); }
    }
    let removedContentKeys = 0;
    for (const key of this.rootsContentCache.keys()) {
      if (underRoot(key)) { removedContentKeys += 1; }
    }
    if (removedFiles.length === 0 && removedContentKeys === 0) {
      return 0;
    }
    for (const filePath of removedFiles) {
      this.unindexFile(filePath);
      this.fileCache.delete(filePath);
      this.fileOrder.delete(filePath);
      this.revisions.delete(filePath);
      this.documents.delete(filePath);
      this.dependencyGraph.removeFile(filePath);
    }
    for (const key of [...this.rootsContentCache.keys()]) {
      if (underRoot(key)) { this.rootsContentCache.delete(key); }
    }
    for (const key of [...this.stagedRequests.keys()]) {
      if (underRoot(key)) { this.stagedRequests.delete(key); }
    }
    for (const key of [...this.pendingScanRetries.keys()]) {
      if (underRoot(key)) { this.pendingScanRetries.delete(key); }
    }
    // 摘除是显式版本事件(消费端可判定过期),非 TTL 静默过期;扫描换代让
    // 在途扫描/发现缓存(discoveredGeneration 口径)自然作废
    this.generation += 1;
    this.scanGeneration += 1;
    this.mroCache.clear();
    this.indexVersions.classes += 1;
    this.indexVersions.bases += 1;
    this.indexVersions.methods += 1;
    this.indexVersions.mro += 1;
    this.scanPromise = null;
    this.resetRoots();
    return removedFiles.length;
  }

  /** 组合根派生状态复位 + 显式版本递增(所有复位路径统一走这里,便于断言) */
  private resetRoots(): void {
    this.rootsEpoch += 1;
    if (this.rootsMap || this.rootsByScope.size > 0 || this.rootsPromise) {
      this.indexVersions.compositionRoots += 1;
    }
    this.rootsMap = null;
    this.rootsByScope.clear();
    this.rootsPromise = null;
  }

  async onFileChanged(filePath: string): Promise<void> {
    if (!filePath.toLowerCase().endsWith('.py')) {
      this.invalidate(filePath);
      return;
    }
    if (!this.fileCache.has(filePath) &&
        filePath.split(/[\\/]/).some(part => PY_SCAN_EXCLUDED_DIRS.has(part))) { return; }
    this.revisions.set(filePath, (this.revisions.get(filePath) ?? 0) + 1);
    await this.loadFile(filePath, -1);
  }

  onDocumentClosed(document: vscode.TextDocument): void {
    this.documents.delete(document.fileName);
    this.invalidate(document.fileName);
  }

  private updateFile(filePath: string, content: string, version: number): void {
    const parseStartedAt = performance.now();
    const parsed = parsePythonFile(content, filePath);
    this.commitParsedFile(filePath, parsed, version, performance.now() - parseStartedAt);
  }

  private async updateFileResponsive(filePath: string, content: string, version: number,
    revision: number): Promise<void> {
    const parseStartedAt = performance.now();
    const result = await parsePythonFileResponsive(content, filePath, revision);
    if (result.revision !== (this.revisions.get(filePath) ?? 0)) { return; }
    this.commitParsedFile(filePath, result.parsed, version, performance.now() - parseStartedAt);
  }

  private commitParsedFile(filePath: string, parsed: ParsedPythonFile, version: number,
    parseMs: number): void {
    const previous = this.fileCache.get(filePath)?.parsed;
    this.generation += 1;
    this.mroCache.clear();
    this.unindexFile(filePath);
    // PR1 打点:单文件解析耗时(document-parse),版本号随样本记录,
    // 解析结果与顺序保持原样(只观测,不改行为)。
    recordLanguageServiceOperation('document-parse', parseMs, {
      fileKind: 'python',
      documentVersion: version,
      fileParseCount: 1
    });
    this.fileCache.set(filePath, { version, parsed });
    for (const cls of parsed.classes) { this.indexClass(cls); }
    // ④ 显式版本轴:单次遍历构建 类/基类/方法 三层签名(30k 文件扫描路径上
    // JSON 序列化是可观测开销,合并为一次循环),哪层变了就递增哪轴。
    let classesChanged = false;
    let basesChanged = false;
    let methodsChanged = false;
    if (previous) {
      const byKey = new Map(previous.classes.map(cls => [this.classKey(cls), cls]));
      if (byKey.size !== parsed.classes.length) {
        classesChanged = true;
      }
      for (const cls of parsed.classes) {
        const before = byKey.get(this.classKey(cls));
        if (!before) {
          classesChanged = true;
        }
        if (!before || before.bases.join('\u0000') !== cls.bases.join('\u0000')) {
          basesChanged = true;
        }
        if (!before || before.methods.size !== cls.methods.size ||
            [...cls.methods.entries()].some(([name, loc]) => {
              const prev = before.methods.get(name);
              return !prev || prev.line !== loc.line || prev.character !== loc.character;
            })) {
          methodsChanged = true;
        }
      }
      if (classesChanged) {
        this.indexVersions.classes += 1;
      }
      if (basesChanged) {
        this.indexVersions.bases += 1;
      }
      if (methodsChanged) {
        this.indexVersions.methods += 1;
      }
      this.indexVersions.mro += 1;
    } else {
      this.indexVersions.classes += 1;
      this.indexVersions.bases += 1;
      this.indexVersions.methods += 1;
    }
    // ④ 组合根的「实现对象 → 类」桥接来源记入依赖图:只有带模块级实例赋值的
    // py 文件才是组合根派生来源,其余 py 变更不触发组合根重建(精确失效)。
    if (parsed.instanceAssignments.length > 0) {
      this.dependencyGraph.recordDependencies(COMPOSITION_ROOTS_NODE, [filePath]);
    }
    // Composition roots depend on entities.xml/.def/types.xml and the relatively
    // rare module-level `instance = Class()` bridge. Ordinary method/class edits
    // change MRO lookup data but do not require another three workspace-wide
    // metadata scans. Rebuild roots only when that bridge changes.
    // PR5:首扫后台化后,组合根派生与分块解析并发——首解析(previous 为空)只在
    // 真的带来实例赋值时才作废派生结果,否则后台扫文件会把刚建好的组合根冲掉。
    const assignmentSignature = (items: ParsedPythonFile['instanceAssignments']): string =>
      JSON.stringify(items.map(item => [item.variable, item.className]));
    const assignmentsChanged = !previous
      ? parsed.instanceAssignments.length > 0
      : assignmentSignature(previous.instanceAssignments) !== assignmentSignature(parsed.instanceAssignments);
    if (assignmentsChanged) {
      // 只有「实现对象 → 类」桥真正变化才作废组合根(首解析无赋值不动派生)
      this.resetRoots();
    }
  }

  private indexClass(cls: PythonClassDef): void {
    const list = this.byName.get(cls.name) ?? [];
    list.push(cls);
    this.byName.set(cls.name, list);
  }

  private unindexFile(filePath: string): void {
    const previous = this.fileCache.get(filePath)?.parsed;
    if (!previous) { return; }
    for (const name of new Set(previous.classes.map(cls => cls.name))) {
      const list = this.byName.get(name);
      if (!list) { continue; }
      const filtered = list.filter(item => item.filePath !== filePath);
      if (filtered.length === 0) {
        this.byName.delete(name);
      } else {
        this.byName.set(name, filtered);
      }
    }
  }

  /** 首次查询时全量扫描(幂等,失败不抛) */
  /**
   * 组合根派生输入指纹:fileCache 里全部模块级实例赋值(实现对象 → 类桥)。
   * 派生期间指纹变化 = 输入变化,触发重派(④ 显式失效条件的并发面)。
   */
  private assignmentsToken(): string {
    const items: string[] = [];
    for (const [file, { parsed }] of this.fileCache) {
      for (const item of parsed.instanceAssignments) {
        items.push(`${file}#${item.variable}=${item.className}`);
      }
    }
    return items.sort().join('|');
  }

  /**
   * 组合根派生(懒):entities.xml 全部实体 + 各实体 .def(父/接口/组件/字段类型)
   * + types.xml(implementedBy 字段对象类)。失败清缓存可重试(与扫描同口径)。
   */
  private async ensureCompositionRoots(): Promise<void> {
    if (this.rootsMap) {
      return;
    }
    if (this.rootsPromise) {
      // PR1 打点:并入进行中的组合根派生 = 本次请求在等索引初始化
      const joinWait = startLanguageServiceOperation('python-composition-roots', {
        waitedForInit: true,
        indexGeneration: this.generation
      });
      try {
        await this.rootsPromise;
        joinWait.end('ok');
      } catch {
        joinWait.end('error');
      }
      return this.rootsPromise;
    }
    this.rootsPromise = (async () => {
      const rootsTimer = jumpTimeStart();
      const compositionMetrics = startLanguageServiceOperation('python-composition-roots', {
        indexGeneration: this.generation
      });
      // PR5:不再等全量 .py 扫描——「实现对象 → 类」桥接用当前已建索引的实例
      // 赋值表(未扫全时部分派生,赋值文件入索引后经 updateFile 的赋值签名对比
      // 自动重派生);首扫本身已后台化,这里只需确保它在推进。
      void this.ensureScanned();
      const readText = async (uri: vscode.Uri): Promise<string> => {
        const document = vscode.workspace.textDocuments?.find(doc => doc.fileName === uri.fsPath) ?? this.documents.get(uri.fsPath);
        if (document) {
          this.rootsContentCache.set(uri.fsPath, {
            mtimeMs: 0, size: document.getText().length, content: document.getText()
          });
          return document.getText();
        }
        // ③ 组合根构建缓存:同批 XML/def 只在 mtime/size 变化时才真正重读,
        // 重派生(entities.xml/.def 局部失效后的常见路径)命中缓存不产生 IO。
        try {
          const stat = await fs.promises.stat(uri.fsPath);
          const cached = this.rootsContentCache.get(uri.fsPath);
          if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
            compositionMetrics.countCacheHit(1);
            return cached.content;
          }
          const content = await fs.promises.readFile(uri.fsPath, 'utf8');
          this.rootsContentCache.set(uri.fsPath, { mtimeMs: stat.mtimeMs, size: stat.size, content });
          return content;
        } catch (error) {
          this.rootsContentCache.delete(uri.fsPath);
          throw error;
        }
      };
      let epochBefore = this.rootsEpoch;
      try {
        // PR5 并发护栏:首扫后台化后,分块解析与派生并发推进。派生输入 =
        // 元数据文件内容 + fileCache 实例赋值快照。注意不能用 this.generation
        // 判稳——每次单文件解析都会递增它,后台扫描期间会引发无谓重派风暴;
        // 这里以「组合根纪元(resetRoots)+ 赋值桥指纹」双条件判稳,输入变了才
        // 用内容缓存重派(重读为零),不静默丢弃。
        for (let attempt = 0; attempt < 8; attempt += 1) {
        epochBefore = this.rootsEpoch;
        const assignmentsBefore = this.assignmentsToken();
        const [entityXmlFiles, defFiles, typeXmlFiles] = await Promise.all([
          findFilesAcrossRoots('**/entities.xml', PY_SCAN_EXCLUDE),
          findFilesAcrossRoots('**/*.def', PY_SCAN_EXCLUDE),
          findFilesAcrossRoots('**/types.xml', PY_SCAN_EXCLUDE)
        ]);
        compositionMetrics.countFileDiscovery(entityXmlFiles.length + defFiles.length + typeXmlFiles.length);
        // ④ 组合根派生来源记入 PR4 依赖图:entities.xml/types.xml 全量、.def
        // 全量(父链/接口/组件交叉读取,逐文件依赖边不划算);失效按图裁断。
        this.dependencyGraph.recordDependencies(COMPOSITION_ROOTS_NODE, [
          ...entityXmlFiles.map(uri => uri.fsPath),
          ...defFiles.map(uri => uri.fsPath),
          ...typeXmlFiles.map(uri => uri.fsPath)
        ]);
        const scopes = [...new Set(entityXmlFiles.map(uri => path.dirname(uri.fsPath)))];
        const scopeFor = (file: string): string => scopes
          .filter(scope => file.startsWith(scope + path.sep))
          .sort((left, right) => right.length - left.length)[0]
          ?? file.replace(/\\/g, '/').match(/^(.*?)\/(?:scripts|entity_defs)(?:\/|$)/)?.[1]
          ?? path.dirname(file);
        const groups = new Map<string, {
          entitiesXmlContents: string[]; typesXmlContents: string[];
          entityDefs: Array<{ entity: string; content: string }>;
        }>();
        const readGroup = async (uri: vscode.Uri, kind: 'entities' | 'types' | 'def'): Promise<void> => {
          try {
            const scope = scopeFor(uri.fsPath);
            const group = groups.get(scope) ?? { entitiesXmlContents: [], typesXmlContents: [], entityDefs: [] };
            groups.set(scope, group);
            const content = await readText(uri);
            compositionMetrics.countFileRead(1);
            compositionMetrics.countFileParse(1);
            if (kind === 'entities') { group.entitiesXmlContents.push(content); }
            else if (kind === 'types') { group.typesXmlContents.push(content); }
            else if (!/[\\/](components|interfaces)[\\/]/i.test(uri.fsPath)) {
              group.entityDefs.push({ entity: path.basename(uri.fsPath, '.def'), content });
            }
          } catch {
            // A missing file cannot prevent other asset projects from resolving.
          }
        };
        // Preserve discovery order; derived root order is also candidate order.
        for (const uri of entityXmlFiles) { await readGroup(uri, 'entities'); }
        for (const uri of typeXmlFiles) { await readGroup(uri, 'types'); }
        for (const uri of defFiles) { await readGroup(uri, 'def'); }
        const scoped = new Map<string, CompositionRootMap>();
        const resolvedRoots: string[] = [];
        const combinedMixins = new Map<string, string[]>();
        for (const [scope, group] of groups) {
          const derived = deriveCompositionRoots(group);
          const assignments = new Map<string, string>();
          for (const [file, { parsed }] of this.fileCache) {
            if (scopeFor(file) !== scope) { continue; }
            for (const item of parsed.instanceAssignments) { assignments.set(item.variable, item.className); }
          }
          const roots = [...new Set(derived.roots.map(root => assignments.get(root) ?? root))];
          scoped.set(scope, { roots, defMixins: derived.defMixins });
          for (const root of roots) { if (!resolvedRoots.includes(root)) { resolvedRoots.push(root); } }
          for (const [root, mixins] of derived.defMixins) {
            combinedMixins.set(root, [...new Set([...(combinedMixins.get(root) ?? []), ...mixins])]);
          }
        }
        if (this.rootsEpoch !== epochBefore || this.assignmentsToken() !== assignmentsBefore) {
          continue; // 输入在派生期间变化(或派生结果已被失效):重派(元数据走内容缓存,零 IO)
        }
        this.rootsByScope = scoped;
        this.rootsMap = { roots: resolvedRoots, defMixins: combinedMixins };
        compositionMetrics.end('ok');
        jumpLog('info', () =>
          `组合根派生 ${resolvedRoots.length} 根: [${resolvedRoots.join(', ')}] ${rootsTimer()}ms(第 ${attempt + 1} 次尝试落地)`
        );
        return;
        }
        // 多次让位后输入仍在变(编辑风暴):按最后一次快照落地;真实失效
        // (依赖图裁断/赋值签名变化)仍会在下一次 updateFile/invalidate 纠正。
        jumpLog('info', () => `组合根派生连续让位 8 次,按最后一次输入落地 ${rootsTimer()}ms`);
      } catch {
        compositionMetrics.end('error');
        // 派生失败:不当成功缓存,下次跳转重试;已建索引不受影响
        if (epochBefore === this.rootsEpoch) {
          this.rootsMap = null;
          this.rootsByScope.clear();
          this.rootsPromise = null;
        }
      }
    })();
    return this.rootsPromise;
  }

  /**
   * 「类 X 被哪些组合根收录」——三输入交叉:根自身的 Python MRO(含同名多文件)
   * 或根 .def 声明的 mixin(Parent/接口/组件)名单命中 X。
   * 按组合根派生序返回(entities.xml 实体序在前)。
   */
  async rootsContaining(className: string): Promise<string[]> {
    await this.ensureCompositionRoots();
    const map = this.rootsMap;
    if (!map) {
      return [];
    }
    const hits: string[] = [];
    for (const root of map.roots) {
      if (root === className) {
        hits.push(root);
        continue;
      }
      if (this.byName.has(root)) {
        const contains = (this.byName.get(root) ?? []).some(cls =>
          this.mroClasses(cls).some(base => base.name === className));
        if (contains) {
          hits.push(root);
          continue;
        }
      }
      if ((map.defMixins.get(root) ?? []).includes(className)) {
        hits.push(root);
      }
    }
    return hits;
  }

  /**
   * 全量知识入口(类名枚举/MRO/后代等必须全仓口径的 API 等这里)。
   * PR5 起扫描本体在调度器后台推进:发现 = keyed initial-scan 任务,解析 =
   * 分块 full-reindex 后台任务(受交互限流);失败不缓存「已扫描」假象,
   * scanPromise 置空后下次调用重新协调(与修复前语义一致)。
   * 单飞行守卫:同一代只允许一个 runScheduledScan 实例——并发调用共享同一
   * scanPromise,终态(成功记完成代/失败清空)由唯一实例回写,不互相覆盖。
   */
  private scanCompletedGeneration = -1;

  private ensureScanned(): Promise<void> {
    if (this.scanCompletedGeneration === this.scanGeneration) {
      // 扫描代已完成,但可能存在失败分块遗留的待补文件:定向重试(不全仓重扫)
      this.schedulePendingScanRetry();
      return Promise.resolve();
    }
    if (!this.scanPromise) {
      const generation = this.scanGeneration;
      this.scanPromise = this.runScheduledScan(generation)
        .then(() => {
          if (generation === this.scanGeneration) {
            this.scanCompletedGeneration = generation;
          }
        }, () => undefined)
        .finally(() => {
          if (generation === this.scanGeneration) {
            this.scanPromise = null;
          }
        });
    }
    return this.scanPromise;
  }

  /**
   * 分块取消/失败遗留文件与解析失败(旧索引保留)文件的定向补解析:单个
   * 后台小块,逐文件重跑 loadFile,以其实际提交结果(false=本次未提交)推进
   * 有界重试(MAX_SCAN_RETRY_ATTEMPTS 次),永久不可读的文件不无限重试;
   * 整块再被取消则保持登记,下一次查询再试。
   */
  private schedulePendingScanRetry(): void {
    if (this.scanRetryInFlight || this.pendingScanRetries.size === 0) { return; }
    const files = [...this.pendingScanRetries.keys()];
    if (files.length === 0) { return; }
    this.scanRetryInFlight = true;
    // 逐文件收 loadFile 的提交结果:登记表里既有从未入索引的分块遗留文件,
    // 也有解析失败但旧索引仍在的文件——后者 fileCache 恒有值,不能拿
    // 「表里有」当成功信号,必须看本次重试是否真的提交了内容。
    const committed = new Map<string, boolean>();
    this.scheduler.enqueue({
      kind: 'full-reindex',
      priority: IndexTaskPriority.BackgroundFull,
      run: async () => {
        for (const file of files) {
          committed.set(file, await this.loadFile(file, -1));
        }
      }
    }).wait.then(
      () => {
        for (const file of files) {
          if (committed.get(file) === true) {
            this.pendingScanRetries.delete(file);
            continue;
          }
          const attempts = (this.pendingScanRetries.get(file) ?? 1) + 1;
          if (attempts >= MAX_SCAN_RETRY_ATTEMPTS) {
            this.pendingScanRetries.delete(file);
            jumpLog('info', () =>
              `py 待补解析重试 ${MAX_SCAN_RETRY_ATTEMPTS} 次仍未成功,放弃: ${file}`);
          } else {
            this.pendingScanRetries.set(file, attempts);
          }
        }
      },
      () => undefined // 整块被取消:文件从未解析,保持登记,下一次查询再试
    ).finally(() => { this.scanRetryInFlight = false; });
  }

  /** 首扫协调:调度器 keyed 发现任务 → 分块后台解析任务(任务间可插队交互任务) */
  private async runScheduledScan(scanGeneration: number): Promise<void> {
    const scanMetrics = startLanguageServiceOperation('python-index-scan', {
      indexGeneration: this.generation
    });
    const scanTimer = jumpTimeStart();
    try {
      const files = await this.ensureDiscovered(scanGeneration);
      // 读取/解析计数按「尝试处理的文件数」口径:loadFile 内部有打开缓冲复用
      // 与读失败回退,精确的读/解析分布由 document-parse 事件单独承载。
      scanMetrics.countFileDiscovery(files.length);
      scanMetrics.countFileRead(files.length);
      scanMetrics.countFileParse(files.length);
      // ③ 反向候选的跨文件排序基线:发现序在此落号(首见不重排)。分块装载
      // 是 Promise.all 并发,完成序随 IO 时序翻动;按需预载又是 readdir 序,
      // 只有发现序才是候选顺序的稳定口径(CI 40470720225 红例根因)。
      for (const uri of files) { this.noteFileOrder(uri.fsPath); }
      // 分块入队:每块一个后台任务,块与块之间调度器可插队交互任务
      // (RequestLocal 单文件解析/当前文件更新),全量扫描不再独占主线程。
      const batches: string[][] = [];
      const handles = [];
      for (let offset = 0; offset < files.length; offset += SCAN_CHUNK_SIZE) {
        const batch = files.slice(offset, offset + SCAN_CHUNK_SIZE).map(uri => uri.fsPath);
        batches.push(batch);
        handles.push(this.scheduler.enqueue({
          kind: 'full-reindex',
          priority: IndexTaskPriority.BackgroundFull,
          run: async () => {
            // 失效换代:过期分块直接放弃(旧代结果不得覆盖新一代状态)
            if (scanGeneration !== this.scanGeneration) { return; }
            await Promise.all(batch.map(file => this.loadFile(file, -1)));
          }
        }));
      }
      // 逐分块收终态:取消/失败的分块不再把拒绝逐一吞掉后照旧标记该代完成
      // ——那会让这批文件(每块最多 SCAN_CHUNK_SIZE 个)从未解析就永久缺席且无后续重试。
      const outcomes = await Promise.all(
        handles.map(handle => handle.wait.then(() => 'completed', () => 'failed' as const))
      );
      if (scanGeneration !== this.scanGeneration) {
        scanMetrics.end('cancelled');
        return;
      }
      const failedFiles = batches.flatMap((batch, index) =>
        outcomes[index] === 'completed' ? [] : batch);
      if (failedFiles.length > 0) {
        for (const file of failedFiles) {
          if (!this.fileCache.has(file)) { this.pendingScanRetries.set(file, 1); }
        }
        jumpLog('info', () =>
          `py 全扫有 ${failedFiles.length} 个文件未随分块解析,已登记待补(后续查询定向重试)`);
      } else {
        // 本轮无失败分块:上一代遗留的待补文件已被本轮全量覆盖,清表
        this.pendingScanRetries.clear();
      }
      jumpLog('info', () =>
        `py 全仓索引完成 ${files.length} 个文件 → 类 ${this.byName.size} 个,${scanTimer()}ms(调度器分块后台执行)`);
      scanMetrics.end('ok');
    } catch (error) {
      scanMetrics.end('error');
      // 扫描失败不阻断跳转,但必须让 ensureScanned 的单飞行守卫感知失败:
      // 重抛后完成代不记账,scanPromise 清空,下次调用重新协调(与修复前
      // 「失败不缓存已扫描假象」语义一致)。
      if (scanGeneration === this.scanGeneration) { throw error; }
    }
  }

  /**
   * 文件发现(keyed 单例)只供后台全扫；请求所需的已知文件按路径定向补载。
   * 同代缓存直接复用，换代或失败后可重新发现。
   */
  private async ensureDiscovered(scanGeneration: number): Promise<vscode.Uri[]> {
    if (this.discoveredFiles && this.discoveredGeneration === scanGeneration) {
      return this.discoveredFiles;
    }
    await this.scheduler.ensureTask(`python-file-discovery#${scanGeneration}`, () => ({
      kind: 'initial-scan' as const,
      priority: IndexTaskPriority.BackgroundFull,
      run: async () => {
        this.discoveredFiles = await findFilesAcrossRoots('**/*.py', PY_SCAN_EXCLUDE);
      }
    }));
    this.discoveredGeneration = scanGeneration;
    return this.discoveredFiles ?? [];
  }

  /**
   * 请求所需文件按需单文件解析(②):RequestLocal 优先级入队,排在后台
   * 全量分块之前;同文件并发请求合并为一次入队(调度器同版本合并 + 本地去重)。
   */
  private loadFileOnDemand(filePath: string): Promise<void> {
    if (this.fileCache.has(filePath)) {
      return Promise.resolve();
    }
    const pending = this.stagedRequests.get(filePath);
    if (pending) {
      return pending;
    }
    const task = this.scheduler.enqueue({
      kind: 'single-file-update',
      priority: IndexTaskPriority.RequestLocal,
      filePath,
      version: this.revisions.get(filePath) ?? 0,
      run: async () => { await this.loadFile(filePath, -1); }
    });
    const done = task.wait
      .catch(() => undefined)
      .then(() => { this.stagedRequests.delete(filePath); });
    this.stagedRequests.set(filePath, done);
    return done;
  }

  /**
   * Definition 请求前置(②):把解析该请求可能需要的文件补进索引——
   * ① 查询文件自身;② 其 import 的模块候选路径(与 resolveSymbol 同一口径);
   * ③ 同目录兄弟 .py(隐式就近引用;上限防大目录全读)。
   * 候选按 import 搜索顺序、再按同目录文件名顺序补载；全程只需已知路径。
   * 全部走 RequestLocal 单文件任务，不等待全仓 discovery。
   */
  private async stageRequestFiles(filePath: string, token?: vscode.CancellationToken): Promise<void> {
    if (token?.isCancellationRequested) { return; }
    if (!this.fileCache.has(filePath)) {
      await this.loadFileOnDemand(filePath);
    }
    if (token?.isCancellationRequested) { return; }
    const cached = this.fileCache.get(filePath);
    if (!cached) {
      return; // 文件不可读:后续解析按落空降级
    }
    // 审核发现(:183):import 派生的候选是真实依赖,不得按序截 64——截断会把
    // 导入较多文件里靠后的真实依赖静默跳过,首查跳转落空。import 候选全量补载;
    // 兄弟目录候选保留上限(防大目录全读,显式口径而非静默丢依赖)。
    const importTargets: string[] = [];
    const seenTargets = new Set<string>();
    for (const binding of cached.parsed.imports?.values() ?? []) {
      for (const target of this.importModuleCandidates(filePath, binding.module)) {
        if (seenTargets.has(target)) { continue; }
        seenTargets.add(target);
        importTargets.push(target);
      }
    }
    const missingImports = importTargets.filter(target => !this.fileCache.has(target));
    for (let offset = 0; offset < missingImports.length; offset += 8) {
      if (token?.isCancellationRequested) { return; }
      await Promise.all(missingImports.slice(offset, offset + 8).map(target => this.loadFileOnDemand(target)));
    }
    try {
      const dir = path.dirname(filePath);
      const siblings = (await fs.promises.readdir(dir))
        .filter(name => name.toLowerCase().endsWith('.py')).sort();
      const missingSiblings = siblings.slice(0, 64)
        .map(sibling => path.join(dir, sibling))
        .filter(target => !this.fileCache.has(target) && !seenTargets.has(target));
      for (let offset = 0; offset < missingSiblings.length; offset += 8) {
        if (token?.isCancellationRequested) { return; }
        await Promise.all(missingSiblings.slice(offset, offset + 8).map(target => this.loadFileOnDemand(target)));
      }
    } catch {
      // 目录不可列(已删除/无权限):按落空降级
    }
  }

  /**
   * 定点按名补文件(②兜底):一类一文件的常规布局下,解析落空时按
   * 类名同名 glob(星号星号斜杠 &lt;ClassName&gt;.py)补入候选文件后重试一次
   * ——代价是一次定点发现,不是全仓扫描。
   */
  private async stageClassNameFiles(names: string[], token?: vscode.CancellationToken): Promise<void> {
    if (token?.isCancellationRequested) { return; }
    const unique = [...new Set(names.filter(name => /^[A-Za-z_]\w*$/.test(name)))].slice(0, 8);
    const discovered = await Promise.all(unique.map(async name => {
      try {
        return await findFilesAcrossRoots(`**/${name}.py`, PY_SCAN_EXCLUDE, token);
      } catch {
        return [];
      }
    }));
    if (token?.isCancellationRequested) { return; }
    const missing = discovered.flat().map(uri => uri.fsPath)
      .filter(target => !this.fileCache.has(target)).slice(0, 16);
    for (let offset = 0; offset < missing.length; offset += 8) {
      if (token?.isCancellationRequested) { return; }
      await Promise.all(missing.slice(offset, offset + 8).map(target => this.loadFileOnDemand(target)));
    }
  }

  /** 文件发现序记号:只在全扫发现清单落地时同步调用(保持首见序不重排)——
   * 装载入口不能记:按需预载(stageRequestFiles)用 readdir 序,会污染发现序。 */
  private noteFileOrder(filePath: string): void {
    if (!this.fileOrder.has(filePath)) {
      this.fileOrder.set(filePath, this.nextFileOrder++);
    }
  }

  private async loadFile(filePath: string, version: number): Promise<boolean> {
    const revision = this.revisions.get(filePath) ?? 0;
    this.revisions.set(filePath, revision);
    // 读失败与解析失败分流(审核发现:两者原共用一个 catch,解析线程崩溃会
    // 把仍存在文件的旧类索引一并删掉)。读失败=文件被删/不可读,撤索引正确;
    // 解析失败=内容已读到、文件仍在盘,必须保留旧索引并登记待补重试。
    // 返回值:false=本次尝试未提交内容(待补重试,有界);true=已提交或无害早退。
    let open: vscode.TextDocument | undefined;
    let content: string;
    try {
      open = vscode.workspace.textDocuments?.find(doc => doc.fileName === filePath) ?? this.documents.get(filePath);
      content = open ? open.getText() : await fs.promises.readFile(filePath, 'utf8');
    } catch {
      // A removed/unreadable file must not leave navigable stale classes.
      // PR5:从未入索引的文件(staging 探测的候选路径不存在等)只记录版本,
      // 不动类集/MRO/组合根——否则探测性读取会把派生状态反复冲掉。
      if ((this.revisions.get(filePath) ?? 0) === revision) {
        const wasIndexed = this.fileCache.has(filePath);
        this.stagedRequests.delete(filePath);
        if (wasIndexed) {
          this.unindexFile(filePath); this.fileCache.delete(filePath);
          this.fileOrder.delete(filePath);
          this.mroCache.clear();
          this.generation += 1;
          this.indexVersions.classes += 1;
          this.indexVersions.mro += 1;
          this.resetRoots();
        }
      }
      return false;
    }
    try {
      if ((this.revisions.get(filePath) ?? 0) !== revision) { return true; }
      await this.updateFileResponsive(filePath, content, open?.version ?? version, revision);
      return true;
    } catch {
      // 解析失败(解析线程崩溃/被停用/postMessage 异常):文件仍在盘,旧类
      // 索引保留——删掉会让悬停/跳转在 worker 恢复前整段落空,且下次成功解析
      // 前该文件凭空缺席。登记待补重试(与分块失败同渠道,有界
      // MAX_SCAN_RETRY_ATTEMPTS,已有计数不重置防反复崩溃绕过上限),
      // 后续查询经 schedulePendingScanRetry 定向补解析。
      this.stagedRequests.delete(filePath);
      if (!this.pendingScanRetries.has(filePath)) {
        this.pendingScanRetries.set(filePath, 1);
      }
      jumpLog('info', () => `py 解析失败(保留旧索引,已登记待补重试): ${filePath}`);
      return false;
    }
  }

  /** Use the buffer synchronously so an older disk read cannot overwrite edits. */
  async onDocumentChanged(document: vscode.TextDocument): Promise<void> {
    if (!/\.(py|def|xml)$/i.test(document.fileName)) { return; }
    // IDE-DIA-003:同版本已入缓存即零成本跳过(诊断 syncDocumentParse 先解析
    // 入缓存后,此处防抖补喂命中,不再各自完整解析一次);只认版本号——
    // 缓存里那份就是该版本缓冲的解析,与文档对象身份无关;版本不可知
    // (undefined)永不判同(空缓存 vacuous 命中会吞掉首解析)
    const cachedVersion = this.fileCache.get(document.fileName)?.version;
    if (cachedVersion !== undefined && cachedVersion === document.version) { return; }
    this.documents.set(document.fileName, document);
    if (!document.fileName.toLowerCase().endsWith('.py')) {
      this.generation += 1;
      const plan = this.dependencyGraph.planInvalidation(document.fileName, 'change');
      if (plan.invalidateFiles.includes(COMPOSITION_ROOTS_NODE)) {
        this.resetRoots();
      }
      return;
    }
    this.revisions.set(document.fileName, (this.revisions.get(document.fileName) ?? 0) + 1);
    await this.updateFileResponsive(document.fileName, document.getText(), document.version,
      this.revisions.get(document.fileName)!);
  }

  /** 版本键只读面:缓存命中且版本一致才给解析结果,否则 null(不把旧代
   * 当现版本用;version 不可知(undefined)同样不给) */
  getParsedForVersion(filePath: string, version: number | undefined): ParsedPythonFile | null {
    if (version === undefined) { return null; }
    const cached = this.fileCache.get(filePath);
    return cached && cached.version === version ? cached.parsed : null;
  }

  /** IDE-DIA-003 共享解析面:同版本命中直接返回缓存对象(零解析);未命中
   * 同步解析并按版本入缓存——receiver 诊断与类索引消费同一份解析,
   * 后续 onDocumentChanged 同版本去重不再各自完整解析一次 */
  syncDocumentParse(document: Pick<vscode.TextDocument, 'fileName' | 'version' | 'getText'>): ParsedPythonFile {
    const hit = this.getParsedForVersion(document.fileName, document.version);
    if (hit) { return hit; }
    const parsed = parsePythonFile(document.getText(), document.fileName);
    this.commitParsedFile(document.fileName, parsed, document.version ?? -1, 0);
    return parsed;
  }

  async resolveClassBase(document: vscode.TextDocument, expression: string, line?: number,
    token?: vscode.CancellationToken): Promise<PythonClassDef | null> {
    if (token?.isCancellationRequested) { return null; }
    await this.onDocumentChanged(document);
    // ② PR5:先查快照+已建索引,请求所需文件按需单文件解析;全量扫描后台补,
    // 不再让基类跳转等 107s 级冷启动扫描。
    this.scheduleBackgroundScan();
    const owner = line === undefined ? undefined : await this.findEnclosingClass(document.fileName, line) ?? undefined;
    await this.stageRequestFiles(document.fileName, token);
    if (token?.isCancellationRequested) { return null; }
    const resolved = this.resolveSymbol(document.fileName, expression, new Set(), owner);
    if (resolved) {
      return resolved;
    }
    // 定点兜底:一类一文件布局下按类名补 `**/<Name>.py` 后重试一次
    await this.stageClassNameFiles([expression.split('.')[0]], token);
    if (token?.isCancellationRequested) { return null; }
    return this.resolveSymbol(document.fileName, expression, new Set(), owner);
  }

  /** 类名 → 定义列表(可能同名多处) */
  async findClassesByName(name: string): Promise<PythonClassDef[]> {
    await this.ensureScanned();
    return this.byName.get(name) ?? [];
  }

  /** 按文件行找内层类定义(用于定位调用点所在类) */
  async findEnclosingClass(filePath: string, line: number): Promise<PythonClassDef | null> {
    // ② PR5:文件本地查询,按需单文件解析即可,不等全仓扫描
    let cached = this.fileCache.get(filePath);
    if (!cached) {
      await this.loadFileOnDemand(filePath);
      cached = this.fileCache.get(filePath);
    }
    if (!cached) {
      return null;
    }
    // 内层优先(endLine 相同取 startLine 更大者)
    const hits = cached.parsed.classes.filter(cls => line >= cls.startLine && line < cls.endLine);
    if (hits.length === 0) {
      return null;
    }
    return hits.reduce((a, b) => (b.startLine > a.startLine ? b : a));
  }

  /** 计算某类的 MRO(含自身),跨文件基类解析 */
  async computeMRO(className: string): Promise<string[]> {
    await this.ensureScanned();
    const definitions = this.byName.get(className) ?? [];
    return definitions.length === 1 ? this.mroClasses(definitions[0]).map(cls => cls.name) : [];
  }

  /** 类 name 的全部后代(直接子类传递闭包,含环护栏) */
  async descendantsOf(name: string): Promise<PythonClassDef[]> {
    await this.ensureScanned();
    const seeds = new Set((this.byName.get(name) ?? []).map(cls => this.classKey(cls)));
    const out: PythonClassDef[] = [];
    for (const defs of this.byName.values()) {
      for (const cls of defs) {
        if (!seeds.has(this.classKey(cls)) && this.mroClasses(cls).some(base => seeds.has(this.classKey(base)))) { out.push(cls); }
      }
    }
    return out;
  }

  /**
   * 主形态解析:从 `self` 的**静态类**出发解 C3 MRO,跨文件命中 mixin 定义。
   * ① 静态类自身 MRO(祖先)—— 覆盖「子类调基类」;
   * ② 静态类 MRO 无果 → 反向找**继承静态类的类**(兄弟 mixin 经共同子类,
   *    如 MixinB.self.x() 需经 Avatar = (MixinA, MixinB) 的 MRO 才落到 MixinA)。
   * 去重后按 祖先优先 → 后代声明序 返回全部候选(供 Location[] 列表选择)。
   * IDE-IDX-018:返回带 partial 标记——预算到期/取消时枚举不完整,消费端
   * 不得把空集当作完整枚举的权威负结论。
   */
  async resolveSelfMethodResolution(
    filePath: string,
    line: number,
    methodName: string,
    document?: vscode.TextDocument,
    token?: vscode.CancellationToken,
    /** 组合根/全量就绪的预算(ms);测试注入小预算以确定性复现超时路径 */
    budgetMs: number = INTERACTIVE_INDEX_WAIT_MS
  ): Promise<SelfMethodResolution> {
    if (token?.isCancellationRequested) { return { candidates: [], partial: true }; }
    const queryTimer = jumpTimeStart();
    jumpLog('info', () => `py 查询 ${path.basename(filePath)}:${line + 1} 方法=${methodName}`);
    if (document) { await this.onDocumentChanged(document); }
    // ② PR5:首查不阻塞在全量扫描上——快照/已建索引先答,请求所需文件
    // (查询文件/同目录/import 候选)按需单文件解析,全量后台补。
    this.scheduleBackgroundScan();
    const enclosing = await this.findEnclosingClass(filePath, line);
    if (token?.isCancellationRequested) { return { candidates: [], partial: true }; }
    if (!enclosing) {
      jumpLog('info', () => 'py 查询落空: 光标不在任何类内(或文件未入索引)');
      return { candidates: [], partial: false };
    }
    await this.stageRequestFiles(filePath, token);
    if (token?.isCancellationRequested) { return { candidates: [], partial: true }; }
    const seen = new Set<string>();
    const push = (loc: PythonMethodLocation | null, out: PythonMethodLocation[]): void => {
      if (!loc) {
        return;
      }
      const key = `${loc.filePath}::${loc.line}::${loc.character}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      out.push(loc);
    };

    const out: PythonMethodLocation[] = [];
    // ①② 两段查询:第二遍只在第一遍落空且后台扫描未收敛时,先等全量就绪再
    // 重查(③ 反向形态的后代集合无法按需定点,必须全仓口径;①② 命中则首查
    // 不等全量——这正是 PR5 去阻塞的主路径)。
    for (let pass = 0; pass < 2; pass += 1) {
    // ① 先记录静态类 MRO 命中，但不能在这里提前返回。
    // 同一个 mixin 可被多个实体组合，且这些实体的 MRO 可能覆盖该方法；
    // 例如 CombatMixin.self.compute_damage 在 TrainingAvatar、TrainingMonster
    // 与 EliteMonster 上分别命中 CriticalDamageMixin、DamageMixin、
    // EliteDamageMixin。只返回静态 MRO 会把运行时有效目标全部漏掉。
    push(this.lookupClass(enclosing, methodName), out);
    if (out.length === 0 && pass === 0) { jumpLog('debug', () => `py ①静态类 MRO 未命中(enclosing=${enclosing.name})`); }

    // ② 组合根(用户 2026-10-16:实体清单里每个实体、其字段对象、组件都是组合根,
    // 不止单一入口类):静态类被哪些组合根收录 → 在每一个组合根的 MRO 里找。
    // 每根先走精确 Python 类身份，再走当前资产项目的 .def 声明 mixin
    // (Parent → Interfaces → Components);多根/多处命中全部保留(上面 push 去重),
    // 由 provider 出 Location[] 列表,不替用户跳第一个。
    const rootsReady = await raceWithBudget('definition:composition-roots',
      this.ensureCompositionRoots().then(() => true), budgetMs, token);
    if (!rootsReady) {
      // 组合根派生超预算:已命中的 ① 静态 MRO 目标必须照常返回,不能因等待
      // 超时把有效目标也一起丢弃(否则 self 跳转在冷/慢资产上整条落空)。
      // 组合根侧本次不补;下次查询时派生结果已就绪/继续等待,自然补齐。
      if (out.length > 0) {
        jumpLog('info', () =>
          `py 组合根等待超时(${budgetMs}ms),先返回已命中 ${out.length} 个静态目标 ${queryTimer()}ms`);
      } else {
        jumpLog('info', () => `py 组合根等待超时(${budgetMs}ms),无静态目标,返回空集(partial) ${queryTimer()}ms`);
      }
      // IDE-IDX-018:②③ 未查全,结果必须标记 partial——消费端不得把这枚
      // 空集/静态子集发布成完整枚举的权威负结论。
      return { candidates: out, partial: true };
    }
    const scope = [...this.rootsByScope.keys()].filter(root => filePath.startsWith(root + path.sep))
      .sort((left, right) => right.length - left.length)[0];
    const composition = scope ? this.rootsByScope.get(scope) : undefined;
    const rootNames = composition?.roots ?? [];
    for (const root of rootNames) {
      if (token?.isCancellationRequested) { return { candidates: [], partial: true }; }
      const roots = (this.byName.get(root) ?? []).filter(cls => this.compatibleContext(cls, enclosing));
      for (const rootClass of roots) {
        const contains = this.mroClasses(rootClass).some(cls => this.classKey(cls) === this.classKey(enclosing));
        const declared = composition?.defMixins.get(root) ?? [];
        // PR5:比较用稳定 classKey 而非对象引用——staging/后台扫描可能重解析
        // 查询文件,旧引用与重新入索引的类对象不再是同一实例。
        const declaredEnclosing = declared.some(name => {
          const resolved = this.resolveSymbol(rootClass.filePath, name);
          return !!resolved && this.classKey(resolved) === this.classKey(enclosing);
        });
        if (!contains && !declaredEnclosing) { continue; }
        const implementation = this.lookupClass(rootClass, methodName);
        if (implementation) { push({ ...implementation, compositionRoot: root }, out); }
        else {
          for (const name of declared) {
            const mixin = this.resolveSymbol(rootClass.filePath, name);
            if (mixin) {
              const hit = this.lookupClass(mixin, methodName);
              if (hit) { push({ ...hit, compositionRoot: root }, out); }
            }
          }
        }
      }
    }
    if (out.length > 0 || pass === 1) { break; }
    // ①② 均落空:等后台全量收敛后重查一遍(失败/慢扫描在 ensureScanned 内部消化)
    const scanReady = await raceWithBudget('definition:python-index',
      this.ensureScanned().then(() => true), budgetMs, token);
    // 全量扫描超预算:①② 首查空且二遍查询未及执行——枚举不完整,同样标 partial。
    if (!scanReady) { return { candidates: [], partial: true }; }
    }
    if (out.length > 0) { return { candidates: out, partial: false }; }

    // Reverse lookup uses exact class identities as well, so unrelated same-name
    // classes in another role/package cannot become sibling mixin providers.
    const descendants: Array<{ order: number; sub: PythonClassDef }> = [];
    for (const defs of this.byName.values()) {
      if (token?.isCancellationRequested) { return { candidates: [], partial: true }; }
      for (const sub of defs) {
        if (!this.compatibleContext(sub, enclosing)) { continue; }
        if (this.mroClasses(sub).some(cls => this.classKey(cls) === this.classKey(enclosing))) {
          descendants.push({ order: this.fileOrder.get(sub.filePath) ?? Number.MAX_SAFE_INTEGER, sub });
        }
      }
    }
    // 候选顺序按文件发现序定死:分块 Promise.all 并发装载的完成序随 IO 时序
    // 翻动(并发完成序 ≠ 发现序),不排序的话同两候选仅顺序翻(CI 40470720225
    // 红例)。稳定排序:同文件多后代保持索引出现序;未见序号的排最后。
    descendants.sort((left, right) => left.order - right.order);
    for (const { sub } of descendants) {
      push(this.lookupClass(sub, methodName), out);
    }
    if (out.length > 0) {
      jumpLog('info', () =>
        `py 命中(③反向后代) ${out[0].className} → ${path.basename(out[0].filePath)}:${out[0].line + 1} ${queryTimer()}ms`
      );
    } else {
      jumpLog('info', () => `py 落空: 静态类/组合根/反向后代均无 ${methodName}(${queryTimer()}ms)`);
    }
    return { candidates: out, partial: false };
  }

  /** 兼容入口:仅候选数组(测试/旧调用面);需要 partial 状态用 resolveSelfMethodResolution */
  async resolveSelfMethodCandidates(
    filePath: string,
    line: number,
    methodName: string,
    document?: vscode.TextDocument,
    token?: vscode.CancellationToken,
    budgetMs: number = INTERACTIVE_INDEX_WAIT_MS
  ): Promise<PythonMethodLocation[]> {
    const { candidates } = await this.resolveSelfMethodResolution(
      filePath, line, methodName, document, token, budgetMs);
    return candidates;
  }

  /** 兼容入口:首个候选(唯一实现场景即唯一解) */
  async resolveSelfMethod(
    filePath: string,
    line: number,
    methodName: string
  ): Promise<PythonMethodLocation | null> {
    const candidates = await this.resolveSelfMethodCandidates(filePath, line, methodName);
    return candidates.length > 0 ? candidates[0] : null;
  }

  /** 某类「由哪些基类/mixin 提供」(CodeLens 用):MRO 去掉自身 */
  async mixinsProvidingTo(className: string): Promise<string[]> {
    const mro = await this.computeMRO(className);
    return mro.filter(name => name !== className);
  }

  /** 某方法名在 MRO 中由哪些类提供(CodeLens/多实现用) */
  async providersOfMethod(className: string, methodName: string): Promise<PythonMethodLocation[]> {
    await this.ensureScanned();
    const out: PythonMethodLocation[] = [];
    for (const definition of this.byName.get(className) ?? []) {
      const chain = this.mroClasses(definition);
      for (const cls of chain) {
        const loc = cls.methods.get(methodName);
        if (loc) { out.push({ ...loc, filePath: cls.filePath, className: cls.name, mro: chain.map(item => item.name) }); }
      }
    }
    return out;
  }
}

/** 工作区根下相对化显示(测试与日志用) */
export function displayPath(filePath: string): string {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (folder && filePath.startsWith(folder)) {
    return path.relative(folder, filePath).replace(/\\/g, '/');
  }
  return filePath;
}
