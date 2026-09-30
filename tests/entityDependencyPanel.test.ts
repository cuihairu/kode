import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EntityDependencyWebView } from '../src/entityDependencyWebView';
import {
  DependencyGraph,
  DependencyType,
  EntityType,
  type EntityNode
} from '../src/entityDependency';
import type * as vscode from 'vscode';
import {
  messages,
  memoryFileSystem,
  panelRegistry,
  Uri,
  ViewColumn,
  window as stubWindow,
  windowState,
  workspace as stubWorkspace
} from './helpers/vscodeStub';
import type { FakeWebviewPanel } from './helpers/vscodeStub';

// EntityDependencyWebView 的面板生命周期:show/refresh 的分析→mermaid→
// html 链路、openEntityFile 的文档打开三态、exportGraph→pendingExport→
// webview.postMessage 的导出握手、saveExportedGraph 的落盘。analyzer 在
// 构造内自建,测试经 internals 替换为可控假例;面板由 fake-vscode 的
// panelRegistry 默认工厂创建(阶段 4:不再 monkey-patch 面板工厂),
// postMessage 经 webview.postedMessages 入账,消息三通道与文档展示直接
// 读 windowState 入账。mermaid 生成已由 entityDependencyWebView 既有纯
// 逻辑测试覆盖。

const saveDialogUris: Array<vscode.Uri | undefined> = [];
const openedDocuments: string[] = [];
const channelLines: string[] = [];

const windowish = stubWindow as unknown as Record<string, unknown>;
const originalShowSaveDialog = windowish.showSaveDialog;

const originalOpenTextDocument = stubWorkspace.openTextDocument;

let analyzeImpl: () => Promise<DependencyGraph>;
let entityNodes: Record<string, EntityNode>;

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

const fakeAnalyzer = () => ({
  analyze: () => analyzeImpl(),
  getEntityNode: (name: string) => entityNodes[name]
});

const makeWebView = (): EntityDependencyWebView => {
  const webview = new EntityDependencyWebView(
    { extensionUri: Uri.file('/ext/root') } as unknown as vscode.ExtensionContext,
    {
      appendLine: (line: string) => {
        channelLines.push(line);
      }
    } as unknown as vscode.OutputChannel
  );
  (webview as unknown as Record<string, unknown>).analyzer = fakeAnalyzer();
  return webview;
};

const currentPanel = (): FakeWebviewPanel =>
  panelRegistry.panels[panelRegistry.panels.length - 1];

const showOf = async (webview: EntityDependencyWebView): Promise<FakeWebviewPanel> => {
  await webview.show();
  return currentPanel();
};

const show = async (): Promise<FakeWebviewPanel> => showOf(makeWebView());

const send = (message: unknown): void => {
  panelRegistry.fireMessage(currentPanel(), message);
};

/** webview 侧收到的 postMessage 载荷序列(beginExport 握手等) */
const postedMessages = (): Array<{ command: string; format?: string }> =>
  currentPanel().webview.postedMessages.map(entry => entry.message) as Array<{
    command: string;
    format?: string;
  }>;

const until = async (predicate: () => boolean, timeoutMs = 2000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('condition not met before deadline');
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};

beforeAll(() => {
  windowish.showSaveDialog = async () => saveDialogUris.shift();
  stubWorkspace.openTextDocument = async (uri: vscode.Uri) => {
    if (String(uri.fsPath).endsWith('/Missing.def')) {
      throw new Error('cannot open');
    }
    openedDocuments.push(uri.fsPath);
    return { uri };
  };
});

afterAll(() => {
  windowish.showSaveDialog = originalShowSaveDialog;
  stubWorkspace.openTextDocument = originalOpenTextDocument;
  memoryFileSystem.reset();
});

beforeEach(() => {
  panelRegistry.reset();
  windowState.reset();
  saveDialogUris.length = 0;
  openedDocuments.length = 0;
  channelLines.length = 0;
  memoryFileSystem.reset();
  stubWorkspace.workspaceFolders = [];
  analyzeImpl = async () => makeGraph();
  entityNodes = {
    Hero: makeGraph().nodes[0],
    Monster: makeGraph().nodes[1],
    // 文档打开失败用例:节点存在,defFile 由 openTextDocument stub 抛错
    Missing: {
      name: 'Missing',
      defFile: '/ws/entity_defs/Missing.def',
      types: [EntityType.Base],
      references: [],
      referencedBy: 0
    }
  };
});

describe('EntityDependencyWebView.show', () => {
  it('creates the panel and renders the analyzed graph on first show', async () => {
    const panel = await show();

    expect(panelRegistry.panels).toHaveLength(1);
    expect(panel.viewType).toBe('kbengine.entityDependency');
    expect(panel.title).toBe('KBEngine 实体依赖关系');
    expect(panel.showOptions).toBe(ViewColumn.Two);
    expect((panel.options as { enableScripts: boolean }).enableScripts).toBe(true);
    expect(panel.messageListeners).toHaveLength(1);
    expect(panel.disposeListeners).toHaveLength(1);
    expect(panel.webview.html).toContain('<!DOCTYPE html>');
    expect(panel.webview.html).toContain('graph TD');
    expect(panel.webview.html).toContain('🔵🟢 Hero');
    expect(panel.webview.html).toContain('🟡 Monster');
    expect(panel.webview.html).toContain('总实体数');
    expect(panel.webview.html).toContain('最常引用');
    expect(panel.webview.html).toContain('Hero');
  });

  it('reveals the existing panel on a second show of the same instance', async () => {
    const webview = makeWebView();
    await webview.show();
    const panel = currentPanel();

    await webview.show();

    expect(panelRegistry.panels).toHaveLength(1);
    expect(panel.revealed).toBe(true);
  });

  it('builds a fresh panel after disposal', async () => {
    const webview = makeWebView();
    await webview.show();
    const first = currentPanel();

    panelRegistry.fireDispose(first);
    await webview.show();
    const second = currentPanel();

    expect(panelRegistry.panels).toHaveLength(2);
    expect(second).not.toBe(first);
    expect(second.webview.html).toContain('graph TD');
  });

  it('reports analysis failures through the error channel and output', async () => {
    analyzeImpl = async () => {
      throw new Error('def tree broken');
    };
    const panel = await show();

    expect(panel.webview.html).toBe('');
    expect(messages.error).toEqual(['刷新依赖图失败: Error: def tree broken']);
    expect(channelLines).toEqual(['刷新依赖图失败: Error: def tree broken']);
  });
});

describe('EntityDependencyWebView message handling', () => {
  it('re-analyzes and re-renders on the refresh command', async () => {
    const panel = await show();
    let analyzeCalls = 0;
    analyzeImpl = async () => {
      analyzeCalls += 1;
      return makeGraph();
    };

    send({ command: 'refresh' });
    await until(() => analyzeCalls === 1);

    expect(panel.webview.html).toContain('graph TD');
    expect(messages.error).toEqual([]);
  });

  // 批62 行覆盖:面板已销毁时的在途 refresh 消息。真实 vscode 里销毁后面板不再
  // 派发消息,fake 的 dispose 也会清空监听器,所以这里先捕获回调再销毁,复现
  // "消息在销毁之后送达"这一守卫所防范的时序;断言的是守卫命中后的行为:
  // 不重新分析、不写 html、不报错。
  it('drops a refresh message that arrives after the panel was disposed', async () => {
    const webview = makeWebView();
    const panel = await showOf(webview);
    // fake 的注册表把回调记为同步签名,类里传的是 async 函数,这里按实际返回值收窄
    const messageListener = panel.messageListeners[0] as (message: unknown) => Promise<void>;
    expect(typeof messageListener).toBe('function');

    let analyzeCalls = 0;
    analyzeImpl = async () => {
      analyzeCalls += 1;
      return makeGraph();
    };
    const htmlBefore = panel.webview.html;

    panelRegistry.fireDispose(panel);
    expect(panel.messageListeners).toEqual([]);

    await messageListener!({ command: 'refresh' });

    expect(analyzeCalls).toBe(0);
    expect(panel.webview.html).toBe(htmlBefore);
    expect(messages.error).toEqual([]);
    expect(channelLines).toEqual([]);
  });

  it('opens the def document for a known entity', async () => {
    await show();

    send({ command: 'openEntity', entityName: 'Hero' });
    await until(() => openedDocuments.length === 1);

    expect(openedDocuments[0]).toBe('/ws/entity_defs/Hero.def');
    expect(windowState.showTextDocumentCalls).toHaveLength(1);
    expect(messages.warning).toEqual([]);
  });

  it('warns when the entity node is unknown', async () => {
    await show();

    send({ command: 'openEntity', entityName: 'Ghost' });
    await new Promise(resolve => setTimeout(resolve, 30));

    expect(messages.warning).toEqual(['未找到实体节点: Ghost']);
    expect(openedDocuments).toEqual([]);
  });

  it('reports document open failures through the error channel', async () => {
    await show();

    send({ command: 'openEntity', entityName: 'Missing' });
    await until(() => messages.error.length === 1);

    expect(messages.error[0]).toContain('打开实体定义失败');
    expect(messages.error[0]).toContain('cannot open');
  });

  it('handshakes an export through the save dialog and beginExport post', async () => {
    const panel = await show();
    saveDialogUris.push(Uri.file('/tmp/kode-dep/graph.png'));

    send({ command: 'export', format: 'png' });
    await until(() => panel.webview.postedMessages.length === 1);

    expect(postedMessages()[0]).toEqual({ command: 'beginExport', format: 'png' });
  });

  it('silently drops a cancelled export dialog', async () => {
    const panel = await show();
    saveDialogUris.push(undefined);

    send({ command: 'export', format: 'svg' });
    await new Promise(resolve => setTimeout(resolve, 30));

    expect(panel.webview.postedMessages).toEqual([]);
  });

  it('warns when exporting with no graph available', async () => {
    const webview = makeWebView();
    await webview.show();
    (webview as unknown as { currentGraph: unknown }).currentGraph = null;

    send({ command: 'export', format: 'png' });
    await new Promise(resolve => setTimeout(resolve, 30));

    expect(messages.warning).toEqual(['没有可导出的图表']);
    expect(currentPanel().webview.postedMessages).toEqual([]);
  });
});

describe('EntityDependencyWebView export persistence', () => {
  const graphPath = '/tmp/kode-dep-out/graph.svg';
  const pngPath = '/tmp/kode-dep-out/graph.png';

  it('writes svg data as utf8 text and reports the target path', async () => {
    const panel = await show();
    saveDialogUris.push(Uri.file(graphPath));

    send({ command: 'export', format: 'svg' });
    await until(() => panel.webview.postedMessages.length === 1);

    send({
      command: 'exportData',
      format: 'svg',
      data: '<svg xmlns="http://www.w3.org/2000/svg"></svg>'
    });
    await until(() => messages.info.length === 1);

    const written = memoryFileSystem.files.get(graphPath) as Buffer;
    expect(written.toString('utf8')).toBe('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(messages.info[0]).toBe(`依赖图已导出到 ${graphPath}`);
  });

  it('decodes png data from base64', async () => {
    const panel = await show();
    saveDialogUris.push(Uri.file(pngPath));

    send({ command: 'export', format: 'png' });
    await until(() => panel.webview.postedMessages.length === 1);

    const payload = Buffer.from('PNG-bytes', 'utf8').toString('base64');
    send({ command: 'exportData', format: 'png', data: payload });
    await until(() => messages.info.length === 1);

    const written = memoryFileSystem.files.get(pngPath) as Buffer;
    expect(written.toString('utf8')).toBe('PNG-bytes');
    expect(messages.info[0]).toBe(`依赖图已导出到 ${pngPath}`);
  });

  it('ignores exportData when no export is pending', async () => {
    await show();

    send({ command: 'exportData', format: 'svg', data: '<svg/>' });
    await new Promise(resolve => setTimeout(resolve, 30));

    expect(memoryFileSystem.files.size).toBe(0);
    expect(messages.info).toEqual([]);
    expect(messages.error).toEqual([]);
  });

  it('fails loudly when the webview reports no data', async () => {
    const panel = await show();
    saveDialogUris.push(Uri.file(pngPath));

    send({ command: 'export', format: 'png' });
    await until(() => panel.webview.postedMessages.length === 1);

    send({ command: 'exportData', format: 'png', data: null });
    await until(() => messages.error.length === 1);

    expect(messages.error).toEqual(['导出 PNG 失败']);
  });

  it('fails loudly when the pending format and the data format disagree', async () => {
    const panel = await show();
    saveDialogUris.push(Uri.file(pngPath));

    send({ command: 'export', format: 'png' });
    await until(() => panel.webview.postedMessages.length === 1);

    send({ command: 'exportData', format: 'svg', data: '<svg/>' });
    await until(() => messages.error.length === 1);

    expect(messages.error).toEqual(['导出 SVG 失败']);
    expect(memoryFileSystem.files.size).toBe(0);
  });

  it('reports write failures through the error channel', async () => {
    const panel = await show();
    saveDialogUris.push(Uri.file(graphPath));

    send({ command: 'export', format: 'svg' });
    await until(() => panel.webview.postedMessages.length === 1);

    const originalWriteFile = stubWorkspace.fs.writeFile;
    stubWorkspace.fs.writeFile = async () => {
      throw new Error('read-only fs');
    };
    try {
      send({ command: 'exportData', format: 'svg', data: '<svg/>' });
      await until(() => messages.error.length === 1);
    } finally {
      stubWorkspace.fs.writeFile = originalWriteFile;
    }

    expect(messages.error[0]).toBe('写入导出文件失败: Error: read-only fs');
  });
});

describe('EntityDependencyWebView.dispose', () => {
  it('disposes the live panel and tolerates repeated calls', async () => {
    const webview = makeWebView();
    await webview.show();
    const panel = currentPanel();

    webview.dispose();
    webview.dispose();

    // FakeWebviewPanel.dispose 幂等:二次调用不再触发销毁监听
    expect(panel.disposed).toBe(true);
  });
});

describe('webview 内联脚本 buildExportData 分支', () => {
  // 批86 变异抽检补锁(M8):`if (format === 'svg')` 位于内联 webview 脚本模板
  // 字符串内,面板侧既有用例只覆盖 !svg 早退与握手消息,svg 命中后的序列化
  // 回包分支无执行面(比较器翻转后 svg 落进 png 影像管线,回包依赖
  // image.onload,无 DOM 的装置下静默全绿)。此处抽取脚本正文在 Node 内用假
  // DOM 元素执行,直接驱动 beginExport 消息走真实分支。
  const runWebviewScript = (html: string): {
    posted: Array<Record<string, unknown>>;
    dispatch: (data: Record<string, unknown>) => void;
  } => {
    const marker = '<script>';
    const start = html.indexOf(marker);
    if (start < 0) {
      throw new Error('webview html 缺少内联 <script> 段');
    }
    const body = html.slice(start + marker.length, html.indexOf('</script>', start));

    const posted: Array<Record<string, unknown>> = [];
    let onMessage: ((event: { data: Record<string, unknown> }) => void) | undefined;

    // 假 svg 命中 querySelector;png 影像管线(Blob→Image→canvas)在假件下
    // 永不触发 image.onload,因此 png 臂不产生同步 exportData 回包。
    const svgStub = {
      getBoundingClientRect: () => ({ width: 1200, height: 800 }),
      getAttribute: () => null
    };
    class ImageStub {
      src = '';
    }

    const load = new Function(
      'acquireVsCodeApi', 'mermaid', 'window', 'document',
      'XMLSerializer', 'Blob', 'URL', 'Image',
      body
    );
    load(
      () => ({
        postMessage: (message: Record<string, unknown>) => {
          posted.push(message);
        }
      }),
      { initialize: () => undefined },
      {
        addEventListener: (type: string, listener: (event: { data: Record<string, unknown> }) => void) => {
          if (type === 'message') {
            onMessage = listener;
          }
        }
      },
      { querySelector: () => svgStub },
      class XMLSerializerStub {
        serializeToString(): string {
          return '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
        }
      },
      class BlobStub {},
      { createObjectURL: () => 'blob:stub', revokeObjectURL: () => undefined },
      ImageStub
    );

    const handler = onMessage;
    if (!handler) {
      throw new Error('webview 脚本未注册 message 监听');
    }
    return { posted, dispatch: data => handler({ data }) };
  };

  it('serializes the svg element and posts exportData synchronously', async () => {
    const panel = await show();
    const { posted, dispatch } = runWebviewScript(panel.webview.html);

    dispatch({ command: 'beginExport', format: 'svg' });

    expect(posted).toContainEqual({
      command: 'exportData',
      format: 'svg',
      data: '<svg xmlns="http://www.w3.org/2000/svg"></svg>'
    });
  });

  it('keeps png export on the async image pipeline without a synchronous reply', async () => {
    const panel = await show();
    const { posted, dispatch } = runWebviewScript(panel.webview.html);

    dispatch({ command: 'beginExport', format: 'png' });

    // png 臂依赖 image.onload 异步回包;假 Image 不解码图片,故此装置下
    // 不产生同步 exportData —— 与 svg 臂的行为差异即为分支锁。
    expect(posted).toEqual([]);
  });
});
