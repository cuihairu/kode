import * as path from 'path';
import * as vscode from 'vscode';
import {
  getDirectChildElement,
  getDirectChildElements,
  getScalarChildValue,
  parseDefDocument
} from './defParser';
import {
  findEntityDefinitionFile,
  getDefinitionEntries,
  getDefinitionWorkspaceLayout,
  getWorkspaceRootForDocument
} from './definitionWorkspace';
import { resolveDatabaseInterfaceConfig, type DatabaseInterfaceConfig } from './serverConfigMerge';
import { getRootConfigGeneration } from './rootConfigGeneration';
import { readSharedFileSnapshot } from './sharedFileSnapshot';
import type { SharedFileVersionRef } from './sharedFileSnapshot';
import {
  DB_TABLE_PREFIX,
  aliasDigestInMap,
  collectPersistentPropertiesForDefinition,
  dedupeSchemaTargets,
  deriveDatabaseTables,
  normalizePath,
  parseTypeAliases,
  parseTypeAliasesFromContent,
  resolveAliasType,
  resolveDbTypeLabel,
  resolveEntityHasCell,
  type BuildContext,
  type DatabaseBackend,
  type DefSourceRef,
  type RuntimeScope,
  type TypeAliasEntry,
  type PersistentPropertyDescriptor,
  type TableFieldDescriptor,
  type TableSchemaDescriptor
} from './databaseSchemaCore';

export interface DatabaseSchemaSnapshot {
  backend: DatabaseBackend;
  entityName: string;
  entitySource?: DefSourceRef;
  defFilePath?: string;
  tables: TableSchemaDescriptor[];
  tableIndex: Map<string, TableSchemaDescriptor>;
  /** 引擎配置 <dbmgr><databaseInterfaces><default> 读得的连接要素(未读得为 undefined) */
  database?: DatabaseInterfaceConfig;
  /**
   * IDE-SNP-006:构建时消费的共享快照输入清单(fsPath → 来源域+版本)。
   * IDE-REV-011:失效走事件面(watcher 定向摘除 + 编辑/关闭事件接线),
   * 查询热命中不再逐条目重读比对;清单仍供事件面匹配与对账面
   * (isDatabaseSchemaSnapshotInputStale)使用。缺失视为不过期(旧结果防御)。
   */
  inputVersions?: Readonly<Record<string, SharedFileVersionRef>>;
  /**
   * IDE-SNP-010:构建时的根配置 generation(扫描根集/运行域配置的代号)。
   * assetsRoot 或运行域配置变化后 generation 前进,旧快照即使文件一字未动
   * 也判过期;缺失视为不过期(身份面新增,旧结果防御,与 inputVersions 同口径)。
   */
  rootConfigGeneration?: number;
  /**
   * IDE-SCH-002:构建时的表前缀(运行域配置面)。缓存判过期时与当前配置值
   * 比对——配置变更无需依赖扩展层 watcher 的 generation bump 即刻失效;
   * 缺失视为不过期(防御面)。
   */
  tablePrefix?: string;
  /**
   * IDE-SCH-004:构建时消费的类型注册表文件(types.xml)。该文件在
   * inputVersions 清单里的版本漂移不直接判过期——退到 consumedTypeAliases
   * 摘要比对:没消费任何被改别名的实体保持命中;缺失视为不过期(防御面)。
   */
  typeRegistryPath?: string;
  /** IDE-SCH-004:消费的别名 → 构建期解析摘要(b:内建/d:字典/a:数组/u:未解析) */
  consumedTypeAliases?: Readonly<Record<string, string>>;
}


// IDE-SCH-002:schema 快照缓存(键=规范化根+实体名,LRU 有界)
const DATABASE_SCHEMA_CACHE_LIMIT = 32;
const databaseSchemaCache = new Map<string, DatabaseSchemaSnapshot>();
let databaseSchemaCacheHits = 0;
let databaseSchemaCacheMisses = 0;

/** 测试面:清缓存与计数 */
export function clearDatabaseSchemaCacheForTests(): void {
  databaseSchemaCache.clear();
  databaseSchemaCacheHits = 0;
  databaseSchemaCacheMisses = 0;
}

/** 测试/观测面:缓存命中/未命中/在册条目数/容量 */
export function getDatabaseSchemaCacheStatsForTests(): {
  hits: number;
  misses: number;
  size: number;
  capacity: number;
} {
  return {
    hits: databaseSchemaCacheHits,
    misses: databaseSchemaCacheMisses,
    size: databaseSchemaCache.size,
    capacity: DATABASE_SCHEMA_CACHE_LIMIT
  };
}

/** IDE-SCH-003:按 def 依赖失效——文件变更事件到达时,只摘除输入清单里消费过
 * 该文件的缓存条目(它及其依赖实体在下次查询时重建),无关实体的条目原样
 * 保留继续命中(同一对象),不清整缓存。返回摘除条目数。懒过期(逐条目
 * 比对清单版本)仍是安全网;本面把失效从查询时提前到事件时。 */
export function invalidateDatabaseSchemaCacheForFiles(filePaths: readonly string[]): number {
  if (filePaths.length === 0 || databaseSchemaCache.size === 0) { return 0; }
  const targets = new Set(filePaths.map(filePath => normalizePath(filePath)));
  let dropped = 0;
  for (const [key, snapshot] of [...databaseSchemaCache.entries()]) {
    const manifestPaths = Object.keys(snapshot.inputVersions ?? {});
    if (manifestPaths.some(manifestPath => targets.has(normalizePath(manifestPath)))) {
      databaseSchemaCache.delete(key);
      dropped += 1;
    }
  }
  return dropped;
}

/** IDE-SCH-004:按 types.xml 依赖失效——注册表文件变更事件到达时,对当前
 * 内容解析一遍别名表,只摘除「消费了被改别名」的条目(相关列下次查询重
 * 建),没消费该别名的实体条目原样保留继续命中。注册表读不到(删除)时
 * 该注册表下所有带消费记录的条目全部摘除。返回摘除条目数。 */
export function invalidateDatabaseSchemaCacheForTypeRegistry(typesXmlPath: string): number {
  if (databaseSchemaCache.size === 0) { return 0; }
  const targetIdentity = normalizePath(typesXmlPath);
  const freshSnapshot = readSharedFileSnapshot(typesXmlPath);
  const freshAliases = freshSnapshot
    ? parseTypeAliasesFromContent(freshSnapshot.content, typesXmlPath)
    : null;
  let dropped = 0;
  for (const [key, snapshot] of [...databaseSchemaCache.entries()]) {
    if (!snapshot.typeRegistryPath
        || normalizePath(snapshot.typeRegistryPath) !== targetIdentity
        || !snapshot.consumedTypeAliases) {
      continue;
    }
    const consumed = Object.entries(snapshot.consumedTypeAliases);
    const changed = freshAliases === null
      ? consumed.some(([, digest]) => digest !== 'u') // 注册表没了:消费过已解析别名者过期
      : consumed.some(([aliasName, digest]) => aliasDigestInMap(aliasName, freshAliases) !== digest);
    if (changed) {
      databaseSchemaCache.delete(key);
      dropped += 1;
    }
  }
  return dropped;
}

/**
 * IDE-REV-011:热命中校验(零文件读取)——只比构建期记录的运行域配置轴
 * (rootConfigGeneration/tablePrefix,均为内存值,比对不触文件系统)。
 * 输入文件内容漂移不在查询路径懒重读(原逐条目再读比对降级为安全网
 * isDatabaseSchemaSnapshotInputStale,仅供对账/测试面调用);失效职责在
 * 事件面:磁盘域变更走 entityMapping watcher(IDE-SCH-003/004 定向摘除),
 * 编辑器脏文档编辑/关闭走 extension.ts 事件接线(IDE-REV-011)。
 */
function isDatabaseSchemaSnapshotConfigStale(snapshot: DatabaseSchemaSnapshot): boolean {
  if (snapshot.rootConfigGeneration !== undefined &&
      snapshot.rootConfigGeneration !== getRootConfigGeneration()) {
    return true;
  }
  // IDE-SCH-002:表前缀是运行域配置输入,构建值与当前值不符即过期(缓存面
  // 不依赖扩展层 watcher 的 generation bump,单测/离线口径同样成立)
  if (snapshot.tablePrefix !== undefined && snapshot.tablePrefix !== resolveSchemaTablePrefix()) {
    return true;
  }
  return false;
}

/** IDE-REV-011:全量失效(无 uri 的事件面兜底)——事件不带路径时无法按
 * 清单匹配,整体让位最安全(重建成本可接受,正确性优先)。返回摘除条目数。 */
export function invalidateDatabaseSchemaCacheForAll(): number {
  const dropped = databaseSchemaCache.size;
  databaseSchemaCache.clear();
  return dropped;
}

/** 缓存新鲜命中则返回条目(LRU 触碰+命中计数);脏条目删除;未命中 undefined */
function peekFreshSchemaCache(
  cacheKey: string
): DatabaseSchemaSnapshot | null | undefined {
  const cached = databaseSchemaCache.get(cacheKey);
  if (cached && !isDatabaseSchemaSnapshotConfigStale(cached)) {
    // LRU 触碰:重插到队尾
    databaseSchemaCache.delete(cacheKey);
    databaseSchemaCache.set(cacheKey, cached);
    databaseSchemaCacheHits += 1;
    return cached;
  }
  if (cached) {
    databaseSchemaCache.delete(cacheKey);
  }
  return undefined;
}

/**
 * 2026-10-28 审核整改(SCH-006):构建管线阶段生成器——阶段间 yield 是
 * 异步驱动的闸点(让出宿主+检查取消);同步查询面直通驱动(不暂停,行为
 * 与原整段函数一致)。取消止步 = 生成器不再推进,缓存不发布部分结果。
 */
function* schemaBuildPhases(
  entityName: string,
  target: string | Pick<vscode.TextDocument, 'fileName'> | undefined,
  workspaceRoot: string,
  cacheKey: string
): Generator<'phase-gate', DatabaseSchemaSnapshot | null, void> {
  const layout = getDefinitionWorkspaceLayout(workspaceRoot);
  // 不可达(批62 定性):getDefinitionWorkspaceLayout 的 entityDefsRoot =
  // 已存在候选 || 候选[0],候选列表恒含非空相对路径,该值只能是字符串。
  /* istanbul ignore start */
  if (!layout.entityDefsRoot) {
    return null;
  }
  /* istanbul ignore stop */
  yield 'phase-gate'; // 闸点 1:布局发现后


  const defFilePath = findEntityDefinitionFile(entityName, target);
  if (!defFilePath) {
    return null;
  }
  yield 'phase-gate'; // 闸点 2:def 定位后

  // IDE-SNP-003:def 文本走共享快照——打开的脏缓冲优先,未打开磁盘补载
  // IDE-SNP-006:入口读得的来源域+版本进清单(后续遍历读点由 context 记录)
  const entityInput = readSharedFileSnapshot(defFilePath);
  if (!entityInput) {
    return null;
  }
  const entityContent = entityInput.content;
  yield 'phase-gate'; // 闸点 3:def 读取后

  const entityDocument = parseDefDocument(entityContent);
  if (!entityDocument.root) {
    return null;
  }

  const buildContext: BuildContext = {
    workspaceRoot,
    entityDefsRoot: layout.entityDefsRoot,
    entityScriptsRoot: layout.entityScriptsRoot,
    visitedDefinitions: new Set<string>(),
    componentCache: new Map<string, PersistentPropertyDescriptor[]>(),
    componentScopesCache: new Map<string, RuntimeScope[]>(),
    typeAliases: new Map<string, TypeAliasEntry>(),
    entityHasCell: resolveEntityHasCell(entityName, workspaceRoot, layout),
    inputVersions: new Map<string, SharedFileVersionRef>([
      [defFilePath, { source: entityInput.source, version: entityInput.version }]
    ]),
    typeRegistryPath: layout.typesXmlPath,
    typeRegistryConsumed: new Map<string, string>()
  };
  buildContext.typeAliases = parseTypeAliases(layout.typesXmlPath, buildContext.inputVersions);
  yield 'phase-gate'; // 闸点 4:类型注册表解析后
  const entitySource: DefSourceRef = {
    filePath: defFilePath,
    line: 1,
    path: entityName,
    category: 'entity'
  };
  const properties = collectPersistentPropertiesForDefinition(
    entityName,
    defFilePath,
    'entity',
    buildContext
  );
  yield 'phase-gate'; // 闸点 5:属性收集(含组件/父链递归)后
  // IDE-SCH-001:表/列推导走纯函数面——输入收集(文件/配置/布局)留在本快照
  // 面,推导本身不读配置不读文件(可缓存/可离线,SCH-002 的缓存前置)
  const effectiveTablePrefix = resolveSchemaTablePrefix();
  const derived = deriveDatabaseTables({
    entityName,
    defFilePath,
    properties,
    hasCellContent: buildContext.entityHasCell,
    tablePrefix: effectiveTablePrefix
  });
  // 批131 用户令:连接信息直接读 KBEngine 自身配置,SQL 与悬停带真实库表名
  const database = resolveDatabaseInterfaceConfig() ?? undefined;

  const snapshot: DatabaseSchemaSnapshot = {
    backend: 'mysql',
    entityName,
    entitySource,
    defFilePath,
    tables: derived.tables,
    tableIndex: derived.tableIndex,
    database,
    // IDE-SNP-010:根配置 generation 记入快照身份(assetsRoot/运行域配置
    // 变化后旧结果判过期,与文件版本清单双轴并行)
    rootConfigGeneration: getRootConfigGeneration(),
    // IDE-SCH-002:表前缀记入身份(配置面输入,缓存判过期直接比对)
    tablePrefix: effectiveTablePrefix,
    // IDE-SCH-004:类型注册表身份——消费的别名与解析摘要;注册表文件版本
    // 漂移时按摘要比对,未消费的实体不受别的别名变更牵连
    ...(buildContext.typeRegistryPath
      ? {
          typeRegistryPath: buildContext.typeRegistryPath,
          consumedTypeAliases: Object.fromEntries(buildContext.typeRegistryConsumed)
        }
      : {}),
    ...(buildContext.inputVersions.size > 0
      ? { inputVersions: Object.fromEntries(buildContext.inputVersions) }
      : {})
  };
  // IDE-SCH-002:入缓存必须有输入清单(否则过期判定永假,会喂旧表)
  if (cacheKey && snapshot.inputVersions) {
    databaseSchemaCache.set(cacheKey, snapshot);
    if (databaseSchemaCache.size > DATABASE_SCHEMA_CACHE_LIMIT) {
      const oldest = databaseSchemaCache.keys().next().value;
      if (oldest !== undefined) {
        databaseSchemaCache.delete(oldest);
      }
    }
  }
  return snapshot;
}

export function getDatabaseSchemaSnapshot(
  entityName: string,
  target?: string | Pick<vscode.TextDocument, 'fileName'>
): DatabaseSchemaSnapshot | null {
  const workspaceRoot = typeof target === 'string'
    ? target
    : getWorkspaceRootForDocument(target);

  // IDE-SCH-002:schema 缓存带实体与根身份——键 = 规范化根 + 实体名,A/B 两
  // 个根的同名实体各自一份,不共用单例;条目按 SNP-006/010 双轴判过期
  // (inputVersions/rootConfigGeneration),文件或根配置变了重建,不喂旧表。
  // null 结果不入缓存(缺 def 是可变状态,watcher/磁盘演进即刻可见)。
  const cacheKey = workspaceRoot ? `${normalizePath(workspaceRoot)}\u0000${entityName}` : '';
  if (cacheKey) {
    const cached = peekFreshSchemaCache(cacheKey);
    if (cached) { return cached; }
  }
  databaseSchemaCacheMisses += 1;

  if (!workspaceRoot) {
    return null;
  }
  // 同步直通驱动:阶段 yield 只是异步面的闸点,同步面一口气跑完(行为不变)
  const iterator = schemaBuildPhases(entityName, target, workspaceRoot, cacheKey);
  let step = iterator.next();
  while (!step.done) {
    step = iterator.next();
  }
  return step.value;
}

/** 异步构建闸:阶段间回调——返回 false 即取消止步(不发布缓存) */
export interface SchemaBuildGateOptions {
  gate?: () => boolean | Promise<boolean>;
}

// IDE-REV-012:在飞后台构建登记(键=根+实体,同 getDatabaseSchemaSnapshot)
interface SchemaBuildFlight {
  promise: Promise<DatabaseSchemaSnapshot | null>;
  cancel(): void;
}
const schemaBuildFlights = new Map<string, SchemaBuildFlight>();

const schemaCacheKeyFor = (
  entityName: string,
  target?: string | Pick<vscode.TextDocument, 'fileName'>
): string => {
  const workspaceRoot = typeof target === 'string'
    ? target
    : getWorkspaceRootForDocument(target);
  return workspaceRoot ? `${normalizePath(workspaceRoot)}\u0000${entityName}` : '';
};

/**
 * IDE-REV-012:已发布快照只读面——只查缓存,绝不触发构建(命中走 LRU 触碰
 * 与命中计数;未命中返回 null 且不记 miss)。属性 hover 冷查询走本面拿不到
 * 就调度后台构建(scheduleDatabaseSchemaSnapshotBuild),发布后下一次查询命中。
 */
export function peekPublishedDatabaseSchemaSnapshot(
  entityName: string,
  target?: string | Pick<vscode.TextDocument, 'fileName'>
): DatabaseSchemaSnapshot | null {
  const cacheKey = schemaCacheKeyFor(entityName, target);
  if (!cacheKey) {
    return null;
  }
  return peekFreshSchemaCache(cacheKey) ?? null;
}

/**
 * IDE-REV-012:调度已发布快照的后台构建(去重+可取消)——同一实体在飞构建
 * 复用同一 Promise;取消只在发布前止步,不影响已发布结果。调用方
 * fire-and-forget 即可,缓存发布由构建面(schemaBuildPhases 收尾)完成。
 */
export function scheduleDatabaseSchemaSnapshotBuild(
  entityName: string,
  target?: string | Pick<vscode.TextDocument, 'fileName'>,
  options: SchemaBuildGateOptions = {}
): Promise<DatabaseSchemaSnapshot | null> {
  const cacheKey = schemaCacheKeyFor(entityName, target);
  const flight = cacheKey ? schemaBuildFlights.get(cacheKey) : undefined;
  if (flight) {
    return flight.promise;
  }
  let cancelled = false;
  const externalGate = options.gate;
  const gate = async (): Promise<boolean> => {
    if (externalGate) {
      if (!(await externalGate())) {
        return false;
      }
    } else {
      await new Promise<void>(resolve => { setImmediate(resolve); });
    }
    return !cancelled;
  };
  const promise = buildDatabaseSchemaSnapshotAsync(entityName, target, { gate });
  if (cacheKey) {
    schemaBuildFlights.set(cacheKey, { promise, cancel: () => { cancelled = true; } });
    void promise.then(() => { schemaBuildFlights.delete(cacheKey); }, () => { schemaBuildFlights.delete(cacheKey); });
  }
  return promise;
}

/** IDE-REV-012:取消某实体的在飞后台构建(发布前止步);无在飞构建返回 false */
export function cancelDatabaseSchemaSnapshotBuild(
  entityName: string,
  target?: string | Pick<vscode.TextDocument, 'fileName'>
): boolean {
  const cacheKey = schemaCacheKeyFor(entityName, target);
  const flight = cacheKey ? schemaBuildFlights.get(cacheKey) : undefined;
  if (!flight) {
    return false;
  }
  flight.cancel();
  return true;
}

/**
 * 2026-10-28 审核整改(SCH-006):异步构建面——同 schemaBuildPhases 管线,
 * 阶段间过闸(让出宿主+取消检查)。后台预热走本面:冷构建不再整段占住
 * 宿主,取消在构建中段即刻止步;缓存命中口径与同步面一致。
 */
export async function buildDatabaseSchemaSnapshotAsync(
  entityName: string,
  target?: string | Pick<vscode.TextDocument, 'fileName'>,
  options: SchemaBuildGateOptions = {}
): Promise<DatabaseSchemaSnapshot | null> {
  const workspaceRoot = typeof target === 'string'
    ? target
    : getWorkspaceRootForDocument(target);
  const cacheKey = workspaceRoot ? `${normalizePath(workspaceRoot)}\u0000${entityName}` : '';
  if (cacheKey) {
    const cached = peekFreshSchemaCache(cacheKey);
    if (cached) { return cached; }
  }
  databaseSchemaCacheMisses += 1;
  if (!workspaceRoot) {
    return null;
  }
  // 缺省闸:让出宿主(setImmediate)不取消——异步面默认即不整段阻塞
  const gate = options.gate ?? (async () => {
    await new Promise<void>(resolve => { setImmediate(resolve); });
    return true;
  });
  const iterator = schemaBuildPhases(entityName, target, workspaceRoot, cacheKey);
  for (;;) {
    const step = iterator.next();
    if (step.done) {
      return step.value;
    }
    const proceed = await gate();
    if (!proceed) {
      return null; // 中段取消:生成器不再推进,缓存不发布
    }
  }
}


/**
 * IDE-SNP-006:按清单判 schema 快照是否过期——运行域配置轴漂移即过期
 * (IDE-SNP-010 rootConfigGeneration / IDE-SCH-002 tablePrefix),任一记录
 * 条目再读后消失或来源域/版本漂移也即过期;无清单的旧快照对文件轴视为
 * 不过期(防御面)。
 * IDE-REV-011:本函数是完整校验(含输入文件再读),已不在查询热路径调用
 * ——热命中走零读取的 isDatabaseSchemaSnapshotConfigStale,文件漂移由事件
 * 面失效;本面保留为对账/测试安全网。
 */
export function isDatabaseSchemaSnapshotStale(snapshot: DatabaseSchemaSnapshot): boolean {
  if (isDatabaseSchemaSnapshotConfigStale(snapshot)) {
    return true;
  }
  return isDatabaseSchemaSnapshotInputStale(snapshot);
}

/**
 * IDE-REV-011:输入清单再读校验(安全网/对账面)——对清单逐条目重读文件
 * 内容比对来源域与版本,任一漂移即过期。有文件读取副作用,禁止在查询
 * 热路径调用(热命中用 isDatabaseSchemaSnapshotConfigStale + 事件面失效)。
 */
export function isDatabaseSchemaSnapshotInputStale(snapshot: DatabaseSchemaSnapshot): boolean {
  if (!snapshot.inputVersions) {
    return false;
  }
  const registryIdentity = snapshot.typeRegistryPath ? normalizePath(snapshot.typeRegistryPath) : null;
  for (const [filePath, recorded] of Object.entries(snapshot.inputVersions)) {
    const current = readSharedFileSnapshot(filePath);
    if (!current || current.source !== recorded.source || current.version !== recorded.version) {
      // IDE-SCH-004:类型注册表文件漂移不整判过期——退到消费别名摘要比对,
      // 没消费任何被改别名的实体保持新鲜(改 SCORE 不牵连只用 ITEM_ID 的)
      if (registryIdentity !== null && normalizePath(filePath) === registryIdentity
          && snapshot.consumedTypeAliases) {
        if (!current) {
          // 注册表整个没了:只有消费过已解析别名(非 'u')的实体才过期
          const consumedResolved = Object.values(snapshot.consumedTypeAliases)
            .some(digest => digest !== 'u');
          if (!consumedResolved) {
            continue;
          }
        } else {
          const freshAliases = parseTypeAliasesFromContent(current.content, filePath);
          const stillConsumesSame = Object.entries(snapshot.consumedTypeAliases)
            .every(([aliasName, digest]) => aliasDigestInMap(aliasName, freshAliases) === digest);
          if (stillConsumesSame) {
            continue;
          }
        }
      }
      return true;
    }
  }
  return false;
}

// 渲染版式锚点(TABLE 行 / 字段行)与 renderDatabaseSchema 同源:定位跳转与
// 悬停都从这里取,不再各处手写镜像行数(批133 用户令:版式改版式,定位
// 就跟着失效)。字段行允许前导空白(友好版式里列行缩进),但首 token 后必须
// 是空白——SQL 行的 `SQL:` 冒号与中文分组标题都不会误命中。
const DATABASE_SCHEMA_TABLE_ANCHOR = /^\s*TABLE\s+([A-Za-z0-9_]+)/;
const DATABASE_SCHEMA_FIELD_LINE = /^\s*([A-Za-z0-9_]+)\s+/;

export function databaseSchemaFieldLineName(lineText: string): string | null {
  if (DATABASE_SCHEMA_TABLE_ANCHOR.test(lineText)) {
    return null;
  }
  const match = DATABASE_SCHEMA_FIELD_LINE.exec(lineText);
  return match ? match[1] : null;
}

export function findDatabaseSchemaFieldAtPosition(
  document: vscode.TextDocument,
  position: vscode.Position
): { table: string; field?: string } | null {
  const lineText = document.lineAt(position.line).text;
  const tableMatch = DATABASE_SCHEMA_TABLE_ANCHOR.exec(lineText);
  if (tableMatch) {
    return { table: tableMatch[1] };
  }

  const field = databaseSchemaFieldLineName(lineText);
  if (!field) {
    return null;
  }

  for (let currentLine = position.line - 1; currentLine >= 0; currentLine -= 1) {
    const currentTableMatch = DATABASE_SCHEMA_TABLE_ANCHOR.exec(document.lineAt(currentLine).text);
    if (currentTableMatch) {
      return {
        table: currentTableMatch[1],
        field
      };
    }
  }

  return null;
}

export function findDatabaseSchemaSourceLocation(
  snapshot: DatabaseSchemaSnapshot,
  tableName: string,
  fieldName?: string
): DefSourceRef | null {
  const table = snapshot.tableIndex.get(tableName);
  if (!table) {
    return null;
  }

  if (!fieldName) {
    return table.source;
  }

  return table.fields.find(field => field.name === fieldName)?.source || null;
}

export function findDatabaseSchemaTargetsForSource(
  snapshot: DatabaseSchemaSnapshot,
  filePath: string,
  sourcePath: string
): Array<{ tableName: string; fieldName?: string }> {
  const targets: Array<{ tableName: string; fieldName?: string }> = [];
  const normalizedFilePath = normalizePath(filePath);

  for (const table of snapshot.tables) {
    if (
      normalizePath(table.source.filePath) === normalizedFilePath
      && (
        table.source.path === sourcePath
        || table.source.path.startsWith(`${sourcePath}.`)
      )
    ) {
      targets.push({ tableName: table.name });
    }

    for (const field of table.fields) {
      if (
        normalizePath(field.source.filePath) === normalizedFilePath
        && (
          field.sourcePath === sourcePath
          || field.sourcePath.startsWith(`${sourcePath}.`)
        )
      ) {
        targets.push({ tableName: table.name, fieldName: field.name });
      }
    }
  }

  return dedupeSchemaTargets(targets);
}

export interface PropertyDatabaseStorageTarget {
  tableName: string;
  fieldName?: string;
  /** 命中列的全量描述(类型/长度/默认值),悬停拼 DDL 摘要用 */
  field?: TableFieldDescriptor;
  /** 命中子表的全量描述(ARRAY/组件槽),悬停说明去向与 parentID 关联用 */
  table?: TableSchemaDescriptor;
}

export interface PropertyDatabaseStorageInfo {
  entityName: string;
  /** 引擎配置读得的连接要素;未读得为 undefined,悬停只给表级全名 */
  database?: DatabaseInterfaceConfig;
  targets: PropertyDatabaseStorageTarget[];
}

/**
 * def 属性的数据库存储落点(2026-10-13 用户令:Persistent 字段悬停展示在
 * 数据库中的名字)。按属性路径查快照目标:标量/向量/FIXED_DICT 键链出
 * 列名(sm_ 前缀),ARRAY/组件槽出子表;types.xml 别名在快照构建时已沿
 * 别名链展开。聚合只按属性路径、不按来源文件过滤——别名/组件结构的
 * 子列 source.filePath 是 types.xml/组件 def(结构定义文件),schema 反向
 * 跳转才需要严格文件口径。非持久属性不建表无目标,返回 null。
 * 批131:目标带全量列/表描述与连接要素,悬停拼 db.table.column 全名。
 */
export function describePropertyDatabaseStorage(
  entityName: string,
  propertyName: string,
  target?: string | Pick<vscode.TextDocument, 'fileName'>
): PropertyDatabaseStorageInfo | null {
  const snapshot = getDatabaseSchemaSnapshot(entityName, target);
  return describeTargetsFromPublishedSnapshot(snapshot, propertyName);
}

/**
 * IDE-REV-012:属性 hover 冷查询面——只读已发布快照,绝不同步构建。
 * 冷/失效 miss 调度后台构建(可取消、阶段间让出宿主)后返回 null(悬停
 * 不出存储行);发布后下一次查询命中出完整字段说明。
 */
export function describePropertyDatabaseStoragePublished(
  entityName: string,
  propertyName: string,
  target?: string | Pick<vscode.TextDocument, 'fileName'>
): PropertyDatabaseStorageInfo | null {
  const snapshot = peekPublishedDatabaseSchemaSnapshot(entityName, target);
  if (!snapshot) {
    scheduleDatabaseSchemaSnapshotBuild(entityName, target);
    return null;
  }
  return describeTargetsFromPublishedSnapshot(snapshot, propertyName);
}

/** 从已发布快照抽属性存储目标(describePropertyDatabaseStorage 共用体) */
function describeTargetsFromPublishedSnapshot(
  snapshot: DatabaseSchemaSnapshot | null,
  propertyName: string
): PropertyDatabaseStorageInfo | null {
  if (!snapshot) {
    return null;
  }

  const targets: PropertyDatabaseStorageTarget[] = [];
  for (const table of snapshot.tables) {
    if (
      table.source.path === propertyName
      || table.source.path.startsWith(`${propertyName}.`)
    ) {
      targets.push({ tableName: table.name, table });
    }

    for (const field of table.fields) {
      if (
        field.sourcePath === propertyName
        || field.sourcePath.startsWith(`${propertyName}.`)
      ) {
        targets.push({ tableName: table.name, fieldName: field.name, field });
      }
    }
  }

  if (targets.length === 0) {
    return null;
  }

  return {
    entityName: snapshot.entityName,
    database: snapshot.database,
    targets: dedupeSchemaTargets(targets)
  };
}

// 表名反引号引用(粘贴进外部 MySQL 客户端不撞保留字);库名读得时带库前缀
export function quoteSchemaTableName(snapshot: DatabaseSchemaSnapshot, tableName: string): string {
  return quoteTableName(snapshot.database, tableName);
}

function quoteTableName(database: DatabaseInterfaceConfig | undefined, tableName: string): string {
  return database ? `\`${database.databaseName}\`.\`${tableName}\`` : `\`${tableName}\``;
}

/** 引擎结构列(id/sm_autoLoad/parentID/位置朝向)之外的属性列 */
function propertyColumnsOf(table: TableSchemaDescriptor): TableFieldDescriptor[] {
  return table.fields.filter(field => !field.synthetic);
}

/**
 * 属性列集 SELECT(批B):只列 def 属性落成的列,剔掉引擎结构列——
 * 「我自己定义了哪些字段」直接可查,不必在 `SELECT *` 里肉眼挑。
 */
export function renderPropertyColumnSelect(
  snapshot: DatabaseSchemaSnapshot,
  table: TableSchemaDescriptor
): string | null {
  return renderPropertyColumnSelectFor(snapshot.database, table);
}

/** 同 renderPropertyColumnSelect,只吃连接要素(悬停侧手上没有快照时用) */
export function renderPropertyColumnSelectFor(
  database: DatabaseInterfaceConfig | undefined,
  table: TableSchemaDescriptor
): string | null {
  const columns = propertyColumnsOf(table);
  if (columns.length === 0) {
    return null;
  }

  const names = columns.map(field => `\`${field.name}\``).join(', ');
  return `SELECT ${names} FROM ${quoteTableName(database, table.name)} LIMIT 100;`;
}

/**
 * 子表 JOIN(批B):元素行经 `parentID` 关联父表(引擎 EntityTableItemMysql
 * 给每张子表固定 parentID 列),LEFT JOIN 保住无元素的属性行。
 */
export function renderChildTableJoinSelect(
  snapshot: DatabaseSchemaSnapshot,
  table: TableSchemaDescriptor
): string | null {
  return renderChildTableJoinSelectFor(snapshot.database, table);
}

/** 同 renderChildTableJoinSelect,只吃连接要素(悬停侧手上没有快照时用) */
export function renderChildTableJoinSelectFor(
  database: DatabaseInterfaceConfig | undefined,
  table: TableSchemaDescriptor
): string | null {
  if (!table.parentTableName) {
    return null;
  }

  const columns = table.fields.map(field => `c.\`${field.name}\``);
  if (columns.length === 0) {
    return null;
  }

  return [
    `SELECT p.\`id\` AS parentID, ${columns.join(', ')}`,
    `FROM ${quoteTableName(database, table.parentTableName)} AS p`,
    `LEFT JOIN ${quoteTableName(database, table.name)} AS c ON c.\`parentID\` = p.\`id\``,
    'LIMIT 100;'
  ].join(' ');
}

/**
 * 每表尾部 SQL 行:最小 SELECT(全列)+ 属性列集 + 子表 JOIN(仅子表)。
 * 渲染与行号定位共用这一产出,两处不会各自漂移。
 */
export function renderTableSqlLines(
  snapshot: DatabaseSchemaSnapshot,
  table: TableSchemaDescriptor
): string[] {
  const result: string[] = [`SQL: SELECT * FROM ${quoteSchemaTableName(snapshot, table.name)} LIMIT 100;`];
  const propertySelect = renderPropertyColumnSelect(snapshot, table);
  if (propertySelect) {
    result.push(`SQL(属性列): ${propertySelect}`);
  }
  const joinSelect = renderChildTableJoinSelect(snapshot, table);
  if (joinSelect) {
    result.push(`SQL(子表 JOIN): ${joinSelect}`);
  }
  return result;
}

/** 根表(实体表)名:优先取快照里的实体表;快照未建表时按配置前缀回落 */
export function resolveEntityTableName(
  entityName: string,
  snapshot: DatabaseSchemaSnapshot | null
): string {
  const rootTable = snapshot?.tables.find(table => table.kind === 'entity');
  return rootTable?.name ?? `${resolveSchemaTablePrefix()}${entityName}`;
}

export function locateDatabaseSchemaLine(
  snapshot: DatabaseSchemaSnapshot,
  tableName: string,
  fieldName?: string
): number {
  // 定位从渲染文本里找锚点,不再手写镜像版式行数(批133 用户令:友好版式改版后
  // 原 `line = 6` / `+= 5` / `+= 2` 的镜像计数全部失效)
  return locateDatabaseSchemaLineInLines(renderDatabaseSchema(snapshot).split('\n'), tableName, fieldName);
}

/** IDE-SCH-010:定位的纯文本面——对「已发布的那一代」渲染行直接找锚点,
 * 展示与跳转同源,不另起快照重渲染 */
export function locateDatabaseSchemaLineInLines(
  lines: string[],
  tableName: string,
  fieldName?: string
): number {
  const tableStart = lines.findIndex(line => {
    const match = DATABASE_SCHEMA_TABLE_ANCHOR.exec(line);
    return match !== null && match[1] === tableName;
  });
  if (tableStart === -1) {
    return 1;
  }
  if (!fieldName) {
    return tableStart + 1;
  }

  let blockEnd = lines.length;
  for (let index = tableStart + 1; index < lines.length; index += 1) {
    if (DATABASE_SCHEMA_TABLE_ANCHOR.test(lines[index])) {
      blockEnd = index;
      break;
    }
  }
  for (let index = tableStart + 1; index < blockEnd; index += 1) {
    if (databaseSchemaFieldLineName(lines[index]) === fieldName) {
      return index + 1;
    }
  }
  // 表在、字段不在(改名或未落列):与旧实现同口径退首行,不高亮错行
  return 1;
}

// 引擎自动建的固定几列,语义固定(建表与 EntityTableItemMysql 的实现都是写死
// 的),直接给注解;其余引擎列只报索引与来源键
const SYNTHETIC_COLUMN_NOTES: Record<string, string> = {
  id: '主键（自增）',
  autoLoad: '带索引；标记是否已读入内存',
  parentID: '带索引；指回父表主键',
  'position.x': '位置 x（引擎为 hasCell 实体预留 6 列）',
  'position.y': '位置 y',
  'position.z': '位置 z',
  'direction.roll': '方向 roll',
  'direction.pitch': '方向 pitch',
  'direction.yaw': '方向 yaw'
};

const TABLE_KIND_LABELS: Record<TableSchemaDescriptor['kind'], string> = {
  entity: '实体表',
  component: '组件表',
  array: '数组子表'
};

// 工作区内给相对路径,工作区外照给绝对路径(不虚构相对关系);undefined 的
// defFilePath 在调用侧(622)已先行折算,这里只收字符串
function displaySourcePath(filePath: string): string {
  for (const folder of vscode.workspace.workspaceFolders || []) {
    const relative = path.relative(folder.uri.fsPath, filePath);
    if (relative && !relative.startsWith('..')) {
      return relative;
    }
  }
  return filePath;
}

export function renderDatabaseSchema(snapshot: DatabaseSchemaSnapshot | null): string {
  if (!snapshot) {
    return '# KBEngine Database Schema\n\nNo schema available.\n';
  }

  const lines: string[] = [];
  lines.push(`# 数据库表结构: ${snapshot.entityName}`);
  lines.push('');
  if (snapshot.database) {
    lines.push(
      `数据库: ${snapshot.database.databaseName}@${snapshot.database.host}:${snapshot.database.port}`
    );
  }
  lines.push(`存储引擎: MySQL`);
  lines.push(`定义文件: ${snapshot.defFilePath ? displaySourcePath(snapshot.defFilePath) : `${snapshot.entityName}.def`}`);
  const propertyColumns = snapshot.tables.reduce(
    (sum, table) => sum + table.fields.filter(field => !field.synthetic).length,
    0
  );
  const totalColumns = snapshot.tables.reduce((sum, table) => sum + table.fields.length, 0);
  lines.push(`表: ${snapshot.tables.length} 张 · 列: ${totalColumns}（其中 .def 声明 ${propertyColumns}）`);
  lines.push('');
  lines.push('读图方式');
  lines.push('  - tbl_ 表前缀与 sm_ 列前缀由引擎加（表前缀可用 kbengine.db.tablePrefix 改）');
  lines.push('  - 引擎列由引擎自动建（id / autoLoad / parentID / 位置朝向 6 列），.def 里不用声明；属性列才是你在 .def 里写的');
  lines.push('  - 组件表与数组子表用 parentID 指回父表；数组子表一行一个元素');
  lines.push('  - flags= 是 .def 声明的可见域（BASE / CELL / CLIENT 及其组合），BASE_AND_CLIENT 表示 base 脚本与客户端都能读写');
  lines.push('  - 表尾 SQL 可直接粘进 MySQL 客户端（默认查 100 行）');
  lines.push('');

  for (const table of snapshot.tables) {
    // TABLE 锚点行与 SQL 三行保持原样:跳转定位与文档说明按它们解析
    lines.push(`TABLE ${table.name}`);
    lines.push(`表类型: ${TABLE_KIND_LABELS[table.kind]}`);
    if (table.parentTableName) {
      lines.push(`父表: ${table.parentTableName}`);
    }
    lines.push(`定义来源: ${displaySourcePath(table.source.filePath)}:${table.source.line}`);
    lines.push('');

    const syntheticFields = table.fields.filter(field => field.synthetic);
    const propertyFields = table.fields.filter(field => !field.synthetic);
    const columnWidth = Math.max(8, ...table.fields.map(field => field.name.length));

    if (syntheticFields.length > 0) {
      lines.push('引擎列（引擎自动建，.def 无需声明）');
      for (const field of syntheticFields) {
        lines.push(renderFieldLine(field, columnWidth, syntheticColumnNote(field)));
      }
    }

    if (propertyFields.length > 0) {
      lines.push('属性列（.def 里声明的）');
      for (const field of propertyFields) {
        lines.push(renderFieldLine(field, columnWidth, ''));
      }
    } else if (syntheticFields.length > 0) {
      // 空表照实提示,不让读者以为是自己漏看了
      lines.push('属性列: 无（本表只有引擎列，没有 .def 声明的数据列）');
    }

    // 每表三行可粘贴 SQL(带库表前缀与反引号转义,直接进外部客户端)
    for (const sqlLine of renderTableSqlLines(snapshot, table)) {
      lines.push(sqlLine);
    }
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

function renderFieldLine(
  field: TableFieldDescriptor,
  columnWidth: number,
  note: string
): string {
  const details: string[] = [field.typeLabel];
  if (field.databaseLength !== undefined) {
    details.push(`长度 ${field.databaseLength}`);
  }
  if (field.indexType) {
    details.push(`索引 ${field.indexType}`);
  }
  if (field.identifier) {
    details.push('唯一标识');
  }
  if (field.flags) {
    details.push(`flags=${field.flags}`);
  }
  if (field.defaultValue !== undefined) {
    details.push(`默认值 ${field.defaultValue}`);
  }
  if (note) {
    details.push(note);
  }
  // 属性列尾部标 def 落点,悬停与跳转按它回 def
  const suffix = field.synthetic || !field.source.path
    ? ''
    : `    ← ${path.basename(field.source.filePath)}:${field.source.line} <${field.source.path}>`;
  return `  ${field.name.padEnd(columnWidth)}  ${details.join('  ')}${suffix}`;
}

function syntheticColumnNote(field: TableFieldDescriptor): string {
  const note = SYNTHETIC_COLUMN_NOTES[field.sourcePath];
  if (note) {
    return note;
  }
  if (field.indexType) {
    return `带 ${field.indexType} 索引`;
  }
  return field.sourcePath ? `引擎列（${field.sourcePath}）` : '引擎列';
}


/**
 * 库表前缀(设置 `kbengine.db.tablePrefix`,缺省空 = 引擎默认 `tbl_`,
 * 出处 entity_table_mysql.cpp 的 TABLE_PREFIX)。设值后表名、schema 视图
 * 与 SQL 模板同源替换,指向非默认前缀的工程。
 */
export function resolveSchemaTablePrefix(): string {
  const configured = vscode.workspace.getConfiguration('kbengine').get<string>('db.tablePrefix', '');
  const trimmed = configured.trim();
  return trimmed.length > 0 ? trimmed : DB_TABLE_PREFIX;
}


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
    typeAliases: parseTypeAliases(typesXmlPath),
    entityHasCell: false,
    inputVersions: new Map(),
    // IDE-SCH-004:形态查询不产快照,消费记账落空 Map(占位,不入缓存)
    typeRegistryPath: null,
    typeRegistryConsumed: new Map<string, string>()
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
        buildTypeStorageUsageIndex(workspaceRoot);
      } finally {
        pendingTypeStorageColdBuildRoots.delete(workspaceRoot);
      }
    }))
    .catch(() => {});
  void typeStorageColdBuildChain.then(() => {
    for (const listener of [...typeStorageUsageIndexListeners]) {
      listener();
    }
  });
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
