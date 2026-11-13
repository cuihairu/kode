import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import {
  renderHotReloadRetryReport,
  resendHotReloadTarget,
  runHotReloadRetryCommand
} from '../src/backend/hotReloadRetryCommand';
import type { HotReloadHttpResponse, HotReloadTimerDeps } from '../src/hotReload';
import { HotReloadTargetStateStore, type HotReloadTargetKey } from '../src/backend/hotReloadTargetState';

// IDE-REV-026 失败目标重试接线(原 IDE-HOT-007):台账里只挑 outcome=failed
// 的目标经真实动作入口重发——已确认成功侧(applied/accepted/sent-unverified,
// 均已发出)零发送,发送次数不增加;每跳发起前探取消令牌,取消后未发起
// 目标不再发送;重发落账与 fire 路径同走 HOT-002..004 既有面(无响应面记
// sent-unverified/failed,HTTP 按传输事实分类,2xx 回包尝试 accepted/applied
// 升格,核验窗口结算),重发成功后台账如实翻面不留 failed 旧账。

const FILE_A = '/ws/scripts/base/Avatar.py';
const FILE_B = '/ws/scripts/base/Account.py';
const KEY_OK: HotReloadTargetKey = { rootId: '/ws', targetId: 'cellapp#a' };
const KEY_BAD: HotReloadTargetKey = { rootId: '/ws', targetId: 'cellapp#b' };
const KEY_UGLY: HotReloadTargetKey = { rootId: '/ws', targetId: 'cellapp#c' };

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

interface Harness {
  store: HotReloadTargetStateStore;
  clock: ReturnType<typeof makeTimers>;
  runAction: ReturnType<typeof vi.fn>;
  blocks: string[];
  shownCount: () => number;
  advance: (ms: number) => void;
  command: (isCancelled?: () => boolean) => Promise<void>;
}

const seedCommandHarness = (seed: (store: HotReloadTargetStateStore) => void): Harness => {
  const store = new HotReloadTargetStateStore({ now: () => 1000 });
  seed(store);
  const clock = makeTimers();
  const runAction = vi.fn(
    async (_actionName: string, _sendOptions?: { onHttpResponse?: (r: HotReloadHttpResponse) => void }) => true
  );
  const blocks: string[] = [];
  let shown = 0;
  let clockNow = 1000;
  const deps = {
    runAction,
    resolveActionNameForTarget: (targetId: string): string => `@http:debug:${targetId.length}`,
    targetState: {
      store,
      resolveTargetId: () => null,
      resolveRootId: () => '/ws',
      readFileContent: async () => 'print(1)'
    },
    timers: clock.timers,
    settleHandles: new Set<unknown>(),
    now: (): number => clockNow,
    isCancelled: (): boolean => false
  };
  return {
    store,
    clock,
    runAction,
    blocks,
    shownCount: (): number => shown,
    advance: (ms: number): void => {
      clockNow += ms;
    },
    command: (isCancelled?: () => boolean): Promise<void> =>
      runHotReloadRetryCommand(
        store,
        { ...deps, ...(isCancelled ? { isCancelled } : {}) },
        {
          logBlock: (text: string): void => {
            blocks.push(text);
          },
          show: (): void => {
            shown += 1;
          }
        }
      )
  };
};

describe('runHotReloadRetryCommand(IDE-REV-026)', () => {
  it('一成一败:只重发失败目标,已确认成功目标零发送且台账不动', async () => {
    const h = seedCommandHarness(store => {
      store.record(KEY_OK, FILE_A, 'applied', { detail: 'digest 一致' });
      store.record(KEY_BAD, FILE_A, 'failed', { detail: 'HTTP 500' });
    });

    await h.command();

    // 只对失败目标发起一次真实动作
    expect(h.runAction).toHaveBeenCalledTimes(1);
    // 成功目标台账不动(applied 不被翻面)
    expect(h.store.get(KEY_OK, FILE_A)?.outcome).toBe('applied');
    // 失败目标重发后如实翻面 sent-unverified(无响应面,不冒充 accepted)
    expect(h.store.get(KEY_BAD, FILE_A)?.outcome).toBe('sent-unverified');
    expect(h.blocks[0]).toContain('重发 1 个');
    expect(h.blocks[0]).toContain('不重发(已确认侧) 1 个');
    expect(h.blocks[0]).toContain('/ws::cellapp#a');
    expect(h.blocks[0]).toContain('/ws::cellapp#b');
    expect(h.shownCount()).toBe(1);
  });

  it('取消后不发送后续目标:首跳重发保留,次跳起零发起', async () => {
    const h = seedCommandHarness(store => {
      store.record(KEY_BAD, FILE_A, 'failed', { detail: 'boom' });
      store.record(KEY_UGLY, FILE_A, 'failed', { detail: 'boom' });
    });
    let probes = 0;
    const isCancelled = (): boolean => probes++ >= 1;

    await h.command(isCancelled);

    expect(h.runAction).toHaveBeenCalledTimes(1);
    // 已发起的重发如实落账,未发起的目标保持 failed 旧账(不冒充已发)
    expect(h.store.get(KEY_BAD, FILE_A)?.outcome).toBe('sent-unverified');
    expect(h.store.get(KEY_UGLY, FILE_A)?.outcome).toBe('failed');
    expect(h.blocks[0]).toContain('取消跳过 1 个');
    expect(h.blocks[0]).toContain('/ws::cellapp#c → 跳过(已取消');
  });

  it('开跑前已取消:零发起,失败台账原样保留', async () => {
    const h = seedCommandHarness(store => {
      store.record(KEY_BAD, FILE_A, 'failed', { detail: 'boom' });
    });

    await h.command(() => true);

    expect(h.runAction).not.toHaveBeenCalled();
    expect(h.store.get(KEY_BAD, FILE_A)?.outcome).toBe('failed');
    expect(h.blocks[0]).toContain('重发 0 个');
    expect(h.blocks[0]).toContain('取消跳过 1 个');
  });

  it('重发动作抛错:落 failed 带 message,结果 ok=false 如实透传', async () => {
    const h = seedCommandHarness(store => {
      store.record(KEY_BAD, FILE_A, 'failed', { detail: '旧错' });
    });
    h.runAction.mockRejectedValue(new Error('ECONNREFUSED 21345'));

    await h.command();

    expect(h.store.get(KEY_BAD, FILE_A)?.outcome).toBe('failed');
    expect(h.store.get(KEY_BAD, FILE_A)?.detail).toContain('ECONNREFUSED 21345');
    expect(h.blocks[0]).toContain('重发结果: 失败:ECONNREFUSED 21345');
  });

  it('IDE-AUD-053 重发回执 false(resolve 不 reject):落 failed 不冒充已重发', async () => {
    const h = seedCommandHarness(store => {
      store.record(KEY_BAD, FILE_A, 'failed', { detail: '旧错' });
    });
    // quick action 通道 false=未执行/失败(runByName 找不到动作/根目录缺失)
    h.runAction.mockImplementation(async () => false);

    await h.command();
    await flush();

    expect(h.store.get(KEY_BAD, FILE_A)?.outcome).toBe('failed');
    expect(h.store.get(KEY_BAD, FILE_A)?.detail).toContain('false');
    expect(h.blocks[0]).toContain('重发结果: 失败');
  });

  it('HTTP 500:按传输事实落 failed(不冒充未确认送达)', async () => {
    const h = seedCommandHarness(store => {
      store.record(KEY_BAD, FILE_A, 'failed', { detail: '旧错' });
    });
    h.runAction.mockImplementation(
      async (_name: string, sendOptions?: { onHttpResponse?: (r: HotReloadHttpResponse) => void }) => {
        sendOptions?.onHttpResponse?.({ status: 500, body: '' });
        return true;
      }
    );

    await h.command();
    await flush();

    expect(h.store.get(KEY_BAD, FILE_A)?.outcome).toBe('failed');
    expect(h.store.get(KEY_BAD, FILE_A)?.detail).toContain('500');
  });

  it('2xx+accepted 回执:经既有面升格 accepted(重发成功不只停在未确认)', async () => {
    const h = seedCommandHarness(store => {
      store.record(KEY_BAD, FILE_A, 'failed', { detail: '旧错' });
      store.record(KEY_BAD, FILE_B, 'failed', { detail: '旧错' });
    });
    h.runAction.mockImplementation(
      async (_name: string, sendOptions?: { onHttpResponse?: (r: HotReloadHttpResponse) => void }) => {
        sendOptions?.onHttpResponse?.({
          status: 200,
          body: JSON.stringify({ status: 'accepted', file: FILE_A })
        });
        return true;
      }
    );

    await h.command();
    await flush();

    // 回执只逐字回显 FILE_A:该文件升格 accepted,同目标 FILE_B 保持未确认送达
    expect(h.store.get(KEY_BAD, FILE_A)?.outcome).toBe('accepted');
    expect(h.store.get(KEY_BAD, FILE_B)?.outcome).toBe('sent-unverified');
  });

  it('核验窗口到点仍未确认:只注解超时不翻失败(与 fire 路径同口径)', async () => {
    const h = seedCommandHarness(store => {
      store.record(KEY_BAD, FILE_A, 'failed', { detail: '旧错' });
    });
    h.runAction.mockImplementation(
      async (_name: string, sendOptions?: { onHttpResponse?: (r: HotReloadHttpResponse) => void }) => {
        // 非 JSON body:送到了但协议不认,保持未确认
        sendOptions?.onHttpResponse?.({ status: 200, body: 'ok' });
        return true;
      }
    );

    await h.command();
    await flush();
    expect(h.store.get(KEY_BAD, FILE_A)?.outcome).toBe('sent-unverified');

    h.advance(20000);
    const fired = h.clock.tick();
    expect(fired).toBe(1);
    expect(h.store.get(KEY_BAD, FILE_A)?.outcome).toBe('sent-unverified');
    expect(h.store.get(KEY_BAD, FILE_A)?.detail).toContain('核验超时');
    expect(h.store.get(KEY_BAD, FILE_A)?.detail).toContain('保持未确认');
  });

  it('动作反查 miss:该目标不执行动作,如实 ok=false 找不到', async () => {
    const store = new HotReloadTargetStateStore({ now: () => 1000 });
    store.record(KEY_BAD, FILE_A, 'failed', { detail: 'boom' });
    const runAction = vi.fn(async () => true);
    const blocks: string[] = [];
    let shown = 0;

    await runHotReloadRetryCommand(
      store,
      {
        runAction,
        resolveActionNameForTarget: () => null,
        targetState: {
          store,
          resolveTargetId: () => null,
          resolveRootId: () => '/ws'
        },
        timers: makeTimers().timers,
        settleHandles: new Set<unknown>(),
        isCancelled: () => false
      },
      {
        logBlock: text => {
          blocks.push(text);
        },
        show: () => {
          shown += 1;
        }
      }
    );

    expect(runAction).not.toHaveBeenCalled();
    expect(store.get(KEY_BAD, FILE_A)?.outcome).toBe('failed');
    expect(blocks[0]).toContain('找不到');
    expect(blocks[0]).toContain('cellapp#b');
    expect(shown).toBe(1);
  });

  it('空台账:如实无投递记录,零发送零报错', async () => {
    const h = seedCommandHarness(() => undefined);

    await h.command();

    expect(h.runAction).not.toHaveBeenCalled();
    expect(h.blocks[0]).toContain('无投递记录');
    expect(h.blocks[0]).toContain('没有可重试的目标');
    expect(h.shownCount()).toBe(1);
  });

  it('响应批含发送基准冻结后追加的文件(异常回包):不崩溃,回落保持未确认且不中断批内后续核验', async () => {
    const h = seedCommandHarness(store => {
      store.record(KEY_BAD, FILE_A, 'failed', { detail: 'HTTP 500' });
    });
    // 制造「响应时批内多出发送基准冻结后追加的文件」:files() 返回活数组,
    // 基准冻结后把 FILE_B 插入批首,响应迭代先遇它而 baselineReads 无该键
    // ——旧实现对 undefined 取 .then 抛 TypeError 中断整批复核,修复后回落注解。
    const live: string[] = [FILE_A];
    (h.store as unknown as { files: (k: HotReloadTargetKey) => string[] }).files = () => live;

    let captured: ((r: HotReloadHttpResponse) => void) | undefined;
    h.runAction.mockImplementation(
      async (_a: string, sendOptions?: { onHttpResponse?: (r: HotReloadHttpResponse) => void }) => {
        captured = sendOptions?.onHttpResponse;
        return true;
      }
    );

    await h.command();
    expect(captured).toBeDefined();

    live.unshift(FILE_B);
    captured!({ status: 200, body: 'applied-receipt' });

    // 缺基准文件回落「保持未确认」而非崩溃,注解如实
    expect(h.store.get(KEY_BAD, FILE_B)?.outcome).toBe('sent-unverified');
    expect(h.store.get(KEY_BAD, FILE_B)?.detail).toContain('发送批无该文件基准');
    // 批处理未中断:批内既有基准文件仍完成核验(不因缺基准文件抛错跳过)
    expect(h.store.get(KEY_BAD, FILE_A)?.outcome).not.toBe('failed');
  });
});

describe('resendHotReloadTarget(单目标重发器)', () => {
  it('目标名下多文件一并重发落账(动作以实例为接收方,整单元投递)', async () => {
    const store = new HotReloadTargetStateStore({ now: () => 1000 });
    store.record(KEY_BAD, FILE_A, 'failed', { detail: 'boom' });
    store.record(KEY_BAD, FILE_B, 'failed', { detail: 'boom' });
    const runAction = vi.fn(async () => true);
    const wiring = {
      store,
      resolveTargetId: () => null,
      resolveRootId: () => '/ws'
    };

    const result = await resendHotReloadTarget(store, KEY_BAD, {
      runAction,
      resolveActionNameForTarget: () => '热更',
      targetState: wiring,
      timers: makeTimers().timers,
      settleHandles: new Set<unknown>()
    });

    expect(result.ok).toBe(true);
    expect(runAction).toHaveBeenCalledWith('热更', expect.objectContaining({ onHttpResponse: expect.any(Function) }));
    expect(store.get(KEY_BAD, FILE_A)?.outcome).toBe('sent-unverified');
    expect(store.get(KEY_BAD, FILE_B)?.outcome).toBe('sent-unverified');
  });

  it('不注入台账接线:重发执行但不落账(纯执行面)', async () => {
    const store = new HotReloadTargetStateStore({ now: () => 1000 });
    store.record(KEY_BAD, FILE_A, 'failed', { detail: 'boom' });
    const runAction = vi.fn(async () => true);

    const result = await resendHotReloadTarget(store, KEY_BAD, {
      runAction,
      resolveActionNameForTarget: () => '热更',
      timers: makeTimers().timers,
      settleHandles: new Set<unknown>()
    });

    expect(result.ok).toBe(true);
    expect(runAction).toHaveBeenCalledWith('热更', undefined);
    expect(store.get(KEY_BAD, FILE_A)?.outcome).toBe('failed');
  });

  it('IDE-AUD-005:第一次重发的核验晚到,不翻第二次重发的失败(旧代回执作废)', async () => {
    const store = new HotReloadTargetStateStore({ now: () => 1000 });
    store.record(KEY_BAD, FILE_A, 'failed', { detail: '原失败' });
    const pendingReads: Array<(value: string | null) => void> = [];
    const content = 'print(1)';
    const digest = createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');
    let sendCount = 0;
    const runAction = vi.fn(
      async (_name: string, sendOptions?: { onHttpResponse?: (r: HotReloadHttpResponse) => void }) => {
        sendCount += 1;
        // 第一次重发:200 + 有效 applied 回执——核验挂起;第二次重发:500 失败
        if (sendCount === 1) {
          sendOptions?.onHttpResponse?.({
            status: 200,
            body: JSON.stringify({ status: 'applied', file: FILE_A, digest })
          });
        } else {
          sendOptions?.onHttpResponse?.({ status: 500, body: '' });
        }
        return true;
      }
    );
    const wiring = {
      store,
      resolveTargetId: () => null,
      resolveRootId: () => '/ws',
      readFileContent: (): Promise<string | null> =>
        new Promise(resolve => {
          pendingReads.push(resolve);
        })
    };

    const first = await resendHotReloadTarget(store, KEY_BAD, {
      runAction,
      resolveActionNameForTarget: () => '热更',
      targetState: wiring,
      timers: makeTimers().timers,
      settleHandles: new Set<unknown>()
    });
    expect(first.ok).toBe(true);
    expect(store.get(KEY_BAD, FILE_A)?.outcome).toBe('sent-unverified');
    expect(pendingReads).toHaveLength(1);

    const second = await resendHotReloadTarget(store, KEY_BAD, {
      runAction,
      resolveActionNameForTarget: () => '热更',
      targetState: wiring,
      timers: makeTimers().timers,
      settleHandles: new Set<unknown>()
    });
    expect(second.ok).toBe(true);
    expect(store.get(KEY_BAD, FILE_A)?.outcome).toBe('failed');

    // 释放第一次的核验(内容可读):旧代回执不得翻新代的失败
    pendingReads[0]?.(content);
    await flush();
    const record = store.get(KEY_BAD, FILE_A);
    expect(record?.outcome).toBe('failed');
    expect(record?.detail ?? '').not.toContain('digest 一致');
  });

  it('IDE-AUD-006:重发核验基准在发送时点冻结——响应后文件已变也不拿新版本冒充所发', async () => {
    const store = new HotReloadTargetStateStore({ now: () => 1000 });
    store.record(KEY_BAD, FILE_A, 'failed', { detail: '原失败' });
    const content = 'print(1)';
    const changed = `${content}\n# 发送后被编辑\n`;
    const digest = createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');
    let responseSent = false;
    const runAction = vi.fn(
      async (_name: string, sendOptions?: { onHttpResponse?: (r: HotReloadHttpResponse) => void }) => {
        responseSent = true;
        sendOptions?.onHttpResponse?.({
          status: 200,
          body: JSON.stringify({ status: 'applied', file: FILE_A, digest })
        });
        return true;
      }
    );

    const result = await resendHotReloadTarget(store, KEY_BAD, {
      runAction,
      resolveActionNameForTarget: () => '热更',
      targetState: {
        store,
        resolveTargetId: () => null,
        resolveRootId: () => '/ws',
        // 发送时点读到所发内容;响应后文件已变(读到新版本)
        readFileContent: async () => (responseSent ? changed : content)
      },
      timers: makeTimers().timers,
      settleHandles: new Set<unknown>()
    });

    expect(result.ok).toBe(true);
    await flush(); // applied 升格在基准微任务链,结算后断言
    const record = store.get(KEY_BAD, FILE_A);
    expect(record?.outcome).toBe('applied');
    expect(record?.detail).toContain('digest 一致');
  });

  it('IDE-AUD-005:第一次重发的旧核验窗口结算,不追注新一次重发的记录(旧超时不改新记录)', async () => {
    const store = new HotReloadTargetStateStore({ now: () => 1000 });
    store.record(KEY_BAD, FILE_A, 'failed', { detail: '原失败' });
    // 两次重发各持自己的时钟——第一次的结算定时器可以在第二次记录之后才到点
    const clockOne = makeTimers();
    const clockTwo = makeTimers();
    let clockOneNow = 2000;
    let clockTwoNow = 3000;
    let sendCount = 0;
    const runAction = vi.fn(
      async (_name: string, sendOptions?: { onHttpResponse?: (r: HotReloadHttpResponse) => void }) => {
        sendCount += 1;
        // 两次都 200 + 非 applied 回执:保持未确认,各自进核验窗口
        sendOptions?.onHttpResponse?.({ status: 200, body: 'ok' });
        return true;
      }
    );
    const wiring = {
      store,
      resolveTargetId: () => null,
      resolveRootId: () => '/ws',
      readFileContent: async (): Promise<string | null> => 'print(1)'
    };

    const first = await resendHotReloadTarget(store, KEY_BAD, {
      runAction,
      resolveActionNameForTarget: () => '热更',
      targetState: wiring,
      timers: clockOne.timers,
      settleHandles: new Set<unknown>(),
      now: () => clockOneNow
    });
    expect(first.ok).toBe(true);
    await flush();
    expect(store.get(KEY_BAD, FILE_A)?.outcome).toBe('sent-unverified');

    const second = await resendHotReloadTarget(store, KEY_BAD, {
      runAction,
      resolveActionNameForTarget: () => '热更',
      targetState: wiring,
      timers: clockTwo.timers,
      settleHandles: new Set<unknown>(),
      now: () => clockTwoNow
    });
    expect(second.ok).toBe(true);
    await flush();
    const before = store.get(KEY_BAD, FILE_A);
    expect(before?.outcome).toBe('sent-unverified');
    expect(before?.detail ?? '').not.toContain('核验超时');

    // 第一次的窗口到点(第二次自己的窗口还远未到):旧代结算不得把超时
    // 注解追到新一次重发的记录上
    clockOneNow = 2000 + 10_001;
    clockOne.tick();
    await flush();

    const record = store.get(KEY_BAD, FILE_A);
    expect(record?.outcome).toBe('sent-unverified');
    expect(record?.detail ?? '').not.toContain('核验超时');
  });
});

describe('renderHotReloadRetryReport', () => {
  it('空动作序=无投递记录文案', () => {
    expect(renderHotReloadRetryReport([])).toContain('无投递记录');
  });
});

describe('源锁(IDE-REV-026 接线)', () => {
  it('装配层注册命令,取消令牌与共享动作入口在册;package.json 在册', () => {
    // SRC-001 L6:装配位自 extension.ts 迁 src/activate/hotReload.ts(纯移动),源锁跟随装配层。
    const extension = readFileSync(path.join(__dirname, '..', 'src', 'extension.ts'), 'utf8')
      + readFileSync(path.join(__dirname, '..', 'src', 'activate', 'hotReload.ts'), 'utf8');
    expect(extension).toContain("'kbengine.hotReload.retryFailed'");
    expect(extension).toContain('runHotReloadRetryCommand');
    // 取消令牌:withProgress 通知令牌驱动 isCancelled 探针
    expect(extension).toContain('isCancelled: () => token.isCancellationRequested');
    // 与 fire 路径共用同一动作入口与台账接线
    expect(extension).toContain('runQuickActionForHotReload');
    expect(extension).toContain('resolveHotReloadActionNameForTarget');
    expect(extension).toContain('targetState: hotReloadTargetStateWiring');

    const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as {
      contributes: { commands: Array<{ command: string }> };
      activationEvents: string[];
    };
    expect(pkg.contributes.commands.some(entry => entry.command === 'kbengine.hotReload.retryFailed')).toBe(true);
    expect(pkg.activationEvents).toContain('onCommand:kbengine.hotReload.retryFailed');
  });
});
