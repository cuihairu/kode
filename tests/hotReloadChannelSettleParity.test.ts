import { beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';

import {
  HOT_RELOAD_APPLIED_SETTLE_MS,
  setupHotReload,
  type HotReloadTimerDeps
} from '../src/hotReload';
import { HotReloadTargetStateStore } from '../src/backend/hotReloadTargetState';
import type { ReloadReceipt, ReloadTarget, ReloadTransport } from '../src/backend/hotReloadTransport';
import { channels, configurationOverrides, lastFileSystemWatcher } from './helpers/vscodeStub';

// KR-AUD-46/47(通道发送语义与 fire 回落路径对齐):
// - KR-AUD-46(取证结论):两条路径的 accepted 台账态本就一致——注解结算口
//   (noteStillUnverified)都只认 sent-unverified,accepted 到点不注解(派生
//   状态机按 recordedAt+窗口把过期 accepted 结算为 FAILED,两路径同语义)。
//   真正的不一致是台账内容:fire 回落路径的 accepted 记录带 HOT-003 注解
//   detail(「应用仍需核验,仍等 applied」),通道 accepted 记录此前无 detail
//   ——修后通道 accepted 同样带注解,两路径台账语义对齐(文案同义,非逐字相同)。
// - KR-AUD-47:通道核验窗口锚定 sentAt=sendFilesViaReloadChannel 入口(冻结
//   基准读取之前),而 fire 回落路径锚定 start()=动作发起时点(读取不占窗口)。
//   冻结读取慢时通道的有效核验窗口被读取耗时吃掉;修后通道窗口锚定「发送发起
//   时点」=各组 transport.send 即将发起之时(逐组紧贴 send 取锚,冻结完成后
//   的分组/落账耗时同样不占窗口),与回落路径同语义。

const makeTimers = (): { timers: HotReloadTimerDeps; tick: () => number } => {
  const handles = new Map<unknown, () => void>();
  let nextHandle = 0;
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
        const handle = nextHandle++;
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

const KEY = { rootId: '/ws', targetId: 'profile-1' };

describe('通道发送与 fire 回落路径的核验窗口语义对齐(KR-AUD-46/47)', () => {
  beforeEach(() => {
    configurationOverrides.clear();
    lastFileSystemWatcher.current = null;
    channels.length = 0;
  });

  const makeContext = (): vscode.ExtensionContext =>
    ({ subscriptions: [] }) as unknown as vscode.ExtensionContext;

  const makeTransport = (
    receipts: ReloadReceipt[],
    onSend?: () => void
  ): ReloadTransport => ({
    kind: 'http',
    probe: async () => ({ ok: true, detail: 'ok' }),
    send: async (_target: ReloadTarget, fileSet: readonly string[], onReceipt) => {
      onSend?.();
      for (const receipt of receipts) {
        onReceipt(receipt);
      }
      return { kind: 'http', receipts };
    }
  });

  const fire = async (options: {
    receipts: ReloadReceipt[];
    now: () => number;
    readFileContent?: (file: string) => Promise<string | null>;
  }): Promise<{ store: HotReloadTargetStateStore; clock: ReturnType<typeof makeTimers> }> => {
    const clock = makeTimers();
    const store = new HotReloadTargetStateStore({ now: () => 7 });
    configurationOverrides.set('kbengine', {
      hotReload: { enabled: true, globs: ['**/*.py'], actionName: '热更', debounceMs: 100 }
    });
    setupHotReload(makeContext(), () => undefined, {
      timers: clock.timers,
      now: options.now,
      resolveChannelTransport: () => ({
        transport: makeTransport(options.receipts),
        targetId: 'profile-1'
      }),
      targetState: {
        store,
        resolveTargetId: () => 't1',
        resolveRootId: () => '/ws',
        ...(options.readFileContent ? { readFileContent: options.readFileContent } : {})
      }
    });
    lastFileSystemWatcher.current!.fireChange({ fsPath: '/ws/a.py' } as never);
    clock.tick();
    await flush();
    return { store, clock };
  };

  it('KR-AUD-46:通道 accepted 记录带 HOT-003 注解 detail,与 fire 回落路径台账对齐', async () => {
    let now = 1000;
    const { store, clock } = await fire({
      receipts: [{ status: 'accepted', file: '/ws/a.py' }],
      now: () => now,
      readFileContent: async () => 'print("x")'
    });
    const record = store.get(KEY, '/ws/a.py');
    expect(record?.outcome).toBe('accepted');
    // 与 fire 回落路径(applyAcceptedReceipt)同款 HOT-003 注解,不冒充终局
    expect(record?.detail).toContain('应用仍需核验');
    expect(record?.detail).toContain('仍等 applied');
    // 注解结算口两路径一致只认 sent-unverified:窗口到点 accepted 不注解超时
    // (派生状态机按 recordedAt+窗口结算过期 accepted,台账保持 accepted 原样)
    now = 1000 + HOT_RELOAD_APPLIED_SETTLE_MS + 50;
    clock.tick();
    const settled = store.get(KEY, '/ws/a.py');
    expect(settled?.outcome).toBe('accepted');
    expect(settled?.detail ?? '').not.toContain('核验超时');
  });

  it('KR-AUD-46:fire 回落路径的 accepted 记录同样到点不注解超时(两路径注解口同语义)', async () => {
    const FALLBACK_KEY = { rootId: '/ws', targetId: 't1' };
    let now = 1000;
    const clock = makeTimers();
    const store = new HotReloadTargetStateStore({ now: () => 7 });
    configurationOverrides.set('kbengine', {
      hotReload: { enabled: true, globs: ['**/*.py'], actionName: '热更', debounceMs: 100 }
    });
    setupHotReload(
      makeContext(),
      (_name, sendOptions) => {
        sendOptions?.onHttpResponse?.({
          status: 200,
          body: JSON.stringify({ status: 'accepted', file: '/ws/a.py' })
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
    expect(store.get(FALLBACK_KEY, '/ws/a.py')?.outcome).toBe('accepted');
    now = 1000 + HOT_RELOAD_APPLIED_SETTLE_MS + 50;
    clock.tick();
    const settled = store.get(FALLBACK_KEY, '/ws/a.py');
    expect(settled?.outcome).toBe('accepted');
    expect(settled?.detail ?? '').not.toContain('核验超时');
  });

  it('KR-AUD-47:通道窗口锚定发送发起时点(冻结完成后)——冻结读取耗时不得吃掉窗口', async () => {
    let now = 1000;
    let releaseRead: (() => void) | undefined;
    const readGate = new Promise<void>(resolve => {
      releaseRead = resolve;
    });
    const sends: number[] = [];
    const clock = makeTimers();
    const store = new HotReloadTargetStateStore({ now: () => 7 });
    configurationOverrides.set('kbengine', {
      hotReload: { enabled: true, globs: ['**/*.py'], actionName: '热更', debounceMs: 100 }
    });
    setupHotReload(makeContext(), () => undefined, {
      timers: clock.timers,
      now: () => now,
      resolveChannelTransport: () => ({
        transport: makeTransport([{ status: 'sent', file: '/ws/a.py', detail: '已送达' }], () => sends.push(now)),
        targetId: 'profile-1'
      }),
      targetState: {
        store,
        resolveTargetId: () => 't1',
        resolveRootId: () => '/ws',
        readFileContent: async () => {
          await readGate;
          // 模拟冻结基准读取耗时 500ms(时钟 1000 → 1500)
          now = 1500;
          return 'print("frozen")';
        }
      }
    });
    lastFileSystemWatcher.current!.fireChange({ fsPath: '/ws/a.py' } as never);
    clock.tick();
    await flush();
    // 基准冻结完成前发送不得发起(F2 既有口径),此刻发送还未发生
    expect(sends).toEqual([]);
    releaseRead!();
    await flush();
    // 发送发起于冻结完成后:transport.send 时窗口锚=1500
    expect(sends).toEqual([1500]);
    expect(store.get(KEY, '/ws/a.py')?.sentDigest).toBeDefined();
    // 旧实现锚 sentAt=1000(冻结前):deadline=11000,now=11200 即注解超时;
    // 修后锚发送发起时点=1500:deadline=11500,now=11200 仍是 pending,不注解
    now = 11200;
    clock.tick();
    const record = store.get(KEY, '/ws/a.py');
    expect(record?.outcome).toBe('sent-unverified');
    expect(record?.detail ?? '').not.toContain('核验超时');
  });

  it('KR-AUD-47 二轮:锚点紧贴本组 send——冻结后的分组/落账耗时不得吃掉窗口', async () => {
    let now = 1000;
    const sendAt: number[] = [];
    const clock = makeTimers();
    // onRecorded 每次落账推进时钟 100ms:模拟冻结完成后逐文件分组、root 解析、
    // 冻结 digest 落账的真实耗时——旧锚(分组前取)会被这些耗时推离 send
    const store = new HotReloadTargetStateStore({
      now: () => 7,
      onRecorded: () => {
        now += 100;
      }
    });
    configurationOverrides.set('kbengine', {
      hotReload: { enabled: true, globs: ['**/*.py'], actionName: '热更', debounceMs: 100 }
    });
    const transport: ReloadTransport = {
      kind: 'http',
      probe: async () => ({ ok: true, detail: 'ok' }),
      send: async (_target, fileSet, onReceipt) => {
        sendAt.push(now);
        onReceipt({ status: 'sent', file: fileSet[0], detail: '已送达' });
        return { kind: 'http', receipts: [{ status: 'sent', file: fileSet[0], detail: '已送达' }] };
      }
    };
    setupHotReload(makeContext(), () => undefined, {
      timers: clock.timers,
      now: () => now,
      resolveChannelTransport: () => ({ transport, targetId: 'profile-1' }),
      targetState: {
        store,
        resolveTargetId: () => 't1',
        resolveRootId: () => '/ws',
        readFileContent: async () => 'print("x")'
      }
    });
    lastFileSystemWatcher.current!.fireChange({ fsPath: '/ws/a.py' } as never);
    clock.tick();
    await flush();
    // 发起记录(写1:1000→1100)、冻结即时、冻结 digest 落账(写2:1100→1200);
    // 锚点必须取在落账之后(=1200,紧贴 send),不得取在冻结完成时(=1100)
    expect(sendAt).toEqual([1200]);
    // 旧锚=1100:deadline=11100,now=11150 即注解超时;新锚=1200:deadline=11200,
    // now=11150 仍是 pending——落账耗时不得吃掉核验窗口
    now = 11150;
    clock.tick();
    const record = store.get(KEY, '/ws/a.py');
    expect(record?.outcome).toBe('sent-unverified');
    expect(record?.detail ?? '').not.toContain('核验超时');
  });
});
