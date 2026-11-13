import { describe, expect, it } from 'vitest';
import { HotReloadSavePipeline, isStaleResponse, type FileChanged } from '../src/backend/hotReloadSavePipeline';

// HR-PR-09(reliability-gate):热更链路可靠性门禁组合套件。
// 只组合既有已证核(HR-PR-04 流水线纯核+HR-WATCH-008 指纹撤回+HR-WATCH-011
// 版本守卫),全部虚拟时钟零 IO;四门=风暴/过期/断网(投递失败)/安全(语法闸),
// 另做规模缩放 soak(10k 事件)取吞吐实测(24h 真 soak 不在本会话口径,账本
// 如实注)。断网门语义=投递失败由调用方 forgetSent 撤回指纹(HR-PR-03/04
// 契约:核不知投递成败,失败由装配按发送结果回调)。

/** 虚拟时钟(同 HR-PR-04/05 测试:advance 按到期序冲 timer+microtask flush) */
class VirtualClock {
  private t = 0;
  private seq = 0;
  private readonly timers = new Map<number, { at: number; run: () => void }>();

  readonly now = (): number => this.t;
  readonly timerDeps = {
    set: (run: () => void, ms: number): unknown => {
      const id = ++this.seq;
      this.timers.set(id, { at: this.t + ms, run });
      return id;
    },
    clear: (handle: unknown): void => {
      if (typeof handle === 'number') {
        this.timers.delete(handle);
      }
    }
  };

  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    for (;;) {
      let next: [number, { at: number; run: () => void }] | undefined;
      for (const entry of this.timers.entries()) {
        if (entry[1].at <= target && (!next || entry[1].at < next[1].at)) {
          next = entry;
        }
      }
      if (!next) {
        break;
      }
      this.t = Math.max(this.t, next[1].at);
      this.timers.delete(next[0]);
      next[1].run();
      for (let i = 0; i < 30; i++) {
        await Promise.resolve();
      }
    }
    this.t = target;
  }
}

interface GateHarness {
  readonly clock: VirtualClock;
  readonly pipeline: HotReloadSavePipeline;
  readonly emitted: { events: readonly FileChanged[]; mode: string }[];
  /** 投递面:置 false 模拟断网(测试在 onEmit 后按结果调 forgetSent) */
  deliveryOk: boolean;
  readonly delivered: number;
  readonly withdrawn: number;
  syntaxOk: boolean;
  readonly blocked: number;
  /** 显式推进文件内容版本(模拟真实改动;不推进=同内容) */
  bumpContent(file: string): void;
  /** 批次交出后的异步投递结果回调:失败面逐文件撤回(装配真实时序) */
  withdrawFailed(): void;
}

const makeHarness = (options: { previewThreshold?: number } = {}): GateHarness => {
  const clock = new VirtualClock();
  const emitted: GateHarness['emitted'] = [];
  const contentVersion = new Map<string, number>();
  // 批次交出后才知道投递结果(onEmit 之后核心才 markSent);撤回发生在
  // 发送结果回调里=周期间之后,与装配真实时序一致
  let failedUris: string[] = [];
  const h: GateHarness = {
    clock,
    pipeline: undefined as unknown as HotReloadSavePipeline,
    emitted,
    deliveryOk: true,
    delivered: 0,
    withdrawn: 0,
    syntaxOk: true,
    blocked: 0,
    bumpContent: file => contentVersion.set(file, (contentVersion.get(file) ?? 0) + 1),
    withdrawFailed: () => {
      for (const uri of failedUris.splice(0)) {
        h.pipeline.forgetSent(uri);
        h.withdrawn += 1;
      }
    }
  };
  h.pipeline = new HotReloadSavePipeline({
    debounceMs: 100,
    stabilityWindowMs: 50,
    batchFlushMs: 10,
    batchPreviewThreshold: options.previewThreshold ?? 5000,
    timers: clock.timerDeps,
    now: () => clock.now(),
    readSnapshot: async file => ({ hash: `h-${file}-${contentVersion.get(file) ?? 0}`, content: 'x=1' }),
    checkSyntax: content => {
      if (!h.syntaxOk) {
        h.blocked += 1;
      }
      return { ok: h.syntaxOk };
    },
    onEmit: (events, mode) => {
      emitted.push({ events, mode });
      if (h.deliveryOk) {
        h.delivered += events.length;
      } else {
        // 断网:本批全失败,结果回调稍后逐文件撤回(HR-WATCH-008)
        failedUris.push(...events.map(event => event.uri));
      }
    }
  });
  return h;
};

/** 一轮:去抖(100)+稳定两拍(50)+波次冲口(10) */
const cycle = async (h: GateHarness): Promise<void> => {
  await h.clock.advance(100);
  await h.clock.advance(50);
  await h.clock.advance(10);
};

describe('门 1:保存风暴(HR-WATCH-006/016 组合)', () => {
  it('50 文件×4 连发=200 offer:每文件恰一次,归并=4,总量不放大', async () => {
    const h = makeHarness();
    for (let f = 0; f < 50; f++) {
      for (let i = 0; i < 4; i++) {
        h.pipeline.offer(`/ws/F${f}.py`, 'save');
      }
    }
    expect(h.pipeline.pendingFiles()).toHaveLength(50);
    await cycle(h);
    const all = h.emitted.flatMap(b => [...b.events]);
    expect(all).toHaveLength(50);
    expect(new Set(all.map(e => e.uri)).size).toBe(50);
    for (const event of all) {
      expect(event.coalesced).toBe(4);
    }
    expect(h.delivered).toBe(50);
  });

  it('风暴超批量阈值只预览不放行(5001 文件,阈 5000)', async () => {
    const h = makeHarness({ previewThreshold: 5000 });
    for (let f = 0; f < 5001; f++) {
      h.pipeline.offer(`/ws/S${f}.py`, 'save');
    }
    await cycle(h);
    expect(h.emitted).toHaveLength(0);
    expect(h.pipeline.previewHeldFiles()).toHaveLength(5001);
    h.pipeline.releasePreview();
    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0].mode).toBe('preview-release');
  });
});

describe('门 2:过期响应(HR-WATCH-011)', () => {
  it('在途响应期间新内容发出:sent revision 落后=stale,不得记新版本成功', async () => {
    const h = makeHarness();
    h.pipeline.offer('/ws/A.py', 'save');
    await cycle(h);
    const first = h.emitted[0].events[0];
    expect(first.revision).toBe(1);
    // 第一笔在途时,同文件新内容再次发出 → revision=2
    h.bumpContent('/ws/A.py');
    h.pipeline.offer('/ws/A.py', 'save');
    await cycle(h);
    const second = h.emitted[1].events[0];
    expect(second.revision).toBe(2);
    // 响应处理面按 isStaleResponse 纯判:v1 响应晚到=stale
    expect(isStaleResponse(first.revision, second.revision)).toBe(true);
    expect(isStaleResponse(second.revision, second.revision)).toBe(false);
  });
});

describe('门 3:断网/投递失败(HR-WATCH-008 指纹撤回)', () => {
  it('批次投递全失败→撤回→恢复后同内容照发(不永久跳过)', async () => {
    const h = makeHarness();
    h.deliveryOk = false; // 布防断网
    h.pipeline.offer('/ws/A.py', 'save');
    await cycle(h);
    h.withdrawFailed(); // 异步发送结果回调:失败撤回指纹
    expect(h.emitted).toHaveLength(1);
    expect(h.delivered).toBe(0);
    expect(h.withdrawn).toBe(1); // 失败面已撤回指纹

    // 恢复:同内容再次变更→照发(不被一次失败永久跳过)
    h.deliveryOk = true;
    h.pipeline.offer('/ws/A.py', 'save');
    await cycle(h);
    expect(h.emitted).toHaveLength(2);
    expect(h.delivered).toBe(1);
    expect(h.emitted[1].events[0].revision).toBe(2); // 失败批次不占成功版本语义,重发是新内容版本
  });

  it('断网风暴:批量失败逐文件撤回,恢复后一批全重发', async () => {
    const h = makeHarness();
    h.deliveryOk = false;
    for (let f = 0; f < 20; f++) {
      h.pipeline.offer(`/ws/N${f}.py`, 'save');
    }
    await cycle(h);
    h.withdrawFailed();
    expect(h.emitted).toHaveLength(1);
    expect(h.withdrawn).toBe(20);
    expect(h.delivered).toBe(0);

    h.deliveryOk = true;
    for (let f = 0; f < 20; f++) {
      h.pipeline.offer(`/ws/N${f}.py`, 'save');
    }
    await cycle(h);
    const resent = h.emitted[1].events;
    expect(resent).toHaveLength(20);
    expect(h.delivered).toBe(20);
  });
});

describe('门 4:安全(语法闸,HR-WATCH-012)', () => {
  it('风暴中半成品(语法坏)一律拦截,不发送不占版本号', async () => {
    const h = makeHarness();
    h.syntaxOk = false;
    for (let f = 0; f < 10; f++) {
      h.pipeline.offer(`/ws/B${f}.py`, 'save');
    }
    await cycle(h);
    expect(h.emitted).toHaveLength(0);
    expect(h.blocked).toBe(10);
    // 恢复语法合法后重发:revision 从 1 起(拦截不占号)
    h.syntaxOk = true;
    for (let f = 0; f < 10; f++) {
      h.pipeline.offer(`/ws/B${f}.py`, 'save');
    }
    await cycle(h);
    for (const event of h.emitted[0].events) {
      expect(event.revision).toBe(1);
    }
  });
});

describe('规模缩放 soak(10k 事件吞吐实测;24h 真 soak 不在本会话口径)', () => {
  it('1000 文件×10 连发=10000 offer:全量定稿恰一次,墙钟实测', async () => {
    const h = makeHarness();
    const t0 = Date.now();
    for (let f = 0; f < 1000; f++) {
      for (let i = 0; i < 10; i++) {
        h.pipeline.offer(`/ws/K${f}.py`, 'save');
      }
    }
    const offerMs = Date.now() - t0;
    await cycle(h);
    const totalMs = Date.now() - t0;

    const all = h.emitted.flatMap(b => [...b.events]);
    expect(all).toHaveLength(1000);
    expect(new Set(all.map(e => e.uri)).size).toBe(1000);
    for (const event of all) {
      expect(event.coalesced).toBe(10);
      expect(event.revision).toBe(1);
    }
    expect(h.pipeline.pendingFiles()).toHaveLength(0);
    // 吞吐口径如实记录(纯内存+虚拟时钟,非端到端网络口径):
    // 10k offer+1000 定稿+发批的总墙钟
    expect(totalMs).toBeLessThan(5000); // 宽松上界防负载抖动误报
    expect(offerMs).toBeLessThan(1000);
  });
});
