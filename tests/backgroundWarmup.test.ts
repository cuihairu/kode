import { describe, expect, it } from 'vitest';
import {
  BackgroundWarmupController,
  WARMUP_SCAN_CONCURRENCY,
  mapWithConcurrency,
  warmupMarkerKey
} from '../src/backgroundWarmup';
import type {
  WarmupStageContext,
  WarmupStageDef,
  WarmupWorkspaceStateLike
} from '../src/backgroundWarmup';

// 后台预热控制器(BG-WARM 批):activate 即后台起全量索引/实例分析管线,
// 面板打开只读缓存。本文件锁控制器行为面:
//   1. start 幂等(复用在跑任务不重扫/不重起);
//   2. 完成写 workspaceState 标记(首次运行/升级重建由 firstRun/upgraded 如实记账);
//   3. 阶段间让出主线程(注入 yield 面,逐阶段结算);
//   4. 取消:中途取消止步,后续阶段不跑,不写完成标记;
//   5. 产物面:阶段声明 expectedArtifacts → 运行期面板 artifact() 复用同一在跑
//      Promise(不重算),完成后 peekArtifact 读到值;
//   6. 失败快速止步:失败阶段后续不跑,整体 failed,不写标记;
//   7. mapWithConcurrency 有界并发(KR-AUD-35 口径:上限常量,禁无界并行)。

const makeState = (initial?: unknown): { store: WarmupWorkspaceStateLike; updates: Array<[string, unknown]> } => {
  const updates: Array<[string, unknown]> = [];
  let value = initial;
  return {
    updates,
    store: {
      get: <T,>(_key: string): T | undefined => value as T | undefined,
      update: (key: string, next: unknown) => {
        value = next;
        updates.push([key, next]);
      }
    }
  };
};

const stage = (key: string, label: string, run: WarmupStageDef['run'], expectedArtifacts?: readonly string[]): WarmupStageDef => ({
  key,
  label,
  run,
  ...(expectedArtifacts ? { expectedArtifacts } : {})
});

const yieldNow = (): Promise<void> => new Promise(resolve => { setImmediate(resolve); });

describe('BackgroundWarmupController 启动/复用', () => {
  it('start 跑完全部阶段并按序结算;二次/并发 start 复用同一轮不重扫', async () => {
    const runs: string[] = [];
    const { store } = makeState();
    const controller = new BackgroundWarmupController({
      stages: [
        stage('a', '阶段A', async () => { runs.push('a'); }),
        stage('b', '阶段B', async () => { runs.push('b'); }),
        stage('c', '阶段C', async () => { runs.push('c'); })
      ],
      workspaceState: store,
      generation: 'gen-1'
    });
    const first = controller.start();
    // 并发 start(面板/装配双入口)拿到同一在跑轮,不触发第二次扫描
    const second = controller.start();
    expect(await second).toBe(await first);
    expect(runs).toEqual(['a', 'b', 'c']);
    const final = await first;
    expect(final).toBe('completed');
    expect(controller.snapshot().state).toBe('completed');
    expect(controller.snapshot().completedStages).toBe(3);
  });

  it('完成写 workspaceState 标记(generation/completedAt/durationMs/stages)', async () => {
    const { store, updates } = makeState();
    const controller = new BackgroundWarmupController({
      stages: [stage('only', '唯一阶段', async () => undefined)],
      workspaceState: store,
      generation: 'gen-7'
    });
    await controller.start();
    const markerWrites = updates.filter(([key]) => key === warmupMarkerKey);
    expect(markerWrites.length).toBe(1);
    const marker = markerWrites[0][1] as { generation: string; completedAt: string; durationMs: number; stages: string[] };
    expect(marker.generation).toBe('gen-7');
    expect(typeof marker.completedAt).toBe('string');
    expect(marker.durationMs).toBeGreaterThanOrEqual(0);
    expect(marker.stages).toEqual(['only']);
  });

  it('首次运行 firstRun=true;上一轮标记代际不同 upgraded=true', () => {
    const fresh = makeState(undefined);
    const a = new BackgroundWarmupController({
      stages: [], workspaceState: fresh.store, generation: 'gen-2'
    });
    expect(a.snapshot().firstRun).toBe(true);
    expect(a.snapshot().upgraded).toBe(false);

    const upgraded = makeState({ generation: 'gen-1', completedAt: '', durationMs: 0, stages: [] });
    const b = new BackgroundWarmupController({
      stages: [], workspaceState: upgraded.store, generation: 'gen-2'
    });
    expect(b.snapshot().firstRun).toBe(false);
    expect(b.snapshot().upgraded).toBe(true);
  });
});

describe('BackgroundWarmupController 让出与进度', () => {
  it('阶段间让出主线程(逐阶段边界结算,注入 yield 面计数)', async () => {
    let yields = 0;
    const { store } = makeState();
    const controller = new BackgroundWarmupController({
      stages: [
        stage('a', 'A', async () => undefined),
        stage('b', 'B', async () => undefined),
        stage('c', 'C', async () => undefined)
      ],
      workspaceState: store,
      generation: 'g',
      yieldBetweenStages: async () => { yields += 1; await yieldNow(); }
    });
    await controller.start();
    // 3 阶段 → 2 个阶段间让出边界
    expect(yields).toBe(2);
  });

  it('运行中 snapshot 报进度(completedStages/totalStages/running 阶段),onDidChange 逐态推送', async () => {
    const releaseA = new Promise<void>(resolve => { setTimeout(resolve, 10); });
    const snapshots: Array<ReturnType<BackgroundWarmupController['snapshot']>> = [];
    const { store } = makeState();
    const controller = new BackgroundWarmupController({
      stages: [
        stage('slow', '慢阶段', async () => { await releaseA; }),
        stage('next', '后续', async () => undefined)
      ],
      workspaceState: store,
      generation: 'g',
      onDidChange: snapshot => snapshots.push(snapshot)
    });
    const running = controller.start();
    const mid = controller.snapshot();
    expect(mid.state).toBe('running');
    expect(mid.completedStages).toBe(0);
    expect(mid.totalStages).toBe(2);
    expect(mid.stages[0].state).toBe('running');
    expect(mid.stages[1].state).toBe('pending');
    await running;
    expect(snapshots.length).toBeGreaterThanOrEqual(3);
    expect(snapshots[snapshots.length - 1].state).toBe('completed');
  });
});

describe('BackgroundWarmupController 取消与失败', () => {
  it('阶段间取消:后续阶段不跑、整体 cancelled、不写完成标记', async () => {
    const runs: string[] = [];
    const { store, updates } = makeState();
    const gate = new Promise<void>(resolve => { setTimeout(resolve, 5); });
    const controller = new BackgroundWarmupController({
      stages: [
        stage('first', '一', async () => { await gate; runs.push('first'); }),
        stage('second', '二', async () => { runs.push('second'); })
      ],
      workspaceState: store,
      generation: 'g'
    });
    const running = controller.start();
    controller.cancel('user-cancel');
    expect(await running).toBe('cancelled');
    expect(runs).toEqual(['first']);
    expect(controller.snapshot().state).toBe('cancelled');
    expect(controller.snapshot().stages[1].state).toBe('cancelled');
    expect(updates.filter(([key]) => key === warmupMarkerKey).length).toBe(0);
    // 取消后再 start 不复活(本轮已终态)
    expect(await controller.start()).toBe('cancelled');
    expect(runs).toEqual(['first']);
  });

  it('阶段抛错:快速止步(后续不跑),整体 failed,不写完成标记', async () => {
    const runs: string[] = [];
    const { store, updates } = makeState();
    const controller = new BackgroundWarmupController({
      stages: [
        stage('boom', '炸', async () => { throw new Error('boom'); }),
        stage('after', '后', async () => { runs.push('after'); })
      ],
      workspaceState: store,
      generation: 'g'
    });
    expect(await controller.start()).toBe('failed');
    expect(runs).toEqual([]);
    expect(controller.snapshot().state).toBe('failed');
    expect(controller.snapshot().stages[0].state).toBe('failed');
    expect(controller.snapshot().stages[0].error).toContain('boom');
    expect(updates.filter(([key]) => key === warmupMarkerKey).length).toBe(0);
  });
});

describe('BackgroundWarmupController 产物面(面板只读缓存/复用在跑)', () => {
  it('expectedArtifacts 在阶段启动即登记 running;artifact() 复用同一在跑 Promise 不重算', async () => {
    const release = new Promise<void>(resolve => { setTimeout(resolve, 10); });
    let computes = 0;
    const { store } = makeState();
    const controller = new BackgroundWarmupController({
      stages: [
        stage('graph', '依赖图', async ctx => {
          computes += 1;
          await release;
          ctx.publish('dependencyGraph', { nodes: ['Hero'] });
        }, ['dependencyGraph'])
      ],
      workspaceState: store,
      generation: 'g'
    });
    controller.start();
    // 阶段已启动 → 产物登记 running,面板读到 running(显示进度)
    expect(controller.peekArtifact('dependencyGraph').state).toBe('running');
    // 面板与装配面并发取同一产物 → 复用同一在跑任务,阶段只算一次
    const [viaPanel, viaStage] = await Promise.all([
      controller.artifact<{ nodes: string[] }>('dependencyGraph'),
      controller.artifact<{ nodes: string[] }>('dependencyGraph')
    ]);
    expect(computes).toBe(1);
    expect(viaPanel).toEqual({ nodes: ['Hero'] });
    expect(viaStage).toBe(viaPanel);
    expect(controller.peekArtifact('dependencyGraph')).toEqual({ state: 'done', value: { nodes: ['Hero'] } });
  });

  it('未声明/未产出产物:artifact() 如实返回 undefined,peek missing/failed', async () => {
    const { store } = makeState();
    const controller = new BackgroundWarmupController({
      stages: [stage('empty', '空', async () => undefined)],
      workspaceState: store,
      generation: 'g'
    });
    expect(controller.peekArtifact('nothing').state).toBe('missing');
    await expect(controller.artifact('nothing')).resolves.toBeUndefined();
    await controller.start();
    expect(controller.peekArtifact('nothing').state).toBe('missing');
    expect(await controller.artifact('nothing')).toBeUndefined();
  });

  it('失败阶段的声明产物落 failed,artifact() 返回 undefined(面板回落现算)', async () => {
    const { store } = makeState();
    const controller = new BackgroundWarmupController({
      stages: [stage('bad', '坏', async () => { throw new Error('x'); }, ['dep'])],
      workspaceState: store,
      generation: 'g'
    });
    controller.start();
    expect(await controller.artifact('dep')).toBeUndefined();
    expect(controller.peekArtifact('dep').state).toBe('failed');
  });
});

describe('BG-WARM 审核整改:取消兑现 / 动态登记 / 停手谓词', () => {
  it('取消即兑现在跑产物:等待中的 artifact() 立刻 resolve undefined,迟到发布不翻回 done', async () => {
    const { store } = makeState();
    let stageFinished = false;
    const hold = new Promise<void>(resolve => { setTimeout(resolve, 60); });
    const controller = new BackgroundWarmupController({
      stages: [
        stage('slow', '慢', async ctx => {
          await hold;
          stageFinished = true;
          ctx.publish('artifactKey', { v: 1 });
        }, ['artifactKey'])
      ],
      workspaceState: store,
      generation: 'g'
    });
    controller.start();
    expect(controller.peekArtifact('artifactKey').state).toBe('running');
    // 面板已在等待该产物
    const waiting = controller.artifact<{ v: number }>('artifactKey');
    controller.cancel('user-cancel');
    // 不等阶段走完:取消当场兑现
    expect(await waiting).toBeUndefined();
    expect(stageFinished).toBe(false);
    expect(controller.peekArtifact('artifactKey').state).toBe('cancelled');
    // 阶段随后自行跑完并迟到 publish:cancelled 不被翻回 done
    await controller.start();
    expect(stageFinished).toBe(true);
    expect(controller.peekArtifact('artifactKey').state).toBe('cancelled');
    expect(await controller.artifact('artifactKey')).toBeUndefined();
  });

  it('ctx.declare 把动态产物登记为 running;已终态键不回改', async () => {
    const { store } = makeState();
    const observed: Array<{ key: string; state: string }> = [];
    const controller = new BackgroundWarmupController({
      stages: [
        stage('dyn', '动态', async ctx => {
          ctx.declare('dyn:Hero');
          observed.push({ key: 'dyn:Hero', state: controller.peekArtifact('dyn:Hero').state });
          ctx.publish('dyn:Hero', { built: true });
          // 终态后再 declare:不重开成 running
          ctx.declare('dyn:Hero');
          observed.push({ key: 'dyn:Hero', state: controller.peekArtifact('dyn:Hero').state });
        })
      ],
      workspaceState: store,
      generation: 'g'
    });
    await controller.start();
    expect(observed).toEqual([
      { key: 'dyn:Hero', state: 'running' },
      { key: 'dyn:Hero', state: 'done' }
    ]);
    expect(controller.peekArtifact('dyn:Hero')).toEqual({ state: 'done', value: { built: true } });
  });

  it('mapWithConcurrency 的 stop 谓词置真后不再领取新条目(取消止步)', async () => {
    const seen: number[] = [];
    let stop = false;
    const result = await mapWithConcurrency(
      [1, 2, 3, 4, 5],
      1,
      async value => {
        seen.push(value);
        if (value === 2) { stop = true; }
        return value * 10;
      },
      { stop: () => stop }
    );
    expect(seen).toEqual([1, 2]);
    expect(result[0]).toBe(10);
    expect(result[1]).toBe(20);
    expect(result[2]).toBeUndefined();
  });
});

describe('mapWithConcurrency 有界并发(KR-AUD-35 口径)', () => {
  it('并发上限不被越过,结果保序', async () => {
    let inFlight = 0;
    let peak = 0;
    const result = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async value => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise(resolve => setTimeout(resolve, 5));
      inFlight -= 1;
      return value * 10;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThanOrEqual(2);
    expect(result).toEqual([10, 20, 30, 40, 50, 60, 70]);
  });

  it('worker 抛错整批拒绝(调用方自行兜底),并发槽正确释放', async () => {
    await expect(mapWithConcurrency([1, 2, 3], 2, async value => {
      if (value === 2) { throw new Error('mid'); }
      return value;
    })).rejects.toThrow('mid');
  });
});

describe('WarmupStageContext 契约', () => {
  it('ctx.token 反映取消旗标(运行中取消,阶段内可见);ctx.report 进度面不抛', async () => {
    let seenCancel = false;
    const { store } = makeState();
    const controller = new BackgroundWarmupController({
      stages: [
        stage('probe', '探', async (ctx: WarmupStageContext) => {
          expect(() => ctx.report('x/y')).not.toThrow();
          await new Promise(resolve => { setTimeout(resolve, 5); });
          seenCancel = ctx.token.isCancellationRequested;
        })
      ],
      workspaceState: store,
      generation: 'g'
    });
    const running = controller.start();
    controller.cancel('mid-run');
    await running;
    expect(seenCancel).toBe(true);
    expect(controller.snapshot().state).toBe('cancelled');
  });
});
