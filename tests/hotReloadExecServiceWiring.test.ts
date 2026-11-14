import { ExtensionContext, Uri, WorkspaceFolder } from 'vscode';
import { afterAll, describe, expect, it } from 'vitest';

import { setupHotReload, type HotReloadTimerDeps } from '../src/hotReload';
import { allFileSystemWatchers, configurationOverrides } from './helpers/vscodeStub';

/**
 * RUST-002 判据③ 接线钉：热更语法闸走**常驻 Python 执行服务**。
 *
 * 此前热更测试都经 pipelineFaces.syntaxCheck 注入替身，真闸
 * buildRealSyntaxGate（唯一真起解释器进程的路径）从未被驱动。本钉不注入
 * 语法检查替身，逼出真闸。
 *
 * 双钉分工：本钉只钉**接线**（真闸确实接通、判定确实拦/放）；进程复用（同一
 * pid 承载多次编译）由 pythonExecService.test.ts 钉——两枚合起来才覆盖
 * 「常驻执行服务」的完整语义。
 *
 * 观测面=传输是否被调：blocked 只进流水线诊断、不上 status 日志，拿日志断言
 * 断不到；runAction 还受动作名/发送通道约束，不是闸的判据。
 */

const makeTimers = (): { timers: HotReloadTimerDeps; tick: () => number } => {
  const handles = new Map<unknown, () => void>();
  let next = 0;
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
        const handle = next += 1;
        handles.set(handle, callback);
        return handle;
      },
      clear: (handle): void => {
        handles.delete(handle);
      }
    }
  };
};

const makeContext = (): ExtensionContext => ({
  subscriptions: [],
  workspaceState: { get: () => undefined, update: async () => undefined, keys: () => [] },
  globalState: { get: () => undefined, update: async () => undefined, keys: () => [] },
  extensionUri: Uri.file('/ext'),
  extensionPath: '/ext',
  asAbsolutePath: (p: string) => `/ext/${p}`,
  environmentVariableCollection: { append: () => undefined, replace: () => undefined },
  workspaceFolders: [{ uri: Uri.file('/ws'), name: 'ws', index: 0 }] satisfies WorkspaceFolder[]
} as unknown as ExtensionContext);

const contexts: ExtensionContext[] = [];
afterAll(() => {
  for (const context of contexts.splice(0)) {
    for (const item of [...context.subscriptions]) {
      (item as { dispose?: () => void }).dispose?.();
    }
  }
});

describe('热更语法闸常驻执行服务接线(RUST-002)', () => {
  const boot = (content: string): {
    clock: ReturnType<typeof makeTimers>;
    fire: () => void;
    sent: () => number;
  } => {
    configurationOverrides.set('kbengine', {
      'python.interpreterPath': '/usr/bin/python3',
      hotReload: {
        enabled: true,
        globs: ['**/*.py'],
        actionName: '',
        debounceMs: 50,
        stabilityWindowMs: 0,
        syntaxGate: true
      }
    });
    allFileSystemWatchers.length = 0;
    const clock = makeTimers();
    const context = makeContext();
    contexts.push(context);
    let sends = 0;
    setupHotReload(context, () => undefined, {
      timers: clock.timers,
      status: {
        log: () => undefined,
        setWatchOff: () => undefined,
        setReady: () => undefined,
        setSending: () => undefined,
        setSentUnverified: () => undefined,
        setFailed: () => undefined,
        setSkippedNoAction: () => undefined,
        setRestartRequired: () => undefined,
        dispose: () => undefined
      } as never,
      // 只注入快照读面(流水线必需)与真传输,**不注入 syntaxCheck** —— 逼真闸跑
      defaultHotfix: {
        transport: async (_request: { url: string }) => {
          sends += 1;
          return {
            ok: true,
            status: 200,
            durationMs: 1,
            body: 'ok'
          };
        }
      },
      pipelineFaces: {
        readSnapshot: async () => ({ hash: `${content.length}`, content })
      }
    });
    const saveWatcher = allFileSystemWatchers[allFileSystemWatchers.length - 1];
    return {
      clock,
      fire: () => saveWatcher.fireChange({ fsPath: '/ws/scripts/A.py' } as never),
      sent: () => sends
    };
  };

  /**
   * 推进到条件成立或超时。真闸要真起解释器并等回包（首调数十毫秒），虚定时器
   * 拍数覆盖不到那段异步：每轮先等真时钟一小段，再 tick 掉虚窗，循环。
   */
  const advanceUntil = async (
    clock: ReturnType<typeof makeTimers>,
    predicate: () => boolean,
    limitMs = 5000
  ): Promise<void> => {
    const startedAt = Date.now();
    for (;;) {
      clock.tick();
      if (predicate()) {
        return;
      }
      if (Date.now() - startedAt >= limitMs) {
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };

  it('语法错文件被真闸拦下:不发送', async () => {
    const { clock, fire, sent } = boot('def broken(:\n    return 1\n');
    fire();
    await advanceUntil(clock, () => false);
    expect(sent()).toBe(0);
  }, 30000);

  it('合法文件放行:真闸判 ok 后照发', async () => {
    const { clock, fire, sent } = boot('value = 42\n');
    fire();
    await advanceUntil(clock, () => sent() === 1);
    expect(sent()).toBe(1);
  }, 30000);
});