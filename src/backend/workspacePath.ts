import * as path from 'path';
import { substituteVariables, type VariableFolderRef } from './variableSubstitution';

export function joinWorkspacePath(basePath: string, ...segments: string[]): string {
  if (usesPosixPath(basePath)) {
    return path.posix.join(basePath, ...segments.map(segment => segment.replace(/\\/g, '/')));
  }

  // Go with win32 semantics explicitly: when relying on the platform-implicit path,
  // on linux/macOS hosts path.join is the posix implementation and would produce a
  // wrong mixed-separator result for C:\ paths.
  return path.win32.join(basePath, ...segments);
}

export function usesPosixPath(targetPath: string): boolean {
  return !/^[A-Za-z]:[\\/]/.test(targetPath) && targetPath.includes('/');
}

/**
 * WIN-3: pure path logic picks the path implementation by input-path style (a
 * platform-parameterized pure function, testable). On POSIX platforms path is posix;
 * on win32 both backslashes and drive-letter prefixes (drive + forward/backward
 * slash, `C:/` and `C:\`) are platform-style signals — a `\` or a drive-letter prefix
 * goes to path.win32, while a leading `/` and relative pure-`/` shapes go to
 * path.posix (unit tests and the uri.path derived face). Mixing them makes win32's
 * join/resolve/relative normalize /ws/repo into \ws\repo anchored to the current
 * drive, or judge a legitimate in-cwd path as out of bounds, distorting both the
 * output and the consumer's expectation.
 * Audit-finding fix: the old implementation judged style only by includes('\\'), so
 * a drive-letter + forward-slash path (`C:/repo/...`) was misjudged as posix, and
 * path.posix.resolve would wrongly anchor to the cwd; kept consistent with
 * usesPosixPath (which likewise recognizes the `^[A-Za-z]:[\\/]` drive prefix).
 */
export function selectPathApiForPlatform(
  platform: NodeJS.Platform,
  samplePath: string
): path.PlatformPath {
  if (platform !== 'win32') {
    return path;
  }
  return /^[A-Za-z]:[\\/]/.test(samplePath) || samplePath.includes('\\') ? path.win32 : path.posix;
}

/** Pick the path implementation by the current host platform (parameterized via selectPathApiForPlatform). */
export function pathApiFor(samplePath: string): path.PlatformPath {
  return selectPathApiForPlatform(process.platform, samplePath);
}

/**
 * The single source of truth for path-template rendering (delegates to src/
 * variableSubstitution's official variable table): placeholders like
 * `${workspaceFolder}` and `${env:...}` → rendered plain text, **with no join/
 * anchoring** — anchoring to the workspace root remains each chain's own path
 * semantics' responsibility.
 *
 * Both chains use this function; the same input must give the same output
 * (equivalence locked by tests/pathTemplateEquivalence.test.ts):
 * - the manual-input chain definitionWorkspace.resolveWorkspacePath (settings keys
 *   such as kbengine.entityDefsPath → layout candidates)
 * - the discovery chain workspaceDiscovery.resolveAgainstWorkspace (the explicit
 *   configuration inventory of the diagnostic report)
 * Previously the manual chain skipped rendering, so `${workspaceFolder}/...` in a
 * setting was spliced literally into the def root as a relative path
 * (`<root>/${workspaceFolder}/scripts/entity_defs`, which could never exist),
 * disagreeing with the discovery chain's conclusion → the def root was located in
 * the wrong place.
 */
export function renderPathTemplate(value: string, workspaceRoot: string): string {
  const folders: VariableFolderRef[] = [{ fsPath: workspaceRoot, name: '' }];
  return substituteVariables(value, { folders });
}

/**
 * Expand VS Code official variables (since batch 141 delegated to src/
 * variableSubstitution as the single source of truth for replacement logic; the same
 * semantics as serverManager.getBinPath, and since batch 112 the telnet engine
 * defaults derivation and the final configuration synthesis share this
 * implementation).
 *
 * Keeps this function's existing "unresolved falls to the empty string" semantics:
 * a path-class setting whose variable cannot be read is treated as not written, so
 * one missing environment variable never takes down the whole extension wiring. The
 * throw semantics are chosen by quickActionConfig's command side itself.
 */
export function expandWorkspacePlaceholders(
  value: string,
  workspaceRoot: string | undefined
): string {
  const resolved = workspaceRoot
    ? renderPathTemplate(value, workspaceRoot)
    : substituteVariables(value, { folders: [] });
  if (resolved.length === 0 || path.isAbsolute(resolved)) {
    return resolved;
  }
  // A relative result is always resolved against the repository root (user order
  // 2026-10-16: never assume the current cwd);
  // no workspace root to anchor → empty string (callers skip as "unresolved", never probing relative to cwd)
  return workspaceRoot ? joinWorkspacePath(workspaceRoot, resolved) : '';
}
