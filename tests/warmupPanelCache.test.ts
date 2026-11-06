import type * as vscode from 'vscode';
import { beforeEach, describe, expect, it } from 'vitest';
import { Uri } from './fake-vscode/core';
import {
  workspace as stubWorkspace
} from './fake-vscode/workspaceState';
import { messages, windowState } from './fake-vscode/windowState';
import { DependencyType, EntityType } from '../src/entityDependency';
import type { DependencyGraph } from '../src/entityDependency';
import type { DependencyGraphRust } from '../src/dependencyGraphRust';
import { EntityDependencyWebView } from '../src/entityDependencyWebView';
import { EntityFlowWebView } from '../src/entityFlowWebView';
import type { EntityFlowGraph } from '../src/entityFlowGraph';
import { BackgroundWarmupController } from '../src/backgroundWarmup';
import type { WarmupStageDef, WarmupWorkspaceStateLike } from '../src/backgroundWarmup';
import { createWarmupStages } from '../src/warmupStages';
import type { WarmupStageDeps } from '../src/warmupStages';

// BG-WARM 面板只读缓存(BG-WARM 批):
//   - 索引依赖面板打开 → 只读预热缓存,秒出,不触发自身扫描(零 findFiles/零 analyze);
//   - 预热中 → 面板先出进度页(部分结果),复用在跑任务不重起(阶段只算一次);
//   - 预热失败/无缓存 → 回落既有现算路径(不虚构空图为结果)。

const emptyState: WarmupWorkspaceStateLike = { get: () => undefined, update: () => undefined };

const stage = (
  key: string,
  label: string,
  run: WarmupStageDef['run'],
  expectedArtifacts?: readonly string[]
): WarmupStageDef => ({ key, label, run, ...(expectedArtifacts ? { expectedArtifacts } : {}) });

const depGraph = (): DependencyGraph => ({
  nodes: [
    {
      name: 'Hero',
      defFile: '/ws/scripts/entity_defs/Hero.def',
      types: [EntityType.Base],
      references: [],
      referencedBy: 0
    }
  ],
  edges: [],
  stats: {
    totalEntities: 1,
    baseEntities: 1,
    cellEntities: 0,
    clientEntities: 0,
    maxDepth: 1,
    mostReferenced: 'Hero'
  }
});

const flowGraph = (): EntityFlowGraph => ({
  entityName: 'Hero',
  defFilePath: '/ws/scripts/entity_defs/Hero.def',
  hasCell: true,
  actors: ['client', 'base'],
  edges: [],
  blocked: [],
  stats: {
    properties: 0,
    methods: 0,
    exposedCalls: 0,
    clientCallbacks: 0,
    persistentProperties: 0,
    blockedCalls: 0
  }
});

const outChannel = (): vscode.OutputChannel =>
  ({
    appendLine: () => undefined,
    show: () => undefined,
    dispose: () => undefined
  }) as unknown as vscode.OutputChannel;

const fakePanel = (): { panel: vscode.WebviewPanel; html: () => string } => {
  const holder: { webviewPanel?: vscode.WebviewPanel } = {};
  const panel = {
    webview: { html: '' }
  } as unknown as vscode.WebviewPanel;
  holder.panel = panel;
  return { panel, html: () => (panel.webview as unknown as { html: string }).html };
};

const internals = (webview: EntityDependencyWebView) =>
  webview as unknown as {
    panel: vscode.WebviewPanel | null;
    analyzer: { analyze(): Promise<DependencyGraph> };
    refreshGraph(): Promise<void>;
    currentRender: unknown;
  };

describe('EntityDependencyWebView 预热缓存(BG-WARM)', () => {
  let findFilesCalls = 0;
  beforeEach(() => {
    windowState.reset();
    stubWorkspace.workspaceFolders = [];
    findFilesCalls = 0;
    stubWorkspace.findFiles = (async () => {
      findFilesCalls += 1;
      return [] as Uri[];
    }) as typeof stubWorkspace.findFiles;
  });

  it('缓存命中:打开即渲染缓存图,零 findFiles/零 analyze(只读缓存不重扫)', async () => {
    const controller = new BackgroundWarmupController({
      stages: [
        stage('graph', '依赖图', async ctx => { ctx.publish('dependencyGraph', { kind: 'ts', graph: depGraph() }); }, ['dependencyGraph'])
      ],
      workspaceState: emptyState,
      generation: 'g'
    });
    controller.start();
    await controller.artifact('dependencyGraph');

    const webview = new EntityDependencyWebView({} as unknown as vscode.ExtensionContext, outChannel(), controller);
    const impl = internals(webview);
    let analyzeCalls = 0;
    impl.analyzer = { analyze: async () => { analyzeCalls += 1; return depGraph(); } };
    const { panel } = fakePanel();
    impl.panel = panel;

    await impl.refreshGraph();
    expect(analyzeCalls).toBe(0);
    expect(findFilesCalls).toBe(0);
    expect(impl.currentRender).not.toBeNull();
    expect(impl.currentRender).toMatchObject({ source: 'ts' });
  });

  it('预热中:面板先出进度页,复用在跑任务不重起(阶段只算一次,analyze 不另起)', async () => {
    let stageRuns = 0;
    let analyzeCalls = 0;
    const release = new Promise<void>(resolve => { setTimeout(resolve, 15); });
    const controller = new BackgroundWarmupController({
      stages: [
        stage('graph', '依赖图', async ctx => {
          stageRuns += 1;
          await release;
          ctx.publish('dependencyGraph', { kind: 'ts', graph: depGraph() });
        }, ['dependencyGraph'])
      ],
      workspaceState: emptyState,
      generation: 'g'
    });
    controller.start();

    const webview = new EntityDependencyWebView({} as unknown as vscode.ExtensionContext, outChannel(), controller);
    const impl = internals(webview);
    impl.analyzer = { analyze: async () => { analyzeCalls += 1; return depGraph(); } };
    const { panel } = fakePanel();
    impl.panel = panel;

    const pending = impl.refreshGraph();
    // 打开瞬间:进度页(部分结果位),不是空屏也不是另起扫描
    expect(panel.webview.html).toContain('kbengine-warmup');
    await pending;
    expect(stageRuns).toBe(1);
    expect(analyzeCalls).toBe(0);
    expect(impl.currentRender).not.toBeNull();
    expect(panel.webview.html).not.toContain('kbengine-warmup');
  });

  it('预热失败:回落现算路径(analyze 照常跑,不拿失败当结果)', async () => {
    const controller = new BackgroundWarmupController({
      stages: [stage('graph', '依赖图', async () => { throw new Error('rust down'); }, ['dependencyGraph'])],
      workspaceState: emptyState,
      generation: 'g'
    });
    controller.start();

    const webview = new EntityDependencyWebView({} as unknown as vscode.ExtensionContext, outChannel(), controller);
    const impl = internals(webview);
    let analyzeCalls = 0;
    impl.analyzer = { analyze: async () => { analyzeCalls += 1; return depGraph(); } };
    const { panel } = fakePanel();
    impl.panel = panel;

    await impl.refreshGraph();
    expect(analyzeCalls).toBe(1);
    expect(impl.currentRender).not.toBeNull();
    expect(messages.error).toHaveLength(0);
  });

  it('无 warmup 注入:既有现算路径不变(向后兼容)', async () => {
    const webview = new EntityDependencyWebView({} as unknown as vscode.ExtensionContext, outChannel());
    const impl = internals(webview);
    let analyzeCalls = 0;
    impl.analyzer = { analyze: async () => { analyzeCalls += 1; return depGraph(); } };
    const { panel } = fakePanel();
    impl.panel = panel;
    await impl.refreshGraph();
    expect(analyzeCalls).toBe(1);
    expect(impl.currentRender).not.toBeNull();
  });
});

const flowInternals = (webview: EntityFlowWebView) =>
  webview as unknown as {
    buildGraph(entityName: string): EntityFlowGraph | null;
    panel: vscode.WebviewPanel | null;
    currentGraph: EntityFlowGraph | null;
    show(entityName?: string): Promise<void>;
  };

describe('EntityFlowWebView 预热缓存(BG-WARM)', () => {
  beforeEach(() => {
    windowState.reset();
    stubWorkspace.workspaceFolders = [];
  });

  it('缓存命中:show 直接渲染缓存图,不进 buildGraph(秒出)', async () => {
    const controller = new BackgroundWarmupController({
      stages: [
        stage('flow', '流程图', async ctx => { ctx.publish('flowGraph:Hero', flowGraph()); }, ['flowGraph:Hero'])
      ],
      workspaceState: emptyState,
      generation: 'g'
    });
    controller.start();
    await controller.artifact('flowGraph:Hero');

    const webview = new EntityFlowWebView({} as unknown as vscode.ExtensionContext, controller);
    const impl = flowInternals(webview);
    let builds = 0;
    impl.buildGraph = (entityName: string) => {
      builds += 1;
      return flowGraph();
    };
    await webview.show('Hero');
    expect(builds).toBe(0);
    expect(impl.currentGraph).toEqual(flowGraph());
    expect(impl.panel).not.toBeNull();
    expect(impl.panel?.title).toContain('Hero');
  });

  it('预热中:面板先出进度页,复用在跑任务;完成后渲染缓存图', async () => {
    let builds = 0;
    const release = new Promise<void>(resolve => { setTimeout(resolve, 15); });
    const controller = new BackgroundWarmupController({
      stages: [
        stage('flow', '流程图', async ctx => {
          await release;
          ctx.publish('flowGraph:Hero', flowGraph());
        }, ['flowGraph:Hero'])
      ],
      workspaceState: emptyState,
      generation: 'g'
    });
    controller.start();

    const webview = new EntityFlowWebView({} as unknown as vscode.ExtensionContext, controller);
    const impl = flowInternals(webview);
    impl.buildGraph = (entityName: string) => {
      builds += 1;
      return flowGraph();
    };
    const pending = webview.show('Hero');
    const registryPanel = impl.panel;
    expect(registryPanel).not.toBeNull();
    expect((registryPanel!.webview as unknown as { html: string }).html).toContain('kbengine-warmup');
    await pending;
    expect(builds).toBe(0);
    expect(impl.currentGraph).toEqual(flowGraph());
  });

  it('无缓存且无工作区:既有「未找到实体定义」路径不变', async () => {
    const controller = new BackgroundWarmupController({
      stages: [stage('flow', '流程图', async () => undefined)],
      workspaceState: emptyState,
      generation: 'g'
    });
    controller.start();
    const webview = new EntityFlowWebView({} as unknown as vscode.ExtensionContext, controller);
    await webview.show('Missing');
    expect(messages.warning.some(text => text.includes('Missing'))).toBe(true);
  });
});

describe('依赖图源归一(Rust 源预热产物走 rust 归一)', () => {
  it('kind=rust 的缓存产物按 normalizeRustGraph 渲染(与现算路径同源)', async () => {
    const rust: DependencyGraphRust = {
      nodes: [
        { id: 'entity:Hero', kind: 'entity', name: 'Hero', filePath: '/ws/entities.xml', types: ['Base'] }
      ],
      edges: [],
      reverseEdges: {},
      paths: { entitiesXml: '/ws/entities.xml', defsRoot: '/ws/entity_defs', typesXml: '/ws/types.xml' },
      stats: {
        nodeCount: 1,
        edgeCount: 0,
        entityCount: 1,
        defCount: 0,
        interfaceCount: 0,
        componentCount: 0,
        typeCount: 0,
        pythonCount: 0
      }
    } as unknown as DependencyGraphRust;
    const controller = new BackgroundWarmupController({
      stages: [
        stage('graph', '依赖图', async ctx => { ctx.publish('dependencyGraph', { kind: 'rust', graph: rust }); }, ['dependencyGraph'])
      ],
      workspaceState: emptyState,
      generation: 'g'
    });
    controller.start();
    await controller.artifact('dependencyGraph');

    const webview = new EntityDependencyWebView({} as unknown as vscode.ExtensionContext, outChannel(), controller);
    const impl = internals(webview);
    impl.analyzer = { analyze: async () => { throw new Error('must not run'); } };
    const { panel } = fakePanel();
    impl.panel = panel;
    await impl.refreshGraph();
    expect(impl.currentRender).toMatchObject({ source: 'rust' });
  });
});

describe('BG-WARM 审核整改:真实阶段管线 / 缓存失效口径', () => {
  const until = async (predicate: () => boolean, timeoutMs = 4000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) {
        throw new Error('condition not met before deadline');
      }
      await new Promise(resolve => { setTimeout(resolve, 5); });
    }
  };

  beforeEach(() => {
    windowState.reset();
    stubWorkspace.workspaceFolders = [];
    stubWorkspace.findFiles = (async () => [] as Uri[]) as typeof stubWorkspace.findFiles;
  });

  it('真实 createWarmupStages:流程图阶段中途打开面板 → 键已 running → 进度页 + 复用在跑产物(不另起 buildGraph)', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let panelBuilds = 0;
    const deps: WarmupStageDeps = {
      waitForDiscovery: async () => undefined,
      ensureEventIndex: async () => undefined,
      buildDependencyGraph: async () => ({ kind: 'ts', graph: depGraph() }),
      listFlowEntities: () => ['Hero'],
      buildFlowGraph: async () => {
        await gate;
        return flowGraph();
      },
      preheatDefinitionLayout: () => undefined,
      report: () => undefined
    };
    const controller = new BackgroundWarmupController({
      stages: createWarmupStages(deps),
      workspaceState: emptyState,
      generation: 'g'
    });
    controller.start();
    await until(() => controller.peekArtifact('flowGraph:Hero').state === 'running');

    const webview = new EntityFlowWebView({} as unknown as vscode.ExtensionContext, controller);
    const impl = flowInternals(webview);
    impl.buildGraph = () => {
      panelBuilds += 1;
      return flowGraph();
    };
    const pending = webview.show('Hero');
    expect((impl.panel!.webview as unknown as { html: string }).html).toContain('kbengine-warmup');
    release();
    await pending;
    expect(panelBuilds).toBe(0);
    expect(impl.currentGraph).toEqual(flowGraph());
  });

  it('依赖图已出图后再刷新:缓存不接管,现算取最新(激活期快照不盖住之后的修改)', async () => {
    const controller = new BackgroundWarmupController({
      stages: [
        stage('graph', '依赖图', async ctx => {
          ctx.publish('dependencyGraph', { kind: 'ts', graph: depGraph() });
        }, ['dependencyGraph'])
      ],
      workspaceState: emptyState,
      generation: 'g'
    });
    controller.start();
    await controller.artifact('dependencyGraph');

    const webview = new EntityDependencyWebView({} as unknown as vscode.ExtensionContext, outChannel(), controller);
    const impl = internals(webview);
    let analyzeCalls = 0;
    impl.analyzer = {
      analyze: async () => {
        analyzeCalls += 1;
        const fresh = depGraph();
        return {
          ...fresh,
          nodes: [...fresh.nodes, { ...fresh.nodes[0], name: 'Monster' }],
          stats: { ...fresh.stats, totalEntities: 77 }
        };
      }
    };
    const { panel } = fakePanel();
    impl.panel = panel;

    await impl.refreshGraph();
    // 首开(面板空屏)吃缓存:零 analyze
    expect(analyzeCalls).toBe(0);
    expect((impl.currentRender as { stats: { entityCount: number } }).stats.entityCount).toBe(1);

    await impl.refreshGraph();
    // 再刷:现算,拿到的是新图(entityCount 77 = analyzer 新返回的那份),不是激活期快照
    expect(analyzeCalls).toBe(1);
    expect((impl.currentRender as { stats: { entityCount: number } }).stats.entityCount).toBe(77);
  });

  const flowGraphOf = (entityName: string, properties = 0): EntityFlowGraph => ({
    ...flowGraph(),
    entityName,
    stats: { ...flowGraph().stats, properties }
  });

  const flowInternalsEx = (webview: EntityFlowWebView) =>
    flowInternals(webview) as ReturnType<typeof flowInternals> & {
      currentEntityName: string | null;
    };

  it('A 等预热产物期间切到 B:A 的旧请求作废,不覆盖 B 的视图', async () => {
    let releaseA!: () => void;
    const gateA = new Promise<void>(resolve => { releaseA = resolve; });
    const controller = new BackgroundWarmupController({
      stages: [
        stage('flow', '流程图', async ctx => {
          ctx.publish('flowGraph:B', flowGraphOf('B'));
          await gateA;
          ctx.publish('flowGraph:A', flowGraphOf('A'));
        }, ['flowGraph:A', 'flowGraph:B'])
      ],
      workspaceState: emptyState,
      generation: 'g'
    });
    controller.start();

    const webview = new EntityFlowWebView({} as unknown as vscode.ExtensionContext, controller);
    const impl = flowInternalsEx(webview);
    impl.buildGraph = () => { throw new Error('不应另起现算'); };

    const pendingA = webview.show('A');
    await webview.show('B');
    expect(impl.currentEntityName).toBe('B');

    releaseA();
    await pendingA;
    // A 的旧请求代际已换:不覆盖 B,也不重开面板
    expect(impl.currentEntityName).toBe('B');
    expect(impl.panel).not.toBeNull();
    expect((impl.panel!.webview as unknown as { html: string }).html).not.toContain('kbengine-warmup');
  });

  it('等待预热产物期间关闭面板:旧请求不重建空壳面板', async () => {
    let releaseA!: () => void;
    const gateA = new Promise<void>(resolve => { releaseA = resolve; });
    const controller = new BackgroundWarmupController({
      stages: [
        stage('flow', '流程图', async ctx => {
          await gateA;
          ctx.publish('flowGraph:A', flowGraphOf('A'));
        }, ['flowGraph:A'])
      ],
      workspaceState: emptyState,
      generation: 'g'
    });
    controller.start();

    const webview = new EntityFlowWebView({} as unknown as vscode.ExtensionContext, controller);
    const impl = flowInternalsEx(webview);
    impl.buildGraph = () => { throw new Error('不应另起现算'); };

    const pending = webview.show('A');
    expect(impl.panel).not.toBeNull(); // 进度页已开
    impl.panel!.dispose(); // 用户关面板
    releaseA();
    await pending;
    expect(impl.panel).toBeNull(); // 旧请求作废,不替已关面板重建
  });

  it('A → 切 B → 再回 A:第二次 A 现算(激活期缓存只服务每个实体首次打开)', async () => {
    const controller = new BackgroundWarmupController({
      stages: [
        stage('flow', '流程图', async ctx => {
          ctx.publish('flowGraph:A', flowGraphOf('A', 1));
          ctx.publish('flowGraph:B', flowGraphOf('B', 1));
        }, ['flowGraph:A', 'flowGraph:B'])
      ],
      workspaceState: emptyState,
      generation: 'g'
    });
    controller.start();
    await controller.artifact('flowGraph:A');

    const webview = new EntityFlowWebView({} as unknown as vscode.ExtensionContext, controller);
    const impl = flowInternalsEx(webview);
    let builds = 0;
    impl.buildGraph = entityName => {
      builds += 1;
      return flowGraphOf(entityName, 99);
    };

    await webview.show('A');
    expect(builds).toBe(0);
    expect(impl.currentGraph?.stats.properties).toBe(1);
    await webview.show('B');
    expect(builds).toBe(0);
    await webview.show('A');
    expect(builds).toBe(1); // 已出过图的键不再吃缓存
    expect(impl.currentGraph?.stats.properties).toBe(99);
  });

  it('流程图同一实体再次 show:缓存不接管,现算取最新', async () => {
    const controller = new BackgroundWarmupController({
      stages: [
        stage('flow', '流程图', async ctx => { ctx.publish('flowGraph:Hero', flowGraph()); }, ['flowGraph:Hero'])
      ],
      workspaceState: emptyState,
      generation: 'g'
    });
    controller.start();
    await controller.artifact('flowGraph:Hero');

    const webview = new EntityFlowWebView({} as unknown as vscode.ExtensionContext, controller);
    const impl = flowInternals(webview);
    let builds = 0;
    impl.buildGraph = () => {
      builds += 1;
      const fresh = flowGraph();
      return { ...fresh, stats: { ...fresh.stats, properties: 99 } };
    };

    await webview.show('Hero');
    expect(builds).toBe(0); // 首开吃缓存
    expect(impl.currentGraph?.stats.properties).toBe(0);

    await webview.show('Hero');
    expect(builds).toBe(1); // 已有图在屏 → 现算
    expect(impl.currentGraph?.stats.properties).toBe(99);
  });
});

