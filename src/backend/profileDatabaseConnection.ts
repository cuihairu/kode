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
import type { ConnectionAbortHooks, DriftConnectionFactory, QueryResult } from './databaseDrift';
import {
  resolveDatabaseInterfaceConfig,
  type DatabaseInterfaceConfig
} from '../serverConfigMerge';
import { getConfigResolved, type ConfigResolveOverrides } from '../serverConfigResolve';

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
 * 连接有效身份键(IDE-AUD-008):host/port/user/database 四要素的确定性指纹。
 * 同一 profile 任一有效身份要素变化 → 键变 → 结果缓存不再命中旧连接结果
 * (旧结果不冒充新连接);密钥分隔符 \u0000 不在身份要素正常值域内。
 */
export function databaseConnectionIdentityKey(config: DatabaseInterfaceConfig): string {
  return [config.host, config.port, config.username, config.databaseName].join('\u0000');
}

/**
 * profile 装载轴覆盖(ensureConfigResolved 预取面):profile 带自己的根 →
 * 只认 profile 的根;空串轴 = 该 profile 没有自己的根,照常走设置链。
 */
export function profileConfigResolveOverrides(
  profile: ProfileDatabaseRoots | null
): ConfigResolveOverrides {
  return {
    binPath: profile?.engineRoot ? path.join(profile.engineRoot, 'kbe', 'bin', 'server') : undefined,
    configRoot: (profile?.assetsRoot || undefined) as string | undefined
  };
}

/**
 * 按根组合解析连接要素(core `dbInterface` 直传,KODE-CFG-009):profile 带
 * 自己的根 → 只认 profile 的根(根缺配置/core 不可知 = 如实 null,不回落
 * 工作区链——回落即读到别的项目);根为空串 = 该 profile 没有自己的根,
 * 该轴照常走设置链。无 profile(null) = 工作区默认(设置/发现链,带既有
 * 缓存)。同步读消费缓存——async 入口须先
 * `await ensureConfigResolved(profileConfigResolveOverrides(profile))`
 * 保证新鲜(接线见 extension 的 profile 切换/命令面)。
 */
export function resolveProfileDatabaseInterfaceConfig(
  profile: ProfileDatabaseRoots | null
): DatabaseInterfaceConfig | null {
  if (!profile) {
    return resolveDatabaseInterfaceConfig();
  }
  return getConfigResolved(profileConfigResolveOverrides(profile))?.dbInterface ?? null;
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
  /** 各 profile 上次选中的连接有效身份键(IDE-AUD-008):变化即失效该 profile 缓存 */
  private readonly identityKeys = new Map<string, string | null>();
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
    // IDE-AUD-008:同 profile 的有效连接身份变化(host/port/user/db 任一)≠
    // 缓存自动属于新配置——使该 profile 缓存失效(推进代际+清桶),旧结果
    // 不再命中、旧连接晚到回写被拒;首次选中(无前值)与身份未变都不触发。
    const identityKey = config === null ? null : databaseConnectionIdentityKey(config);
    const previousKey = this.identityKeys.get(profileId);
    if (previousKey !== undefined && previousKey !== identityKey) {
      this.queryResultCache.clearProfile(profileId);
    }
    this.identityKeys.set(profileId, identityKey);
    return this.registry.select(profileId, () =>
      config === null ? null : databaseConfigSnapshotFromInterface(config)
    );
  }

  /** 释放某 profile 的会话面:结果缓存 + 全量要素;台账快照留档(持久层) */
  releaseProfile(profileId: string): void {
    this.queryResultCache.clearProfile(profileId);
    this.fullConfigs.delete(profileId);
    this.identityKeys.delete(profileId);
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
 *
 * IDE-AUD-008 两维加固:缓存键含连接身份(host/port/user/db)——同 profile
 * 换连接后同 SQL 不再命中旧结果;查询发起时捕获代际,回写时代际不符(失效
 * 面在查询期间推进)即被拒,旧连接晚到回写不重新污染新代。
 */
export function createProfileScopedDriftExecutor(
  profileId: string,
  cache: DatabaseQueryResultCache,
  inner: DriftConnectionFactory,
  hooks?: ConnectionAbortHooks
): DriftConnectionFactory {
  return async (database, abortHooks) => {
    // IDE-AUD-010:守卫给的在途强杀登记面透传给内层工厂(SET READ ONLY 挂死
    // 时守卫经它撕在途连接);本层只用透传,不碰缓存与连接语义
    const executor = await inner(database, hooks ?? abortHooks);
    const identity = databaseConnectionIdentityKey(database);
    return {
      runQuery: async (sql: string): Promise<QueryResult> => {
        const generation = cache.generationOf(profileId); // 查询发起时代际(晚到写回比对)
        const hit = cache.get(profileId, sql, identity);
        if (hit) {
          return hit;
        }
        const result = await executor.runQuery(sql);
        cache.set(profileId, sql, result, { identity, generation });
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
