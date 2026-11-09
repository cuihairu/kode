/**
 * 启动项直接依赖(RUN-005):LaunchTargetSpec.dependsOn 声明直接依赖键
 * (组件名或 组件名#targetId),resolveLaunchOrder 拓扑排序并检测环
 * (报出环路径);isDependencySatisfied 是唯一「依赖成功」判据——记录在
 * 册且 status=Running 才算就绪,Starting/缺席/放弃等待(RUN-004)都不算。
 * 依赖排序是静态面,就绪判定是运行期面,两者分离(RUN-006 编排消费)。
 */

export interface LaunchTargetSpec {
  /** 目标键:组件名(默认实例)或 组件名#targetId */
  key: string;
  /** 直接依赖键;本组之外的依赖不参与排序,留给运行期就绪判定 */
  dependsOn: readonly string[];
}

export type LaunchOrderResult =
  | { ok: true; order: string[] }
  | { ok: false; kind: 'cycle'; cycle: string[] };

/**
 * 拓扑排序(波次法):组内直接依赖全部已发射才可发射,同波按输入序(确定性);
 * 组外依赖不参与排序。一轮无进展即有环,沿组内依赖边走一圈报出环路径
 * (首尾同名)。
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

/** 沿组内依赖边走一圈,报出首尾同名的环路径 */
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

/** 就绪判定的最小面:登记键 → 状态(含 RUN-004 放弃标记) */
export interface DependencyReadyState {
  status: string;
  readinessGivenUp?: 'timeout' | 'cancelled';
}

/**
 * 依赖就绪判定:登记键命中且 status=Running 才算成功。带 #targetId 的
 * 键查精确实例;纯组件名的键按「任一该组件实例就绪」(组件级依赖适用
 * 全部实例,RUN-001 多实例口径)。
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
