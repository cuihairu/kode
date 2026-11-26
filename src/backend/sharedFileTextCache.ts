// Read once, fan out many times: a file-text cache shared across index faces
// (2026-11-24 user order, "why do the five read faces not share one file
// cache"). A transitional layer before the RST lane adoption: "stat validation +
// hit-skips-read + single-flight dedup + bounded eviction" is collapsed into one
// shared layer, and fileReadMetrics's two accounting entries plus the direct
// read sites (workspaceIndex/pythonClassIndex) all go through this layer — a
// file is truly read at most once per host lifetime, and the five index faces
// share the same text.
//
// Correctness semantics:
// - every read path stats first; the cache is consumed only when both keys
//   mtimeMs+size match (the "re-read when changed" user semantics; same risk
//   level as the faces' existing mtime caches, the size key closes the
//   same-mtime rewrite window);
// - **stat unavailable (file missing / no permission / virtual filesystem
//   without stat) → pure pass-through**: no cache, no accounting, read errors
//   thrown verbatim — byte-for-byte identical to the pre-adoption "read
//   directly" behavior; the cache only applies to files whose freshness can be
//   verified (never serves unverifiable stale text);
// - read failure (when the fingerprint is available): clear the entry and
//   **rethrow verbatim** (failures are never cached — a Windows file-lock
//   jiggle does not poison the cache; callers' existing catch semantics
//   unchanged);
// - hit = no disk read, not counted in the fileReadMetrics audit (which makes
//   the audit contract more honest, not less);
// - budget: LRU, drops the oldest over budget; a single entry over budget is
//   pass-through and never cached (never unbounded);
// - loader injection: each face keeps its own read seam (workspaceIndex uses
//   vscode.workspace.fs, pythonClassIndex/fileReadMetrics use node fs) — the
//   cache only shares "what to store", not "how to read"; existing test stub
//   seams and remote/virtual workspace read paths are never re-routed;
// - freshness verification (stat) defaults to vscode.workspace.fs.stat: the
//   same contract for local and remote/virtual workspaces, and on the same
//   event-loop scale as the stub-seam environment (real-disk I/O macrotasks are
//   never injected into pure-stub tests).

import * as fs from 'fs';
import { Uri, workspace } from 'vscode';

export interface SharedFileTextEntry {
  readonly text: string;
  readonly mtimeMs: number;
  readonly size: number;
  readonly bytes: number;
}

/** Read-through result: fromCache=true means this call produced no new disk read (hit / joined an in-flight single flight) */
export interface SharedFileTextRead {
  readonly text: string;
  readonly bytes: number;
  readonly fromCache: boolean;
}

export interface SharedFileTextStats {
  hits: number;
  misses: number;
  failures: number;
  evictions: number;
  entries: number;
  bytes: number;
}

/** Policy constants (no user-config face — same contract as the kode-server budget constants) */
export const SHARED_FILE_TEXT_BUDGET_BYTES = 64 * 1024 * 1024;

export interface SharedFileTextCacheDeps {
  statAsync(path: string): Promise<{ mtimeMs: number; size: number }>;
  readAsync(path: string): Promise<string>;
  statSync(path: string): { mtimeMs: number; size: number };
  readSync(path: string): string;
}

/** Read seam on cache miss; each face injects its own original read function (stub seams / remote fs are not re-routed).
 * PromiseLike adopts vscode.workspace.fs's Thenable return shape. */
export type SharedFileTextAsyncLoader = (path: string) => PromiseLike<string>;
export type SharedFileTextSyncLoader = (path: string) => string;

export const sharedFileTextCacheDefaultDeps: SharedFileTextCacheDeps = {
  // stat goes through vscode.workspace.fs (local/remote same contract; failure =
  // pass-through, see readInner*).
  // mtime is the vscode API's millisecond timestamp; when a stub environment has
  // no mtime, undefined keys compare consistently.
  statAsync: async path => {
    const stat = await workspace.fs.stat(Uri.file(path));
    return { mtimeMs: stat.mtime, size: stat.size };
  },
  readAsync: path => fs.promises.readFile(path, 'utf8'),
  statSync: path => {
    const stat = fs.statSync(path);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  },
  readSync: path => fs.readFileSync(path, 'utf8')
};

export class SharedFileTextCache {
  private readonly store = new Map<string, SharedFileTextEntry>();
  private readonly inflight = new Map<string, Promise<SharedFileTextRead>>();
  private hits = 0;
  private misses = 0;
  private failures = 0;
  private evictions = 0;

  constructor(
    private readonly budgetBytes: number = SHARED_FILE_TEXT_BUDGET_BYTES,
    private readonly deps: SharedFileTextCacheDeps = sharedFileTextCacheDefaultDeps
  ) {}

  /**
   * Read-through (async): stat validation → hit skips the read; on miss, the
   * loader really reads into the cache (loader defaults to node fs). stat
   * unavailable → pure pass-through (no caching, no accounting). Concurrent
   * calls on the same path join the in-flight single flight — the joining side
   * gets fromCache=true (no new disk read; the audit face only counts the call
   * that really hit the disk). opts.fresh=true neither joins nor registers an
   * in-flight single flight: for paths that must "really read this time" (such
   * as discard-and-rebuild; during the in-flight old read the on-disk content
   * may have changed, and joining would serve the old read result).
   */
  async readThroughAsync(
    path: string,
    loader?: SharedFileTextAsyncLoader,
    opts?: { fresh?: boolean }
  ): Promise<SharedFileTextRead> {
    if (!opts?.fresh) {
      const pending = this.inflight.get(path);
      if (pending) {
        const shared = await pending;
        return { ...shared, fromCache: true };
      }
    }
    const task = this.readInnerAsync(path, loader);
    if (!opts?.fresh) {
      this.inflight.set(path, task);
      try {
        return await task;
      } finally {
        this.inflight.delete(path);
      }
    }
    return task;
  }

  private async readInnerAsync(
    path: string,
    loader?: SharedFileTextAsyncLoader
  ): Promise<SharedFileTextRead> {
    let fingerprint: { mtimeMs: number; size: number };
    try {
      fingerprint = await this.deps.statAsync(path);
    } catch {
      // stat unavailable (missing / lock jiggle / virtual fs without stat): pure
      // pass-through, same behavior as the pre-adoption "read directly"; even a
      // successful read is not cached (freshness still cannot be verified next
      // time).
      const text = await (loader ?? this.deps.readAsync)(path);
      return { text, bytes: Buffer.byteLength(text, 'utf8'), fromCache: false };
    }
    const cached = this.store.get(path);
    if (cached && cached.mtimeMs === fingerprint.mtimeMs && cached.size === fingerprint.size) {
      // Map insertion order is the LRU freshness: a hit re-inserts to refresh
      this.store.delete(path);
      this.store.set(path, cached);
      this.hits += 1;
      return { text: cached.text, bytes: cached.bytes, fromCache: true };
    }
    this.misses += 1;
    let text: string;
    try {
      text = await (loader ?? this.deps.readAsync)(path);
    } catch (error) {
      this.store.delete(path);
      this.failures += 1;
      throw error;
    }
    const bytes = Buffer.byteLength(text, 'utf8');
    const entry: SharedFileTextEntry = { text, mtimeMs: fingerprint.mtimeMs, size: fingerprint.size, bytes };
    this.insert(path, entry);
    return { text, bytes, fromCache: false };
  }

  /**
   * Read-through (sync): the synchronous version with the same semantics. Sync
   * calls are naturally serialized, no single-flight face; used by the
   * fileReadMetrics accounting entries and the synchronous read chains
   * (definitionWorkspace/entityMapping sync legs).
   */
  readThroughSync(path: string, loader?: SharedFileTextSyncLoader): SharedFileTextRead {
    let fingerprint: { mtimeMs: number; size: number };
    try {
      fingerprint = this.deps.statSync(path);
    } catch {
      // stat unavailable: pure pass-through (not cached), read errors thrown verbatim
      const text = (loader ?? this.deps.readSync)(path);
      return { text, bytes: Buffer.byteLength(text, 'utf8'), fromCache: false };
    }
    const cached = this.store.get(path);
    if (cached && cached.mtimeMs === fingerprint.mtimeMs && cached.size === fingerprint.size) {
      this.store.delete(path);
      this.store.set(path, cached);
      this.hits += 1;
      return { text: cached.text, bytes: cached.bytes, fromCache: true };
    }
    this.misses += 1;
    let text: string;
    try {
      text = (loader ?? this.deps.readSync)(path);
    } catch (error) {
      this.store.delete(path);
      this.failures += 1;
      throw error;
    }
    const bytes = Buffer.byteLength(text, 'utf8');
    const entry: SharedFileTextEntry = { text, mtimeMs: fingerprint.mtimeMs, size: fingerprint.size, bytes };
    this.insert(path, entry);
    return { text, bytes, fromCache: false };
  }

  /** Single-file invalidation (called explicitly by the watcher/delete chains; batch 1's per-face stat-on-load already covers it, a pre-attached interface) */
  invalidate(path: string): void {
    this.store.delete(path);
  }

  clear(): void {
    this.store.clear();
  }

  snapshotStats(): SharedFileTextStats {
    let bytes = 0;
    for (const entry of this.store.values()) {
      bytes += entry.bytes;
    }
    return {
      hits: this.hits,
      misses: this.misses,
      failures: this.failures,
      evictions: this.evictions,
      entries: this.store.size,
      bytes
    };
  }

  private insert(path: string, entry: SharedFileTextEntry): void {
    if (entry.bytes > this.budgetBytes) {
      // single entry over budget: served as pass-through, never cached (the cache is never unbounded)
      return;
    }
    this.store.delete(path);
    this.store.set(path, entry);
    while (this.totalBytes() > this.budgetBytes) {
      const oldest = this.store.keys().next();
      if (oldest.done) {
        break;
      }
      this.store.delete(oldest.value);
      this.evictions += 1;
    }
  }

  private totalBytes(): number {
    let total = 0;
    for (const entry of this.store.values()) {
      total += entry.bytes;
    }
    return total;
  }
}

let singleton: SharedFileTextCache | null = null;

/** Host-level singleton: the five index faces share one file-text cache */
export function getSharedFileTextCache(): SharedFileTextCache {
  if (singleton === null) {
    singleton = new SharedFileTextCache();
  }
  return singleton;
}

/** For tests and single-operation audits: swap in a fresh instance (existing entries/counters all discarded) */
export function resetSharedFileTextCacheForTests(): void {
  singleton = new SharedFileTextCache();
}
