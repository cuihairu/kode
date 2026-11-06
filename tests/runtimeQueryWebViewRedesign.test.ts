// RuntimeQueryWebView P0 重设计(UI-04):原面板零 CSS、全英文、spaces 结果
// JSON 原始倾倒、监视清单与查询区纠缠。按已批准原型 #rt 重做:
// 左操作轨(组件/路径/监视清单)+ 右结果页签(Watcher 表格 / Spaces 表格),
// 接入统一设计 token,全部文案走字符串表(zh 默认/en 覆盖)。
import { beforeEach, describe, expect, it } from 'vitest';
import { RuntimeQueryWebView } from '../src/runtimeQueryWebView';
import { Uri, type ExtensionContext } from './fake-vscode/core';
import { panelRegistry } from './fake-vscode/panelRegistry';
import { configurationOverrides, envState } from './helpers/vscodeStub';
import type { KBEngineComponentInfo } from '../src/kbengineProtocol';

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

const protocol = {
  discoverComponents: async (): Promise<KBEngineComponentInfo[]> => [component],
  querySpaces: async () => ({
    componentType: 4,
    componentID: 1n,
    spaces: [
      {
        componentType: 4,
        componentID: 3n,
        cellappID: 7n,
        spaceID: 3,
        geomappingPath: '',
        scriptModuleName: 'spaces/monster_scene',
        cells: [1, 2]
      }
    ]
  }),
  queryWatcherPath: async () => []
};

const context: ExtensionContext = { subscriptions: [], extensionUri: Uri.file('/tmp') };

const render = (): string => {
  panelRegistry.reset();
  const webview = new RuntimeQueryWebView(context, protocol);
  webview.show();
  return panelRegistry.panels[0].webview.html;
};

beforeEach(() => {
  panelRegistry.reset();
  configurationOverrides.delete('kbengine');
  envState.language = 'zh-cn';
});

describe('RuntimeQueryWebView 设计系统(P0:零 CSS 退场)', () => {
  it('token 进面板,带 kode 面板头与双栏骨架', () => {
    const html = render();
    expect(html).toContain('--kode-ok:#89d185');
    expect(html).toContain('kode-head');
    expect(html).toContain('class="rt-body"');
    expect(html).toContain('id="rt-rail"');
    expect(html).toContain('id="rt-main"');
  });
});

describe('RuntimeQueryWebView 结果区表格化', () => {
  it('watcher 结果仍是固定列表格(Path/Kind/Value)', () => {
    const html = render();
    expect(html).toContain('<table id="watcher-result" hidden class="kode-table">');
    expect(html).toContain('<table id="spaces-result" hidden class="kode-table">');
    // spaces 不再是 JSON 倾倒容器
    expect(html).not.toContain('<pre id="result"');
  });

  it('监视清单与查询区各自成区(rail 内三段)', () => {
    const html = render();
    expect(html).toContain('id="component"');
    expect(html).toContain('id="path"');
    expect(html).toContain('id="watch-list"');
    expect(html).toContain('id="add-watcher"');
    expect(html).toContain('id="stream"');
  });
});

describe('RuntimeQueryWebView i18n', () => {
  it('zh:面板标题/按钮/表头全部中文', () => {
    const html = render();
    expect(html).toContain('运行时查询');
    expect(html).toContain('刷新组件');
    expect(html).toContain('目标组件');
    expect(html).toContain('Watcher 路径');
    expect(html).toContain('监视清单');
    expect(html).toContain('加入监视');
    expect(html).toContain('开始流式轮询');
    expect(html).toContain('Watcher 结果');
    expect(html).toContain('Spaces 空间');
    expect(html).toContain('路径');
    expect(html).toContain('类型');
    expect(html).toContain('值');
  });

  it('en:kbengine.webviewLocale=en 输出英文面板', () => {
    configurationOverrides.set('kbengine', { webviewLocale: 'en' });
    const html = render();
    expect(html).toContain('Runtime Queries');
    expect(html).toContain('Refresh components');
    expect(html).toContain('Watch list');
    expect(html).toContain('Add to watch list');
    expect(html).toContain('Start stream polling');
    expect(html).toContain('Path');
    expect(html).not.toContain('运行时查询');
  });

  it('en:错误文案本地化(选组件提示)', async () => {
    configurationOverrides.set('kbengine', { webviewLocale: 'en' });
    panelRegistry.reset();
    const webview = new RuntimeQueryWebView(context, protocol);
    webview.show();
    await Promise.resolve();
    panelRegistry.fireMessage(panelRegistry.panels[0], {
      command: 'queryWatcher',
      componentKey: 'missing',
      path: ' '
    });
    await Promise.resolve();
    const message = panelRegistry.panels[0].webview.postedMessages.at(-1)?.message as Record<string, unknown>;
    expect((message.error as Record<string, unknown>).message).toBe('Select a running component first.');
  });

  it('zh:错误文案默认中文', async () => {
    panelRegistry.reset();
    const webview = new RuntimeQueryWebView(context, protocol);
    webview.show();
    await Promise.resolve();
    panelRegistry.fireMessage(panelRegistry.panels[0], {
      command: 'queryWatcher',
      componentKey: 'missing',
      path: ' '
    });
    await Promise.resolve();
    const message = panelRegistry.panels[0].webview.postedMessages.at(-1)?.message as Record<string, unknown>;
    expect((message.error as Record<string, unknown>).message).toBe('请先选择运行中的组件。');
  });
});
