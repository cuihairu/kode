import { beforeEach, describe, expect, it } from 'vitest';
import {
  RuntimeQueryWebView,
  joinWatcherPath,
  toSpaceView,
  watcherResultRows
} from '../src/runtimeQueryWebView';
import type {
  KBEngineComponentInfo,
  SpaceQueryResult,
  WatcherQueryResult
} from '../src/kbengineProtocol';
import { Uri, type ExtensionContext } from './fake-vscode/core';
import { panelRegistry } from './fake-vscode/panelRegistry';

const component: KBEngineComponentInfo = {
  uid: 1000,
  username: 'tester',
  componentType: 5,
  componentID: 9001n,
  componentIDEx: 0n,
  globalOrderID: 0,
  groupOrderID: 0,
  genuuidSections: 0,
  intaddr: '127.0.0.1',
  intport: 20005,
  extaddr: '127.0.0.1',
  extport: 20006,
  extaddrEx: '127.0.0.1',
  pid: 123,
  cpu: 0,
  mem: 0,
  usedmem: 0,
  state: 1,
  machineID: 1,
  extradata: 0n,
  extradata1: 0n,
  extradata2: 0n,
  extradata3: 0n,
  backaddr: 0,
  backport: 0,
  componentName: 'cellapp1',
  fullName: 'cellapp1'
};

const space: SpaceQueryResult = {
  componentType: 4,
  componentID: 1n,
  spaces: []
};

// 引擎 `Watcher.py:73-93` 的叶子读数段形态:type 0 + 父路径 + values 里叶子名
const watcher: WatcherQueryResult = {
  type: 0,
  path: '/cellapp',
  values: { uptime: 42 },
  keys: []
};

const protocol = {
  discoverComponents: async (timeoutMs?: number): Promise<KBEngineComponentInfo[]> => {
    if (timeoutMs !== 1200) throw new Error('unexpected discovery timeout');
    return [component];
  },
  querySpaces: async (): Promise<SpaceQueryResult> => space,
  queryWatcherPath: async (): Promise<WatcherQueryResult[]> => [watcher]
};

const context: ExtensionContext = { subscriptions: [], extensionUri: Uri.file('/tmp') };

const postState = (panelIndex = 0) => {
  const messages = panelRegistry.panels[panelIndex].webview.postedMessages;
  const message = messages.at(-1)?.message as Record<string, unknown>;
  expect(message.command).toBe('state');
  return message;
};

beforeEach(() => {
  panelRegistry.reset();
});

describe('RuntimeQueryWebView', () => {
  it('renders and refreshes the running component list', async () => {
    const webview = new RuntimeQueryWebView(context, protocol);
    webview.show();
    await Promise.resolve();
    await Promise.resolve();

    const panel = panelRegistry.panels[0];
    expect(panel.viewType).toBe('kbengine.runtimeQuery');
    expect(panel.webview.html).toContain('Query watcher');
    // C-2:结果以表格呈现(不再是整包 JSON 倾倒),列头固定 Path/Kind/Value
    expect(panel.webview.html).toContain('<table id="watcher-result" hidden>');
    for (const column of ['Path', 'Kind', 'Value']) {
      expect(panel.webview.html).toContain(`<th scope="col">${column}</th>`);
    }
    expect(postState().components).toEqual([
      { key: '5:9001', name: 'cellapp1', type: 5, address: '127.0.0.1:20005' }
    ]);
  });

  it('queries spaces for the selected component', async () => {
    const webview = new RuntimeQueryWebView(context, protocol);
    webview.show();
    await Promise.resolve();
    await Promise.resolve();

    panelRegistry.fireMessage(panelRegistry.panels[0], {
      command: 'querySpaces',
      componentKey: '5:9001'
    });
    await Promise.resolve();

    expect(postState().result).toEqual({
      spaces: [{ componentType: 4, componentID: '1', spaces: [] }],
      watcherRows: []
    });
  });

  it('queries a watcher path after trimming input', async () => {
    const webview = new RuntimeQueryWebView(context, protocol);
    webview.show();
    await Promise.resolve();
    await Promise.resolve();

    panelRegistry.fireMessage(panelRegistry.panels[0], {
      command: 'queryWatcher',
      componentKey: 'cellapp1',
      path: ' /cellapp/uptime '
    });
    await Promise.resolve();

    // C-2:回包不再带原始 watchers,而是带已投影好的表格行
    expect(postState().result).toEqual({
      spaces: [],
      watcherRows: [{ path: '/cellapp/uptime', kind: 'value', value: '42' }]
    });
  });

  it('reports missing components, empty paths, and discovery failures', async () => {
    const failing = {
      ...protocol,
      discoverComponents: async (): Promise<KBEngineComponentInfo[]> => {
        throw new Error('discovery unavailable');
      }
    };
    const webview = new RuntimeQueryWebView(context, failing);
    webview.show();
    await Promise.resolve();
    await Promise.resolve();

    const panel = panelRegistry.panels[0];
    panelRegistry.fireMessage(panel, { command: 'queryWatcher', componentKey: 'missing', path: ' ' });
    panelRegistry.fireMessage(panel, { command: 'querySpaces', componentKey: 'missing' });
    await Promise.resolve();

    expect(postState().error).toEqual({
      kind: 'spaces',
      componentKey: 'missing',
      message: 'Select a running component first.'
    });

    panelRegistry.reset();
    const failedWebview = new RuntimeQueryWebView(context, failing);
    failedWebview.show();
    await Promise.resolve();
    await Promise.resolve();
    expect(postState().error).toEqual({
      kind: 'discovery',
      message: 'discovery unavailable'
    });
  });

  it('reports watcher and spaces protocol failures', async () => {
    const failing = {
      ...protocol,
      querySpaces: async (): Promise<SpaceQueryResult> => {
        throw new Error('spaces failed');
      },
      queryWatcherPath: async (): Promise<WatcherQueryResult[]> => {
        throw new Error('watcher failed');
      }
    };
    const webview = new RuntimeQueryWebView(context, failing);
    webview.show();
    await Promise.resolve();
    await Promise.resolve();

    const panel = panelRegistry.panels[0];
    panelRegistry.fireMessage(panel, { command: 'queryWatcher', componentKey: '5:9001', path: '/x' });
    await Promise.resolve();
    expect(postState().error).toMatchObject({ kind: 'watcher', message: 'watcher failed' });

    panelRegistry.fireMessage(panel, { command: 'querySpaces', componentKey: '5:9001' });
    await Promise.resolve();
    expect(postState().error).toMatchObject({ kind: 'spaces', message: 'spaces failed' });
  });
});

describe('toSpaceView(webview 边界 bigint 转字符串)', () => {
  it('componentID/snapshot.componentID/cellappID 转 string,数值字段保持 number', () => {
    const [view] = toSpaceView([
      {
        componentType: 4,
        componentID: 12345678901234567890n,
        spaces: [
          {
            componentType: 5,
            componentID: 999n,
            cellappID: 888n,
            spaceID: 7,
            geomappingPath: 'spaces/dungeon',
            scriptModuleName: 'dungeon',
            cells: [1, 2]
          }
        ]
      }
    ]);
    expect(view.componentID).toBe('12345678901234567890');
    expect(view.spaces[0]).toEqual({
      componentType: 5,
      componentID: '999',
      cellappID: '888',
      spaceID: 7,
      geomappingPath: 'spaces/dungeon',
      scriptModuleName: 'dungeon',
      cells: [1, 2]
    });
    // 产物必须可 JSON 序列化(修复前的原始 bigint 会抛 Do not know how to serialize)
    expect(() => JSON.stringify(view)).not.toThrow();
  });

  it('空输入返回空数组', () => {
    expect(toSpaceView()).toEqual([]);
    expect(toSpaceView([])).toEqual([]);
  });
});

// C-2 结果表格的行投影口径。引擎侧依据 `Watcher.py:73-137`:type 0 是叶子读数段
// (父路径 + values 叶子名),type≠0 是目录清单段(keys 直接是子路径全名)。
describe('watcherResultRows / joinWatcherPath', () => {
  it('joinWatcherPath 按引擎 fullpath 口径拼:父路径非空补斜杠,为空只留叶子名', () => {
    expect(joinWatcherPath('/cellapp', 'uptime')).toBe('/cellapp/uptime');
    expect(joinWatcherPath('', 'uptime')).toBe('uptime');
  });

  it('type 0 叶子读数段展开为逐条 value 行,保引擎线序、值如实转字符串', () => {
    const rows = watcherResultRows([
      { type: 0, path: '/cellapp', values: { uptime: 42, load: 0.5, verbose: true, state: 'normal' }, keys: [] }
    ]);
    expect(rows).toEqual([
      { path: '/cellapp/uptime', kind: 'value', value: '42' },
      { path: '/cellapp/load', kind: 'value', value: '0.5' },
      { path: '/cellapp/verbose', kind: 'value', value: 'true' },
      { path: '/cellapp/state', kind: 'value', value: 'normal' }
    ]);
  });

  it('type≠0 目录清单段展开为逐条 child 行,值列留空', () => {
    const rows = watcherResultRows([
      { type: 1, path: '/cellapp', values: {}, keys: ['/cellapp/uptime', '/cellapp/load'] }
    ]);
    expect(rows).toEqual([
      { path: '/cellapp/uptime', kind: 'child', value: '' },
      { path: '/cellapp/load', kind: 'child', value: '' }
    ]);
  });

  it('多段结果按线序拼接;空输入返回空数组,不造占位行', () => {
    expect(watcherResultRows()).toEqual([]);
    expect(watcherResultRows([])).toEqual([]);

    const rows = watcherResultRows([
      { type: 1, path: '/', values: {}, keys: ['/a'] },
      { type: 0, path: '/a', values: { b: 1 }, keys: [] }
    ]);
    expect(rows).toEqual([
      { path: '/a', kind: 'child', value: '' },
      { path: '/a/b', kind: 'value', value: '1' }
    ]);
  });
});

describe('webview 内联脚本渲染 watcher 结果表格', () => {
  // C-2 的表格渲染活在内联脚本字符串里,没有执行面时投影再对也会静默退化成
  // 空表。按 tests/entityDependencyPanel.test.ts 的 runWebviewScript 口径把
  // 脚本正文抽出来在 Node 内用假 DOM 执行,直接驱动 state 消息断言表格行。
  interface FakeElement {
    tag: string;
    children: FakeElement[];
    listeners: Record<string, () => void>;
    textContent: string;
    value: string;
    hidden: boolean;
    scope?: string;
    append: (...nodes: FakeElement[]) => void;
    replaceChildren: (...nodes: FakeElement[]) => void;
    addEventListener: (type: string, listener: () => void) => void;
    querySelector: (selector: string) => FakeElement | undefined;
  }

  const makeElement = (tag: string): FakeElement => {
    const element = {
      tag,
      children: [] as FakeElement[],
      listeners: {} as Record<string, () => void>,
      textContent: '',
      value: '',
      hidden: false,
      append: (...nodes: FakeElement[]): void => {
        element.children.push(...nodes);
      },
      replaceChildren: (...nodes: FakeElement[]): void => {
        element.children = [...nodes];
      },
      addEventListener: (type: string, listener: () => void): void => {
        element.listeners[type] = listener;
      },
      querySelector: (): FakeElement | undefined => undefined
    } as FakeElement;
    return element;
  };

  const runWebviewScript = (html: string): {
    elements: Map<string, FakeElement>;
    dispatch: (data: Record<string, unknown>) => void;
  } => {
    const marker = '<script>';
    const start = html.indexOf(marker);
    if (start < 0) {
      throw new Error('webview html 缺少内联 <script> 段');
    }
    const body = html.slice(start + marker.length, html.indexOf('</script>', start));

    const elements = new Map<string, FakeElement>();
    const tbody = makeElement('tbody');
    for (const id of ['component', 'path', 'message', 'result', 'empty', 'refresh', 'spaces', 'watcher']) {
      elements.set(id, makeElement(id === 'component' ? 'select' : id === 'path' ? 'input' : 'div'));
    }
    const watcherTable = makeElement('table');
    watcherTable.querySelector = (selector: string) => (selector === 'tbody' ? tbody : undefined);
    elements.set('watcher-result', watcherTable);

    let onMessage: ((event: { data: Record<string, unknown> }) => void) | undefined;
    const load = new Function(
      'acquireVsCodeApi', 'window', 'document',
      body
    );
    load(
      () => ({ postMessage: () => undefined }),
      {
        addEventListener: (type: string, listener: (event: { data: Record<string, unknown> }) => void) => {
          if (type === 'message') {
            onMessage = listener;
          }
        }
      },
      {
        getElementById: (id: string) => elements.get(id),
        createElement: (tag: string) => makeElement(tag)
      }
    );

    const handler = onMessage;
    if (!handler) {
      throw new Error('webview 脚本未注册 message 监听');
    }
    return { elements, dispatch: data => handler({ data }) };
  };

  const htmlOf = (): string => {
    const webview = new RuntimeQueryWebView(context, protocol);
    webview.show();
    return panelRegistry.panels[0].webview.html;
  };

  it('state 消息带 watcherRows 时逐行渲染 Path/Kind/Value,隐藏空态', () => {
    const { elements, dispatch } = runWebviewScript(htmlOf());
    const table = elements.get('watcher-result') as FakeElement;
    const tbody = table.querySelector('tbody') as FakeElement;

    dispatch({
      command: 'state',
      components: [],
      error: null,
      result: {
        spaces: [],
        watcherRows: [
          { path: '/cellapp/uptime', kind: 'value', value: '42' },
          { path: '/cellapp/load', kind: 'child', value: '' }
        ]
      }
    });

    expect(table.hidden).toBe(false);
    expect(elements.get('empty')?.hidden).toBe(true);
    expect(tbody.children).toHaveLength(2);
    const [first, second] = tbody.children;
    expect(first.tag).toBe('tr');
    expect(first.children.map(cell => `${cell.tag}:${cell.scope ?? ''}:${cell.textContent}`)).toEqual([
      'th:row:/cellapp/uptime',
      'td::value',
      'td::42'
    ]);
    expect(second.children.map(cell => cell.textContent)).toEqual(['/cellapp/load', 'child', '']);
  });

  it('watcherRows 为空时表格隐藏、空态可见;spaces 结果仍走 JSON 前置块', () => {
    const { elements, dispatch } = runWebviewScript(htmlOf());
    const table = elements.get('watcher-result') as FakeElement;

    dispatch({
      command: 'state',
      components: [],
      error: null,
      result: { spaces: [{ componentType: 4, componentID: '1', spaces: [] }], watcherRows: [] }
    });

    expect(table.hidden).toBe(true);
    expect(elements.get('empty')?.hidden).toBe(false);
    const result = elements.get('result');
    expect(result?.hidden).toBe(false);
    expect(result?.textContent).toContain('"componentType": 4');
  });
});
