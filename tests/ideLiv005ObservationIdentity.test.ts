import { describe, expect, it } from 'vitest';
import {
  describeObservationTarget,
  groupObservationsByTarget,
  observationTargetFor,
  observationsFromRound,
  stampObservationPoint
} from '../src/observationIdentity';
import type { KBEngineComponentInfo } from '../src/kbengineProtocol';

function makeCellapp(componentID: bigint, pid: number, groupOrderID = 1): KBEngineComponentInfo {
  return {
    uid: 1000,
    username: 'tester',
    componentType: 5,
    componentID,
    componentIDEx: 0n,
    globalOrderID: 0,
    groupOrderID,
    genuuidSections: 0,
    intaddr: '192.168.5.117',
    intport: 20005,
    extaddr: '192.168.5.117',
    extport: 20006,
    extaddrEx: 'imac',
    pid,
    cpu: 1,
    mem: 16,
    usedmem: 4,
    state: 1,
    machineID: 1,
    extradata: 0n,
    extradata1: 0n,
    extradata2: 0n,
    extradata3: 0n,
    backaddr: 0,
    backport: 0,
    componentName: 'cellapp',
    fullName: `cellapp${groupOrderID}`,
    ...{}
  };
}

describe('observationIdentity (IDE-LIV-005)', () => {
  it('keys targets by componentType:componentID, never by name or pid', () => {
    const app1 = makeCellapp(11n, 3120);
    const app2 = makeCellapp(22n, 3121, 2);
    expect(observationTargetFor(app1).targetKey).toBe('5:11');
    expect(observationTargetFor(app2).targetKey).toBe('5:22');
    // label 只是展示;两个实例 label 相似也不共用身份
    expect(observationTargetFor(app1).label).toBe('cellapp1');
    expect(observationTargetFor(app2).label).toBe('cellapp2');
  });

  it('keeps two same-type instances in separate buckets with no value mixing', () => {
    const app1 = makeCellapp(11n, 3120);
    const app2 = makeCellapp(22n, 3121, 2);
    const points = observationsFromRound(
      [
        { component: app1, values: { '/cellapp/uptime': 100 } },
        { component: app2, values: { '/cellapp/uptime': 200 } }
      ],
      '2026-11-07T00:00:00.000Z'
    );
    const groups = groupObservationsByTarget(points);
    expect([...groups.keys()].sort()).toEqual(['5:11', '5:22']);
    expect(groups.get('5:11')?.map(point => point.value)).toEqual([100]);
    expect(groups.get('5:22')?.map(point => point.value)).toEqual([200]);
    // 每个观测点自带身份戳,单独拿出来也归属清晰
    for (const point of points) {
      if (point.value === 200) {
        expect(point.target.targetKey).toBe('5:22');
      } else {
        expect(point.target.targetKey).toBe('5:11');
      }
    }
  });

  it('keeps identity stable across rediscovery when pid or label changes', () => {
    const before = makeCellapp(11n, 3120);
    const after = makeCellapp(11n, 9999, 3); // 同一实例重发现:pid/groupOrder 展示变化
    expect(observationTargetFor(before).targetKey).toBe(observationTargetFor(after).targetKey);
    const groups = groupObservationsByTarget([
      stampObservationPoint(before, '/cellapp/uptime', 1, 't1'),
      stampObservationPoint(after, '/cellapp/uptime', 2, 't2')
    ]);
    expect([...groups.keys()]).toEqual(['5:11']);
    expect(groups.get('5:11')?.map(point => point.value)).toEqual([1, 2]);
  });

  it('separates different component types even if ids collide numerically', () => {
    const baseapp = { ...makeCellapp(11n, 100), componentType: 6, componentName: 'baseapp', fullName: 'baseapp1' };
    const points = observationsFromRound(
      [
        { component: makeCellapp(11n, 3120), values: { '/cellapp/uptime': 1 } },
        { component: baseapp, values: { '/baseapp/uptime': 2 } }
      ],
      't'
    );
    const groups = groupObservationsByTarget(points);
    expect([...groups.keys()].sort()).toEqual(['5:11', '6:11']);
    expect(groups.get('5:11')?.[0].path).toBe('/cellapp/uptime');
    expect(groups.get('6:11')?.[0].path).toBe('/baseapp/uptime');
  });

  it('describes targets with both label and stable id', () => {
    expect(describeObservationTarget(observationTargetFor(makeCellapp(11n, 3120)))).toBe(
      'cellapp1 (type=5, id=11)'
    );
  });
});
