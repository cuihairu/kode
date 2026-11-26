/**
 * Correlate observation results by stable target identity (IDE-LIV-005): observation
 * points and curves are always keyed by `componentType:componentID` (unique inside the
 * engine and stable across rounds); fullName and pid are display-only -- two instances of
 * the same component type can have similar fullNames and different pids, so grouping by
 * name or by pid would bleed values/curves into another instance. Across discovery rounds
 * componentID is unchanged while pid changes (the in-process thread-number surface) and
 * fullName display may change; neither reassigns ownership. An observation point missing
 * identity should rather stay ungrouped (unknown-target) than fall into a neighbour bucket.
 */

import type { KBEngineComponentInfo } from './kbengineProtocol';

/** Stable target identity: unique inside the engine, stable across discovery rounds; neither the display name nor the pid participates */
export interface ObservationTarget {
  targetKey: string;
  componentType: number;
  componentID: string;
  /** Display only; does not participate in grouping/correlation */
  label: string;
}

export interface ObservationPoint<TValue = string | number | boolean> {
  target: ObservationTarget;
  /** Full path or observation name */
  path: string;
  value: TValue;
  observedAt: string;
}

/** Broad-cast-discovered component -> stable observation identity (key=type:id; label display-only) */
export function observationTargetFor(component: KBEngineComponentInfo): ObservationTarget {
  return {
    targetKey: `${component.componentType}:${component.componentID.toString()}`,
    componentType: component.componentType,
    componentID: component.componentID.toString(),
    label: component.fullName
  };
}

/** Stamp one observation point with its identity: a component without identity should rather produce no observation point */
export function stampObservationPoint<TValue>(
  component: KBEngineComponentInfo,
  path: string,
  value: TValue,
  observedAt: string
): ObservationPoint<TValue> {
  return {
    target: observationTargetFor(component),
    path,
    value,
    observedAt
  };
}

/**
 * Group by stable identity: two instances of the same type with different componentIDs
 * are always separated into different buckets; the same instance across rounds (pid/label
 * changes) stays in the same bucket. Buckets share no mutable state with each other.
 */
export function groupObservationsByTarget<TValue>(
  points: Array<ObservationPoint<TValue>>
): Map<string, Array<ObservationPoint<TValue>>> {
  const groups = new Map<string, Array<ObservationPoint<TValue>>>();
  for (const point of points) {
    const bucket = groups.get(point.target.targetKey);
    if (bucket) {
      bucket.push(point);
    } else {
      groups.set(point.target.targetKey, [point]);
    }
  }
  return groups;
}

/** Target identity wording (for display; the key remains the stable identity, no naming mix-up) */
export function describeObservationTarget(target: ObservationTarget): string {
  return `${target.label} (type=${target.componentType}, id=${target.componentID})`;
}

/**
 * Expand one round of readings into observation points by component ownership; within a
 * round, multiple instances of the same type each become their own point and never
 * overwrite one another -- this is the entry constraint behind "do not mix values/curves".
 */
export function observationsFromRound<TValue>(
  readings: Array<{ component: KBEngineComponentInfo; values: Record<string, TValue> }>,
  observedAt: string
): Array<ObservationPoint<TValue>> {
  const points: Array<ObservationPoint<TValue>> = [];
  for (const reading of readings) {
    for (const [path, value] of Object.entries(reading.values)) {
      points.push(stampObservationPoint(reading.component, path, value, observedAt));
    }
  }
  return points;
}
