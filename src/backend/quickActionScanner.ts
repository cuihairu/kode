/**
 * First-install scan pure layer (design 1.4, decided on the user's behalf 2026-10-15; updated
 * per user order 2026-10-16):
 * - For each root given by the caller, scan only one level, collecting `.bat` and `.ps1`, no recursion;
 * - the start-stop/export word lists only decide the category and **no longer filter** -- scripts
 *   outside the word lists also become candidates with the category left empty (omitted when
 *   writing config; the schema already allows omitting it), and the user ticks them in the list;
 * - deduplicate by absolute path;
 * - directory reads are injected wholesale; this layer never touches vscode.workspace.fs (the
 *   adapter for real directory reads lives in quickActions).
 */

import * as path from 'path';
import { pathApiFor } from './workspacePath';
import { classifyBatchScript } from './quickActionConfig';
import type { QuickActionCategory } from './quickActionConfig';

/** The value of vscode.FileSystemKind (File=1); fake-vscode does not export that enum, so it is pinned here as the real-value constant */
export const FILE_SYSTEM_KIND_FILE = 1;

const SCRIPT_PATTERN = /\.(bat|ps1)$/i;

export interface DirectoryEntry {
  name: string;
  /** FileSystemKind; absent is treated as a non-file (real vscode always has it; injected doubles may not) */
  type?: number;
}

export interface BatchScriptCandidate {
  path: string;
  /** The category hit by the word lists (start-stop/export); null for scripts outside the lists, the field is omitted when writing config */
  category: QuickActionCategory | null;
}

/** Whether a file is scanned into candidates (one level of .bat/.ps1; the word lists only attach a category in passing, they do not filter); category and path are returned together for easy dedup */
export function scanBatchScripts(
  root: string,
  readDir: (root: string) => DirectoryEntry[]
): BatchScriptCandidate[] {
  let entries: DirectoryEntry[];
  try {
    entries = readDir(root);
  } catch {
    // The root directory cannot be read (permissions / no workspace chosen): silently return an empty list; the caller decides whether to notify
    return [];
  }

  const candidates: BatchScriptCandidate[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== FILE_SYSTEM_KIND_FILE) {
      continue;
    }
    if (!SCRIPT_PATTERN.test(entry.name)) {
      continue;
    }
    // WIN-3: join according to the root's style -- POSIX roots (starting with /) go through posix,
    // win32 fsPath goes through the platform path; otherwise win32 joins /ws into \ws, mismatching consumer expectations.
    const candidatePath = pathApiFor(root).join(root, entry.name);
    const normalized = path.resolve(candidatePath).replace(/\\/g, '/');
    const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    candidates.push({ path: candidatePath, category: classifyBatchScript(entry.name) });
  }
  return candidates;
}

/** Scan multiple root directories and deduplicate by normalized absolute path. */
export function scanBatchScriptsInRoots(
  roots: readonly string[],
  readDir: (root: string) => DirectoryEntry[]
): BatchScriptCandidate[] {
  const byPath = new Map<string, BatchScriptCandidate>();
  for (const root of roots) {
    for (const candidate of scanBatchScripts(root, readDir)) {
      const normalized = path.resolve(candidate.path).replace(/\\/g, '/');
      const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
      if (!byPath.has(key)) byPath.set(key, candidate);
    }
  }
  return [...byPath.values()];
}
