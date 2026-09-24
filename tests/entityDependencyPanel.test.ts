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
  Uri,
  ViewColumn,
  memoryFileSystem,
  window as stubWindow,
  workspace as stubWorkspace
} from './helpers/vscodeStub';

// EntityDependencyWebView 的面板生命周期:show/refresh 的分析→mermaid→
// html 链路、openEntityFile 的文档打开三态、exportGraph→pendingExport→
// webview.postMessage 的导出握手、saveExportedGraph 的落盘。analyzer 在
// 构造内自建,测试经 internals 替换为可控假例;面板工厂/保存对话框/
// 文档打开由 monkey-patch 驱动。mermaid 生成已由 entityDependencyWebView
// 既有纯逻辑测试覆盖。

interface StubPanel {
  viewType: string;
  title: string;
  column: number;
  options: { enableScripts: boolean };
  revealCalls: number;
  disposeCalls: number;
  webview: {
    html: string;
    posted: Array<{ command: string; format?: string }>;
    handlers: Array<(message: unknown) => void>;
    onDidReceiveMessage(handler: (message: unknown) => void): { dispose(): void };
    postMessage(message: unknown): Promise<boolean>;
  };
  disposeHandlers: Array<() => void>;
  onDidDispose(handler: () => void): { dispose(): void };
  reveal(): void;
  dispose(): void;
}

const panels: StubPanel[] = [];
const saveDialogUris: Array<vscode.Uri | undefined> = [];
const messages = {
  info: [] as string[],
  warning: [] as string[],
  error: [] as string[]
};
const openedDocuments: string[] = [];
const shownDocuments: string[] = [];
const channelLines: string[] = [];

const windowish = stubWindow as unknown as Record<string, unknown>;
const originalWindow: Record<string, unknown> = {};
const patchedKeys = [
  'createWebviewPanel',
  'showSaveDialog',
  'showInformationMessage',
  'showWarningMessage',
  'showErrorMessage',
  'showTextDocument'
];

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

const currentPanel = (): StubPanel => panels[panels.length - 1];

const show = async (): Promise<StubPanel> => {
  await makeWebView().show();
  return currentPanel();
};

const send = (message: unknown): void => {
  for (const handler of [...currentPanel().webview.handlers]) {
    void handler(message);
  }
};

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
  for (const key of patchedKeys) {
    originalWindow[key] = windowish[key];
  }
  windowish.createWebviewPanel = (
    viewType: string,
    title: string,
    column: number,
    options: { enableScripts: boolean }
  ) => {
    const panel = {
      viewType,
      title,
      column,
      options,
      revealCalls: 0,
      disposeCalls: 0,
      disposeHandlers: [] as Array<() => void>,
      webview: {
        html: '',
        posted: [] as Array<{ command: string; format?: string }>,
        handlers: [] as Array<(message: unknown) => void>,
        onDidReceiveMessage: (handler: (message: unknown) => void) => {
          panel.webview.handlers.push(handler);
          return { dispose: () => undefined };
        },
        postMessage: async (message: unknown) => {
          panel.webview.posted.push(message as { command: string; format?: string });
          return true;
        }
      },
      onDidDispose: (handler: () => void) => {
        panel.disposeHandlers.push(handler);
        return { dispose: () => undefined };
      },
      reveal: () => {
        panel.revealCalls += 1;
      },
      dispose: () => {
        panel.disposeCalls += 1;
      }
    };
    panels.push(panel as unknown as StubPanel);
    return panel;
  };
  windowish.showSaveDialog = async () => saveDialogUris.shift();
  windowish.showInformationMessage = async (message: string) => {
    messages.info.push(message);
    return undefined;
  };
  windowish.showWarningMessage = async (message: string) => {
    messages.warning.push(message);
    return undefined;
  };
  windowish.showErrorMessage = async (message: string) => {
    messages.error.push(message);
    return undefined;
  };
  windowish.showTextDocument = async (document: unknown) => {
    shownDocuments.push(String(document));
    return {};
  };
  stubWorkspace.openTextDocument = async (uri: vscode.Uri) => {
    if (String(uri.fsPath).endsWith('/Missing.def')) {
      throw new Error('cannot open');
    }
    openedDocuments.push(uri.fsPath);
    return { uri };
  };
});

afterAll(() => {
  for (const key of patchedKeys) {
    windowish[key] = originalWindow[key];
  }
  stubWorkspace.openTextDocument = originalOpenTextDocument;
  memoryFileSystem.reset();
});

beforeEach(() => {
  panels.length = 0;
  saveDialogUris.length = 0;
  messages.info.length = 0;
  messages.warning.length = 0;
  messages.error.length = 0;
  openedDocuments.length = 0;
  shownDocuments.length = 0;
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

    expect(panels).toHaveLength(1);
    expect(panel.viewType).toBe('kbengine.entityDependency');
    expect(panel.title).toBe('KBEngine 实体依赖关系');
    expect(panel.column).toBe(ViewColumn.Two);
    expect(panel.options.enableScripts).toBe(true);
    expect(panel.webview.handlers).toHaveLength(1);
    expect(panel.disposeHandlers).toHaveLength(1);
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

    expect(panels).toHaveLength(1);
    expect(panel.revealCalls).toBe(1);
  });

  it('builds a fresh panel after disposal', async () => {
    const webview = makeWebView();
    await webview.show();
    const first = currentPanel();

    first.disposeHandlers[0]();
    await webview.show();
    const second = currentPanel();

    expect(panels).toHaveLength(2);
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

  it('opens the def document for a known entity', async () => {
    await show();

    send({ command: 'openEntity', entityName: 'Hero' });
    await until(() => openedDocuments.length === 1);

    expect(openedDocuments[0]).toBe('/ws/entity_defs/Hero.def');
    expect(shownDocuments).toHaveLength(1);
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
    await until(() => panel.webview.posted.length === 1);

    expect(panel.webview.posted[0]).toEqual({ command: 'beginExport', format: 'png' });
  });

  it('silently drops a cancelled export dialog', async () => {
    const panel = await show();
    saveDialogUris.push(undefined);

    send({ command: 'export', format: 'svg' });
    await new Promise(resolve => setTimeout(resolve, 30));

    expect(panel.webview.posted).toEqual([]);
  });

  it('warns when exporting with no graph available', async () => {
    const webview = makeWebView();
    await webview.show();
    (webview as unknown as { currentGraph: unknown }).currentGraph = null;

    send({ command: 'export', format: 'png' });
    await new Promise(resolve => setTimeout(resolve, 30));

    expect(messages.warning).toEqual(['没有可导出的图表']);
    expect(currentPanel().webview.posted).toEqual([]);
  });
});

describe('EntityDependencyWebView export persistence', () => {
  const graphPath = '/tmp/kode-dep-out/graph.svg';
  const pngPath = '/tmp/kode-dep-out/graph.png';

  it('writes svg data as utf8 text and reports the target path', async () => {
    const panel = await show();
    saveDialogUris.push(Uri.file(graphPath));

    send({ command: 'export', format: 'svg' });
    await until(() => panel.webview.posted.length === 1);

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
    await until(() => panel.webview.posted.length === 1);

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
    await until(() => panel.webview.posted.length === 1);

    send({ command: 'exportData', format: 'png', data: null });
    await until(() => messages.error.length === 1);

    expect(messages.error).toEqual(['导出 PNG 失败']);
  });

  it('fails loudly when the pending format and the data format disagree', async () => {
    const panel = await show();
    saveDialogUris.push(Uri.file(pngPath));

    send({ command: 'export', format: 'png' });
    await until(() => panel.webview.posted.length === 1);

    send({ command: 'exportData', format: 'svg', data: '<svg/>' });
    await until(() => messages.error.length === 1);

    expect(messages.error).toEqual(['导出 SVG 失败']);
    expect(memoryFileSystem.files.size).toBe(0);
  });

  it('reports write failures through the error channel', async () => {
    const panel = await show();
    saveDialogUris.push(Uri.file(graphPath));

    send({ command: 'export', format: 'svg' });
    await until(() => panel.webview.posted.length === 1);

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

    expect(panel.disposeCalls).toBe(1);
  });
});
