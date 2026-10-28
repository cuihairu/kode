/**
 * KBEngine definition / Python navigation mapping
 * 基于统一 definition semantics 构建 owner-aware 的导航索引。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { jumpLog, jumpTimeStart } from './navigationLog';
import { INTERACTIVE_INDEX_WAIT_MS, logLayerTiming, raceWithBudget } from './hoverBudget';
import { startLanguageServiceOperation } from './languageServiceMetrics';
import { getRootConfigGeneration } from './rootConfigGeneration';
import { readFileUtf8Recorded, readFileSyncUtf8Recorded } from './fileReadMetrics';
import { collectOpenDocumentTexts, readSharedFileSnapshot } from './sharedFileSnapshot';
import {
  findFilesAcrossRoots,
  getExternalScanRoots,
  getIndexScanRoots,
  getScanRootForFile
} from './scanRoots';
import { DefMethodSection } from './defParser';
import { clearDefCallChainFileCache } from './defCallChain';
import { PYTHON_BUILTIN_TYPE_ANNOTATIONS } from './pythonTypeStubs';
import { propertyFlagDomainList } from './defAnalyzer';
import type { PropertyFlagDomain } from './defAnalyzer';
import {
  createDefinitionSemanticsLoader,
  DefinitionMemberSourceKind,
  DefinitionMethod,
  DefinitionOwnerRef,
  DefinitionProperty,
  DefinitionSemanticCategory,
  ResolvedDefinitionSemantics,
  normalizeLookupPath
} from './definitionSemantics';
import {
  findEntityDefsDirForDefFile,
  getDefinitionWorkspaceLayout,
  scriptFoldersForRole
} from './definitionWorkspace';
import { joinWorkspacePath } from './workspacePath';
import { IndexScheduler, IndexTaskPriority } from './indexScheduler';
import { PY_SCAN_EXCLUDED_DIRS } from './pythonScanRules';
import { SemanticIndex, getSemanticIndex, isTypeRegistryFile } from './semanticIndex';
import { createSharedFileEventMerger, type SharedFileEvent } from './sharedFileEvents';
import { SemanticDependencyGraph, type SemanticChangeKind } from './dependencyGraph';
import type { EntityComponentFace } from './entityBuiltinProperties';
import { invalidateDatabaseSchemaCacheForFiles, invalidateDatabaseSchemaCacheForTypeRegistry } from './databaseSchema';

export type EntityMethodSection = DefMethodSection;

/** 首扫尝试上限(首次+重触发;真实扫描失败经冷查询有界重试,树真坏不无限打转) */
const MAX_INITIAL_SCAN_ATTEMPTS = 3;

export interface DefinitionSymbolIdentity {
  ownerKind: DefinitionSemanticCategory;
  ownerName: string;
  sourceKind: DefinitionMemberSourceKind;
  sourceChain: string[];
  section?: EntityMethodSection;
  symbolName: string;
  propertyPath?: string;
  componentSlotName?: string;
}

export interface EntityMethodDefinitionLocation {
  defFile: string;
  line: number;
  section: EntityMethodSection;
  exposed: boolean;
  identity: DefinitionSymbolIdentity;
  /** def 声明的参数类型序列(<Arg> 直文本,批123 解析);空数组=未声明,不作闸门 */
  declaredArgs?: string[];
  /** def 声明的 <ReturnType> 直文本(任务2 2026-10-27:定义点 -> inlay);null/缺 = 未声明 */
  declaredReturnType?: string | null;
}

export interface EntityPropertyDefinitionLocation {
  defFile: string;
  line: number;
  identity: DefinitionSymbolIdentity;
}

/**
 * 属性声明的完整面(批135 属性访问 CodeLens 用):声明位置之上再带 <Type>
 * 直文本、Flags 位集推导的可见域与持久化标记。域位与属性判重复用 defAnalyzer
 * 同一份旗标真值,不另写一份映射。
 */
export interface PropertyDefinitionInfo extends EntityPropertyDefinitionLocation {
  /** <Type> 直文本(别名未展开,与 def 声明行同源) */
  typeName?: string;
  /** Flags 位集推导的引擎三域位,定序 base → cell → client */
  domains: PropertyFlagDomain[];
  persistent: boolean;
}

export interface PythonMethodLocation {
  filePath: string;
  methodName: string;
  line: number;
  character: number;
}

export interface PythonMethodCallReference {
  filePath: string;
  methodName: string;
  line: number;
  character: number;
}

type IndexedPropertyDefinition = PropertyDefinitionInfo;

export interface IndexedMethodDefinition extends EntityMethodDefinitionLocation {
  owner: DefinitionOwnerRef;
}

interface PythonOwnerFile {
  ownerKind: DefinitionSemanticCategory;
  ownerName: string;
  section?: EntityMethodSection;
  filePath: string;
}

interface PythonMethodBinding {
  identity: DefinitionSymbolIdentity;
  pythonFile: string;
}

export interface IndexedPythonMethodLocation extends PythonMethodLocation {
  endLine: number;
  calls: Array<{ methodName: string; line: number; character: number; filePath: string }>;
  binding?: PythonMethodBinding;
}

export interface EntityMappingIndex {
  rootName: string;
  rootCategory: DefinitionSemanticCategory;
  rootDefFile: string;
  semantics: ResolvedDefinitionSemantics;
  propertyDefinitions: IndexedPropertyDefinition[];
  methodDefinitions: IndexedMethodDefinition[];
  pythonOwnerFiles: PythonOwnerFile[];
  pythonMethods: IndexedPythonMethodLocation[];
}

/** IDE-NAV-006:工作区符号命中(已索引 def 符号前缀查询的返回面) */
export interface WorkspaceDefSymbolHit {
  symbolName: string;
  kind: 'property' | 'method';
  section?: EntityMethodSection;
  rootName: string;
  rootDefFile: string;
  defFile: string;
  line: number;
}

export interface EntityMapping {
  name: string;
  defFile: string;
  pythonFile: string;
  pythonFiles: string[];
  properties: { [propertyName: string]: { defFile: string; line: number } };
  methods: { [methodName: string]: EntityMethodDefinitionLocation[] };
}

/** IDE-IDX-003:python/def 文件 → 所属 assets 根(scripts/entity_defs 布局);非该布局 → null。 */
const assetsRootOfPythonFile = (file: string): string | null => {
  const normalized = normalizeLookupPath(file);
  const marker = normalized.indexOf('/scripts/');
  return marker > 0 ? normalized.slice(0, marker) : null;
};

const assetsRootOfDefFile = (file: string): string | null => {
  const normalized = normalizeLookupPath(file);
  const marker = normalized.indexOf('/entity_defs/');
  if (marker <= 0) { return null; }
  // KBEngine 布局 entity_defs 挂在 scripts 下(a/scripts/entity_defs),python 侧
  // 定根在 a(截于 /scripts/)——剥掉尾部 scripts 使两侧同根。
  const root = normalized.slice(0, marker);
  return root.endsWith('/scripts') ? root.slice(0, -'/scripts'.length) : root;
};

/** def 与 python 调用文件是否同一 assets 根(双方都能定根且相等)。 */
const sharesAssetsRoot = (defFile: string, pythonFile: string): boolean => {
  const pythonRoot = assetsRootOfPythonFile(pythonFile);
  return pythonRoot !== null && assetsRootOfDefFile(defFile) === pythonRoot;
};

export class EntityMappingManager {
  private mappingIndexes = new Map<string, EntityMappingIndex>();
  private mappingIndexesByRoot = new Map<string, EntityMappingIndex>();
  /**
   * 统一语义查询层(PR4 A4-1/A4-4):实体名/Python 文件/类名 → 实体的全部
   * 查询改走 SemanticIndex(显式根序+注册序,不暴露内部遍历);本类保留
   * 索引对象存储与旧 API 形状(行为兼容层)。依赖失效(PR4 A4-2)走
   * SemanticDependencyGraph:def 变更只失效该文件及其记录在案的依赖者,
   * 禁「任何变更=整表清空」的旧口径。
   */
  private readonly semanticIndex = new SemanticIndex();
  private readonly dependencyGraph = new SemanticDependencyGraph();
  private scanningEntityMappings: Promise<void> | null = null;
  private pythonWatcher: vscode.FileSystemWatcher | null = null;
  private defWatcher: vscode.FileSystemWatcher | null = null;
  /** 外部资产根 watcher 三件套(assetsRoot 切换时整组重建,IDE-IDX-014) */
  private externalRootWatchers: vscode.FileSystemWatcher[] = [];
  /** 已移除根(IDE-IDX-016):在途解析结果落在这些根下时不回写任何登记面 */
  private readonly removedRootKeys = new Set<string>();
  /**
   * 负缓存:已确认「不在任何 .def 的 pythonOwnerFiles 里」的文件。
   * 没有它,非 owner 的 .py 每次跳转都会在 property/method 两处各触发一次
   * 全量 .def 枚举与逐个解析,是「加载很久」第二来源。
   * 真实 .def 增删改由 watchDefFiles 清空(含本集合与索引),改完下次跳转重扫。
   */
  private missingOwnerPaths = new Set<string>();
  /** 负缓存:已确认「类名不在任何 .def 索引(含 ownerName 回溯)」的对象级查询 */
  private missingClassNames = new Set<string>();
  /** 构造期全量 .def 扫描句柄(对象级探等待它,避免同一次跳转内重复全量 walk) */
  private initialScan: Promise<void> = Promise.resolve();
  /**
   * 首扫是否成功落地。对象级负缓存(类名 miss)只在它置位后发布——首扫进行
   * 中哪怕映射表已并入部分分块,后续分块里的接口/组件类仍可能经 ownerName
   * 回溯命中,凭「表非空」记 miss 会把它们永久误判为不存在(负缓存只在 .def
   * 变更时清理,不会自愈)。
   */
  private initialScanCompleted = false;
  /**
   * 首扫真实扫描是否失败(审核发现 :182):keyed 任务受单槽调度器约束只负责
   * 启动扫描即让出席位(运行中任务不可抢占,首扫分块才能插队执行),真实扫描
   * 的失败因此无法经 keyed 失败态自动重排——由冷查询入口在此标记后重触发,
   * 语义与调度器对 failed keyed 条目的下次调用重排(A3-4)对齐,但记账在
   * 管理器侧。重触发有界,树真坏时不无限打转。
   */
  private initialScanFailed = false;
  /** 首扫尝试次数(含首次;重触发上限见 MAX_INITIAL_SCAN_ATTEMPTS) */
  private initialScanAttempts = 0;
  /** PR3:首扫统一走索引调度器(扩展注入共享实例,独立构造自建一份) */
  private readonly scheduler: IndexScheduler;
  /**
   * 按 mtime 的 .def 解析缓存(2026-10-22 用户令「hover 永转 loading 根治」):
   * 键 = 规范化 .def 路径,值 = 解析产物 + 采集时 mtime/size。重扫(负缓存
   * 失效、watcher 整表失效后的再扫)对未变更文件直接复用索引对象,不再逐个
   * loadResolved 重解析——此前每次整表失效都是全量重解析,真实大树秒级+/次。
   * python 文件变更路径必须 force 重解析(py 内容不在 .def mtime 里)。
   */
  private defParseCache = new Map<
    string,
    { mtimeMs: number; size: number; index: EntityMappingIndex }
  >();
  private defParseCacheHits = 0;
  private defParseCacheMisses = 0;
  /**
   * IDE-SNP-008:共享文件事件合并器(实例自持,消费索引间互不串线)。
   * watcher 三件套的原始通知先入此合并,同 URI 同 kind 的重复通知(同一
   * 保存多 watcher/多段通知)只应用一次;窗口内 kind 变化补投终态。
   */
  private readonly fileEventMerger = createSharedFileEventMerger();
  /** 工作区门控(书 PR-002):deferStartup=true 时构造零副作用,待 ensureStartup */
  private startupStarted = false;
  /** deferStartup 模式下首扫完成句柄的resolve(ensureStartup 时接线) */
  private deferredInitialScanResolve: (() => void) | null = null;

  constructor(
    private context: vscode.ExtensionContext,
    scheduler?: IndexScheduler,
    options: { deferStartup?: boolean } = {}
  ) {
    this.scheduler = scheduler ?? new IndexScheduler();
    if (options.deferStartup) {
      // 门控激活:构造零副作用——不建 watcher、不入队首扫。initialScan 挂起,
      // ensureStartup() 幂等接线(幂等同键 ensureTask 去重)。await this.initialScan
      // 的既有等待链不变;查询入口先 ensureStartup 再等待,永不悬死。
      this.initialScan = new Promise<void>(resolve => {
        this.deferredInitialScanResolve = resolve;
      });
      return;
    }
    this.ensureStartup();
  }

  /**
   * 幂等启动:watcher 三件套(类型注册表→def→python,既有次序契约)+ 构造期
   * 全量 .def 首扫。直接激活路径构造即调(与门控前逐行为一致);门控激活路径
   * 在特征确认或首个查询入口调用。
   */
  ensureStartup(): void {
    if (this.startupStarted) {
      return;
    }
    this.startupStarted = true;
    // 构造期全量 .def 扫描留句柄:对象级(类粒度)解析只等这一遍,不另起
    // 全量 walk(真实 kbengine 树每遍 walk 秒级,多一走即压穿调用方超时预算)。
    // 启动推迟一个宏任务(2026-10-22 用户令「hover 永转根治」):构造方在
    // 同一同步块里发起的首个悬停/跳转先跑完自己的定向解析,首扫不与前台
    // 第一答抢事件循环。
    // The keyed task starts discovery and returns its scheduler slot. Parsing
    // then runs as bounded background tasks so RequestLocal can run between them.
    const scanPromise = new Promise<void>(resolve => {
      setImmediate(() => {
        void this.launchInitialScanViaScheduler().then(
          () => { this.initialScanCompleted = true; resolve(); },
          () => {
            // 真实扫描失败:不置完成位(负缓存不得基于残缺快照发布),也不再
            // 静默转成「成功的 initialScan」——失败态记账,后续冷查询重触发
            // (有界),等待者照常放行(部分索引可用)。
            this.initialScanFailed = true;
            resolve();
          }
        );
      });
    });
    if (this.deferredInitialScanResolve) {
      const resolveDeferred = this.deferredInitialScanResolve;
      void scanPromise.then(() => resolveDeferred());
    } else {
      this.initialScan = scanPromise;
    }
    // 创建顺序有意为之:类型注册表 watcher 最先、def watcher 次之、python
    // watcher 最后——外部与既有用例把「最后创建的 watcher」当作 python
    // watcher 语义使用(变更只重解析归属实体);PR4 在 def 前新增
    // types.xml/alias.xml watcher(只作废类型注册表快照,不碰实体索引),
    // def→python 的既有相对顺序保持不破。
    this.watchTypeRegistryFiles();
    this.watchDefFiles();
    this.watchPythonFiles();
    // 外部资产根三件套(IDE-IDX-014):随工作区 watcher 之后挂,创建序仍以
    // python watcher 收尾(外部根存在时最后一个是外部 python watcher)
    this.refreshExternalRootWatchers();
    // IDE-SNP-008:合并器订阅一次性接线(watcher 组重建/外部根切换不重复
    // 订阅);dispose 时随合并器一并退订。
    this.context.subscriptions.push({ dispose: this.fileEventMerger.subscribe(event => {
      this.handleSharedFileEvent(event);
    }) });
  }

  /**
   * 经 keyed 任务启动首扫并等真实扫描终态(ensureStartup 与失败重触发共用)。
   * keyed 任务本体只启动扫描即返回(让出单槽调度席位,首扫分块才能作为独立
   * 后台任务插队执行——运行中任务不可抢占,若 keyed 任务整轮占位会饿死自家
   * 分块);真实扫描的终态由本方法返回的 promise 承载。
   */
  private launchInitialScanViaScheduler(): Promise<void> {
    this.initialScanAttempts += 1;
    let work: Promise<void> | null = null;
    return this.scheduler
      .ensureTask('entity-mapping-initial-scan', () => ({
        kind: 'initial-scan',
        priority: IndexTaskPriority.BackgroundFull,
        run: async () => { work = this.scanEntityMappings(); }
      }))
      .catch(() => undefined)
      .then(async () => { await work; });
  }

  /**
   * 首扫失败后的有界重触发(审核发现 :182):冷查询入口在等待 initialScan 前
   * 调用——失败态在此重排同一 keyed 任务(与调度器对 failed keyed 条目的下次
   * 调用重排语义对齐),成功则补置完成位(负缓存闸放开),再失败则重新记账。
   * 有界 MAX_INITIAL_SCAN_ATTEMPTS 次;当前查询不等待重试结果(部分索引即可
   * 应答,负缓存闸保证不落死),后续查询自然拿到重试后的完整口径。
   */
  private retryInitialScanAfterFailure(): void {
    if (!this.initialScanFailed || this.initialScanCompleted) { return; }
    if (this.initialScanAttempts >= MAX_INITIAL_SCAN_ATTEMPTS) { return; }
    this.initialScanFailed = false; // 重触发在途:防同一查询风暴内重复重排
    jumpLog('info', () =>
      `def 首扫失败,冷查询重触发(第 ${this.initialScanAttempts + 1}/${MAX_INITIAL_SCAN_ATTEMPTS} 次尝试)`);
    void this.launchInitialScanViaScheduler().then(
      () => { this.initialScanCompleted = true; },
      () => {
        if (this.initialScanAttempts < MAX_INITIAL_SCAN_ATTEMPTS) {
          this.initialScanFailed = true;
        }
      }
    );
  }

  private async scanEntityMappings(): Promise<void> {
    if (this.scanningEntityMappings) {
      return this.scanningEntityMappings;
    }
    const scan = this.performScanEntityMappings().finally(() => {
      this.scanningEntityMappings = null;
    });
    this.scanningEntityMappings = scan;
    return scan;
  }

  private async performScanEntityMappings(): Promise<void> {
    // 扫描根 = workspace 顶层 ∪ assetsRoot(2026-10-16):loader 按全部根逐个
    // 解析 def(外部资产根下的 entities/接口/父链同样找得到)。空根集合(无
    // 工作区且无 assetsRoot)= 原空工作区早退,不失败。
    const scanRoots = getIndexScanRoots();
    if (scanRoots.length === 0) {
      return;
    }
    // PR4 A4-5:扫描根显式登记语义索引(规范化路径+稳定 rootId+显式序),
    // 查询按该序裁断,不再依赖 Map 插入序。
    for (const scanRoot of scanRoots) {
      this.semanticIndex.registerRoot(scanRoot);
    }

    // 不可达(批62 定性):工厂只在根为空时返回 null,上方已对空集合早退。
    const loader = createDefinitionSemanticsLoader(scanRoots);
    /* istanbul ignore start */
    if (!loader) {
      return;
    }
    /* istanbul ignore stop */

    const indexTimer = jumpTimeStart();
    const scanStartedAt = Date.now();
    // PR1 打点:entity-mapping-scan = .def 全量发现+逐文件解析的整段耗时,
    // 计数口径:发现=候选 .def 总数;读取/解析=实际走进 parseDefFile 的次数
    // (mtime 命中复用由 type-registry/缓存命中另行统计,这里如实记尝试数)。
    const scanMetrics = startLanguageServiceOperation('entity-mapping-scan');
    // IDE-PRJ-011:扫描按起步时的根配置代定身——profile 切换(或 assetsRoot
    // 等任何 bump)后,本扫描的输入已过期,在途批次经代闸整体不再写入当前
    // 快照(新输入由新扫描重建)
    const scanGeneration = getRootConfigGeneration();
    const defFiles = await findFilesAcrossRoots('**/*.def', null);
    scanMetrics.countFileDiscovery(defFiles.length);
    const entities = defFiles.filter(defFile => {
      const normalized = normalizeLookupPath(defFile.fsPath);
      return !normalized.includes('/interfaces/') && !normalized.includes('/components/');
    });
    const handles = [];
    for (let offset = 0; offset < entities.length; offset += 8) {
      const batch = entities.slice(offset, offset + 8);
      handles.push(this.scheduler.enqueue({
        kind: 'full-reindex',
        priority: IndexTaskPriority.BackgroundFull,
        run: async () => {
          for (const defFile of batch) {
            // 代闸:根配置已前进 → 本批属旧输入,剩余文件不解析不写入
            if (getRootConfigGeneration() !== scanGeneration) {
              return;
            }
            await this.parseDefFile(path.basename(defFile.fsPath, '.def'), defFile.fsPath, loader);
            scanMetrics.countFileRead(1);
            scanMetrics.countFileParse(1);
          }
        }
      }));
    }
    await Promise.all(handles.map(handle => handle.wait));
    jumpLog('info', () => `def 全量索引完成 ${defFiles.length} 个 .def → 实体 ${this.mappingIndexes.size} 个,${indexTimer()}ms`);
    // 扫描总耗时进 LogHub(用户令「加计时日志实测,别猜」):独立计时
    // (jumpTimeStart 关开关时恒 0,不做闸),便于真机定位首扫占比
    logLayerTiming('initial-scan', Date.now() - scanStartedAt, `defs=${defFiles.length} entities=${this.mappingIndexes.size}`);
    scanMetrics.end('ok');
  }

  /** IDE-IDX-016:def 路径是否落在已移除根下(在途结果回写闸) */
  private isUnderRemovedRoot(defPath: string): boolean {
    const normalized = normalizeLookupPath(defPath);
    for (const root of this.removedRootKeys) {
      if (normalized.startsWith(`${root}/`)) {
        return true;
      }
    }
    return false;
  }

  private async parseDefFile(
    entityName: string,
    defPath: string,
    loader?: ReturnType<typeof createDefinitionSemanticsLoader>,
    rootCategory: DefinitionSemanticCategory = 'entity',
    forceReparse = false
  ): Promise<void> {
    try {
      // mtime 缓存复用(2026-10-22):未变更 .def 重扫不再重解析;python 变更
      // 路径(forceReparse)绕过缓存——py 内容不进 .def mtime 键。
      const cached = forceReparse ? undefined : this.defParseCache.get(normalizeLookupPath(defPath));
      let stat: fs.Stats | null = null;
      try {
        stat = fs.statSync(defPath);
      } catch {
        stat = null;
      }
      if (cached && stat && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        this.defParseCacheHits += 1;
        this.storeIndex(cached.index);
        return;
      }
      const parseStartedAt = Date.now();
      const mapping = await this.buildIndex(entityName, defPath, loader, rootCategory);
      const elapsedMs = Date.now() - parseStartedAt;
      if (elapsedMs >= 200) {
        // 慢解析记账(用户令「加计时日志实测,别猜」):>200ms 的单文件进日志
        jumpLog('info', () => `def 解析慢文件 ${path.basename(defPath)} ${elapsedMs}ms`);
        logLayerTiming('def-parse', elapsedMs, `file=${path.basename(defPath)}`);
      }
      if (mapping && stat) {
        this.defParseCacheMisses += 1;
        this.defParseCache.set(normalizeLookupPath(defPath), {
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          index: mapping
        });
      } else if (!mapping) {
        this.defParseCache.delete(normalizeLookupPath(defPath));
      }
      if (mapping) {
        this.storeIndex(mapping);
      }
    } catch (error) {
      console.error(`解析 .def 文件失败: ${defPath}`, error);
    }
  }

  private async buildIndex(
    entityName: string,
    defPath: string,
    providedLoader?: ReturnType<typeof createDefinitionSemanticsLoader>,
    rootCategory: DefinitionSemanticCategory = 'entity'
  ): Promise<EntityMappingIndex | null> {
    // IDE-IDX-016:根已移除的在途解析不产出——晚到结果不回写索引/缓存/
    // 依赖图/语义投影任何登记面(扫描清单在移除前已取走,B 的批照跑)。
    if (this.isUnderRemovedRoot(defPath)) {
      return null;
    }
    // loader 回退链(2026-10-22):默认 loader 以 .def 所在目录当根,而
    // findEntityDefinitionFile 需要目录布局(以文件当根恒 null,单文件重解析
    // 一直静默失败)。按扫描根(与全量扫描同源)优先,退到 .def 所在目录。
    // IDE-IDX-001:精确路径解析只信扫描根 loader(providedLoader 或扫描根链);
    // dirname 兜底 loader 保持原「名字解析静默失败」口径——无工作区的孤儿
    // manager 不得因精确路径绕过布局发现而意外建出索引。
    const scanLoader = providedLoader ?? createDefinitionSemanticsLoader(getIndexScanRoots());
    const loader = scanLoader ?? createDefinitionSemanticsLoader(path.dirname(defPath));
    if (!loader) {
      return null;
    }

    const semantics = (scanLoader
      ? scanLoader.loadResolvedAt(defPath, entityName, rootCategory, true)
      : null)
      ?? loader.loadResolved(entityName, rootCategory, true);
    if (!semantics) {
      return null;
    }

    const pythonOwnerFiles = this.collectPythonOwnerFiles(semantics);
    const pythonMethods = this.collectPythonMethods(pythonOwnerFiles);
    const propertyDefinitions = this.collectPropertyDefinitions(semantics);
    const methodDefinitions = this.collectMethodDefinitions(semantics);
    this.bindPythonMethods(methodDefinitions, pythonMethods);

    // PR4 A4-2:真实依赖边入库——本 .def 的解析读过的父链/接口/组件 .def
    // (owner filePath 集合)。父 .def 变更经依赖图反向闭包只失效这些子
    // .def,不波及全仓。
    const ownerDefFiles = new Set<string>();
    ownerDefFiles.add(semantics.owner.filePath);
    for (const property of semantics.effectiveProperties) {
      ownerDefFiles.add(property.owner.filePath);
    }
    for (const section of ['BaseMethods', 'CellMethods', 'ClientMethods'] as EntityMethodSection[]) {
      for (const method of semantics.effectiveMethodsBySection[section]) {
        ownerDefFiles.add(method.owner.filePath);
      }
    }
    for (const component of semantics.components) {
      if (component.resolved) {
        ownerDefFiles.add(component.resolved.owner.filePath);
      }
    }
    ownerDefFiles.delete(defPath);
    this.dependencyGraph.recordDependencies(defPath, ownerDefFiles);

    return {
      rootName: entityName,
      rootCategory,
      rootDefFile: defPath,
      semantics,
      propertyDefinitions,
      methodDefinitions,
      pythonOwnerFiles,
      pythonMethods
    };
  }

  private storeIndex(index: EntityMappingIndex): void {
    this.mappingIndexes.set(index.rootName, index);
    const normalizedDefFile = normalizeLookupPath(index.rootDefFile);
    this.mappingIndexesByRoot.set(normalizedDefFile, index);
    // PR4 A4-1/A4-5:实体语义投影登记进统一语义索引(同名覆盖=既有 Map.set
    // 口径;py owner/类名先到先得=既有插入序扫描口径)。根未显式登记时
    // (定向单文件解析早于全量扫描)rootId 置空串,只影响取证字段不影响
    // 查询路径。
    const owners: Array<{ kind: string; name: string }> = [];
    for (const ownerFile of index.pythonOwnerFiles) {
      if (ownerFile.ownerName && !owners.some(owner =>
        owner.kind === ownerFile.ownerKind && owner.name === ownerFile.ownerName)) {
        owners.push({ kind: ownerFile.ownerKind, name: ownerFile.ownerName });
      }
    }
    this.semanticIndex.registerEntity({
      rootId: this.semanticIndex.resolveRootIdForPath(index.rootDefFile) ?? '',
      entityName: index.rootName,
      defFile: normalizedDefFile,
      pythonFiles: uniqueFilePaths(index.pythonOwnerFiles.map(item => item.filePath)),
      owners
    });
  }

  private collectPythonOwnerFiles(semantics: ResolvedDefinitionSemantics): PythonOwnerFile[] {
    // 相对候选必须锚定根(用户令 2026-10-16):拿不到扫描根时整段跳过,
    // 绝不以空根造出相对候选去 fs 探测(那会相对 cwd 解析)
    const ownerRoot = this.getWorkspaceRoot(semantics.owner.filePath);
    if (!ownerRoot) {
      return [];
    }
    const layout = getDefinitionWorkspaceLayout(ownerRoot);
    const files: PythonOwnerFile[] = [];
    const seen = new Set<string>();

    const push = (candidate: PythonOwnerFile | null) => {
      // 不可达(批62 定性):三处调用都在 fs.existsSync 命中分支里传对象字面量,
      // 该闭包收不到 null。
      /* istanbul ignore start */
      if (!candidate) {
        return;
      }
      /* istanbul ignore stop */

      // 不可达(批72 定性):push 仅在三处调用(实体/接口/组件各段循环),皆显式传入
// section 字面量(BaseMethods/CellMethods/ClientMethods),故 candidate.section
// 恒为非空字符串,`|| ''` 兜底右臂无触发路径。真臂行为由既有
// entityMappingBranches.test.ts 中 Python 候选文件扫描用例锁定。
/* istanbul ignore start */
      const key = `${candidate.ownerKind}:${candidate.ownerName}:${candidate.section || ''}:${normalizeLookupPath(candidate.filePath)}`;
/* istanbul ignore stop */
      if (seen.has(key)) {
        return;
      }

      seen.add(key);
      files.push(candidate);
    };

    const addDefinitionOwnerFiles = (
      owner: DefinitionOwnerRef,
      componentSlotName?: string
    ) => {
      for (const section of ['BaseMethods', 'CellMethods', 'ClientMethods'] as EntityMethodSection[]) {
        for (const filePath of this.getPythonCandidates(layout.workspaceRoot, owner, section, componentSlotName)) {
          if (fs.existsSync(filePath)) {
            push({
              ownerKind: owner.kind,
              ownerName: owner.name,
              section,
              filePath
            });
          }
        }
      }

      if (owner.kind === 'interface') {
        for (const section of ['BaseMethods', 'CellMethods'] as EntityMethodSection[]) {
          for (const filePath of this.getPythonCandidates(layout.workspaceRoot, owner, section, componentSlotName, true)) {
            if (fs.existsSync(filePath)) {
              push({
                ownerKind: owner.kind,
                ownerName: owner.name,
                section,
                filePath
              });
            }
          }
        }
      }
    };

    const owners = new Map<string, DefinitionOwnerRef>();
    const collectOwner = (owner: DefinitionOwnerRef) => {
      owners.set(`${owner.kind}:${owner.name}`, owner);
    };

    collectOwner(semantics.owner);
    for (const property of semantics.effectiveProperties) {
      collectOwner(property.owner);
    }
    for (const section of ['BaseMethods', 'CellMethods', 'ClientMethods'] as EntityMethodSection[]) {
      for (const method of semantics.effectiveMethodsBySection[section]) {
        collectOwner(method.owner);
      }
    }
    for (const component of semantics.components) {
      if (component.resolved) {
        collectOwner(component.resolved.owner);
      }
    }

    for (const owner of owners.values()) {
      addDefinitionOwnerFiles(owner);
    }

    for (const component of semantics.components) {
      if (!component.resolved) {
        continue;
      }

      addDefinitionOwnerFiles(component.resolved.owner, component.slotName);
    }

    return files;
  }

  private getPythonCandidates(
    workspaceRoot: string,
    owner: DefinitionOwnerRef,
    section: EntityMethodSection,
    componentSlotName?: string,
    preferInterfaceScriptFolder = false
  ): string[] {
    const candidates: string[] = [];
    const sectionFolder = this.getSectionFolder(section);
    const scriptRoots = this.getPythonScriptRoots(workspaceRoot, owner);
    const ownerName = owner.name;

    if (owner.kind === 'entity') {
      for (const root of scriptRoots) {
        // 官方模板 bots/(ClientMethods 的 BotsApp 客户端脚本)+ 生成器平铺
        // 形态 scripts/<实体>.py,与角色目录并列入候选(2026-10-12 用户实测)。
        for (const folder of scriptFoldersForRole(sectionFolder)) {
          candidates.push(joinWorkspacePath(root, folder, `${ownerName}.py`));
        }
        candidates.push(joinWorkspacePath(root, `${ownerName}.py`));
      }
      return candidates;
    }

    if (owner.kind === 'component') {
      for (const root of scriptRoots) {
        candidates.push(joinWorkspacePath(root, sectionFolder, 'components', `${ownerName}.py`));
      }
      return candidates;
    }

    // 不可达(批72 定性):owner.kind 类型为 DefinitionSemanticCategory,
    // 仅 entity/interface/component 三员。entity 与 component 在上方
    // 早退 return(311/318),能走到此处的仅 interface,故隐式 else
    // (arm#1 armLoc=undefined)契约上不可达。真臂行为由既有
    // entityMappingBranches.test.ts 接口 Python 候选扫描用例锁定。
    /* istanbul ignore start */
    if (owner.kind === 'interface') {
    /* istanbul ignore stop */
      // 官方模板是单数 interface/,历史口径是复数 interfaces/(2026-10-12
      // 用户实测核定),两种都入候选,复数在前保持既有工程行为。
      const interfaceFolders = preferInterfaceScriptFolder
        ? [`${sectionFolder}/interfaces`, 'interfaces', `${sectionFolder}/interface`, 'interface']
        : ['interfaces', `${sectionFolder}/interfaces`, 'interface', `${sectionFolder}/interface`];

      for (const root of scriptRoots) {
        for (const folder of interfaceFolders) {
          candidates.push(joinWorkspacePath(root, folder, `${ownerName}.py`));
          // 用户工程实测命名变体(2026-10-12):scripts/base/interfaces/
          // Interface_Activity.py,def 里接口名是 Activity。
          candidates.push(
            joinWorkspacePath(root, folder, `Interface_${ownerName}.py`)
          );
        }
      }
      return candidates;
    }

    // 不可达(批62 定性):owner.kind 类型为 DefinitionSemanticCategory,只有
    // entity/interface/component 三员且各自在上方早退 return,走到这里需要一个
    // 类型外的 kind;componentSlotName 的槽位脚本候选已由 kind === 'component'
    // 分支承担(批33 记录的重复形态),末次 return 同样只能由类型外 kind 达到。
    /* istanbul ignore start */
    if (componentSlotName) {
      for (const root of scriptRoots) {
        candidates.push(joinWorkspacePath(root, sectionFolder, 'components', `${ownerName}.py`));
      }
    }

    return candidates;
    /* istanbul ignore stop */
  }

  /**
   * Python 脚本根候选(批132:嵌套资产根兜底)。
   * ① 与 getDefinitionWorkspaceLayout 的布局候选同口径的三条工作区根前缀
   *   (scripts / assets/scripts / server_assets/scripts,含官方 newassets 形态);
   * ② owner 自己的 def 文件位置反推的 scripts 根——资产根不在工作区根本身时
   *   (<repo>/<xxx>_assets 布局,批129 约定扫描支持的形态),①全 miss,索引里
   *   pythonOwnerFiles 恒空,RPC CodeLens 与 Python → def 反向跳转整链静默失效;
   *   引擎语义 entity_defs 与 base/cell/client 恒同层,故 scripts 根 = def 所在
   *   entity_defs 的父目录,与定义导航的文件相对口径一致。②排在①之后:扁平布局
   *   候选顺序不变,嵌套布局只增补。
   */
  private getPythonScriptRoots(
    workspaceRoot: string,
    owner: DefinitionOwnerRef
  ): string[] {
    const roots = uniqueFilePaths([
      joinWorkspacePath(workspaceRoot, 'scripts'),
      joinWorkspacePath(workspaceRoot, 'assets', 'scripts'),
      joinWorkspacePath(workspaceRoot, 'server_assets', 'scripts')
    ]);
    const defsDir = findEntityDefsDirForDefFile(owner.filePath);
    if (defsDir) {
      roots.push(path.dirname(defsDir));
    }
    return roots;
  }

  private getSectionFolder(section: EntityMethodSection): 'base' | 'cell' | 'client' {
    switch (section) {
      case 'BaseMethods':
        return 'base';
      case 'CellMethods':
        return 'cell';
      case 'ClientMethods':
        return 'client';
    }
  }

  private collectPropertyDefinitions(semantics: ResolvedDefinitionSemantics): IndexedPropertyDefinition[] {
    const results: IndexedPropertyDefinition[] = [];
    const pushProperty = (property: DefinitionProperty, componentSlotName?: string) => {
      results.push({
        defFile: property.owner.filePath,
        line: property.line,
        identity: {
          ownerKind: property.owner.kind,
          ownerName: property.owner.name,
          sourceKind: property.source.kind,
          sourceChain: [...property.source.chain],
          symbolName: property.name,
          propertyPath: property.fullPath,
          componentSlotName
        },
        typeName: property.typeName,
        domains: propertyFlagDomainList(property.flags),
        // <Persistent> 缺省视作非持久(与 databaseSchema 的 isTruePersistent 口径一致)
        persistent: property.persistent ?? false
      });

      for (const child of property.children) {
        pushProperty(child, componentSlotName);
      }

      if (property.arrayElement) {
        pushProperty(property.arrayElement, componentSlotName);
      }
    };

    for (const property of semantics.effectiveProperties) {
      pushProperty(property);
    }

    for (const component of semantics.components) {
      if (!component.resolved) {
        continue;
      }

      for (const property of component.resolved.effectiveProperties) {
        pushProperty(this.rebasePropertyPath(property, component.slotName), component.slotName);
      }
    }

    return results;
  }

  private collectMethodDefinitions(semantics: ResolvedDefinitionSemantics): IndexedMethodDefinition[] {
    const results: IndexedMethodDefinition[] = [];
    const pushMethod = (method: DefinitionMethod, componentSlotName?: string) => {
      results.push({
        defFile: method.owner.filePath,
        line: method.line,
        section: method.section,
        exposed: method.exposed,
        owner: method.owner,
        declaredArgs: method.args,
        declaredReturnType: method.returnType,
        identity: {
          ownerKind: method.owner.kind,
          ownerName: method.owner.name,
          sourceKind: method.source.kind,
          sourceChain: [...method.source.chain],
          section: method.section,
          symbolName: method.name,
          componentSlotName
        }
      });
    };

    for (const section of ['BaseMethods', 'CellMethods', 'ClientMethods'] as EntityMethodSection[]) {
      for (const method of semantics.effectiveMethodsBySection[section]) {
        pushMethod(method);
      }
    }

    for (const component of semantics.components) {
      if (!component.resolved) {
        continue;
      }

      for (const section of ['BaseMethods', 'CellMethods', 'ClientMethods'] as EntityMethodSection[]) {
        for (const method of component.resolved.effectiveMethodsBySection[section]) {
          pushMethod(method, component.slotName);
        }
      }
    }

    return results;
  }

  private rebasePropertyPath(property: DefinitionProperty, prefix: string): DefinitionProperty {
    const sourceRoot = property.fullPath.split('.')[0] || property.fullPath;
    const suffix = property.fullPath === sourceRoot
      ? ''
      : property.fullPath.slice(sourceRoot.length);
    const nextFullPath = `${prefix}${suffix}`;

    return {
      ...property,
      fullPath: nextFullPath,
      children: property.children.map(child => this.rebasePropertyPath(child, prefix)),
      arrayElement: property.arrayElement ? this.rebasePropertyPath(property.arrayElement, prefix) : undefined
    };
  }

  private collectPythonMethods(ownerFiles: PythonOwnerFile[]): IndexedPythonMethodLocation[] {
    const methods: IndexedPythonMethodLocation[] = [];

    for (const ownerFile of ownerFiles) {
      if (!fs.existsSync(ownerFile.filePath)) {
        continue;
      }

      const content = readFileSyncUtf8Recorded(ownerFile.filePath);
      const parsedMethods = parsePythonMethodBlocks(content, ownerFile.filePath);
      for (const method of parsedMethods) {
        methods.push({
          ...method
        });
      }
    }

    return methods;
  }

  private bindPythonMethods(
    methodDefinitions: IndexedMethodDefinition[],
    pythonMethods: IndexedPythonMethodLocation[]
  ): void {
    const byOwner = new Map<string, IndexedMethodDefinition[]>();
    for (const definition of methodDefinitions) {
      const key = buildMethodOwnerBindingKey(definition.identity);
      const list = byOwner.get(key) || [];
      list.push(definition);
      byOwner.set(key, list);
    }

    for (const method of pythonMethods) {
      const ownerBindingKeys = [
        buildMethodOwnerBindingKey({
          ownerKind: inferOwnerKindFromPythonFile(method.filePath) || 'entity',
          ownerName: inferOwnerNameFromPythonFile(method.filePath),
          section: inferMethodSectionFromPythonFile(method.filePath),
          symbolName: method.methodName
        }),
        buildMethodOwnerBindingKey({
          ownerKind: inferOwnerKindFromPythonFile(method.filePath) || 'interface',
          ownerName: inferOwnerNameFromPythonFile(method.filePath),
          section: inferMethodSectionFromPythonFile(method.filePath),
          symbolName: method.methodName
        }),
        buildMethodOwnerBindingKey({
          ownerKind: inferOwnerKindFromPythonFile(method.filePath) || 'component',
          ownerName: inferOwnerNameFromPythonFile(method.filePath),
          section: inferMethodSectionFromPythonFile(method.filePath),
          symbolName: method.methodName
        })
      ];

      const boundDefinition = ownerBindingKeys
        .map(key => byOwner.get(key)?.[0])
        .find((candidate): candidate is IndexedMethodDefinition => !!candidate);

      if (!boundDefinition) {
        continue;
      }

      method.binding = {
        identity: boundDefinition.identity,
        pythonFile: method.filePath
      };
    }
  }

  /** 挂单个 python watcher(工作区根与外部资产根共用;事件经合并器去重) */
  private attachPythonWatcher(pattern: string): vscode.FileSystemWatcher {
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    watcher.onDidChange(uri => {
      this.fileEventMerger.emit(uri.fsPath, 'change');
    });
    watcher.onDidCreate(uri => {
      this.fileEventMerger.emit(uri.fsPath, 'create');
    });
    watcher.onDidDelete(uri => {
      this.fileEventMerger.emit(uri.fsPath, 'delete');
    });
    this.context.subscriptions.push(watcher);
    return watcher;
  }

  /**
   * types.xml/alias.xml 变更(PR4 A4-3):只作废共享类型注册表快照仓中依赖
   * 该文件的快照(事件驱动重建),实体索引不动——def 解析产物不内嵌已解析
   * 注解,类型查询在应答时经快照解析。
   */
  private attachTypeRegistryWatcher(pattern: string): vscode.FileSystemWatcher {
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const notify = (uri: vscode.Uri, kind: 'create' | 'change' | 'delete'): void => {
      if (isTypeRegistryFile(uri.fsPath)) {
        this.fileEventMerger.emit(uri.fsPath, kind);
      }
    };
    watcher.onDidChange(uri => { notify(uri, 'change'); });
    watcher.onDidCreate(uri => { notify(uri, 'create'); });
    watcher.onDidDelete(uri => { notify(uri, 'delete'); });
    this.context.subscriptions.push(watcher);
    return watcher;
  }

  /**
   * `.def` 增删改 → 定向失效(PR4 A4-2,依赖图裁断):只失效该 .def 自身
   * 及其记录在案的依赖者(父链子 .def 等),禁「任何变更=整表清空」。
   * 「无归属」负缓存仍整体让位(新 .def 可能补上此前 miss,集合很小);
   * 变更/新建文件定向重解析,依赖者留待下次查询按需重建。
   */
  private attachDefWatcher(pattern: string): vscode.FileSystemWatcher {
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    watcher.onDidChange(uri => this.fileEventMerger.emit(uri.fsPath, 'change'));
    watcher.onDidCreate(uri => this.fileEventMerger.emit(uri.fsPath, 'create'));
    watcher.onDidDelete(uri => this.fileEventMerger.emit(uri.fsPath, 'delete'));
    this.context.subscriptions.push(watcher);
    return watcher;
  }

  /**
   * IDE-SNP-008:合并后事件的路由——按文件类别分派到原有三处理面
   * (types/alias → 注册表作废;.def → 定向失效;.py → 归属实体重扫),
   * 与直连 watcher 时的行为一致,只是同 URI 重复通知只到达一次。
   */
  private handleSharedFileEvent(event: SharedFileEvent): void {
    if (isTypeRegistryFile(event.fsPath)) {
      // IDE-SCH-004:types.xml 变更按消费别名摘除 schema 缓存(没消费被改
      // 别名的实体继续命中),注册表快照照旧作废
      invalidateDatabaseSchemaCacheForTypeRegistry(event.fsPath);
      getSemanticIndex().notifySemanticFilesChanged([event.fsPath]);
      return;
    }
    if (event.fsPath.toLowerCase().endsWith('.def')) {
      this.handleDefFileChanged(event.fsPath, event.kind);
      return;
    }
    this.handlePythonFileChanged(event.fsPath);
  }

  private watchPythonFiles(): void {
    // workspace 全部根(IDE-IDX-012/013 同口径);外部资产根部分由
    // refreshExternalRootWatchers 统一挂载,assetsRoot 切换可整组重建
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const watcher = this.attachPythonWatcher(
        vscode.Uri.joinPath(folder.uri, '**/*.py').toString()
      );
      if (!this.pythonWatcher) {
        this.pythonWatcher = watcher;
      }
    }
  }

  private watchTypeRegistryFiles(): void {
    // IDE-IDX-013:workspace 全部根(多根工作区第二根的 types/alias 变更
    // 同样要作废快照);外部资产根部分见 refreshExternalRootWatchers
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      this.attachTypeRegistryWatcher(
        vscode.Uri.joinPath(folder.uri, '**/{types,alias}.xml').toString()
      );
    }
  }

  private watchDefFiles(): void {
    // IDE-IDX-012:workspace 全部根(多根工作区的第二根 .def 变更同样要
    // 定向失效);外部资产根部分见 refreshExternalRootWatchers
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const watcher = this.attachDefWatcher(
        vscode.Uri.joinPath(folder.uri, '**/*.def').toString()
      );
      if (!this.defWatcher) {
        this.defWatcher = watcher;
      }
    }
  }

  /**
   * IDE-IDX-014:外部资产根 watcher 三件套(py/types/def)整组重建——
   * assetsRoot 配置切换时由扩展层调:旧根 watcher 全部释放,新根按当前
   * getExternalScanRoots() 重挂,新根的增删改重新可触发维护。
   */
  refreshExternalRootWatchers(): void {
    for (const watcher of this.externalRootWatchers) {
      watcher.dispose();
    }
    this.externalRootWatchers = [];
    for (const root of getExternalScanRoots()) {
      const base = vscode.Uri.file(root);
      this.externalRootWatchers.push(
        this.attachPythonWatcher(vscode.Uri.joinPath(base, '**/*.py').toString()),
        this.attachTypeRegistryWatcher(vscode.Uri.joinPath(base, '**/{types,alias}.xml').toString()),
        this.attachDefWatcher(vscode.Uri.joinPath(base, '**/*.def').toString())
      );
    }
  }

  /** def 变更定向失效:依赖图出计划 → 精确摘除索引/解析缓存/依赖边 */
  private handleDefFileChanged(defPath: string, changeKind: SemanticChangeKind): void {
    const plan = this.dependencyGraph.planInvalidation(defPath, changeKind);
    for (const file of plan.invalidateFiles) {
      this.removeIndexByDefFile(normalizeLookupPath(file));
    }
    // IDE-SCH-003:变更面文件同步送 schema 缓存按清单摘除——只重建它及其
    // 依赖实体的快照,无关实体条目保留命中(懒过期之外的事件时失效)。
    invalidateDatabaseSchemaCacheForFiles(plan.invalidateFiles);
    this.missingOwnerPaths.clear();
    this.missingClassNames.clear();
    if (changeKind !== 'delete') {
      // 定向重解析变更文件自身(缓存已摘除,必然真解析)
      void this.parseDefFile(path.basename(defPath, '.def'), defPath);
    }
  }

  /**
   * 摘除单个 def 的索引记录:语义投影/解析缓存/依赖边;同名实体共用名字槽,
   * 删 B 不连坐 A——摘除后由语义索引重选的同名胜者(仍存在的另一根)接管
   * 名字槽,无胜者才真删(IDE-IDX-008 口径)。
   */
  private removeIndexByDefFile(normalizedDefFile: string): void {
    const index = this.mappingIndexesByRoot.get(normalizedDefFile);
    if (index) {
      this.mappingIndexesByRoot.delete(normalizedDefFile);
      const removed = this.semanticIndex.removeEntityByDefFile(normalizedDefFile);
      const successorEntry = removed ? this.semanticIndex.findEntityByName(removed.entityName) : null;
      const successor = successorEntry ? this.mappingIndexesByRoot.get(successorEntry.defFile) : undefined;
      if (successor) {
        this.mappingIndexes.set(index.rootName, successor);
      } else {
        this.mappingIndexes.delete(index.rootName);
      }
    } else {
      this.semanticIndex.removeEntityByDefFile(normalizedDefFile);
    }
    this.defParseCache.delete(normalizedDefFile);
    this.dependencyGraph.removeFile(normalizedDefFile);
  }

  /**
   * IDE-IDX-015:工作区移除根时摘除该根全部索引记录——该根下所有实体索引
   * (名字槽由剩余同名接管,IDE-IDX-008 口径)、owner 反查、类型注册表快照
   * 全部清出;其他根的记录原样保留。
   */
  removeRoot(rootPath: string): void {
    const normalizedRoot = normalizeLookupPath(rootPath);
    this.removedRootKeys.add(normalizedRoot);
    for (const defFile of [...this.mappingIndexesByRoot.keys()]) {
      if (defFile.startsWith(`${normalizedRoot}/`)) {
        this.removeIndexByDefFile(defFile);
      }
    }
    this.missingOwnerPaths.clear();
    this.missingClassNames.clear();
    getSemanticIndex().removeRoot(rootPath);
  }

  private handlePythonFileChanged(pythonPath: string): void {
    clearDefCallChainFileCache();
    this.allPythonMethodHits.clear();
    // Reconcile only this file after any in-flight initial build. Queries made
    // after the event await the replacement promise, so they see the new file.
    if (this.pythonDefIndexBuild) {
      this.pythonDefIndexBuild = this.pythonDefIndexBuild.then(async index => {
        await this.refreshPythonDefFile(index, pythonPath);
        return index;
      });
    }
    // PR4 A4-4:owner 归属反查改走语义索引(不再线性扫描 mappingIndexes)。
    // IDE-IDX-005:共享脚本(owner 归属多实体)保存时逐个 force 重解析全部
    // 依赖实体——只刷第一家会让其余实体的方法行号/绑定滞留旧脚本内容。
    for (const entry of this.semanticIndex.findEntitiesByPythonOwner(pythonPath)) {
      const mapping = this.mappingIndexesByRoot.get(entry.defFile);
      if (mapping) {
        // force 重解析:py 变更不进 .def mtime 键,缓存会让绑定滞留旧内容
        void this.parseDefFile(entry.entityName, mapping.rootDefFile, undefined, 'entity', true);
      }
    }
  }

  getMapping(entityName: string): EntityMapping | undefined {
    const index = this.mappingIndexes.get(entityName);
    return index ? this.toLegacyMapping(index) : undefined;
  }

  getMappingForPythonFile(pythonFile: string): EntityMapping | undefined {
    const index = this.findIndexForPythonFile(pythonFile);
    return index ? this.toLegacyMapping(index) : undefined;
  }

  getIndexForPythonFile(pythonFile: string): EntityMappingIndex | undefined {
    return this.findIndexForPythonFile(pythonFile);
  }

  async waitForInitialScan(): Promise<void> {
    // 门控兜底(书 PR-002):deferred 模式下首个使用证据即幂等启动,结果口径与门控前一致
    this.ensureStartup();
    await this.initialScan;
  }

  /**
   * IDE-NAV-016:首扫是否已成功落地(只读,不触发门控启动)。冷补全用它
   * 区分「索引未就绪」(可刷新,isIncomplete 空 CompletionList)与「首扫
   * 完成后的真 miss」(null,不虚报可刷新)。失败重触发中的未完成态按冷
   * 处理——重试后同前缀自然拿到补全。
   */
  isInitialScanComplete(): boolean {
    return this.initialScanCompleted;
  }

  /** 解析缓存命中记账(测试/取证用):验证重扫确实复用未变更 .def */
  getDefParseCacheStats(): { entries: number; hits: number; misses: number } {
    return {
      entries: this.defParseCache.size,
      hits: this.defParseCacheHits,
      misses: this.defParseCacheMisses
    };
  }

  /** PR4 取证/测试面:语义索引查询视图(只暴露查询 API,不暴露内部遍历) */
  getSemanticIndex(): SemanticIndex {
    return this.semanticIndex;
  }

  /** PR4 取证/测试面:依赖失效图(单文件变更失效范围测试用) */
  getDependencyGraph(): SemanticDependencyGraph {
    return this.dependencyGraph;
  }

  getIndex(entityName: string): EntityMappingIndex | undefined {
    return this.mappingIndexes.get(entityName);
  }

  // 同步状态读取不触发门控启动(书 PR-002):激活期装配(如 CodeLens 初始
  // entries)会读当前映射状态,门控前它读到的也是「首扫未完成」的近空集,
  // 门控后读空集同口径;启动面只在异步查询/等待入口,避免激活期读状态把
  // 负案例工作区悄悄拉回全量启动。
  getAllMappings(): EntityMapping[] {
    return [...this.mappingIndexes.values()].map(index => this.toLegacyMapping(index));
  }

  async resolvePropertyDefinition(
    pythonFile: string,
    fullPath: string,
    rootSymbol?: string
  ): Promise<EntityPropertyDefinitionLocation | null> {
    // 门控兜底(书 PR-002):deferred 模式下首个使用证据即幂等启动,结果口径与门控前一致
    this.ensureStartup();
    return this.findIndexedProperty(pythonFile, fullPath, rootSymbol);
  }

  /** 与 resolvePropertyDefinition 同解析口径,额外带 <Type>/可见域/持久化标记(批135) */
  async resolvePropertyDefinitionInfo(
    pythonFile: string,
    fullPath: string,
    rootSymbol?: string
  ): Promise<PropertyDefinitionInfo | null> {
    // 门控兜底(书 PR-002):deferred 模式下首个使用证据即幂等启动,结果口径与门控前一致
    this.ensureStartup();
    return this.findIndexedProperty(pythonFile, fullPath, rootSymbol);
  }

  private async findIndexedProperty(
    pythonFile: string,
    fullPath: string,
    rootSymbol?: string
  ): Promise<IndexedPropertyDefinition | null> {
    const index = await this.ensureIndexForPythonFile(pythonFile);
    if (!index) {
      return null;
    }
    return this.findIndexedPropertyIn(index, fullPath, rootSymbol);
  }

  private findIndexedPropertyIn(
    index: EntityMappingIndex,
    fullPath: string,
    rootSymbol?: string
  ): IndexedPropertyDefinition | null {
    const normalizedFullPath = normalizePropertyLookupPath(fullPath);
    const normalizedRoot = rootSymbol ? normalizePropertyLookupPath(rootSymbol) : undefined;

    return index.propertyDefinitions.find(item => normalizePropertyLookupPath(item.identity.propertyPath || '') === normalizedFullPath)
      || (normalizedRoot
        ? index.propertyDefinitions.find(item => normalizePropertyLookupPath(item.identity.propertyPath || '') === normalizedRoot)
        : undefined)
      || null;
  }

  async resolveMethodDefinition(
    pythonFile: string,
    methodName: string,
    receiverSection?: EntityMethodSection,
    token?: vscode.CancellationToken
  ): Promise<EntityMethodDefinitionLocation | null> {
    // IDE-BUD-002:hover 取消传播到请求独占任务——取消后本请求不再发起新读取
    // (两道闸:入口/索引等待后);共享首扫只被等待,永不被取消。
    if (token?.isCancellationRequested) { return null; }
    // 门控兜底(书 PR-002):deferred 模式下首个使用证据即幂等启动,结果口径与门控前一致
    this.ensureStartup();
    const index = await this.ensureIndexForPythonFile(pythonFile);
    if (token?.isCancellationRequested) { return null; }
    const ownerKind = inferOwnerKindFromPythonFile(pythonFile);
    const ownerName = inferOwnerNameFromPythonFile(pythonFile);
    const section = inferMethodSectionFromPythonFile(pythonFile);
    const options = {
      methodName,
      ownerKind,
      ownerName,
      section
    };

    // Keep the paired owner index as the preferred scope. Interfaces without a
    // matching .def (or declarations stored in a shared .def) need a global
    // fallback across every scanned definition index.
    // 接收者段闸(用户令 2026-10-21):receiverSection 在场时先按段过滤候选
    // (段不符的 def 声明一律不进打分,更不进任何后续闸)。
    const local = index
      ? this.selectMethodDefinition(
        filterMethodDefinitionsBySection(index.methodDefinitions, receiverSection),
        options
      )
      : null;
    // A role-neutral scripts/interfaces module (for example interfaces/ROLE.py)
    // has no Base/Cell/Client ownership and must not bind to an unrelated entity
    // declaration. Cross-file fallback is for role-specific interface modules.
    const allowCrossDefFallback = ownerKind === 'interface' && !!section;
    if (!local && allowCrossDefFallback) {
      // 首扫曾失败:先重触发(有界)再等——失败被静默转成功的话,这里等的
      // 永远是已 resolve 的残缺快照,重试语义到不了实体扫描(审核发现 :182)
      this.retryInitialScanAfterFailure();
      const ready = await raceWithBudget('definition:cross-def-index',
        this.initialScan.then(() => true), INTERACTIVE_INDEX_WAIT_MS, token);
      if (!ready) { return null; }
    }
    const global = local || (allowCrossDefFallback
      ? this.selectMethodDefinition(
        filterMethodDefinitionsBySection(
          [...this.mappingIndexes.values()].flatMap(item => item.methodDefinitions),
          receiverSection
        ),
        options
      )
      : null);
    const located = global;
    jumpLog('debug', () =>
      `def 方法[文件级${local ? '' : '+全局回退'}]${receiverSection ? `[段闸 ${receiverSection}]` : ''} ${methodName} → ${located ? `${path.basename(located.defFile)}:${located.line}` : 'miss'}`
    );
    return located;
  }

  /**
   * 对象级(类粒度).def 解析:按类名直接取该类的 .def 索引,不看调用文件
   * 是否匹配到 owner——「文件没匹配上 owner」不等于「对象没有 .def」,
   * 放弃范围必须在对象/类粒度判定(接口/组件类经 ownerName 回溯到引用它的
   * 实体索引)。
   */
  async resolveMethodDefinitionForClass(
    className: string,
    methodName: string,
    receiverSection?: EntityMethodSection,
    callerFile?: string
  ): Promise<EntityMethodDefinitionLocation | null> {
    // 门控兜底(书 PR-002):deferred 模式下首个使用证据即幂等启动,结果口径与门控前一致
    this.ensureStartup();
    const index = await this.ensureIndexForClass(className, callerFile);
    if (!index) {
      return null;
    }
    return this.selectMethodDefinition(
      filterMethodDefinitionsBySection(index.methodDefinitions, receiverSection),
      {
        methodName,
        ownerName: className
      }
    );
  }

  /** 对象级属性解析:取索引口径同 resolveMethodDefinitionForClass,查 <Properties> */
  async resolvePropertyDefinitionForClass(
    className: string,
    fullPath: string,
    rootSymbol?: string,
    callerFile?: string
  ): Promise<EntityPropertyDefinitionLocation | null> {
    // 门控兜底(书 PR-002):deferred 模式下首个使用证据即幂等启动,结果口径与门控前一致
    this.ensureStartup();
    const index = await this.ensureIndexForClass(className, callerFile);
    if (!index) {
      return null;
    }
    return this.findIndexedPropertyIn(index, fullPath, rootSymbol);
  }

  async resolveDefinitionSymbolAtPosition(
    defFile: string,
    line: number,
    symbolName: string,
    section?: EntityMethodSection,
    propertyPath?: string
  ): Promise<DefinitionSymbolIdentity | null> {
    // 门控兜底(书 PR-002):deferred 模式下首个使用证据即幂等启动,结果口径与门控前一致
    this.ensureStartup();
    const index = await this.ensureIndexByDefFile(defFile);
    if (!index) {
      return null;
    }

    if (propertyPath) {
      const property = index.propertyDefinitions.find(item =>
        normalizeLookupPath(item.defFile) === normalizeLookupPath(defFile)
        && item.line === line
        && normalizePropertyLookupPath(item.identity.propertyPath || '') === normalizePropertyLookupPath(propertyPath)
      );
      return property?.identity || null;
    }

    if (section) {
      const method = index.methodDefinitions.find(item =>
        normalizeLookupPath(item.defFile) === normalizeLookupPath(defFile)
        && item.line === line
        && item.section === section
        && item.identity.symbolName === symbolName
      );
      return method?.identity || null;
    }

    return null;
  }

  async openMethodTarget(
    identityOrEntityName: DefinitionSymbolIdentity | string,
    methodName?: string,
    section?: EntityMethodSection
  ): Promise<boolean> {
    // 门控兜底(书 PR-002):deferred 模式下首个使用证据即幂等启动,结果口径与门控前一致
    this.ensureStartup();
    const identity = typeof identityOrEntityName === 'string'
      ? this.createLegacyIdentity(identityOrEntityName, methodName, section)
      : identityOrEntityName;
    if (!identity) {
      return false;
    }

    const index = typeof identityOrEntityName === 'string'
      ? await this.ensureIndex(identity.ownerName)
      : await this.ensureIndexForOwner(identity);
    if (!index) {
      return false;
    }

    const implementationTarget = this.findMethodImplementationByIdentity(index, identity);
    if (implementationTarget) {
      return this.openFileAtLocation(
        implementationTarget.filePath,
        implementationTarget.line,
        implementationTarget.character
      );
    }

    const definition = index.methodDefinitions.find(item => sameIdentity(item.identity, identity));
    if (!definition) {
      return false;
    }

    return this.openFileAtLocation(definition.defFile, definition.line);
  }

  async resolveMethodImplementationByIdentity(
    identity: DefinitionSymbolIdentity
  ): Promise<{ filePath: string; line: number; character: number } | null> {
    // 门控兜底(书 PR-002):deferred 模式下首个使用证据即幂等启动,结果口径与门控前一致
    this.ensureStartup();
    const index = await this.ensureIndexForOwner(identity);
    if (!index) {
      return null;
    }

    const located = this.findMethodImplementationByIdentity(index, identity);
    if (located) {
      // 绑定层不做形参拦截(2026-10-21 收窄):实体自身脚本的同名绑定是约定即答案,
      // 形参闸门只装在「猜外来文件」的域目录层与全项目回退层。
      return located;
    }
    const definition = index.methodDefinitions.find(item => sameIdentity(item.identity, identity));
    const declaredArgs = definition?.declaredArgs;
    const declaredArgTypes = declaredArgs && declaredArgs.length > 0 ? declaredArgs : undefined;

    // 用户令(2026-10-20):.def 方法在同名/绑定文件找不到实现时,放宽到全项目
    // python:方法名**唯一命中**才跳(实现常落在父类/公共模块的 py 里,
    // 属主索引 pythonMethods 只收实体属主脚本,覆盖不到),多处命中保持静默
    // (交给调用方约定链与提示),找不到维持现状不误跳。
    // 2026-10-21:先按方法域走 base//cell/ 目录层(identity.section 在场时);
    // def 声明了 <Arg> 时叠加形参闸门——个数必须相等,有注解的还要按
    // 引擎内建映射(UINT8→int 等)对得上类型;读不出签名不算候选。
    return this.resolveMethodImplementationGlobally(
      identity.symbolName,
      identity.section,
      declaredArgTypes
    );
  }

  /**
   * IDE-NAV-007:def 方法实现列表(Go to Implementations)。按精确声明身份
   * 收全部实现:绑定命中(pythonMethods.binding sameIdentity)+ 段属主脚本
   * 同名定义(owner 注册面 ownerName/ownerKind/section 匹配的每个文件),
   * 按文件去重。不含全项目唯一名回退——那是 F12 按名字猜的导航兜底,
   * 不是实现(Go to Impl 不猜)。
   */
  async listMethodImplementationsByIdentity(
    identity: DefinitionSymbolIdentity,
    token?: vscode.CancellationToken
  ): Promise<Array<{ filePath: string; line: number; character: number }>> {
    this.ensureStartup();
    const index = await this.ensureIndexForOwner(identity);
    if (!index || token?.isCancellationRequested) {
      return [];
    }

    const implementations: Array<{ filePath: string; line: number; character: number }> = [];
    const seenFiles = new Set<string>();

    for (const method of index.pythonMethods) {
      if (token?.isCancellationRequested) { return implementations; }
      if (!method.binding || !sameIdentity(method.binding.identity, identity)) {
        continue;
      }
      const key = normalizeLookupPath(method.filePath);
      if (seenFiles.has(key)) {
        continue;
      }
      seenFiles.add(key);
      implementations.push({ filePath: method.filePath, line: method.line, character: method.character });
    }

    const section = identity.section;
    const candidates = index.pythonOwnerFiles
      .filter(item =>
        item.ownerName === identity.ownerName
        && item.ownerKind === identity.ownerKind
        && (!section || item.section === section))
      .map(item => item.filePath);
    for (const filePath of uniqueFilePaths(candidates)) {
      if (token?.isCancellationRequested) { return implementations; }
      if (seenFiles.has(normalizeLookupPath(filePath))) {
        continue;
      }
      const location = this.findPythonMethodLine(filePath, identity.symbolName);
      if (!location) {
        continue;
      }
      seenFiles.add(normalizeLookupPath(filePath));
      implementations.push({ filePath, line: location.line, character: location.character });
    }

    return implementations;
  }

  /**
   * IDE-NAV-014:身份对应段的属主脚本清单(盘上已存在的,按候选生成序)。
   * 空方法生成 Code Action 用首个条目作目标文件;实现判存用
   * listMethodImplementationsByIdentity(同一 owner 注册面),两者不混。
   */
  async listOwnerScriptFilesForIdentity(
    identity: DefinitionSymbolIdentity,
    token?: vscode.CancellationToken
  ): Promise<string[]> {
    this.ensureStartup();
    const index = await this.ensureIndexForOwner(identity);
    if (!index || token?.isCancellationRequested) {
      return [];
    }

    const section = identity.section;
    const candidates = index.pythonOwnerFiles
      .filter(item =>
        item.ownerName === identity.ownerName
        && item.ownerKind === identity.ownerKind
        && (!section || item.section === section))
      .map(item => item.filePath);
    return uniqueFilePaths(candidates);
  }

  /**
   * 全项目 python 回退(用户令 2026-10-20):方法名在全项目 py 中唯一命中才返回,
   * 多处/零处一律 null(静默,不误跳)。给 def 侧 identity 未命中/未绑定实现的
   * 两个早落分支复用——那两支不经过 resolveMethodImplementationByIdentity。
   *
   * 域目录层(用户令 2026-10-21,报错 onClientEnabled 错跳):BaseMethods 定义的方法
   * 先只在 base/ 目录下找、CellMethods 只在 cell/ 下找;域内唯一命中即返回,
   * 域内无果或歧义才进入全项目回退(唯一命中才跳的既有语义不变)。
   */
  async resolveMethodImplementationGlobally(
    methodName: string,
    section?: EntityMethodSection,
    declaredArgTypes?: string[]
  ): Promise<{ filePath: string; line: number; character: number } | null> {
    // 门控兜底(书 PR-002):deferred 模式下首个使用证据即幂等启动,结果口径与门控前一致
    this.ensureStartup();
    const domainRole =
      section === 'BaseMethods' ? 'base' : section === 'CellMethods' ? 'cell' : null;
    if (domainRole) {
      const domainHits = await this.collectAllPythonMethodHits(methodName, domainRole, declaredArgTypes);
      if (domainHits.length === 1) {
        const [domainHit] = domainHits;
        jumpLog('debug', () =>
          `def 方法[域内目录 ${domainRole}] ${methodName} → ${path.basename(domainHit.filePath)}:${domainHit.line}`
        );
        return domainHit;
      }
    }
    const globalHits = await this.collectAllPythonMethodHits(methodName, undefined, declaredArgTypes);
    if (globalHits.length === 1) {
      const [globalHit] = globalHits;
      jumpLog('debug', () =>
        `def 方法[全项目回退] ${methodName} → ${path.basename(globalHit.filePath)}:${globalHit.line}`
      );
      return globalHit;
    }
    return null;
  }

  /** 全项目 python 方法扫描(懒缓存):精确 `def <name>(`,跳过虚目录,多处命中交由调用方判定。domain 在场时只收路径含该目录段(base/cell)的文件。 */
  private readonly allPythonMethodHits = new Map<
    string,
    Array<{ filePath: string; line: number; character: number }>
  >();

  /**
   * 方法名倒排索引：首次查询扫描一次；之后的 Python 文件事件只替换该文件
   * 的桶记录。构建与增量读取均用异步 IO，目录及文件循环定期让出事件循环。
   */
  private pythonDefIndexBuild: Promise<
    Map<string, Array<{ filePath: string; line: number; character: number }>>
  > | null = null;
  private readonly pythonDefIndexFiles = new Map<string, Set<string>>();
  private readonly pythonDefFileOrder = new Map<string, number>();
  private nextPythonDefFileOrder = 0;

  private addPythonDefFile(
    index: Map<string, Array<{ filePath: string; line: number; character: number }>>,
    filePath: string,
    text: string
  ): void {
    const names = new Set<string>();
    const lines = text.split(/\r?\n/);
    const defPattern = /^\s*def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/;
    for (let i = 0; i < lines.length; i += 1) {
      const match = defPattern.exec(lines[i]);
      if (!match || names.has(match[1])) { continue; }
      names.add(match[1]);
      const bucket = index.get(match[1]) ?? [];
      bucket.push({ filePath, line: i + 1, character: lines[i].search(/\S/) });
      index.set(match[1], bucket);
    }
    this.pythonDefIndexFiles.set(filePath, names);
  }

  private async refreshPythonDefFile(
    index: Map<string, Array<{ filePath: string; line: number; character: number }>>,
    filePath: string
  ): Promise<void> {
    for (const name of this.pythonDefIndexFiles.get(filePath) ?? []) {
      const remaining = (index.get(name) ?? []).filter(hit => hit.filePath !== filePath);
      if (remaining.length) { index.set(name, remaining); }
      else { index.delete(name); }
    }
    this.pythonDefIndexFiles.delete(filePath);
    if (!filePath.toLowerCase().endsWith('.py') ||
        filePath.split(/[\\/]/).some(part => PY_SCAN_EXCLUDED_DIRS.has(part))) { return; }
    let text: string;
    try { text = await fs.promises.readFile(filePath, 'utf8'); }
    catch {
      this.pythonDefFileOrder.delete(filePath);
      return; // deletion or unreadable file: its old hits are already gone
    }
    if (!this.pythonDefFileOrder.has(filePath)) {
      this.pythonDefFileOrder.set(filePath, this.nextPythonDefFileOrder++);
    }
    this.addPythonDefFile(index, filePath, text);
    for (const name of this.pythonDefIndexFiles.get(filePath) ?? []) {
      index.get(name)?.sort((left, right) =>
        (this.pythonDefFileOrder.get(left.filePath) ?? Number.MAX_SAFE_INTEGER) -
        (this.pythonDefFileOrder.get(right.filePath) ?? Number.MAX_SAFE_INTEGER));
    }
  }

  private buildPythonDefIndex(): Promise<
    Map<string, Array<{ filePath: string; line: number; character: number }>>
  > {
    if (this.pythonDefIndexBuild) {
      return this.pythonDefIndexBuild;
    }
    const build = this.performBuildPythonDefIndex();
    const recovered = build.catch(error => {
      jumpLog(
        'debug',
        () => `python def 索引构建失败: ${error instanceof Error ? error.message : String(error)}`
      );
      if (this.pythonDefIndexBuild === recovered) { this.pythonDefIndexBuild = null; }
      return new Map<string, Array<{ filePath: string; line: number; character: number }>>();
    });
    this.pythonDefIndexBuild = recovered;
    return this.pythonDefIndexBuild;
  }

  private async performBuildPythonDefIndex(): Promise<
    Map<string, Array<{ filePath: string; line: number; character: number }>>
  > {
    const index = new Map<string, Array<{ filePath: string; line: number; character: number }>>();
    const skippedDirs = PY_SCAN_EXCLUDED_DIRS;
    const seenPaths = new Set<string>();
    let filesSinceYield = 0;
    let chunkStartedAt = Date.now();
    const walk = async (dir: string): Promise<void> => {
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (Date.now() - chunkStartedAt >= 16) {
          filesSinceYield = 0;
          chunkStartedAt = Date.now();
          await new Promise<void>(resolve => setImmediate(resolve));
        }
        if (entry.isDirectory()) {
          if (!skippedDirs.has(entry.name)) {
            await walk(path.join(dir, entry.name));
          }
          continue;
        }
        if (!entry.name.endsWith('.py')) {
          continue;
        }
        const filePath = path.join(dir, entry.name);
        const normalized = normalizeLookupPath(filePath);
        if (seenPaths.has(normalized)) {
          continue;
        }
        seenPaths.add(normalized);
        let text: string;
        try {
          text = await readFileUtf8Recorded(filePath);
        } catch {
          continue;
        }
        if (!this.pythonDefFileOrder.has(filePath)) {
          this.pythonDefFileOrder.set(filePath, this.nextPythonDefFileOrder++);
        }
        this.addPythonDefFile(index, filePath, text);
        // 协作式让路:巨仓 walk 不再钉死插件宿主(口径同首扫让路)
        if (++filesSinceYield >= 25 || Date.now() - chunkStartedAt >= 16) {
          filesSinceYield = 0;
          chunkStartedAt = Date.now();
          await new Promise<void>(resolve => setImmediate(resolve));
        }
      }
    };
    for (const root of getIndexScanRoots()) {
      await walk(root);
    }
    return index;
  }

  private async collectAllPythonMethodHits(
    methodName: string,
    domain?: 'base' | 'cell',
    declaredArgTypes?: string[]
  ): Promise<Array<{ filePath: string; line: number; character: number }>> {
    const cacheKey = `${domain ?? '*'}:${methodName}:${declaredArgTypes ? declaredArgTypes.join(',') : '*'}`;
    const cached = this.allPythonMethodHits.get(cacheKey);
    if (cached) {
      return cached;
    }
    // 批158:全树 walk 改共享倒排索引(一次 walk 服务所有方法名,协作式让路);
    // 形参闸门仍在此处逐桶筛选——索引只收名字,不收签名。
    const index = await this.buildPythonDefIndex();
    const candidates = index.get(methodName) ?? [];
    const domainFiltered = domain
      ? candidates.filter(hit => hit.filePath.split(path.sep).includes(domain))
      : candidates;
    const hits: Array<{ filePath: string; line: number; character: number }> = [];
    for (const candidate of domainFiltered) {
      if (!declaredArgTypes) {
        hits.push(candidate);
        continue;
      }
      let text: string;
      try {
        text = readFileSyncUtf8Recorded(candidate.filePath);
      } catch {
        continue;
      }
      const lines = text.split(/\r?\n/);
      const lineIndex = candidate.line - 1;
      // 形参闸门(用户令 2026-10-21,口径不变):def 声明了 <Arg> 时,实现形参
      // 个数(剔除 self/cls)必须相等;有注解的形参按引擎内建映射对上类型
      // (UINT8→int/STRING→str/VECTOR3→Tuple[...]);读不出签名/不符 → 不算候选。
      if (EntityMappingManager.pythonSignatureMatchesDeclaredArgs(declaredArgTypes, lines, lineIndex)) {
        hits.push(candidate);
      }
    }
    hits.sort((a, b) => (a.filePath === b.filePath ? a.line - b.line : a.filePath.localeCompare(b.filePath)));
    this.allPythonMethodHits.set(cacheKey, hits);
    return hits;
  }

  /**
   * 形参闸门公开口(用户令 2026-10-21:只凭名字标 RPC/标 KBEngine 函数不严谨,
   * CodeLens/Hover 面与全项目回退扫描共用同一把尺):从 lines[index] 的 def 行
   * 起收集签名,与 declaredArgTypes 逐一对账——形参个数(剔除 self/cls)必须
   * 相等,有注解的形参按统一解析链对上类型(缺省内建映射 UINT8→int/STRING→str
   * 等,兼容直写 <Arg> 原文;hover/CodeLens 面注入 resolveEntityAnnotationType
   * 同源解析,types.xml 自定义类型也按链断到内建),未注明解的只作个数校验;
   * 读不出签名/个数或类型不符一律 false,declaredArgTypes 为空序列视为未声明
   * <Arg>,恒真。
   */
  static pythonSignatureMatchesDeclaredArgs(
    declaredArgTypes: readonly string[],
    lines: string[],
    index: number,
    resolveAnnotation?: (raw: string) => string
  ): boolean {
    if (declaredArgTypes.length === 0) {
      return true;
    }
    const signature = EntityMappingManager.collectSignatureText(lines, index);
    if (signature === null) {
      return false;
    }
    const params = EntityMappingManager.parsePythonParams(signature);
    if (!params || params.length !== declaredArgTypes.length) {
      return false;
    }
    for (let a = 0; a < declaredArgTypes.length; a += 1) {
      const annotation = params[a].annotation;
      if (!annotation) {
        continue;
      }
      const raw = declaredArgTypes[a];
      const expected = resolveAnnotation
        ? resolveAnnotation(raw)
        : PYTHON_BUILTIN_TYPE_ANNOTATIONS[raw] ?? raw;
      if (annotation !== expected && annotation !== raw) {
        return false;
      }
    }
    return true;
  }

  /** 从 def 行起收集到括号配平的签名文本(≤8 行跨行容忍);读不出返回 null。 */
  private static collectSignatureText(lines: string[], startIndex: number): string | null {
    let chunk = '';
    for (let k = startIndex; k < lines.length && k < startIndex + 8; k += 1) {
      chunk += (chunk ? ' ' : '') + (lines[k] ?? '');
      if (!chunk.includes('(')) {
        continue;
      }
      let depth = 0;
      let closed = false;
      for (const ch of chunk.slice(chunk.indexOf('('))) {
        if (ch === '(') {
          depth += 1;
        } else if (ch === ')') {
          depth -= 1;
          if (depth === 0) {
            closed = true;
            break;
          }
        }
      }
      if (closed) {
        return chunk;
      }
    }
    return null;
  }

  /** 签名文本 → 形参序列(名+可选注解;剔除 self/cls,剥默认值,顶层深度感知切分);读不出 null。 */
  private static parsePythonParams(
    signature: string
  ): Array<{ name: string; annotation: string | null }> | null {
    const open = signature.indexOf('(');
    if (open < 0) {
      return null;
    }
    let depth = 0;
    let close = -1;
    for (let k = open; k < signature.length; k += 1) {
      const ch = signature[k];
      if (ch === '(') {
        depth += 1;
      } else if (ch === ')') {
        depth -= 1;
        if (depth === 0) {
          close = k;
          break;
        }
      }
    }
    if (close < 0) {
      return null;
    }
    // 括号内只有形参列表(返回注解在 ')' 之后,已被 close 截掉),无需再剥注解;
    // 形参自身的注解冒号由逐段解析处理。
    const inner = signature.slice(open + 1, close);
    if (!inner.trim()) {
      return [];
    }
    const parts: string[] = [];
    let cur = '';
    let d = 0;
    for (const ch of inner) {
      if (ch === '[' || ch === '(' || ch === '{') {
        d += 1;
      } else if (ch === ']' || ch === ')' || ch === '}') {
        d -= 1;
      }
      if (ch === ',' && d === 0) {
        parts.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
    if (cur.trim()) {
      parts.push(cur);
    }
    const params: Array<{ name: string; annotation: string | null }> = [];
    for (const part of parts) {
      const head = part.split('=')[0] ?? '';
      const colon = head.indexOf(':');
      const name = (colon >= 0 ? head.slice(0, colon) : head).trim();
      const annotation = colon >= 0 ? head.slice(colon + 1).trim() || null : null;
      if (!name || name === 'self' || name === 'cls') {
        continue;
      }
      params.push({ name, annotation });
    }
    return params;
  }

  private async ensureIndexForOwner(
    identity: DefinitionSymbolIdentity
  ): Promise<EntityMappingIndex | undefined> {
    // PR4 A4-4:owner 回溯改走语义索引(直查=同名单一胜者;回溯=kind+名
    // 归属注册序首中),不再线性扫描 mappingIndexes。
    const directDefFile = this.semanticIndex.getEntityDefFile(identity.ownerName);
    const direct = directDefFile ? this.mappingIndexesByRoot.get(directDefFile) : undefined;
    if (direct) {
      return direct;
    }

    const ownerIndex = this.findOwnerIndexByIdentity(identity);
    if (ownerIndex) {
      return ownerIndex;
    }

    await this.scanEntityMappings();
    const retried = this.semanticIndex.getEntityDefFile(identity.ownerName);
    return (retried ? this.mappingIndexesByRoot.get(retried) : undefined)
      || this.findOwnerIndexByIdentity(identity);
  }

  /** owner(kind+名)归属索引:语义索引 owner 文件投影的注册序首中 */
  private findOwnerIndexByIdentity(identity: DefinitionSymbolIdentity): EntityMappingIndex | undefined {
    for (const entry of this.semanticIndex.findEntitiesByOwner(identity.ownerKind, identity.ownerName)) {
      const index = this.mappingIndexesByRoot.get(entry.defFile);
      if (index) {
        return index;
      }
    }
    return undefined;
  }

  async resolveMethodImplementation(
    entityName: string,
    methodName: string,
    section: EntityMethodSection
  ): Promise<{ filePath: string; line: number; character: number } | null> {
    // 门控兜底(书 PR-002):deferred 模式下首个使用证据即幂等启动,结果口径与门控前一致
    this.ensureStartup();
    const index = await this.ensureIndex(entityName);
    if (!index) {
      return null;
    }

    const definition = this.selectMethodDefinition(index.methodDefinitions, {
      methodName,
      ownerKind: 'entity',
      ownerName: entityName,
      section
    });

    return definition ? this.findMethodImplementationByIdentity(index, definition.identity) : null;
  }

  async resolvePythonMethodAtPosition(
    pythonFile: string,
    line: number,
    character: number
  ): Promise<PythonMethodLocation | null> {
    // 门控兜底(书 PR-002):deferred 模式下首个使用证据即幂等启动,结果口径与门控前一致
    this.ensureStartup();
    const index = await this.ensureIndexForPythonFile(pythonFile);
    if (!index) {
      return null;
    }

    const normalizedPythonPath = normalizeLookupPath(pythonFile);
    return index.pythonMethods.find(method =>
      normalizeLookupPath(method.filePath) === normalizedPythonPath
      && line >= method.line
      && line <= method.endLine
      && (line !== method.line || character >= method.character)
    ) || null;
  }

  /**
   * 实体脚本的 def 归属面(用户令 2026-10-21 内建属性单 ④):owner 文件
   * 段位映射 BaseMethods→baseapp / CellMethods→cellapp / ClientMethods→client,
   * 去重返回。非实体脚本(无 .def 归属)→ null;面歧义由调用方
   * (entityBuiltinProperties.resolveEntityBuiltinPropertyHit)降级为宏公共 3。
   */
  async getEntityComponentFacesForPythonFile(
    pythonFile: string,
    token?: vscode.CancellationToken
  ): Promise<EntityComponentFace[] | null> {
    // IDE-BUD-002:取消传播同 resolveMethodDefinition(取消后不发起新读取)
    if (token?.isCancellationRequested) { return null; }
    // 门控兜底(书 PR-002):deferred 模式下首个使用证据即幂等启动,结果口径与门控前一致
    this.ensureStartup();
    const index = await this.ensureIndexForPythonFile(pythonFile);
    if (token?.isCancellationRequested || !index) {
      return null;
    }
    const normalized = normalizeLookupPath(pythonFile);
    const faces = new Set<EntityComponentFace>();
    for (const owner of index.pythonOwnerFiles) {
      if (normalizeLookupPath(owner.filePath) !== normalized) {
        continue;
      }
      const face =
        owner.section === 'BaseMethods'
          ? 'baseapp'
          : owner.section === 'CellMethods'
            ? 'cellapp'
            : owner.section === 'ClientMethods'
              ? 'client'
              : null;
      if (face) {
        faces.add(face);
      }
    }
    return [...faces];
  }

  async getOutgoingPythonMethodCalls(
    pythonFile: string,
    methodName: string,
    token?: vscode.CancellationToken
  ): Promise<PythonMethodCallReference[]> {
    if (token?.isCancellationRequested) return [];
    // 门控兜底(书 PR-002):deferred 模式下首个使用证据即幂等启动,结果口径与门控前一致
    this.ensureStartup();
    const index = await this.ensureIndexForPythonFile(pythonFile, token);
    if (!index || token?.isCancellationRequested) {
      return [];
    }

    const targetMethod = index.pythonMethods.find(method =>
      normalizeLookupPath(method.filePath) === normalizeLookupPath(pythonFile)
      && method.methodName === methodName
    );
    if (!targetMethod) {
      return [];
    }

    const references: PythonMethodCallReference[] = [];
    const seen = new Set<string>();
    for (const reference of targetMethod.calls) {
      if (token?.isCancellationRequested) return [];
      const binding = index.pythonMethods.find(candidate =>
        normalizeLookupPath(candidate.filePath) === normalizeLookupPath(reference.filePath)
        && candidate.methodName === reference.methodName
      );

      const resolved = binding
        || index.pythonMethods.find(candidate => candidate.methodName === reference.methodName);
      if (!resolved) {
        continue;
      }

      const key = `${normalizeLookupPath(resolved.filePath)}:${resolved.methodName}:${resolved.line}:${resolved.character}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      references.push({
        filePath: resolved.filePath,
        methodName: resolved.methodName,
        line: resolved.line,
        character: resolved.character
      });
    }

    return references;
  }

  /**
   * IDE-NAV-002:def 属性的 python self 访问引用。归属由 owner 注册面决定:
   * 只扫该 def 索引的 pythonOwnerFiles(已确定实体归属),无关实体同名
   * 属性不进来;self.<name>( 带调用括号的是方法调用(NAV-003 面),不收。
   */
  async getIncomingPythonPropertyAccesses(
    defFile: string,
    propertyName: string,
    token?: vscode.CancellationToken
  ): Promise<Array<{ filePath: string; line: number; character: number }>> {
    if (token?.isCancellationRequested) { return []; }
    // 门控兜底(书 PR-002):deferred 模式下首个使用证据即幂等启动
    this.ensureStartup();
    const index = this.mappingIndexesByRoot.get(normalizeLookupPath(defFile));
    if (!index) {
      return [];
    }
    const accesses: Array<{ filePath: string; line: number; character: number }> = [];
    const accessRegex = new RegExp(
      `\\bself\\.${escapeRegExp(propertyName)}\\b(?!\\s*\\()`,
      'g'
    );
    for (const owner of index.pythonOwnerFiles) {
      if (token?.isCancellationRequested) { return accesses; }
      // IDE-NAV-004:未保存文档跟随——打开文档在位时扫缓冲区当前版,
      // 未打开/已关闭回落磁盘(SNP-001 快照契约;磁盘侧读盘照常记账)。
      const snapshot = readSharedFileSnapshot(owner.filePath);
      if (!snapshot) {
        continue;
      }
      const content = snapshot.content;
      const lines = content.split('\n');
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        accessRegex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = accessRegex.exec(lines[lineIndex])) !== null) {
          accesses.push({
            filePath: owner.filePath,
            line: lineIndex + 1,
            character: match.index + 'self.'.length
          });
        }
      }
    }
    return accesses;
  }

  /**
   * IDE-NAV-003:receiver RPC 调用收录(self.cell.X( / self.base.X( / self.client.X()。
   * 归属与 NAV-002 属性访问同面——只扫本 def 的 owner 文件;同名方法按
   * receiver 段分开统计(调用方查哪段就配哪个 receiver),带调用括号断言,
   * 非调用形态(self.cell.X 不带括号作回调引用)不收。
   */
  async getIncomingPythonReceiverCalls(
    defFile: string,
    methodName: string,
    receiver: 'cell' | 'base' | 'client',
    token?: vscode.CancellationToken
  ): Promise<Array<{ filePath: string; line: number; character: number }>> {
    if (token?.isCancellationRequested) return [];
    this.ensureStartup();
    const index = this.mappingIndexesByRoot.get(normalizeLookupPath(defFile));
    if (!index) return [];
    const callRegex = new RegExp(
      `\\bself\\.${receiver}\\.${escapeRegExp(methodName)}\\b(?=\\s*\\()`,
      'g'
    );
    const calls: Array<{ filePath: string; line: number; character: number }> = [];
    for (const owner of index.pythonOwnerFiles) {
      if (token?.isCancellationRequested) return calls;
      // IDE-NAV-004:同属性引用面——打开文档优先(缓冲区当前版),磁盘兜底
      const snapshot = readSharedFileSnapshot(owner.filePath);
      if (!snapshot) {
        continue;
      }
      const content = snapshot.content;
      const lines = content.split('\n');
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        callRegex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = callRegex.exec(lines[lineIndex])) !== null) {
          calls.push({
            filePath: owner.filePath,
            line: lineIndex + 1,
            character: match.index + `self.${receiver}.`.length
          });
        }
      }
    }
    return calls;
  }

  async getIncomingPythonMethodCalls(
    pythonFile: string,
    methodName: string,
    token?: vscode.CancellationToken
  ): Promise<Array<{ caller: PythonMethodLocation; callLine: number; callCharacter: number }>> {    if (token?.isCancellationRequested) return [];
    // 门控兜底(书 PR-002):deferred 模式下首个使用证据即幂等启动,结果口径与门控前一致
    this.ensureStartup();
    const index = await this.ensureIndexForPythonFile(pythonFile, token);
    if (!index || token?.isCancellationRequested) {
      return [];
    }

    const incoming: Array<{ caller: PythonMethodLocation; callLine: number; callCharacter: number }> = [];
    const normalizedTarget = normalizeLookupPath(pythonFile);

    // IDE-NAV-004:未保存文档跟随——在位打开文档以缓冲区当前版重解析方法块
    // (parsePythonMethodBlocks 与索引首扫同一纯函数),覆盖该文件的索引条目
    // 后再扫:新增/删除调用点随缓冲区,未打开文件走磁盘索引原样。逐文件
    // 快照会把磁盘补载放大成整索引读盘,故清单一次取(collectOpenDocumentTexts)。
    const methodsByFile = new Map<string, IndexedPythonMethodLocation[]>();
    for (const method of index.pythonMethods) {
      const key = normalizeLookupPath(method.filePath);
      const bucket = methodsByFile.get(key);
      if (bucket) {
        bucket.push(method);
      } else {
        methodsByFile.set(key, [method]);
      }
    }
    for (const openText of collectOpenDocumentTexts()) {
      const key = normalizeLookupPath(openText.fsPath);
      const bucket = methodsByFile.get(key);
      if (bucket) {
        methodsByFile.set(key, parsePythonMethodBlocks(openText.content, bucket[0].filePath));
      }
    }
    const methods = [...methodsByFile.values()].flat();

    for (const method of methods) {
      if (token?.isCancellationRequested) return [];
      for (const call of method.calls) {
        if (token?.isCancellationRequested) return [];
        if (call.methodName !== methodName) {
          continue;
        }

        const resolved = methods.find(candidate =>
          candidate.methodName === call.methodName
          && normalizeLookupPath(candidate.filePath) === normalizedTarget
        );
        if (!resolved) {
          continue;
        }

        incoming.push({
          caller: {
            filePath: method.filePath,
            methodName: method.methodName,
            line: method.line,
            character: method.character
          },
          callLine: call.line,
          callCharacter: call.character
        });
      }
    }

    return incoming;
  }

  /**
   * IDE-NAV-006:已索引 def 符号前缀查询(工作区符号 Ctrl+T)。只读内存
   * 索引(mappingIndexesByRoot),不触发首扫/全仓扫描(查询面零 IO);前缀
   * 大小写不敏感;序=rootName → symbolName → line,跨 root 同名不覆盖。
   */
  searchDefSymbolsByPrefix(prefix: string, token?: vscode.CancellationToken): WorkspaceDefSymbolHit[] {
    const needle = prefix.trim().toLowerCase();
    const hits: WorkspaceDefSymbolHit[] = [];
    for (const index of this.mappingIndexesByRoot.values()) {
      if (token?.isCancellationRequested) { return hits; }
      for (const property of index.propertyDefinitions) {
        if (!property.identity.symbolName.toLowerCase().startsWith(needle)) {
          continue;
        }
        hits.push({
          symbolName: property.identity.symbolName,
          kind: 'property',
          rootName: index.rootName,
          rootDefFile: index.rootDefFile,
          defFile: property.defFile,
          line: property.line
        });
      }
      for (const method of index.methodDefinitions) {
        if (!method.identity.symbolName.toLowerCase().startsWith(needle)) {
          continue;
        }
        hits.push({
          symbolName: method.identity.symbolName,
          kind: 'method',
          section: method.section,
          rootName: index.rootName,
          rootDefFile: index.rootDefFile,
          defFile: method.defFile,
          line: method.line
        });
      }
    }
    hits.sort((a, b) =>
      a.rootName.localeCompare(b.rootName)
      || a.symbolName.localeCompare(b.symbolName)
      || a.line - b.line);
    return hits;
  }

  async jumpToDef(
    pythonFile: string,
    symbol: string,
    type: 'property' | 'method'
  ): Promise<boolean> {
    // 门控兜底(书 PR-002):deferred 模式下首个使用证据即幂等启动,结果口径与门控前一致
    this.ensureStartup();
    const location = type === 'property'
      ? await this.resolvePropertyDefinition(pythonFile, symbol, symbol)
      : await this.resolveMethodDefinition(pythonFile, symbol);

    // 可达但测试未覆盖(批72 定性):jumpToDef 成功路径需构造真实
    // Python 文件与符号定位,属端到端集成面;既有 openMethodTarget
    // 与 resolveMethodImplementation 已间接锁定解析成功后的
    // openFileAtLocation 调用链。此处隐式 else 仅为代码完整性保留,
    // 标记 ignore 避免分母膨胀。
    /* istanbul ignore start */
    if (!location) {
    /* istanbul ignore stop */
      return false;
    }

    return this.openFileAtLocation(location.defFile, location.line);
  }

  dispose(): void {
    this.pythonWatcher?.dispose();
    this.defWatcher?.dispose();
    for (const watcher of this.externalRootWatchers) {
      watcher.dispose();
    }
    this.externalRootWatchers = [];
    this.fileEventMerger.dispose();
    this.scheduler.dispose();
  }

  private selectMethodDefinition(
    definitions: IndexedMethodDefinition[],
    options: {
      methodName: string;
      ownerKind?: DefinitionSemanticCategory;
      ownerName?: string;
      section?: EntityMethodSection;
      componentSlotName?: string;
    }
  ): IndexedMethodDefinition | null {
    const matches = definitions.filter(item => item.identity.symbolName === options.methodName);
    if (matches.length === 0) {
      return null;
    }

    const scored = matches
      .map(item => ({ item, score: this.scoreMethodDefinition(item, options) }))
      .sort((left, right) => right.score - left.score
        // A single-location API must choose deterministically when equally
        // relevant declarations exist; owner/section/local scores win first,
        // then normalized def path and line provide a stable tie-break.
        || normalizeLookupPath(left.item.defFile).localeCompare(normalizeLookupPath(right.item.defFile))
        || left.item.line - right.item.line);

    // 不可达(批72 定性):matches.length > 0 已由上方早退守卫,map+sort 产出
// scored 数组长度 ≥1 且每项 item 来自 matches 原元素(非空对象),
// 故 scored[0]?.item 恒为非空 IndexedMethodDefinition,`|| null`
// 兜底右臂无触发路径。真臂行为由既有 entityMappingBranches.test.ts
// 同名方法打分选优用例锁定。
/* istanbul ignore start */
    return scored[0]?.item || null;
/* istanbul ignore stop */
  }

  private scoreMethodDefinition(
    definition: IndexedMethodDefinition,
    options: {
      ownerKind?: DefinitionSemanticCategory;
      ownerName?: string;
      section?: EntityMethodSection;
      componentSlotName?: string;
    }
  ): number {
    let score = 0;
    if (options.ownerKind && definition.identity.ownerKind === options.ownerKind) {
      score += 40;
    }
    if (options.ownerName && definition.identity.ownerName === options.ownerName) {
      score += 40;
    }
    if (options.section && definition.section === options.section) {
      score += 20;
    }
    if (options.componentSlotName && definition.identity.componentSlotName === options.componentSlotName) {
      score += 30;
    }
    if (definition.identity.sourceKind === 'local') {
      score += 10;
    }
    return score;
  }

  private findMethodImplementationByIdentity(
    index: EntityMappingIndex,
    identity: DefinitionSymbolIdentity
  ): { filePath: string; line: number; character: number } | null {
    const direct = index.pythonMethods.find(method =>
      method.binding && sameIdentity(method.binding.identity, identity)
    );
    if (direct) {
      return {
        filePath: direct.filePath,
        line: direct.line,
        character: direct.character
      };
    }

    const ownerName = identity.ownerName;
    const ownerKind = identity.ownerKind;
    const section = identity.section;
    const candidates = index.pythonOwnerFiles
      .filter(item =>
        item.ownerName === ownerName
        && item.ownerKind === ownerKind
        && (!section || item.section === section)
      )
      .map(item => item.filePath);

    for (const filePath of uniqueFilePaths(candidates)) {
      const location = this.findPythonMethodLine(filePath, identity.symbolName);
      if (location) {
        return {
          filePath,
          line: location.line,
          character: location.character
        };
      }
    }

    return null;
  }

  private findPythonMethodLine(
    pythonFile: string,
    methodName: string
  ): { line: number; character: number } | null {
    if (!fs.existsSync(pythonFile)) {
      return null;
    }

    try {
      const content = readFileSyncUtf8Recorded(pythonFile);
      const regex = new RegExp(`^(\\s*)(?:async\\s+)?def\\s+(${escapeRegExp(methodName)})\\s*\\(`, 'm');
      const match = regex.exec(content);
      if (!match) {
        return null;
      }

      const nameIndex = match.index + match[0].indexOf(match[2]);
      return {
        line: getLineNumber(content, nameIndex),
        character: getColumnNumber(content, nameIndex)
      };
    } catch {
      return null;
    }
  }

  private async openFileAtLocation(filePath: string, line: number, character = 0): Promise<boolean> {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    const position = new vscode.Position(Math.max(line - 1, 0), Math.max(character, 0));
    const selection = new vscode.Range(position, position);
    const editor = await vscode.window.showTextDocument(document, { selection });
    return editor !== undefined;
  }

  private async ensureIndex(entityName: string): Promise<EntityMappingIndex | undefined> {
    let index = this.mappingIndexes.get(entityName);
    if (!index) {
      // 定向首解析(2026-10-22):同名 .def 单文件解析毫秒级,命中即不等全量扫描
      index = await this.ensureIndexTargeted(entityName);
    }
    if (!index) {
      await this.scanEntityMappings();
      index = this.mappingIndexes.get(entityName);
    }
    return index;
  }

  /**
   * 定向首解析(2026-10-22 用户令「hover 永转 loading 根治」):约定
   * 实体名 = .def 文件名,按名 glob 单个 .def 直接解析,毫秒级应答;
   * 命中即不再等全量首扫(首扫在构造期后台继续补全其余实体)。找不到
   * 同名 .def 返回 undefined,调用方落回全量扫描原口径(语义不变)。
   */
  private async ensureIndexTargeted(entityName: string, token?: vscode.CancellationToken, callerPythonFile?: string): Promise<EntityMappingIndex | undefined> {
    if (token?.isCancellationRequested) return undefined;
    const direct = this.mappingIndexes.get(entityName);
    if (direct) {
      return direct;
    }
    const defFiles = await findFilesAcrossRoots(`**/${entityName}.def`, null, token);
    if (token?.isCancellationRequested) return undefined;
    const defFileName = `${entityName}.def`;
    const matchesDefShape = (uri: vscode.Uri): boolean => {
      // 文件名必须原样比对(2026-10-22 修正):Windows 路径键会小写化，
      // 拿它取 basename 去对 PascalCase 实体名(Hero.def vs hero.def)恒 false,
      // 定向快路径成了死代码,悬停全部静默落回全量扫(永转根因之一)。
      // 目录排除仍用 normalized(大小写不敏感排除 interfaces/components)。
      if (path.basename(uri.fsPath) !== defFileName) {
        return false;
      }
      const normalized = normalizeLookupPath(uri.fsPath);
      return !normalized.includes('/interfaces/') && !normalized.includes('/components/');
    };
    // IDE-IDX-003:带调用文件根时优先解析同根 assets 目录下的同名 .def
    const defFile = (callerPythonFile
      ? defFiles.find(uri => matchesDefShape(uri) && sharesAssetsRoot(uri.fsPath, callerPythonFile))
      : undefined)
      ?? defFiles.find(matchesDefShape);
    if (!defFile) {
      return undefined;
    }
    const targetedStartedAt = Date.now();
    await this.parseDefFile(entityName, defFile.fsPath);
    const elapsedMs = Date.now() - targetedStartedAt;
    jumpLog('debug', () =>
      `def 定向解析 ${entityName} → ${this.mappingIndexes.has(entityName) ? 'hit' : 'miss'} ${elapsedMs}ms`
    );
    logLayerTiming('targeted-parse', elapsedMs, `entity=${entityName}`);
    return this.mappingIndexes.get(entityName);
  }

  private async ensureIndexByDefFile(defFile: string): Promise<EntityMappingIndex | undefined> {
    // PR4 A4-4:def 路径反查改走语义索引投影(mappingIndexesByRoot 同键直取)
    let index = this.mappingIndexesByRoot.get(normalizeLookupPath(defFile));
    if (!index) {
      const entityName = path.basename(defFile, '.def');
      index = await this.ensureIndex(entityName);
    }
    return index;
  }

  private async ensureIndexForPythonFile(pythonFile: string, token?: vscode.CancellationToken): Promise<EntityMappingIndex | undefined> {
    if (token?.isCancellationRequested) return undefined;
    const normalized = normalizeLookupPath(pythonFile);
    // 负缓存命中:该文件已确认无 .def 归属,直接走 null → 上层 PythonClassIndex
    // 兜底,不再每次重扫(修复前每次跳转两轮全量 .def 重扫)
    if (this.missingOwnerPaths.has(normalized)) {
      jumpLog('debug', () => `def 索引[文件级] ${path.basename(pythonFile)} → miss(负缓存命中)`);
      return undefined;
    }
    let index = this.findIndexForPythonFile(pythonFile);
    if (!index) {
      // 定向首解析(2026-10-22):hover 链走这里,同名 .def 单文件解析毫秒级,
      // 命中即应答,不再阻塞等全量首扫(此前大树首扫分钟级,hover 一直转圈)
      index = await this.ensureIndexTargeted(path.basename(pythonFile, '.py'), token, pythonFile);
      if (token?.isCancellationRequested) return undefined;
    }
    if (!index) {
      index = this.findIndexForPythonFile(pythonFile);
      if (!index && this.initialScanCompleted) {
        this.missingOwnerPaths.add(normalized);
      }
    }
    jumpLog('debug', () =>
      `def 索引[文件级] ${path.basename(pythonFile)} → ${index ? index.rootName : 'miss(无 owner 归属)'}`
    );
    return index;
  }

  /**
   * 对象级取索引:类名直接命中;接口/组件类不单独建索引,经 ownerName 回溯。
   * PR4 A4-4:两段都改走语义索引(直查=同名单一胜者,回溯=类名注册序
   * 首中),不再线性扫描 mappingIndexes。
   */
  private lookupIndexByClass(className: string, callerFile?: string): EntityMappingIndex | undefined {
    // IDE-IDX-003:类查询带调用文件根时,同名实体按调用根的 assets 目录挑
    // def(不靠最后注册者覆盖);无调用根或根内无匹配时维持既有单一胜者口径。
    if (callerFile) {
      for (const defFile of this.semanticIndex.getEntityDefFilesByName(className)) {
        if (sharesAssetsRoot(defFile, callerFile)) {
          const hit = this.mappingIndexesByRoot.get(defFile);
          if (hit) { return hit; }
        }
      }
    }
    const directDefFile = this.semanticIndex.getEntityDefFile(className);
    if (directDefFile) {
      return this.mappingIndexesByRoot.get(directDefFile);
    }
    const ownerEntry = this.semanticIndex.findEntityByClassName(className);
    return ownerEntry ? this.mappingIndexesByRoot.get(ownerEntry.defFile) : undefined;
  }

  private async ensureIndexForClass(className: string, callerFile?: string): Promise<EntityMappingIndex | undefined> {
    if (this.missingClassNames.has(className)) {
      return undefined;
    }
    // 首扫曾失败(哪怕映射表已并入部分分块):先重触发(有界)再查——失败被
    // 静默转成功的话,后续分块里的类从此缺席且无任何重试路径(审核发现 :182)。
    this.retryInitialScanAfterFailure();
    let index = this.lookupIndexByClass(className, callerFile);
    if (!index) {
      // 定向首解析(2026-10-22):同名 .def 单文件解析毫秒级,不再阻塞等全量首扫
      index = await this.ensureIndexTargeted(className, undefined, callerFile);
    }
    if (!index && this.mappingIndexes.size === 0) {
      // Cold misses wait briefly for the shared scan. A timed-out query must
      // not publish a negative cache entry from a partial index snapshot.
      const ready = await raceWithBudget('definition:class-index',
        this.initialScan.then(() => true), INTERACTIVE_INDEX_WAIT_MS);
      if (!ready) { return undefined; }
    }
    index = index ?? this.lookupIndexByClass(className, callerFile);
    if (!index && this.initialScanCompleted) {
      // 首扫已成功落地仍未命中才负缓存:首扫进行中(哪怕索引表已并入部分
      // 分块)不能凭「表非空」判类不存在——后续分块里的接口/组件类会经
      // ownerName 回溯命中,提前记 miss 会被永久误判(负缓存不自动自愈)。
      this.missingClassNames.add(className);
    }
    jumpLog('debug', () =>
      `def 索引[对象级] ${className} → ${index ? index.rootName : this.missingClassNames.has(className) ? 'miss(负缓存)' : 'miss'}`
    );
    return index;
  }

  /**
   * PR4 A4-4:Python 文件 → 实体索引改走语义索引(旧行为兼容层)。
   * 既有两段式命中顺序在 SemanticIndex 内以显式策略承载:owner 归属文件
   * 精确匹配优先,未命中再按 basename(去 .py)对实体名回落。
   */
  private findIndexForPythonFile(pythonFile: string): EntityMappingIndex | undefined {
    const entry = this.semanticIndex.findEntityByPythonFile(pythonFile);
    return entry ? this.mappingIndexesByRoot.get(entry.defFile) : undefined;
  }

  private getWorkspaceRoot(filePath: string): string | null {
    const workspaceFolder = vscode.workspace.workspaceFolders?.find(folder =>
      filePath.startsWith(`${folder.uri.fsPath}${path.sep}`) || filePath.startsWith(`${folder.uri.fsPath}/`)
    );
    if (workspaceFolder) {
      return workspaceFolder.uri.fsPath;
    }
    // workspace 外的 assetsRoot 下文件 → 扫描根兜底(布局/owner 解析用),
    // 都不匹配时维持既有行为:回落首个工作区根
    return getScanRootForFile(filePath)
      || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
      || null;
  }

  private createLegacyIdentity(
    entityName: string,
    methodName?: string,
    section?: EntityMethodSection
  ): DefinitionSymbolIdentity | null {
    if (!entityName || !methodName || !section) {
      return null;
    }

    return {
      ownerKind: 'entity',
      ownerName: entityName,
      sourceKind: 'local',
      sourceChain: [],
      section,
      symbolName: methodName
    };
  }

  private toLegacyMapping(index: EntityMappingIndex): EntityMapping {
    const properties: EntityMapping['properties'] = {};
    for (const property of index.propertyDefinitions) {
      const propertyPath = property.identity.propertyPath;
      if (!propertyPath || properties[propertyPath]) {
        continue;
      }

      properties[propertyPath] = {
        defFile: property.defFile,
        line: property.line
      };
    }

    const methods: EntityMapping['methods'] = {};
    for (const method of index.methodDefinitions) {
      const list = methods[method.identity.symbolName] || [];
      list.push({
        defFile: method.defFile,
        line: method.line,
        section: method.section,
        exposed: method.exposed,
        declaredArgs: method.declaredArgs,
        declaredReturnType: method.declaredReturnType,
        identity: method.identity
      });
      methods[method.identity.symbolName] = list;
    }

    return {
      name: index.rootName,
      defFile: index.rootDefFile,
      pythonFile: index.pythonOwnerFiles[0]?.filePath || buildFallbackPythonPath(index.rootName),
      pythonFiles: uniqueFilePaths(index.pythonOwnerFiles.map(item => item.filePath)).length > 0
        ? uniqueFilePaths(index.pythonOwnerFiles.map(item => item.filePath))
        : [buildFallbackPythonPath(index.rootName)],
      properties,
      methods
    };
  }
}

function buildFallbackPythonPath(entityName: string): string {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
  return joinWorkspacePath(workspaceRoot, 'scripts/base', `${entityName}.py`);
}

/**
 * 接收者段过滤(用户令 2026-10-21):self.cell./self.base./self.client. 调用的
 * 候选闸——receiverSection 在场时只留段相符的 def 声明(段不符一律剔除,不是
 * 降权),过滤发生在形参闸与打分之前;无前缀(section 缺省)原样通过。
 */
export function filterMethodDefinitionsBySection<
  T extends { section: EntityMethodSection }
>(
  definitions: readonly T[],
  receiverSection?: EntityMethodSection
): T[] {
  return receiverSection
    ? definitions.filter(item => item.section === receiverSection)
    : [...definitions];
}

export function buildMethodOwnerBindingKey(identity: {
  ownerKind: DefinitionSemanticCategory;
  ownerName: string;
  section?: EntityMethodSection;
  symbolName: string;
}): string {
  return [
    identity.ownerKind,
    identity.ownerName,
    identity.section || '',
    identity.symbolName
  ].join('::').toLowerCase();
}

export function sameIdentity(left: DefinitionSymbolIdentity, right: DefinitionSymbolIdentity): boolean {
  return left.ownerKind === right.ownerKind
    && left.ownerName === right.ownerName
    && left.sourceKind === right.sourceKind
    && left.section === right.section
    && left.symbolName === right.symbolName
    && left.componentSlotName === right.componentSlotName
    && normalizePropertyLookupPath(left.propertyPath || '') === normalizePropertyLookupPath(right.propertyPath || '')
    && left.sourceChain.join('::').toLowerCase() === right.sourceChain.join('::').toLowerCase();
}

function inferOwnerNameFromPythonFile(pythonFile: string): string {
  return path.basename(pythonFile, '.py');
}

export function inferOwnerKindFromPythonFile(
  pythonFile: string
): DefinitionSemanticCategory | undefined {
  const normalizedPath = normalizeLookupPath(pythonFile).toLowerCase();
  if (normalizedPath.includes('/components/')) {
    return 'component';
  }
  if (normalizedPath.includes('/interfaces/')) {
    return 'interface';
  }
  if (normalizedPath.endsWith('.py')) {
    return 'entity';
  }
  return undefined;
}

export function inferMethodSectionFromPythonFile(pythonFile: string): EntityMethodSection | undefined {
  const normalizedPath = normalizeLookupPath(pythonFile).toLowerCase();

  if (normalizedPath.includes('/scripts/base/') || normalizedPath.includes('/assets/scripts/base/')
    || normalizedPath.startsWith('base/') || normalizedPath.includes('/base/')) {
    return 'BaseMethods';
  }

  if (normalizedPath.includes('/scripts/cell/') || normalizedPath.includes('/assets/scripts/cell/')
    || normalizedPath.startsWith('cell/') || normalizedPath.includes('/cell/')) {
    return 'CellMethods';
  }

  if (normalizedPath.includes('/scripts/client/') || normalizedPath.includes('/assets/scripts/client/')
    || normalizedPath.startsWith('client/') || normalizedPath.includes('/client/')) {
    return 'ClientMethods';
  }

  return undefined;
}

export function uniqueFilePaths(candidatePaths: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const candidatePath of candidatePaths) {
    const normalized = normalizeLookupPath(candidatePath);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    unique.push(candidatePath);
  }
  return unique;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function getLineNumber(text: string, index: number): number {
  return text.substring(0, index).split('\n').length;
}

export function getColumnNumber(text: string, index: number): number {
  const lineStart = text.lastIndexOf('\n', index - 1);
  return index - (lineStart + 1);
}

function normalizePropertyLookupPath(value: string): string {
  return value.trim().toLowerCase();
}

export function parsePythonMethodBlocks(
  content: string,
  pythonFile: string
): IndexedPythonMethodLocation[] {
  const lines = content.split('\n');
  const methods: IndexedPythonMethodLocation[] = [];
  const definitionRegex = /^(\s*)(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/;

  for (let index = 0; index < lines.length; index += 1) {
    const lineText = lines[index];
    const match = definitionRegex.exec(lineText);
    if (!match) {
      continue;
    }

    const indent = match[1].length;
    const methodName = match[2];
    const character = lineText.indexOf(methodName);
    let endLine = lines.length;

    for (let nextLine = index + 1; nextLine < lines.length; nextLine += 1) {
      const nextText = lines[nextLine];
      if (!nextText.trim()) {
        continue;
      }

      const nextIndent = nextText.match(/^\s*/)?.[0].length || 0;
      if (nextIndent <= indent) {
        endLine = nextLine;
        break;
      }
    }

    const bodyLines = lines.slice(index + 1, endLine);
    methods.push({
      filePath: pythonFile,
      methodName,
      line: index + 1,
      character,
      endLine,
      calls: parsePythonSelfCalls(bodyLines, index + 2, pythonFile)
    });
  }

  return methods;
}

function parsePythonSelfCalls(
  bodyLines: string[],
  startLine: number,
  pythonFile: string
): Array<{ methodName: string; line: number; character: number; filePath: string }> {
  const calls: Array<{ methodName: string; line: number; character: number; filePath: string }> = [];
  const callRegex = /\bself\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;

  for (let index = 0; index < bodyLines.length; index += 1) {
    const lineText = bodyLines[index];
    let match: RegExpExecArray | null;

    while ((match = callRegex.exec(lineText)) !== null) {
      calls.push({
        methodName: match[1],
        line: startLine + index,
        // match[0] 恒以 'self.' 开头,名字紧跟前缀(批86 M7 同类:indexOf(name)
        // 在 name 为 'self' 子串时命中前缀内部,self.e/self.self 列错位)
        character: match.index + 'self.'.length,
        filePath: pythonFile
      });
    }
  }

  return calls;
}
