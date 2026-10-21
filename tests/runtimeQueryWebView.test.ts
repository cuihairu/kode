import { beforeEach, describe, expect, it } from 'vitest';
import { RuntimeQueryWebView } from '../src/runtimeQueryWebView';
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

const watcher: WatcherQueryResult = {
  type: 3,
  path: '/cellapp/uptime',
  values: { '/cellapp/uptime': 42 },
  keys: ['/cellapp/uptime']
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

    expect(postState().result).toEqual({ spaces: [space] });
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

    expect(postState().result).toEqual({ watchers: [watcher] });
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
