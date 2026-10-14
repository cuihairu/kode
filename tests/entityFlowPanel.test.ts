import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EntityFlowWebView } from '../src/entityFlowWebView';
import type * as vscode from 'vscode';
import {
  memoryFileSystem,
  messages,
  panelRegistry,
  Uri,
  ViewColumn,
  window as stubWindow,
  windowState,
  workspace as stubWorkspace
} from './helpers/vscodeStub';
import type { FakeWebviewPanel } from './helpers/vscodeStub';

// EntityFlowWebView 的装配层:show 的实体定位与面板生命周期、refresh 的磁盘
// 重读、openMember 的声明回跳、三类导出(Markdown 直写 / SVG·PNG 经 webview
// 握手)与落盘失败。图模型与 mermaid/markdown 渲染由 entityFlowGraph 纯函数
// 测试锁定,本文件只看「面板把图数据接到哪个 UI 出口」。面板由 fake-vscode 的
// panelRegistry 默认工厂创建,建图走真实临时工作区(def 与 entities.xml 经磁盘)。

const HERO_DEF = [
  '<root>',
  '  <Properties>',
  '    <hp>',
  '      <Type>UINT32</Type>',
  '      <Flags>BASE_AND_CLIENT</Flags>',
  '      <Persistent>true</Persistent>',
  '      <Default>100</Default>',
  '    </hp>',
  '    <pos>',
  '      <Type>Vector3</Type>',
  '      <Flags>ALL_CLIENTS</Flags>',
  '    </pos>',
  '  </Properties>',
  '  <BaseMethods>',
  '    <attack>',
  '      <Exposed/>',
  '    </attack>',
  '    <bookkeeping>',
  '    </bookkeeping>',
  '  </BaseMethods>',
  '  <ClientMethods>',
  '    <onTakeDamage/>',
  '  </ClientMethods>',
  '</root>'
].join('\n');

const HERO_WITH_HEAL_DEF = HERO_DEF.replace(
  '    <bookkeeping>',
  '    <heal>\n      <Exposed/>\n    </heal>\n    <bookkeeping>'
);

const ACTOR_DEF = [
  '<root>',
  '  <Properties>',
  '    <score>',
  '      <Type>UINT32</Type>',
  '      <Flags>BASE</Flags>',
  '      <Persistent>true</Persistent>',
  '      <Default>0</Default>',
  '    </score>',
  '  </Properties>',
  '</root>'
].join('\n');

let root = '';
let heroDefPath = '';

const saveDialogUris: Array<vscode.Uri | undefined> = [];
const saveDialogOptions: Array<Record<string, unknown>> = [];

const windowish = stubWindow as unknown as Record<string, unknown>;
const originalShowSaveDialog = windowish.showSaveDialog;
const originalActiveTextEditor = windowish.activeTextEditor;
const originalOpenTextDocument = stubWorkspace.openTextDocument;
const originalWriteFile = stubWorkspace.fs.writeFile;

const currentPanel = (): FakeWebviewPanel =>
  panelRegistry.panels[panelRegistry.panels.length - 1];

const makeWebView = (): EntityFlowWebView =>
  new EntityFlowWebView({ extensionUri: Uri.file('/ext/root') } as unknown as vscode.ExtensionContext);

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-flow-'));
  heroDefPath = path.join(root, 'scripts', 'entity_defs', 'Hero.def');
  fs.mkdirSync(path.join(root, 'scripts', 'entity_defs'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'scripts', 'entities.xml'),
    '<root>\n  <Hero hasBase="true" hasCell="true" hasClient="true"/>\n</root>\n',
    'utf8'
  );
  fs.writeFileSync(heroDefPath, HERO_DEF, 'utf8');
  fs.writeFileSync(path.join(root, 'scripts', 'entity_defs', 'Actor.def'), ACTOR_DEF, 'utf8');

  windowish.showSaveDialog = async (options: Record<string, unknown>) => {
    saveDialogOptions.push(options);
    return saveDialogUris.shift();
  };
  stubWorkspace.openTextDocument = async (uri: vscode.Uri) => {
    if (String(uri.fsPath).endsWith('/Broken.def')) {
      throw new Error('cannot open');
    }
    return { uri };
  };
});

afterAll(() => {
  windowish.showSaveDialog = originalShowSaveDialog;
  windowish.activeTextEditor = originalActiveTextEditor;
  stubWorkspace.openTextDocument = originalOpenTextDocument;
  stubWorkspace.fs.writeFile = originalWriteFile;
  windowState.reset();
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  panelRegistry.reset();
  windowState.reset();
  memoryFileSystem.reset();
  saveDialogUris.length = 0;
  saveDialogOptions.length = 0;
  fs.writeFileSync(heroDefPath, HERO_DEF, 'utf8');
  stubWorkspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
});

const until = async (predicate: () => boolean, timeoutMs = 2000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('condition not met before deadline');
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};

const htmlOf = (): string => currentPanel().webview.html;

const postedMessages = (): Array<{ command: string; format?: string; data?: unknown }> =>
  currentPanel().webview.postedMessages.map(entry => entry.message) as Array<
    { command: string; format?: string; data?: unknown }
  >;

describe('EntityFlowWebView.show', () => {
  it('renders the flow graph for a named entity', async () => {
    await makeWebView().show('Hero');
    const panel = currentPanel();

    expect(panelRegistry.panels).toHaveLength(1);
    expect(panel.viewType).toBe('kbengine.entityFlow');
    expect(panel.title).toBe('KBEngine 实体架构流程 · Hero');
    expect(panel.showOptions).toBe(ViewColumn.Two);
    expect((panel.options as { enableScripts: boolean }).enableScripts).toBe(true);
    expect(panel.messageListeners).toHaveLength(1);
    expect(panel.disposeListeners).toHaveLength(1);

    const html = htmlOf();
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('graph LR');
    expect(html).toContain('客户端实体');
    expect(html).toContain('baseapp 实体');
    expect(html).toContain('客户端可调');
    expect(html).toContain('客户端调不到');
    expect(html).toContain('导出 Markdown');
    expect(html).toContain('导出 SVG');
    expect(html).toContain('导出 PNG');
    expect(html).toContain('客户端远程调用 base 方法');
    // 引擎出处逐条进面板;旗标与持久标记随成员出现
    expect(html).toContain('引擎出处');
    expect(html).toContain('kbe/src/server/baseapp/entity.cpp:960');
    expect(html).toContain('BASE_AND_CLIENT');
    expect(html).toContain('Persistent');
    expect(html).toContain('客户端调不到的方法');
    expect(html).toContain('bookkeeping');
  });

  it('resolves the entity name from the active def editor', async () => {
    windowish.activeTextEditor = {
      document: {
        languageId: 'kbengine-def',
        uri: Uri.file(path.join(root, 'scripts', 'entity_defs', 'Actor.def'))
      }
    };

    await makeWebView().show();
    expect(htmlOf()).toContain('Actor');
    // 未注册到 entities.xml、也无 cell 脚本:无 cell 参与方
    expect(htmlOf()).not.toContain('cellapp 实体');
  });

  it('asks for a def editor when neither name nor active editor is available', async () => {
    delete windowish.activeTextEditor;

    await makeWebView().show();

    expect(messages.info).toEqual(['请先打开一个实体 .def 文件']);
    expect(panelRegistry.panels).toHaveLength(0);
  });

  it('ignores a non-def active editor', async () => {
    windowish.activeTextEditor = {
      document: { languageId: 'plaintext', uri: Uri.file('/ws/readme.md') }
    };

    await makeWebView().show();
    expect(messages.info).toEqual(['请先打开一个实体 .def 文件']);
    expect(panelRegistry.panels).toHaveLength(0);
  });

  it('warns without opening a panel when the entity is not a registered def', async () => {
    await makeWebView().show('Ghost');

    expect(messages.warning).toEqual(['打开架构流程图失败: Ghost (未找到实体定义)']);
    expect(panelRegistry.panels).toHaveLength(0);
  });

  it('warns without opening a panel when no workspace folder is open', async () => {
    stubWorkspace.workspaceFolders = [];

    await makeWebView().show('Hero');
    expect(messages.warning).toEqual(['打开架构流程图失败: Hero (未找到实体定义)']);
    expect(panelRegistry.panels).toHaveLength(0);
  });

  it('refreshes and reveals the existing panel on a second show', async () => {
    const webview = makeWebView();
    await webview.show('Hero');
    const panel = currentPanel();

    await webview.show('Actor');

    expect(panelRegistry.panels).toHaveLength(1);
    expect(panel.revealed).toBe(true);
    expect(panel.title).toBe('KBEngine 实体架构流程 · Actor');
    expect(htmlOf()).toContain('Actor');
    expect(htmlOf()).not.toContain('bookkeeping');
  });

  it('builds a fresh panel after disposal', async () => {
    const webview = makeWebView();
    await webview.show('Hero');
    const first = currentPanel();

    panelRegistry.fireDispose(first);
    await webview.show('Hero');

    const second = currentPanel();
    expect(panelRegistry.panels).toHaveLength(2);
    expect(second).not.toBe(first);
    expect(second.webview.html).toContain('graph LR');
  });
});

describe('EntityFlowWebView messages', () => {
  it('re-reads the def from disk on refresh', async () => {
    await makeWebView().show('Hero');
    expect(htmlOf()).not.toContain('heal');

    fs.writeFileSync(heroDefPath, HERO_WITH_HEAL_DEF, 'utf8');
    panelRegistry.fireMessage(currentPanel(), { command: 'refresh' });
    await until(() => htmlOf().includes('heal'));

    expect(htmlOf()).toContain('heal');
    expect(messages.warning).toEqual([]);
  });

  it('drops a refresh message before any entity is bound to the panel', async () => {
    const webview = makeWebView();
    await webview.show('Hero');
    const panel = currentPanel();
    const messageListener = panel.messageListeners[0] as (message: unknown) => Promise<void>;
    expect(typeof messageListener).toBe('function');

    (webview as unknown as { currentEntityName: string | null }).currentEntityName = null;

    await messageListener({ command: 'refresh' });
    expect(messages.warning).toEqual([]);
    expect(htmlOf()).toContain('Hero');
  });

  it('opens the declaration file at the member line', async () => {
    await makeWebView().show('Hero');

    panelRegistry.fireMessage(currentPanel(), {
      command: 'openMember',
      filePath: heroDefPath,
      line: 12
    });
    await until(() => windowState.showTextDocumentCalls.length === 1);

    const opened = windowState.showTextDocumentCalls[0].document as { uri: vscode.Uri };
    expect(opened.uri.fsPath).toBe(heroDefPath);
    expect(messages.warning).toEqual([]);
  });

  it('warns when the declaration file cannot be opened', async () => {
    await makeWebView().show('Hero');

    panelRegistry.fireMessage(currentPanel(), {
      command: 'openMember',
      filePath: '/ws/scripts/entity_defs/Broken.def',
      line: 1
    });
    await until(() => messages.warning.length === 1);

    expect(messages.warning[0]).toContain('打开声明失败');
    expect(messages.warning[0]).toContain('cannot open');
  });
});

describe('EntityFlowWebView export', () => {
  const mdPath = '/tmp/kode-flow-out/Hero-flow.md';
  const svgPath = '/tmp/kode-flow-out/Hero-flow.svg';
  const pngPath = '/tmp/kode-flow-out/Hero-flow.png';

  it('warns when there is nothing to export', async () => {
    const webview = makeWebView();
    await webview.show('Hero');
    (webview as unknown as { currentGraph: unknown }).currentGraph = null;

    panelRegistry.fireMessage(currentPanel(), { command: 'export', format: 'markdown' });
    await new Promise(resolve => setTimeout(resolve, 30));

    expect(messages.warning).toEqual(['没有可导出的流程图']);
    expect(postedMessages()).toEqual([]);
  });

  it('silently drops a cancelled export dialog', async () => {
    await makeWebView().show('Hero');
    saveDialogUris.push(undefined);

    panelRegistry.fireMessage(currentPanel(), { command: 'export', format: 'svg' });
    await new Promise(resolve => setTimeout(resolve, 30));

    expect(postedMessages()).toEqual([]);
    expect(messages.warning).toEqual([]);
    expect(saveDialogOptions[0].filters).toEqual({ 'SVG Image': ['svg'] });
  });

  it('writes the markdown artifact without a webview handshake', async () => {
    await makeWebView().show('Hero');
    saveDialogUris.push(Uri.file(mdPath));

    panelRegistry.fireMessage(currentPanel(), { command: 'export', format: 'markdown' });
    await until(() => messages.info.length === 1);

    expect(saveDialogOptions[0].filters).toEqual({ Markdown: ['md'] });
    expect(postedMessages()).toEqual([]);
    const written = memoryFileSystem.files.get(mdPath) as Buffer;
    expect(written.toString('utf8')).toContain('# KBEngine 架构流程图：Hero');
    expect(written.toString('utf8')).toContain('客户端远程调用 base 方法');
    expect(messages.info[0]).toBe(`架构流程图已导出到 ${mdPath}`);
  });

  it('handshakes svg and png exports through the webview', async () => {
    await makeWebView().show('Hero');
    saveDialogUris.push(Uri.file(pngPath));

    panelRegistry.fireMessage(currentPanel(), { command: 'export', format: 'png' });
    await until(() => postedMessages().length === 1);

    expect(postedMessages()).toEqual([{ command: 'beginExport', format: 'png' }]);
    expect(saveDialogOptions[0].filters).toEqual({ 'PNG Image': ['png'] });

    saveDialogUris.push(Uri.file(svgPath));
    panelRegistry.fireMessage(currentPanel(), { command: 'export', format: 'svg' });
    await until(() => postedMessages().length === 2);

    expect(saveDialogOptions[1].filters).toEqual({ 'SVG Image': ['svg'] });
  });

  it('writes svg as utf8 text and reports the target path', async () => {
    await makeWebView().show('Hero');
    saveDialogUris.push(Uri.file(svgPath));

    panelRegistry.fireMessage(currentPanel(), { command: 'export', format: 'svg' });
    await until(() => postedMessages().length === 1);

    panelRegistry.fireMessage(currentPanel(), {
      command: 'exportData',
      format: 'svg',
      data: '<svg xmlns="http://www.w3.org/2000/svg"></svg>'
    });
    await until(() => messages.info.length === 1);

    const written = memoryFileSystem.files.get(svgPath) as Buffer;
    expect(written.toString('utf8')).toBe('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(messages.info[0]).toBe(`架构流程图已导出到 ${svgPath}`);
  });

  it('decodes png data from base64', async () => {
    await makeWebView().show('Hero');
    saveDialogUris.push(Uri.file(pngPath));

    panelRegistry.fireMessage(currentPanel(), { command: 'export', format: 'png' });
    await until(() => postedMessages().length === 1);

    const payload = Buffer.from('PNG-bytes', 'utf8').toString('base64');
    panelRegistry.fireMessage(currentPanel(), { command: 'exportData', format: 'png', data: payload });
    await until(() => messages.info.length === 1);

    const written = memoryFileSystem.files.get(pngPath) as Buffer;
    expect(written.toString('utf8')).toBe('PNG-bytes');
  });

  it('ignores exportData when no export is pending', async () => {
    await makeWebView().show('Hero');

    panelRegistry.fireMessage(currentPanel(), { command: 'exportData', format: 'svg', data: '<svg/>' });
    await new Promise(resolve => setTimeout(resolve, 30));

    expect(memoryFileSystem.files.size).toBe(0);
    expect(messages.info).toEqual([]);
    expect(messages.error).toEqual([]);
  });

  it('fails loudly when the webview reports no data or a format mismatch', async () => {
    await makeWebView().show('Hero');
    saveDialogUris.push(Uri.file(pngPath));

    panelRegistry.fireMessage(currentPanel(), { command: 'export', format: 'png' });
    await until(() => postedMessages().length === 1);

    panelRegistry.fireMessage(currentPanel(), { command: 'exportData', format: 'png', data: null });
    await until(() => messages.error.length === 1);
    expect(messages.error).toEqual(['导出 PNG 失败']);

    saveDialogUris.push(Uri.file(pngPath));
    panelRegistry.fireMessage(currentPanel(), { command: 'export', format: 'png' });
    await until(() => postedMessages().length === 2);

    panelRegistry.fireMessage(currentPanel(), { command: 'exportData', format: 'svg', data: '<svg/>' });
    await until(() => messages.error.length === 2);
    expect(messages.error).toEqual(['导出 PNG 失败', '导出 SVG 失败']);
    expect(memoryFileSystem.files.size).toBe(0);
  });

  it('reports write failures through the error channel', async () => {
    await makeWebView().show('Hero');
    saveDialogUris.push(Uri.file(mdPath));
    stubWorkspace.fs.writeFile = async () => {
      throw new Error('read-only fs');
    };

    try {
      panelRegistry.fireMessage(currentPanel(), { command: 'export', format: 'markdown' });
      await until(() => messages.error.length === 1);
    } finally {
      stubWorkspace.fs.writeFile = originalWriteFile;
    }

    expect(messages.error).toEqual(['写入导出文件失败: Error: read-only fs']);
  });
});

describe('EntityFlowWebView.dispose', () => {
  it('disposes the live panel and tolerates repeated calls', async () => {
    const webview = makeWebView();
    await webview.show('Hero');
    const panel = currentPanel();

    webview.dispose();
    webview.dispose();
    expect(panel.disposed).toBe(true);
  });

  it('disposes without a panel', () => {
    expect(() => makeWebView().dispose()).not.toThrow();
  });
});
