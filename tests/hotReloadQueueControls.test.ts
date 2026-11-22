import { beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import {
  HotReloadSavePipeline,
  type FileChanged,
  type HotReloadSavePipelineOptions,
  type SavePipelineDiagnostic
} from '../src/backend/hotReloadSavePipeline';
import { HotReloadHistoryCore, type HotReloadHistoryEntry } from '../src/backend/hotReloadHistoryCore';
import { buildHotReloadTargetKeyId, type HotReloadDeliveryRecord } from '../src/backend/hotReloadTargetState';
import {
  HOT_RELOAD_HISTORY_CLEAR_COMMAND,
  setupHotReloadHistoryView,
  type HotReloadNamesResolver
} from '../src/hotReloadHistoryView';
import { commandRegistry, windowState } from './helpers/vscodeStub';
import { messages, treeRegistrations } from './fake-vscode/windowState';

// HR-STATE-011 接口四臂:流水线 cancel/pause/resume + 历史 clear-history。
// retry/retry-all-failed 由 RUST-381 收口(重试面已齐=hotReloadRetry 纯核
// +RetryCommand+RetryChannel+DefGate),本批只补队列操作与清史。
// - 纯核:暂停按住波次归集(入口照收,恢复一次放出);取消按队列摘除
//   (pending/preview-held/wave/in-flight 如实报,定稿在途标记后入波前丢弃);
//   清史=行+索引一并丢,持久化清空由装配面负责(核心无持久化知识)。
// - 装配:三条命令(pause/resume/cancel)+ 一条清史命令,闭锁当前实例。

// ── 虚拟钟(与 hotReloadSavePipeline.test.ts 同款:逐拍冲 timer+microtask 续言) ──
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

  /** 只冲 microtask 不推钟(异步定稿在途的续言靠它推进) */
  async flush(): Promise<void> {
    await this.settleMicrotasks();
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
  readonly disk: Map<string, Snapshot>;
  /** 语法闸判定(默认通过);改写以驱动异步定稿在途 */
  syntaxGate: () => { readonly ok: boolean; readonly errors?: readonly string[] } | Promise<{ readonly ok: boolean; readonly errors?: readonly string[] }>;
  readBehavior: (file: string) => Snapshot | null;
}

const makePipeline = (
  overrides: Partial<HotReloadSavePipelineOptions> = {},
  faces: { withSnapshot?: boolean; withChecker?: boolean } = {}
): Harness => {
  const wantSnapshot = faces.withSnapshot === true || (overrides.stabilityWindowMs ?? 0) > 0;
  const wantChecker = faces.withChecker === true;
  const clock = new VirtualTime();
  const emitted: Emitted[] = [];
  const diagnostics: SavePipelineDiagnostic[] = [];
  const disk = new Map<string, Snapshot>();
  const harness: Harness = {
    clock,
    pipeline: undefined as unknown as HotReloadSavePipeline,
    emitted,
    diagnostics,
    disk,
    syntaxGate: () => ({ ok: true }),
    readBehavior: file => disk.get(file) ?? null
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
      ? { readSnapshot: async (file: string) => harness.readBehavior(file) }
      : {}),
    ...(wantChecker ? { checkSyntax: () => harness.syntaxGate() } : {}),
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

const FILE_A = '/ws/scripts/entities/fight/FightAI.py';
const FILE_B = '/ws/scripts/entities/spawn/Spawner.py';

describe('HR-STATE-011 流水线暂停/恢复', () => {
  it('暂停按住波次归集(事件留波次),恢复一次放出', async () => {
    const h = makePipeline();
    h.pipeline.pause();
    expect(h.pipeline.isPaused()).toBe(true);
    h.pipeline.offer(FILE_A, 'save');
    await h.clock.advance(100); // 到期定稿入波
    await h.clock.advance(50); // 波次冲口被暂停按住
    expect(h.emitted).toHaveLength(0);
    expect(h.pipeline.waveFiles()).toEqual([FILE_A]);
    h.pipeline.resume();
    expect(h.pipeline.isPaused()).toBe(false);
    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0].events.map(event => event.uri)).toEqual([FILE_A]);
    expect(h.pipeline.waveFiles()).toEqual([]);
  });

  it('0 冲口(定稿即发)下暂停同样按住,恢复放出', async () => {
    const h = makePipeline({ batchFlushMs: 0 });
    h.pipeline.pause();
    h.pipeline.offer(FILE_A, 'save');
    await h.clock.advance(100);
    expect(h.emitted).toHaveLength(0);
    expect(h.pipeline.waveFiles()).toEqual([FILE_A]);
    h.pipeline.resume();
    expect(h.emitted).toHaveLength(1);
  });

  it('暂停期间入口照收:多文件累积,恢复一次成批放出', async () => {
    const h = makePipeline({ batchFlushMs: 0 });
    h.pipeline.pause();
    h.pipeline.offer(FILE_A, 'save');
    await h.clock.advance(100);
    h.pipeline.offer(FILE_B, 'save');
    await h.clock.advance(100);
    expect(h.emitted).toHaveLength(0);
    h.pipeline.resume();
    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0].events.map(event => event.uri).sort()).toEqual([FILE_A, FILE_B].sort());
  });

  it('暂停只挡波次归集:恢复后冲入超阈值,再由预览滞留闸接住(两闸独立)', async () => {
    const h = makePipeline({ batchFlushMs: 50, batchPreviewThreshold: 0 });
    h.pipeline.pause();
    h.pipeline.offer(FILE_A, 'save');
    await h.clock.advance(100);
    await h.clock.advance(50);
    expect(h.emitted).toHaveLength(0);
    expect(h.pipeline.previewHeldFiles()).toEqual([]); // 从未到 emitBatch,预览滞留空
    h.pipeline.resume(); // 冲口放行 → 超阈值 0 → 预览滞留接住
    expect(h.emitted).toHaveLength(0);
    expect(h.pipeline.previewHeldFiles()).toEqual([FILE_A]);
    h.pipeline.releasePreview(); // 显式放行仍可用
    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0].mode).toBe('preview-release');
  });

  it('波次已空时恢复是幂等无动作;重复暂停幂等', async () => {
    const h = makePipeline();
    h.pipeline.pause();
    h.pipeline.pause();
    expect(h.pipeline.isPaused()).toBe(true);
    h.pipeline.resume();
    h.pipeline.resume();
    expect(h.pipeline.isPaused()).toBe(false);
    expect(h.emitted).toHaveLength(0);
  });
});

describe('HR-STATE-011 流水线取消', () => {
  it('归并中取消:摘 pending+清钟,到期不发出', async () => {
    const h = makePipeline();
    h.pipeline.offer(FILE_A, 'save');
    expect(h.pipeline.cancel(FILE_A)).toBe('pending');
    expect(h.pipeline.pendingFiles()).toEqual([]);
    await h.clock.advance(100);
    await h.clock.advance(50);
    expect(h.emitted).toHaveLength(0);
  });

  it('波次内取消:摘 wave 条目,冲口不发出', async () => {
    const h = makePipeline();
    h.pipeline.offer(FILE_A, 'save');
    await h.clock.advance(100); // 定稿入波
    expect(h.pipeline.cancel(FILE_A)).toBe('wave');
    expect(h.pipeline.waveFiles()).toEqual([]);
    await h.clock.advance(50);
    expect(h.emitted).toHaveLength(0);
  });

  it('预览滞留取消:摘滞留条目,放行无物可放', async () => {
    const h = makePipeline({ batchFlushMs: 50, batchPreviewThreshold: 0 });
    h.pipeline.offer(FILE_A, 'save');
    await h.clock.advance(100);
    await h.clock.advance(50); // → 预览滞留
    expect(h.pipeline.previewHeldFiles()).toEqual([FILE_A]);
    expect(h.pipeline.cancel(FILE_A)).toBe('preview-held');
    expect(h.pipeline.previewHeldFiles()).toEqual([]);
    h.pipeline.releasePreview();
    expect(h.emitted).toHaveLength(0);
  });

  it('定稿在途(异步语法闸)取消:标记后入波前丢弃,不发出', async () => {
    const h = makePipeline({ batchFlushMs: 0 }, { withSnapshot: true, withChecker: true });
    h.disk.set(FILE_A, { hash: 'h1', content: 'code' });
    let resolveGate!: (v: { ok: boolean }) => void;
    h.syntaxGate = () => new Promise<{ ok: boolean }>(resolve => {
      resolveGate = resolve;
    });
    h.pipeline.offer(FILE_A, 'save');
    await h.clock.advance(100); // 到期 → 读快照 → 定稿 → 等异步语法闸
    expect(h.pipeline.cancel(FILE_A)).toBe('in-flight');
    resolveGate({ ok: true });
    await h.clock.flush(); // 定稿续言 → 取消标记消费 → 丢弃
    expect(h.emitted).toHaveLength(0);
    expect(h.pipeline.waveFiles()).toEqual([]);
    expect(h.pipeline.revisionOf(FILE_A)).toBe(0); // 未发出不占版本号
  });

  it('定稿在途取消后同文件再保存:新条目正常定稿发出(旧标记不误伤)', async () => {
    const h = makePipeline({ batchFlushMs: 0 }, { withSnapshot: true, withChecker: true });
    h.disk.set(FILE_A, { hash: 'h1', content: 'code' });
    let resolveGate!: (v: { ok: boolean }) => void;
    h.syntaxGate = () => new Promise<{ ok: boolean }>(resolve => {
      resolveGate = resolve;
    });
    h.pipeline.offer(FILE_A, 'save');
    await h.clock.advance(100);
    expect(h.pipeline.cancel(FILE_A)).toBe('in-flight');
    // 取消后立刻再保存:全新 pending 条目(旧标记只该被旧定稿消费)
    h.pipeline.offer(FILE_A, 'save');
    resolveGate({ ok: true });
    h.syntaxGate = () => ({ ok: true }); // 旧闸一次性,新定稿过同步闸
    await h.clock.flush(); // 旧定稿消费标记丢弃
    h.disk.set(FILE_A, { hash: 'h2', content: 'code2' });
    await h.clock.advance(100); // 新条目到期 → 定稿发出
    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0].events.map(event => event.uri)).toEqual([FILE_A]);
  });

  it('无对应待发条目如实 none(已发出/未知文件),不假装取消', async () => {
    const h = makePipeline();
    expect(h.pipeline.cancel(FILE_A)).toBe('none');
    h.pipeline.offer(FILE_A, 'save');
    await h.clock.advance(100);
    await h.clock.advance(50); // 已发出
    expect(h.pipeline.cancel(FILE_A)).toBe('none');
  });
});

describe('HR-STATE-011 历史清空(纯核)', () => {
  const entryOf = (requestId: string): HotReloadHistoryEntry => ({
    requestId,
    fullModule: 'entities.fight.FightAI',
    requestModule: 'fight.FightAI',
    fileUri: FILE_A,
    targetId: '',
    time: 1700000000000,
    status: 'sent-unverified'
  });

  it('clear 清空行与索引;清后查询为空、状态推进如实拒', () => {
    const core = new HotReloadHistoryCore();
    core.record(entryOf('r1'));
    core.record(entryOf('r2'));
    expect(core.size()).toBe(2);
    core.clear();
    expect(core.size()).toBe(0);
    expect(core.entries()).toEqual([]);
    expect(core.newestFirst()).toEqual([]);
    expect(core.filter({})).toEqual([]);
    expect(core.updateStatus('r1', 'applied')).toBe(false); // 索引已清,如实拒
  });

  it('clear 后 record 重建正常(容量/索引不复用旧态)', () => {
    const core = new HotReloadHistoryCore();
    core.record(entryOf('r1'));
    core.clear();
    core.record(entryOf('r2'));
    expect(core.size()).toBe(1);
    expect(core.entries()[0].requestId).toBe('r2');
    expect(core.updateStatus('r2', 'applied')).toBe(true);
  });
});

describe('HR-STATE-011 历史清空命令(装配)', () => {
  const FILE = '/ws/scripts/entities/fight/FightAI.py';
  const resolver: HotReloadNamesResolver = () => ({
    fullModule: 'entities.fight.FightAI',
    requestModule: 'fight.FightAI'
  });
  const recordOf = (overrides: Partial<HotReloadDeliveryRecord> = {}): HotReloadDeliveryRecord => ({
    rootId: 'r1',
    targetId: '',
    file: FILE,
    outcome: 'applied',
    recordedAt: 1700000000000,
    attempt: 1,
    ...overrides
  });
  const contextOf = (): vscode.ExtensionContext =>
    ({ subscriptions: [] as Array<{ dispose(): void }> } as unknown as vscode.ExtensionContext);

  beforeEach(() => {
    windowState.reset();
    commandRegistry.reset();
  });

  it('命令登记:清史命令在册', () => {
    setupHotReloadHistoryView(contextOf(), { core: new HotReloadHistoryCore(), resolveNames: resolver });
    expect(commandRegistry.registeredCommandIds()).toContain(HOT_RELOAD_HISTORY_CLEAR_COMMAND);
  });

  it('执行清空:核心清空+持久化落空数组+树刷新', () => {
    const saves: (readonly HotReloadHistoryEntry[])[] = [];
    const core = new HotReloadHistoryCore();
    const feed = setupHotReloadHistoryView(contextOf(), {
      core,
      resolveNames: resolver,
      persist: { load: () => [], save: entries => saves.push(entries) }
    });
    feed.handle(recordOf());
    feed.handle(recordOf({ attempt: 2 }));
    expect(core.size()).toBe(2);
    const provider = treeRegistrations[treeRegistrations.length - 1]?.provider as {
      onDidChangeTreeData(cb: () => void): { dispose(): void };
    };
    let fires = 0;
    provider.onDidChangeTreeData(() => {
      fires += 1;
    });
    void vscode.commands.executeCommand(HOT_RELOAD_HISTORY_CLEAR_COMMAND);
    expect(core.size()).toBe(0);
    // 落账前沿窗会先存一次快照(feed 落账即存),清史命令的最后一次存空数组
    expect(saves.length).toBeGreaterThan(0);
    expect(saves[saves.length - 1]).toEqual([]);
    expect(fires).toBe(1);
  });

  it('空史执行如实报空,不写持久化', () => {
    const saves: (readonly HotReloadHistoryEntry[])[] = [];
    setupHotReloadHistoryView(contextOf(), {
      core: new HotReloadHistoryCore(),
      resolveNames: resolver,
      persist: { load: () => [], save: entries => saves.push(entries) }
    });
    void vscode.commands.executeCommand(HOT_RELOAD_HISTORY_CLEAR_COMMAND);
    expect(saves).toHaveLength(0);
    expect(messages.info.some(message => message.includes('已为空'))).toBe(true);
  });
});
