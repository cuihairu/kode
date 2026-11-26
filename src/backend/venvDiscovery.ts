/**
 * venv auto-discovery (PY-ENV phase 2): scans the workspace (and its subdirectories,
 * up to a depth cap) for virtual environments. An environment is accepted only on
 * evidence — a venv is evidenced by a pyvenv.cfg file, a conda environment by a
 * conda-meta/ directory, and the interpreter binary (bin/python or, on Windows,
 * Scripts/python.exe) must actually exist on disk to be recorded; broken environments
 * (a marker without a binary / a binary without a marker) are never accepted, never
 * fabricated. The scan face is fully decoupled from pythonScanRules (the Python
 * source-code class index): no shared candidate lists, no shared pruning rules, no
 * cross imports. Everything is pure existence probing; no program is ever executed.
 *
 * Besides the synchronous version (scanVenvs) there is an async layer (scanVenvsAsync
 * + discoverVenvsCached, KODE-RESP-010): directory reads go through async I/O with a
 * yield between directories, keeping the event-loop heartbeat alive under wide
 * directories / slow filesystems; the total-directory / time budgets and the cancel
 * token stop the walk the moment they hit their limits; results are cached per root
 * and per configuration generation (the agreed-name list), and multiple consumers
 * share one in-flight discovery. Product main threads (UI/status bar/picker) always
 * use the async layer; the synchronous version is reserved for callers that have
 * definitely left the main thread.
 */

import * as fs from 'fs';
import * as path from 'path';

/** Scan depth cap (0 = the scan root itself, one level) */
export const MAX_VENV_SCAN_DEPTH = 3;

/**
 * Pruned directory names: dependency trees / build outputs / version-control
 * directories may contain environment-looking directories, but none of them is a project
 * environment the user intends, so they are never entered (note .venv/venv are legal
 * candidates and not in this list).
 */
export const DEFAULT_PRUNED_DIRECTORY_NAMES: readonly string[] = [
  'node_modules',
  'target',
  '.git',
  '__pycache__',
  'dist',
  'coverage',
  '.cache'
];

/** A single discovered environment */
export interface DiscoveredVenv {
  /** Absolute path of the environment directory */
  rootPath: string;
  /** Directory name (basename) */
  name: string;
  /** Absolute path of the verified interpreter binary */
  interpreterPath: string;
  /** Evidence type: pyvenv.cfg = venv, conda-meta = conda */
  envKind: 'venv' | 'conda';
  /** Depth relative to the scan root (directly under root = 0) */
  depth: number;
}

export interface VenvScanOptions {
  /** Depth cap, defaults to MAX_VENV_SCAN_DEPTH */
  maxDepth?: number;
  /** Pruned directory-name list, defaults to DEFAULT_PRUNED_DIRECTORY_NAMES */
  prunedDirectoryNames?: readonly string[];
  /** Platform (test injection); defaults to process.platform */
  platform?: NodeJS.Platform;
  /** Same-depth preferred directory-name hints (continuing the venvDirectories configuration semantics) */
  preferredNames?: readonly string[];
}

/** Whether this directory name is in the prune list (exact match; venv candidate names are not in the list) */
export function shouldPruneVenvScanDirectory(
  name: string,
  pruned: readonly string[] = DEFAULT_PRUNED_DIRECTORY_NAMES
): boolean {
  return pruned.includes(name);
}

/** Platform-specific interpreter binary candidates (bin|Scripts × python|python3[.exe]); a conda
 * environment's interpreter on Windows often sits in the environment root (python.exe), appended by envKind */
export function venvBinaryCandidates(
  dir: string,
  platform: NodeJS.Platform,
  envKind: 'venv' | 'conda' | null = null
): string[] {
  const binDir = path.join(dir, platform === 'win32' ? 'Scripts' : 'bin');
  const layout =
    platform === 'win32'
      ? [path.join(binDir, 'python.exe'), path.join(binDir, 'python3.exe')]
      : [path.join(binDir, 'python'), path.join(binDir, 'python3')];
  if (platform === 'win32' && envKind === 'conda') {
    return [
      path.join(dir, 'python.exe'),
      path.join(dir, 'python3.exe'),
      ...layout
    ];
  }
  return layout;
}

/** Existence probing counts real files only (directories / symlink-to-dir do not count); statSync follows symlinks,
 * and a venv's bin/python is a symlink pointing at the system interpreter, still judged real */
const isFileCandidate = (candidate: string): boolean => {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
};

/**
 * Environment evidence ruling: a pyvenv.cfg file → venv; a conda-meta directory →
 * conda; neither → null (not an environment, no guessing). venv evidence wins (when
 * both are on disk it is recorded as venv).
 */
export function hasEnvMarker(dir: string): 'venv' | 'conda' | null {
  try {
    if (fs.statSync(path.join(dir, 'pyvenv.cfg')).isFile()) {
      return 'venv';
    }
  } catch {
    // No pyvenv.cfg, keep checking conda evidence
  }
  try {
    if (fs.statSync(path.join(dir, 'conda-meta')).isDirectory()) {
      return 'conda';
    }
  } catch {
    // No conda-meta
  }
  return null;
}

/**
 * Verify that a directory is a usable environment: environment evidence present + the
 * interpreter binary on disk. Returns the interpreter path; null when any evidence is
 * missing (a broken environment is not accepted and no path is fabricated).
 */
export function verifyVenvDirectory(
  dir: string,
  platform: NodeJS.Platform = process.platform
): string | null {
  const kind = hasEnvMarker(dir);
  if (!kind) {
    return null;
  }
  for (const candidate of venvBinaryCandidates(dir, platform, kind)) {
    if (isFileCandidate(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Depth-first scan of the environment under root (depth capped, prune list never
 * entered; after discovering an environment, never descend into it — a nested
 * environment inside an environment is not anyone's intent). Ordering: shallower
 * first, lexicographic within the same depth; names matching preferredNames are moved
 * earlier within the same depth (the resolution chain uses this so the directory-name
 * hint configuration semantics still work).
 */
export function scanVenvs(root: string, options: VenvScanOptions = {}): DiscoveredVenv[] {
  const maxDepth = options.maxDepth ?? MAX_VENV_SCAN_DEPTH;
  const pruned = options.prunedDirectoryNames ?? DEFAULT_PRUNED_DIRECTORY_NAMES;
  const platform = options.platform ?? process.platform;
  const found: Array<DiscoveredVenv & { preferred: boolean }> = [];
  const preferredSet = new Set(options.preferredNames ?? []);

  const visit = (dir: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directories are skipped honestly
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || shouldPruneVenvScanDirectory(entry.name, pruned)) {
        continue;
      }
      const child = path.join(dir, entry.name);
      const interpreterPath = verifyVenvDirectory(child, platform);
      if (interpreterPath) {
        found.push({
          rootPath: child,
          name: entry.name,
          interpreterPath,
          envKind: hasEnvMarker(child) === 'conda' ? 'conda' : 'venv',
          depth,
          preferred: preferredSet.has(entry.name)
        });
        continue; // do not descend into the environment
      }
      if (depth < maxDepth) {
        visit(child, depth + 1);
      }
    }
  };

  visit(root, 0);
  return sortDiscoveredVenvs(found);
}

/** Sorting (shared by both the sync/async scans, zero drift): shallower first, same-depth agreed-name hits
 * (preferredNames) moved before others, then lexicographic */
const sortDiscoveredVenvs = (
  found: Array<DiscoveredVenv & { preferred: boolean }>
): DiscoveredVenv[] =>
  found
    .sort(
      (a, b) =>
        a.depth - b.depth ||
        Number(b.preferred) - Number(a.preferred) ||
        a.name.localeCompare(b.name)
    )
    .map(({ preferred: _preferred, ...env }) => env);

// ---- Async scan layer (KODE-RESP-010): wide directories / slow filesystems must not freeze the extension host main thread ----

/** Total directory-access budget of the async scan (including the scan root and agreed-candidate probing; stops once hit in large repos) */
export const MAX_VENV_SCAN_DIRECTORIES = 4096;
/** Total time budget of the async scan (ms); on timeout, returns the portion discovered so far */
export const VENV_SCAN_DEADLINE_MS = 5000;

export interface VenvScanAsyncOptions extends VenvScanOptions {
  /** Total-directory budget, defaults to MAX_VENV_SCAN_DIRECTORIES; stops the deep scan once hit */
  maxDirectories?: number;
  /** Time budget ms, defaults to VENV_SCAN_DEADLINE_MS */
  deadlineMs?: number;
  /** Cancel token: after aborted is set, no deeper scanning happens (the in-flight scan converges on the portion already found) */
  signal?: { aborted: boolean };
  /** Directory-read injection face (tests inject a slow filesystem); defaults to fs.promises.readdir */
  readDirectory?: (dir: string) => Promise<fs.Dirent[]>;
  /** Yield between directories (defaults to setImmediate); the event-loop heartbeat is guaranteed by it */
  yieldControl?: () => Promise<void>;
}

const yieldToEventLoop = (): Promise<void> => new Promise<void>(resolve => setImmediate(resolve));

const readDirectoryDefault = (dir: string): Promise<fs.Dirent[]> =>
  fs.promises.readdir(dir, { withFileTypes: true });

/**
 * The async version of scanVenvs (KODE-RESP-010): directory reads go through
 * async I/O with one yield between directories (setImmediate, injectable), keeping
 * the event-loop heartbeat running continuously; stops when the total-directory /
 * time budget is hit or the cancel token is set — no deeper scanning, and the
 * discovered portion is returned honestly (no fabricated completeness). Agreed
 * candidates (preferredNames) are probed directly first — common .venv/venv layouts
 * need not wait for the whole tree walk; the walk follows the same rules as the
 * synchronous version (depth cap / prune list / no descending into environments), and
 * its output ordering matches the synchronous version.
 */
export async function scanVenvsAsync(
  root: string,
  options: VenvScanAsyncOptions = {}
): Promise<DiscoveredVenv[]> {
  const maxDepth = options.maxDepth ?? MAX_VENV_SCAN_DEPTH;
  const pruned = options.prunedDirectoryNames ?? DEFAULT_PRUNED_DIRECTORY_NAMES;
  const platform = options.platform ?? process.platform;
  const maxDirectories = options.maxDirectories ?? MAX_VENV_SCAN_DIRECTORIES;
  const deadline = Date.now() + (options.deadlineMs ?? VENV_SCAN_DEADLINE_MS);
  const readDirectory = options.readDirectory ?? readDirectoryDefault;
  const yieldControl = options.yieldControl ?? yieldToEventLoop;
  const preferredNames = options.preferredNames ?? [];
  const preferredSet = new Set(preferredNames);
  const found: Array<DiscoveredVenv & { preferred: boolean }> = [];
  const claimed = new Set<string>();
  let visited = 0;

  // Budget/cancel/time triple gate: once any triggers, no further directory reads happen
  const exhausted = (): boolean =>
    visited >= maxDirectories || options.signal?.aborted === true || Date.now() > deadline;

  const record = (dir: string, name: string, depth: number): void => {
    const interpreterPath = verifyVenvDirectory(dir, platform);
    if (interpreterPath) {
      claimed.add(dir);
      found.push({
        rootPath: dir,
        name,
        interpreterPath,
        envKind: hasEnvMarker(dir) === 'conda' ? 'conda' : 'venv',
        depth,
        preferred: preferredSet.has(name)
      });
    }
  };

  // Probe agreed candidates first (single-point stat validation, independent of the full
  // tree walk): common .venv/venv layouts hit right here; unmatched names are still
  // recorded honestly by the later walk. Once hit, the candidate is claimed — the walk
  // does not re-validate it nor descend into the environment (same rule as the
  // synchronous version's "no descending into environments").
  for (const name of preferredNames) {
    if (exhausted()) {
      break;
    }
    visited += 1;
    await yieldControl();
    const candidate = path.join(root, name);
    if (!claimed.has(candidate)) {
      record(candidate, name, 0);
    }
  }

  const visit = async (dir: string, depth: number): Promise<void> => {
    if (exhausted()) {
      return;
    }
    visited += 1;
    await yieldControl();
    let entries: fs.Dirent[];
    try {
      entries = await readDirectory(dir);
    } catch {
      return; // unreadable directories are skipped honestly
    }
    for (const entry of entries) {
      if (exhausted()) {
        return;
      }
      if (!entry.isDirectory() || shouldPruneVenvScanDirectory(entry.name, pruned)) {
        continue;
      }
      const child = path.join(dir, entry.name);
      if (!claimed.has(child)) {
        record(child, entry.name, depth);
      }
      if (!claimed.has(child) && depth < maxDepth) {
        await visit(child, depth + 1);
      }
    }
  };

  await visit(root, 0);
  return sortDiscoveredVenvs(found);
}

// ---- Discovery cache layer (KODE-RESP-010): cache per root and configuration generation + in-flight sharing ----

const VENV_DISCOVERY_CACHE_CAPACITY = 4;
const venvDiscoveryCache = new Map<string, DiscoveredVenv[]>();
const venvDiscoveryInFlight = new Map<string, Promise<DiscoveredVenv[]>>();

/** Cache key = platform + root + sorted agreed-name list: the configuration content enters
 * the key (cache per root and configuration generation), so a change to venvDirectories
 * naturally changes the key and rescans; a different name order is treated as the same
 * configuration generation */
export function venvDiscoveryCacheKey(
  root: string,
  preferredNames: readonly string[],
  platform: NodeJS.Platform = process.platform
): string {
  return [platform, root, ...[...preferredNames].sort()].join('|');
}

/** A read-only cache peek that does not trigger a scan (undefined = no hot value); the UI uses it to show existing candidates first */
export function peekVenvDiscoveryCache(
  root: string,
  preferredNames: readonly string[],
  platform: NodeJS.Platform = process.platform
): DiscoveredVenv[] | undefined {
  return venvDiscoveryCache.get(venvDiscoveryCacheKey(root, preferredNames, platform));
}

/** Clears the cache and in-flight records (for test isolation) */
export function clearVenvDiscoveryCache(): void {
  venvDiscoveryCache.clear();
  venvDiscoveryInFlight.clear();
}

/**
 * Cached discovery: a hot value returns directly (the UI shows existing candidates
 * first, no rescan); a cold value starts one budgeted async scan, and multiple
 * consumers with the same key share the same in-flight Promise (one in-flight
 * discovery), which writes the cache for later consumption once it converges. A
 * failed scan is not cached and throws honestly (the next call can retry). The first
 * consumer's options carries this scan's budget parameters; the cache key only
 * recognizes the root / agreed names / platform.
 */
export function discoverVenvsCached(
  root: string,
  options: VenvScanAsyncOptions = {}
): Promise<DiscoveredVenv[]> {
  const preferredNames = options.preferredNames ?? [];
  const key = venvDiscoveryCacheKey(root, preferredNames, options.platform);
  const cached = venvDiscoveryCache.get(key);
  if (cached) {
    return Promise.resolve(cached);
  }
  const inFlight = venvDiscoveryInFlight.get(key);
  if (inFlight) {
    return inFlight;
  }
  const discovery = scanVenvsAsync(root, options).then(
    envs => {
      venvDiscoveryCache.set(key, envs);
      if (venvDiscoveryCache.size > VENV_DISCOVERY_CACHE_CAPACITY) {
        const oldest = venvDiscoveryCache.keys().next().value;
        if (oldest !== undefined) {
          venvDiscoveryCache.delete(oldest);
        }
      }
      venvDiscoveryInFlight.delete(key);
      return envs;
    },
    error => {
      venvDiscoveryInFlight.delete(key);
      throw error;
    }
  );
  venvDiscoveryInFlight.set(key, discovery);
  return discovery;
}

/**
 * Parse the version number out of `python --version` output: take the "Python x.y.z"
 * shape, and when that cannot be done, honestly return null (the display face omits
 * the version segment rather than fabricating one).
 */
export function parsePythonVersionOutput(output: string): string | null {
  const match = output.match(/Python\s+(\d+\.\d+\.\d+)/);
  return match ? match[1] : null;
}
