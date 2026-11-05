import { createHash } from 'crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';

import { setupHotReload, type HotReloadTimerDeps } from '../src/hotReload';
import { HotReloadTargetStateStore } from '../src/hotReloadTargetState';
import type { ReloadReceipt, ReloadTarget, ReloadTransport } from '../src/hotReloadTransport';
import { channels, configurationOverrides, lastFileSystemWatcher } from './helpers/vscodeStub';

// RT-9(外部深审 2026-11-04)/IDE-HOT-004:部署通道路径的 applied 回执必须过
// digest 双证核验——transport 回执自称 applied 但 digest 与发送时点冻结的所发
// 内容 sha256 不符(或缺 digest/无内容基准)时绝不升格 applied,保持未确认并
// 注解原因;核验窗口(HOT_RELOAD_APPLIED_SETTLE_MS)到点结算,与 fire 路径
// 同语义。此前通道回执 accepted/applied 直喂台账,applied 无核验即终态,两
// 路径状态语义不一致。
// RT-10:两条路径的 applied 核验窗口统一锚定「发送发起时点」——fire 路径
// 此前用响应到达时刻起算窗口,响应晚到会把窗口整体后移,重试路径一直是发送
// 时点;修后统一 sentAt=发送发起时点。

const makeTimers = (): { timers: HotReloadTimerDeps; tick: () => number } => {
  const handles = new Map<unknown, () => void>();
  return {
    tick: () => {
      const callbacks = [...handles.values()];
      handles.clear();
      for (const callback of callbacks) {
        callback();
      }
      return callbacks.length;
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

const flush = async (): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
};

const digestOf = (content: string): string =>
  createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');

const KEY = { rootId: '/ws', targetId: 'profile-1' };

describe('部署通道 applied digest 核验与结算(RT-9 / RT-10 / IDE-HOT-004)', () => {
  beforeEach(() => {
    configurationOverrides.clear();
    lastFileSystemWatcher.current = null;
    channels.length = 0;
  });

  const makeContext = (): vscode.ExtensionContext =>
    ({ subscriptions: [] }) as unknown as vscode.ExtensionContext;

  const fire = async (
    receipts: ReloadReceipt[],
    wiring: {
      content?: string | null;
      readFileContent?: (file: string) => Promise<string | null>;
    } = {},
    options: { now?: () => number } = {}
  ): Promise<{ store: HotReloadTargetStateStore; clock: ReturnType<typeof makeTimers>; runCalls: string[] }> => {
    const clock = makeTimers();
    const store = new HotReloadTargetStateStore({ now: () => 7 });
    const runCalls: string[] = [];
    const transport: ReloadTransport = {
      kind: 'http',
      probe: async () => ({ ok: true, detail: 'ok' }),
      send: async (_target: ReloadTarget, _fileSet: readonly string[], onReceipt) => {
        for (const receipt of receipts) {
          onReceipt(receipt);
        }
        return { kind: 'http', receipts };
      }
    };
    configurationOverrides.set('kbengine', {
      hotReload: { enabled: true, actionName: '热更', debounceMs: 100 }
    });
    setupHotReload(makeContext(), name => void runCalls.push(name), {
      timers: clock.timers,
      ...(options.now !== undefined ? { now: options.now } : {}),
      resolveChannelTransport: () => ({ transport, targetId: 'profile-1' }),
      targetState: {
        store,
        resolveTargetId: () => 't1',
        resolveRootId: () => '/ws',
        ...(wiring.readFileContent ? { readFileContent: wiring.readFileContent } : {})
      }
    });
    lastFileSystemWatcher.current!.fireChange({ fsPath: '/ws/a.py' } as never);
    clock.tick();
    await flush();
    return { store, clock, runCalls };
  };

  it('applied 回执 + digest 与发送时点冻结基准一致 → 升格 applied,detail 带指纹', async () => {
    const content = 'print("sent content")';
    const { store } = await fire([{ status: 'applied', file: '/ws/a.py', digest: digestOf(content) }], {
      readFileContent: async () => content
    });
    const record = store.get(KEY, '/ws/a.py');
    expect(record?.outcome).toBe('applied');
    expect(record?.detail).toContain(digestOf(content).slice(0, 12));
  });

  it('applied 回执缺 digest → 保持未确认并注解,绝不冒充 applied', async () => {
    const content = 'print("sent content")';
    const { store } = await fire([{ status: 'applied', file: '/ws/a.py' }], {
      readFileContent: async () => content
    });
    const record = store.get(KEY, '/ws/a.py');
    expect(record?.outcome).toBe('sent-unverified');
    expect(record?.detail).toContain('applied 回执不可信');
    expect(record?.detail).toContain('digest');
  });

  it('applied 回执 digest 不符(引擎报了别的版本)→ 保持未确认并注解', async () => {
    const content = 'print("sent content")';
    const { store } = await fire(
      [{ status: 'applied', file: '/ws/a.py', digest: digestOf('engine applied something else') }],
      { readFileContent: async () => content }
    );
    const record = store.get(KEY, '/ws/a.py');
    expect(record?.outcome).toBe('sent-unverified');
    expect(record?.detail).toContain('applied 回执不可信');
  });

  it('无内容读取通道(无冻结基准)→ applied 自称不可信,保持未确认', async () => {
    const { store } = await fire([{ status: 'applied', file: '/ws/a.py', digest: 'deadbeef' }], {});
    const record = store.get(KEY, '/ws/a.py');
    expect(record?.outcome).toBe('sent-unverified');
    expect(record?.detail).toContain('applied 回执不可信');
  });

  it('applied 回执 digest 与响应后已变的当前内容无关(只比发送时点冻结基准)', async () => {
    let content = 'print("sent content")';
    const { store } = await fire(
      [{ status: 'applied', file: '/ws/a.py', digest: digestOf('print("sent content")') }],
      { readFileContent: async () => content }
    );
    content = 'print("changed after response")';
    const record = store.get(KEY, '/ws/a.py');
    expect(record?.outcome).toBe('applied');
  });

  it('回执超时结算:窗口到点仍未确认 → 注解超时,保持未确认语义(通道与 fire 同窗口)', async () => {
    const content = 'print("x")';
    let now = 1000;
    const { store, clock } = await fire([{ status: 'sent', file: '/ws/a.py', detail: '已送达' }], {
      readFileContent: async () => content
    }, { now: () => now });
    // 时钟推进过核验窗口截止(sentAt=1000 + 10s 窗口),结算到点
    now = 20000;
    expect(clock.tick()).toBeGreaterThan(0);
    const record = store.get(KEY, '/ws/a.py');
    expect(record?.outcome).toBe('sent-unverified');
    expect(record?.detail).toContain('核验超时');
  });

  it('F4 回归:通道回执带不匹配 targetId → 不升格 applied,状态如实未确认;审计行带目标', async () => {
    const content = 'print("x")';
    const { store } = await fire(
      [
        {
          status: 'applied',
          file: '/ws/a.py',
          digest: digestOf(content),
          targetId: 'other-profile'
        } as ReloadReceipt
      ],
      {
        readFileContent: async () => content
      }
    );
    // F4:回执自称 applied 但 targetId 与通道目标不符 → 绝不升格,
    // 保持未确认(回执按目标核验,不落入当前目标了事)
    const record = store.get(KEY, '/ws/a.py');
    expect(record?.outcome).toBe('sent-unverified');
    expect(record?.detail).toContain('targetId');
    // 状态/审计面区分目标:通道审计行带 目标=profile-1
    const channel = channels.find(entry => entry.name === 'KBEngine 热更新');
    const audit = channel?.lines.find(line => line.includes('审计'));
    expect(audit).toContain('目标=profile-1');
  });

  it('F2 回归:通道发送在发送时点建立代际,冻结 digest 进台账', async () => {
    const content = 'print("sent content")';
    const { store } = await fire([{ status: 'applied', file: '/ws/a.py', digest: digestOf(content) }], {
      readFileContent: async () => content
    });
    const record = store.get(KEY, '/ws/a.py');
    expect(record?.outcome).toBe('applied');
    // 代际在发送时点建立(不是回执到达时另起新发送):整批一次发送一代
    expect(record?.attempt).toBe(1);
    // 发送时点冻结的所发内容 sha256 带进台账(可审计),不是回执后才补
    expect(record?.sentDigest).toBe(digestOf(content));
  });

  it('F2 回归:旧发送的晚到 digest 核验不翻新发送的失败(回执绑定代际)', async () => {
    const clock = makeTimers();
    const store = new HotReloadTargetStateStore({ now: () => 7 });
    const content = 'print("v1")';
    const digest = digestOf(content);
    // 发送1的冻结基准读取挂起:applied 回执已到,核验迟迟不能结算
    let gatedRead: ((value: string | null) => void) | undefined;
    let sendIndex = 0;
    const transport: ReloadTransport = {
      kind: 'http',
      probe: async () => ({ ok: true, detail: 'ok' }),
      send: async (_target, files, onReceipt) => {
        const index = sendIndex++;
        if (index === 0) {
          onReceipt({ status: 'applied', file: files[0], digest });
          await new Promise<void>(() => undefined); // 发送1悬挂(响应未收口)
        }
        throw new Error('send 2 failed');
      }
    };
    configurationOverrides.set('kbengine', {
      hotReload: { enabled: true, actionName: '热更', debounceMs: 100 }
    });
    setupHotReload(makeContext(), () => undefined, {
      timers: clock.timers,
      resolveChannelTransport: () => ({ transport, targetId: 'profile-1' }),
      targetState: {
        store,
        resolveTargetId: () => 't1',
        resolveRootId: () => '/ws',
        readFileContent: async () =>
          gatedRead === undefined
            ? new Promise<string | null>(resolve => {
                gatedRead = resolve;
              })
            : content
      }
    });
    // 发送1:applied 回执到达但 digest 核验挂起(冻结基准未决)
    lastFileSystemWatcher.current!.fireChange({ fsPath: '/ws/a.py' } as never);
    clock.tick();
    await flush();
    // 发送2:通道抛错整组 failed(新代际接管记录)
    lastFileSystemWatcher.current!.fireChange({ fsPath: '/ws/a.py' } as never);
    clock.tick();
    await flush();
    const afterSend2 = store.get(KEY, '/ws/a.py');
    expect(afterSend2?.outcome).toBe('failed');
    // 旧发送的 digest 基准晚到:其核验写回必须被代际守卫拒绝,绝不把
    // 新发送的失败翻成 applied(旧实现无代际绑定,此处被翻案)
    gatedRead!(content);
    await flush();
    const finalRecord = store.get(KEY, '/ws/a.py');
    expect(finalRecord?.outcome).toBe('failed');
    expect(finalRecord?.attempt).toBe(2);
    expect(finalRecord?.detail).toContain('send 2 failed');
  });

  it('RT-10:fire 路径核验窗口锚定发送发起时点——响应晚到不后移窗口', async () => {
    // 发送发起时 now=1000;响应在 now=20000 才到达(晚到)。旧实现窗口从响应
    // 时刻起算(deadline=30000),窗口到点结算时(now=20000)仍是 pending 不
    // 注解;修后统一 sentAt=发送发起时点(deadline=11000),结算即注解超时。
    let now = 1000;
    let releaseResponse: (() => void) | undefined;
    const responseGate = new Promise<void>(resolve => {
      releaseResponse = resolve;
    });
    const clock = makeTimers();
    const store = new HotReloadTargetStateStore({ now: () => 7 });
    configurationOverrides.set('kbengine', {
      hotReload: { enabled: true, actionName: '热更', debounceMs: 100 }
    });
    setupHotReload(
      makeContext(),
      (_name, sendOptions) => {
        void responseGate.then(() => {
          sendOptions?.onHttpResponse?.({ status: 200, body: 'ok' });
        });
        return true;
      },
      {
        timers: clock.timers,
        now: () => now,
        targetState: {
          store,
          resolveTargetId: () => 't1',
          resolveRootId: () => '/ws'
        }
      }
    );
    lastFileSystemWatcher.current!.fireChange({ fsPath: '/ws/a.py' } as never);
    clock.tick();
    await flush();
    const before = store.get({ rootId: '/ws', targetId: 't1' }, '/ws/a.py');
    expect(before?.outcome).toBe('sent-unverified');
    // 响应晚到:时钟已走到 20000 才放行响应
    now = 20000;
    releaseResponse!();
    await flush();
    // 核验窗口到点结算:锚定发送时点 1000,deadline=11000 < now=20000 → 注解超时
    expect(clock.tick()).toBeGreaterThan(0);
    const record = store.get({ rootId: '/ws', targetId: 't1' }, '/ws/a.py');
    expect(record?.outcome).toBe('sent-unverified');
    expect(record?.detail).toContain('核验超时');
  });
});
