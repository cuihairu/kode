import { describe, expect, it } from 'vitest';
import { createWarmupStages } from '../src/warmupStages';
import { BackgroundWarmupController, warmupMarkerKey } from '../src/backgroundWarmup';
import type { WarmupStageDeps } from '../src/warmupStages';
import type { WarmupWorkspaceStateLike } from '../src/backgroundWarmup';

// 预热阶段管线(BG-WARM 批):activate 后台全量索引/实例分析管线的阶段构成。
// 复用既有链:发现链(entityMapping waitForInitialScan,复用在跑首扫不重起)、
// workspaceIndex 事件索引全量首扫、依赖图(Rust 优先 TS 兜底)、定义布局预热、
// 逐实体架构流程图(有界并发,KR-AUD-35 口径)。

interface DepsStub extends WarmupStageDeps {
  calls: string[];
  flowGraphsBuilt: string[];
}

const makeDeps = (overrides: Partial<WarmupStageDeps> = {}): DepsStub => {
  const calls: string[] = [];
  const flowGraphsBuilt: string[] = [];
  const base: WarmupStageDeps = {
    waitForDiscovery: async () => { calls.push('discovery'); },
    ensureEventIndex: async () => { calls.push('eventIndex'); },
    buildDependencyGraph: async () => {
      calls.push('dependencyGraph');
      return { kind: 'ts' as const, graph: { nodes: [], edges: [], stats: {} } };
    },
    listFlowEntities: () => ['Hero', 'Monster', 'NPC'],
    buildFlowGraph: (entityName: string) => {
      calls.push(`flow:${entityName}`);
      flowGraphsBuilt.push(entityName);
      return { entityName };
    },
    preheatDefinitionLayout: () => { calls.push('layout'); },
    report: () => undefined
  };
  return { calls, flowGraphsBuilt, ...base, ...overrides };
};

const runAll = async (deps: WarmupStageDeps, concurrency = 4): Promise<void> => {
  const updates: Array<[string, unknown]> = [];
  const store: WarmupWorkspaceStateLike = {
    get: () => undefined,
    update: (key, value) => { updates.push([key, value]); }
  };
  const controller = new BackgroundWarmupController({
    stages: createWarmupStages(deps),
    workspaceState: store,
    generation: 'test',
    concurrency
  });
  const final = await controller.start();
  expect(final).toBe('completed');
  return undefined;
};

describe('createWarmupStages 阶段构成', () => {
  it('五阶段按序执行:发现链→事件索引→依赖图→布局预热→逐实体流程图', async () => {
    const deps = makeDeps();
    await runAll(deps);
    // 阶段序:discovery / eventIndex / dependencyGraph / layout 先于全部 flow
    expect(deps.calls[0]).toBe('discovery');
    expect(deps.calls[1]).toBe('eventIndex');
    expect(deps.calls[2]).toBe('dependencyGraph');
    expect(deps.calls[3]).toBe('layout');
    // flow 实体逐个建图(集合面断言,段内并发不保证条目序)
    expect(deps.flowGraphsBuilt.sort()).toEqual(['Hero', 'Monster', 'NPC']);
  });

  it('发现链只等一次:waitForDiscovery 单次调用(复用 activate 已起的首扫,不重起)', async () => {
    const deps = makeDeps();
    const stages = createWarmupStages(deps);
    expect(stages.filter(s => s.key === 'discovery').length).toBe(1);
    await runAll(deps);
    expect(deps.calls.filter(c => c === 'discovery').length).toBe(1);
    expect(deps.calls.filter(c => c === 'eventIndex').length).toBe(1);
  });

  it('依赖图阶段发布 dependencyGraph 产物(Rust 优先 TS 兜底由 deps 决定,管线不掺和)', async () => {
    const updates: Array<[string, unknown]> = [];
    const store: WarmupWorkspaceStateLike = {
      get: () => undefined,
      update: (key, value) => { updates.push([key, value]); }
    };
    const deps = makeDeps({
      buildDependencyGraph: async () => ({ kind: 'rust' as const, graph: { entities: [] } })
    });
    const controller = new BackgroundWarmupController({
      stages: createWarmupStages(deps),
      workspaceState: store,
      generation: 'test'
    });
    await controller.start();
    const peek = controller.peekArtifact<{ kind: string }>('dependencyGraph');
    expect(peek.state).toBe('done');
    expect(peek.value).toEqual({ kind: 'rust', graph: { entities: [] } });
  });

  it('逐实体流程图发布 flowGraph:<entity> 产物;空实体清单零建图', async () => {
    const updates: Array<[string, unknown]> = [];
    const store: WarmupWorkspaceStateLike = {
      get: () => undefined,
      update: (key, value) => { updates.push([key, value]); }
    };
    const deps = makeDeps();
    const controller = new BackgroundWarmupController({
      stages: createWarmupStages(deps),
      workspaceState: store,
      generation: 'test'
    });
    await controller.start();
    expect(controller.peekArtifact<unknown>('flowGraph:Hero').state).toBe('done');
    expect(controller.peekArtifact<unknown>('flowGraph:Monster').state).toBe('done');
    expect(controller.peekArtifact<unknown>('flowGraph:NPC').state).toBe('done');

    const empty = makeDeps({ listFlowEntities: () => [] });
    const emptyUpdates: Array<[string, unknown]> = [];
    const emptyStore: WarmupWorkspaceStateLike = {
      get: () => undefined,
      update: (key, value) => { emptyUpdates.push([key, value]); }
    };
    const emptyController = new BackgroundWarmupController({
      stages: createWarmupStages(empty),
      workspaceState: emptyStore,
      generation: 'test'
    });
    await emptyController.start();
    expect(emptyController.snapshot().state).toBe('completed');
    expect(empty.flowGraphsBuilt).toEqual([]);
  });

  it('阶段带 expectedArtifacts 声明:依赖图/流程图阶段运行期可被面板复用', () => {
    const stages = createWarmupStages(makeDeps());
    const byKey = new Map(stages.map(s => [s.key, s]));
    expect(byKey.get('dependencyGraph')?.expectedArtifacts).toContain('dependencyGraph');
    const flowExpected = byKey.get('flowGraphs')?.expectedArtifacts ?? [];
    expect(flowExpected.length).toBe(0); // 实体清单运行期才知道,声明为空(动态登记)
  });

  it('有界并发下流程图阶段不越上限(concurrency=2,3 实体峰值≤2)', async () => {
    let inFlight = 0;
    let peak = 0;
    const deps = makeDeps({
      buildFlowGraph: async (entityName: string) => {
        deps.flowGraphsBuilt.push(entityName);
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise(resolve => { setTimeout(resolve, 5); });
        inFlight -= 1;
        return { entityName };
      }
    });
    await runAll(deps, 2);
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBe(2);
    expect(deps.flowGraphsBuilt.sort()).toEqual(['Hero', 'Monster', 'NPC']);
  });
});

describe('BG-WARM 审核整改:动态登记 / 让出与取消 / 失败传播', () => {
  const until = async (predicate: () => boolean, timeoutMs = 4000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) {
        throw new Error('condition not met before deadline');
      }
      await new Promise(resolve => { setTimeout(resolve, 5); });
    }
  };

  const makeStore = (): { store: WarmupWorkspaceStateLike; updates: Array<[string, unknown]> } => {
    const updates: Array<[string, unknown]> = [];
    return {
      updates,
      store: { get: () => undefined, update: (key, value) => { updates.push([key, value]); } }
    };
  };

  it('流程图阶段:实体键在建图之前先登记 running(面板中途读到 running,不是 missing)', async () => {
    const { store } = makeStore();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const builtNames: string[] = [];
    const deps = makeDeps({
      listFlowEntities: () => ['Hero', 'Monster', 'NPC'],
      buildFlowGraph: async entityName => {
        await gate;
        builtNames.push(entityName);
        return { entityName };
      }
    });
    const controller = new BackgroundWarmupController({
      stages: createWarmupStages(deps),
      workspaceState: store,
      generation: 'g'
    });
    controller.start();
    await until(() => controller.peekArtifact('flowGraph:NPC').state === 'running');
    // 键先登记:此刻一张图都还没建成,面板已能读到 running 并复用
    expect(builtNames).toEqual([]);
    expect(controller.peekArtifact('flowGraph:Hero').state).toBe('running');
    release();
    expect(await controller.start()).toBe('completed');
    expect(builtNames.sort()).toEqual(['Hero', 'Monster', 'NPC']);
    expect(controller.peekArtifact('flowGraph:Hero').state).toBe('done');
  });

  it('流程图阶段逐条让出宏任务(同步建图也放行定时器,长清单不按住宿主)', async () => {
    const { store } = makeStore();
    const entities = Array.from({ length: 12 }, (_unused, index) => `E${index}`);
    let fired = false;
    let timerFiredBeforeLastBuild = false;
    const built: string[] = [];
    const busyWait = (ms: number): void => {
      const until = Date.now() + ms;
      while (Date.now() < until) { /* 同步 CPU 活:不让出就走不动定时器 */ }
    };
    const deps = makeDeps({
      listFlowEntities: () => entities,
      buildFlowGraph: entityName => {
        built.push(entityName);
        if (built.length === 1) {
          // 0ms 定时器只可能在流程图阶段内部被走动(它在首图时才起表)
          setInterval(() => { fired = true; }, 0);
        }
        busyWait(3); // 每图 3ms 同步活:不逐条让出则阶段整体是一段连续占用
        if (entityName === 'E11') {
          timerFiredBeforeLastBuild = fired;
        }
        return { entityName };
      }
    });
    const controller = new BackgroundWarmupController({
      stages: createWarmupStages(deps),
      workspaceState: store,
      generation: 'g'
    });
    expect(await controller.start()).toBe('completed');
    expect(built.length).toBe(entities.length);
    expect(timerFiredBeforeLastBuild).toBe(true);
  });

  it('取消后流程图阶段停止领取新实体(不再建图)', async () => {
    const { store } = makeStore();
    const entities = Array.from({ length: 20 }, (_unused, index) => `E${index}`);
    let controller: BackgroundWarmupController | null = null;
    const built: string[] = [];
    const deps = makeDeps({
      listFlowEntities: () => entities,
      buildFlowGraph: entityName => {
        built.push(entityName);
        controller?.cancel('mid-stage'); // 首图即取消:其后不再领取
        return { entityName };
      }
    });
    controller = new BackgroundWarmupController({
      stages: createWarmupStages(deps),
      workspaceState: store,
      generation: 'g'
    });
    expect(await controller.start()).toBe('cancelled');
    expect(built.length).toBeGreaterThanOrEqual(1);
    expect(built.length).toBeLessThan(entities.length);
  });

  it('某实体建图抛错:同阶段已声明的其余动态键结算 failed,artifact() 立即空值(不悬挂)', async () => {
    const { store, updates } = makeStore();
    let releaseFailure!: () => void;
    const failureGate = new Promise<void>(resolve => { releaseFailure = resolve; });
    const deps = makeDeps({
      listFlowEntities: () => ['Hero', 'Monster', 'NPC'],
      buildFlowGraph: async entityName => {
        if (entityName === 'Hero') {
          await failureGate; // Hero 卡住:阶段保持在跑,声明面可被观察
          throw new Error('build boom');
        }
        return { entityName };
      }
    });
    const controller = new BackgroundWarmupController({
      stages: createWarmupStages(deps),
      workspaceState: store,
      generation: 'g',
      concurrency: 1 // 串行:Hero 先炸,后两键此时尚未 publish
    });
    controller.start();
    // 声明已落地(键在跑)后再等它:失败结算必须把这条在跑键收掉
    await until(() => controller.peekArtifact('flowGraph:Monster').state === 'running');
    const waiting = controller.artifact('flowGraph:Monster');
    releaseFailure();
    expect(await controller.start()).toBe('failed');
    expect(await waiting).toBeUndefined();
    expect(controller.peekArtifact('flowGraph:Monster').state).toBe('failed');
    expect(controller.peekArtifact('flowGraph:NPC').state).toBe('failed');
    expect(updates.filter(([key]) => key === warmupMarkerKey).length).toBe(0);
  });

  it('事件索引阶段抛错:整体 failed、后续阶段不跑、不写完成标记(真实失败向上传播)', async () => {
    const { store, updates } = makeStore();
    const deps = makeDeps({
      ensureEventIndex: async () => { throw new Error('scan boom'); }
    });
    const controller = new BackgroundWarmupController({
      stages: createWarmupStages(deps),
      workspaceState: store,
      generation: 'g'
    });
    expect(await controller.start()).toBe('failed');
    // 失败快速止步:发现链之后的事件索引抛错,后续布局/流程图阶段一个不跑
    expect(deps.calls).toEqual(['discovery']);
    expect(controller.snapshot().stages[1].error).toContain('scan boom');
    expect(updates.filter(([key]) => key === warmupMarkerKey).length).toBe(0);
  });
});

