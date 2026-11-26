/**
 * Isolate Python analysis roots by base/cell role (IDE-PRJ-006). The KBEngine server side's
 * scripts/base/<entity>.py and scripts/cell/<entity>.py often contain same-named modules (the
 * base Avatar and the cell Avatar are two separate implementations); merging both role
 * directories into one python.analysis.extraPaths list means whoever is listed first wins
 * `import Avatar`, so cross-role misresolution is decided by ordering alone.
 *
 * Isolation policy: role directories (server analysis roles = base/cell, same source as
 * scriptFoldersForRole; client/bots are not server analysis roles) never enter the merged list
 * -- the merged list only takes the scripts root itself. Same-named module sets are reported
 * as they are (findCrossRoleModuleCollisions) for the health summary / sync broadcast, so
 * ordering no longer decides resolution. Paths the user fills in by hand are outside this
 * module's jurisdiction (extraPaths only governs its own entries).
 */

import { scriptFoldersForRole } from '../definitionWorkspace';

/** Server analysis role (client/bots are the client/bot faces; they do not enter server analysis roots) */
export type PythonAnalysisRole = 'base' | 'cell';

export interface RoleAnalysisRoots {
  /** The scripts root (a legitimate member of the merged list) */
  scriptsRoot: string;
  /** Role directories that actually exist on disk (base/cell) */
  roleRoots: Array<{ role: PythonAnalysisRole; root: string }>;
}

export interface RoleRootDeps {
  /** Path existence check (injected for tests) */
  exists: (path: string) => boolean;
  /** List the .py file names in a directory (with extension; injected for tests) */
  listPyFiles: (dir: string) => string[];
}

function toPosix(candidate: string): string {
  return candidate.replace(/\\/g, '/');
}

/** Resolve the role directories under the scripts root: only base/cell entries that actually exist on disk */
export function resolveRoleAnalysisRoots(scriptsRoot: string, deps: Pick<RoleRootDeps, 'exists'>): RoleAnalysisRoots {
  const roleRoots: Array<{ role: PythonAnalysisRole; root: string }> = [];
  for (const role of ['base', 'cell'] as const) {
    for (const folder of scriptFoldersForRole(role)) {
      const root = toPosix(`${scriptsRoot.replace(/[\\/]+$/, '')}/${folder}`);
      if (deps.exists(root)) {
        roleRoots.push({ role, root });
      }
    }
  }
  return { scriptsRoot: toPosix(scriptsRoot), roleRoots };
}

/**
 * Cross-role same-named module list: module names present in >=2 role directories (.py
 * stripped, exact name match), output sorted. These modules are exactly the ones "merged by
 * ordering would misresolve"; once reported, the isolation policy provides the backstop (the
 * merged list contains no role roots, so nobody can win).
 */
export function findCrossRoleModuleCollisions(
  roots: RoleAnalysisRoots,
  deps: Pick<RoleRootDeps, 'listPyFiles'>
): string[] {
  const byModule = new Map<string, Set<PythonAnalysisRole>>();
  for (const { role, root } of roots.roleRoots) {
    for (const fileName of deps.listPyFiles(root)) {
      if (!fileName.endsWith('.py')) {
        continue;
      }
      const moduleName = fileName.slice(0, -'.py'.length);
      const roles = byModule.get(moduleName) ?? new Set<PythonAnalysisRole>();
      roles.add(role);
      byModule.set(moduleName, roles);
    }
  }
  return [...byModule.entries()]
    .filter(([, roles]) => roles.size > 1)
    .map(([moduleName]) => moduleName)
    .sort();
}

/**
 * Isolation gate: strip entries from the merged list that match a role root exactly
 * (order-sensitive resolution of top-level same-named modules only happens at the role root
 * level; deeper entries live in a different namespace than the role roots and are left alone).
 * Order-independent -- whatever the input order, the output kept set contains no role root, so
 * cross-role same-named modules have no entry that can win in the merged list.
 */
export function enforceRoleIsolation(
  paths: readonly string[],
  roots: RoleAnalysisRoots
): { kept: string[]; removedRoleRoots: string[] } {
  const roleRootSet = new Set(roots.roleRoots.map(entry => entry.root));
  const kept: string[] = [];
  const removedRoleRoots: string[] = [];
  for (const candidate of paths) {
    const normalized = toPosix(candidate.replace(/[\\/]+$/, ''));
    if (roleRootSet.has(normalized)) {
      removedRoleRoots.push(normalized);
      continue;
    }
    kept.push(candidate);
  }
  return { kept, removedRoleRoots };
}
