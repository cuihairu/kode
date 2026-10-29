/**
 * 按 profile 选择只读数据库连接(IDE-DB-001):连接配置与查询结果缓
 * 存都以 profileId 为主键隔离——切换项目后新 profile 读自己的配置,
 * 绝不沿用另一 profile 的连接配置(未选择过=如实 null 不回退邻居);
 * 结果缓存同 SQL 各 profile 各存各的,过期/清缓存都只影响目标
 * profile。连接配置经注入 load/save 持久化(workspaceState 面,重启
 * 按 profile 独立读回);结果缓存是会话级(不落盘,陈旧结果不冒充新
 * 查询)。实际建连与只读白名单走 databaseDrift 既有面,本模块只管
 * 「哪个 profile 用哪份配置/缓存」的隔离。
 */

export interface DatabaseConnectionRegistryDeps {
  now(): number;
  /** 持久层读(workspaceState 型);无则纯会话 */
  load?(): unknown;
  save?(data: unknown): void;
}

export interface DatabaseConnectionConfigSnapshot {
  host: string;
  port: number;
  user?: string;
  database?: string;
}

interface RegistryPayload {
  connections: Record<string, DatabaseConnectionConfigSnapshot>;
}

const isConfigSnapshot = (value: unknown): value is DatabaseConnectionConfigSnapshot => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.host === 'string' && typeof candidate.port === 'number';
};

/** 连接配置台账:profileId → 该 profile 自己的配置快照 */
export class DatabaseConnectionRegistry {
  private readonly now: () => number;
  private readonly load?: () => unknown;
  private readonly save?: (data: unknown) => void;
  private readonly connections = new Map<string, DatabaseConnectionConfigSnapshot>();

  constructor(deps: DatabaseConnectionRegistryDeps) {
    this.now = deps.now;
    this.load = deps.load;
    this.save = deps.save;
    const payload = this.load?.();
    if (typeof payload === 'object' && payload !== null && !Array.isArray(payload)) {
      const connections = (payload as RegistryPayload).connections;
      if (typeof connections === 'object' && connections !== null) {
        for (const [profileId, config] of Object.entries(connections)) {
          if (isConfigSnapshot(config)) {
            this.connections.set(profileId, config);
          }
        }
      }
    }
  }

  /**
   * 为 profileId 选择连接配置:以 resolveConfig 的结果为该 profile 的
   * 当前配置(重新选择=覆盖,引擎配置变更生效);解析失败如实 null 并
   * 记该 profile 无配置(不回退邻居)。
   */
  select(
    profileId: string,
    resolveConfig: () => DatabaseConnectionConfigSnapshot | null
  ): DatabaseConnectionConfigSnapshot | null {
    const config = resolveConfig();
    if (config === null) {
      this.connections.delete(profileId);
    } else {
      this.connections.set(profileId, config);
    }
    this.save?.({ connections: Object.fromEntries(this.connections) });
    return this.getActive(profileId);
  }

  /** 该 profile 的配置;未选择过/解析失败过 = null(绝不给邻居的) */
  getActive(profileId: string): DatabaseConnectionConfigSnapshot | null {
    return this.connections.get(profileId) ?? null;
  }
}

export interface CachedQueryResult {
  /**
   * 列信息:判读字段(nullable/defaultValue/key)可选保留——IDE-REV-015
   * 起缓存随真实查询往返,丢这些字段会让二次判读与首查不一致,故带上。
   */
  columns: Array<{
    name: string;
    type: string;
    nullable?: boolean;
    defaultValue?: unknown;
    key?: string;
  }>;
  rows: Array<Record<string, unknown>>;
}

interface CacheEntry {
  result: CachedQueryResult;
  expiresAt: number;
}

/** 查询结果默认 TTL(ms):过期不再命中,陈旧结果不冒充新查询 */
export const DEFAULT_QUERY_RESULT_TTL_MS = 30_000;

/** 结果缓存:profileId → SQL → 结果,会话级(TTL 过期不再命中) */
export class DatabaseQueryResultCache {
  private readonly now: () => number;
  private readonly byProfile = new Map<string, Map<string, CacheEntry>>();

  constructor(deps: Pick<DatabaseConnectionRegistryDeps, 'now'>) {
    this.now = deps.now;
  }

  get(profileId: string, sql: string): CachedQueryResult | undefined {
    const entry = this.byProfile.get(profileId)?.get(sql);
    if (!entry) {
      return undefined;
    }
    if (this.now() > entry.expiresAt) {
      this.byProfile.get(profileId)?.delete(sql);
      return undefined;
    }
    return entry.result;
  }

  set(profileId: string, sql: string, result: CachedQueryResult, options: { ttlMs?: number } = {}): void {
    let bySql = this.byProfile.get(profileId);
    if (!bySql) {
      bySql = new Map();
      this.byProfile.set(profileId, bySql);
    }
    bySql.set(sql, { result, expiresAt: this.now() + (options.ttlMs ?? DEFAULT_QUERY_RESULT_TTL_MS) });
  }

  /** 只清目标 profile 的缓存,邻居原样 */
  clearProfile(profileId: string): void {
    this.byProfile.delete(profileId);
  }
}
