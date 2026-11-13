import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { QuickActionManager } from '../src/quickActions';
import { setupHotReload, type HotReloadTimerDeps } from '../src/hotReload';
import { HotReloadTargetStateStore } from '../src/backend/hotReloadTargetState';
import { startReferenceReceiver } from './helpers/referenceReceiver';
import {
  configurationOverrides,
  lastFileSystemWatcher,
  memoryFileSystem,
  Uri,
  workspace as stubWorkspace
} from './helpers/vscodeStub';

// IDE-REV-022 accepted 回执接线:真实 HTTP 响应到达即按传输事实落账(2xx=
// 未确认送达/非 2xx=failed),2xx 且回包体逐字段符合已记录协议才升格 accepted
// (file 回显必须一致);未知响应(非 JSON/状态非 accepted/回显不一致)保持
// 未确认;脚本/命令动作无响应面,回落 REV-021 的 sent-unverified;targetId
// 解不到时不落台账。

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

describe('setupHotReload accepted 回执接线(IDE-REV-022)', () => {
  beforeEach(() => {
    configurationOverrides.clear();
    lastFileSystemWatcher.current = null;
  });

  afterEach(() => {
    stubWorkspace.workspaceFolders = [];
  });

  const makeContext = (): vscode.ExtensionContext =>
    ({ subscriptions: [] }) as unknown as vscode.ExtensionContext;

  const enableHotReload = (): void => {
    configurationOverrides.set('kbengine', {
      hotReload: { enabled: true, globs: ['**/*.py'], actionName: '热更', debounceMs: 100 }
    });
  };

  const fireFiles = (files: string[]): void => {
    for (const file of files) {
      lastFileSystemWatcher.current!.fireChange({ fsPath: file } as never);
    }
  };

  const KEY = { rootId: '/ws', targetId: 't1' };

  // 模拟真实 HTTP 动作:runHttpAction 收到响应后触发 onHttpResponse,再 resolve
  const httpRun = (
    response: { status: number; body: string },
    resolveValue: boolean = true
  ): ((name: string, sendOptions?: { onHttpResponse?: (r: { status: number; body?: string }) => void }) => boolean) =>
    (_name, sendOptions) => {
      sendOptions?.onHttpResponse?.(response);
      return resolveValue;
    };

  it('2xx + 协议逐字段符合的 accepted 回执:升格 accepted', async () => {
    const clock = makeTimers();
    const store = new HotReloadTargetStateStore({ now: () => 7 });
    enableHotReload();
    setupHotReload(
      makeContext(),
      httpRun({ status: 200, body: JSON.stringify({ status: 'accepted', file: '/ws/a.py' }) }),
      {
        timers: clock.timers,
        targetState: { store, resolveTargetId: () => 't1', resolveRootId: () => '/ws' }
      }
    );

    fireFiles(['/ws/a.py']);
    clock.tick();
    await flush();

    const record = store.get(KEY, '/ws/a.py');
    expect(record?.outcome).toBe('accepted');
  });

  it('2xx + 未知回包体(非 JSON):保持未确认', async () => {
    const clock = makeTimers();
    const store = new HotReloadTargetStateStore({ now: () => 7 });
    enableHotReload();
    setupHotReload(makeContext(), httpRun({ status: 200, body: 'not-json' }), {
      timers: clock.timers,
      targetState: { store, resolveTargetId: () => 't1', resolveRootId: () => '/ws' }
    });

    fireFiles(['/ws/a.py']);
    clock.tick();
    await flush();

    expect(store.get(KEY, '/ws/a.py')?.outcome).toBe('sent-unverified');
  });

  it('2xx + 协议 file 回显与所发文件不一致:不升格,保持未确认', async () => {
    const clock = makeTimers();
    const store = new HotReloadTargetStateStore({ now: () => 7 });
    enableHotReload();
    setupHotReload(
      makeContext(),
      httpRun({ status: 200, body: JSON.stringify({ status: 'accepted', file: '/other/x.py' }) }),
      {
        timers: clock.timers,
        targetState: { store, resolveTargetId: () => 't1', resolveRootId: () => '/ws' }
      }
    );

    fireFiles(['/ws/a.py']);
    clock.tick();
    await flush();

    expect(store.get(KEY, '/ws/a.py')?.outcome).toBe('sent-unverified');
  });

  it('非 2xx 响应:按传输事实落 failed(状态码入 detail)', async () => {
    const clock = makeTimers();
    const store = new HotReloadTargetStateStore({ now: () => 7 });
    enableHotReload();
    setupHotReload(makeContext(), httpRun({ status: 500, body: 'oops' }), {
      timers: clock.timers,
      targetState: { store, resolveTargetId: () => 't1', resolveRootId: () => '/ws' }
    });

    fireFiles(['/ws/a.py']);
    clock.tick();
    await flush();

    const record = store.get(KEY, '/ws/a.py');
    expect(record?.outcome).toBe('failed');
    expect(record?.detail).toContain('HTTP 状态 500');
  });

  it('脚本/命令动作无响应面:回落 REV-021 sent-unverified,不虚构 accepted', async () => {
    const clock = makeTimers();
    const store = new HotReloadTargetStateStore({ now: () => 7 });
    enableHotReload();
    // runAction 不触发 onHttpResponse(脚本动作),resolve true
    setupHotReload(makeContext(), () => Promise.resolve(true), {
      timers: clock.timers,
      targetState: { store, resolveTargetId: () => 't1', resolveRootId: () => '/ws' }
    });

    fireFiles(['/ws/a.py']);
    clock.tick();
    await flush();

    expect(store.get(KEY, '/ws/a.py')?.outcome).toBe('sent-unverified');
  });

  it('targetId 解不到:响应到达也不落台账(不虚构实例维度)', async () => {
    const clock = makeTimers();
    const store = new HotReloadTargetStateStore({ now: () => 7 });
    enableHotReload();
    setupHotReload(makeContext(), httpRun({ status: 200, body: JSON.stringify({ status: 'accepted', file: '/ws/a.py' }) }), {
      timers: clock.timers,
      targetState: { store, resolveTargetId: () => null, resolveRootId: () => '/ws' }
    });

    fireFiles(['/ws/a.py']);
    clock.tick();
    await flush();

    expect(store.targetsWithRecords()).toEqual([]);
  });

  it('真实管线:runByName → runHttpAction → 观察者把 accepted 回执落到台账', async () => {
    const clock = makeTimers();
    const store = new HotReloadTargetStateStore({ now: () => 7 });
    memoryFileSystem.set('/ws/.kbengine/debug.json', JSON.stringify({
      quickActions: [
        { name: '热更', type: 'http', method: 'POST', url: 'http://127.0.0.1:21345/reload', body: '', confirm: false }
      ]
    }));
    stubWorkspace.workspaceFolders = [{ uri: Uri.file('/ws'), name: 'ws', index: 0 }];
    const manager = new QuickActionManager(
      { subscriptions: [] } as unknown as vscode.ExtensionContext,
      {
        runHttp: async () => ({
          status: 200,
          body: JSON.stringify({ status: 'accepted', file: '/ws/scripts/a.py' })
        })
      }
    );
    enableHotReload();
    setupHotReload(
      makeContext(),
      (actionName, sendOptions) =>
        manager.runByName(actionName, {
          suppressConfirm: true,
          ...(sendOptions?.onHttpResponse
            ? { onHttpResponse: response => sendOptions.onHttpResponse!(response) }
            : {})
        }),
      {
        timers: clock.timers,
        targetState: { store, resolveTargetId: () => 't1', resolveRootId: () => '/ws' }
      }
    );

    fireFiles(['/ws/scripts/a.py']);
    clock.tick();
    await flush();

    expect(store.get({ rootId: '/ws', targetId: 't1' }, '/ws/scripts/a.py')?.outcome).toBe('accepted');
  });

  it('源锁:响应面经 quickActions 上报、extension.ts 透传、hotReload 接回执', () => {
    const read = (name: string): string => readFileSync(path.join(__dirname, '..', 'src', name), 'utf8');
    const quickActions = read('quickActions.ts');
    expect(quickActions).toContain('onHttpResponse?: (response: HttpActionResponse) => void');
    expect(quickActions).toContain('options.onHttpResponse?.({ status: result.status, body: result.body })');

    // SRC-001 L6:接线位自 extension.ts 迁 src/activate/hotReload.ts(纯移动),源锁跟随装配层。
    const assembly = read('extension.ts') + read('activate/hotReload.ts');
    expect(assembly).toContain('onHttpResponse: response => sendOptions.onHttpResponse!(response)');

    const hotReload = read('hotReload.ts');
    expect(hotReload).toContain('recordHttpDelivery');
    expect(hotReload).toContain('applyAcceptedReceipt');
  });

  // IDE-REV-022 重新核验(2026-11-05,AUD-007 证据落地后):回包体不再是
  // 模拟 JSON 字符串——参考接收端真实监听回环端口,runAction 发真实 HTTP
  // POST,响应按真实 wire 样本经既有响应面接线落台账。
  const realHttpPost = async (
    port: number,
    body: string
  ): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
      const request = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/reload',
          method: 'POST',
          headers: { 'content-type': 'application/json' }
        },
        response => {
          let raw = '';
          response.on('data', (chunk: Buffer) => {
            raw += chunk.toString('utf8');
          });
          response.on('end', () => resolve({ status: response.statusCode ?? 0, body: raw }));
        }
      );
      request.on('error', reject);
      request.write(body);
      request.end();
    });

  // 真实 wire 往返不受固定两拍 flush 约束:按终态有界轮询(5s 上限)
  const waitForOutcome = async (
    store: HotReloadTargetStateStore,
    file: string,
    expected: 'accepted' | 'sent-unverified'
  ): Promise<void> => {
    const key = { rootId: '/ws', targetId: 't1' };
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const outcome = store.get(key, file)?.outcome;
      if (outcome === expected) {
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(store.get(key, file)?.outcome).toBe(expected);
  };

  it('真实接收端 accepted 回包(真 wire):火线路径升格 accepted', async () => {
    const receiver = await startReferenceReceiver('stage', 'accepted');
    try {
      const clock = makeTimers();
      const store = new HotReloadTargetStateStore({ now: () => 7 });
      const realFile = path.join(receiver.root, 'Avatar.py');
      writeFileSync(realFile, 'class Avatar:\n    pass\n', 'utf8');
      enableHotReload();
      setupHotReload(
        makeContext(),
        async (_name, sendOptions) => {
          const response = await realHttpPost(receiver.port, JSON.stringify({ files: [realFile] }));
          sendOptions?.onHttpResponse?.(response);
          return true;
        },
        {
          timers: clock.timers,
          targetState: {
            store,
            resolveTargetId: () => 't1',
            resolveRootId: () => '/ws',
            readFileContent: async () => readFileSync(realFile, 'utf8')
          }
        }
      );

      fireFiles([realFile]);
      clock.tick();
      await flush();
      await waitForOutcome(store, realFile, 'accepted');
    } finally {
      receiver.dispose();
    }
  });

  it('真实接收端非 JSON 回包(真 wire):已送达但保持未确认', async () => {
    const receiver = await startReferenceReceiver('stage', 'echo');
    try {
      const clock = makeTimers();
      const store = new HotReloadTargetStateStore({ now: () => 7 });
      const realFile = path.join(receiver.root, 'Avatar.py');
      writeFileSync(realFile, 'class Avatar:\n    pass\n', 'utf8');
      enableHotReload();
      setupHotReload(
        makeContext(),
        async (_name, sendOptions) => {
          const response = await realHttpPost(receiver.port, JSON.stringify({ files: [realFile] }));
          sendOptions?.onHttpResponse?.(response);
          return true;
        },
        {
          timers: clock.timers,
          targetState: {
            store,
            resolveTargetId: () => 't1',
            resolveRootId: () => '/ws',
            readFileContent: async () => readFileSync(realFile, 'utf8')
          }
        }
      );

      fireFiles([realFile]);
      clock.tick();
      await flush();
      await waitForOutcome(store, realFile, 'sent-unverified');
    } finally {
      receiver.dispose();
    }
  });

  it('HR-WATCH-011 响应面:滞代响应在台账注解「响应过期」(绑定本代),新代响应不注', async () => {
    const clock = makeTimers();
    const store = new HotReloadTargetStateStore({ now: () => 7 });
    enableHotReload();
    // 响应挂起的动作替身:onHttpResponse 由测试在恰当时机显式触发
    const captured: Array<{ onHttpResponse?: (r: { status: number; body?: string }) => void }> = [];
    const resolvers: Array<(value: boolean) => void> = [];
    setupHotReload(
      makeContext(),
      (_name, sendOptions) => {
        captured.push(sendOptions);
        return new Promise<boolean>(resolve => resolvers.push(resolve));
      },
      {
        timers: clock.timers,
        targetState: { store, resolveTargetId: () => 't1', resolveRootId: () => '/ws' }
      }
    );

    fireFiles(['/ws/a.py']);
    clock.tick(); // 定稿 rev1 + 合并窗 → fire#1
    fireFiles(['/ws/a.py']);
    clock.tick(); // 再定稿 rev2 → fire#2;此刻 rev=2
    await flush(); // def 结构闸放行 → 两次动作发起(响应挂起,由测试显式投递)
    expect(captured).toHaveLength(2);
    expect(store.get(KEY, '/ws/a.py')).toBeUndefined(); // 响应未到,台账未落

    captured[0]?.onHttpResponse?.({ status: 200, body: 'not-json' }); // 滞代响应#1
    resolvers[0]?.(true);
    await flush();
    const staleRecord = store.get(KEY, '/ws/a.py');
    expect(staleRecord?.outcome).toBe('sent-unverified');
    expect(staleRecord?.detail ?? '').toContain('响应过期');

    captured[1]?.onHttpResponse?.({ status: 200, body: 'not-json' }); // 新代响应#2
    resolvers[1]?.(true);
    await flush();
    const fresh = store.get(KEY, '/ws/a.py');
    expect(fresh?.outcome).toBe('sent-unverified');
    expect(fresh?.detail ?? '').not.toContain('响应过期'); // 新代不背旧响应的注解
  });
});
