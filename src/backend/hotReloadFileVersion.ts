/**
 * Hot reload status bar file version numbers (HOT-VER): a monotonically
 * increasing integer per file (v1, v2, ...), never exposing the raw
 * mtime:size token. Rules: v1 when the file is first tracked; +1 each time an
 * on-disk content change is detected (version token changed); the baseline
 * catches up when a receipt arrives applied and its digest matches what is
 * currently on disk (that file's baseline version = current version). The
 * baseline lives in the ledger (same lifecycle as HotReloadTargetState, no
 * new storage).
 *
 * The ledger is independent of the watcher: with
 * `kbengine.hotReload.enabled=false` the manual trigger paths (showFileState /
 * retryFailed / right-click manual hot reload) still create records and issue
 * numbers, same file same version as when watching is on -- the watcher is only
 * one default event source of this version book, not its precondition; both
 * paths write the same ledger through the same implementation (noteFileVersion's
 * token dedup guarantees no double counting).
 *
 * Badge convention: single number = synced (baseline == on disk), double number
 * = pending sync (baseline -> on disk); untracked files and files outside the
 * watch scope show no number. The version number only describes "how many
 * times the on-disk content changed / where the baseline is"; it does not claim
 * the change took effect -- whether it took effect is still decided by the
 * applied double-evidence verification.
 */

import { createHash } from 'crypto';
import * as fs from 'fs';

import { readFileVersionToken } from './sharedFileEvents';
import type {
  HotReloadFileVersionEvent,
  HotReloadFileVersionState,
  HotReloadTargetStateStore
} from './hotReloadTargetState';
import {
  formatHotReloadTime,
  formatHotReloadVersionSuffix,
  type HotReloadVersionBadgeView,
  type HotReloadVersionSource
} from '../hotReloadStatus';

export type { HotReloadVersionBadgeView, HotReloadVersionSource };

/** Content sha256 (node:crypto primitive, same source as hotReloadFileState.sha256Hex) */
const sha256Hex = (content: string): string =>
  createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');

/** Regex escaping for the literal segments of a glob (metacharacters; `*`/`?`/`{}`/`,` are handled separately by the caller) */
const escapeGlobLiteral = (text: string): string => text.replace(/[.+^$()|[\]\\]/g, '\\$&');

/**
 * glob -> RegExp (VS Code glob subset): `**` crosses directories, `*`/`?` do
 * not, `{a,b}` is brace enumeration; patterns containing `/` are anchored as a
 * whole against the relative path, while patterns without `/` (e.g. `*.py`)
 * match by last segment at any depth.
 */
const globToRegExp = (rawPattern: string): RegExp => {
  const pattern = rawPattern.replace(/\\/g, '/');
  let out = '';
  let braceDepth = 0;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        if (pattern[index + 2] === '/') {
          out += '(?:[^/]+/)*'; // `**/` = zero or more directory segments
          index += 2;
        } else {
          out += '.*';
          index += 1;
        }
      } else {
        out += '[^/]*';
      }
      continue;
    }
    if (char === '?') {
      out += '[^/]';
      continue;
    }
    if (char === '{') {
      braceDepth += 1;
      out += '(?:';
      continue;
    }
    if (char === '}') {
      braceDepth = Math.max(0, braceDepth - 1);
      out += ')';
      continue;
    }
    if (char === ',' && braceDepth > 0) {
      out += '|';
      continue;
    }
    out += escapeGlobLiteral(char);
  }
  const anchored = pattern.includes('/') ? `^/?${out}$` : `^(?:.*/)?${out}$`;
  return new RegExp(anchored);
};

/**
 * Watch-scope decision: whether a file's relative path hits any hot reload
 * glob. Scope only looks at the `globs` setting and is orthogonal to the
 * `enabled` switch -- the switch only decides whether a watcher is created;
 * the version badge's "inside or outside the watch scope" is always judged
 * against the same pattern set, so manual trigger and watcher paths share one
 * convention.
 */
export function matchesHotReloadGlob(file: string, patterns: readonly string[]): boolean {
  const posixPath = file.replace(/\\/g, '/');
  return patterns.some(pattern => globToRegExp(pattern).test(posixPath));
}

export interface HotReloadVersionTrackerDeps {
  /** Version book carrier (inside the ledger, no new storage) */
  readonly store: HotReloadTargetStateStore;
  /** Absolute path of the current active document (none = undefined); when injected the status bar shows it first */
  activeFile(): string | undefined;
  /** Whether inside the watch scope (glob hit; unrelated to the enabled switch) */
  isWatched(file: string): boolean;
  /** Injected clock (version event timestamps) */
  now(): number;
  /** On-disk version token sampling hook (defaults to fs.stat's mtimeMs:size) */
  statToken?(file: string): Promise<string | undefined>;
  /** On-disk content read hook (digest comparison for applied baseline catch-up; defaults to fs.readFile) */
  readContent?(file: string): Promise<string | undefined>;
}

/** Version event rendering (OUTPUT version ledger line): time + version + facts, no processing, no beautification */
const renderVersionEvent = (event: HotReloadFileVersionEvent): string => {
  const time = formatHotReloadTime(event.at);
  switch (event.kind) {
    case 'tracked':
      return `${time} v${event.version} 首次跟踪`;
    case 'bump':
      return `${time} v${event.version} 盘上内容变化`;
    case 'baseline':
      return `${time} 基线追平 v${event.version}`;
    case 'delivery': {
      const parts = [`${time} v${event.version} ${event.stage === 'receipt' ? '回执' : '发送'}`];
      if (event.attempt !== undefined) {
        parts.push(`attempt=${event.attempt}`);
      }
      if (event.digest8 !== undefined) {
        parts.push(`digest=${event.digest8}`);
      }
      if (event.outcome !== undefined) {
        parts.push(`outcome=${event.outcome}`);
      }
      if (event.targetId !== undefined) {
        parts.push(`target=${event.targetId}`);
      }
      if (event.fullModule !== undefined && event.requestModule !== undefined) {
        parts.push(`module=${event.fullModule}(${event.requestModule})`);
      }
      return parts.join(' ');
    }
    default:
      return `${time} v${event.version}`;
  }
};

/**
 * Version sampling and badge data source: sampling (async stat) is separated
 * from judgment (sync ledger read) -- status bar rendering goes through the
 * sync badge/pending/report, after which kickRefresh re-samples asynchronously
 * and only a detected change triggers one extra render. Every path (watcher
 * events, receipt recording, manual triggers, status bar clicks) converges to
 * this class's two entry points noteFile/refresh; no second counting
 * implementation exists.
 */
export class HotReloadVersionTracker implements HotReloadVersionSource {
  private readonly deps: HotReloadVersionTrackerDeps;

  constructor(deps: HotReloadVersionTrackerDeps) {
    this.deps = deps;
  }

  private async stat(file: string): Promise<string | undefined> {
    if (this.deps.statToken) {
      return this.deps.statToken(file);
    }
    // Hooks into main's on-disk version read interface (readFileVersionToken); no second criterion is built
    return readFileVersionToken(file);
  }

  private async read(file: string): Promise<string | undefined> {
    if (this.deps.readContent) {
      return this.deps.readContent(file);
    }
    try {
      return await fs.promises.readFile(file, 'utf8');
    } catch {
      return undefined;
    }
  }

  /**
   * Samples one file's on-disk version (shared by watcher events and explicit
   * record creation before manual triggers).
   * Returns whether anything changed (record created or +1) -- the caller uses
   * it to re-render the status bar.
   */
  async noteFile(file: string): Promise<boolean> {
    const token = await this.stat(file);
    const result = this.deps.store.noteFileVersion(file, token, this.deps.now());
    return result !== undefined && result.change !== 'unchanged';
  }

  /**
   * Full refresh: stat every tracked file (backfill sampling / skip numbers),
   * then for files whose "baseline < on-disk current" and that have an applied
   * record, read the disk and compare digests -- the baseline catches up only
   * when it matches the baseline frozen at send time (if the disk has changed
   * since, no catch-up and the double number is honestly kept). Returns whether
   * anything changed.
   */
  async refresh(): Promise<boolean> {
    let changed = false;
    for (const state of this.deps.store.fileVersions()) {
      const token = await this.stat(state.file);
      const result = this.deps.store.noteFileVersion(state.file, token, this.deps.now());
      if (result !== undefined && result.change !== 'unchanged') {
        changed = true;
      }
      if (await this.catchUpBaseline(state.file)) {
        changed = true;
      }
    }
    return changed;
  }

  /** applied and on-disk content sha256 == baseline frozen at send time -> baseline catches up to the current version */
  private async catchUpBaseline(file: string): Promise<boolean> {
    const state = this.deps.store.fileVersion(file);
    if (!state || state.baseline >= state.version) {
      return false;
    }
    const digests = this.deps.store.appliedSentDigestsForFile(file);
    if (digests.length === 0) {
      return false;
    }
    const content = await this.read(file);
    if (content === undefined) {
      return false;
    }
    if (!digests.includes(sha256Hex(content))) {
      return false; // on-disk content != sent content: no catch-up, the double number is honestly kept
    }
    return this.deps.store.advanceFileVersionBaseline(file, this.deps.now());
  }

  /** Current active document version; untracked/outside watch scope -> falls back to the most recently changed file; none at all = undefined */
  badge(): HotReloadVersionBadgeView | undefined {
    const active = this.deps.activeFile();
    if (active !== undefined && this.deps.isWatched(active)) {
      const state = this.deps.store.fileVersion(active);
      if (state) {
        return this.viewOf(state);
      }
    }
    const recent = this.recentChangedFile();
    return recent ? this.viewOf(recent) : undefined;
  }

  /** All pending-sync files (baseline != on-disk current), sorted by file path */
  pending(): HotReloadVersionBadgeView[] {
    return this.deps.store
      .fileVersions()
      .filter(state => this.deps.isWatched(state.file) && state.baseline !== state.version)
      .map(state => this.viewOf(state))
      .sort((left, right) => left.file.localeCompare(right.file));
  }

  /** OUTPUT version ledger: per file, lists the baseline/on-disk version plus the time and send receipt of every version jump */
  report(): string[] {
    const badgeFile = this.badge()?.file;
    const states = this.deps.store.fileVersions().filter(state => this.deps.isWatched(state.file));
    if (states.length === 0) {
      return [];
    }
    const lines = [`版本台账:${states.length} 个文件(基线=已核验同步版本,盘上=当前内容版本)`];
    for (const state of states) {
      const synced = state.baseline === state.version;
      lines.push(
        ` ${state.file}基线 v${state.baseline} · 盘上 v${state.version}(${synced ? '已同步' : '待同步'})${
          state.file === badgeFile ? ' ← 状态栏当前文件' : ''
        }`
      );
      for (const event of state.events) {
        lines.push(`  ${renderVersionEvent(event)}`);
      }
    }
    return lines;
  }

  /** Single-file version description (for showFileState and other manual paths to log); untracked/out of scope = undefined */
  describeVersion(file: string): string | undefined {
    const state = this.deps.store.fileVersion(file);
    if (!state || !this.deps.isWatched(file)) {
      return undefined;
    }
    const synced = state.baseline === state.version;
    return `版本: ${file} ${formatHotReloadVersionSuffix(state.baseline, state.version)}(${
      synced ? '已同步' : '待同步'
    })`;
  }

  /** Most recently changed file (compares by sequence number over tracked/bump change events only; delivery/baseline events do not count as changes) */
  private recentChangedFile(): HotReloadFileVersionState | undefined {
    let best: HotReloadFileVersionState | undefined;
    for (const state of this.deps.store.fileVersions()) {
      if (!this.deps.isWatched(state.file)) {
        continue;
      }
      if (!best || state.seq > best.seq) {
        best = state;
      }
    }
    return best;
  }

  private viewOf(state: HotReloadFileVersionState): HotReloadVersionBadgeView {
    return { file: state.file, baseline: state.baseline, current: state.version };
  }
}
