/**
 * KODE-CFG-017 inference face: pyrefly infer external binary discovery +
 * argument construction + write-permission gate.
 * The pure logic layer does not import vscode; the wiring layer entry is the
 * sync entry at the end of the file (same pattern as pythonExtraPaths: pure
 * functions re-tested, thin executor).
 *
 * Verification conclusion (todo KODE-CFG-017): the correct subcommand is
 * `infer` (aggressive inference over local literals + reference chains), not
 * `stubgen` (1.4.0 falls back to Incomplete for everything unannotated); def
 * ground truth is fed in via `--search-path` (.kbengine/stubs) so inference
 * follows the truth chain.
 */

import * as path from 'path';
import { pathApiFor } from './workspacePath';

// ---------------------------------------------------------------------------
// Write-permission gate (user order 2026-11-03): writes outside the scope are
// always denied, never silently. Until the Rust core migration lands, this
// function is the mandatory checkpoint for every disk-write path; semantics
// match the Rust side: Managed (default, .kbengine/** only) | UserSource
// (additionally scripts/**, must be explicitly enabled).
// ---------------------------------------------------------------------------

export type SourceWriteScope = 'managed' | 'user';

export const SOURCE_WRITE_SCOPE_MANAGED: SourceWriteScope = 'managed';
export const SOURCE_WRITE_SCOPE_USER: SourceWriteScope = 'user';

export interface WriteScopeDecision {
  allowed: boolean;
  /** Denial reason (always present when allowed=false; surfaced for diagnostics, never silent) */
  reason?: string;
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Gate decision (pure function): whether target falls inside the write domain
 * allowed by the scope.
 * - managed: writable only inside <workspaceRoot>/<managedDir>/**;
 * - user: managed domain ∪ <scriptsRoot>/** (requires the user to explicitly
 *   enable `kbengine.infer.sourceWrite=user`; default is managed).
 */
export function assertWritable(
  target: string,
  scope: SourceWriteScope,
  workspaceRoot: string,
  managedDir: string,
  scriptsRoot: string
): WriteScopeDecision {
  const managedRoot = path.join(workspaceRoot, managedDir);
  if (isInside(managedRoot, target)) {
    return { allowed: true };
  }
  if (scope === SOURCE_WRITE_SCOPE_USER && isInside(scriptsRoot, target)) {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason:
      scope === SOURCE_WRITE_SCOPE_MANAGED
        ? `write denied outside managed dir (${managedDir}/): ${target}`
        : `write denied outside managed dir (${managedDir}/) and scripts root: ${target}`
  };
}

// ---------------------------------------------------------------------------
// Binary discovery: setting > PATH > pipx default location.
// ---------------------------------------------------------------------------

export interface PyreflyDiscoveryDeps {
  exists: (absPath: string) => boolean;
  /** PATH environment variable string (wiring layer passes process.env.PATH; tests inject) */
  envPath?: string;
  /** User home directory (pipx default location ~/.local/bin) */
  homeDir?: string;
}

const PYREFLY_BINARY = 'pyrefly';
const PYREFLY_WINDOWS_BINARY = 'pyrefly.exe';

/** Discover the absolute path of the pyrefly executable; returns null when not found (feature degrades without an error) */
export function discoverPyrefly(settingPath: unknown, deps: PyreflyDiscoveryDeps): string | null {
  if (typeof settingPath === 'string' && settingPath.trim() !== '') {
    const candidate = settingPath.trim();
    return deps.exists(candidate) ? candidate : null;
  }
  const pathEnv = deps.envPath ?? '';
  const names = pathEnv.includes(';') ? [PYREFLY_WINDOWS_BINARY, PYREFLY_BINARY] : [PYREFLY_BINARY];
  for (const dir of pathEnv.split(path.delimiter).filter(segment => segment !== '')) {
    for (const name of names) {
      // WIN-3: join per directory style -- POSIX dirs (leading /) keep /,
      // win drive letters take the platform path; otherwise win32 joins
      // /usr/local/bin into \usr\local\bin, mismatching the probe.
      const candidate = pathApiFor(dir).join(dir, name);
      if (deps.exists(candidate)) {
        return candidate;
      }
    }
  }
  if (deps.homeDir) {
    const candidate = pathApiFor(deps.homeDir).join(deps.homeDir, '.local', 'bin', PYREFLY_BINARY);
    if (deps.exists(candidate)) {
      return candidate;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Argument construction.
// ---------------------------------------------------------------------------

/**
 * `pyrefly infer --python-version <v> --search-path <stubs>... <targetDir>`
 * (target Python 3.7 is the KBEngine embedded interpreter version;
 * search-path feeds def ground truth).
 */
export function buildInferArgs(
  pythonVersion: string,
  searchPaths: readonly string[],
  targetDir: string
): string[] {
  const args = ['infer', '--python-version', pythonVersion];
  for (const searchPath of searchPaths) {
    args.push('--search-path', searchPath);
  }
  args.push(targetDir);
  return args;
}

// ---------------------------------------------------------------------------
// Execution (wiring layer injects spawn; tests do not depend on a real pyrefly).
// ---------------------------------------------------------------------------

export interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { cwd?: string }
) => Promise<SpawnResult>;

export type PyreflyRunStatus = 'ran' | 'ran-with-errors' | 'not-found';

export interface PyreflyRunOutcome {
  status: PyreflyRunStatus;
  /** Process exit code (absent for not-found) */
  code?: number;
  /** stderr summary when the exit code is non-zero (for diagnostics) */
  stderr?: string;
}
