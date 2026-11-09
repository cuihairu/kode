import * as path from 'path';
import { getDirectChildElement, getDirectChildElements, getScalarChildValue } from './defParser';
import { getDefinitionEntries } from '../definitionWorkspace';
import { buildSchemaSourcePorts } from './databaseSchemaSource';
import {
  buildDatabaseSchemaSnapshotAsync,
  getDatabaseSchemaSnapshot,
  type DatabaseSchemaSnapshot
} from '../databaseSchema';
import {
  normalizePath,
  parseTypeAliases,
  resolveAliasType,
  resolveDbTypeLabel,
  type BuildContext,
  type SchemaBuildProgress
} from './databaseSchemaCore';

// ---- types.xml 类型的落库形态与使用处反扫(批134) ----
//
// 落库规则只有 schema 构建器这一套实现(别名解析/列展开/子表命名都在上面),
// 这里只把它的产出换成两种视图:
// - getTypeStorageShape:给 types.xml 悬停的形态数据(FIXED_DICT 顶层键 /
//   ARRAY 元素递归一层),不重复落库规则;
// - buildTypeStorageUsageIndex / findTypeStorageUsages:遍历实体快照,把每个
//   非合成列按 declaredType(原始 <Type> 文本)归档成「类型 → 真实落点」,
//   落点表/列直接取快照,types.xml 的 CodeLens 与悬停都消费它。

export type TypeStorageShape =
  | { kind: 'builtin'; rawType: string; typeName: string; columnType: string | null }
  | { kind: 'fixedDict'; rawType: string; topLevelKeys: string[] }
  | { kind: 'array'; rawType: string; element: TypeStorageShape | null }
  | { kind: 'unresolved'; rawType: string };

export interface TypeStorageUsage {
  /** 使用处所在实体(数组/FD 键落点跟随实体属性) */
  entity: string;
  /** 声明路径,如 itemId / items[] / skills[].count */
  property: string;
  /** 落点表名(tbl_...) */
  table: string;
  /** 落点列名(sm_...) */
  column: string;
  /** 声明处文件(实体 def 或 types.xml 的 FD 键声明) */
  defFile: string;
  /** 声明处行号(1 起) */
  line: number;
}

export function getTypeStorageShape(typesXmlPath: string | null, typeName: string): TypeStorageShape {
  const context: BuildContext = {
    workspaceRoot: '',
    entityDefsRoot: '',
    entityScriptsRoot: null,
    visitedDefinitions: new Set(),
    componentCache: new Map(),
    componentScopesCache: new Map(),
    typeAliases: parseTypeAliases(typesXmlPath, undefined, buildSchemaSourcePorts().readInputFile),
    entityHasCell: false,
    inputVersions: new Map(),
    // IDE-SCH-004:形态查询不产快照,消费记账落空 Map(占位,不入缓存)
    typeRegistryPath: null,
    typeRegistryConsumed: new Map<string, string>(),
    ports: buildSchemaSourcePorts()
  };
  return typeShapeOf(typeName, context, new Set());
}

function typeShapeOf(typeName: string, context: BuildContext, seen: Set<string>): TypeStorageShape {
  if (seen.has(typeName)) {
    // 别名环:引擎 resolveAlias 同样按 seen 短路,形态层面不再展开
    return { kind: 'unresolved', rawType: typeName };
  }
  seen.add(typeName);

  const resolved = resolveAliasType(typeName, context);
  if (resolved.kind === 'builtin') {
    return {
      kind: 'builtin',
      rawType: typeName,
      typeName: resolved.typeName,
      columnType: resolveDbTypeLabel(resolved.typeName)
    };
  }
  if (resolved.kind === 'fixedDict') {
    const propertiesNode = getDirectChildElement(resolved.node, 'Properties');
    return {
      kind: 'fixedDict',
      rawType: typeName,
      topLevelKeys: getDirectChildElements(propertiesNode).map(node => node.name)
    };
  }
  if (resolved.kind === 'array') {
    // 元素类型 = <of> 的文本(与 parseArrayElementDescriptor 同一读法)
    const rawElementType = getScalarChildValue(resolved.node, 'of');
    return {
      kind: 'array',
      rawType: typeName,
      element: rawElementType ? typeShapeOf(rawElementType, context, seen) : null
    };
  }
  return { kind: 'unresolved', rawType: typeName };
}

// IDE-SCH-008:按实体增量维护——usage 记录按实体存放,快照对象身份一致则复用
// 该实体的记录(修改一个实体只重建它自己,无关实体记录对象原样保留),
// 聚合索引由记录懒聚合,记录未变时聚合也复用。
interface TypeStorageUsageEntityRecord {
  snapshot: DatabaseSchemaSnapshot | null;
  usages: Array<{ typeName: string; usage: TypeStorageUsage }>;
}

let typeStorageUsageState: {
  key: string;
  entityRecords: Map<string, TypeStorageUsageEntityRecord>;
  index: Map<string, TypeStorageUsage[]> | null;
} | null = null;

function collectTypeStorageUsagesForSnapshot(snapshot: DatabaseSchemaSnapshot | null): Array<{ typeName: string; usage: TypeStorageUsage }> {
  const usages: Array<{ typeName: string; usage: TypeStorageUsage }> = [];
  if (!snapshot) {
    return usages;
  }
  for (const table of snapshot.tables) {
    for (const field of table.fields) {
      if (field.synthetic || !field.declaredType) {
        continue;
      }
      usages.push({
        typeName: field.declaredType,
        usage: {
          entity: snapshot.entityName,
          property: field.sourcePath,
          table: table.name,
          column: field.name,
          defFile: field.source.filePath,
          line: field.source.line
        }
      });
    }
  }
  return usages;
}

function refreshTypeStorageUsageRecord(workspaceRoot: string, entityName: string): boolean {
  const state = typeStorageUsageState;
  if (!state) {
    return false;
  }
  const snapshot = getDatabaseSchemaSnapshot(entityName, workspaceRoot);
  const existing = state.entityRecords.get(entityName);
  if (existing && existing.snapshot === snapshot) {
    return false; // 快照对象未变:该实体贡献的记录原样复用
  }
  state.entityRecords.set(entityName, {
    snapshot,
    usages: collectTypeStorageUsagesForSnapshot(snapshot)
  });
  return true;
}

/** IDE-AUD-013(F13):分阶段冷构建用的单实体刷新面——异步构建管线在单实体
 * 内部按预算让路(属性循环/组件/父链递归),中段取消经 gate 立即止步。
 * 返回 'cancelled' 即该实体未完整处理(记录不更新,调用方应止步不发布)。 */
async function refreshTypeStorageUsageRecordAsync(
  workspaceRoot: string,
  entityName: string,
  progress: SchemaBuildProgress,
  gate: () => Promise<boolean>
): Promise<'updated' | 'unchanged' | 'cancelled'> {
  const state = typeStorageUsageState;
  if (!state) {
    return 'cancelled'; // 状态已弃置:无法记录,调用方应止步
  }
  let cancelled = false;
  const snapshot = await buildDatabaseSchemaSnapshotAsync(entityName, workspaceRoot, {
    budgetMs: progress.budgetMs,
    progress,
    gate: async () => {
      if (!(await gate())) {
        cancelled = true;
        return false;
      }
      return true;
    }
  });
  if (cancelled) {
    return 'cancelled'; // 中段取消:未产出可用快照,不更新记录
  }
  const existing = state.entityRecords.get(entityName);
  if (existing && existing.snapshot === snapshot) {
    return 'unchanged'; // 快照对象未变:该实体贡献的记录原样复用
  }
  state.entityRecords.set(entityName, {
    snapshot,
    usages: collectTypeStorageUsagesForSnapshot(snapshot)
  });
  return 'updated';
}

export function invalidateTypeStorageUsageIndex(): void {
  typeStorageUsageState = null;
}

function rebuildTypeStorageUsageAggregate(state: NonNullable<typeof typeStorageUsageState>): Map<string, TypeStorageUsage[]> {
  const index = new Map<string, TypeStorageUsage[]>();
  for (const record of state.entityRecords.values()) {
    for (const { typeName, usage } of record.usages) {
      const usages = index.get(typeName) || [];
      usages.push(usage);
      index.set(typeName, usages);
    }
  }
  state.index = index;
  return index;
}

/** 后台任务派发器:渲染面不建索引,交后台线程外排队(extension 注册调度器) */
export type BackgroundSchemaTaskDispatcher = (run: () => Promise<void>) => Promise<void>;
let typeStorageUsageBackgroundDispatcher: BackgroundSchemaTaskDispatcher | null = null;

export function setTypeStorageUsageBackgroundDispatcher(dispatcher: BackgroundSchemaTaskDispatcher | null): void {
  typeStorageUsageBackgroundDispatcher = dispatcher;
}

const pendingTypeStorageColdBuildRoots = new Set<string>();
let typeStorageColdBuildChain: Promise<void> = Promise.resolve();
const typeStorageUsageIndexListeners = new Set<() => void>();

/** 冷构建完成(发布)监听:渲染面据此刷新(types.xml CodeLens 重渲染) */
export function onTypeStorageUsageIndexPublished(listener: () => void): () => void {
  typeStorageUsageIndexListeners.add(listener);
  return () => { typeStorageUsageIndexListeners.delete(listener); };
}

/** 测试面:等在途冷构建链排干 */
export async function flushTypeStorageUsageColdBuildForTests(): Promise<void> {
  while (pendingTypeStorageColdBuildRoots.size > 0) {
    await typeStorageColdBuildChain;
  }
}

/** 残留任务量规(P0-4b 审核重开 2026-10-28):在途冷构建根数(只读)。 */
export function getPendingTypeStorageColdBuildCount(): number {
  return pendingTypeStorageColdBuildRoots.size;
}

const defaultBackgroundDispatch: BackgroundSchemaTaskDispatcher = run =>
  new Promise<void>(resolve => {
    setImmediate(() => { void run().then(resolve, resolve); });
  });

/** IDE-SCH-009 只读反查面:聚合已发布则纯读返回——零快照探测,新鲜度由
 * 事件面(watcher→按实体替换/整表置空)承担。2026-10-28 审核整改:冷路径
 * (无状态)不再在交互线程整表构建——派发后台一次构建,本次渲染拿空表,
 * 构建完成后经 onTypeStorageUsageIndexPublished 通知渲染面刷新。 */
export function getTypeStorageUsageIndexReadOnly(workspaceRoot: string): Map<string, TypeStorageUsage[]> {
  if (typeStorageUsageState && typeStorageUsageState.key === workspaceRoot) {
    return typeStorageUsageState.index || rebuildTypeStorageUsageAggregate(typeStorageUsageState);
  }
  scheduleTypeStorageUsageColdBuild(workspaceRoot);
  return new Map();
}

function scheduleTypeStorageUsageColdBuild(workspaceRoot: string): void {
  if (pendingTypeStorageColdBuildRoots.has(workspaceRoot)) {
    return; // 同根冷构建在途:去重
  }
  pendingTypeStorageColdBuildRoots.add(workspaceRoot);
  const dispatch = typeStorageUsageBackgroundDispatcher ?? defaultBackgroundDispatch;
  typeStorageColdBuildChain = typeStorageColdBuildChain
    .then(() => dispatch(async () => {
      try {
        // IDE-REV-013:冷索引逐实体分阶段——不再单个 setImmediate 回调里同步
        // 遍历全部实体;预算让出宿主+取消检查,中途取消弃部分状态重新可调度
        const outcome = await buildTypeStorageUsageIndexPhased(workspaceRoot, {
          shouldContinue: () => !typeStorageColdBuildCancelFlags.has(workspaceRoot)
        });
        if (outcome.stopped && typeStorageUsageState?.key === workspaceRoot) {
          typeStorageUsageState = null; // 部分记录不可当聚合:弃置,下次查询重调度
        }
      } finally {
        pendingTypeStorageColdBuildRoots.delete(workspaceRoot);
        typeStorageColdBuildCancelFlags.delete(workspaceRoot);
      }
    }))
    .catch(() => {});
  void typeStorageColdBuildChain.then(() => {
    for (const listener of [...typeStorageUsageIndexListeners]) {
      listener();
    }
  });
}

// IDE-REV-013:调度面取消标记(键=根);在飞冷构建在实体边界看到即止步
const typeStorageColdBuildCancelFlags = new Set<string>();

/** IDE-REV-013:取消某根在飞 type storage 冷构建;无在飞构建返回 false */
export function cancelTypeStorageUsageColdBuild(workspaceRoot: string): boolean {
  if (!pendingTypeStorageColdBuildRoots.has(workspaceRoot)) {
    return false;
  }
  typeStorageColdBuildCancelFlags.add(workspaceRoot);
  return true;
}

/** IDE-REV-013:分阶段冷构建的让路与取消注入面 */
export interface TypeStorageUsageColdBuildOptions {
  /** 每实体边界(及每次让路后)调用;返回 false 即止步不发布 */
  shouldContinue?: () => boolean | Promise<boolean>;
  /** 让出宿主(缺省 setImmediate) */
  yieldControl?: () => Promise<void>;
  /** 连续执行时间预算(毫秒,超即让路;缺省 25ms,与诊断时间片同口径) */
  entityBudgetMs?: number;
}

/** IDE-REV-013:一次分阶段冷构建的结果量规(测试/观测面) */
export interface TypeStorageUsageColdBuildOutcome {
  /** 处理完成的实体数(止步前) */
  entities: number;
  /** 是否因取消止步(true=未发布聚合) */
  stopped: boolean;
  /** 让出宿主次数(真实让路面,非 beforeBuild 假闸门) */
  yields: number;
  /** 两次让路之间最长连续执行时长(毫秒)——最大连续阻塞量规 */
  maxSliceMs: number;
}

let lastTypeStorageColdBuildGauge: TypeStorageUsageColdBuildOutcome | null = null;

/** IDE-REV-013:读最近一次分阶段冷构建量规(测试面) */
export function getTypeStorageColdBuildGaugeForTests(): TypeStorageUsageColdBuildOutcome | null {
  return lastTypeStorageColdBuildGauge;
}

/**
 * IDE-REV-013:type storage 冷索引分阶段构建——逐实体刷新 usage 记录,
 * 实体边界检查取消;连续执行超过预算(缺省 25ms)让出宿主再续。止步
 * (取消)不发布聚合,部分记录由调用方裁断弃置。同步面
 * buildTypeStorageUsageIndex 保持查询/测试口径不变。
 */
export async function buildTypeStorageUsageIndexPhased(
  workspaceRoot: string,
  options: TypeStorageUsageColdBuildOptions = {}
): Promise<TypeStorageUsageColdBuildOutcome> {
  if (!typeStorageUsageState || typeStorageUsageState.key !== workspaceRoot) {
    typeStorageUsageState = { key: workspaceRoot, entityRecords: new Map(), index: null };
  }
  const state = typeStorageUsageState;
  const entries = getDefinitionEntries(workspaceRoot, 'entity').filter(entry => entry.exists);
  const liveEntities = new Set(entries.map(entry => entry.name));
  const shouldContinue = options.shouldContinue ?? (() => true);
  const yieldControl = options.yieldControl ?? (() => new Promise<void>(resolve => { setImmediate(resolve); }));
  const budgetMs = options.entityBudgetMs ?? 25;

  // IDE-AUD-013(F13):共享让路量规——单实体内部(属性循环/组件/父链递归)
  // 与实体边界让路记入同一把量规,最大连续片跨两者连续测量。
  const progress: SchemaBuildProgress = { sliceStart: Date.now(), budgetMs, yields: 0, maxSliceMs: 0 };
  const gate = async (): Promise<boolean> => {
    await yieldControl();
    return shouldContinue();
  };

  let entities = 0;
  let stopped = false;
  for (const entry of entries) {
    if (!(await shouldContinue())) {
      stopped = true; // 实体边界止步:后续实体不再处理
      break;
    }
    const status = await refreshTypeStorageUsageRecordAsync(workspaceRoot, entry.name, progress, gate);
    if (status === 'cancelled') {
      stopped = true; // 单实体内部让路后取消:该实体未完整处理,止步不发布
      break;
    }
    entities += 1;
    const now = Date.now();
    progress.maxSliceMs = Math.max(progress.maxSliceMs, now - progress.sliceStart);
    if (now - progress.sliceStart >= budgetMs) {
      progress.yields += 1;
      await yieldControl();
      if (!(await shouldContinue())) {
        stopped = true; // 让路后取消:续批前止步
        break;
      }
      progress.sliceStart = Date.now();
    }
  }

  const gauge: TypeStorageUsageColdBuildOutcome = {
    entities,
    stopped,
    yields: progress.yields,
    maxSliceMs: progress.maxSliceMs
  };
  lastTypeStorageColdBuildGauge = gauge;
  if (stopped) {
    return gauge; // 不清亡灵/不聚合:部分状态由调用方弃置
  }
  for (const name of [...state.entityRecords.keys()]) {
    if (!liveEntities.has(name)) { // 实体已不在定义清单:清掉亡灵记录
      state.entityRecords.delete(name);
    }
  }
  rebuildTypeStorageUsageAggregate(state);
  return gauge;
}

export function findTypeStorageUsagesReadOnly(workspaceRoot: string, typeName: string): TypeStorageUsage[] {
  return getTypeStorageUsageIndexReadOnly(workspaceRoot).get(typeName) || [];
}

/**
 * IDE-SCH-008 事件面:实体 def 变更后只替换该实体贡献的 usage 记录,
 * 其余实体的记录对象保持不变,聚合索引按需重聚(不全仓重建)。
 */
export function replaceTypeStorageUsageForEntity(workspaceRoot: string, entityName: string): void {
  if (!typeStorageUsageState || typeStorageUsageState.key !== workspaceRoot) {
    return; // 尚无索引:下一次查询本身就是全新构建
  }
  if (refreshTypeStorageUsageRecord(workspaceRoot, entityName)) {
    rebuildTypeStorageUsageAggregate(typeStorageUsageState); // 只重聚既有记录,不逐实体探快照
  }
}

export function buildTypeStorageUsageIndex(workspaceRoot: string): Map<string, TypeStorageUsage[]> {
  if (!typeStorageUsageState || typeStorageUsageState.key !== workspaceRoot) {
    typeStorageUsageState = { key: workspaceRoot, entityRecords: new Map(), index: null };
  }
  const state = typeStorageUsageState;

  // 逐实体按快照身份自愈:无关实体零成本复用,变更实体仅重建自身
  const entries = getDefinitionEntries(workspaceRoot, 'entity').filter(entry => entry.exists);
  let changed = false;
  const liveEntities = new Set(entries.map(entry => entry.name));
  for (const entry of entries) {
    if (refreshTypeStorageUsageRecord(workspaceRoot, entry.name)) {
      changed = true;
    }
  }
  for (const name of [...state.entityRecords.keys()]) {
    if (!liveEntities.has(name)) { // 实体已不在定义清单:清掉亡灵记录
      state.entityRecords.delete(name);
      changed = true;
    }
  }

  if (!changed && state.index) {
    return state.index;
  }
  return rebuildTypeStorageUsageAggregate(state);
}

export function findTypeStorageUsages(workspaceRoot: string, typeName: string): TypeStorageUsage[] {
  return buildTypeStorageUsageIndex(workspaceRoot).get(typeName) || [];
}

/**
 * Index persisted schema columns by their source line in a file.
 * This exposes fields contributed by FIXED_DICT keys and ARRAY element aliases
 * without maintaining a second type-to-column expansion algorithm.
 */
export function indexTypeStorageUsagesBySourceLine(
  workspaceRoot: string,
  sourceFile: string
): Map<number, TypeStorageUsage[]> {
  return indexTypeStorageUsageEntries(buildTypeStorageUsageIndex(workspaceRoot), sourceFile);
}

/** IDE-SCH-009:从已取到的聚合(通常只读面)按源码行编组,不触发任何构建 */
export function indexTypeStorageUsageEntries(
  index: Map<string, TypeStorageUsage[]>,
  sourceFile: string
): Map<number, TypeStorageUsage[]> {
  const sourceKey = normalizePath(path.resolve(sourceFile));
  const byLine = new Map<number, TypeStorageUsage[]>();
  const seen = new Set<string>();
  for (const typeUsages of index.values()) {
    for (const usage of typeUsages) {
      const key = `${normalizePath(path.resolve(usage.defFile))}:${usage.line}:${usage.entity}:${usage.table}:${usage.column}`;
      if (normalizePath(path.resolve(usage.defFile)) !== sourceKey || seen.has(key)) {
        continue;
      }
      seen.add(key);
      const lineUsages = byLine.get(usage.line) || [];
      lineUsages.push(usage);
      byLine.set(usage.line, lineUsages);
    }
  }
  return byLine;
}
