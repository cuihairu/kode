import { describe, expect, it } from 'vitest';
import {
  HotReloadSavePipeline,
  isDuplicateUpdate,
  isStaleResponse,
  isWatchableScriptFile,
  type FileChanged,
  type HotReloadSavePipelineOptions,
  type SavePipelineDiagnostic
} from '../src/backend/hotReloadSavePipeline';

// HR-PR-04(HR-WATCH-004/006/007/009/010/011/014/016):保存事件流水线
// 纯核测试。时钟与定时器全部虚拟:advance() 按到期序逐拍冲 timer,
// 异步续言(稳定两拍快照)靠 microtask flush 推进,顺路新挂的 timer
// 一并处理。装配接线(vscode 事件绑定/配置面/默认开关)不在本核,
// 不在本文件测试范围。

interface VirtualTimer {
  readonly at: number;
  readonly run: () => void;
}

class VirtualTime {
  private t = 0;
  private seq = 0;
  private readonly timers = new Map<number, VirtualTimer>();

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

  /** 逐拍推进:按到期序冲 timer,异步续言经 microtask flush 推进,顺路再挂新 timer 一并处理 */
  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    for (;;) {
      let next: [number, VirtualTimer] | undefined;
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
      await this.settleMicrotasks();
    }
    this.t = target;
  }

  private async settleMicrotasks(): Promise<void> {
    for (let i = 0; i < 30; i++) {
      await Promise.resolve();
    }
  }
}

interface Emitted {
  readonly events: readonly FileChanged[];
  readonly mode: 'auto' | 'preview-release';
}

interface Snapshot {
  readonly hash: string;
  readonly content: string;
}

interface Harness {
  readonly clock: VirtualTime;
  readonly pipeline: HotReloadSavePipeline;
  readonly emitted: Emitted[];
  readonly diagnostics: SavePipelineDiagnostic[];
  readonly readCalls: string[];
  readonly targets: Map<string, string>;
  /** 磁盘内容(默认快照源);改写即可驱动同文件新版本 */
  readonly disk: Map<string, Snapshot>;
  /** 快照行为覆写面:默认读 disk,测试改写以模拟逐拍变化/删除 */
  readBehavior: (file: string) => Snapshot | null;
  /** 语法闸判定(默认通过);测试改写以拦截 */
  syntaxVerdict: { ok: boolean; errors?: string[] };
}

const makePipeline = (overrides: Partial<HotReloadSavePipelineOptions> = {}): Harness => {
  const clock = new VirtualTime();
  const emitted: Emitted[] = [];
  const diagnostics: SavePipelineDiagnostic[] = [];
  const readCalls: string[] = [];
  const targets = new Map<string, string>();
  const disk = new Map<string, Snapshot>();
  const harness: Harness = {
    clock,
    emitted,
    diagnostics,
    readCalls,
    targets,
    disk,
    readBehavior: file => disk.get(file) ?? null,
    syntaxVerdict: { ok: true },
    // 装配完成后回填(pipeline 构造需要 harness 的行为面,harness 引用 pipeline)
    pipeline: undefined as unknown as HotReloadSavePipeline
  };
  const pipeline = new HotReloadSavePipeline({
    debounceMs: 100,
    maxDelayMs: 2000,
    stabilityWindowMs: 0,
    batchFlushMs: 50,
    ...overrides,
    timers: overrides.timers ?? clock.timerDeps,
    now: overrides.now ?? (() => clock.now()),
    readSnapshot: async file => {
      readCalls.push(file);
      return harness.readBehavior(file);
    },
    checkSyntax: () => harness.syntaxVerdict,
    targetOf: file => targets.get(file) ?? '',
    onDiagnostic: diagnostic => {
      diagnostics.push(diagnostic);
    },
    onEmit: (events, mode) => {
      emitted.push({ events, mode });
    }
  });
  harness.pipeline = pipeline;
  return harness;
};

/** 稳定路径一个完整周期:到期(100) → 两拍快照(200) → 波次冲口(50) */
const stabilityCycle = async (h: Harness): Promise<void> => {
  await h.clock.advance(100);
  await h.clock.advance(200);
  await h.clock.advance(50);
};

describe('HR-WATCH-006 每文件去抖(尾窗)+ max-delay 封顶', () => {
  it('同文件连发事件归并:单事件单批次,coalesced/coalesceReason 如实记账', async () => {
    const h = makePipeline();
    h.pipeline.offer('/ws/scripts/base/Avatar.py', 'save');
    h.pipeline.offer('/ws/scripts/base/Avatar.py', 'save');
    h.pipeline.offer('/ws/scripts/base/Avatar.py', 'save');
    // 尾窗:末次事件后 100ms 才到期(三发同刻 → 100ms 到期)
    await h.clock.advance(99);
    expect(h.emitted).toHaveLength(0);
    await h.clock.advance(1); // 到期定稿入波
    await h.clock.advance(50); // 波次冲口发出
    expect(h.emitted).toHaveLength(1);
    const event = h.emitted[0].events[0];
    expect(event.coalesced).toBe(3);
    expect(event.coalesceReason).toBe('debounced:3');
    expect(event.revision).toBe(1);
    expect(event.source).toBe('save');
    expect(h.emitted[0].mode).toBe('auto');
  });

  it('不同路径形态归并为同一 canonical uri(file:// 与裸路径同 pending)', async () => {
    const h = makePipeline();
    h.pipeline.offer('/ws/scripts/base/Avatar.py', 'save');
    h.pipeline.offer('file:///ws/scripts/base/Avatar.py', 'disk-change');
    await h.clock.advance(100);
    await h.clock.advance(50);
    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0].events[0].uri).toBe('/ws/scripts/base/Avatar.py');
    expect(h.emitted[0].events[0].coalesced).toBe(2);
  });

  it('窗后单发一次:coalesced=1,coalesceReason=single', async () => {
    const h = makePipeline();
    h.pipeline.offer('/ws/a.py', 'save');
    await h.clock.advance(150);
    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0].events[0].coalesced).toBe(1);
    expect(h.emitted[0].events[0].coalesceReason).toBe('single');
  });

  it('max-delay 封顶:连发 save storm 最多推迟到 max-delay,截断如实记因', async () => {
    const h = makePipeline({ debounceMs: 500, maxDelayMs: 1000 });
    h.pipeline.offer('/ws/a.py', 'save'); // 首窗 500ms → t=500
    await h.clock.advance(200);
    h.pipeline.offer('/ws/a.py', 'save'); // t=200 重排 500ms → t=700
    await h.clock.advance(200);
    h.pipeline.offer('/ws/a.py', 'save'); // t=400,余窗 min(500,600)=500 → t=900
    await h.clock.advance(200);
    h.pipeline.offer('/ws/a.py', 'save'); // t=600,余窗 min(500,400)=400 → 封顶,t=1000
    expect(h.pipeline.pendingFiles()).toEqual(['/ws/a.py']);
    await h.clock.advance(399);
    expect(h.emitted).toHaveLength(0);
    await h.clock.advance(1); // t=1000 到期
    await h.clock.advance(50); // 波次冲口
    expect(h.emitted).toHaveLength(1);
    const event = h.emitted[0].events[0];
    expect(event.coalesced).toBe(4);
    expect(event.coalesceReason).toBe('debounced:4;max-delay-capped');
  });

  it('maxDelay < debounce:首窗即封顶(上限对整段 pending 生效)', async () => {
    const h = makePipeline({ debounceMs: 500, maxDelayMs: 100 });
    h.pipeline.offer('/ws/a.py', 'save');
    await h.clock.advance(99);
    expect(h.emitted).toHaveLength(0);
    await h.clock.advance(1);
    await h.clock.advance(50);
    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0].events[0].coalesceReason).toBe('max-delay-capped');
  });
});

describe('HR-WATCH-003/009 事件源标记归并', () => {
  it('save 后紧跟 disk-change:同 pending 归并,记 disk-save-overlap,代表源=最新', async () => {
    const h = makePipeline();
    h.pipeline.offer('/ws/a.py', 'save');
    h.pipeline.offer('/ws/a.py', 'disk-change');
    await h.clock.advance(100);
    await h.clock.advance(50);
    expect(h.emitted).toHaveLength(1);
    const event = h.emitted[0].events[0];
    expect(event.coalesced).toBe(2);
    expect(event.coalesceReason).toContain('disk-save-overlap');
    expect(event.source).toBe('disk-change');
  });

  it('disk-change 后 save:归并无 overlap 因(仅 save→disk 方向记因),代表源=save', async () => {
    const h = makePipeline();
    h.pipeline.offer('/ws/a.py', 'disk-change');
    h.pipeline.offer('/ws/a.py', 'save');
    await h.clock.advance(100);
    await h.clock.advance(50);
    expect(h.emitted).toHaveLength(1);
    const event = h.emitted[0].events[0];
    expect(event.coalesced).toBe(2);
    expect(event.coalesceReason).not.toContain('disk-save-overlap');
    expect(event.source).toBe('save');
  });
});

describe('HR-WATCH-007 写入稳定(两拍快照一致才发)', () => {
  it('两拍一致:一致后发,快照恰读 2 次', async () => {
    const h = makePipeline({ stabilityWindowMs: 200, maxStabilityProbes: 3 });
    h.disk.set('/ws/a.py', { hash: 'h1', content: 'x=1' });
    h.pipeline.offer('/ws/a.py', 'save');
    await h.clock.advance(100); // 到期 → 第一拍快照 + 稳定窗 timer
    expect(h.emitted).toHaveLength(0);
    await h.clock.advance(200); // 第二拍快照一致 → 定稿入波
    expect(h.emitted).toHaveLength(0);
    await h.clock.advance(50); // 波次冲口
    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0].events[0].diskHash).toBe('h1');
    expect(h.readCalls).toHaveLength(2);
  });

  it('持续变化超探测上限:如实发末拍快照,记 unstable-after-N-probes', async () => {
    const h = makePipeline({ stabilityWindowMs: 200, maxStabilityProbes: 3 });
    let reads = 0;
    h.readBehavior = () => {
      reads += 1;
      return { hash: `h${reads}`, content: `c${reads}` };
    };
    h.pipeline.offer('/ws/a.py', 'save');
    await h.clock.advance(100); // 到期 → 探测 p0 第一拍
    await h.clock.advance(600); // 三轮探测窗各 200:p0 二拍/p1 两拍/p2 两拍,超限定稿
    await h.clock.advance(50); // 波次冲口
    expect(h.emitted).toHaveLength(1);
    const event = h.emitted[0].events[0];
    expect(event.diskHash).toBe('h6');
    expect(event.coalesceReason).toContain('unstable-after-3-probes');
    expect(reads).toBe(6);
  });

  it('首拍读不到(已删除/不可读):如实丢弃,不发', async () => {
    const h = makePipeline({ stabilityWindowMs: 200 });
    h.readBehavior = () => null;
    h.pipeline.offer('/ws/a.py', 'save');
    await stabilityCycle(h);
    expect(h.emitted).toHaveLength(0);
    expect(h.pipeline.pendingFiles()).toHaveLength(0);
    expect(h.diagnostics.some(d => d.type === 'filtered' && d.detail?.includes('读不到快照'))).toBe(true);
  });

  it('稳定窗内快照消失(写入中途删除):如实丢弃,不发', async () => {
    const h = makePipeline({ stabilityWindowMs: 200 });
    let reads = 0;
    h.readBehavior = () => {
      reads += 1;
      return reads === 1 ? { hash: 'h1', content: 'x=1' } : null;
    };
    h.pipeline.offer('/ws/a.py', 'save');
    await stabilityCycle(h);
    expect(h.emitted).toHaveLength(0);
    expect(h.pipeline.pendingFiles()).toHaveLength(0);
    expect(h.diagnostics.some(d => d.type === 'filtered' && d.detail?.includes('快照消失'))).toBe(true);
  });
});

describe('HR-WATCH-010 去重(canonical URI + targetId + 内容哈希)', () => {
  it('同内容同目标不重复发;新内容才发且 revision 递增', async () => {
    const h = makePipeline({ stabilityWindowMs: 200 });
    h.disk.set('/ws/a.py', { hash: 'h1', content: 'x=1' });
    h.pipeline.offer('/ws/a.py', 'save');
    await stabilityCycle(h);
    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0].events[0].revision).toBe(1);

    // 同内容再发(新去抖窗):deduped,不重复发
    h.pipeline.offer('/ws/a.py', 'save');
    await stabilityCycle(h);
    expect(h.emitted).toHaveLength(1);
    expect(h.diagnostics.some(d => d.type === 'deduped' && d.uri === '/ws/a.py')).toBe(true);

    // 新内容:发,revision 递增
    h.disk.set('/ws/a.py', { hash: 'h2', content: 'x=2' });
    h.pipeline.offer('/ws/a.py', 'save');
    await stabilityCycle(h);
    expect(h.emitted).toHaveLength(2);
    expect(h.emitted[1].events[0].diskHash).toBe('h2');
    expect(h.emitted[1].events[0].revision).toBe(2);
  });

  it('同内容换目标(targetId 维度):不是重复,照发', async () => {
    const h = makePipeline({ stabilityWindowMs: 200 });
    h.disk.set('/ws/a.py', { hash: 'h1', content: 'x=1' });
    h.targets.set('/ws/a.py', 'cell-1');
    h.pipeline.offer('/ws/a.py', 'save');
    await stabilityCycle(h);
    h.targets.set('/ws/a.py', 'cell-2'); // 同内容,新目标实例
    h.pipeline.offer('/ws/a.py', 'save');
    await stabilityCycle(h);
    expect(h.emitted).toHaveLength(2);
    expect(h.emitted[1].events[0].revision).toBe(2);
  });
});

describe('HR-WATCH-008 投递指纹生命周期(失败不永久跳过)', () => {
  it('投递失败撤回指纹:同内容变更照发,不永久跳过;指纹重记后再同内容被去重', async () => {
    const h = makePipeline({ stabilityWindowMs: 200 });
    h.disk.set('/ws/a.py', { hash: 'h1', content: 'x=1' });
    h.pipeline.offer('/ws/a.py', 'save');
    await stabilityCycle(h);
    expect(h.emitted).toHaveLength(1);

    // 装配面报投递失败 → 撤回指纹;同内容下一次变更照发
    h.pipeline.forgetSent('/ws/a.py');
    h.pipeline.offer('/ws/a.py', 'save');
    await stabilityCycle(h);
    expect(h.emitted).toHaveLength(2);
    expect(h.emitted[1].events[0].diskHash).toBe('h1');
    expect(h.emitted[1].events[0].revision).toBe(2);

    // 指纹重记后,再同内容变更回落到去重(不无限重发)
    h.pipeline.offer('/ws/a.py', 'save');
    await stabilityCycle(h);
    expect(h.emitted).toHaveLength(2);
    expect(h.diagnostics.filter(d => d.type === 'deduped')).toHaveLength(1);
  });

  it('指纹在批次交给发送面的那一刻记:预览滞留批次放行后才记', async () => {
    const h = makePipeline({ batchPreviewThreshold: 2, stabilityWindowMs: 200 });
    h.disk.set('/ws/a.py', { hash: 'h1', content: 'x=1' });
    h.disk.set('/ws/b.py', { hash: 'h2', content: 'x=1' });
    h.disk.set('/ws/c.py', { hash: 'h3', content: 'x=1' });
    h.pipeline.offer('/ws/a.py', 'save');
    h.pipeline.offer('/ws/b.py', 'save');
    h.pipeline.offer('/ws/c.py', 'save');
    await h.clock.advance(100);
    await h.clock.advance(200);
    await h.clock.advance(50);
    expect(h.emitted).toHaveLength(0);
    expect(h.pipeline.previewHeldFiles()).toHaveLength(3);
    h.pipeline.releasePreview();
    expect(h.emitted).toHaveLength(1);
    // 指纹已记:同内容再 offer 去重
    h.pipeline.offer('/ws/a.py', 'save');
    await stabilityCycle(h);
    expect(h.emitted).toHaveLength(1);
    expect(h.diagnostics.some(d => d.type === 'deduped' && d.uri === '/ws/a.py')).toBe(true);
  });
});

describe('HR-WATCH-012 语法闸(注入检查器不通过即拦)', () => {
  it('检查不通过:blocked,不发送半成品', async () => {
    const h = makePipeline({ stabilityWindowMs: 200 });
    h.disk.set('/ws/a.py', { hash: 'h1', content: 'def broken(' });
    h.syntaxVerdict = { ok: false, errors: ['line 1: SyntaxError: unexpected EOF'] };
    h.pipeline.offer('/ws/a.py', 'save');
    await stabilityCycle(h);
    expect(h.emitted).toHaveLength(0);
    const blocked = h.diagnostics.find(d => d.type === 'blocked');
    expect(blocked?.uri).toBe('/ws/a.py');
    expect(blocked?.detail).toContain('line 1: SyntaxError');
  });

  it('拦截不占版本号:被拦版本不递增,首发即 revision=1(HR-WATCH-011 不被误判 stale)', async () => {
    const h = makePipeline({ stabilityWindowMs: 200 });
    h.disk.set('/ws/a.py', { hash: 'h1', content: 'def broken(' });
    h.syntaxVerdict = { ok: false, errors: ['line 1: bad'] };
    h.pipeline.offer('/ws/a.py', 'save');
    await stabilityCycle(h);
    h.syntaxVerdict = { ok: true };
    h.pipeline.offer('/ws/a.py', 'save');
    await stabilityCycle(h);
    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0].events[0].revision).toBe(1);
    // 在途首个响应到达时,当前版本号即 1 → 不 stale
    expect(isStaleResponse(1, 1)).toBe(false);
  });
});

describe('HR-WATCH-016 批量预览(超阈值只预览,显式放行才发)', () => {
  it('超阈值批次只预览不自动发;releasePreview 原样放行', async () => {
    const h = makePipeline({ batchPreviewThreshold: 2 });
    h.pipeline.offer('/ws/a.py', 'save');
    h.pipeline.offer('/ws/b.py', 'save');
    h.pipeline.offer('/ws/c.py', 'save');
    await h.clock.advance(100);
    await h.clock.advance(50);
    expect(h.emitted).toHaveLength(0);
    expect(h.pipeline.previewHeldFiles()).toHaveLength(3);
    expect(h.diagnostics.some(d => d.type === 'preview')).toBe(true);

    h.pipeline.releasePreview();
    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0].mode).toBe('preview-release');
    expect(h.emitted[0].events.map(event => event.uri).sort()).toEqual(['/ws/a.py', '/ws/b.py', '/ws/c.py']);
    expect(h.pipeline.previewHeldFiles()).toHaveLength(0);
    // 无滞留时放行:如实空放,不产生新批次
    h.pipeline.releasePreview();
    expect(h.emitted).toHaveLength(1);
  });

  it('预览滞留期间新批次并入滞留队列,维持单一批次形态', async () => {
    const h = makePipeline({ batchPreviewThreshold: 2 });
    h.pipeline.offer('/ws/a.py', 'save');
    h.pipeline.offer('/ws/b.py', 'save');
    h.pipeline.offer('/ws/c.py', 'save');
    await h.clock.advance(100);
    await h.clock.advance(50);
    expect(h.pipeline.previewHeldFiles()).toHaveLength(3);

    // 滞留期间新文件走完整个流水线:并入滞留,不自动发
    h.pipeline.offer('/ws/d.py', 'save');
    await h.clock.advance(100);
    await h.clock.advance(50);
    expect(h.emitted).toHaveLength(0);
    expect(h.pipeline.previewHeldFiles()).toHaveLength(4);

    h.pipeline.releasePreview();
    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0].events).toHaveLength(4);
  });
});

describe('波次归集(同窗多文件合成一批)', () => {
  it('三文件同窗:单次 onEmit 批量三事件,冲口前 waveFiles 可自省', async () => {
    const h = makePipeline();
    h.pipeline.offer('/ws/a.py', 'save');
    h.pipeline.offer('/ws/b.py', 'save');
    h.pipeline.offer('/ws/c.py', 'save');
    await h.clock.advance(100);
    expect(h.emitted).toHaveLength(0);
    expect(h.pipeline.waveFiles().sort()).toEqual(['/ws/a.py', '/ws/b.py', '/ws/c.py']);
    await h.clock.advance(50);
    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0].events).toHaveLength(3);
    expect(h.pipeline.waveFiles()).toHaveLength(0);
  });
});

describe('HR-WATCH-014 dispose(清空待提交队列,后续事件不再受理)', () => {
  it('pending 中 dispose:定时器清除,不发出', async () => {
    const h = makePipeline();
    h.pipeline.offer('/ws/a.py', 'save');
    h.pipeline.offer('/ws/b.py', 'save');
    h.pipeline.dispose();
    expect(h.pipeline.pendingFiles()).toHaveLength(0);
    await h.clock.advance(200);
    expect(h.emitted).toHaveLength(0);
    h.pipeline.offer('/ws/c.py', 'save'); // dispose 后新事件不受理
    expect(h.pipeline.pendingFiles()).toHaveLength(0);
    await h.clock.advance(200);
    expect(h.emitted).toHaveLength(0);
  });

  it('波次缓冲与预览滞留同样清空;预览滞留放行不再发', async () => {
    const h = makePipeline({ batchPreviewThreshold: 2 });
    h.pipeline.offer('/ws/a.py', 'save');
    h.pipeline.offer('/ws/b.py', 'save');
    h.pipeline.offer('/ws/c.py', 'save');
    await h.clock.advance(100);
    await h.clock.advance(50);
    expect(h.pipeline.previewHeldFiles()).toHaveLength(3);
    h.pipeline.dispose();
    expect(h.pipeline.previewHeldFiles()).toHaveLength(0);
    h.pipeline.releasePreview();
    expect(h.emitted).toHaveLength(0);
  });
});

describe('HR-WATCH-011/010 纯判:版本守卫与去重键', () => {
  it('isStaleResponse:落后即 stale,持平不 stale,超前不 stale', () => {
    expect(isStaleResponse(1, 2)).toBe(true);
    expect(isStaleResponse(2, 2)).toBe(false);
    expect(isStaleResponse(3, 1)).toBe(false);
  });

  it('isDuplicateUpdate:uri+targetId+hash 三同才重复,任一异非重复', () => {
    const a = { uri: '/ws/a.py', targetId: 'cell-1', hash: 'h1' };
    expect(isDuplicateUpdate(a, { ...a })).toBe(true);
    expect(isDuplicateUpdate(a, { ...a, uri: '/ws/b.py' })).toBe(false);
    expect(isDuplicateUpdate(a, { ...a, targetId: 'cell-2' })).toBe(false);
    expect(isDuplicateUpdate(a, { ...a, hash: 'h2' })).toBe(false);
  });
});

describe('HR-WATCH-004 isWatchableScriptFile(纯词法过滤,零 IO)', () => {
  it('扩展名默认只认 .py(大小写不敏感);显式扩展名表按表收', () => {
    expect(isWatchableScriptFile('/ws/scripts/A.py')).toBe(true);
    expect(isWatchableScriptFile('/ws/scripts/A.PY')).toBe(true);
    expect(isWatchableScriptFile('/ws/scripts/A.txt')).toBe(false);
    expect(isWatchableScriptFile('/ws/scripts/a.kbhook', { extensions: ['.py', '.kbhook'] })).toBe(true);
    expect(isWatchableScriptFile('/ws/scripts/a.py', { extensions: ['.kbhook'] })).toBe(false);
  });

  it('备份/临时形态不收(.swp/.swo/.bak/.tmp/尾~/首尾#)', () => {
    expect(isWatchableScriptFile('/ws/.a.py.swp')).toBe(false);
    expect(isWatchableScriptFile('/ws/a.py.swo')).toBe(false);
    expect(isWatchableScriptFile('/ws/a.py.bak')).toBe(false);
    expect(isWatchableScriptFile('/ws/a.py.tmp')).toBe(false);
    expect(isWatchableScriptFile('/ws/a.py~')).toBe(false);
    expect(isWatchableScriptFile('/ws/#a.py#')).toBe(false);
  });

  it('默认排除目录段不收;额外排除表与默认表并集', () => {
    expect(isWatchableScriptFile('/ws/.git/hooks/a.py')).toBe(false);
    expect(isWatchableScriptFile('/ws/.venv/a.py')).toBe(false);
    expect(isWatchableScriptFile('/ws/venv/a.py')).toBe(false);
    expect(isWatchableScriptFile('/ws/node_modules/pkg/a.py')).toBe(false);
    expect(isWatchableScriptFile('/ws/sub/__pycache__/a.py')).toBe(false);
    expect(isWatchableScriptFile('/ws/.kbengine/tmp/a.py')).toBe(false);
    expect(isWatchableScriptFile('/ws/.ruff_cache/a.py')).toBe(false);
    expect(isWatchableScriptFile('/ws/generated/a.py', { excludedDirs: ['generated'] })).toBe(false);
    expect(isWatchableScriptFile('/ws/generated/a.py')).toBe(true);
    expect(isWatchableScriptFile('/ws/node_modules/a.py', { excludedDirs: ['generated'] })).toBe(false);
  });

  it('显式根集合:严格前缀+整段边界(/ws/scripts 不含 /ws/scripts2)', () => {
    const options = { roots: ['/ws/scripts'] };
    expect(isWatchableScriptFile('/ws/scripts/base/Avatar.py', options)).toBe(true);
    expect(isWatchableScriptFile('/ws/scripts2/Avatar.py', options)).toBe(false);
    expect(isWatchableScriptFile('/ws/outside/Avatar.py', options)).toBe(false);
    // 根自身是目录而非 .py 文件:不收
    expect(isWatchableScriptFile('/ws/scripts', options)).toBe(false);
    // Windows 形态与 file:// 形态走同一 canonical 化
    expect(isWatchableScriptFile('c:\\ws\\scripts\\A.py', { roots: ['c:/ws/scripts'] })).toBe(true);
    expect(isWatchableScriptFile('c:\\ws\\other\\A.py', { roots: ['c:/ws/scripts'] })).toBe(false);
  });

  it('空串/纯斜杠/相对单文件如实判定', () => {
    expect(isWatchableScriptFile('')).toBe(false);
    expect(isWatchableScriptFile('/')).toBe(false);
    expect(isWatchableScriptFile('Avatar.py')).toBe(true); // 无根集合时相对路径词法通过
  });
});

describe('HR-WATCH-017 诊断事件(全量可注入观察)', () => {
  it('典型运行诊断序列:trigger → scheduled → (debounced) → flushed', async () => {
    const h = makePipeline();
    h.pipeline.offer('/ws/a.py', 'save');
    h.pipeline.offer('/ws/a.py', 'save');
    await h.clock.advance(100);
    await h.clock.advance(50);
    const types = h.diagnostics.map(d => d.type);
    expect(types[0]).toBe('trigger');
    expect(types).toContain('scheduled');
    expect(types).toContain('debounced');
    expect(types[types.length - 1]).toBe('flushed');
    const debounced = h.diagnostics.find(d => d.type === 'debounced');
    expect(debounced?.detail).toContain('归并第 2 次事件');
  });

  it('空路径如实过滤(filtered),不进 pending', () => {
    const h = makePipeline();
    h.pipeline.offer('', 'save');
    h.pipeline.offer('   ', 'disk-change');
    expect(h.pipeline.pendingFiles()).toHaveLength(0);
    const filtered = h.diagnostics.filter(d => d.type === 'filtered');
    expect(filtered).toHaveLength(2);
  });
});
