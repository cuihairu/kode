import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createObservationFreshnessTracker,
  describeObservationFreshness,
  summarizeObservationFreshness
} from '../src/observationConnectionState';
import { observationTargetFor } from '../src/observationIdentity';
import { RuntimeQueryWebView, type RuntimeQueryProtocol } from '../src/runtimeQueryWebView';
import type { KBEngineComponentInfo, SpaceQueryResult, WatcherQueryResult } from '../src/kbengineProtocol';
import { Uri, type ExtensionContext } from './fake-vscode/core';
import { panelRegistry } from './fake-vscode/panelRegistry';
import { configurationOverrides } from './fake-vscode/workspaceState';

const component: KBEngineComponentInfo = {
  uid: 1000,
  username: 'tester',
  componentType: 5,
  componentID: 9001n,
  componentIDEx: 0n,
  globalOrderID: 0,
  groupOrderID: 1,
  genuuidSections: 0,
  intaddr: '127.0.0.1',
  intport: 20005,
  extaddr: '127.0.0.1',
  extport: 20006,
  extaddrEx: 'local',
  pid: 123,
  cpu: 0,
  mem: 0,
  usedmem: 0,
  state: 1,
  machineID: 1,
  extradata: 0n,
  extradata1: 0n,
  extradata2: 0n,
  extradata3: 0n,
  backaddr: 0,
  backport: 0,
  componentName: 'cellapp1',
  fullName: 'cellapp1'
};

const watcher: WatcherQueryResult = { type: 0, path: '/cellapp', values: { uptime: 42 }, keys: [] };
const space: SpaceQueryResult = { componentType: 4, componentID: 1n, spaces: [] };

function makeCellapp(componentID: bigint): KBEngineComponentInfo {
  return {
    uid: 1000,
    username: 'tester',
    componentType: 5,
    componentID,
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
    fullName: 'cellapp1'
  };
}

describe('observationConnectionState (IDE-LIV-006)', () => {
  it('marks stale on failure keeping last-success time, restores live only on real success', () => {
    let now = 0;
    const tracker = createObservationFreshnessTracker(() => new Date(now).toISOString());
    const target = observationTargetFor(makeCellapp(11n));

    now = 1000;
    expect(tracker.recordRound(target, true).state).toBe('live');
    now = 2000;
    const stale = tracker.recordRound(target, false);
    expect(stale.state).toBe('stale');
    expect(stale.lastSuccessAt).toBe(new Date(1000).toISOString());
    expect(stale.lastFailureAt).toBe(new Date(2000).toISOString());
    expect(stale.consecutiveFailures).toBe(1);

    // 断连期间时间流逝不自动转正(无轮次结算)
    now = 60_000;
    expect(tracker.view(target.targetKey)?.state).toBe('stale');

    now = 61_000;
    const restored = tracker.recordRound(target, true);
    expect(restored.state).toBe('live');
    expect(restored.lastSuccessAt).toBe(new Date(61_000).toISOString());
    expect(restored.consecutiveFailures).toBe(0);
  });

  it('counts consecutive failures and tracks targets independently', () => {
    const tracker = createObservationFreshnessTracker(() => '2026-11-07T00:00:00.000Z');
    const app1 = observationTargetFor(makeCellapp(11n));
    const app2 = observationTargetFor(makeCellapp(22n));
    tracker.recordRound(app1, false);
    tracker.recordRound(app1, false);
    tracker.recordRound(app2, true);
    expect(tracker.view('5:11')?.consecutiveFailures).toBe(2);
    expect(tracker.view('5:11')?.state).toBe('stale');
    expect(tracker.view('5:22')?.state).toBe('live');
    tracker.recordRound(app1, true);
    expect(tracker.view('5:11')?.consecutiveFailures).toBe(0);
  });

  it('stale with no prior success explicitly says there is nothing to show', () => {
    const tracker = createObservationFreshnessTracker(() => 't0');
    const target = observationTargetFor(makeCellapp(11n));
    const stale = tracker.recordRound(target, false);
    expect(stale.lastSuccessAt).toBeUndefined();
    expect(describeObservationFreshness(stale)).toContain('尚无成功读数,无旧值可显示');
    expect(describeObservationFreshness(stale)).toContain('断连于 t0');
  });

  it('describes live with the reading time and stale with old-value time', () => {
    const tracker = createObservationFreshnessTracker(() => 't1');
    const target = observationTargetFor(makeCellapp(11n));
    tracker.recordRound(target, true);
    tracker.recordRound(target, false);
    const text = describeObservationFreshness(tracker.view(target.targetKey)!);
    expect(text).toContain('过期(断连于 t1,连续失败 1 轮)');
    expect(text).toContain('当前显示 t1 的旧值,重连成功前不转实时');
    expect(describeObservationFreshness(tracker.recordRound(target, true))).toContain('实时(最近成功读数');
  });

  it('summarizes overall freshness naming stale targets', () => {
    const summary = summarizeObservationFreshness([
      { targetKey: '5:11', state: 'stale', consecutiveFailures: 2 },
      { targetKey: '5:22', state: 'live', lastSuccessAt: 't', consecutiveFailures: 0 }
    ]);
    expect(summary.allLive).toBe(false);
    expect(summary.staleTargets).toEqual(['5:11']);
    expect(summarizeObservationFreshness([{ targetKey: '5:22', state: 'live', consecutiveFailures: 0 }]).allLive).toBe(true);
  });
});

// 面板接线:流式轮询某轮失败→state.freshness=过期(旧值保留);下一轮真实
// 成功→恢复实时;主动停流→新鲜度清空(停流不是断连)。
describe('RuntimeQueryWebView freshness wiring (IDE-LIV-006)', () => {
  const context: ExtensionContext = { subscriptions: [], extensionUri: Uri.file('/tmp') };
  const flush = async (): Promise<void> => {
    for (let tick = 0; tick < 20; tick += 1) {
      await Promise.resolve();
    }
  };
  const postState = () => {
    const message = panelRegistry.panels[0].webview.postedMessages.at(-1)?.message as Record<string, unknown>;
    return message;
  };

  beforeEach(() => {
    panelRegistry.reset();
    configurationOverrides.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('marks stale on a failed stream round and restores live on the next success', async () => {
    vi.useFakeTimers();
    configurationOverrides.set('kbengine', {
      'runtimeQuery.enabled': true,
      'runtimeQuery.pollIntervalMs': 600
    });
    let ok = true;
    let calls = 0;
    const flaky: RuntimeQueryProtocol = {
      discoverComponents: async () => [component],
      querySpaces: async () => space,
      queryWatcherPath: async (): Promise<WatcherQueryResult[]> => {
        calls += 1;
        if (ok) return [watcher];
        throw new Error('connect ETIMEDOUT 192.168.5.117:20005');
      }
    };
    const webview = new RuntimeQueryWebView(context, flaky);
    webview.show();
    await flush();
    const panel = panelRegistry.panels[0];
    panelRegistry.fireMessage(panel, { command: 'addWatcher', path: '/cellapp/uptime' });
    panelRegistry.fireMessage(panel, { command: 'toggleStream', componentKey: '5:9001' });
    await flush();
    expect(postState().freshness).toMatchObject({ state: 'live', targetKey: '5:9001' });

    // 断连轮:旧值(上一轮行)保留,新鲜度转过期并点名断连
    ok = false;
    await vi.advanceTimersByTimeAsync(600);
    await flush();
    const staleState = postState();
    expect(staleState.freshness).toMatchObject({ state: 'stale', targetKey: '5:9001' });
    expect(String((staleState.freshness as { text: string }).text)).toContain('过期');
    expect(calls).toBeGreaterThan(1);

    // 重连轮真实成功才恢复实时
    ok = true;
    await vi.advanceTimersByTimeAsync(600);
    await flush();
    expect(postState().freshness).toMatchObject({ state: 'live' });

    // 主动停流:清空新鲜度(停流不是断连)
    panelRegistry.fireMessage(panel, { command: 'toggleStream', componentKey: '5:9001' });
    await flush();
    expect(postState().freshness).toBeNull();
    expect(postState().streaming).toBe(false);
  });
});
