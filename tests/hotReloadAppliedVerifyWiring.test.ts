import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { setupHotReload, type HotReloadTimerDeps } from '../src/hotReload';
import { HotReloadTargetStateStore } from '../src/hotReloadTargetState';
import { configurationOverrides, lastFileSystemWatcher, workspace as stubWorkspace } from './helpers/vscodeStub';

// IDE-REV-023 applied 证据核验接线:真实 HTTP 响应的回包体经
// verifyAppliedReceipt 双证核验——回执逐字段符合协议且 digest 与所发内容
// sha256 一致才升格 applied;digest 缺失/不符、回执不合规(含运行时根本
// 没有 applied 协议)一律保持未确认并把阻塞原因注解进记录;核验窗口到点
// 仍未确认只注解超时,不冒充失败也不冒充 applied;无响应面(脚本动作)
// 不进核验流程。

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

const CONTENT = 'class Avatar:\n    def tick(self):\n        pass\n';
const FILE = '/ws/scripts/base/Avatar.py';
const KEY = { rootId: '/ws', targetId: 't1' };

describe('setupHotReload applied 核验接线(IDE-REV-023)', () => {
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
      hotReload: { enabled: true, actionName: '热更', debounceMs: 100 }
    });
  };

  const fireOne = (): void => {
    lastFileSystemWatcher.current!.fireChange({ fsPath: FILE } as never);
  };

  // 走完一次发送:fire → 去抖 tick → 微任务结算(响应+核验链),返回发送用时钟
  const sendOnce = (
    options: {
      body: string;
      content?: string | null;
      withReader?: boolean;
      status?: number;
    }
  ): { store: HotReloadTargetStateStore; clock: ReturnType<typeof makeTimers>; advanceSettle: () => void } => {
    const clock = makeTimers();
    const store = new HotReloadTargetStateStore({ now: () => 5 });
    let fakeNow = 1000;
    const withReader = options.withReader ?? true;
    enableHotReload();
    setupHotReload(
      makeContext(),
      (_name, sendOptions) => {
        sendOptions?.onHttpResponse?.({ status: options.status ?? 200, body: options.body });
        return true;
      },
      {
        timers: clock.timers,
        now: () => fakeNow,
        targetState: {
          store,
          resolveTargetId: () => 't1',
          resolveRootId: () => '/ws',
          ...(withReader
            ? {
                readFileContent: async () =>
                  options.content === undefined ? CONTENT : options.content
              }
            : {})
        }
      }
    );
    fireOne();
    clock.tick();
    return {
      store,
      clock,
      advanceSettle: () => {
        fakeNow = 1000 + 10_001;
      }
    };
  };

  const appliedBody = (digest: string): string =>
    JSON.stringify({ status: 'applied', file: FILE, digest });

  it('回执 applied 且 digest 与所发内容一致:双证齐 → 升格 applied', async () => {
    const digest = createHash('sha256').update(Buffer.from(CONTENT, 'utf8')).digest('hex');
    const run = sendOnce({ body: appliedBody(digest) });
    await flush();

    const record = run.store.get(KEY, FILE);
    expect(record?.outcome).toBe('applied');
    expect(record?.detail).toContain('digest 一致');
  });

  it('回执 digest 与所发内容不符:可疑回执不升格,注解阻塞原因', async () => {
    const otherDigest = createHash('sha256').update(Buffer.from('other', 'utf8')).digest('hex');
    const run = sendOnce({ body: appliedBody(otherDigest) });
    await flush();

    const record = run.store.get(KEY, FILE);
    expect(record?.outcome).toBe('sent-unverified');
    expect(record?.detail).toContain('digest 与所发内容不符');
  });

  it('运行时无 applied 协议(回执自称其他状态):保持未确认,注解缺协议阻塞条件', async () => {
    const run = sendOnce({ body: JSON.stringify({ status: 'ok' }) });
    await flush();

    const record = run.store.get(KEY, FILE);
    expect(record?.outcome).toBe('sent-unverified');
    expect(record?.detail).toContain('applied 核验阻塞');
    expect(record?.detail).toContain('非 applied');
  });

  it('无内容读取通道:digest 无基准,不核验只注解阻塞', async () => {
    const digest = createHash('sha256').update(Buffer.from(CONTENT, 'utf8')).digest('hex');
    const run = sendOnce({ body: appliedBody(digest), withReader: false });
    await flush();

    const record = run.store.get(KEY, FILE);
    expect(record?.outcome).toBe('sent-unverified');
    expect(record?.detail).toContain('无内容读取通道');
  });

  it('所发内容读不到:null 基准,不升格只注解阻塞', async () => {
    const digest = createHash('sha256').update(Buffer.from(CONTENT, 'utf8')).digest('hex');
    const run = sendOnce({ body: appliedBody(digest), content: null });
    await flush();

    const record = run.store.get(KEY, FILE);
    expect(record?.outcome).toBe('sent-unverified');
    expect(record?.detail).toContain('所发内容不可读');
  });

  it('核验窗口到点仍未确认:只注解超时,不冒充失败也不冒充 applied', async () => {
    const run = sendOnce({ body: 'ok' });
    await flush();
    run.advanceSettle();
    run.clock.tick();
    await flush();

    const record = run.store.get(KEY, FILE);
    expect(record?.outcome).toBe('sent-unverified');
    expect(record?.detail).toContain('applied 核验超时');
    expect(record?.outcome === 'applied' || record?.outcome === 'failed').toBe(false);
  });

  it('已升格 accepted 的记录:核验结算不碰(不追加超时,不改状态)', async () => {
    const run = sendOnce({ body: JSON.stringify({ status: 'accepted', file: FILE }) });
    await flush();
    expect(run.store.get(KEY, FILE)?.outcome).toBe('accepted');
    run.advanceSettle();
    run.clock.tick();
    await flush();

    const record = run.store.get(KEY, FILE);
    expect(record?.outcome).toBe('accepted');
    expect(record?.detail).not.toContain('核验超时');
    expect(record?.detail).not.toContain('核验阻塞');
  });

  it('无响应面(脚本动作):不进核验流程,无注解无结算', async () => {
    const clock = makeTimers();
    const store = new HotReloadTargetStateStore({ now: () => 5 });
    enableHotReload();
    setupHotReload(makeContext(), () => Promise.resolve(true), {
      timers: clock.timers,
      now: () => 999_999,
      targetState: {
        store,
        resolveTargetId: () => 't1',
        resolveRootId: () => '/ws',
        readFileContent: async () => CONTENT
      }
    });
    fireOne();
    clock.tick();
    await flush();
    clock.tick();
    await flush();

    const record = store.get(KEY, FILE);
    expect(record?.outcome).toBe('sent-unverified');
    expect(record?.detail ?? '').not.toContain('applied');
  });

  it('源锁:extension.ts 接内容读取口,hotReload 接双证核验与窗口结算', () => {
    const read = (name: string): string => readFileSync(path.join(__dirname, '..', 'src', name), 'utf8');
    const extension = read('extension.ts');
    expect(extension).toContain('readFileContent: async file =>');
    expect(extension).toContain('vscode.workspace.fs.readFile(vscode.Uri.file(file))');

    const hotReload = read('hotReload.ts');
    expect(hotReload).toContain('verifyAppliedReceipt(');
    expect(hotReload).toContain('settleAppliedStatus(');
    expect(hotReload).toContain('HOT_RELOAD_APPLIED_SETTLE_MS');
  });
});
