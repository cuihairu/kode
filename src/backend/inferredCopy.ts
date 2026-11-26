/**
 * KODE-CFG-017 copy layer: `.kbengine/inferred/` mirrors the scripts tree so
 * pyrefly infer can write annotations in place (the user's real code is
 * never touched). Pure logic layer, no vscode imports.
 *
 * Mirror structure: each scripts root lands under
 * `<managedDir>/inferred/<workspace-relative>/...` by its workspace-relative
 * path (the scripts-root-relative structure is preserved verbatim, so
 * multiple roots do not collide). Content comparison is zero-write
 * (overwrite only when there is a difference), the same discipline as the
 * existing export chain.
 */

import * as path from 'path';

/** Copy root: `<managedDir>/inferred` */
export function inferredDirFor(managedDir: string): string {
  const dir = managedDir.replace(/^\/+|\/+$/g, '');
  return path.posix.join(dir, 'inferred');
}

/** A scripts root's prefix inside the mirror = its workspace-relative path (e.g. `scripts`, `assets/scripts`) */
export function mirrorPrefixFor(workspaceRoot: string, scriptsRoot: string): string {
  const rel = path.relative(workspaceRoot, scriptsRoot).replace(/\\/g, '/');
  return rel === '' ? '.' : rel;
}

export interface InferredMirrorPlan {
  /** Needs creating (source has it, mirror does not) */
  copy: string[];
  /** Needs overwriting (the two sides differ; zero-write discipline: identical content enters no list) */
  overwrite: string[];
  /** Needs deleting (mirror has it, source does not — the residue left after a source file was deleted/renamed; only cleaned within the mirror's managed segment) */
  deleteStale: string[];
  /** Already identical (idempotence confirmation, for status reporting) */
  unchanged: string[];
}

export interface InferredMirrorDeps {
  /** Read text; returns null when the file does not exist */
  readText: (absPath: string) => string | null;
}

/**
 * Mirror plan (pure function): both sourceFiles / existingInferred are
 * relative paths (e.g. `base/Avatar.py`). Content comparison is zero-write;
 * deletion only clears residue within the relative-path set "managed by this
 * mirror" and never oversteps to delete user files.
 */
export function planInferredMirror(
  sourceRoot: string,
  inferredRoot: string,
  sourceFiles: readonly string[],
  existingInferred: readonly string[],
  deps: InferredMirrorDeps
): InferredMirrorPlan {
  const sourceSet = new Set(sourceFiles);
  const copy: string[] = [];
  const overwrite: string[] = [];
  const unchanged: string[] = [];
  for (const rel of sourceFiles) {
    const inferredPath = path.join(inferredRoot, rel);
    const inferredText = deps.readText(inferredPath);
    if (inferredText === null) {
      copy.push(rel);
      continue;
    }
    const sourceText = deps.readText(path.join(sourceRoot, rel));
    if (sourceText === null) {
      // The source file vanished after planning: skip it (the next sync round will move it into deleteStale)
      continue;
    }
    if (sourceText === inferredText) {
      unchanged.push(rel);
      continue;
    }
    overwrite.push(rel);
  }
  const deleteStale: string[] = [];
  for (const rel of existingInferred) {
    if (!sourceSet.has(rel)) {
      deleteStale.push(rel);
    }
  }
  return { copy, overwrite, deleteStale, unchanged };
}

/** Directory entry (injected by the wiring layer: the Dirent shape of fs.readdirSync) */
export interface InferredDirEntry {
  name: string;
  isDir: boolean;
}

export interface SourceFilesResult {
  /** The .py/.pyi relative paths successfully enumerated (depth unbounded) */
  files: string[];
  /**
   * A directory read failed during enumeration (permissions / transient IO,
   * say). The result is incomplete: the caller must never conclude from it
   * that "a mirror file is stale" — a failed read is not an empty directory,
   * and treating it as one would wrongly delete existing copies.
   */
  incomplete: boolean;
}

/**
 * Enumerate the .py/.pyi relative paths to be mirrored under a scripts root
 * (depth unbounded). When a directory entry does not distinguish file vs
 * directory, isDir decides whether to descend; .py/.pyi files are collected,
 * everything else is skipped. A failed directory read sets incomplete=true
 * and skips that subtree (no throw); the caller uses incomplete to forbid
 * deletions — "a read failed" and "a genuinely empty directory" must stay
 * distinguishable.
 */
export function listSourceFiles(
  scriptsRoot: string,
  deps: { listDir: (absPath: string) => readonly InferredDirEntry[] }
): SourceFilesResult {
  const result: string[] = [];
  let incomplete = false;
  const walk = (absDir: string, relDir: string): void => {
    let entries: readonly InferredDirEntry[];
    try {
      entries = deps.listDir(absDir);
    } catch {
      incomplete = true;
      return;
    }
    for (const entry of entries) {
      const abs = `${absDir}/${entry.name}`;
      const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      if (entry.isDir) {
        walk(abs, rel);
        continue;
      }
      if (entry.name.endsWith('.py') || entry.name.endsWith('.pyi')) {
        result.push(rel);
      }
    }
  };
  walk(scriptsRoot, '');
  return { files: result, incomplete };
}
