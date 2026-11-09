import type * as vscode from 'vscode';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CancellationToken,
  CancellationTokenSource,
  Uri
} from './fake-vscode/core';
import {
  workspace as stubWorkspace,
  workspaceState,
  memoryFileSystem
} from './fake-vscode/workspaceState';
import { messages, windowState } from './fake-vscode/windowState';
import {
  DependencyType,
  EntityType
} from '../src/entityDependency';
import type { DependencyGraph } from '../src/entityDependency';
import type { DependencyGraphRust } from '../src/backend/dependencyGraphRust';
import {
  EntityDependencyWebView,
  normalizeDependencyGraph,
  normalizeRustGraph,
  normalizeCallGraph,
  renderCallGraphMermaid
} from '../src/entityDependencyWebView';
import {
  CALLGRAPH_MAX_FILES
} from '../src/entityDependencyWebView';
import type {
  RenderGraph,
  CallGraphGraph,
  CollectedPythonFiles
} from '../src/entityDependencyWebView';
import type { PythonCallGraphRustResult } from '../src/backend/pythonCallGraphRust';

// EntityDependencyWebView 的纯图渲染:mermaid 生成与 webview HTML 骨架。
// 面板生命周期/导出(截图、文件写入)依赖真实 vscode.WebviewPanel,
// 不在纯逻辑测试域。私有方法经实例直调,零 mock。
//
// IDE-RUST-007:渲染层两源归一(RenderGraph)。TS 兜底源输出与迁移前逐字节
// 一致(空图精确相等、空标签边省略管道段);Rust 源按节点 kind
// 分 emoji/classDef、按边 kind 分箭头、id 清洗(entity:Hero→entity_Hero、
// python 路径整体清洗、撞名消解)、click 跳转、三关键路径与来源徽章。

const makeWebView = () =>
  new EntityDependencyWebView(
    {} as unknown as vscode.ExtensionContext,
    {
      appendLine: () => undefined,
      show: () => undefined,
      dispose: () => undefined
    } as unknown as vscode.OutputChannel
  );

const internals = (webview: EntityDependencyWebView) =>
  webview as unknown as {
    generateMermaidGraph: (graph: RenderGraph) => string;
    getWebviewContent: (
      mermaidGraph: string,
      graph: RenderGraph | null,
      callGraph: CallGraphGraph | null,
      rustUnavailable: boolean
    ) => string;
    mode: 'dependency' | 'callgraph';
  };

const graph = (over: Partial<DependencyGraph> = {}): DependencyGraph => ({
  nodes: [],
  edges: [],
  stats: {
    totalEntities: 0,
    baseEntities: 0,
    cellEntities: 0,
    clientEntities: 0,
    maxDepth: 0,
    mostReferenced: ''
  },
  ...over
});

const rustGraph = (): DependencyGraphRust => ({
  nodes: [
    { id: 'entity:Hero', kind: 'entity', name: 'Hero', filePath: '/ws/scripts/entities.xml', types: ['Base', 'Cell', 'Client'] },
    { id: 'def:Hero', kind: 'def', name: 'Hero', filePath: '/ws/scripts/entity_defs/Hero.def' },
    { id: 'def:Monster', kind: 'def', name: 'Monster', filePath: '/ws/scripts/entity_defs/Monster.def' },
    { id: 'interface:IMove', kind: 'interface', name: 'IMove', filePath: '/ws/scripts/entity_defs/interfaces/IMove.def' },
    { id: 'component:CWeapon', kind: 'component', name: 'CWeapon', filePath: '/ws/scripts/entity_defs/components/CWeapon.def' },
    { id: 'type:Vec3', kind: 'type', name: 'Vec3', filePath: '/ws/scripts/entity_defs/types.xml' },
    { id: 'python:/ws/scripts/base/Hero.py', kind: 'python', name: 'Hero.py', filePath: '/ws/scripts/base/Hero.py' },
    { id: 'python:/ws/scripts/types/Vec3.py', kind: 'python', name: 'Vec3.py', filePath: '/ws/scripts/types/Vec3.py' }
  ],
  edges: [
    { from: 'entity:Hero', to: 'def:Hero', kind: 'registration' },
    { from: 'def:Hero', to: 'def:Monster', kind: 'inheritance' },
    { from: 'def:Hero', to: 'interface:IMove', kind: 'is-a' },
    { from: 'def:Hero', to: 'component:CWeapon', kind: 'has-a', label: 'weapon' },
    { from: 'def:Hero', to: 'type:Vec3', kind: 'property-type', label: 'pos' },
    { from: 'type:Vec3', to: 'python:/ws/scripts/types/Vec3.py', kind: 'implements' },
    { from: 'def:Hero', to: 'python:/ws/scripts/base/Hero.py', kind: 'method-impl' }
  ],
  reverseEdges: {},
  paths: {
    entitiesXml: '/ws/scripts/entities.xml',
    defsRoot: '/ws/scripts/entity_defs',
    typesXml: '/ws/scripts/entity_defs/types.xml'
  },
  stats: {
    nodeCount: 8,
    edgeCount: 7,
    entityCount: 1,
    defCount: 2,
    interfaceCount: 1,
    componentCount: 1,
    typeCount: 1,
    pythonCount: 2
  }
});

describe('EntityDependencyWebView.generateMermaidGraph(TS 兜底源)', () => {
  it('renders nodes with type emoji labels and dedash ids', () => {
    const impl = internals(makeWebView());
    const mermaid = impl.generateMermaidGraph(normalizeDependencyGraph(graph({
      nodes: [
        { name: 'Hero', defFile: 'Hero.def', types: [EntityType.Base, EntityType.Cell, EntityType.Client] },
        { name: 'Monster-Npc', defFile: 'Monster-Npc.def', types: [EntityType.Cell] }
      ]
    })));

    // 节点 id 把 '-' 替换为 '_',标签带类型 emoji
    expect(mermaid).toContain('  Hero["🔵🟢🟡 Hero"]');
    expect(mermaid).toContain('  Monster_Npc["🟢 Monster-Npc"]');
  });

  it('renders every edge as an arrow with its label', () => {
    const impl = internals(makeWebView());
    const mermaid = impl.generateMermaidGraph(normalizeDependencyGraph(graph({
      nodes: [
        { name: 'Hero', defFile: 'Hero.def', types: [EntityType.Base] },
        { name: 'Avatar', defFile: 'Avatar.def', types: [] }
      ],
      edges: [
        { from: 'Hero', to: 'Avatar', type: DependencyType.Inheritance, label: 'parent' },
        { from: 'Hero', to: 'Avatar', type: DependencyType.Array, label: '' }
      ]
    })));

    expect(mermaid).toContain('  Hero -->|parent| Avatar');
    // 空标签不输出管道段(mermaid 12 对 `-->||` 报语法错,整图渲染失败)
    expect(mermaid).toContain('  Hero --> Avatar');
    expect(mermaid).not.toContain('||');
  });

  it('appends class defs and class assignments by entity types', () => {
    const impl = internals(makeWebView());
    const mermaid = impl.generateMermaidGraph(normalizeDependencyGraph(graph({
      nodes: [
        { name: 'Hero', defFile: 'Hero.def', types: [EntityType.Base, EntityType.Client] },
        { name: 'Ghost', defFile: 'Ghost.def', types: [EntityType.Cell] },
        { name: 'Empty', defFile: 'Empty.def', types: [] }
      ]
    })));

    expect(mermaid.startsWith('graph TD\n')).toBe(true);
    expect(mermaid).toContain('classDef baseNode fill:#173a5e,stroke:#3794ff,stroke-width:2px;');
    expect(mermaid).toContain('classDef cellNode fill:#1d3a2a,stroke:#89d185,stroke-width:2px;');
    expect(mermaid).toContain('classDef clientNode fill:#3a2d10,stroke:#cca700,stroke-width:2px;');
    expect(mermaid).toContain('  class Hero baseNode;');
    expect(mermaid).toContain('  class Hero clientNode;');
    expect(mermaid).not.toContain('  class Hero cellNode');
    expect(mermaid).toContain('  class Ghost cellNode;');
    // 无类型节点不分配任何 class
    expect(mermaid).not.toContain('  class Empty ');
  });

  it('renders an empty graph as the bare header with class defs only', () => {
    const impl = internals(makeWebView());
    const mermaid = impl.generateMermaidGraph(normalizeDependencyGraph(graph()));

    expect(mermaid).toBe([
      'graph TD',
      '',
      '  classDef baseNode fill:#173a5e,stroke:#3794ff,stroke-width:2px;',
      '  classDef cellNode fill:#1d3a2a,stroke:#89d185,stroke-width:2px;',
      '  classDef clientNode fill:#3a2d10,stroke:#cca700,stroke-width:2px;',
      ''
    ].join('\n'));
  });
});

describe('EntityDependencyWebView.generateMermaidGraph(Rust 核心源)', () => {
  it('sanitizes kind-qualified ids and renders kind emoji labels', () => {
    const impl = internals(makeWebView());
    const mermaid = impl.generateMermaidGraph(normalizeRustGraph(rustGraph()));

    // id 清洗:entity:Hero→entity_Hero,python 路径整体清洗
    expect(mermaid).toContain('  entity_Hero["🔵🟢🟡 Hero"]');
    expect(mermaid).toContain('  def_Hero["📄 Hero"]');
    expect(mermaid).toContain('  interface_IMove["🧩 IMove"]');
    expect(mermaid).toContain('  component_CWeapon["⚙️ CWeapon"]');
    expect(mermaid).toContain('  type_Vec3["🧬 Vec3"]');
    expect(mermaid).toContain('  python__ws_scripts_base_Hero_py["🐍 Hero.py"]');
  });

  it('renders each edge kind with its dedicated arrow', () => {
    const impl = internals(makeWebView());
    const mermaid = impl.generateMermaidGraph(normalizeRustGraph(rustGraph()));

    expect(mermaid).toContain('  entity_Hero --- def_Hero');
    expect(mermaid).toContain('  def_Hero --> def_Monster');
    expect(mermaid).toContain('  def_Hero -.-> interface_IMove');
    expect(mermaid).toContain('  def_Hero --o|weapon| component_CWeapon');
    expect(mermaid).toContain('  def_Hero -->|pos| type_Vec3');
    expect(mermaid).toContain('  type_Vec3 ==> python__ws_scripts_types_Vec3_py');
    expect(mermaid).toContain('  def_Hero -.-> python__ws_scripts_base_Hero_py');
  });

  it('adds per-kind class defs, class assignments and click directives', () => {
    const impl = internals(makeWebView());
    const mermaid = impl.generateMermaidGraph(normalizeRustGraph(rustGraph()));

    expect(mermaid).toContain('classDef entityNode fill:#173a5e,stroke:#3794ff,stroke-width:2px;');
    expect(mermaid).toContain('classDef defNode fill:#243a44,stroke:#75beff,stroke-width:2px;');
    expect(mermaid).toContain('classDef interfaceNode fill:#103a35,stroke:#4ec9b0,stroke-width:2px;');
    expect(mermaid).toContain('classDef componentNode fill:#2d1d3a,stroke:#c586c0,stroke-width:2px;');
    expect(mermaid).toContain('classDef typeNode fill:#3a2d10,stroke:#cca700,stroke-width:2px;');
    expect(mermaid).toContain('classDef pythonNode fill:#1d3a2a,stroke:#89d185,stroke-width:2px;');
    expect(mermaid).toContain('  class entity_Hero entityNode;');
    expect(mermaid).toContain('  class type_Vec3 typeNode;');
    expect(mermaid).toContain('  class python__ws_scripts_base_Hero_py pythonNode;');
    // click 跳转:节点 id + openFilePath 回调 + 文件路径
    expect(mermaid).toContain('  click entity_Hero openFilePath "/ws/scripts/entities.xml"');
    expect(mermaid).toContain('  click def_Hero openFilePath "/ws/scripts/entity_defs/Hero.def"');
    expect(mermaid).toContain('  click python__ws_scripts_base_Hero_py openFilePath "/ws/scripts/base/Hero.py"');
    // 规范序:entityNode 先于 defNode
    expect(mermaid.indexOf('classDef entityNode')).toBeLessThan(mermaid.indexOf('classDef defNode'));
  });

  it('dedupes sanitized id collisions with a numeric suffix', () => {
    const impl = internals(makeWebView());
    const g = rustGraph();
    // 'entity-Hero' 清洗后与 'entity:Hero' 同为 entity_Hero → 撞名消解
    g.nodes.push({
      id: 'entity-Hero',
      kind: 'entity',
      name: 'Hero2',
      filePath: '/other/entities.xml',
      types: ['Base']
    });
    const mermaid = impl.generateMermaidGraph(normalizeRustGraph(g));

    expect(mermaid).toContain('  entity_Hero_2["🔵 Hero2"]');
  });
});

describe('EntityDependencyWebView.getWebviewContent', () => {
  it('embeds the mermaid graph and entity names into the html shell', () => {
    const impl = internals(makeWebView());
    const full = graph({
      nodes: [
        { name: 'Hero', defFile: 'Hero.def', types: [EntityType.Base] },
        { name: 'Avatar', defFile: 'Avatar.def', types: [EntityType.Cell] }
      ],
      edges: [
        { from: 'Hero', to: 'Avatar', type: DependencyType.Inheritance, label: 'parent' }
      ],
      stats: {
        totalEntities: 2,
        baseEntities: 1,
        cellEntities: 1,
        clientEntities: 0,
        maxDepth: 2,
        mostReferenced: 'Avatar'
      }
    });
    const render = normalizeDependencyGraph(full);
    const mermaid = impl.generateMermaidGraph(render);
    const html = impl.getWebviewContent(mermaid, render, null, false);

    expect(html).toContain('graph TD');
    expect(html).toContain('Hero');
    expect(html).toContain('parent');
    // webview 脚本按实现现状直接内嵌 mermaid 源码字符串
    expect(html).toContain('mermaid');
    // TS 兜底徽章与六张 legacy 统计卡
    expect(html).toContain('TS 兜底');
    expect(html).toContain('总实体数');
    expect(html).toContain('最常引用');
  });

  it('badges the rust source, lists the three key paths and kind stats', () => {
    const impl = internals(makeWebView());
    const render = normalizeRustGraph(rustGraph());
    const mermaid = impl.generateMermaidGraph(render);
    const html = impl.getWebviewContent(mermaid, render, null, false);

    expect(html).toContain('Rust 核心');
    expect(html).not.toContain('TS 兜底');
    // 三关键路径(实体文件/def 根/types.xml)
    expect(html).toContain('entities.xml');
    expect(html).toContain('/ws/scripts/entity_defs');
    expect(html).toContain('/ws/scripts/entity_defs/types.xml');
    // 分 kind 计数卡
    expect(html).toContain('Python');
    expect(html).toContain('接口');
    // 节点点击回调注册
    expect(html).toContain('openFilePath');
  });
});

// ---------------------------------------------------------------------------
// C-20 callgraph 模式:normalizeCallGraph / renderCallGraphMermaid / 模式壳
// ---------------------------------------------------------------------------

const callGraphRust = (): PythonCallGraphRustResult => ({
  nodes: [
    { id: 'Avatar.act', kind: 'method', className: 'Avatar', name: 'act', filePath: '/ws/scripts/cell/Avatar.py', line: 1, isAsync: false, params: ['self'] },
    { id: 'Avatar.notify', kind: 'method', className: 'Avatar', name: 'notify', filePath: '/ws/scripts/cell/Avatar.py', line: 3, isAsync: false, params: ['self'] },
    { id: 'Avatar::helper', kind: 'function', name: 'helper', filePath: '/ws/scripts/cell/Avatar.py', line: 5, isAsync: false, params: ['x'] }
  ],
  edges: [
    { caller: 'act', callerClass: 'Avatar', callerLine: 2, callee: 'notify', receiver: 'self', kind: 'self-method', filePath: '/ws/scripts/cell/Avatar.py' },
    { caller: 'act', callerClass: 'Avatar', callerLine: 2, callee: 'helper', kind: 'local', filePath: '/ws/scripts/cell/Avatar.py' },
    { caller: 'act', callerClass: 'Avatar', callerLine: 4, callee: 'onDamage', receiver: 'allClients', kind: 'kbe-broadcast', filePath: '/ws/scripts/cell/Avatar.py' },
    { caller: 'act', callerClass: 'Avatar', callerLine: 5, callee: 'recalc', receiver: 'cell', kind: 'kbe-cross-process', filePath: '/ws/scripts/cell/Avatar.py' },
    { caller: 'act', callerClass: 'Avatar', callerLine: 6, callee: 'log', receiver: 'KBEngine', kind: 'kbe-api', filePath: '/ws/scripts/cell/Avatar.py' },
    { caller: 'act', callerClass: 'Avatar', callerLine: 7, callee: 'use', receiver: 'tool', kind: 'method', filePath: '/ws/scripts/cell/Avatar.py' },
    { caller: 'act', callerClass: 'Avatar', callerLine: 8, callee: 'unknownFn', kind: 'unknown', filePath: '/ws/scripts/cell/Avatar.py' },
    { caller: '<module>', callerLine: 9, callee: 'standalone', kind: 'local', filePath: '/ws/scripts/cell/Avatar.py' }
  ],
  reverseIndex: { '/ws/scripts/cell/Avatar.py': [] },
  dataflow: [],
  processRoles: ['cellapp', 'baseapp'],
  stats: {
    fileCount: 1,
    nodeCount: 3,
    edgeCount: 8,
    dataflowCount: 0,
    errorCount: 0,
    byKind: { 'self-method': 1, local: 2, 'kbe-broadcast': 1, 'kbe-cross-process': 1, 'kbe-api': 1, method: 1, unknown: 1 }
  }
});

describe('EntityDependencyWebView.callgraph mode(normalizeCallGraph)', () => {
  it('resolves self-method and local callees to existing nodes, never drops a call edge', () => {
    const graph = normalizeCallGraph(callGraphRust());
    // 全部 8 条边都保留
    expect(graph.edges).toHaveLength(8);
    // self-method → Avatar.notify(已存在节点,不补 stub)
    const selfEdge = graph.edges.find((e) => e.kind === 'self-method')!;
    expect(selfEdge.to).toBe('Avatar.notify');
    expect(graph.nodes.some((n) => n.id === 'Avatar.notify')).toBe(true);
    // local(act→helper) → Avatar::helper(已存在)
    const localEdge = graph.edges.find((e) => e.kind === 'local' && e.from === 'Avatar.act')!;
    expect(localEdge.to).toBe('Avatar::helper');
    expect(graph.nodes.some((n) => n.id === 'Avatar::helper')).toBe(true);
  });

  it('stubs unresolved external callees (ext:/kbe: prefixes) without losing the call site', () => {
    const graph = normalizeCallGraph(callGraphRust());
    // kbe-broadcast → kbe:onDamage(外部 stub)
    expect(graph.edges.find((e) => e.kind === 'kbe-broadcast')!.to).toBe('kbe:onDamage');
    // kbe-cross-process → kbe:recalc
    expect(graph.edges.find((e) => e.kind === 'kbe-cross-process')!.to).toBe('kbe:recalc');
    // kbe-api → kbe:log
    expect(graph.edges.find((e) => e.kind === 'kbe-api')!.to).toBe('kbe:log');
    // method(receiver tool) → ext:tool.use
    expect(graph.edges.find((e) => e.kind === 'method')!.to).toBe('ext:tool.use');
    // unknown → ext:unknownFn
    expect(graph.edges.find((e) => e.kind === 'unknown')!.to).toBe('ext:unknownFn');
    // 每个 stub 节点都是 external kind
    for (const id of ['kbe:onDamage', 'kbe:recalc', 'kbe:log', 'ext:tool.use', 'ext:unknownFn']) {
      expect(graph.nodes.find((n) => n.id === id)?.kind).toBe('external');
    }
    // module 顶层调用 → <module> 伪节点,从为文件 stem
    const moduleEdge = graph.edges.find((e) => e.from === 'Avatar')!;
    expect(moduleEdge).toBeTruthy();
    expect(moduleEdge.to).toBe('Avatar::standalone');
  });

  it('propagates stats and process roles', () => {
    const graph = normalizeCallGraph(callGraphRust());
    expect(graph.stats.fileCount).toBe(1);
    expect(graph.stats.nodeCount).toBeGreaterThan(3);
    expect(graph.stats.edgeCount).toBe(8);
    expect(graph.processRoles).toEqual(['cellapp', 'baseapp']);
    expect(graph.source).toBe('rust');
  });
});

describe('EntityDependencyWebView.callgraph mode(renderCallGraphMermaid)', () => {
  it('renders kind-specific arrows, classDefs, clicks and sanitized ids', () => {
    const graph = normalizeCallGraph(callGraphRust());
    const mermaid = renderCallGraphMermaid(graph);

    expect(mermaid.startsWith('graph TD\n')).toBe(true);
    // 节点 id 清洗:Avatar.act → Avatar_act
    expect(mermaid).toContain('  Avatar_act["🔧 act"]');
    // 自方法箭头 -.->;kbe 广播 ==>
    expect(mermaid).toContain('  Avatar_act -.-> Avatar_notify');
    expect(mermaid).toContain('  Avatar_act ==> kbe_onDamage');
    // classDef 按出现 kind 规范序(method/function/module/external)
    expect(mermaid).toContain('classDef methodCall fill:#173a5e,stroke:#3794ff,stroke-width:2px;');
    expect(mermaid).toContain('classDef externalCall fill:#333333,stroke:#808080,stroke-width:1px,stroke-dasharray:3 3');
    expect(mermaid).toContain('  class Avatar_act methodCall;');
    expect(mermaid).toContain('  class kbe_onDamage externalCall;');
    // click 跳转:节点 + openFilePath + 文件路径
    expect(mermaid).toContain('  click Avatar_act openFilePath "/ws/scripts/cell/Avatar.py"');
    expect(mermaid).toContain('  click kbe_onDamage openFilePath "/ws/scripts/cell/Avatar.py"');
  });

  it('renders an empty graph as the bare header only', () => {
    const mermaid = renderCallGraphMermaid({ nodes: [], edges: [], stats: { nodeCount: 0, edgeCount: 0, fileCount: 0, errorCount: 0 }, processRoles: [], source: 'rust' });
    expect(mermaid).toBe('graph TD\n\n');
  });
});

describe('EntityDependencyWebView.callgraph mode(getWebviewContent)', () => {
  it('shows callgraph stats, mode select and rust badge when graph is available', () => {
    const impl = internals(makeWebView());
    impl.mode = 'callgraph';
    const graph = normalizeCallGraph(callGraphRust());
    const mermaid = renderCallGraphMermaid(graph);
    const html = impl.getWebviewContent(mermaid, null, graph, false);

    expect(html).toContain('KBEngine Python 调用图');
    expect(html).toContain('Rust 核心');
    expect(html).toContain('调用边');
    expect(html).toContain('进程角色');
    expect(html).toContain('cellapp, baseapp');
    expect(html).toContain('<option value="callgraph" selected>');
    expect(html).toContain('setMode');
    expect(html).toContain('本地调用');
    expect(html).toContain('客户端广播');
  });

  it('shows the rust-unavailable badge and empty-graph notice when Rust is down', () => {
    const impl = internals(makeWebView());
    impl.mode = 'callgraph';
    const html = impl.getWebviewContent('', null, null, true);

    expect(html).toContain('Rust 不可用');
    expect(html).toContain('Rust 核心不可用');
    expect(html).not.toContain('classDef methodCall');
  });

  it('shows truncation warning and collected/discovered file count when over the cap', () => {
    const impl = internals(makeWebView());
    impl.mode = 'callgraph';
    const normalized = normalizeCallGraph(callGraphRust());
    const truncated: CallGraphGraph = {
      ...normalized,
      stats: { ...normalized.stats, truncated: true, totalDiscovered: 12_345 }
    };
    const mermaid = renderCallGraphMermaid(truncated);
    const html = impl.getWebviewContent(mermaid, null, truncated, false);

    // 类名 .callgraph-warning 恒在 CSS 块,须以警告文案断言(而非类名)。
    expect(html).toContain('callgraph-warning');
    expect(html).toContain('超出 10000 个 Python 文件上限');
    expect(html).toContain('（截断）');
    expect(html).toContain('12345');
    expect(html).toContain(`${CALLGRAPH_MAX_FILES}`);
  });

  it('does not show truncation warning when under the cap', () => {
    const impl = internals(makeWebView());
    impl.mode = 'callgraph';
    const graph = normalizeCallGraph(callGraphRust());
    const mermaid = renderCallGraphMermaid(graph);
    const html = impl.getWebviewContent(mermaid, null, graph, false);

    expect(html).not.toContain('超出 10000 个 Python 文件上限');
    expect(html).not.toContain('（截断）');
  });
});

// KODE 审核发现(冻结期 lane-2):refreshGraph/refreshCallGraph 在 await 后
// 未复检 this.panel 与 this.mode——面板在 RPC 在途时关闭(panel=null)会把
// TypeError 冒泡成「刷新依赖图失败」;在途 setMode 切换会把旧模式数据渲染
// 进新模式视图。修复=渲染前复检,面板没了/模式已换代即丢弃本轮旧代结果。
describe('EntityDependencyWebView.refresh 在途复检(面板关闭/模式切换不写旧代)', () => {
  const lifecycleInternals = (webview: EntityDependencyWebView) =>
    webview as unknown as {
      panel: vscode.WebviewPanel | null;
      analyzer: { analyze(): Promise<DependencyGraph> };
      refreshGraph(): Promise<void>;
      refreshCallGraph(
        generation: number,
        token: CancellationToken
      ): Promise<void>;
      collectPythonFiles(
        token?: CancellationToken
      ): Promise<CollectedPythonFiles>;
      mode: 'dependency' | 'callgraph';
      currentRender: RenderGraph | null;
      currentCallGraph: CallGraphGraph | null;
      refreshGeneration: number;
    };

  const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((resolvePromise) => {
      resolve = resolvePromise;
    });
    return { promise, resolve };
  };

  it('dependency 刷新在途面板关闭:不写入、不报「刷新依赖图失败」', async () => {
    windowState.reset();
    stubWorkspace.workspaceFolders = [];
    const webview = makeWebView();
    const impl = lifecycleInternals(webview);
    const fakePanel = { webview: { html: '' } } as unknown as vscode.WebviewPanel;
    impl.panel = fakePanel;
    const gate = deferred<DependencyGraph>();
    impl.analyzer = { analyze: () => gate.promise };

    const pending = impl.refreshGraph();
    impl.panel = null; // 面板在 RPC 在途时被关闭(onDidDispose 语义)
    gate.resolve(graph());
    await expect(pending).resolves.toBeUndefined();

    expect(fakePanel.webview.html).toBe('');
    expect(impl.currentRender).toBeNull();
    expect(messages.error).toHaveLength(0);
  });

  it('dependency 刷新在途 setMode 切到 callgraph:旧依赖图不渲染进新模式面板', async () => {
    windowState.reset();
    stubWorkspace.workspaceFolders = [];
    const webview = makeWebView();
    const impl = lifecycleInternals(webview);
    const fakePanel = { webview: { html: '' } } as unknown as vscode.WebviewPanel;
    impl.panel = fakePanel;
    const gate = deferred<DependencyGraph>();
    impl.analyzer = { analyze: () => gate.promise };

    const pending = impl.refreshGraph();
    impl.mode = 'callgraph'; // 在途切换(与新一代 refreshGraph 并发)
    gate.resolve(graph());
    await expect(pending).resolves.toBeUndefined();

    expect(fakePanel.webview.html).toBe('');
    expect(impl.currentRender).toBeNull();
    expect(messages.error).toHaveLength(0);
    stubWorkspace.workspaceFolders = [];
  });

  it('callgraph 刷新在途面板关闭:不写入、Promise 不冒泡 TypeError', async () => {
    windowState.reset();
    stubWorkspace.workspaceFolders = [{ uri: Uri.file('/ws'), name: 'ws', index: 0 }];
    const webview = makeWebView();
    const impl = lifecycleInternals(webview);
    impl.mode = 'callgraph';
    const fakePanel = { webview: { html: '' } } as unknown as vscode.WebviewPanel;
    impl.panel = fakePanel;
    const gate = deferred<CollectedPythonFiles>();
    impl.collectPythonFiles = () => gate.promise;

    // KODE-PERF-005:经 refreshGraph 走真实代际(生成 CTS + 代际自增),不直调
    // refreshCallGraph——验证写入面守卫对「面板在途关闭」的整链行为。
    const pending = impl.refreshGraph();
    impl.panel = null; // 面板在途关闭:写入面必须复检后放弃
    gate.resolve({ files: [], truncated: false, totalDiscovered: 0 });
    await expect(pending).resolves.toBeUndefined();

    expect(fakePanel.webview.html).toBe('');
    expect(impl.currentCallGraph).toBeNull();
    expect(messages.error).toHaveLength(0);
    stubWorkspace.workspaceFolders = [];
  });

  it('callgraph 刷新在途 setMode 切回 dependency:旧调用图不渲染', async () => {
    windowState.reset();
    stubWorkspace.workspaceFolders = [{ uri: Uri.file('/ws'), name: 'ws', index: 0 }];
    const webview = makeWebView();
    const impl = lifecycleInternals(webview);
    impl.mode = 'callgraph';
    const fakePanel = { webview: { html: '' } } as unknown as vscode.WebviewPanel;
    impl.panel = fakePanel;
    const gate = deferred<CollectedPythonFiles>();
    impl.collectPythonFiles = () => gate.promise;

    const pending = impl.refreshGraph();
    impl.mode = 'dependency'; // 在途切换:旧调用图结果丢弃
    gate.resolve({ files: [], truncated: false, totalDiscovered: 0 });
    await expect(pending).resolves.toBeUndefined();

    expect(fakePanel.webview.html).toBe('');
    expect(impl.currentCallGraph).toBeNull();
    expect(messages.error).toHaveLength(0);
    stubWorkspace.workspaceFolders = [];
  });

  it('callgraph 同模式并发刷新:旧代结果不覆盖新代(写入面代际守卫)', async () => {
    windowState.reset();
    stubWorkspace.workspaceFolders = [{ uri: Uri.file('/ws'), name: 'ws', index: 0 }];
    const webview = makeWebView();
    const impl = lifecycleInternals(webview);
    impl.mode = 'callgraph';
    // 写入记账:每次 html 赋值入栈,便于断言「旧代被取代后不再写」。
    const writes: string[] = [];
    const fakePanel = {
      webview: {
        get html() {
          return writes[writes.length - 1] ?? '';
        },
        set html(value: string) {
          writes.push(value);
        }
      }
    } as unknown as vscode.WebviewPanel;
    impl.panel = fakePanel;
    // 每次 collectPythonFiles 返回新 gate,代际各自在途(旧码无代际,两会写)。
    const gates: Array<{
      promise: Promise<CollectedPythonFiles>;
      resolve: (value: CollectedPythonFiles) => void;
    }> = [];
    impl.collectPythonFiles = () => {
      const gate = deferred<CollectedPythonFiles>();
      gates.push(gate);
      return gate.promise;
    };

    const first = impl.refreshGraph(); // 代 1:collect 在途 gates[0]
    const second = impl.refreshGraph(); // 代 2:取消代 1,collect 在途 gates[1]
    gates[1].resolve({ files: [], truncated: false, totalDiscovered: 0 });
    await second;
    gates[0].resolve({ files: [], truncated: false, totalDiscovered: 0 });
    await first;

    // 关键断言:仅最新代(代 2)写入,旧代(代 1)被取代后结果整体弃置。
    expect(writes).toHaveLength(1);
    stubWorkspace.workspaceFolders = [];
  });

  it('callgraph 收集在途被取消:不再发 RPC、不写入(代际 token 守卫)', async () => {
    windowState.reset();
    stubWorkspace.workspaceFolders = [{ uri: Uri.file('/ws'), name: 'ws', index: 0 }];
    const webview = makeWebView();
    const impl = lifecycleInternals(webview);
    impl.mode = 'callgraph';
    const fakePanel = { webview: { html: '' } } as unknown as vscode.WebviewPanel;
    impl.panel = fakePanel;
    // 令写入面代际守卫放行(gen===refreshGeneration),隔离验证「收集后 token
    // 已取消 → 提前 return」这一处守卫(否则写守卫也会拦下,测不到点)。
    impl.refreshGeneration = 1;
    const cancellation = new CancellationTokenSource();
    cancellation.cancel();
    impl.collectPythonFiles = async () => ({
      files: [],
      truncated: false,
      totalDiscovered: 0
    });

    await impl.refreshCallGraph(1, cancellation.token);

    expect(fakePanel.webview.html).toBe('');
    expect(impl.currentCallGraph).toBeNull();
    expect(messages.error).toHaveLength(0);
    stubWorkspace.workspaceFolders = [];
  });
});

// KODE-PERF-004:callgraph 收集支持多 workspace 根、异步读取、超 10,000 文件
// 明确策略。旧码只取根[0]、同步 readWorkspaceTextFile 逐文件阻塞宿主、
// findFiles 静默封顶 10,000;新码遍历全部根去重、有界并发异步读、发现全量
// 按路径排序取上限并出截断标记(面板出警告条,绝不静默装完整)。
describe('EntityDependencyWebView.collectPythonFiles(KODE-PERF-004 多根/异步/截断)', () => {
  const collectInternals = (webview: EntityDependencyWebView) =>
    webview as unknown as {
      collectPythonFiles(): Promise<CollectedPythonFiles>;
    };

  beforeEach(() => {
    workspaceState.reset();
  });

  it('多 workspace 根:合并全部根 *.py,重叠文件按路径去重(旧码只取根[0])', async () => {
    stubWorkspace.workspaceFolders = [
      { uri: Uri.file('/rootA'), name: 'A', index: 0 },
      { uri: Uri.file('/rootB'), name: 'B', index: 1 }
    ];
    // 按 RelativePattern.base 分发;根B 与根A 重叠 /rootA/a.py(去重面)。
    stubWorkspace.findFiles = async (glob: unknown) => {
      const pattern = glob as { base: string | Uri; pattern: string };
      const base = typeof pattern.base === 'string' ? pattern.base : pattern.base.fsPath;
      if (base === '/rootA') return [Uri.file('/rootA/a.py'), Uri.file('/rootA/b.py')];
      if (base === '/rootB') return [Uri.file('/rootB/c.py'), Uri.file('/rootA/a.py')];
      return [];
    };
    memoryFileSystem.set('/rootA/a.py', 'x = 1');
    memoryFileSystem.set('/rootA/b.py', 'y = 2');
    memoryFileSystem.set('/rootB/c.py', 'z = 3');

    const collected = await collectInternals(makeWebView()).collectPythonFiles();
    // 重叠 a.py 只出现一次;三文件全到(多根结果完整)。
    expect(collected.files.map((f) => f.path).sort()).toEqual(
      ['/rootA/a.py', '/rootA/b.py', '/rootB/c.py'].sort()
    );
    // 内容经异步 fs.readFile 读回(非空串)——证明走异步读而非同步空串兜底。
    const byPath = new Map(collected.files.map((f) => [f.path, f.text]));
    expect(byPath.get('/rootA/a.py')).toBe('x = 1');
    expect(byPath.get('/rootA/b.py')).toBe('y = 2');
    expect(byPath.get('/rootB/c.py')).toBe('z = 3');
    expect(collected.truncated).toBe(false);
    expect(collected.totalDiscovered).toBe(3);
    stubWorkspace.workspaceFolders = [];
  });

  it('异步读失败(文件消失)回落空串,不静默丢文件计数', async () => {
    stubWorkspace.workspaceFolders = [{ uri: Uri.file('/rootA'), name: 'A', index: 0 }];
    stubWorkspace.findFiles = async () => [Uri.file('/rootA/gone.py')];
    // 不播种 memoryFiles → fs.readFile 抛 ENOENT → 回落空串。
    const collected = await collectInternals(makeWebView()).collectPythonFiles();
    expect(collected.files).toEqual([{ path: '/rootA/gone.py', text: '' }]);
    expect(collected.totalDiscovered).toBe(1);
    stubWorkspace.workspaceFolders = [];
  });

  it('超 10,000 文件:截断到上限并如实报告发现总数(明确策略,不静默)', async () => {
    stubWorkspace.workspaceFolders = [{ uri: Uri.file('/rootA'), name: 'A', index: 0 }];
    const over = CALLGRAPH_MAX_FILES + 5;
    const uris = Array.from({ length: over }, (_, i) => Uri.file(`/rootA/f${i}.py`));
    stubWorkspace.findFiles = async () => uris;

    const collected = await collectInternals(makeWebView()).collectPythonFiles();
    expect(collected.files.length).toBe(CALLGRAPH_MAX_FILES);
    expect(collected.truncated).toBe(true);
    expect(collected.totalDiscovered).toBe(over);
    stubWorkspace.workspaceFolders = [];
  });
});

it('keeps same-named methods in separate files when Rust supplies identities', () => {
  const input = callGraphRust();
  input.nodes = [
    { id: 'sym_base', kind: 'method', className: 'Avatar', name: 'act', filePath: '/base/Avatar.py', line: 1, isAsync: false, params: [] },
    { id: 'sym_cell', kind: 'method', className: 'Avatar', name: 'act', filePath: '/cell/Avatar.py', line: 1, isAsync: false, params: [] }
  ];
  input.edges = [
    { callerId: 'sym_base', calleeId: 'sym_base_target', caller: 'act', callerClass: 'Avatar', callerLine: 2, callee: 'target', kind: 'self-method', filePath: '/base/Avatar.py' },
    { callerId: 'sym_cell', calleeId: 'sym_cell_target', caller: 'act', callerClass: 'Avatar', callerLine: 2, callee: 'target', kind: 'self-method', filePath: '/cell/Avatar.py' }
  ];
  const graph = normalizeCallGraph(input);
  expect(graph.nodes.find(n => n.id === 'sym_base')?.filePath).toBe('/base/Avatar.py');
  expect(graph.nodes.find(n => n.id === 'sym_cell')?.filePath).toBe('/cell/Avatar.py');
  expect(graph.edges.map(e => [e.from, e.to])).toEqual([['sym_base', 'sym_base_target'], ['sym_cell', 'sym_cell_target']]);
});
