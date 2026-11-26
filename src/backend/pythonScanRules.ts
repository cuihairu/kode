/** Keep workspace discovery and external-root walking on the same exclusion list. */
export const PY_SCAN_EXCLUDED_DIRS = new Set([
  'node_modules', 'third_party', '.git', 'vcpkg', 'build', 'dist',
  'out', '.tmp', 'perf', '.venv', 'venv', 'site-packages', '__pycache__'
]);

export const PY_SCAN_EXCLUDE =
  `**/{${[...PY_SCAN_EXCLUDED_DIRS].join(',')}}/**`;

/**
 * KODE-CFG-017: drop managed-directory copies (prevents double counting of mirrors). The .py
 * copies of the scripts tree mirrored under `.kbengine/inferred/` would be scanned again as
 * independent files by kode itself; the isolation face only writes search.exclude /
 * files.watcherExclude (findFiles does not honor search.exclude), so the scan exit drops
 * managed-directory paths. Three review rounds, P1: decide by **absolute path prefix**
 * (workspaceRoot ∪ external scan roots + the managedDir relative value assemble the managed
 * roots; multi-segment relative configs such as `tools/.kbengine` are supported), not by
 * dropping any same-named segment globally -- ordinary subdirectories/ancestor directories in
 * the user's workspace that happen to share the name are not collateral damage.
 */
export function filterManagedDirCopies(
  paths: readonly string[],
  managedRoots: readonly string[]
): string[] {
  const roots = managedRoots
    .map(r => r.replace(/\/+$/, ''))
    .filter(r => r.length > 0);
  if (roots.length === 0) {
    return [...paths];
  }
  return paths.filter(p => !roots.some(r => p === r || p.startsWith(r.endsWith('/') ? r : `${r}/`)));
}

/** Merge the managed directory name into the external-root walking directory blacklist (dropped too when managedDir lands inside a scan root) */
export function withManagedDirSkip(dirs: ReadonlySet<string>, managedDir: string): Set<string> {
  const out = new Set(dirs);
  if (managedDir && !managedDir.includes('/')) {
    out.add(managedDir);
  }
  return out;
}

/**
 * ENGINE-LIB-SCAN-005 cut 1: the Python standard library mirror bundled in the KBEngine
 * engine repo (kbe/scripts/common/Lib; pure library files, not business code, thousands of
 * files) is excluded from the business python scan by **path shape** -- only paths whose
 * segment sequence contains `kbe/scripts/common/Lib` are dropped; a project's own
 * `Lib`/`lib` directories are unaffected (following the KODE-CFG-017 precedent of
 * "shape/prefix anchoring, no global drop of any same-named segment"). Case-insensitive
 * (the Windows engine repo); both the \ and / separators are recognized.
 */
const ENGINE_LIB_SEGMENT_TAIL = ['kbe', 'scripts', 'common', 'lib'] as const;

export function isEnginePythonLibPath(fsPath: string): boolean {
  const parts = fsPath.toLowerCase().split(/[\\/]+/);
  const tail: readonly string[] = ENGINE_LIB_SEGMENT_TAIL;
  if (parts.length < tail.length) {
    return false;
  }
  outer: for (let i = 0; i + tail.length <= parts.length; i++) {
    for (let j = 0; j < tail.length; j++) {
      if (parts[i + j] !== tail[j]) {
        continue outer;
      }
    }
    return true;
  }
  return false;
}
