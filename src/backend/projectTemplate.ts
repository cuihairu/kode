/**
 * Minimal project creation template manifest (IDE-PRJ-007): an explicit
 * directory/file manifest defining everything that must land on disk when
 * "creating a minimal empty KBEngine project". The manifest lines up with
 * the scripts layout of workspaceDiscovery.DISCOVERY_CONVENTIONS (same
 * shape as demo/assets), and the skeleton it builds is recognized by
 * projectImport.identifyProjectLayout on all three faces — entities/defs/
 * scripts (the "importable" precondition of IDE-PRJ-008).
 *
 * This module is a pure manifest + precheck + preview face:
 * planProjectCreation only probes for existence and never writes to disk;
 * conflicts with existing targets are laid out honestly in
 * plan.conflicts (rejection semantics = non-empty conflicts, wired at the
 * command layer); each preview item carries an exact absolute path, same
 * shape as the generator confirmation face (generationConfirm).
 */

import * as path from 'path';
import type { GenerationPlanItem } from '../generationConfirm';

/** Manifest entry: a directory (only an empty directory is created) or a file (relative path + full content) */
export interface ProjectTemplateDirectory {
  kind: 'directory';
  relativePath: string;
}

export interface ProjectTemplateFile {
  kind: 'file';
  relativePath: string;
  content: string;
}

export type ProjectTemplateEntry = ProjectTemplateDirectory | ProjectTemplateFile;

/**
 * Minimal template (scripts layout, parent directories before child
 * entries): scripts/entities.xml as an empty registry + scripts/entity_defs
 * (containing an empty types.xml) + the two server-side role directories
 * scripts/base and scripts/cell (same roots as the role analysis).
 * The engine repository is not part of the template — an unrecognized
 * engineRoot on an empty project is the norm, and import returns honest
 * null.
 */
export const MINIMAL_PROJECT_TEMPLATE: readonly ProjectTemplateEntry[] = [
  { kind: 'directory', relativePath: 'scripts' },
  { kind: 'file', relativePath: 'scripts/entities.xml', content: '<root>\n</root>\n' },
  { kind: 'directory', relativePath: 'scripts/entity_defs' },
  { kind: 'file', relativePath: 'scripts/entity_defs/types.xml', content: '<root>\n</root>\n' },
  { kind: 'directory', relativePath: 'scripts/base' },
  { kind: 'directory', relativePath: 'scripts/cell' }
];

/** Manifest read (defensive copies, so a caller mutating the listing cannot affect the manifest itself) */
export function listMinimalProjectTemplate(): ProjectTemplateEntry[] {
  return MINIMAL_PROJECT_TEMPLATE.map(entry => ({ ...entry }));
}

/** Precheck dependency (injected for tests; the product face uses the real fs.existsSync) */
export interface ProjectCreationDeps {
  exists: (path: string) => boolean;
}

export interface ProjectCreationPlanEntry {
  entry: ProjectTemplateEntry;
  absolutePath: string;
}

export interface ProjectCreationConflict {
  absolutePath: string;
  reason: string;
}

export interface ProjectCreationPlan {
  targetRoot: string;
  entries: ProjectCreationPlanEntry[];
  /** Full set of conflicts with existing targets (non-empty = the command layer must reject, never writing a half set) */
  conflicts: ProjectCreationConflict[];
}

/**
 * Disk-write precheck: each manifest entry is mapped to an absolute path
 * under the target root, and any already-existing target (file or
 * directory alike) goes into conflicts honestly; a conflict does not
 * truncate entries — the manifest stays fully laid out and the caller
 * enforces rejection by testing that conflicts is non-empty.
 *
 * entries defaults to the minimal template; since DEMO-GAME-006 the demo
 * game template (loaded from disk via
 * demoGameTemplate.loadDemoGameTemplateEntries) travels through the same
 * precheck / preview / disk-write face.
 */
export function planProjectCreation(
  targetRoot: string,
  deps: ProjectCreationDeps,
  entries: readonly ProjectTemplateEntry[] = MINIMAL_PROJECT_TEMPLATE
): ProjectCreationPlan {
  const planned = entries.map(entry => ({
    entry,
    absolutePath: path.join(targetRoot, entry.relativePath)
  }));
  const conflicts = planned
    .filter(({ absolutePath }) => deps.exists(absolutePath))
    .map(({ absolutePath }) => ({ absolutePath, reason: `目标已存在: ${absolutePath}` }));
  return { targetRoot, entries: planned, conflicts };
}

/**
 * Preview items: one line per manifest entry, the label distinguishing a
 * new directory from a new file, and the description the exact absolute
 * path (same source as the write: the same absolutePath). Used directly by
 * the confirmation face (008 wires the command layer into
 * generationConfirm.confirmGenerationPlanItems).
 */
export function buildProjectCreationPreviewItems(plan: ProjectCreationPlan): GenerationPlanItem[] {
  return plan.entries.map(({ entry, absolutePath }) => ({
    label: entry.kind === 'directory' ? `新增目录 ${entry.relativePath}` : `新增文件 ${entry.relativePath}`,
    description: absolutePath
  }));
}
