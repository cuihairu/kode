import { describe, expect, it } from 'vitest';
import {
  formatLiveWatcherEvidence,
  liveVerificationIdentity,
  reconcileWatcherEvidence,
  runLiveWatcherPathVerification,
  watcherProtocolSourceFor,
  type LiveWatcherVerificationRecord
} from '../src/liveWatcherVerification';
import {
  COMPONENT_NAMES,
  type KBEngineComponentInfo,
  type WatcherQueryResult
} from '../src/backend/kbengineProtocol';
import { WATCHER_MESSAGE_PROTOCOL_AUDIT, WATCHER_PROTOCOL_AUDIT_VERSION } from '../src/watcherProtocolAudit';

function makeComponent(overrides: Partial<KBEngineComponentInfo> = {}): KBEngineComponentInfo {
  return {
    uid: 1000,
    username: 'tester',
    componentType: 5,
    componentID: 9001n,
    componentIDEx: 0n,
    globalOrderID: 0,
    groupOrderID: 1,
    genuuidSections: 0,
    intaddr: '192.168.5.117',
    intport: 20005,
    extaddr: '192.168.5.117',
    extport: 20006,
    extaddrEx: 'imac',
    pid: 3120,
    cpu: 1.5,
    mem: 32,
    usedmem: 8,
    state: 1,
    machineID: 1,
    extradata: 0n,
    extradata1: 0n,
    extradata2: 0n,
    extradata3: 0n,
    backaddr: 0,
    backport: 0,
    componentName: 'cellapp',
    fullName: 'cellapp1',
    ...overrides
  };
}

describe('liveWatcherVerification (IDE-LIV-003)', () => {
  it('runs a real-shape query and freezes identity + raw frames into evidence', async () => {
    const frames: WatcherQueryResult[] = [
      { type: 0, path: '/cellapp', values: { uptime: 42, bytesPerSecond: 120.5 }, keys: [] },
      { type: 1, path: '', keys: ['/cellapp/stats', '/cellapp/goods'] }
    ];
    const queried: string[] = [];
    const protocol = {
      queryWatcherPath: async (component: KBEngineComponentInfo, path: string) => {
        queried.push(`${component.componentType}:${component.componentID}:${path}`);
        return frames;
      }
    };
    const record = await runLiveWatcherPathVerification(protocol, makeComponent(), '/cellapp');

    expect(queried).toEqual(['5:9001:/cellapp']);
    expect(record.ok).toBe(true);
    expect(record.identity).toEqual({
      componentType: 5,
      componentName: 'cellapp',
      componentID: '9001',
      fullName: 'cellapp1',
      address: '192.168.5.117:20005',
      pid: 3120
    });
    // 原始帧保线序不重排,是联验证据的原始面
    expect(record.frames).toEqual(frames);
    // 面板口径行与 watcherResultRows 同源:叶子读数 + 目录项都在
    expect(record.rows).toEqual([
      { path: '/cellapp/uptime', kind: 'value', value: '42' },
      { path: '/cellapp/bytesPerSecond', kind: 'value', value: '120.5' },
      { path: '/cellapp/stats', kind: 'child', value: '' },
      { path: '/cellapp/goods', kind: 'child', value: '' }
    ]);
    expect(record.protocolSource).toContain('41002');
    expect(record.protocolSource).toContain(WATCHER_PROTOCOL_AUDIT_VERSION.commit);
  });

  it('records ok=false with the raw error instead of fabricating frames', async () => {
    const protocol = {
      queryWatcherPath: async () => {
        throw new Error('connect ECONNREFUSED 192.168.5.117:20005');
      }
    };
    const record = await runLiveWatcherPathVerification(protocol, makeComponent(), '/cellapp');
    expect(record.ok).toBe(false);
    expect(record.error).toBe('connect ECONNREFUSED 192.168.5.117:20005');
    expect(record.frames).toEqual([]);
    expect(record.rows).toEqual([]);
    expect(record.queriedAt).toBeTruthy();
  });

  it('reconciles panel values against engine-console reference per path', () => {
    const record: LiveWatcherVerificationRecord = {
      kind: 'watcher',
      identity: liveVerificationIdentity(makeComponent()),
      path: '/cellapp',
      frames: [{ type: 0, path: '/cellapp', values: { uptime: 42 }, keys: [] }],
      rows: [
        { path: '/cellapp/uptime', kind: 'value', value: '42' },
        { path: '/cellapp/load', kind: 'value', value: '0.25' }
      ],
      queriedAt: '2026-11-07T00:00:00.000Z',
      ok: true,
      protocolSource: watcherProtocolSourceFor(5)
    };
    const reference = { '/cellapp/uptime': '42', '/cellapp/load': '0.31' };
    const reconciliation = reconcileWatcherEvidence(record, reference);
    expect(reconciliation.ok).toBe(false);
    expect(reconciliation.lines).toEqual([
      { path: '/cellapp/uptime', panelValue: '42', referenceValue: '42', verdict: 'match' },
      { path: '/cellapp/load', panelValue: '0.25', referenceValue: '0.31', verdict: 'mismatch' }
    ]);

    const matched = reconcileWatcherEvidence(record, { '/cellapp/uptime': '42' });
    expect(matched.lines[0].verdict).toBe('match');
    expect(reconcileWatcherEvidence(record, {}).lines[0].verdict).toBe('no-reference');
    // 全无参考时 ok=false(未对账不能算一致)
    expect(reconcileWatcherEvidence(record, {}).ok).toBe(false);
  });

  it('formats evidence text carrying identity, frames, protocol source and verdicts', () => {
    const record: LiveWatcherVerificationRecord = {
      kind: 'watcher',
      identity: liveVerificationIdentity(makeComponent()),
      path: '/cellapp',
      frames: [{ type: 0, path: '/cellapp', values: { uptime: 42 }, keys: [] }],
      rows: [{ path: '/cellapp/uptime', kind: 'value', value: '42' }],
      queriedAt: '2026-11-07T00:00:00.000Z',
      ok: true,
      protocolSource: watcherProtocolSourceFor(5)
    };
    const text = formatLiveWatcherEvidence(
      record,
      reconcileWatcherEvidence(record, { '/cellapp/uptime': '42' })
    );
    expect(text).toContain('[LIV-003] watcher 路径联验 2026-11-07T00:00:00.000Z');
    expect(text).toContain('cellapp1 (type=5/cellapp, id=9001, pid=3120, addr=192.168.5.117:20005)');
    expect(text).toContain("原始帧: type=0 path='/cellapp' values={\"uptime\":42} keys=[]");
    expect(text).toContain('对账: /cellapp/uptime 面板=42 → 一致');
    expect(text).toContain('对账结论: 全部一致');
    expect(text).toContain('<Cellapp::queryWatcher><id>41002');
  });

  it('names the protocol source from the audit table and refuses unaudited components', () => {
    const cellapp = watcherProtocolSourceFor(5);
    expect(cellapp).toContain(
      WATCHER_MESSAGE_PROTOCOL_AUDIT.find(entry => entry.componentName === 'cellapp')?.requestSource ?? ''
    );
    // machine(8) 无 watcher 请求号:如实说明未发请求,不借用邻居组件号
    expect(watcherProtocolSourceFor(COMPONENT_NAMES.indexOf('machine'))).toContain(
      '不在 watcher 协议审计表'
    );
  });
});
