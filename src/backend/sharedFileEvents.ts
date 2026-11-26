// IDE-SNP-008: shared file events merged by URI. A single save often triggers
// multiple watcher notifications (multiple watchers matching the same file / an
// editor writing the file in several notifications); without merging the
// consuming index would apply the same-version update multiple times. Each
// consuming index keeps its own merger (instances never cross wires):
// - first report arrives immediately: events are delivered synchronously (the
//   consumer tests' and synchronous assertions' contract unchanged);
// - pure duplicates within the window (same URI, same kind) are swallowed; the
//   window restarts from the last report (debounce);
// - kind changes (change→delete etc.) are different-version semantics, delivered
//   immediately, never delayed;
// - the dedup key = normalizeFileIdentity (slash/dot-segment normalization; Linux
//   does not fold case — different casing on a real filesystem is a different
//   file).
//
// 2026-10-28 audit fix (the second real write is no longer lost): swallowing
// same-kind reports within the window cannot distinguish "duplicate notification
// of the same version" from "two real writes". At delivery, record the on-disk
// version (mtimeMs:size); when the window expires, verify it: if the version has
// advanced, deliver one trailing same-kind event — the second update arrives at
// most one window late, never lost for good. delete is a terminal state (missing
// file = the target state) and is not re-delivered; when the on-disk version is
// unavailable (path missing / stat failed) it cannot be verified and is not
// re-delivered.
//
// File-change metadata (plan B): the stat produced by the dedup pass rides along
// with the event (SharedFileEvent.version), and downstream lazy parsers
// memoize by identity+version — the same version is read once, no extra IO for
// the version alone. First report / kind change are synchronous deliveries while
// stat is async (KR-AUD-30), so the first report's version is backfilled onto
// the same event object once settled; the window's trailing re-delivery has
// already awaited the verifying stat before re-delivering, and carries the
// advanced version at that moment. Contract: docs/design/file-change-meta.md.
import * as fs from 'fs';
import { normalizeFileIdentity } from './pathIdentity';

export type SharedFileEventKind = 'create' | 'change' | 'delete';

export interface SharedFileEvent {
  /** The as-reported path at first report (consumers use it by their own key rules) */
  readonly fsPath: string;
  /** Normalized identity key (merge contract) */
  readonly identity: string;
  readonly kind: SharedFileEventKind;
  /**
   * The on-disk version token at delivery time (`${mtimeMs}:${size}`), reusing
   * the dedup pass's stat, zero extra IO. Three delivery contracts:
   * - first report / in-window kind change: delivered synchronously, the async
   *   stat not yet settled → undefined first, then backfilled onto **the same
   *   event object** (the merger is the sole writer, consumers read-only; no
   *   re-delivery);
   * - window trailing re-delivery: the verifying stat has been awaited before
   *   re-delivery, carrying the advanced version at re-delivery time (carrying
   *   the old version would make downstream hit the same-version cache and lose
   *   the second write's metadata).
   * Consumers without a version go through fileChangeMeta's lazy parse and stat
   * on their own, no guessing.
   */
  readonly version?: string;
}

export type SharedFileEventHandler = (event: SharedFileEvent) => void;

const DEFAULT_MERGE_WINDOW_MS = 30;

interface UriMergeState {
  /** The as-reported path at delivery (reused by trailing re-delivery) */
  fsPath: string;
  deliveredKind: SharedFileEventKind;
  /** The on-disk version at delivery (mtimeMs:size); undefined when stat is unavailable.
   *  KR-AUD-30: switched to async fs.stat, the promise awaited when the window expires. */
  deliveredVersion: Promise<string | undefined>;
  timer: NodeJS.Timeout;
}

/** On-disk version token contract (KR-AUD-30): two identical stats = same version (pure duplicate).
 *  Shared with bypass events (fileChangeBypass) — both sides must use the exact same
 *  contract, otherwise dedup/version decisions each writing their own will drift. HOT-VER:
 *  the file version book (hotReloadFileVersion) reuses the same contract — the watcher
 *  event stream, bypass, and manual trigger paths share it; no second criterion is built. */
export const fileVersionTokenFromStats = (stats: { mtimeMs: number; size: number }): string =>
  `${stats.mtimeMs}:${stats.size}`;

/** Read the on-disk version token (async): returns undefined on stat failure (never fabricates a version) */
export const readFileVersionToken = async (fsPath: string): Promise<string | undefined> => {
  try {
    const stats = await fs.promises.stat(fsPath);
    return fileVersionTokenFromStats(stats);
  } catch {
    return undefined;
  }
};

/** Legacy internal name: semantics unchanged, uniformly goes through the fileVersionTokenFromStats contract */
const statVersionToken = readFileVersionToken;

export interface SharedFileEventMerger {
  /** Report one raw file event (merged, then delivered to all subscribers of this merger) */
  emit(fsPath: string, kind: SharedFileEventKind): void;
  /** Subscribe to merged events; returns an unsubscribe function */
  subscribe(handler: SharedFileEventHandler): () => void;
  /** End all suppression windows (test face, synchronous) */
  flushForTests(): void;
  /** Terminate: clear subscriptions and in-window state */
  dispose(): void;
}

/** The merge window is injectable (defaults to 30ms; for tests) */
export function createSharedFileEventMerger(windowMs: number = DEFAULT_MERGE_WINDOW_MS): SharedFileEventMerger {
  const subscribers = new Set<SharedFileEventHandler>();
  const mergeByUri = new Map<string, UriMergeState>();
  let disposed = false;

  /**
   * Deliver one merged event. `versionSource`:
   * - string = the version already resolved at delivery time (window trailing re-delivery);
   * - Promise = the in-flight dedup stat (first report / kind change): deliver
   *   synchronously first (the first-report-arrives-immediately contract
   *   unchanged), then backfill the same event object's version once settled, no
   *   re-delivery;
   * - undefined = no version available (e.g. stat failed after delete).
   */
  const deliver = (
    fsPath: string,
    identity: string,
    kind: SharedFileEventKind,
    versionSource: string | Promise<string | undefined> | undefined
  ): void => {
    let settled: string | undefined = typeof versionSource === 'string' ? versionSource : undefined;
    const event: SharedFileEvent = {
      fsPath,
      identity,
      kind,
      get version(): string | undefined {
        return settled;
      }
    };
    if (typeof versionSource !== 'string' && versionSource !== undefined) {
      void versionSource.then(
        value => { settled = value; },
        () => undefined // statVersionToken swallows its own errors; a second line of defense so the backfill never produces an unhandled rejection
      );
    }
    for (const handler of [...subscribers]) {
      handler(event);
    }
  };

  /** Window expiry: verify the on-disk version (KR-AUD-30: async stat); if advanced, re-deliver a same-kind trailing event */
  const endWindow = (identity: string): void => {
    const state = mergeByUri.get(identity);
    if (!state) {
      return;
    }
    mergeByUri.delete(identity);
    if (state.deliveredKind === 'delete') {
      return; // terminal state: no trailing verification
    }
    void Promise.all([state.deliveredVersion, statVersionToken(state.fsPath)]).then(
      ([delivered, current]) => {
        if (delivered !== undefined && current !== undefined && current !== delivered) {
          // The re-delivery carries the **advanced current** (not the first
          // report's deliveredVersion): downstream memoizes by version; carrying
          // the old version would hit the old cache and swallow the second
          // write's metadata
          deliver(state.fsPath, identity, state.deliveredKind, current);
        }
      }
    );
  };

  const armWindow = (state: UriMergeState, identity: string): void => {
    state.timer = setTimeout(() => { endWindow(identity); }, windowMs);
  };

  return {
    emit(fsPath: string, kind: SharedFileEventKind): void {
      if (disposed) {
        return;
      }
      const identity = normalizeFileIdentity(fsPath);
      const existing = mergeByUri.get(identity);
      if (existing) {
        clearTimeout(existing.timer);
        armWindow(existing, identity);
        if (existing.deliveredKind === kind) {
          return; // same-kind report inside the window: still swallowed immediately; window expiry decides re-delivery by the on-disk version
        }
        existing.fsPath = fsPath;
        existing.deliveredKind = kind;
        existing.deliveredVersion = statVersionToken(fsPath);
        deliver(fsPath, identity, kind, existing.deliveredVersion);
        return;
      }
      const state: UriMergeState = {
        fsPath,
        deliveredKind: kind,
        deliveredVersion: statVersionToken(fsPath),
        timer: setTimeout(() => { endWindow(identity); }, windowMs)
      };
      mergeByUri.set(identity, state);
      deliver(fsPath, identity, kind, state.deliveredVersion);
    },
    subscribe(handler: SharedFileEventHandler): () => void {
      subscribers.add(handler);
      return () => { subscribers.delete(handler); };
    },
    flushForTests(): void {
      for (const identity of [...mergeByUri.keys()]) {
        const state = mergeByUri.get(identity);
        if (state) {
          clearTimeout(state.timer);
        }
        endWindow(identity);
      }
    },
    dispose(): void {
      disposed = true;
      subscribers.clear();
      for (const state of mergeByUri.values()) {
        clearTimeout(state.timer);
      }
      mergeByUri.clear();
    }
  };
}
