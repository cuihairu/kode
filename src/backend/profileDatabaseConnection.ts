/**
 * Profile connection registry wiring (IDE-REV-015, reopening IDE-DB-001):
 * DatabaseConnectionRegistry/DatabaseQueryResultCache are wired out of orphan
 * modules into the real database commands (kbengine.database.checkDrift/
 * checkAllDrift). The active profile's engine root / assets root each derive
 * the dbmgr connection facts, recorded per profileId in the ledger; a
 * command's connection config may only be fetched through the ledger — no
 * ledger record for that profile (never selected / resolve failed) = honest
 * "config unavailable" degradation, never falling back to a neighbor profile
 * or workspace settings.
 *
 * Switch/release lifecycle: switching the active profile releases the old
 * profile's session result cache (clearProfile) and reselects per the new
 * profile; with no active profile, isolation uses the workspace default key
 * (same key, likewise never mixed with any profile). Commands reselect once
 * per execution, so engine config changes on disk take effect at the next
 * execution (same contract as the per-run resolution before wiring).
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

/** Ledger key when there is no active profile: the workspace settings chain's own connection (likewise never mixed with any profile) */
export const WORKSPACE_DEFAULT_DATABASE_PROFILE_ID = 'workspace-default';

/** Ledger persistence key (workspaceState): connection snapshots are stored per profile and read back independently after restart */
export const DATABASE_CONNECTIONS_STATE_KEY = 'kbengine.databaseConnections.v1';

/** Root fields the profile face needs (same shape as ProjectProfile, avoiding a reverse dependency on the store) */
export interface ProfileDatabaseRoots {
  engineRoot: string;
  assetsRoot: string;
}

/** Connection facts → ledger snapshot (the ledger stores only the four identity facts; sensitive parts such as the password never enter the ledger) */
export function databaseConfigSnapshotFromInterface(
  config: DatabaseInterfaceConfig
): DatabaseConnectionConfigSnapshot {
  return { host: config.host, port: config.port, user: config.username, database: config.databaseName };
}

/**
 * Connection effective identity key (IDE-AUD-008): a deterministic
 * fingerprint of the four facts host/port/user/database. Any effective
 * identity fact of the same profile changing → key changes → the result
 * cache no longer hits the old connection's results (old results never
 * masquerade as the new connection); the \u0000 key separator lies outside
 * the facts' normal value range.
 */
export function databaseConnectionIdentityKey(config: DatabaseInterfaceConfig): string {
  return [config.host, config.port, config.username, config.databaseName].join('\u0000');
}

/**
 * Profile load-axis override (ensureConfigResolved prefetch face): a profile
 * with its own roots → only the profile's roots are honored; an empty-string
 * axis = the profile has no root of its own, the settings chain applies as
 * usual.
 */
export function profileConfigResolveOverrides(
  profile: ProfileDatabaseRoots | null
): ConfigResolveOverrides {
  return {
    binPath: profile?.engineRoot ? path.join(profile.engineRoot, 'bin', 'server') : undefined,
    configRoot: (profile?.assetsRoot || undefined) as string | undefined
  };
}

/**
 * Resolve connection facts per root combination (core `dbInterface` passed
 * straight through, KODE-CFG-009): a profile with its own roots → only the
 * profile's roots are honored (root missing config / core unavailable =
 * honest null, no fall back to the workspace chain — falling back would
 * read another project); an empty-string root = the profile has no root of
 * its own, that axis follows the settings chain as usual. No profile (null)
 * = workspace default (settings/discovery chain, with the existing cache).
 * The sync read consumes the cache — async entries must first
 * `await ensureConfigResolved(profileConfigResolveOverrides(profile))`
 * to guarantee freshness (wiring lives in the extension's profile switch /
 * command faces).
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
 * Ledger mediation service: a command's connection-config fetch must go
 * through this (selectActive first, then getActiveConfig); bypassing the
 * ledger = no config available = command-level tests can catch missing
 * wiring. The ledger stores snapshots (persisted); the full connection facts
 * (password/charset etc.) are recorded in-session at selection time and
 * reconciled against the ledger snapshot at fetch time — a mismatch (stale)
 * is honest null, never passing the old full config off as the new
 * selection.
 */
export class ProfileDatabaseConnectionService {
  private readonly registry: DatabaseConnectionRegistry;
  private readonly queryResultCache: DatabaseQueryResultCache;
  private readonly resolveConfig: ProfileDatabaseConnectionServiceDeps['resolveConfig'];
  private readonly fullConfigs = new Map<string, DatabaseInterfaceConfig>();
  /** Last selected effective connection identity key per profile (IDE-AUD-008): a change invalidates that profile's cache */
  private readonly identityKeys = new Map<string, string | null>();
  private lastProfileId: string | null = null;

  constructor(deps: ProfileDatabaseConnectionServiceDeps) {
    this.registry = deps.registry;
    this.queryResultCache = deps.queryResultCache;
    this.resolveConfig = deps.resolveConfig;
  }

  /**
   * Select (reselect) the connection config for a profileId: on an actual
   * switch to another profile, first release the old profile's session result
   * cache and full facts (released at switch time, not waiting for the next
   * query); a resolve failure is recorded honestly as no config (no
   * neighbor fallback).
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
    // IDE-AUD-008: an effective connection identity change on the same profile
    // (any of host/port/user/db) does not mean the cache automatically
    // belongs to the new config — invalidate that profile's cache (advance
    // the generation + clear the bucket) so old results no longer hit and
    // late write-backs from the old connection are rejected; first selection
    // (no previous value) and an unchanged identity trigger nothing.
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

  /** Release a profile's session face: result cache + full facts; the ledger snapshot stays on file (persistence layer) */
  releaseProfile(profileId: string): void {
    this.queryResultCache.clearProfile(profileId);
    this.fullConfigs.delete(profileId);
    this.identityKeys.delete(profileId);
  }

  /**
   * Command data-fetch face: no selected ledger record for the profile =
   * null (never selected / resolve failed); ledger snapshot and in-session
   * full facts disagree = stale = null. Never falls back to a neighbor.
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

  /** Command execution face reads the currently active connection (no active profile = workspace default key) */
  get cache(): DatabaseQueryResultCache {
    return this.queryResultCache;
  }
}

/**
 * Wraps one more per-profile result cache layer: the same SQL hitting the
 * cache is no longer dispatched to the connection (TTL expiry misses);
 * results are stored per profileId and cleared on switch (releaseProfile).
 * Interpretation fields of a column such as nullable/default/key survive the
 * cache round trip (the cached column type carries optional metadata).
 *
 * IDE-AUD-008 two-dimensional hardening: the cache key includes the
 * connection identity (host/port/user/db) — after the same profile switches
 * connections, the same SQL no longer hits old results; the generation is
 * captured at query start and a generation mismatch at write-back (the
 * invalidation face advancing during the query) is rejected, so late
 * write-backs from the old connection never re-pollute the new generation.
 */
export function createProfileScopedDriftExecutor(
  profileId: string,
  cache: DatabaseQueryResultCache,
  inner: DriftConnectionFactory,
  hooks?: ConnectionAbortHooks
): DriftConnectionFactory {
  return async (database, abortHooks) => {
    // IDE-AUD-010: the guard's in-flight force-kill registration face is
    // passed through to the inner factory (when SET READ ONLY hangs, the
    // guard tears down the in-flight connection through it); this layer only
    // forwards and never touches cache or connection semantics
    const executor = await inner(database, hooks ?? abortHooks);
    const identity = databaseConnectionIdentityKey(database);
    return {
      runQuery: async (sql: string): Promise<QueryResult> => {
        const generation = cache.generationOf(profileId); // generation at query start (compared on late write-back)
        const hit = cache.get(profileId, sql, identity);
        if (hit) {
          return hit;
        }
        const result = await executor.runQuery(sql);
        cache.set(profileId, sql, result, { identity, generation });
        return result;
      },
      close: (): Promise<void> => executor.close(),
      // Force-destroy face passthrough (IDE-REV-017): exposed only when the inner layer has one; the cache layer never invents it
      ...(executor.destroy
        ? {
            destroy: (): Promise<void> => executor.destroy!()
          }
        : {})
    };
  };
}

let activeConnections: ProfileDatabaseConnectionService | null = null;

/** Wiring face installs the current service (at extension activation); the old instance becomes unreachable once replaced */
export function installProfileDatabaseConnections(
  service: ProfileDatabaseConnectionService | null
): void {
  activeConnections = service;
}

/** Command wiring layer reads the current service (not installed / already disposed = null, honest degradation) */
export function getProfileDatabaseConnections(): ProfileDatabaseConnectionService | null {
  return activeConnections;
}
