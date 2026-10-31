import type * as vscode from 'vscode';
import { describe, expect, it } from 'vitest';
import {
  DependencyType,
  EntityType
} from '../src/entityDependency';
import type { DependencyGraph } from '../src/entityDependency';
import type { DependencyGraphRust } from '../src/dependencyGraphRust';
import {
  EntityDependencyWebView,
  normalizeDependencyGraph,
  normalizeRustGraph
} from '../src/entityDependencyWebView';
import type { RenderGraph } from '../src/entityDependencyWebView';

// EntityDependencyWebView 的纯图渲染:mermaid 生成与 webview HTML 骨架。
// 面板生命周期/导出(截图、文件写入)依赖真实 vscode.WebviewPanel,
// 不在纯逻辑测试域。私有方法经实例直调,零 mock。
//
// IDE-RUST-007:渲染层两源归一(RenderGraph)。TS 兜底源输出与迁移前逐字节
// 一致(空图精确相等、Hero -->|| Avatar 空标签管道段);Rust 源按节点 kind
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
    getWebviewContent: (mermaidGraph: string, graph: RenderGraph) => string;
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
    // 空标签渲染为空管道段
    expect(mermaid).toContain('  Hero -->|| Avatar');
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
    expect(mermaid).toContain('classDef baseNode fill:#e1f5fe,stroke:#01579b,stroke-width:2px;');
    expect(mermaid).toContain('classDef cellNode fill:#e8f5e9,stroke:#1b5e20,stroke-width:2px;');
    expect(mermaid).toContain('classDef clientNode fill:#fffde7,stroke:#f57f17,stroke-width:2px;');
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
      '  classDef baseNode fill:#e1f5fe,stroke:#01579b,stroke-width:2px;',
      '  classDef cellNode fill:#e8f5e9,stroke:#1b5e20,stroke-width:2px;',
      '  classDef clientNode fill:#fffde7,stroke:#f57f17,stroke-width:2px;',
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

    expect(mermaid).toContain('  entity_Hero -- def_Hero');
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

    expect(mermaid).toContain('classDef entityNode fill:#e1f5fe,stroke:#01579b,stroke-width:2px;');
    expect(mermaid).toContain('classDef defNode fill:#f3e5f5,stroke:#6a1b9a,stroke-width:2px;');
    expect(mermaid).toContain('classDef interfaceNode fill:#e0f7fa,stroke:#006064,stroke-width:2px;');
    expect(mermaid).toContain('classDef componentNode fill:#fff3e0,stroke:#e65100,stroke-width:2px;');
    expect(mermaid).toContain('classDef typeNode fill:#e8eaf6,stroke:#283593,stroke-width:2px;');
    expect(mermaid).toContain('classDef pythonNode fill:#e0f2f1,stroke:#004d40,stroke-width:2px;');
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
    const html = impl.getWebviewContent(mermaid, render);

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
    const html = impl.getWebviewContent(mermaid, render);

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
