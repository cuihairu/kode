// EntityDependencyWebView UI 重设计(UI-05):
// - 统计卡按业务域分组(图结构/定义源;继承结构/引用热点;规模/质量),
//   组头可折叠 + 计数(与 monitoring 同一分类管理范式);
// - mermaid classDef 从亮色节点换深色主题(原型 #gph 色板),图例与
//   classDef 一一对应;
// - 面板接入 webviewTheme token,统计/徽标文案走字符串表(zh/en)。
import { beforeEach, describe, expect, it } from 'vitest';
import { configurationOverrides, envState } from './helpers/vscodeStub';

// getWebviewContent 为私有,经装配好的面板实例直取 html;graph 走最小
// RenderGraph 形状(rust 源),不触发真实扫描。
import { EntityDependencyWebView } from '../src/entityDependencyWebView';

const makePanel = () =>
  new EntityDependencyWebView({} as unknown as import('vscode').ExtensionContext);

const internals = (panel: EntityDependencyWebView) =>
  panel as unknown as {
    getWebviewContent: (
      mermaidGraph: string,
      graph: unknown,
      callGraph: unknown,
      rustUnavailable: boolean
    ) => string;
  };

const rustGraph = {
  source: 'rust',
  stats: {
    nodeCount: 26,
    edgeCount: 41,
    entityCount: 12,
    defCount: 8,
    interfaceCount: 3,
    componentCount: 4,
    typeCount: 6,
    pythonCount: 9
  },
  paths: {
    entitiesXml: '/ws/entities.xml',
    defsRoot: '/ws/entity_defs',
    typesXml: '/ws/types.xml'
  },
  nodes: [],
  edges: [],
  legend: []
};

const render = (mermaidGraph = 'graph Digraph {}'): string =>
  internals(makePanel()).getWebviewContent(mermaidGraph, rustGraph, null, false);

beforeEach(() => {
  configurationOverrides.delete('kbengine');
  envState.language = 'zh-cn';
});

describe('EntityDependencyWebView 分类管理重设计', () => {
  it('统计卡按业务域分组:图结构/定义源,组头可折叠 + 计数', () => {
    const html = render();
    expect(html).toContain('<details class="stat-group"');
    expect(html).toContain('data-domain="graph"');
    expect(html).toContain('data-domain="defs"');
    expect(html).toContain('图结构');
    expect(html).toContain('定义源');
    // graph 组 2 项(节点/边),defs 组 6 项
    expect(html).toContain('data-count="2"');
    expect(html).toContain('data-count="6"');
  });
});

describe('EntityDependencyWebView 深色主题与图例对齐', () => {
  it('mermaid classDef 使用原型深色节点色板', () => {
    const html = render('graph TD\\n  classDef entityNode fill:#173a5e,stroke:#3794ff,stroke-width:2px;\\n  classDef cellNode fill:#1d3a2a,stroke:#89d185,stroke-width:2px;');
    expect(html).toContain('fill:#173a5e,stroke:#3794ff');
    expect(html).toContain('fill:#1d3a2a,stroke:#89d185');
    expect(html).not.toContain('fill:#e1f5fe');
    expect(html).not.toContain('fill:#f3e5f5');
  });

  it('图例色点与 classDef 对齐', () => {
    const html = render();
    expect(html).toContain('background-color: #173a5e');
  });
});

describe('EntityDependencyWebView 设计系统与 i18n', () => {
  it('token 进面板', () => {
    const html = render();
    expect(html).toContain('--kode-ok:#89d185');
    expect(html).toContain('--kode-accent:#3794ff');
  });

  it('zh:统计标签沿用现有中文文案', () => {
    const html = render();
    expect(html).toContain('节点');
    expect(html).toContain('实体');
    expect(html).toContain('接口');
  });

  it('en:统计标签与分组本地化', () => {
    configurationOverrides.set('kbengine', { webviewLocale: 'en' });
    const html = render();
    expect(html).toContain('Graph structure');
    expect(html).toContain('Definition sources');
    expect(html).toContain('Nodes');
    expect(html).not.toContain('图结构');
  });
});
