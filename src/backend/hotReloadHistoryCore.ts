/**
 * Pure core of the hot reload history store (HR-PR-06, book §19.4 ui-status):
 * - zero vscode imports, zero IO: capacity/clock are injected, and the wiring
 *   face (TreeView/panel/decorations) only consumes this core's query face, at
 *   the same boundary as hotReloadSavePipeline;
 * - HR-UI-002/006/HR-MOD-014 field shape: every history row stores both
 *   fullModule and requestModule (HR-MOD-014) plus fileUri/targetId/time/
 *   request id/status/error summary; tree node titles take fullModule and the
 *   tooltip projection carries requestModule/URI/target/time/request id — the
 *   name the user sees is presented apart from the name the request carries
 *   (HR-UI-006);
 * - HR-UI-010/014 the same path with a different target is two independent
 *   history rows (targetId is part of the row identity); filtering runs on the
 *   fullModule substring (case-insensitive)/targetId/status/time range;
 * - HR-UI-009 status semantics follow the same convention as hotReloadStatus:
 *   sent-unverified is the honest state for a 2xx with no business receipt, and
 *   applied only after the engine receipt has been verified; transitions are
 *   one-way sent-unverified→applied/failed and terminal states never regress
 *   (a regression is fabrication, refused and honestly returned as false); a
 *   nonexistent requestId is also honestly false;
 * - HR-UI-007 high-frequency coalescing: several updates for the same requestId
 *   inside the merge window collapse into one row keeping the final state (a
 *   pure decision; the UI adapter face uses the merged result to decide re-
 *   render throttling); capacity is bounded with ring eviction of the oldest;
 * - the paging window (offset/pageSize+total/hasMore) serves virtual scrolling
 *   and incremental loading;
 * - grouping (recent/byFile/byTarget) feeds the HR-UI-002 tree view: newest
 *   first within each group;
 * - RUST-368 retention limit (maxAgeMs+pruneExpired, pure mechanism) and the
 *   redacted export (redactHistoryEntry whitelist projection +
 *   buildHistoryExport, zero body/header).
 *
 * Wiring (TreeView/panel registration, i18n rendering, a11y, lifecycle binding)
 * is not part of this core.
 */

import type { HotReloadErrorReason } from './hotReloadErrorReason';

/** HR-UI-009 status convention (same semantics as hotReloadStatus; a separate enum so the vscode face is not imported) */
export type HotReloadHistoryStatus = 'sent-unverified' | 'applied' | 'failed';

export interface HotReloadHistoryInput {
  /** Request-associated id (generated per execution, HR-HTTP-014; replaying the same id = idempotent replacement, no duplicate row) */
  readonly requestId: string;
  /** Full module name (tree title / primary search key, HR-UI-006) */
  readonly fullModule: string;
  /** Sent module name (what the request actually carries, HR-UI-006 detail) */
  readonly requestModule: string;
  /** Normalized file path (output of canonicalizeScriptFilePath) */
  readonly fileUri: string;
  /** Target environment id (part of the row identity: same file, different target = two rows, HR-UI-010/014) */
  readonly targetId: string;
  /** HR-UI-014 workspace root fsPath (output of resolveRootId): the dimension that
   *  disambiguates which workspace a same-module row belongs to (row identity is
   *  already carried by the requestId prefix); optional = old persisted rows lack
   *  this field (rendered as a placeholder without dropping the row); live rows
   *  are always non-empty */
  readonly rootId?: string;
  /** Clock milliseconds */
  readonly time: number;
  readonly status: HotReloadHistoryStatus;
  /** Failure/interception summary (e.g. HTTP status, error category; keys/headers are never recorded) */
  readonly errorSummary?: string;
  /**
   * Trigger source (the "trigger" of the HR-STATE-007 nine elements, same as the
   * "who" of the IDE-HOT-102 audit): watcher-auto / command / retry / temp-edit;
   * not provided = source unrecorded (honestly defaults, never guessed).
   */
  readonly trigger?: string;
  /**
   * Send duration in milliseconds (the "duration" of the HR-STATE-007 nine
   * elements): from the send-initiation anchor to the moment it lands in the
   * ledger; the baseline freeze performed before the send has no duration
   * (honestly defaults, never impersonates 0).
   */
  readonly durationMs?: number;
  /**
   * Seven-category error classification (the "errorCategory" of the
   * HR-STATE-007 nine elements; HR-STATE-010 shares the same classification
   * source): complementary to the free-text errorSummary — summary is the
   * original text with advice, this is the filterable qualitative enum.
   */
  readonly errorCategory?: HotReloadErrorReason;
  /**
   * Content sha256 frozen at send time (the "hash" of the HR-STATE-007 nine
   * elements): same source as the delivery ledger's sentDigest, it is the
   * re-verifiable basis for "exactly which content went out this time"; a read
   * failure = honestly defaults.
   */
  readonly hash?: string;
}

/** History row (read-only view; status updates go through updateStatus; immutable from outside) */
export type HotReloadHistoryEntry = HotReloadHistoryInput;

/** One-way transition table: only sent-unverified may advance; terminal regressions/self-transitions are always refused */
const ALLOWED_TRANSITIONS: Readonly<Record<HotReloadHistoryStatus, readonly HotReloadHistoryStatus[]>> = {
  'sent-unverified': ['applied', 'failed'],
  applied: [],
  failed: []
};

export interface HotReloadHistoryFilter {
  /** fullModule case-insensitive substring match */
  readonly fullModuleContains?: string;
  /** HR-STATE-007 requestModule substring (case-insensitive): the sent name and the displayed name are queryable separately */
  readonly requestModuleContains?: string;
  readonly targetId?: string;
  /** HR-UI-014 exact filter on the workspace root (same convention as targetId: a hit means equality) */
  readonly rootId?: string;
  readonly fileUri?: string;
  readonly status?: HotReloadHistoryStatus;
  /** Time range inclusive of bounds [from,to]; undefined = unlimited */
  readonly timeFrom?: number;
  readonly timeTo?: number;
  /** HR-STATE-007 filter by trigger source (watcher-auto/command/retry/temp-edit) */
  readonly trigger?: string;
  /** HR-STATE-007 filter by the seven error categories (HR-STATE-010 same-source enum) */
  readonly errorCategory?: HotReloadErrorReason;
  /** HR-STATE-007 content hash prefix filter (a short prefix identifies the source; empty string = unrestricted) */
  readonly hash?: string;
  /** HR-STATE-007 delivery duration range inclusive of bounds [from,to] (ms); rows without a duration never match */
  readonly durationFrom?: number;
  readonly durationTo?: number;
}

export interface HotReloadHistoryPage<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly hasMore: boolean;
}

/**
 * RUST-368 redacted export row: an explicit safe-field whitelist (nine elements
 * + dual names + file + requestId). Same source as "no need to persist every
 * HTTP body" — only the listed fields are projected here, so any future field
 * (HTTP body/header/token) stays out of the export by default, with no reliance
 * on scrubbing after the fact.
 */
export interface HotReloadHistoryExportRow {
  readonly requestId: string;
  readonly fullModule: string;
  readonly requestModule: string;
  readonly fileUri: string;
  readonly targetId: string;
  /** HR-UI-014 workspace root (explicitly added to the whitelist: new fields are silently excluded by the whitelist by default) */
  readonly rootId?: string;
  readonly time: number;
  readonly status: HotReloadHistoryStatus;
  readonly errorSummary?: string;
  readonly trigger?: string;
  readonly durationMs?: number;
  readonly errorCategory?: HotReloadErrorReason;
  readonly hash?: string;
}

/** RUST-368 redacted export document (schemaVersion pins the shape, easing later evolution) */
export interface HotReloadHistoryExport {
  readonly schemaVersion: 1;
  readonly exportedAt: number;
  readonly count: number;
  readonly entries: HotReloadHistoryExportRow[];
}

export interface HotReloadHistoryOptions {
  /** Capacity (defaults to 200): overflow evicts the oldest (HR-UI-007 relies on paging + eviction for thousands of records, never resident in full) */
  readonly capacity?: number;
  /**
   * Retention time limit in ms (RUST-368; not enabled by default = the pure
   * core does not set policy on its own): pruneExpired evicts rows whose time
   * is earlier than nowMs-maxAgeMs. The policy value comes from the wiring
   * face (the view's HOT_RELOAD_HISTORY_MAX_AGE_MS); the core only owns the
   * mechanism.
   */
  readonly maxAgeMs?: number;
}

/** Coalescing input: the update sequence for one requestId inside the window */
export interface HotReloadHistoryUpdate {
  readonly requestId: string;
  readonly status: HotReloadHistoryStatus;
  readonly time: number;
  readonly errorSummary?: string;
}

/**
 * HR-UI-007 high-frequency coalescing (pure function): several updates for the
 * same requestId within windowMs collapse into one row keeping the last
 * status/time (updates across the window do not merge); different requestIds
 * stay independent.
 * Event order follows input order (the caller guarantees timing); the one-way
 * status semantics are guaranteed by the caller's history-store transition
 * face, so this function only coalesces the presentation layer without
 * changing transition rules.
 */
export function coalesceHistoryUpdates(
  updates: readonly HotReloadHistoryUpdate[],
  windowMs: number
): HotReloadHistoryUpdate[] {
  const out: HotReloadHistoryUpdate[] = [];
  const lastIndexByRequest = new Map<string, number>();
  for (const update of updates) {
    const lastIndex = lastIndexByRequest.get(update.requestId);
    if (
      lastIndex !== undefined &&
      update.time - out[lastIndex].time <= windowMs
    ) {
      out[lastIndex] = update;
      continue;
    }
    lastIndexByRequest.set(update.requestId, out.length);
    out.push(update);
  }
  return out;
}

/**
 * HR-UI-007 virtual scroll window (a pure decision; the panel rendering face
 * uses it to render only the viewport rows):
 * - every input is clamped (negative values honestly take 0/1, never a
 *   negative window), and totalRows=0 is honestly an empty window;
 * - overscan extends N rows up and down so the viewport edges never show gaps
 *   while scrolling;
 * - totalHeightPx = rows x row height, so the scrollbar is sized by the total
 *   content height (it does not shrink because only the window rows render).
 * The webview-side scroll update uses a JS mirror of this same formula (this
 * function is the spec, pinned down by TS tests).
 */
export interface VirtualScrollWindow {
  /** First rendered row (inclusive) */
  readonly startIndex: number;
  /** Last rendered row (exclusive; after clamping always >= startIndex) */
  readonly endIndex: number;
  /** Total content height (px; the basis for the scrollbar) */
  readonly totalHeightPx: number;
}

export function computeVirtualScrollWindow(opts: {
  totalRows: number;
  rowHeightPx: number;
  viewportHeightPx: number;
  scrollTopPx: number;
  overscanRows: number;
}): VirtualScrollWindow {
  const totalRows = Math.max(0, Math.floor(opts.totalRows));
  const rowHeightPx = Math.max(1, opts.rowHeightPx);
  const viewportHeightPx = Math.max(0, opts.viewportHeightPx);
  const scrollTopPx = Math.max(0, opts.scrollTopPx);
  const overscanRows = Math.max(0, Math.floor(opts.overscanRows));
  // Scrolled past the tail: first is clamped to totalRows too (past the tail = an empty window after the end; never produces an inverted window with start > end)
  const first = Math.min(totalRows, Math.max(0, Math.floor(scrollTopPx / rowHeightPx) - overscanRows));
  const last = Math.min(totalRows, Math.ceil((scrollTopPx + viewportHeightPx) / rowHeightPx) + overscanRows);
  return {
    startIndex: first,
    endIndex: Math.max(first, last),
    totalHeightPx: totalRows * rowHeightPx
  };
}

/** HR-UI-006 tree node title projection: fullModule first, honestly a placeholder when absent */
export function buildHistoryEntryLabel(entry: HotReloadHistoryEntry): string {
  return entry.fullModule.length > 0 ? entry.fullModule : entry.requestModule || '(unknown module)';
}

/** HR-UI-002/006 tooltip field projection (structured lines; the UI face renders them; no HTML assembly) */
export function buildHistoryEntryTooltipLines(entry: HotReloadHistoryEntry): string[] {
  const lines: string[] = [];
  if (entry.fullModule.length > 0 && entry.requestModule !== entry.fullModule) {
    lines.push(`requestModule: ${entry.requestModule}`);
  }
  lines.push(`module: ${entry.fullModule || entry.requestModule}`);
  lines.push(`file: ${entry.fileUri}`);
  lines.push(`target: ${entry.targetId || '(default)'}`);
  // HR-UI-014 workspace root (a missing root has no "default root" notion, honestly reported as unrecorded;
  // live rows are always non-empty, so the placeholder only appears on old persisted rows)
  lines.push(`root: ${entry.rootId || '(unrecorded)'}`);
  lines.push(`time: ${new Date(entry.time).toISOString()}`);
  lines.push(`requestId: ${entry.requestId}`);
  lines.push(`status: ${entry.status}`);
  // The remaining four of the HR-STATE-007 searchable nine elements (absent values are honestly not shown; no fabricated placeholder)
  if (entry.trigger !== undefined) {
    lines.push(`trigger: ${entry.trigger}`);
  }
  if (entry.durationMs !== undefined) {
    lines.push(`duration: ${entry.durationMs}ms`);
  }
  if (entry.hash !== undefined) {
    lines.push(`hash: ${entry.hash}`);
  }
  if (entry.errorCategory !== undefined) {
    lines.push(`errorCategory: ${entry.errorCategory}`);
  }
  if (entry.errorSummary) {
    lines.push(`error: ${entry.errorSummary}`);
  }
  return lines;
}

/**
 * RUST-368 redaction projection (whitelist): an explicit field-by-field copy;
 * absent values stay honestly absent (no fabricated empty values).
 * Keys outside the whitelist (any body/header/token that may appear later)
 * never make it into the export.
 */
export function redactHistoryEntry(entry: HotReloadHistoryEntry): HotReloadHistoryExportRow {
  // An explicit field-by-field copy (absent values stay honestly absent, no fabricated empty values); keys outside the whitelist never enter.
  return {
    requestId: entry.requestId,
    fullModule: entry.fullModule,
    requestModule: entry.requestModule,
    fileUri: entry.fileUri,
    targetId: entry.targetId,
    ...(entry.rootId !== undefined ? { rootId: entry.rootId } : {}),
    time: entry.time,
    status: entry.status,
    ...(entry.errorSummary !== undefined ? { errorSummary: entry.errorSummary } : {}),
    ...(entry.trigger !== undefined ? { trigger: entry.trigger } : {}),
    ...(entry.durationMs !== undefined ? { durationMs: entry.durationMs } : {}),
    ...(entry.errorCategory !== undefined ? { errorCategory: entry.errorCategory } : {}),
    ...(entry.hash !== undefined ? { hash: entry.hash } : {})
  };
}

/**
 * RUST-368 redacted export document: every row is projected one by one in
 * record order plus metadata (count always equals entries.length, so the
 * quantity is reported honestly); serialization (JSON.stringify) is left to
 * the caller.
 */
export function buildHistoryExport(
  entries: readonly HotReloadHistoryEntry[],
  meta: { exportedAt: number }
): HotReloadHistoryExport {
  return {
    schemaVersion: 1,
    exportedAt: meta.exportedAt,
    count: entries.length,
    entries: entries.map(entry => redactHistoryEntry(entry))
  };
}

/** Hot reload history store (pure core): record/advance/filter/group/page */
export class HotReloadHistoryCore {
  private readonly capacity: number;
  private readonly maxAgeMs: number | undefined;
  /** Insertion order is the age order (append-only; a requestId replacement stays in place without moving the order) */
  private readonly rows: HotReloadHistoryEntry[] = [];
  private readonly indexByRequest = new Map<string, number>();

  constructor(options: HotReloadHistoryOptions = {}) {
    this.capacity = options.capacity ?? 200;
    this.maxAgeMs = options.maxAgeMs;
  }

  /** Introspection: current row count (checked by tests / the wiring face) */
  size(): number {
    return this.rows.length;
  }

  /**
   * HR-STATE-011 clear-history: clears the entire history (rows plus the
   * requestId index are dropped together). Only memory is cleared; the
   * persisted clear is the caller's job (persist.save([])) — this core knows
   * nothing of persistence and does not reach beyond its boundary to guess the
   * host's disk-write face.
   */
  clear(): void {
    this.rows.length = 0;
    this.indexByRequest.clear();
  }

  /**
   * RUST-368 retention limit eviction: removes rows whose time is earlier than
   * nowMs-maxAgeMs, rebuilds the index preserving order, and returns the
   * eviction count. maxAgeMs not enabled = honestly a no-op (0); the cutoff is
   * inclusive of time==nowMs-maxAgeMs (>= retained). No assumption that time
   * is ordered (out-of-order insertion also keeps its order honestly).
   */
  pruneExpired(nowMs: number): number {
    if (this.maxAgeMs === undefined) {
      return 0;
    }
    const cutoff = nowMs - this.maxAgeMs;
    const kept: HotReloadHistoryEntry[] = [];
    let dropped = 0;
    for (const row of this.rows) {
      if (row.time < cutoff) {
        dropped += 1;
      } else {
        kept.push(row);
      }
    }
    if (dropped === 0) {
      return 0;
    }
    this.rows.length = 0;
    this.rows.push(...kept);
    this.indexByRequest.clear();
    kept.forEach((row, index) => {
      this.indexByRequest.set(row.requestId, index);
    });
    return dropped;
  }

  /**
   * Record one send. An existing requestId → idempotent replacement in place
   * (no duplicate row, order untouched); a new id is appended at the newest
   * position, and over capacity the oldest is evicted with its index honestly
   * cleared.
   */
  record(input: HotReloadHistoryInput): void {
    const existing = this.indexByRequest.get(input.requestId);
    if (existing !== undefined) {
      this.rows[existing] = { ...input };
      return;
    }
    this.rows.push({ ...input });
    this.indexByRequest.set(input.requestId, this.rows.length - 1);
    while (this.rows.length > this.capacity) {
      const evicted = this.rows.shift();
      if (evicted) {
        this.indexByRequest.delete(evicted.requestId);
      }
      // After shift, every index moves up by one position
      for (const [id, index] of this.indexByRequest) {
        this.indexByRequest.set(id, index - 1);
      }
    }
  }

  /**
   * HR-UI-009 status advancement: sent-unverified→applied (receipt verified)
   * or →failed.
   * Terminal states (applied/failed) never regress and same-state self-
   * transitions are refused — a fabricated regression is honestly refused with
   * false; a nonexistent requestId (evicted / never recorded) is also honestly
   * false.
   */
  updateStatus(requestId: string, status: HotReloadHistoryStatus, errorSummary?: string): boolean {
    const index = this.indexByRequest.get(requestId);
    if (index === undefined) {
      return false;
    }
    const current = this.rows[index];
    if (!ALLOWED_TRANSITIONS[current.status].includes(status)) {
      return false;
    }
    this.rows[index] = {
      ...current,
      status,
      ...(errorSummary !== undefined ? { errorSummary } : {})
    };
    return true;
  }

  /** All rows (insertion order, oldest first); callers wanting newest first should use newestFirst */
  entries(): readonly HotReloadHistoryEntry[] {
    return [...this.rows];
  }

  /** Newest-first view (the HR-UI-002 "recently updated" group) */
  newestFirst(): readonly HotReloadHistoryEntry[] {
    return [...this.rows].reverse();
  }

  /** HR-UI-010 filtering: all conditions ANDed; fullModule substring is case-insensitive */
  filter(query: HotReloadHistoryFilter): HotReloadHistoryEntry[] {
    const needle = query.fullModuleContains?.toLowerCase();
    const requestNeedle = query.requestModuleContains?.toLowerCase();
    return this.rows.filter(entry => {
      if (needle && !entry.fullModule.toLowerCase().includes(needle)) {
        return false;
      }
      if (
        requestNeedle &&
        !entry.requestModule.toLowerCase().includes(requestNeedle)
      ) {
        return false;
      }
      if (query.targetId !== undefined && entry.targetId !== query.targetId) {
        return false;
      }
      if (query.rootId !== undefined && entry.rootId !== query.rootId) {
        return false;
      }
      if (query.fileUri !== undefined && entry.fileUri !== query.fileUri) {
        return false;
      }
      if (query.status !== undefined && entry.status !== query.status) {
        return false;
      }
      if (query.timeFrom !== undefined && entry.time < query.timeFrom) {
        return false;
      }
      if (query.timeTo !== undefined && entry.time > query.timeTo) {
        return false;
      }
      if (query.trigger !== undefined && entry.trigger !== query.trigger) {
        return false;
      }
      if (query.errorCategory !== undefined && entry.errorCategory !== query.errorCategory) {
        return false;
      }
      if (
        query.hash !== undefined &&
        query.hash.length > 0 &&
        !(entry.hash ?? '').startsWith(query.hash)
      ) {
        return false;
      }
      // Duration interval: a row with no duration (pre-send baseline freeze / unrecorded) never matches an interval query —
      // it is counted as neither 0 nor infinity (honestly absent)
      if (
        (query.durationFrom !== undefined || query.durationTo !== undefined) &&
        entry.durationMs === undefined
      ) {
        return false;
      }
      if (query.durationFrom !== undefined && (entry.durationMs ?? 0) < query.durationFrom) {
        return false;
      }
      if (query.durationTo !== undefined && (entry.durationMs ?? 0) > query.durationTo) {
        return false;
      }
      return true;
    });
  }

  /**
   * HR-UI-007 paging window (the data face for virtual scrolling / incremental
   * loading): an out-of-bounds offset is honestly an empty page.
   */
  static page<T>(
    rows: readonly T[],
    offset: number,
    pageSize: number
  ): HotReloadHistoryPage<T> {
    const safeOffset = Math.max(0, offset);
    const safeSize = Math.max(1, pageSize);
    const items = rows.slice(safeOffset, safeOffset + safeSize);
    return {
      items,
      total: rows.length,
      hasMore: safeOffset + items.length < rows.length
    };
  }

  /** HR-UI-002 group by file: group keys ordered by first appearance (iterating newest first), newest first within a group */
  static groupByFile(rows: readonly HotReloadHistoryEntry[]): Map<string, HotReloadHistoryEntry[]> {
    return HotReloadHistoryCore.groupBy(rows, entry => entry.fileUri);
  }

  /** HR-UI-002/014 group by target: the same path with a different target falls into a different group */
  static groupByTarget(rows: readonly HotReloadHistoryEntry[]): Map<string, HotReloadHistoryEntry[]> {
    return HotReloadHistoryCore.groupBy(rows, entry => entry.targetId);
  }

  /** HR-UI-014 group by workspace root: a same-module multi-workspace set falls into different groups */
  static groupByRoot(rows: readonly HotReloadHistoryEntry[]): Map<string, HotReloadHistoryEntry[]> {
    return HotReloadHistoryCore.groupBy(rows, entry => entry.rootId ?? '');
  }

  private static groupBy(
    rows: readonly HotReloadHistoryEntry[],
    keyOf: (entry: HotReloadHistoryEntry) => string
  ): Map<string, HotReloadHistoryEntry[]> {
    const groups = new Map<string, HotReloadHistoryEntry[]>();
    for (const entry of rows) {
      const key = keyOf(entry);
      const bucket = groups.get(key);
      if (bucket) {
        bucket.push(entry);
      } else {
        groups.set(key, [entry]);
      }
    }
    return groups;
  }
}
