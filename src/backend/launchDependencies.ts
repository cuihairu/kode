/**
 * Direct dependencies of launch targets (RUN-005): LaunchTargetSpec.dependsOn declares
 * direct dependency keys (a component name, or componentName#targetId); resolveLaunchOrder
 * topologically sorts and detects cycles (reporting the cycle path);
 * isDependencySatisfied is the sole "dependency succeeded" criterion -- it only counts when
 * it is registered and status=Running; Starting/absent/given-up waiting (RUN-004) do not
 * count. Dependency ordering is a static face and readiness checking is a runtime face; the
 * two are kept separate (consumed by the RUN-006 orchestration).
 */

export interface LaunchTargetSpec {
  /** Target key: a component name (the default instance) or componentName#targetId */
  key: string;
  /** Direct dependency keys; dependencies outside this group do not participate in the ordering and are left to the runtime readiness check */
  dependsOn: readonly string[];
}

export type LaunchOrderResult =
  | { ok: true; order: string[] }
  | { ok: false; kind: 'cycle'; cycle: string[] };

/**
 * Topological sort (wave method): a target may be emitted only once all of its in-group
 * direct dependencies have been emitted; within a wave the input order applies
 * (deterministic); dependencies outside the group do not participate. If a round makes no
 * progress there is a cycle -- walk one loop along the in-group dependency edges and report
 * the cycle path (same name at both ends).
 */
export function resolveLaunchOrder(targets: readonly LaunchTargetSpec[]): LaunchOrderResult {
  const byKey = new Map(targets.map(target => [target.key, target]));
  for (const target of targets) {
    if (target.dependsOn.includes(target.key)) {
      return { ok: false, kind: 'cycle', cycle: [target.key, target.key] };
    }
  }

  const order: string[] = [];
  const emitted = new Set<string>();
  let progressed = true;
  while (order.length < targets.length && progressed) {
    progressed = false;
    for (const target of targets) {
      if (emitted.has(target.key)) {
        continue;
      }
      const inGroupDeps = target.dependsOn.filter(dep => byKey.has(dep));
      if (inGroupDeps.every(dep => emitted.has(dep))) {
        emitted.add(target.key);
        order.push(target.key);
        progressed = true;
      }
    }
  }

  if (order.length < targets.length) {
    return { ok: false, kind: 'cycle', cycle: findCyclePath(targets) };
  }
  return { ok: true, order };
}

/** Walk one loop along the in-group dependency edges and report the cycle path with the same name at both ends */
function findCyclePath(targets: readonly LaunchTargetSpec[]): string[] {
  const byKey = new Map(targets.map(target => [target.key, target]));
  const visited = new Set<string>();
  const path: string[] = [];
  const walk = (key: string): string[] | null => {
    if (path.includes(key)) {
      return [...path.slice(path.indexOf(key)), key];
    }
    if (visited.has(key)) {
      return null;
    }
    visited.add(key);
    const target = byKey.get(key);
    if (!target) {
      return null;
    }
    for (const dependency of target.dependsOn) {
      if (!byKey.has(dependency)) {
        continue;
      }
      path.push(key);
      const cycle = walk(dependency);
      if (cycle) {
        return cycle;
      }
      path.pop();
    }
    return null;
  };
  for (const target of targets) {
    const cycle = walk(target.key);
    if (cycle) {
      return cycle;
    }
  }
  return [...targets.map(target => target.key)];
}

/** Minimal face for the readiness check: registered key -> status (including the RUN-004 given-up marker) */
export interface DependencyReadyState {
  status: string;
  readinessGivenUp?: 'timeout' | 'cancelled';
}

/**
 * Dependency readiness check: it only counts as success when the registered key matches and
 * status=Running. A key carrying #targetId looks up that exact instance; a bare component
 * name key means "any instance of that component is ready" (a component-level dependency
 * applies to all instances, the RUN-001 multi-instance accounting).
 */
export function isDependencySatisfied(
  key: string,
  entries: ReadonlyMap<string, DependencyReadyState>
): boolean {
  const hashIndex = key.indexOf('#');
  if (hashIndex >= 0) {
    const entry = entries.get(key);
    return entry?.status === 'running' && entry.readinessGivenUp === undefined;
  }
  for (const [entryKey, entry] of entries) {
    if (entryKey === key || entryKey.startsWith(`${key}#`)) {
      if (entry.status === 'running' && entry.readinessGivenUp === undefined) {
        return true;
      }
    }
  }
  return false;
}
