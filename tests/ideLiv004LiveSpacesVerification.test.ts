import { describe, expect, it } from 'vitest';
import {
  SPACES_UNKNOWN_FIELD,
  formatLiveSpacesEvidence,
  runLiveSpacesVerification,
  spacesProtocolSource
} from '../src/liveSpacesVerification';
import type { KBEngineComponentInfo, SpaceQueryResult } from '../src/backend/kbengineProtocol';

function makeComponent(
  componentType: number,
  componentID: bigint,
  overrides: Partial<KBEngineComponentInfo> = {}
): KBEngineComponentInfo {
  return {
    uid: 1000,
    username: 'tester',
    componentType,
    componentID,
    componentIDEx: 0n,
    globalOrderID: 0,
    groupOrderID: 1,
    genuuidSections: 0,
    intaddr: '192.168.5.117',
    intport: 20000 + componentType,
    extaddr: '192.168.5.117',
    extport: 21000 + componentType,
    extaddrEx: 'imac',
    pid: 3000 + componentType,
    cpu: 0.5,
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
    componentName: componentType === 4 ? 'cellappmgr' : 'cellapp',
    fullName: componentType === 4 ? 'cellappmgr' : `cellapp${groupSuffix(componentID)}`,
    ...overrides
  };
}

function groupSuffix(componentID: bigint): string {
  return componentID === 11n ? '1' : '2';
}

describe('liveSpacesVerification (IDE-LIV-004)', () => {
  it('runs a real spaces query, reconciles cellapp identity, marks missing fields unknown', async () => {
    const manager = makeComponent(4, 1n);
    const cellapp1 = makeComponent(5, 11n);
    const cellapp2 = makeComponent(5, 22n);
    const raw: SpaceQueryResult = {
      componentType: 4,
      componentID: 1n,
      spaces: [
        {
          componentType: 4,
          componentID: 1n,
          cellappID: 11n,
          spaceID: 3,
          geomappingPath: 'spaces/main',
          scriptModuleName: 'spaces_main',
          cells: [101, 102]
        },
        {
          componentType: 4,
          componentID: 1n,
          cellappID: 99n, // 广播里没有的 cellappID → 对不上
          spaceID: 4,
          geomappingPath: '',
          scriptModuleName: '',
          cells: []
        }
      ]
    };
    const protocol = {
      querySpaces: async () => raw
    };
    const record = await runLiveSpacesVerification(protocol, manager, [manager, cellapp1, cellapp2]);

    expect(record.ok).toBe(true);
    expect(record.manager).toMatchObject({ componentType: 4, componentID: '1', componentName: 'cellappmgr' });
    expect(record.snapshots[0]).toEqual({
      spaceID: '3',
      cellappID: '11',
      geomappingPath: 'spaces/main',
      scriptModuleName: 'spaces_main',
      cells: '101,102',
      cellappVerdict: 'matched',
      matchedCellapp: 'cellapp1@192.168.5.117:20005'
    });
    // 对不上的 cellappID 如实标 unknown-cellapp,缺失字段显式「未知」不猜
    expect(record.snapshots[1]).toMatchObject({
      spaceID: '4',
      cellappID: '99',
      geomappingPath: SPACES_UNKNOWN_FIELD,
      scriptModuleName: SPACES_UNKNOWN_FIELD,
      cells: SPACES_UNKNOWN_FIELD,
      cellappVerdict: 'unknown-cellapp'
    });
    expect(record.snapshots[1].matchedCellapp).toBeUndefined();
    expect(record.raw).toEqual(raw);
    expect(record.protocolSource).toContain('50003');
  });

  it('records ok=false with the raw error instead of fabricating snapshots', async () => {
    const protocol = {
      querySpaces: async () => {
        throw new Error('connect ETIMEDOUT 192.168.5.117:20004');
      }
    };
    const record = await runLiveSpacesVerification(protocol, makeComponent(4, 1n), []);
    expect(record.ok).toBe(false);
    expect(record.error).toBe('connect ETIMEDOUT 192.168.5.117:20004');
    expect(record.snapshots).toEqual([]);
  });

  it('formats evidence text with identity, per-space verdicts and unknown markers', async () => {
    const manager = makeComponent(4, 1n);
    const cellapp1 = makeComponent(5, 11n);
    const raw: SpaceQueryResult = {
      componentType: 4,
      componentID: 1n,
      spaces: [
        {
          componentType: 4,
          componentID: 1n,
          cellappID: 11n,
          spaceID: 3,
          geomappingPath: 'spaces/main',
          scriptModuleName: 'spaces_main',
          cells: [101]
        }
      ]
    };
    const record = await runLiveSpacesVerification({ querySpaces: async () => raw }, manager, [manager, cellapp1]);
    const text = formatLiveSpacesEvidence(record);
    expect(text).toContain('[LIV-004] 空间列表联验');
    expect(text).toContain('cellappmgr (type=4/cellappmgr, id=1');
    expect(text).toContain('cellapp 对账一致(cellapp1@192.168.5.117:20005)');
    expect(text).toContain('协议引据');
    expect(spacesProtocolSource()).toContain('<Cellappmgr::querySpaces><id>50003');
  });

  it('keeps unknown markers for empty module fields even when cellapp matches', async () => {
    const raw: SpaceQueryResult = {
      componentType: 4,
      componentID: 1n,
      spaces: [
        {
          componentType: 4,
          componentID: 1n,
          cellappID: 11n,
          spaceID: 7,
          geomappingPath: '',
          scriptModuleName: 'base_space',
          cells: []
        }
      ]
    };
    const record = await runLiveSpacesVerification(
      { querySpaces: async () => raw },
      makeComponent(4, 1n),
      [makeComponent(5, 11n)]
    );
    expect(record.snapshots[0]).toMatchObject({
      geomappingPath: SPACES_UNKNOWN_FIELD,
      scriptModuleName: 'base_space',
      cells: SPACES_UNKNOWN_FIELD,
      cellappVerdict: 'matched'
    });
  });
});
