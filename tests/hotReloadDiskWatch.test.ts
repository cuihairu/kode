import { describe, expect, it } from 'vitest';
import {
  HotReloadSavePipeline,
  isWatchableScriptFile,
  type FileChanged,
  type SavePipelineDiagnostic
} from '../src/backend/hotReloadSavePipeline';
import {
  deriveWatchGlob,
  HotReloadDiskWatchController,
  type DiskWatchDiagnostic,
  type DiskWatcherHandle
} from '../src/backend/hotReloadDiskWatch';

// HR-PR-05(HR-WATCH-003/004/005/015 + Git 批量变更):磁盘监视装配核
// 测试。watcher 用内存总线(模式匹配=根前缀+.py 后缀,足够仿真真实
// RelativePattern 语义);流水线用 HR-PR-04 真核(非 mock),全链验证
// 事件 → 过滤 → offer(disk-change) → 去抖/归并/去重/波次 → 发出。

/** 内存 watcher:记录回调,fire 由测试驱动 */
class FakeWatcher implements DiskWatcherHandle {
  readonly changeCbs: ((uri: string) => void)[] = [];
  readonly createCbs: ((uri: string) => void)[] = [];
  readonly deleteCbs: ((uri: string) => void)[] = [];
  disposeCalls = 0;
  private disposed = false;

  constructor(readonly pattern: string) {}

  readonly onDidChange = (cb: (uri: string) => void): void => {
    this.changeCbs.push(cb);
  };
  readonly onDidCreate = (cb: (uri: string) => void): void => {
    this.createCbs.push(cb);
  };
  readonly onDidDelete = (cb: (uri: string) => void): void => {
    this.deleteCbs.push(cb);
  };
  readonly dispose = (): void => {
    this.disposeCalls += 1;
    this.disposed = true;
  };

  fire(kind: 'change' | 'create' | 'delete', uri: string): void {
    if (this.disposed) {
      return; // 已 dispose 的 watcher 不再发事件(真 vscode 语义)
    }
    const cbs = kind === 'change' ? this.changeCbs : kind === 'create' ? this.createCbs : this.deleteCbs;
    for (const cb of cbs) {
      cb(uri);
    }
  }
}

/** 内存 watcher 总线:按模式把磁盘事件路由到匹配的 watcher */
class WatcherBus {
  readonly watchers: FakeWatcher[] = [];
  readonly factory = (pattern: string): DiskWatcherHandle => {
    const watcher = new FakeWatcher(pattern);
    this.watchers.push(watcher);
    return watcher;
  };

  /** 递归 glob 的内存匹配:根前缀+整段+.py 尾(仿真 RelativePattern) */
  private matches(pattern: string, uri: string): boolean {
    const root = pattern.replace(/\/\*\*\/\*\.py$/, '');
    return uri.startsWith(`${root}/`) && uri.endsWith('.py');
  }

  emitDisk(kind: 'change' | 'create' | 'delete', uri: string): void {
    for (const watcher of this.watchers) {
      if (this.matches(watcher.pattern, uri)) {
        watcher.fire(kind, uri);
      }
    }
  }
}

interface Harness {
  readonly bus: WatcherBus;
  readonly clock: VirtualClock;
  readonly controller: HotReloadDiskWatchController;
  readonly pipeline: HotReloadSavePipeline;
  readonly emitted: { events: readonly FileChanged[]; mode: 'auto' | 'preview-release' }[];
  readonly diagnostics: SavePipelineDiagnostic[];
  readonly watchDiagnostics: DiskWatchDiagnostic[];
  readonly disk: Map<string, { hash: string; content: string }>;
}

/** 虚拟时钟(与 HR-PR-04 测试同构:advance 按到期序冲 timer+microtask flush) */
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

const makeHarness = (): Harness => {
  const bus = new WatcherBus();
  const clock = new VirtualClock();
  const emitted: Harness['emitted'] = [];
  const diagnostics: SavePipelineDiagnostic[] = [];
  const watchDiagnostics: DiskWatchDiagnostic[] = [];
  const disk = new Map<string, { hash: string; content: string }>();
  const pipeline = new HotReloadSavePipeline({
    debounceMs: 100,
    stabilityWindowMs: 50,
    batchFlushMs: 50,
    timers: clock.timerDeps,
    now: () => clock.now(),
    readSnapshot: async file => disk.get(file) ?? null,
    onDiagnostic: d => {
      diagnostics.push(d);
    },
    onEmit: (events, mode) => {
      emitted.push({ events, mode });
    }
  });
  const controller = new HotReloadDiskWatchController({
    offer: (file, source) => pipeline.offer(file, source),
    createWatcher: bus.factory,
    onDiagnostic: d => {
      watchDiagnostics.push(d);
    }
  });
  return { bus, clock, controller, pipeline, emitted, diagnostics, watchDiagnostics, disk };
};

/**
 * 走完一轮:去抖(100)→ 稳定两拍(50)→ 波次冲口(50)。
 * 注意:事件文件须先在 h.disk 登记快照,否则稳定首拍读不到会被如实丢弃。
 */
const cycle = async (h: Harness): Promise<void> => {
  await h.clock.advance(100);
  await h.clock.advance(50);
  await h.clock.advance(50);
};

describe('HR-WATCH-004 只监已声明根(派生 glob)', () => {
  it('每根派生 <root>/**/*.py;根外事件到不了 watcher(bus 匹配仿真)', () => {
    const h = makeHarness();
    h.controller.watchRoots(['/ws/scripts', '/ws/other_scripts']);
    expect(h.controller.watchedPatterns()).toEqual(['/ws/scripts/**/*.py', '/ws/other_scripts/**/*.py']);
    // 根外文件:无 watcher 匹配 → 不 offer(真 vscode watcher 同语义)
    h.controller.arm();
    h.bus.emitDisk('change', '/elsewhere/Avatar.py');
    expect(h.emitted).toHaveLength(0);
  });

  it('deriveWatchGlob:规范化+派生;空根空串', () => {
    expect(deriveWatchGlob('/ws/scripts')).toBe('/ws/scripts/**/*.py');
    expect(deriveWatchGlob('file:///ws/scripts')).toBe('/ws/scripts/**/*.py');
    expect(deriveWatchGlob('   ')).toBe('');
  });
});

describe('HR-WATCH-015 基线不是变更', () => {
  it('arm 前磁盘事件一律丢弃并记诊断;arm 后照常 offer', () => {
    const h = makeHarness();
    h.controller.watchRoots(['/ws/scripts']);
    h.bus.emitDisk('change', '/ws/scripts/Avatar.py');
    h.bus.emitDisk('create', '/ws/scripts/New.py');
    expect(h.emitted).toHaveLength(0);
    expect(h.pipeline.pendingFiles()).toHaveLength(0);
    expect(h.watchDiagnostics.filter(d => d.type === 'dropped-before-arm')).toHaveLength(2);
    expect(h.controller.isArmed()).toBe(false);

    h.controller.arm();
    h.bus.emitDisk('change', '/ws/scripts/Avatar.py');
    expect(h.pipeline.pendingFiles()).toEqual(['/ws/scripts/Avatar.py']);
  });
});

describe('HR-WATCH-003 磁盘事件过滤与进管线', () => {
  it('watchable 事件 offer(disk-change) 且 canonical 化;排除目录被过滤层拦', () => {
    const h = makeHarness();
    h.controller.watchRoots(['/ws/scripts']);
    h.controller.arm();
    h.bus.emitDisk('change', '/ws/scripts/base/Avatar.py');
    expect(h.pipeline.pendingFiles()).toEqual(['/ws/scripts/base/Avatar.py']);

    // 排除目录:.py glob watcher 会送达,过滤层拦下并记 filtered 诊断
    h.bus.emitDisk('change', '/ws/scripts/.git/config.py');
    h.bus.emitDisk('create', '/ws/scripts/node_modules/pkg.py');
    expect(h.watchDiagnostics.filter(d => d.type === 'filtered')).toHaveLength(2);
    // 备份名:在 watcher glob 层(.py 尾)就到不了——bus 如实仿真不路由
    h.bus.emitDisk('change', '/ws/scripts/notes.txt.py.bak');
    expect(h.watchDiagnostics.filter(d => d.type === 'filtered')).toHaveLength(2);
    // 过滤核对备份名的词法拒绝(HR-PR-04 isWatchableScriptFile 深层防御,
    // 覆盖更宽 watcher/其他事件源送进来的场景)
    expect(isWatchableScriptFile('/ws/scripts/notes.txt.py.bak')).toBe(false);
    expect(h.pipeline.pendingFiles()).toHaveLength(1);
  });

  it('file:// 形态与裸路径同 canonical 同 pending(不双发)', () => {
    const h = makeHarness();
    h.controller.watchRoots(['/ws/scripts']);
    h.controller.arm();
    h.bus.emitDisk('change', '/ws/scripts/Avatar.py');
    // file:///ws/scripts/Avatar.py 命中同一 watcher 同一文件(仿真真 vscode 对同一文件的 URI 形态)
    h.bus.emitDisk('create', 'file:///ws/scripts/Avatar.py');
    expect(h.pipeline.pendingFiles()).toEqual(['/ws/scripts/Avatar.py']);
  });

  it('delete 事件不进管线,记 delete-ignored(已删除由流水线稳定等待如实丢弃)', () => {
    const h = makeHarness();
    h.controller.watchRoots(['/ws/scripts']);
    h.controller.arm();
    h.bus.emitDisk('delete', '/ws/scripts/Gone.py');
    expect(h.pipeline.pendingFiles()).toHaveLength(0);
    expect(h.watchDiagnostics.filter(d => d.type === 'delete-ignored')).toHaveLength(1);
  });

  it('rename(=delete+create):delete 忽略,create 照常进管线', () => {
    const h = makeHarness();
    h.controller.watchRoots(['/ws/scripts']);
    h.controller.arm();
    h.bus.emitDisk('delete', '/ws/scripts/Old.py');
    h.bus.emitDisk('create', '/ws/scripts/New.py');
    expect(h.pipeline.pendingFiles()).toEqual(['/ws/scripts/New.py']);
  });

  it('远端形态(WSL //wsl$):canonical 保留 UNC 前缀进管线', () => {
    const h = makeHarness();
    h.controller.watchRoots(['//wsl$/Ubuntu/home/u/scripts']);
    h.controller.arm();
    h.bus.emitDisk('change', '//wsl$/Ubuntu/home/u/scripts/Avatar.py');
    expect(h.pipeline.pendingFiles()).toEqual(['//wsl$/Ubuntu/home/u/scripts/Avatar.py']);
  });
});

describe('HR-WATCH-003 save 与 disk 重叠去重(经真流水线)', () => {
  it('save 后同文件 disk 事件:单事件单批次,记 disk-save-overlap', async () => {
    const h = makeHarness();
    h.disk.set('/ws/scripts/Avatar.py', { hash: 'h1', content: 'x=1' });
    h.controller.watchRoots(['/ws/scripts']);
    h.controller.arm();
    h.pipeline.offer('/ws/scripts/Avatar.py', 'save');
    h.bus.emitDisk('change', '/ws/scripts/Avatar.py');
    await cycle(h);
    expect(h.emitted).toHaveLength(1);
    const event = h.emitted[0].events[0];
    expect(event.coalesced).toBe(2);
    expect(event.coalesceReason).toContain('disk-save-overlap');
    expect(event.source).toBe('disk-change');
  });
});

describe('Git 批量变更(分支切换/checkout 爆发)', () => {
  const checkoutBurst = (h: Harness, count: number, prefix = 'F'): void => {
    for (let i = 0; i < count; i++) {
      h.disk.set(`/ws/scripts/${prefix}${i}.py`, { hash: `h-${prefix}${i}`, content: `#${i}` });
      h.bus.emitDisk('change', `/ws/scripts/${prefix}${i}.py`);
    }
  };

  it('30 文件爆发:波次归集单批发出不放大', async () => {
    const h = makeHarness();
    h.controller.watchRoots(['/ws/scripts']);
    h.controller.arm();
    checkoutBurst(h, 30);
    expect(h.pipeline.pendingFiles()).toHaveLength(30);
    await cycle(h);
    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0].mode).toBe('auto');
    expect(h.emitted[0].events).toHaveLength(30);
  });

  it('checkout 还原同内容:同内容同目标 deduped,不重复发送', async () => {
    const h = makeHarness();
    h.disk.set('/ws/scripts/Avatar.py', { hash: 'h1', content: 'x=1' });
    h.controller.watchRoots(['/ws/scripts']);
    h.controller.arm();
    // 第一轮:真实变更,发送
    h.bus.emitDisk('change', '/ws/scripts/Avatar.py');
    await cycle(h);
    expect(h.emitted).toHaveLength(1);
    // 分支切走再切回:同内容事件爆发(含 Avatar.py 原字节还原)
    checkoutBurst(h, 5);
    h.bus.emitDisk('change', '/ws/scripts/Avatar.py');
    await cycle(h);
    // Avatar.py 同内容被去重;其余 5 个新文件照常一批发
    expect(h.emitted).toHaveLength(2);
    expect(h.emitted[1].events.map(e => e.uri)).not.toContain('/ws/scripts/Avatar.py');
    expect(h.emitted[1].events).toHaveLength(5);
  });

  it('爆发超批量预览阈值:只预览不自动发,放行才发(HR-WATCH-016 兜底)', async () => {
    const bus = new WatcherBus();
    const clock = new VirtualClock();
    const emitted: Harness['emitted'] = [];
    const pipeline = new HotReloadSavePipeline({
      debounceMs: 100,
      stabilityWindowMs: 0,
      batchFlushMs: 50,
      batchPreviewThreshold: 20,
      timers: clock.timerDeps,
      now: () => clock.now(),
      onEmit: (events, mode) => {
        emitted.push({ events, mode });
      }
    });
    const controller = new HotReloadDiskWatchController({
      offer: (file, source) => pipeline.offer(file, source),
      createWatcher: bus.factory
    });
    controller.watchRoots(['/ws/scripts']);
    controller.arm();
    for (let i = 0; i < 25; i++) {
      bus.emitDisk('change', `/ws/scripts/B${i}.py`);
    }
    await clock.advance(100);
    await clock.advance(50);
    expect(emitted).toHaveLength(0);
    expect(pipeline.previewHeldFiles()).toHaveLength(25);
    pipeline.releasePreview();
    expect(emitted).toHaveLength(1);
    expect(emitted[0].mode).toBe('preview-release');
    expect(emitted[0].events).toHaveLength(25);
  });
});

describe('HR-WATCH-005 生命周期(dispose/rebuild)', () => {
  it('dispose:watcher 全清全 dispose,后续事件不受理', () => {
    const h = makeHarness();
    h.controller.watchRoots(['/ws/scripts', '/ws/other_scripts']);
    expect(h.bus.watchers).toHaveLength(2);
    h.controller.dispose();
    expect(h.controller.watchedPatterns()).toHaveLength(0);
    expect(h.bus.watchers.every(w => w.disposeCalls === 1)).toBe(true);
    // dispose 后 watcher 不再发事件(真 vscode 语义)+ 控制器也拒收
    for (const watcher of h.bus.watchers) {
      watcher.fire('change', '/ws/scripts/After.py');
    }
    expect(h.pipeline.pendingFiles()).toHaveLength(0);
    expect(h.watchDiagnostics.some(d => d.type === 'disposed')).toBe(true);
  });

  it('rebuild:旧 watcher 全 dispose,按新根重建,armed 保持(不重开基线窗)', () => {
    const h = makeHarness();
    h.controller.watchRoots(['/ws/old']);
    const oldWatcher = h.bus.watchers[0];
    h.controller.arm();
    h.controller.rebuild(['/ws/new']);
    expect(oldWatcher.disposeCalls).toBe(1);
    expect(oldWatcher.changeCbs).toHaveLength(1); // 旧 watcher 曾有订阅
    expect(h.controller.watchedPatterns()).toEqual(['/ws/new/**/*.py']);
    expect(h.controller.isArmed()).toBe(true); // 重建不重开基线窗
    h.bus.emitDisk('change', '/ws/new/Avatar.py');
    expect(h.pipeline.pendingFiles()).toEqual(['/ws/new/Avatar.py']);
  });

  it('dispose 后 watchRoots/arm/rebuild 全部不受理', () => {
    const h = makeHarness();
    h.controller.dispose();
    h.controller.watchRoots(['/ws/x']);
    h.controller.arm();
    h.controller.rebuild(['/ws/y']);
    expect(h.controller.watchedPatterns()).toHaveLength(0);
    expect(h.controller.isArmed()).toBe(false);
  });
});

describe('全链集成(磁盘事件 → 流水线 → 去抖 → 波次 → 发出)', () => {
  it('磁盘变更走完整流水线发出,事件字段如实', async () => {
    const h = makeHarness();
    h.disk.set('/ws/scripts/cell/Monster.py', { hash: 'hm', content: 'class Monster' });
    h.controller.watchRoots(['/ws/scripts']);
    h.controller.arm();
    h.bus.emitDisk('change', '/ws/scripts/cell/Monster.py');
    h.bus.emitDisk('change', '/ws/scripts/cell/Monster.py'); // 同文件连发归并
    await cycle(h);
    expect(h.emitted).toHaveLength(1);
    const event = h.emitted[0].events[0];
    expect(event.uri).toBe('/ws/scripts/cell/Monster.py');
    expect(event.source).toBe('disk-change');
    expect(event.coalesced).toBe(2);
    expect(event.revision).toBe(1);
    expect(h.emitted[0].mode).toBe('auto');
  });
});
