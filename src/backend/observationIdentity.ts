/**
 * 用稳定目标身份关联观测结果(IDE-LIV-005):观测点/曲线一律按
 * `componentType:componentID`(引擎唯一且跨轮稳定)关联,fullName 与
 * pid 只做展示——同一组件类型的两个实例 fullName 可能相似、pid 各自
 * 不同,按名或按 pid 归组都会把数值/曲线混进别的实例。发现轮之间
 * componentID 不变,pid 变化(进程内线程号面)或 fullName 展示变化都
 * 不换归属。任何观测点缺身份宁可不归组(unknown-target),不落邻居桶。
 */

import type { KBEngineComponentInfo } from './kbengineProtocol';

/** 稳定目标身份:引擎内唯一、跨发现轮稳定;展示名与 pid 都不参与 */
export interface ObservationTarget {
  targetKey: string;
  componentType: number;
  componentID: string;
  /** 仅展示,不参与归组/关联 */
  label: string;
}

export interface ObservationPoint<TValue = string | number | boolean> {
  target: ObservationTarget;
  /** 全路径或观测名 */
  path: string;
  value: TValue;
  observedAt: string;
}

/** 广播发现的组件 → 稳定观测身份(key=type:id;label 仅展示) */
export function observationTargetFor(component: KBEngineComponentInfo): ObservationTarget {
  return {
    targetKey: `${component.componentType}:${component.componentID.toString()}`,
    componentType: component.componentType,
    componentID: component.componentID.toString(),
    label: component.fullName
  };
}

/** 单个观测点打身份戳:没身份的组件宁可不产生观测点 */
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
 * 按稳定身份归组:同类型不同 componentID 的两个实例必然分桶;同一实
 * 例跨轮(pid/label 变化)仍在同桶。桶与桶之间零共享可变状态。
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

/** 目标身份文案(展示用;key 仍是稳定身份,不点名混淆) */
export function describeObservationTarget(target: ObservationTarget): string {
  return `${target.label} (type=${target.componentType}, id=${target.componentID})`;
}

/**
 * 把一轮读数按组件归属展开成观测点;同一轮里同类型多实例各自成点,
 * 互不覆盖——这是「不混合数值/曲线」的入口约束。
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
