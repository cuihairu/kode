import type * as vscode from 'vscode';
import { describe, expect, it } from 'vitest';
import {
  DependencyType,
  EntityType
} from '../src/entityDependency';
import type { DependencyGraph } from '../src/entityDependency';
import { EntityDependencyWebView } from '../src/entityDependencyWebView';

// EntityDependencyWebView 的纯图渲染:mermaid 生成与 webview HTML 骨架。
// 面板生命周期/导出(截图、文件写入)依赖真实 vscode.WebviewPanel,
// 不在纯逻辑测试域。私有方法经实例直调,零 mock。

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
    generateMermaidGraph: (graph: DependencyGraph) => string;
    getWebviewContent: (mermaidGraph: string, graph: DependencyGraph) => string;
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

describe('EntityDependencyWebView.generateMermaidGraph', () => {
  it('renders nodes with type emoji labels and dedash ids', () => {
    const impl = internals(makeWebView());
    const mermaid = impl.generateMermaidGraph(graph({
      nodes: [
        { name: 'Hero', defFile: 'Hero.def', types: [EntityType.Base, EntityType.Cell, EntityType.Client] },
        { name: 'Monster-Npc', defFile: 'Monster-Npc.def', types: [EntityType.Cell] }
      ]
    }));

    // 节点 id 把 '-' 替换为 '_',标签带类型 emoji
    expect(mermaid).toContain('  Hero["🔵🟢🟡 Hero"]');
    expect(mermaid).toContain('  Monster_Npc["🟢 Monster-Npc"]');
  });

  it('renders every edge as an arrow with its label', () => {
    const impl = internals(makeWebView());
    const mermaid = impl.generateMermaidGraph(graph({
      nodes: [
        { name: 'Hero', defFile: 'Hero.def', types: [EntityType.Base] },
        { name: 'Avatar', defFile: 'Avatar.def', types: [] }
      ],
      edges: [
        { from: 'Hero', to: 'Avatar', type: DependencyType.Inheritance, label: 'parent' },
        { from: 'Hero', to: 'Avatar', type: DependencyType.Array, label: '' }
      ]
    }));

    expect(mermaid).toContain('  Hero -->|parent| Avatar');
    // 空标签渲染为空管道段
    expect(mermaid).toContain('  Hero -->|| Avatar');
  });

  it('appends class defs and class assignments by entity types', () => {
    const impl = internals(makeWebView());
    const mermaid = impl.generateMermaidGraph(graph({
      nodes: [
        { name: 'Hero', defFile: 'Hero.def', types: [EntityType.Base, EntityType.Client] },
        { name: 'Ghost', defFile: 'Ghost.def', types: [EntityType.Cell] },
        { name: 'Empty', defFile: 'Empty.def', types: [] }
      ]
    }));

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
    const mermaid = impl.generateMermaidGraph(graph());

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
    const mermaid = impl.generateMermaidGraph(full);
    const html = impl.getWebviewContent(mermaid, full);

    expect(html).toContain('graph TD');
    expect(html).toContain('Hero');
    expect(html).toContain('parent');
    // webview 脚本按实现现状直接内嵌 mermaid 源码字符串
    expect(html).toContain('mermaid');
  });
});
