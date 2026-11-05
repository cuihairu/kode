import { beforeEach, describe, expect, it } from 'vitest';

import { resendHotReloadTarget } from '../src/hotReloadRetryCommand';
import { createDefStructuralGate } from '../src/hotReloadDefGate';
import { setupHotReload, type HotReloadTimerDeps } from '../src/hotReload';
import { HotReloadTargetStateStore } from '../src/hotReloadTargetState';
import { configurationOverrides, lastFileSystemWatcher } from './helpers/vscodeStub';

// RT-3(外部深审 2026-11-04)/IDE-HOT-005:失败目标重试不得绕过 def 结构闸——
// fire 路径发送前过 gateDefChanges(结构指纹基线对比),重试此前直接 resend,
// 结构性 def 变更会经「重试」通道以普通 reload 下发。修后重试复用与 fire 相同
// 的闸判定与同一会话基线册:结构性/无基线/不可读一律不发送(不落 failed——
// 拦下是保守拦截不是投递失败),非结构 def 与纯 Python 批照常重发。

const BASE_DEF = `<root>
  <Properties>
    <hp>
      <Type>INT32</Type>
      <Flags>CELL_PRIVATE</Flags>
    </hp>
  </Properties>
  <BaseMethods>
    <attack>
      <Arg>INT32</Arg>
    </attack>
  </BaseMethods>
</root>
`;
const STRUCTURAL_DEF = BASE_DEF.replace('<Type>INT32</Type>', '<Type>FLOAT</Type>');
const NONSTRUCTURAL_DEF = `<!-- 注释不进指纹 -->\n${BASE_DEF}`;

const makeTimers = (): { timers: HotReloadTimerDeps; tick: () => void } => {
  const handles = new Map<unknown, () => void>();
  return {
    tick: () => {
      const callbacks = [...handles.values()];
      handles.clear();
      for (const callback of callbacks) {
        callback();
      }
    },
    timers: {
      set: (callback): unknown => {
        const handle = handles.size;
        handles.set(handle, callback);
        return handle;
      },
      clear: (handle): void => {
        handles.delete(handle);
      }
    }
  };
};

const KEY = { rootId: '/ws', targetId: 'baseapp#1' };

describe('重试路径 def 结构闸(RT-3 / IDE-HOT-005)', () => {
  let baselines: Map<string, string>;
  let content: string | null;
  let restartNotices: Array<{ targetId: string; files: string[]; reasons: string[] }>;

  const makeGate = () => createDefStructuralGate(async () => content, baselines);

  const makeStore = (): HotReloadTargetStateStore => {
    const store = new HotReloadTargetStateStore({ now: () => 1 });
    store.record(KEY, '/ws/entities/Avatar.def', 'failed', { detail: 'ECONNREFUSED' });
    store.record(KEY, '/ws/scripts/cell/Avatar.py', 'failed', { detail: 'ECONNREFUSED' });
    return store;
  };

  const resend = async (store: HotReloadTargetStateStore, gate = makeGate()) => {
    const runCalls: string[] = [];
    const clock = makeTimers();
    const result = await resendHotReloadTarget(store, KEY, {
      runAction: name => {
        runCalls.push(name);
        return true;
      },
      resolveActionNameForTarget: () => '热更',
      targetState: {
        store,
        resolveTargetId: () => 'baseapp#1',
        resolveRootId: () => '/ws'
      },
      timers: clock.timers,
      settleHandles: new Set<unknown>(),
      defGate: gate,
      onRestartRequired: (targetId, files, reasons) => {
        restartNotices.push({ targetId, files: [...files], reasons: [...reasons] });
      }
    });
    return { result, runCalls };
  };

  beforeEach(() => {
    baselines = new Map();
    content = BASE_DEF;
    restartNotices = [];
    configurationOverrides.clear();
    lastFileSystemWatcher.current = null;
  });

  it('结构性 def 变更:重试被拦,不发送不落账,发需重启通知', async () => {
    baselines.set('/ws/entities/Avatar.def', BASE_DEF);
    content = STRUCTURAL_DEF;
    const store = makeStore();
    const { result, runCalls } = await resend(store);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('需要重启');
    expect(runCalls).toEqual([]);
    // 拦下是保守拦截不是投递失败:台账原样保留 failed 旧账,不追加新记录
    expect(store.files(KEY)).toHaveLength(2);
    expect(store.get(KEY, '/ws/entities/Avatar.def')?.outcome).toBe('failed');
    // 拦下通知状态机标 RESTART_REQUIRED 呈现
    expect(restartNotices).toHaveLength(1);
    expect(restartNotices[0].targetId).toBe('baseapp#1');
    expect(restartNotices[0].reasons[0]).toContain('属性结构变化');
  });

  it('非结构 def 变更(注释/空白):重试照常发送', async () => {
    baselines.set('/ws/entities/Avatar.def', BASE_DEF);
    content = NONSTRUCTURAL_DEF;
    const store = makeStore();
    const { result, runCalls } = await resend(store);
    expect(result.ok).toBe(true);
    expect(runCalls).toEqual(['热更']);
    expect(restartNotices).toHaveLength(0);
  });

  it('会话首见 def 无基线:保守拦下不发送', async () => {
    content = BASE_DEF;
    const store = makeStore();
    const { result, runCalls } = await resend(store);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('无基线');
    expect(runCalls).toEqual([]);
    expect(restartNotices[0].reasons[0]).toContain('无基线');
  });

  it('闸基线逐次滚动:拦下后基线更新,下次重试放行(与 fire 闸同语义)', async () => {
    baselines.set('/ws/entities/Avatar.def', BASE_DEF);
    content = STRUCTURAL_DEF;
    const store = makeStore();
    const gate = makeGate();
    const first = await resend(store, gate);
    expect(first.result.ok).toBe(false);
    expect(first.runCalls).toEqual([]);
    // 与 fire 闸一致:被拦批次也把基线滚到当前内容,再次判定不再重复拦
    const second = await resend(store, gate);
    expect(second.result.ok).toBe(true);
    expect(second.runCalls).toEqual(['热更']);
  });

  it('重试复用与 fire 相同的闸实例:fire 闸拦下滚动基线后重试放行(同一基线册)', async () => {
    const store = makeStore();
    const clock = makeTimers();
    const runCalls: string[] = [];
    content = BASE_DEF;
    baselines.clear();
    configurationOverrides.set('kbengine', {
      hotReload: { enabled: true, actionName: '热更', debounceMs: 100, globs: ['**/*.def'] }
    });
    const sharedGate = makeGate();
    setupHotReload(
      { subscriptions: [] } as never,
      (name: string) => {
        runCalls.push(name);
        return true;
      },
      {
        timers: clock.timers,
        defGate: sharedGate,
        targetState: {
          store,
          resolveTargetId: () => 'baseapp#1',
          resolveRootId: () => '/ws'
        }
      }
    );
    // fire 路径:def 首见无基线 → 闸拦下,基线滚到当前内容,动作未执行
    (lastFileSystemWatcher.current as unknown as {
      fireChange: (event: { fsPath: string }) => void;
    }).fireChange({ fsPath: '/ws/entities/Avatar.def' });
    clock.tick();
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(runCalls).toEqual([]);
    // 同一闸实例(同一基线册)给重试用:基线已滚,重试放行
    const { result, runCalls: retryCalls } = await resend(store, sharedGate);
    expect(result.ok).toBe(true);
    expect(retryCalls).toEqual(['热更']);
  });
});
