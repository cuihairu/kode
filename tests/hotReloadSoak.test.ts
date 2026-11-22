/**
 * RUST-428(HR-QA-016)Watch/HTTP soak——高迭代长稳不变式。
 *
 * 四门按 todo 原义逐项钉住「无泄漏、无膨胀、无风暴」:
 *  ①无 watcher 泄漏:2000 轮 rebuild(每次按新根重建)后创建数=处置数,
 *    存活 watcher 恒等于根数,dispose 后零残留;重建即切断上一代事件流
 *    (旧 watcher 的回调随 dispose 注销,跨代事件不外泄)。
 *  ②状态增长无界:10000 轮投递同一文件集后,台账仍是逐键单条覆盖
 *    (重发=覆盖最新一次,不追加历史),版本事件簿封顶 HOT_RELOAD_VERSION_EVENT_CAP。
 *  ③连接泄漏:10000 任务(含半数拒绝)全部结算后队列内部态全零
 *    (目标态在 idle 时自删,结算不清=泄漏),在途不超全局上限。
 *  ④错误重试风暴:100 轮重试对永久失败目标每轮恰一跳(线性,非指数),
 *    已确认侧全程零重发。
 *
 * 口径如实注:本文件是**结构性长稳**——用高迭代量把四类泄漏/风暴面
 * 压到量级上取不变式,24h 真墙钟 soak 不在本会话口径(与
 * hotReloadReliabilityGate 的 10k 缩放 soak 同口径)。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  HotReloadDiskWatchController,
  type DiskWatcherFactory,
  type DiskWatcherHandle
} from '../src/backend/hotReloadDiskWatch';
import { summarizeHotReloadBatch } from '../src/backend/hotReloadBatchSummary';
import { createHttpTargetQueue } from '../src/backend/httpRequestQueue';
import { retryFailedHotReloadTargets } from '../src/backend/hotReloadRetry';
import { HOT_RELOAD_VERSION_EVENT_CAP, HotReloadTargetStateStore } from '../src/backend/hotReloadTargetState';

/** 内存 watcher:dispose 即注销回调(与真 vscode watcher 同语义) */
interface MemoryWatcher {
  readonly pattern: string;
  disposed: number;
  change?: (uri: string) => void;
  create?: (uri: string) => void;
  remove?: (uri: string) => void;
}

const makeMemoryWatcherFactory = (): { factory: DiskWatcherFactory; created: MemoryWatcher[] } => {
  const created: MemoryWatcher[] = [];
  const factory: DiskWatcherFactory = pattern => {
    const rec: MemoryWatcher = { pattern, disposed: 0 };
    created.push(rec);
    const handle: DiskWatcherHandle = {
      pattern,
      onDidChange: cb => {
        rec.change = cb;
      },
      onDidCreate: cb => {
        rec.create = cb;
      },
      onDidDelete: cb => {
        rec.remove = cb;
      },
      dispose: () => {
        rec.disposed += 1;
        rec.change = undefined;
        rec.create = undefined;
        rec.remove = undefined;
      }
    };
    return handle;
  };
  return { factory, created };
};

const ROOTS = ['/ws/scripts', '/ws/game', '/ws/server', '/ws/ai', '/ws/entities'];

describe('RUST-428 门 1:无 watcher 泄漏(2000 轮 rebuild)', () => {
  it('rebuild 逐轮全清旧 watcher:存活恒等于根数,创建数=处置数,dispose 零残留', () => {
    const { factory, created } = makeMemoryWatcherFactory();
    const controller = new HotReloadDiskWatchController({
      offer: () => undefined,
      createWatcher: factory
    });
    const liveCount = (): number => created.length - created.reduce((sum, watcher) => sum + watcher.disposed, 0);
    for (let round = 0; round < 2000; round += 1) {
      controller.rebuild(ROOTS);
      expect(controller.watchedPatterns()).toHaveLength(5);
      expect(liveCount()).toBe(5);
    }
    // 2000 轮 × 5 根 = 10000 个 watcher 全部创建过;此刻存活恰 5(其余 9995 已清)
    expect(created).toHaveLength(10000);
    expect(liveCount()).toBe(5);
    controller.dispose();
    // dispose 后零残留:watcher 自省空,创建数=处置数(无泄漏)
    expect(controller.watchedPatterns()).toHaveLength(0);
    expect(created.reduce((sum, watcher) => sum + watcher.disposed, 0)).toBe(10000);
  });

  it('重建即切断上一代事件流:旧 watcher dispose 后事件不外泄', () => {
    const { factory, created } = makeMemoryWatcherFactory();
    const offered: string[] = [];
    const controller = new HotReloadDiskWatchController({
      offer: (file, source) => void offered.push(`${source}:${file}`),
      createWatcher: factory
    });
    controller.watchRoots(ROOTS);
    controller.arm();
    const firstGen = [...created];
    controller.rebuild(ROOTS);
    // 第一代回调随 dispose 注销:对旧 watcher 发事件=空操作,不外泄
    for (const watcher of firstGen) {
      watcher.change?.('/ws/scripts/entities/FightAI.py');
      watcher.create?.('/ws/scripts/entities/Spell.py');
    }
    expect(offered).toHaveLength(0);
    // 第二代 watcher 正常受理(事件流换到新代,不死不死锁)
    const live = created[created.length - 5];
    live.change?.('/ws/scripts/entities/FightAI.py');
    expect(offered.some(entry => entry.endsWith('entities/FightAI.py'))).toBe(true);
  });
});

describe('RUST-428 门 2:状态增长无界(10000 轮投递)', () => {
  it('台账逐键单条覆盖,版本事件簿封顶:轮次不膨胀内部状态', () => {
    const store = new HotReloadTargetStateStore({ now: () => 1 });
    const key = { rootId: 'r', targetId: 'cellapp#a' };
    const files = Array.from({ length: 10 }, (_, i) => `/ws/scripts/entities/F${i}.py`);
    for (let round = 0; round < 10000; round += 1) {
      for (const file of files) {
        // 重发=覆盖为最新一次投递(不追加历史):每轮交替失败/未确认
        store.record(key, file, round % 2 === 0 ? 'failed' : 'sent-unverified', {
          detail: `round ${round}`
        });
      }
    }
    // 逐键单条:10000 轮后每文件恰一条当前记录,代际恰 10000
    expect(store.files(key)).toHaveLength(10);
    for (const file of files) {
      const record = store.get(key, file);
      expect(record?.file).toBe(file);
      expect(record?.attempt).toBe(10000);
    }
    // 版本事件簿封顶:10000 轮投递只留最近 200 条,不随轮次线性增长
    for (const file of files) {
      const state = store.fileVersion(file);
      expect(state, `文件 ${file} 应有版本簿`).toBeDefined();
      expect(state!.events.length).toBeLessThanOrEqual(HOT_RELOAD_VERSION_EVENT_CAP);
    }
  });
});

describe('RUST-428 门 3:连接泄漏(10000 任务,20 目标)', () => {
  it('全部结算后队列内部态全零,在途不超全局上限', async () => {
    const queue = createHttpTargetQueue({ globalConcurrency: 4 });
    const runs = Array.from({ length: 10000 }, (_, i) =>
      queue.run(`t${i % 20}`, async () => {
        return i;
      })
    );
    // 同步入队后:在途恰达全局上限 4(不超),其余 9996 排队
    expect(queue.stats().inFlight).toBeLessThanOrEqual(4);
    const results = await Promise.all(runs);
    expect(results).toHaveLength(10000);
    expect(results[9999]).toBe(9999);
    // 结算后内部态全零:目标态在 idle 时自删(结算不清=连接泄漏)
    expect(queue.stats()).toEqual({ targets: 0, inFlight: 0, pending: 0 });
  });

  it('拒绝任务不泄漏:半数拒绝全部结算后仍全零', async () => {
    const queue = createHttpTargetQueue({});
    const runs = Array.from({ length: 10000 }, (_, i) =>
      queue.run(`t${i % 20}`, async () => {
        if (i % 2 === 0) {
          throw new Error(`reject ${i}`);
        }
        return i;
      })
    );
    const settled = await Promise.allSettled(runs);
    expect(settled.filter(r => r.status === 'fulfilled')).toHaveLength(5000);
    expect(settled.filter(r => r.status === 'rejected')).toHaveLength(5000);
    expect(queue.stats()).toEqual({ targets: 0, inFlight: 0, pending: 0 });
  });
});

describe('RUST-428 门 4:错误重试风暴(100 轮)', () => {
  it('永久失败目标每轮恰一跳(线性),已确认侧全程零重发', async () => {
    const FILE = '/ws/scripts/entities/Avatar.py';
    const store = new HotReloadTargetStateStore({ now: () => 1 });
    store.record({ rootId: 'r', targetId: 'cellapp#a' }, FILE, 'applied');
    store.record({ rootId: 'r', targetId: 'cellapp#b' }, FILE, 'failed', { detail: 'HTTP 500' });
    const summary = summarizeHotReloadBatch(store);
    const send = vi.fn(async () => ({ ok: false, detail: 'HTTP 500' }));
    for (let round = 0; round < 100; round += 1) {
      const actions = await retryFailedHotReloadTargets(summary, { send, isCancelled: () => false });
      expect(actions.filter(a => a.action === 'resent')).toHaveLength(1);
      expect(actions.filter(a => a.action === 'skipped-confirmed')).toHaveLength(1);
    }
    // 100 轮=100 跳(每轮恰一跳);无风暴=非指数放大
    expect(send).toHaveBeenCalledTimes(100);
    expect(send.mock.calls.every(call => call[0].targetId === 'cellapp#b')).toBe(true);
  });
});