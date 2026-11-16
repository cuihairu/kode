import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { EntityDependencyWebView } from '../src/entityDependencyWebView';
import {
  DependencyGraph,
  DependencyType,
  EntityType
} from '../src/entityDependency';
import type * as vscode from 'vscode';
import {
  messages,
  panelRegistry,
  Uri,
  window as stubWindow
} from './helpers/vscodeStub';
import type { FakeWebviewPanel } from './helpers/vscodeStub';

// RUST-178:实体关系浏览器面板接线——show('relations') 聚焦解析(活跃编辑
// 器 .def 基名 → QuickPick 候选)、懒加载 expand 消息(未展开节点点击 →
// 重渲染子图;幂等重放零渲染)、setMode 三模式闸、空图/取消候选占位空态。
// analyzer 经 internals 替换为可控假例,面板走 fake-vscode panelRegistry。

const windowish = stubWindow as unknown as Record<string, unknown>;
const originalShowQuickPick = windowish.showQuickPick;

let analyzeImpl: () => Promise<DependencyGraph>;

const makeGraph = (): DependencyGraph => ({
  nodes: [
    {
      name: 'Hero',
      defFile: '/ws/entity_defs/Hero.def',
      types: [EntityType.Base, EntityType.Cell],
      references: [],
      referencedBy: 0
    },
    {
      name: 'Monster',
      defFile: '/ws/entity_defs/Monster.def',
      types: [EntityType.Client],
      references: [{ entityName: 'Hero', type: DependencyType.Array, propertyName: 'targets' }],
      referencedBy: 1
    }
  ],
  edges: [
    { from: 'Monster', to: 'Hero', type: DependencyType.Array, label: 'targets' }
  ],
  stats: {
    totalEntities: 2,
    baseEntities: 1,
    cellEntities: 1,
    clientEntities: 1,
    maxDepth: 1,
    mostReferenced: 'Hero'
  }
});

const makeWebView = (): EntityDependencyWebView => {
  const webview = new EntityDependencyWebView(
    { extensionUri: Uri.file('/ext/root') } as unknown as vscode.ExtensionContext,
    {
      appendLine: (): void => undefined
    } as unknown as vscode.OutputChannel
  );
  (webview as unknown as Record<string, unknown>).analyzer = {
    analyze: (): Promise<DependencyGraph> => analyzeImpl()
  };
  return webview;
};

const currentPanel = (): FakeWebviewPanel => panelRegistry.panels[panelRegistry.panels.length - 1];

const send = (message: unknown): void => {
  panelRegistry.fireMessage(currentPanel(), message);
};

const drain = async (): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, 10));
};

beforeAll(() => {
  windowish.showQuickPick = originalShowQuickPick;
});

afterAll(() => {
  windowish.showQuickPick = originalShowQuickPick;
});

afterEach(() => {
  delete (stubWindow as { activeTextEditor?: unknown }).activeTextEditor;
});

describe('entityDependencyRelations panel wiring', () => {
  it('renders relations mode with active-editor focus: expanded focus opens, unexpanded neighbor expands', async () => {
    analyzeImpl = async () => makeGraph();
    stubWindow.activeTextEditor = {
      document: { uri: Uri.file('/ws/entity_defs/Hero.def') }
    } as never;
    const webview = makeWebView();
    await webview.show('relations');
    const panel = currentPanel();
    expect(panel.title).toBe('KBEngine 实体关系浏览器');
    // 模式选择器带第三项且选中
    expect(panel.webview.html).toContain('<option value="relations" selected>');
    // 焦点 Hero 已展开 → openFilePath;Monster 未展开 → relationsExpand
    expect(panel.webview.html).toContain('click Hero openFilePath "/ws/entity_defs/Hero.def"');
    expect(panel.webview.html).toContain('click Monster relationsExpand "Monster"');
    // ts 兜底源实线箭头 + 关系子图标签 +N 徽标(徽标只在未展开节点上)
    expect(panel.webview.html).toContain('Monster -->|targets| Hero');
    expect(panel.webview.html).toContain('Monster＋1"]');
  });

  it('falls back to QuickPick when no active editor; cancel leaves placeholder empty state', async () => {
    analyzeImpl = async () => makeGraph();
    windowish.showQuickPick = async (): Promise<undefined> => undefined;
    const webview = makeWebView();
    await webview.show('relations');
    await drain();
    const html = currentPanel().webview.html;
    // 占位空态:空 mermaid 容器(无图体;JS 委托正则里的关键字字面量恒在,不作断言面)
    expect(html).toContain('<div class="mermaid">');
    expect(html).not.toContain('graph TD');
  });

  it('QuickPick selection becomes the focus (entities first among candidates)', async () => {
    analyzeImpl = async () => makeGraph();
    windowish.showQuickPick = async (): Promise<string | undefined> => 'Monster';
    const webview = makeWebView();
    await webview.show('relations');
    await drain();
    const html = currentPanel().webview.html;
    expect(html).toContain('click Monster openFilePath "/ws/entity_defs/Monster.def"');
    expect(html).toContain('click Hero relationsExpand "Hero"');
  });

  it('expand message merges the node neighborhood and re-renders the subgraph', async () => {
    analyzeImpl = async () => makeGraph();
    stubWindow.activeTextEditor = {
      document: { uri: Uri.file('/ws/entity_defs/Hero.def') }
    } as never;
    const webview = makeWebView();
    await webview.show('relations');
    await drain();
    const before = currentPanel().webview.html;
    expect(before).toContain('click Monster relationsExpand "Monster"');
    send({ command: 'expand', nodeId: 'Monster' });
    await drain();
    const after = currentPanel().webview.html;
    expect(after).toContain('click Monster openFilePath "/ws/entity_defs/Monster.def"');
    expect(after).not.toContain('click Monster relationsExpand');
    // Hero 邻接已全部可见:展开后无新 relationsExpand 节点(Hero 仍可开文件)
    expect(after).toContain('click Hero openFilePath "/ws/entity_defs/Hero.def"');
  });

  it('idempotent expand replay does not re-render', async () => {
    analyzeImpl = async () => makeGraph();
    stubWindow.activeTextEditor = {
      document: { uri: Uri.file('/ws/entity_defs/Hero.def') }
    } as never;
    const webview = makeWebView();
    await webview.show('relations');
    await drain();
    send({ command: 'expand', nodeId: 'Monster' });
    await drain();
    const once = currentPanel().webview.html;
    send({ command: 'expand', nodeId: 'Monster' });
    await drain();
    expect(currentPanel().webview.html).toBe(once);
  });

  it('setMode switches to relations and updates the title; unknown mode is ignored', async () => {
    analyzeImpl = async () => makeGraph();
    stubWindow.activeTextEditor = {
      document: { uri: Uri.file('/ws/entity_defs/Hero.def') } as never
    } as never;
    const webview = makeWebView();
    await webview.show();
    expect(currentPanel().title).toBe('KBEngine 实体依赖关系');
    send({ command: 'setMode', mode: 'relations' });
    await drain();
    expect(currentPanel().title).toBe('KBEngine 实体关系浏览器');
    expect(currentPanel().webview.html).toContain('click Hero openFilePath "/ws/entity_defs/Hero.def"');
    send({ command: 'setMode', mode: 'bogus' });
    await drain();
    expect(currentPanel().title).toBe('KBEngine 实体关系浏览器');
    expect(messages.error).toHaveLength(0);
  });

  it('empty graph renders the placeholder empty state instead of a blank panel', async () => {
    analyzeImpl = async () => ({
      nodes: [],
      edges: [],
      stats: {
        totalEntities: 0,
        baseEntities: 0,
        cellEntities: 0,
        clientEntities: 0,
        maxDepth: 0,
        mostReferenced: ''
      }
    });
    const webview = makeWebView();
    await webview.show('relations');
    await drain();
    const html = currentPanel().webview.html;
    expect(html).toContain('<div class="mermaid">');
    expect(html).not.toContain('graph TD');
  });
});
