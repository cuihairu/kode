import { describe, expect, it } from 'vitest';
import {
  HotReloadSavePipeline,
  isDuplicateUpdate,
  isStaleResponse,
  isWatchableScriptFile,
  type FileChanged,
  type HotReloadSavePipelineOptions,
  type SavePipelineDiagnostic,
  type SavePipelineDiagnosticType
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
  /** 语法闸异步面钉:置真后检查器返回 Promise(真解释器编译形态) */
  syntaxAsync: boolean;
}

const makePipeline = (
  overrides: Partial<HotReloadSavePipelineOptions> = {},
  faces: { withSnapshot?: boolean; withChecker?: boolean } = {}
): Harness => {
  // 注入面按需挂载(与真装配同形:键关/窗 0 =面不进,核如实不读不检):
  // 稳定窗>0 必带快照读;窗 0 但显式 withSnapshot(=语法闸内容面)才读;
  // 检查器只随 withChecker 进(缺省装配无检查器,如实不拦)
  const wantSnapshot = faces.withSnapshot === true || (overrides.stabilityWindowMs ?? 0) > 0;
  const wantChecker = faces.withChecker === true;
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
    syntaxAsync: false,
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
    ...(wantSnapshot
      ? {
          readSnapshot: async (file: string) => {
            readCalls.push(file);
            return harness.readBehavior(file);
          }
        }
      : {}),
    ...(wantChecker
      ? {
          checkSyntax: () =>
            harness.syntaxAsync ? Promise.resolve(harness.syntaxVerdict) : harness.syntaxVerdict
        }
      : {}),
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

  it('revisionOf 自省:发出面版本号可查,未定稿文件如实 0(HR-WATCH-011 响应面快照用)', async () => {
    const h = makePipeline({ stabilityWindowMs: 200 });
    expect(h.pipeline.revisionOf('/ws/a.py')).toBe(0); // 未定稿如实 0
    h.disk.set('/ws/a.py', { hash: 'h1', content: 'x=1' });
    h.pipeline.offer('/ws/a.py', 'save');
    await stabilityCycle(h);
    expect(h.emitted).toHaveLength(1);
    expect(h.pipeline.revisionOf('/ws/a.py')).toBe(1);
    // 再定稿新版本递增;响应面比对(isStaleResponse)以此为当前值
    h.disk.set('/ws/a.py', { hash: 'h2', content: 'x=2' });
    h.pipeline.offer('/ws/a.py', 'save');
    await stabilityCycle(h);
    expect(h.pipeline.revisionOf('/ws/a.py')).toBe(2);
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
    const h = makePipeline({ stabilityWindowMs: 200 }, { withChecker: true });
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
    const h = makePipeline({ stabilityWindowMs: 200 }, { withChecker: true });
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

  it('queueSnapshot(HR-UI-004 实时队列面):三队列一快照如实聚合,与三自省方法不分叉', async () => {
    const h = makePipeline();
    h.pipeline.offer('/ws/a.py', 'save');
    // 归并窗内:文件在 pending 归并中,wave 尚未定稿
    expect(h.pipeline.queueSnapshot()).toEqual({ pending: ['/ws/a.py'], previewHeld: [], wave: [] });
    await h.clock.advance(100);
    const snapshot = h.pipeline.queueSnapshot();
    expect(snapshot).toEqual({ pending: [], previewHeld: [], wave: ['/ws/a.py'] });
    expect(snapshot.pending).toEqual(h.pipeline.pendingFiles());
    expect(snapshot.previewHeld).toEqual(h.pipeline.previewHeldFiles());
    expect(snapshot.wave).toEqual(h.pipeline.waveFiles());
  });

  it('batchFlushMs=0 定稿即发:不起归集窗,去抖到期当拍直接出批(接线默认形态)', async () => {
    const h = makePipeline({ batchFlushMs: 0 });
    h.pipeline.offer('/ws/a.py', 'save');
    await h.clock.advance(100); // 去抖到期当拍:定稿即出,无需再等冲口
    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0].events.map(event => event.uri)).toEqual(['/ws/a.py']);
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

  it('RUST-337 路径拒绝表:命中即不收(严格前缀+整段边界,拒绝优先于根许可)', () => {
    const options = { roots: ['/ws/scripts'], denyPaths: ['/ws/scripts/generated'] };
    expect(isWatchableScriptFile('/ws/scripts/base/Avatar.py', options)).toBe(true);
    expect(isWatchableScriptFile('/ws/scripts/generated/Avatar.py', options)).toBe(false);
    // 整段边界:/ws/scripts/generated2 不被 /ws/scripts/generated 拒
    expect(isWatchableScriptFile('/ws/scripts/generated2/Avatar.py', options)).toBe(true);
    // 拒绝优先:无根集合时仅凭拒绝表即拒
    expect(isWatchableScriptFile('/ws/scripts/Avatar.py', { denyPaths: ['/ws/scripts'] })).toBe(false);
    // 根自身路径恰等于拒绝表项(目录非 .py,本就不收;此处钉拒绝语义不抬枪)
    expect(isWatchableScriptFile('/ws/scripts/generated', options)).toBe(false);
    // Windows 形态与拒绝表走同一 canonical 化
    expect(isWatchableScriptFile('c:\\ws\\scripts\\generated\\A.py', { roots: ['c:/ws/scripts'], denyPaths: ['c:/ws/scripts/generated'] })).toBe(false);
    expect(isWatchableScriptFile('c:\\ws\\scripts\\base\\A.py', { roots: ['c:/ws/scripts'], denyPaths: ['c:/ws/scripts/generated'] })).toBe(true);
    // 空表 = 行为逐字不变(无根集合时全收)
    expect(isWatchableScriptFile('/ws/scripts/generated/Avatar.py', { denyPaths: [] })).toBe(true);
  });

  it('RUST-337 路径许可表:非空即只收表内(严格前缀+整段边界,拒绝优先于许可)', () => {
    const options = { allowPaths: ['/ws/scripts/base'] };
    expect(isWatchableScriptFile('/ws/scripts/base/Avatar.py', options)).toBe(true);
    // 表外即不收(即使无根集合限制)
    expect(isWatchableScriptFile('/ws/scripts/other/Avatar.py', options)).toBe(false);
    // 整段边界:/ws/scripts/base2 不被 /ws/scripts/base 许可
    expect(isWatchableScriptFile('/ws/scripts/base2/Avatar.py', options)).toBe(false);
    // 许可表自身路径(目录非 .py,本就不收;此处钉许可语义不抬枪)
    expect(isWatchableScriptFile('/ws/scripts/base', options)).toBe(false);
    // 拒绝优先于许可:同文件既在许可表又在拒绝表=拒绝
    expect(
      isWatchableScriptFile('/ws/scripts/base/gen/Avatar.py', {
        allowPaths: ['/ws/scripts/base'],
        denyPaths: ['/ws/scripts/base/gen']
      })
    ).toBe(false);
    expect(
      isWatchableScriptFile('/ws/scripts/base/Avatar.py', {
        allowPaths: ['/ws/scripts/base'],
        denyPaths: ['/ws/scripts/base/gen']
      })
    ).toBe(true);
    // 与根许可同用:根内且许可内才收
    expect(
      isWatchableScriptFile('/ws/scripts/base/Avatar.py', { roots: ['/ws/scripts'], allowPaths: ['/ws/scripts/base'] })
    ).toBe(true);
    expect(
      isWatchableScriptFile('/ws/other/Avatar.py', { roots: ['/ws/scripts'], allowPaths: ['/ws/scripts'] })
    ).toBe(false);
    // Windows 形态与许可表走同一 canonical 化
    expect(
      isWatchableScriptFile('c:\\ws\\scripts\\base\\A.py', {
        roots: ['c:/ws/scripts'],
        allowPaths: ['c:/ws/scripts/base']
      })
    ).toBe(true);
    expect(
      isWatchableScriptFile('c:\\ws\\scripts\\other\\A.py', {
        roots: ['c:/ws/scripts'],
        allowPaths: ['c:/ws/scripts/base']
      })
    ).toBe(false);
    // 空表 = 不限(行为逐字不变)
    expect(isWatchableScriptFile('/ws/scripts/other/Avatar.py', { allowPaths: [] })).toBe(true);
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

describe('HR-WATCH-012 语法闸·窗 0 内容面(单拍直取,闸不死面)', () => {
  it('窗 0+快照读:单拍读即定稿,闸收到真实内容并拦下(不读两次,无稳定窗 sleep)', async () => {
    const h = makePipeline({ stabilityWindowMs: 0 }, { withSnapshot: true, withChecker: true });
    h.disk.set('/ws/a.py', { hash: 'h1', content: 'def broken(' });
    h.syntaxVerdict = { ok: false, errors: ['SyntaxError: bad'] };
    h.pipeline.offer('/ws/a.py', 'save');
    await h.clock.advance(100); // 到期 → 单拍读 → 定稿带内容 → 闸拦
    await h.clock.advance(50); // 波次冲口(空)
    expect(h.emitted).toHaveLength(0);
    const blocked = h.diagnostics.find(d => d.type === 'blocked');
    expect(blocked?.uri).toBe('/ws/a.py');
    expect(blocked?.detail).toContain('SyntaxError');
    expect(h.readCalls).toHaveLength(1); // 单拍一次读(窗 0 不做稳定等待)
  });

  it('窗 0+闸通过:发出且带真实哈希;同内容再发被去重(哈希面随读接通)', async () => {
    const h = makePipeline({ stabilityWindowMs: 0 }, { withSnapshot: true, withChecker: true });
    h.disk.set('/ws/a.py', { hash: 'h1', content: 'x=1' });
    h.pipeline.offer('/ws/a.py', 'save');
    await h.clock.advance(100);
    await h.clock.advance(50);
    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0].events[0].diskHash).toBe('h1');
    h.pipeline.offer('/ws/a.py', 'save'); // 同内容再发(新去抖窗)
    await h.clock.advance(100);
    await h.clock.advance(50);
    expect(h.emitted).toHaveLength(1); // 去重拦下
    expect(h.diagnostics.some(d => d.type === 'deduped' && d.uri === '/ws/a.py')).toBe(true);
  });

  it('异步检查器(HR-WATCH-012 异步面):Promise 判定拦下,微任务后续言不串批', async () => {
    const h = makePipeline({ stabilityWindowMs: 200 }, { withChecker: true });
    h.syntaxAsync = true;
    h.disk.set('/ws/a.py', { hash: 'h1', content: 'def broken(' });
    h.syntaxVerdict = { ok: false, errors: ['SyntaxError: async'] };
    h.pipeline.offer('/ws/a.py', 'save');
    await h.clock.advance(100); // 到期 → 第一拍
    await h.clock.advance(200); // 第二拍一致 → 定稿 → await 异步判定
    await h.clock.advance(50);
    expect(h.emitted).toHaveLength(0); // Promise 判定同样拦下
    expect(h.diagnostics.some(d => d.type === 'blocked')).toBe(true);
    h.syntaxVerdict = { ok: true };
    h.pipeline.offer('/ws/a.py', 'save');
    await h.clock.advance(100);
    await h.clock.advance(200);
    await h.clock.advance(50);
    expect(h.emitted).toHaveLength(1); // 通过后照发
    expect(h.emitted[0].events[0].revision).toBe(1); // 拦截不占号
  });

  it('KODE-FULL-014:检查在途时的新保存,检查收口后补排处理,不悬挂到第三次保存', async () => {
    // 场景复刻探针(save-pipeline-probe):v1 语法检查挂起 → v2 保存入 pending →
    // v2 去抖窗到期被 settling 守卫挡回(timer 已耗尽)→ v1 检查放行。
    // 旧实现在此停摆:v2 pending 无 timer,悬到第三次保存才被推动
    let releaseCheck: ((verdict: { ok: boolean }) => void) | undefined;
    const gate = new Promise<{ ok: boolean }>(resolve => {
      releaseCheck = resolve;
    });
    let checkCalls = 0;
    const h = makePipeline(
      {
        stabilityWindowMs: 0,
        checkSyntax: (): Promise<{ ok: boolean }> => {
          checkCalls += 1;
          return gate.then(verdict => verdict);
        }
      },
      { withSnapshot: true }
    );
    h.disk.set('/ws/a.py', { hash: 'h1', content: 'a=1' });
    h.pipeline.offer('/ws/a.py', 'save');
    // t=100:v1 到期定稿 → 语法检查挂起(await 中,pending 已删,settling 在册)
    await h.clock.advance(100);
    expect(checkCalls).toBe(1);
    // 检查在途时保存 v2(新 pending + 去抖窗)
    h.disk.set('/ws/a.py', { hash: 'h2', content: 'b=2' });
    h.pipeline.offer('/ws/a.py', 'save');
    // t=200:v2 窗到期 → settling 守卫挡回,timer 耗尽(悬置态成形)
    await h.clock.advance(100);
    expect(checkCalls).toBe(1);
    // 放行 v1 检查:定稿收口 → finally 补排 v2
    releaseCheck?.({ ok: true });
    for (let i = 0; i < 30; i++) {
      await Promise.resolve(); // 推进 gate.then → settle 续行 → finally 补排
    }
    await h.clock.advance(50); // v1 波次冲口
    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0].events[0].diskHash).toBe('h1');
    // t+100:补排的 v2 窗到期 → 读到最新内容 → 检查(已放行)→ 定稿
    await h.clock.advance(100);
    expect(checkCalls).toBe(2);
    await h.clock.advance(50); // v2 波次冲口
    expect(h.emitted).toHaveLength(2);
    expect(h.emitted[1].events[0].diskHash).toBe('h2');
    expect(h.emitted[1].events[0].revision).toBe(2);
    // 终态:无悬置 pending(最新保存已处理,不是悬到第三次事件)
    expect(h.pipeline.pendingFiles()).toEqual([]);
  });

  it('缺省装配形态(无读无检):定稿空哈希直发,全程不触快照(现有时序不变)', async () => {
    const h = makePipeline({ stabilityWindowMs: 0 });
    h.pipeline.offer('/ws/a.py', 'save');
    await h.clock.advance(100);
    await h.clock.advance(50);
    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0].events[0].diskHash).toBe(''); // 无读面=无哈希(如实)
    expect(h.readCalls).toHaveLength(0);
    expect(h.diagnostics.some(d => d.type === 'blocked')).toBe(false);
  });
});

// COV 批 7:异步等待面的 dispose 让位守卫与缺省装配面。本文件余下不可达
// 行的逐行论证(全部走公开入口,均无触发路径,不写凑数测试):
// - 420 awaitStable 入口守卫(等待开始前 pending 已缺/disposed):两处调用点
//   (due 到期面 / 探测递归)与该守卫之间没有任何 await——due 的守卫与
//   awaitStable 首行同步连续执行,探测递归前的守卫(第二拍后)同样同步
//   连续;单线程事件循环下没有任何交错点能让 pending 在两行之间被抽走,
//   守卫与调用方的 pending/disposed 判定完全同条件冗余;
// - 489 settle 入口守卫(settle 被调时 pending 已缺/disposed):三个调用点
//   (due 直定稿 / 窗 0 单拍 / 第二拍一致 / 超限)到 settle 首行全部同步
//   连续,调用点前方各自的守卫刚验过同一条件,无交错点;
// - 564 flushWave 的 disposed/空波守卫:两处调用点——settle 定稿即发(前面
//   dispose 判定同步刚过,且 wave 刚 push 必非空)/波次冲口 timer 回调
//   (dispose 会先 clear 该 timer,注入时钟与真定时器都不再触发);波次
//   只被 flushWave 自身清空,故「空波或已停用时被调」不可构造。
describe('稳定等待面的 dispose 让位守卫(HR-WATCH-007 异步边界)', () => {
  it('稳定首拍读取挂起期间停用:续言如实让位,不产生事件', async () => {
    const h = makePipeline({ stabilityWindowMs: 200 });
    let release!: (snapshot: Snapshot | null) => void;
    const gate = new Promise<Snapshot | null>(resolve => {
      release = resolve;
    });
    h.readBehavior = (() => gate) as unknown as Harness['readBehavior'];
    h.pipeline.offer('/ws/a.py', 'save');
    await h.clock.advance(100); // 到期进稳定等待:首拍读取挂起
    expect(h.readCalls).toHaveLength(1);
    h.pipeline.dispose(); // 停用清 pending;挂起的读取随后才落地
    release?.({ hash: 'h1', content: 'x=1' });
    for (let i = 0; i < 30; i++) {
      await Promise.resolve(); // 推进读取续言:守卫见 pending 已缺 → 让位
    }
    await h.clock.advance(400);
    expect(h.emitted).toHaveLength(0);
    expect(h.pipeline.pendingFiles()).toHaveLength(0);
    expect(h.diagnostics.some(d => d.type === 'flushed')).toBe(false);
  });

  it('稳定窗睡眠期间停用:睡眠到点续言如实让位,不产生事件', async () => {
    const h = makePipeline({ stabilityWindowMs: 200 });
    h.disk.set('/ws/a.py', { hash: 'h1', content: 'x=1' });
    h.pipeline.offer('/ws/a.py', 'save');
    await h.clock.advance(100); // 到期:首拍读到,稳定窗睡眠挂起
    h.pipeline.dispose(); // 清 pending(核不跟踪睡眠 timer,到点仍会续言)
    await h.clock.advance(300); // 睡眠到点:续言见 disposed/pending 缺 → 让位
    expect(h.emitted).toHaveLength(0);
    expect(h.pipeline.pendingFiles()).toHaveLength(0);
  });

  it('第二拍读取挂起期间停用:续言如实让位,不产生事件', async () => {
    const h = makePipeline({ stabilityWindowMs: 200 });
    let reads = 0;
    let release!: (snapshot: Snapshot | null) => void;
    const gate = new Promise<Snapshot | null>(resolve => {
      release = resolve;
    });
    h.readBehavior = ((): Snapshot | null => {
      reads += 1;
      // 第二拍换成挂起 Promise:dispose 落在两拍之间
      return reads === 1 ? { hash: 'h1', content: 'x=1' } : (gate as unknown as Snapshot | null);
    }) as unknown as Harness['readBehavior'];
    h.pipeline.offer('/ws/a.py', 'save');
    await h.clock.advance(100); // 到期:首拍读到,稳定窗睡眠挂起
    await h.clock.advance(200); // 睡眠到点:第二拍读取挂起
    expect(h.readCalls).toHaveLength(2);
    h.pipeline.dispose();
    release?.({ hash: 'h1', content: 'x=1' });
    for (let i = 0; i < 30; i++) {
      await Promise.resolve(); // 推进第二拍续言:守卫见 pending 已缺 → 让位
    }
    await h.clock.advance(100);
    expect(h.emitted).toHaveLength(0);
    expect(h.pipeline.pendingFiles()).toHaveLength(0);
    expect(h.diagnostics.some(d => d.type === 'flushed')).toBe(false);
  });

  it('语法检查挂起期间停用:续言如实丢弃,不发送不入波', async () => {
    let release!: (verdict: { ok: boolean }) => void;
    const gate = new Promise<{ ok: boolean }>(resolve => {
      release = resolve;
    });
    const h = makePipeline(
      { stabilityWindowMs: 0, checkSyntax: (): Promise<{ ok: boolean }> => gate },
      { withSnapshot: true }
    );
    h.disk.set('/ws/a.py', { hash: 'h1', content: 'a=1' });
    h.pipeline.offer('/ws/a.py', 'save');
    await h.clock.advance(100); // 到期:单拍读 → 定稿带内容 → 闸挂起
    h.pipeline.dispose();
    release?.({ ok: true });
    for (let i = 0; i < 30; i++) {
      await Promise.resolve(); // 推进检查续言:守卫见 disposed → 丢弃
    }
    await h.clock.advance(50);
    expect(h.emitted).toHaveLength(0);
    expect(h.pipeline.waveFiles()).toHaveLength(0);
    expect(h.diagnostics.some(d => d.type === 'flushed')).toBe(false);
  });
});

describe('缺省装配面(未注入的定时器与备份形态第二道闸)', () => {
  it('未注入 timers:缺省真 setTimeout 面,去抖与波次冲口照常驱动', async () => {
    // 构造器缺省定时器臂只在装配未注入时走(测试/装配接线都注入),
    // 此处按真墙钟走通一个完整周期
    const emitted: Emitted[] = [];
    const pipeline = new HotReloadSavePipeline({
      debounceMs: 30,
      batchFlushMs: 10,
      stabilityWindowMs: 0,
      onEmit: (events, mode) => emitted.push({ events, mode })
    });
    pipeline.offer('/ws/a.py', 'save');
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(emitted).toHaveLength(1);
    expect(emitted[0].mode).toBe('auto');
    expect(emitted[0].events.map(event => event.uri)).toEqual(['/ws/a.py']);
  });

  it('调用方扩展名表含备份后缀时,备份形态仍如实拒收(扩展门后的第二道闸)', () => {
    // 默认扩展名表(.py)与备份形态后缀互斥,此闸只有调用方显式声明
    // 备份类扩展名才会到达;闸的语义=声明表再宽也不收编辑器临时文件
    expect(isWatchableScriptFile('/ws/.a.py.swp', { extensions: ['.py', '.swp'] })).toBe(false);
    expect(isWatchableScriptFile('/ws/a.py~', { extensions: ['.py', ''] })).toBe(false);
    expect(isWatchableScriptFile('/ws/#a.py#', { extensions: ['.py', ''] })).toBe(false);
    expect(isWatchableScriptFile('/ws/a.py.swo', { extensions: ['.swo'] })).toBe(false);
    expect(isWatchableScriptFile('/ws/a.py.bak', { extensions: ['.bak'] })).toBe(false);
    expect(isWatchableScriptFile('/ws/a.py.tmp', { extensions: ['.tmp'] })).toBe(false);
  });
});

// RUST-415(旧 HR-QA-003)连续保存 100 次同一文件:去抖归并、最终版本提交、
// 不无限请求、拦截不占版本号。装配面(每版恰一请求+旧回执不作当前结果)已在
// tests/hotReloadRevisionGate.test.ts RUST-443 节钉,本节补纯核归并面——
// 既有 HR-WATCH-006 归并用例只钉计数(3/4 发)且跑在缺省空哈希装配上,
// 无内容面;此处断言归并后读末版快照、发出哈希=末版(最终版本提交)。
describe('RUST-415 连续保存 100 次同一文件:归并+最终版本提交+不无限请求', () => {
  const FILE = '/ws/scripts/base/Avatar.py';
  const diagCount = (h: Harness, type: SavePipelineDiagnosticType): number =>
    h.diagnostics.filter(d => d.type === type).length;
  const settleFlush = async (h: Harness): Promise<void> => {
    await h.clock.advance(100); // 去抖尾窗到期→单拍定稿
    await h.clock.advance(50); // 波次冲口
  };
  const burst = (h: Harness, version: number): void => {
    for (let i = 1; i <= version; i++) {
      h.disk.set(FILE, { hash: `h${i}`, content: `v${i}` });
      h.pipeline.offer(FILE, 'save');
    }
  };

  it('窗口内 100 连发不同内容:恰 1 发,diskHash=末版,revision=1,归并后单读', async () => {
    const h = makePipeline({}, { withSnapshot: true, withChecker: true });
    burst(h, 100);
    expect(h.emitted).toHaveLength(0); // 尾窗内绝不先发中间版
    await settleFlush(h);
    expect(h.emitted).toHaveLength(1);
    const event = h.emitted[0].events[0];
    expect(event.diskHash).toBe('h100'); // 最终版本提交:末版哈希,非首版/中间版
    expect(event.revision).toBe(1); // 100 连发不虚增版本号
    expect(event.coalesced).toBe(100); // 全窗归并为一条
    expect(event.source).toBe('save');
    expect(h.readCalls).toEqual([FILE]); // 归并后单读,无中间版 IO
    expect(diagCount(h, 'trigger')).toBe(1);
    expect(diagCount(h, 'debounced')).toBe(99);
    expect(diagCount(h, 'flushed')).toBe(1);
  });

  it('窗外续保存:再定稿再发,revision=2 提交新末版(不丢版)', async () => {
    const h = makePipeline({}, { withSnapshot: true, withChecker: true });
    burst(h, 100);
    await settleFlush(h);
    expect(h.emitted).toHaveLength(1);
    h.disk.set(FILE, { hash: 'h101', content: 'v101' });
    h.pipeline.offer(FILE, 'save');
    await settleFlush(h);
    expect(h.emitted).toHaveLength(2);
    expect(h.emitted[1].events[0].revision).toBe(2);
    expect(h.emitted[1].events[0].diskHash).toBe('h101');
  });

  it('同内容 100 连发+同内容再保存:归并 1 发,指纹去重零新增(不无限请求)', async () => {
    const h = makePipeline({}, { withSnapshot: true, withChecker: true });
    h.disk.set(FILE, { hash: 'same', content: 'same' });
    for (let i = 0; i < 100; i++) {
      h.pipeline.offer(FILE, 'save');
    }
    await settleFlush(h);
    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0].events[0].diskHash).toBe('same');
    h.pipeline.offer(FILE, 'save');
    await settleFlush(h);
    expect(h.emitted).toHaveLength(1); // 同内容零新增请求
    expect(diagCount(h, 'deduped')).toBe(1);
  });

  it('100 连发后语法拦:零发半成品,拦截不占版本号(不出现错误成功态)', async () => {
    const h = makePipeline({}, { withSnapshot: true, withChecker: true });
    h.syntaxVerdict = { ok: false, errors: ['def broken(:'] };
    h.disk.set(FILE, { hash: 'broken', content: 'broken' });
    for (let i = 0; i < 100; i++) {
      h.pipeline.offer(FILE, 'save');
    }
    await settleFlush(h);
    expect(h.emitted).toHaveLength(0); // 半成品零发
    expect(diagCount(h, 'blocked')).toBe(1);
    expect(h.pipeline.revisionOf(FILE)).toBe(0); // 拦截不占版本号
  });
});
