import { beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';

import { setupHotReload, type HotReloadTimerDeps } from '../src/hotReload';
import { HotReloadTargetStateStore } from '../src/backend/hotReloadTargetState';
import { configurationOverrides, lastFileSystemWatcher } from './helpers/vscodeStub';

// RT-8(外部深审 2026-11-04):未确认记录的阻塞/超时注解拼接 detail 用
// `${current.detail} | ${reason}` 模板——detail 为空时会拼出字面
// "undefined | 原因"上屏。修后空段过滤([].filter(Boolean).join(' | ')),
// 只留真实段;两段都有时保持 "detail | reason" 既有格式不变。

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

describe('未确认注解 detail 拼接不产生字面 undefined(RT-8)', () => {
  beforeEach(() => {
    configurationOverrides.clear();
    lastFileSystemWatcher.current = null;
  });

  const makeContext = (): vscode.ExtensionContext =>
    ({ subscriptions: [] }) as unknown as vscode.ExtensionContext;

  it('注解拼接:两段都有时 detail | 原因,绝不出现字面 undefined', async () => {
    const clock = makeTimers();
    const store = new HotReloadTargetStateStore({ now: () => 7 });
    configurationOverrides.set('kbengine', {
      hotReload: { enabled: true, globs: ['**/*.py'], actionName: '热更', debounceMs: 100 }
    });
    setupHotReload(
      makeContext(),
      (_name, sendOptions) => {
        sendOptions?.onHttpResponse?.({ status: 200, body: 'ok(非 JSON 回包)' });
        return true;
      },
      {
        timers: clock.timers,
        // 无 readFileContent:applied 核验阻塞注解路径(注解只碰 sent-unverified)
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
    const record = store.get({ rootId: '/ws', targetId: 't1' }, '/ws/a.py');
    expect(record?.outcome).toBe('sent-unverified');
    expect(record?.detail).toBeDefined();
    expect(record?.detail).toContain('applied 核验阻塞');
    expect(record?.detail).not.toContain('undefined');
  });
});
