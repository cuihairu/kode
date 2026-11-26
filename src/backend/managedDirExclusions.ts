/**
 * KODE-CFG-017 isolation face: keep the self-managed `.kbengine` directory from polluting
 * the user's search / explorer / git. Pure logic layer, no vscode imports; the wiring layer
 * lives in extension.ts.
 *
 * Three disciplines (same pattern as pythonExtraPaths / jsoncAssociation):
 * - "manage only your own section": search.exclude / files.watcherExclude only add or remove
 *   the section kode wrote last time (recorded in workspaceState); entries the user types by
 *   hand are never touched;
 * - .gitignore is appended idempotently only when "a git repo + the file already exists",
 *   and is **never created** (SVN / no-VCS scenarios write nothing git-specific);
 * - everything is additive / idempotent / revertible, keyed off the `managedDir` setting
 *   value rather than hardcoded.
 */

export interface ManagedDirExclusionsDeps {
  /** Read a text file; returns null when it does not exist (.gitignore probing) */
  readText?: (path: string) => string | null;
  /** Write a text file (only called when a git repo + .gitignore already exists) */
  writeText?: (path: string, content: string) => void;
  /** Search upward for a `.git` directory; on a hit returns the repo root, otherwise null */
  findGitRoot?: (startDir: string) => string | null;
  /** Search upward for a `.svn` directory; on a hit returns the repo root, otherwise null */
  findSvnRoot?: (startDir: string) => string | null;
  /** Absolute path of the git repo root's .gitignore (default <root>/.gitignore) */
  gitignorePath?: (gitRoot: string) => string;
}

/** Exclusion key shape: `<managedDir>/**` (a workspace-root-relative glob, VS Code semantics) */
export function exclusionKeyFor(managedDir: string): string {
  const dir = managedDir.replace(/^\/+|\/+$/g, '');
  return `${dir}/**`;
}

/** gitignore append line: `<managedDir>/` (the trailing slash = only the directory form is ignored) */
export function gitignoreLineFor(managedDir: string): string {
  const dir = managedDir.replace(/^\/+|\/+$/g, '');
  return `${dir}/`;
}

/** Marker comment of the kode-managed section (stable ASCII, for precisely removing our own section later) */
export const GITIGNORE_MARKER = '# kode managed dir (auto-generated)';

/**
 * Decide whether the gitignore content already ignores that directory.
 * Hit condition: some line (whitespace-trimmed) is exactly `dir` / `dir/` / `/dir` / `/dir/`.
 * Only the "directory itself" forms count: **sub-path rules (like `dir/stubs/`) and wildcard
 * globs (like `dir/**`) do not count as the whole directory being ignored** -- they cover only
 * a subset, and the remaining generated files could still be tracked by Git, so `dir/` must be
 * appended. Conservative: rather append one duplicate kode section than misjudge an existing
 * user rule as "already ignored" (a duplicate append is deduplicated by content comparison,
 * so nothing breaks). Hand-written user entries are never deleted.
 */
export function gitignoreIgnores(content: string, managedDir: string): boolean {
  const dir = managedDir.replace(/^\/+|\/+$/g, '');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') {
      continue;
    }
    if (line === dir || line === `${dir}/` || line === `/${dir}` || line === `/${dir}/`) {
      return true;
    }
  }
  return false;
}

export type GitignorePlan =
  | { action: 'none'; line: string }
  | { action: 'append'; line: string; marker: string; nextContent: string };

/**
 * gitignore append plan (pure function): it only decides "how the content should change";
 * whether to write to disk is decided by the caller based on "a git repo + .gitignore exists"
 * -- this function never creates a file.
 * Idempotent: already ignored -> none; already containing the kode section (marker + this
 * directory's line) -> none as well.
 */
export function planGitignoreAdd(content: string, managedDir: string): GitignorePlan {
  const line = gitignoreLineFor(managedDir);
  if (gitignoreIgnores(content, managedDir)) {
    return { action: 'none', line };
  }
  // Already contains the kode section (marker + this directory's line adjacent) -> leave it alone (guards against a duplicate section)
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() === GITIGNORE_MARKER && i + 1 < lines.length && lines[i + 1].trim() === line) {
      return { action: 'none', line };
    }
  }
  const trimmed = content.replace(/\s+$/, '');
  const nextContent = trimmed === '' ? `${GITIGNORE_MARKER}\n${line}\n` : `${trimmed}\n${GITIGNORE_MARKER}\n${line}\n`;
  return { action: 'append', line, marker: GITIGNORE_MARKER, nextContent };
}

export type VcsKind = 'git' | 'svn' | 'none';

/** VCS probing (a pure-function decision entry): git first, then svn, otherwise none */
export function detectVcs(deps: ManagedDirExclusionsDeps, startDir: string): { kind: VcsKind; root: string | null } {
  const gitRoot = deps.findGitRoot?.(startDir) ?? null;
  if (gitRoot) {
    return { kind: 'git', root: gitRoot };
  }
  const svnRoot = deps.findSvnRoot?.(startDir) ?? null;
  if (svnRoot) {
    return { kind: 'svn', root: svnRoot };
  }
  return { kind: 'none', root: null };
}

export interface ExclusionPlan {
  /** The value to write back (the user's section first + kode's current section) */
  next: Record<string, unknown>;
  /** A write is needed only if this differs from the current value */
  changed: boolean;
  /** The keys kode manages this time (for the next workspaceState diff) */
  managedKeys: ManagedExclusionEntry[];
}

/**
 * A self-managed config entry kode wrote last time (the key + the value written then).
 * Recording the value distinguishes "the user changed it" from "kode's own untouched entry":
 * the value still equals what kode wrote -> still a self-managed entry; changed by the user ->
 * a user entry, never touched.
 */
export interface ManagedExclusionEntry {
  /** The config key kode wrote last time (e.g. `.kbengine/**`) */
  key: string;
  /** The value kode wrote last time (kode always writes true; a general type is kept here against future evolution) */
  value: unknown;
}

/** Compatible with the old stored shape: the old workspaceState stored only a string-key array (always true) -> the record shape */
export function normalizeManagedEntries(
  stored: readonly (string | ManagedExclusionEntry)[]
): ManagedExclusionEntry[] {
  return stored.map((e) => (typeof e === 'string' ? { key: e, value: true } : e));
}

/**
 * The plan for search.exclude / files.watcherExclude ("manage only your own section"):
 * first strip out every self-managed key kode wrote last time (hand-typed user entries are
 * never touched), then add the currently enabled keys.
 * - The self-managed test = it is in the previouslyManaged record **and the current value still
 *   equals what kode wrote last time** (the user changed the value -> treat it as a user entry,
 *   kept untouched);
 * - If the user changed the value of the very key kode is managing (e.g. `.kbengine/**: false`
 *   to re-include), kode no longer forcibly writes true back (respect the user's override, to
 *   prevent "the sync logic overwriting it straight back to true");
 * - When the managed directory changes, an old-directory key is removed only if it is still a
 *   self-managed entry; old keys the user adjusted are kept.
 * The current value's shape is not controlled by this extension: a non-object is treated as
 * empty, nothing breaks.
 */
export function planExclusion(
  current: unknown,
  managedDir: string,
  previouslyManaged: readonly (string | ManagedExclusionEntry)[],
  enabled: boolean
): ExclusionPlan {
  const currentMap = current != null && typeof current === 'object' && !Array.isArray(current)
    ? (current as Record<string, unknown>)
    : {};
  const managed = normalizeManagedEntries(previouslyManaged);
  const managedKey = exclusionKeyFor(managedDir);
  const userEntries: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(currentMap)) {
    const entry = managed.find((e) => e.key === key);
    const isManagedUntouched = entry !== undefined && entry.value === value;
    if (!isManagedUntouched) {
      userEntries[key] = value;
    }
  }
  // If the user changed the value of the key kode currently manages (e.g. true->false), kode yields and does not write it back.
  const ourEntry = managed.find((e) => e.key === managedKey);
  const userOverrodeManaged = ourEntry !== undefined && currentMap[managedKey] !== ourEntry.value;
  const managedEntries = enabled && !userOverrodeManaged
    ? [{ key: managedKey, value: true } as ManagedExclusionEntry]
    : [];
  const next: Record<string, unknown> = { ...userEntries };
  for (const entry of managedEntries) {
    next[entry.key] = entry.value;
  }
  const changed =
    Object.keys(next).length !== Object.keys(currentMap).length ||
    Object.keys(next).some((key) => next[key] !== currentMap[key]);
  return { next, changed, managedKeys: managedEntries };
}
