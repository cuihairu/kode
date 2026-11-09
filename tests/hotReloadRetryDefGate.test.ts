import { beforeEach, describe, expect, it } from 'vitest';

import { resendHotReloadTarget } from '../src/backend/hotReloadRetryCommand';
import { createDefStructuralGate } from '../src/backend/hotReloadDefGate';
import { setupHotReload, type HotReloadTimerDeps } from '../src/hotReload';
import { HotReloadTargetStateStore } from '../src/backend/hotReloadTargetState';
import type { ReloadTransport } from '../src/backend/hotReloadTransport';
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

  it('F1 回归:被拦批次不前滚基线——重复重试持续拦下,重启确认后才放行', async () => {
    baselines.set('/ws/entities/Avatar.def', BASE_DEF);
    content = STRUCTURAL_DEF;
    const store = makeStore();
    const gate = makeGate();
    const first = await resend(store, gate);
    expect(first.result.ok).toBe(false);
    expect(first.runCalls).toEqual([]);
    // F1:被拦批次不前滚基线——再次重试仍与引擎已加载基线比对,持续拦下
    // (旧实现拦后基线滚动,第二次重试放行,绕过需重启)
    const second = await resend(store, gate);
    expect(second.result.ok).toBe(false);
    expect(second.result.detail).toContain('需要重启');
    expect(second.runCalls).toEqual([]);
    // 明确重启确认(引擎已加载 STRUCTURAL_DEF)→ 基线建立/对齐,重试放行
    expect(await gate.confirmLoaded!()).toBe(1);
    const third = await resend(store, gate);
    expect(third.result.ok).toBe(true);
    expect(third.runCalls).toEqual(['热更']);
  });

  it('F1 二轮回归:放行判定后内容再变,commit 只落判定时快照,基线绝不进未判定内容', async () => {
    baselines.set('/ws/entities/Avatar.def', BASE_DEF);
    const gate = makeGate();
    // 判定时读到的内容与基线结构一致 → 放行
    content = BASE_DEF;
    const verdict = await gate.check(['/ws/entities/Avatar.def']);
    expect(verdict.reasons).toEqual([]);
    // 判定后、commit 前文件变成结构性变更:旧实现 commit 重读文件,会把这份
    // 从未通过判定的内容滚进基线;修后 commit 只落判定时快照
    content = STRUCTURAL_DEF;
    await gate.commit!(verdict.token);
    // 基线必须仍是判定过的 A——被拦/未应用内容重发时按旧基线保守拦下
    expect(baselines.get('/ws/entities/Avatar.def')).toBe(BASE_DEF);
    const second = await gate.check(['/ws/entities/Avatar.def']);
    expect(second.reasons.length).toBeGreaterThan(0);
    expect(second.reasons[0]).toContain('属性结构变化');
  });

  it('F1 二轮回归:「放行→内容变更→重试」时序——重试基线只滚判定时内容,再变内容不得经重试绕过', async () => {
    baselines.set('/ws/entities/Avatar.def', BASE_DEF);
    const gate = createDefStructuralGate(
      // 第一次读(check 判定)返回与基线一致的内容并同步翻转为结构性内容:
      // 旧实现 commit 重读会拿到翻转后的未判定内容并滚进基线,下一次重试
      // 与该内容指纹相同即放行(需重启被绕过);修后 commit 用判定快照。
      async () => {
        const read = content;
        content = STRUCTURAL_DEF;
        return read;
      },
      baselines
    );
    const store = makeStore();
    const first = await resend(store, gate);
    expect(first.result.ok).toBe(true);
    expect(first.runCalls).toEqual(['热更']);
    // 基线只滚判定时内容(A),不是未判定过的 B
    expect(baselines.get('/ws/entities/Avatar.def')).toBe(BASE_DEF);
    // 当前内容已是结构性 B 且从未通过判定:再次重试必须拦下
    const second = await resend(store, gate);
    expect(second.result.ok).toBe(false);
    expect(second.result.detail).toContain('需要重启');
    expect(second.runCalls).toEqual([]);
  });

  it('重试复用与 fire 相同的闸实例:fire 拦下后重试同被拦(同一基线册,不因 fire 拦截而放行)', async () => {
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
    // fire 路径:def 首见无基线 → 闸拦下,动作未执行;F1:拦下不建立基线
    (lastFileSystemWatcher.current as unknown as {
      fireChange: (event: { fsPath: string }) => void;
    }).fireChange({ fsPath: '/ws/entities/Avatar.def' });
    clock.tick();
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(runCalls).toEqual([]);
    // 同一闸实例(同一基线册)给重试用:仍是同一次被拦的未知基线 → 重试同样拦下
    const { result } = await resend(store, sharedGate);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('无基线');
    // 明确重启确认后,同一闸实例的重试放行(基线已由确认通道建立)
    expect(await sharedGate.confirmLoaded!()).toBe(1);
    const { result: retryResult, runCalls: retryCalls } = await resend(store, sharedGate);
    expect(retryResult.ok).toBe(true);
    expect(retryCalls).toEqual(['热更']);
  });
});

// KR-AUD-40:失败目标重试的「部署通道分支」同样不得绕过 def 结构闸——
// 重试目标=当前部署通道目标(profile ID)时,resendHotReloadTarget 接回
// resolveChannelTransport 走通道发送;闸判定必须先于该分支(拦下时不发
// transport.send、不发动作、不落账),否则结构性 def 变更经「重试→部署
// 通道」仍会以普通 reload 下发。
describe('重试路径 def 结构闸 × 部署通道分支(KR-AUD-40)', () => {
  const CHANNEL_KEY = { rootId: '/ws', targetId: 'profile-9' };
  let baselines: Map<string, string>;
  let content: string | null;
  let restartNotices: Array<{ targetId: string; files: string[]; reasons: string[] }>;
  const makeGate = () => createDefStructuralGate(async () => content, baselines);

  beforeEach(() => {
    baselines = new Map();
    content = BASE_DEF;
    restartNotices = [];
    configurationOverrides.clear();
    lastFileSystemWatcher.current = null;
  });

  const makeChannelStore = (): HotReloadTargetStateStore => {
    const store = new HotReloadTargetStateStore({ now: () => 1 });
    store.record(CHANNEL_KEY, '/ws/entities/Avatar.def', 'failed', { detail: 'ECONNREFUSED' });
    store.record(CHANNEL_KEY, '/ws/scripts/cell/Avatar.py', 'failed', { detail: 'ECONNREFUSED' });
    return store;
  };

  const resendViaChannel = async (store: HotReloadTargetStateStore, gate = makeGate()) => {
    const runCalls: string[] = [];
    const sends: string[][] = [];
    const clock = makeTimers();
    const transport: ReloadTransport = {
      kind: 'http',
      probe: async () => ({ ok: true, detail: 'ok' }),
      send: async (_target, fileSet) => {
        sends.push([...fileSet]);
        return { kind: 'http', receipts: [] };
      }
    };
    const result = await resendHotReloadTarget(store, CHANNEL_KEY, {
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
      resolveChannelTransport: () => ({ transport, targetId: 'profile-9' }),
      onRestartRequired: (targetId, files, reasons) => {
        restartNotices.push({ targetId, files: [...files], reasons: [...reasons] });
      }
    });
    return { result, runCalls, sends };
  };

  it('结构性 def 变更:通道目标重试被闸拦下,不走 transport.send 不落账,发需重启通知', async () => {
    content = STRUCTURAL_DEF;
    baselines.set('/ws/entities/Avatar.def', BASE_DEF);
    const store = makeChannelStore();
    const { result, runCalls, sends } = await resendViaChannel(store);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('结构性 def 变更需要重启');
    expect(sends).toEqual([]);
    expect(runCalls).toEqual([]);
    expect(restartNotices).toHaveLength(1);
    expect(restartNotices[0].targetId).toBe('profile-9');
    // 拦下是保守拦截不是投递失败:台账保留 failed 旧账原样
    expect(store.get(CHANNEL_KEY, '/ws/entities/Avatar.def')?.outcome).toBe('failed');
  });

  it('非结构 def 变更:通道目标重试照常经部署通道重发(闸放行,不走动作反查)', async () => {
    content = NONSTRUCTURAL_DEF;
    baselines.set('/ws/entities/Avatar.def', BASE_DEF);
    const store = makeChannelStore();
    const { result, runCalls, sends } = await resendViaChannel(store);
    expect(result.ok).toBe(true);
    expect(sends).toHaveLength(1);
    expect(sends[0]).toContain('/ws/entities/Avatar.def');
    expect(sends[0]).toContain('/ws/scripts/cell/Avatar.py');
    expect(runCalls).toEqual([]);
    expect(restartNotices).toEqual([]);
  });
});
