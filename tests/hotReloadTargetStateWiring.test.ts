import { readFileSync } from 'fs';
import * as path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { setupHotReload, type HotReloadTimerDeps } from '../src/hotReload';
import { HotReloadTargetStateStore } from '../src/hotReloadTargetState';
import { configurationOverrides, lastFileSystemWatcher } from './helpers/vscodeStub';

// IDE-REV-021 热更目标状态仓接线:注入 targetState 即逐发送按
// rootId × targetId 双维记账——同文件发不同实例各落各的,切目标不
// 复用上一目标成功态;动作完成无回执仍只记 sent-unverified(传输/
// 执行成功≠应用成功,绝不记成功态),失败带原因;targetId/rootId 解
// 不到的维度如实不落;不注入时行为与原装配一致。

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

describe('setupHotReload targetState 接线(IDE-REV-021)', () => {
  beforeEach(() => {
    configurationOverrides.clear();
    lastFileSystemWatcher.current = null;
  });

  const makeContext = (): vscode.ExtensionContext =>
    ({ subscriptions: [] }) as unknown as vscode.ExtensionContext;

  const enableHotReload = (): void => {
    configurationOverrides.set('kbengine', {
      hotReload: { enabled: true, actionName: '热更', debounceMs: 100 }
    });
  };

  const fireFiles = (files: string[]): void => {
    for (const file of files) {
      lastFileSystemWatcher.current!.fireChange({ fsPath: file } as never);
    }
  };

  it('逐发送记账:两个文件各落各自 rootId,targetId 为动作解析结果;无回执只记 sent-unverified', async () => {
    enableHotReload();
    const clock = makeTimers();
    const store = new HotReloadTargetStateStore({ now: () => 111 });
    setupHotReload(makeContext(), () => Promise.resolve(true), {
      timers: clock.timers,
      targetState: {
        store,
        resolveTargetId: () => 'http://127.0.0.1:21345/reload',
        resolveRootId: file => (file.startsWith('/wsA/') ? '/wsA' : file.startsWith('/wsB/') ? '/wsB' : null)
      }
    });

    fireFiles(['/wsA/scripts/base/Account.py', '/wsB/scripts/cell/Hero.py']);
    clock.tick();
    await flush();

    const a = store.get({ rootId: '/wsA', targetId: 'http://127.0.0.1:21345/reload' }, '/wsA/scripts/base/Account.py');
    const b = store.get({ rootId: '/wsB', targetId: 'http://127.0.0.1:21345/reload' }, '/wsB/scripts/cell/Hero.py');
    expect(a?.outcome).toBe('sent-unverified');
    expect(b?.outcome).toBe('sent-unverified');
    expect(a?.recordedAt).toBe(111);
    // 无回执语义保持:不是 accepted/applied/failed
    expect(a?.outcome === 'accepted' || a?.outcome === 'applied').toBe(false);
  });

  it('动作失败:同批文件落 failed 带原因', async () => {
    enableHotReload();
    const clock = makeTimers();
    const store = new HotReloadTargetStateStore({ now: () => 1 });
    setupHotReload(makeContext(), () => Promise.reject(new Error('ECONNREFUSED 21345')), {
      timers: clock.timers,
      targetState: {
        store,
        resolveTargetId: () => 't1',
        resolveRootId: () => '/ws'
      }
    });

    fireFiles(['/ws/a.py']);
    clock.tick();
    await flush();

    const record = store.get({ rootId: '/ws', targetId: 't1' }, '/ws/a.py');
    expect(record?.outcome).toBe('failed');
    expect(record?.detail).toContain('ECONNREFUSED');
  });

  it('同文件两个实例结果独立:切目标不复用上一目标成功态,b 失败不动 a 的 sent-unverified', async () => {
    enableHotReload();
    const clock = makeTimers();
    const store = new HotReloadTargetStateStore({ now: () => 1 });
    let target = 'inst-a';
    let shouldFail = false;
    setupHotReload(makeContext(), () => (shouldFail ? Promise.reject(new Error('boom')) : Promise.resolve(true)), {
      timers: clock.timers,
      targetState: {
        store,
        resolveTargetId: () => target,
        resolveRootId: () => '/ws'
      }
    });

    // 第一发:实例 a 成功(传输完成,无回执)→ sent-unverified
    fireFiles(['/ws/a.py']);
    clock.tick();
    await flush();
    // 切目标重发同一文件:实例 b 失败 → failed;a 的记录保持原样
    target = 'inst-b';
    shouldFail = true;
    fireFiles(['/ws/a.py']);
    clock.tick();
    await flush();

    const a = store.get({ rootId: '/ws', targetId: 'inst-a' }, '/ws/a.py');
    const b = store.get({ rootId: '/ws', targetId: 'inst-b' }, '/ws/a.py');
    expect(a?.outcome).toBe('sent-unverified');
    expect(b?.outcome).toBe('failed');
    expect(b?.detail).toContain('boom');
    // 查没发过的第三实例:拿不到邻居记录,不存在「复用成功态」
    expect(store.get({ rootId: '/ws', targetId: 'inst-c' }, '/ws/a.py')).toBeUndefined();
  });

  it('targetId 解不到:该次发送如实不落台账(不虚构实例);rootId 解不到的文件不落', async () => {
    enableHotReload();
    const clock = makeTimers();
    const store = new HotReloadTargetStateStore({ now: () => 1 });
    let targetId: string | null = 't1';
    setupHotReload(makeContext(), () => Promise.resolve(true), {
      timers: clock.timers,
      targetState: {
        store,
        resolveTargetId: () => targetId,
        resolveRootId: file => (file.startsWith('/ws/') ? '/ws' : null)
      }
    });

    // 一个可归根文件 + 一个归不到根的文件
    fireFiles(['/ws/a.py', '/outside/b.py']);
    clock.tick();
    await flush();
    expect(store.get({ rootId: '/ws', targetId: 't1' }, '/ws/a.py')?.outcome).toBe('sent-unverified');
    expect(store.files({ rootId: '/ws', targetId: 't1' })).toEqual(['/ws/a.py']);

    // 目标解析失败:同文件再发不落任何新记录(也不虚构 null 实例维度)
    targetId = null;
    fireFiles(['/ws/a.py']);
    clock.tick();
    await flush();
    const record = store.get({ rootId: '/ws', targetId: 't1' }, '/ws/a.py');
    expect(record?.outcome).toBe('sent-unverified'); // 仍是第一发的记录,未被第二发覆盖
    expect(store.files({ rootId: '/ws', targetId: 't1' })).toEqual(['/ws/a.py']);
    expect(store.targetsWithRecords()).toEqual([{ rootId: '/ws', targetId: 't1' }]);
  });

  it('不注入 targetState:原装配行为不变,动作照常执行', async () => {
    enableHotReload();
    const clock = makeTimers();
    const runCalls: string[] = [];
    setupHotReload(makeContext(), name => void runCalls.push(name), { timers: clock.timers });

    fireFiles(['/ws/a.py']);
    expect(clock.tick()).toBe(1);
    await flush();
    expect(runCalls).toEqual(['热更']);
  });

  it('源锁:extension.ts 真装配接了状态仓与双维解析器', () => {
    const source = readFileSync(path.join(__dirname, '..', 'src', 'extension.ts'), 'utf8');
    expect(source).toContain('new HotReloadTargetStateStore');
    expect(source).toContain('resolveTargetId: async actionName =>');
    expect(source).toContain('resolveRootId: file =>');
  });
});
