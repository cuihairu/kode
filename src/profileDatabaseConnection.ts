/**
 * profile 连接注册表接线(IDE-REV-015,原项 IDE-DB-001 重开):
 * DatabaseConnectionRegistry/DatabaseQueryResultCache 从孤儿模块接到真实
 * 数据库命令(kbengine.database.checkDrift/checkAllDrift)。活动 profile 的
 * 引擎根/资产根各自推导 dbmgr 连接要素,按 profileId 入台账;命令的连接
 * 配置只能经台账取——台账无该 profile 的记录(未选过/解析失败)= 如实
 * 「读不到配置」降级,绝不回退邻居 profile 或工作区设置。
 *
 * 切换/释放生命周期:切换活动 profile 即释放旧 profile 的会话结果缓存
 * (clearProfile)并按新 profile 重选;无活动 profile 时按工作区默认键
 * 隔离(同一键,同样不混任何 profile)。命令每次执行前重选一次,引擎
 * 配置落盘变更下次执行即生效(与接线前逐次解析的口径一致)。
 */

import * as path from 'path';
import {
  DatabaseConnectionRegistry,
  DatabaseQueryResultCache,
  type DatabaseConnectionConfigSnapshot
} from './databaseConnectionRegistry';
import type { DriftConnectionFactory, QueryResult } from './databaseDrift';
import {
  buildMergedConfigTree,
  extractDatabaseInterfaceConfig,
  resolveDatabaseInterfaceConfig,
  type DatabaseInterfaceConfig
} from './serverConfigMerge';

/** 无活动 profile 时的台账键:工作区设置链自己的连接(同样不与 profile 混) */
export const WORKSPACE_DEFAULT_DATABASE_PROFILE_ID = 'workspace-default';

/** 台账持久化键(workspaceState):连接快照按 profile 落盘,重启独立读回 */
export const DATABASE_CONNECTIONS_STATE_KEY = 'kbengine.databaseConnections.v1';

/** profile 面需要的根字段(与 ProjectProfile 同形,避免反向依赖 store) */
export interface ProfileDatabaseRoots {
  engineRoot: string;
  assetsRoot: string;
}

/** 连接要素 → 台账快照(台账只存身份四要素,密码等敏感面不入台账) */
export function databaseConfigSnapshotFromInterface(
  config: DatabaseInterfaceConfig
): DatabaseConnectionConfigSnapshot {
  return { host: config.host, port: config.port, user: config.username, database: config.databaseName };
}

/**
 * 按根组合解析连接要素:profile 带自己的根 → 只认 profile 的根(根缺
 * 配置/读不到 = 如实 null,不回落工作区链——回落即读到别的项目);根为
 * 空串 = 该 profile 没有自己的根,该轴照常走设置链。无 profile(null)
 * = 工作区默认(设置/发现链,带既有缓存)。
 */
export function resolveProfileDatabaseInterfaceConfig(
  profile: ProfileDatabaseRoots | null
): DatabaseInterfaceConfig | null {
  if (!profile) {
    return resolveDatabaseInterfaceConfig();
  }
  const { merged } = buildMergedConfigTree({
    binPath: profile.engineRoot ? path.join(profile.engineRoot, 'kbe', 'bin', 'server') : undefined,
    configRoot: profile.assetsRoot || undefined
  });
  return merged ? extractDatabaseInterfaceConfig(merged) : null;
}

export interface ProfileDatabaseConnectionServiceDeps {
  registry: DatabaseConnectionRegistry;
  queryResultCache: DatabaseQueryResultCache;
  resolveConfig(profile: ProfileDatabaseRoots | null): DatabaseInterfaceConfig | null;
}

/**
 * 台账中介服务:命令取连接配置必须经此(先 selectActive 再 getActiveConfig),
 * 绕过台账 = 取不到配置 = 命令级测试可捕获漏接。台账存快照(持久化),
 * 全量连接要素(密码/字符集等)随选择记在会话内,取数时与台账快照对
 * 账——不一致(陈旧)如实 null,不拿旧全量冒充新选择。
 */
export class ProfileDatabaseConnectionService {
  private readonly registry: DatabaseConnectionRegistry;
  private readonly queryResultCache: DatabaseQueryResultCache;
  private readonly resolveConfig: ProfileDatabaseConnectionServiceDeps['resolveConfig'];
  private readonly fullConfigs = new Map<string, DatabaseInterfaceConfig>();
  private lastProfileId: string | null = null;

  constructor(deps: ProfileDatabaseConnectionServiceDeps) {
    this.registry = deps.registry;
    this.queryResultCache = deps.queryResultCache;
    this.resolveConfig = deps.resolveConfig;
  }

  /**
   * 为 profileId 选择(重选)连接配置:真实切换到别的 profile 时,先释放
   * 旧 profile 的会话结果缓存与全量要素(切换即释放,不等下次查询);
   * 解析失败如实记无配置(不回退邻居)。
   */
  selectActive(
    profileId: string,
    profile: ProfileDatabaseRoots | null
  ): DatabaseConnectionConfigSnapshot | null {
    if (this.lastProfileId !== null && this.lastProfileId !== profileId) {
      this.releaseProfile(this.lastProfileId);
    }
    this.lastProfileId = profileId;
    const config = this.resolveConfig(profile);
    if (config === null) {
      this.fullConfigs.delete(profileId);
    } else {
      this.fullConfigs.set(profileId, config);
    }
    return this.registry.select(profileId, () =>
      config === null ? null : databaseConfigSnapshotFromInterface(config)
    );
  }

  /** 释放某 profile 的会话面:结果缓存 + 全量要素;台账快照留档(持久层) */
  releaseProfile(profileId: string): void {
    this.queryResultCache.clearProfile(profileId);
    this.fullConfigs.delete(profileId);
  }

  /**
   * 命令取数面:台账无该 profile 的已选记录 = null(未选过/解析失败);
   * 台账快照与会话内全量要素不一致 = 陈旧 = null。绝不回退邻居。
   */
  getActiveConfig(profileId: string): DatabaseInterfaceConfig | null {
    const snapshot = this.registry.getActive(profileId);
    const full = this.fullConfigs.get(profileId);
    if (!snapshot || !full) {
      return null;
    }
    if (
      full.host !== snapshot.host ||
      full.port !== snapshot.port ||
      full.username !== snapshot.user ||
      full.databaseName !== snapshot.database
    ) {
      return null;
    }
    return full;
  }

  /** 命令执行面读当前活动连接(无活动 profile = 工作区默认键) */
  get cache(): DatabaseQueryResultCache {
    return this.queryResultCache;
  }
}

/**
 * 按套一层 per-profile 结果缓存:同 SQL 命中即不再下发到连接(TTL 过期
 * 不命中);结果按 profileId 各存各的,切换即清(releaseProfile)。列的
 * nullable/default/key 等判读字段随缓存往返不丢(缓存列型带可选元数据)。
 */
export function createProfileScopedDriftExecutor(
  profileId: string,
  cache: DatabaseQueryResultCache,
  inner: DriftConnectionFactory
): DriftConnectionFactory {
  return async database => {
    const executor = await inner(database);
    return {
      runQuery: async (sql: string): Promise<QueryResult> => {
        const hit = cache.get(profileId, sql);
        if (hit) {
          return hit;
        }
        const result = await executor.runQuery(sql);
        cache.set(profileId, sql, result);
        return result;
      },
      close: (): Promise<void> => executor.close(),
      // 强制销毁面透传(IDE-REV-017):内层有才暴露,缓存层不造
      ...(executor.destroy
        ? {
            destroy: (): Promise<void> => executor.destroy!()
          }
        : {})
    };
  };
}

let activeConnections: ProfileDatabaseConnectionService | null = null;

/** 装配面安装当前服务(扩展激活时);旧实例被替换即不可再达 */
export function installProfileDatabaseConnections(
  service: ProfileDatabaseConnectionService | null
): void {
  activeConnections = service;
}

/** 命令装配层读取当前服务(未装配/已卸载 = null,如实降级) */
export function getProfileDatabaseConnections(): ProfileDatabaseConnectionService | null {
  return activeConnections;
}
