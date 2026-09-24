import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { KBEngineLogCollector } from '../src/logCollector';
import { LogViewerWebView } from '../src/logWebView';
import type * as vscode from 'vscode';
import { Uri, window as stubWindow } from './helpers/vscodeStub';

// LogViewerWebView 的面板状态守卫:updateWebView 在无面板时的早退、
// dispose 释放面板并置空(幂等)。面板经 monkey-patch 的假例承载。

interface StubPanel {
  viewType: string;
  revealCalls: number;
  disposed: boolean;
  webview: {
    html: string;
    onDidReceiveMessage: (handler: (message: unknown) => void) => unknown;
  };
  onDidDispose: (handler: () => void) => unknown;
  reveal: () => void;
  dispose: () => void;
}

const windowish = stubWindow as unknown as Record<string, unknown>;
const panels: StubPanel[] = [];
const originals: Record<string, unknown> = {};

const makeCollector = () =>
  new KBEngineLogCollector(
    {
      host: '127.0.0.1',
      port: 30000,
      autoReconnect: false,
      reconnectInterval: 1000,
      maxBufferSize: 100
    },
    {} as unknown as vscode.ExtensionContext
  );

const internals = (webview: LogViewerWebView): {
  panel: StubPanel | null;
  updateWebView: () => void;
} => webview as unknown as never;

beforeAll(() => {
  originals.createWebviewPanel = windowish.createWebviewPanel;
  windowish.createWebviewPanel = (
    viewType: string
  ) => {
    const panel: StubPanel = {
      viewType,
      revealCalls: 0,
      disposed: false,
      webview: {
        html: '',
        onDidReceiveMessage: () => ({ dispose: () => undefined })
      },
      onDidDispose: () => ({ dispose: () => undefined }),
      reveal: () => {
        panel.revealCalls += 1;
      },
      dispose: () => {
        panel.disposed = true;
      }
    };
    panels.push(panel);
    return panel;
  };

  // extensionUri 仅用于 localResourceRoots,给一个可 join 的假例
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-logview-gap-'));
  (globalThis as { __logViewGapRoot?: string }).__logViewGapRoot = tmp;
});

afterAll(() => {
  windowish.createWebviewPanel = originals.createWebviewPanel;
  const tmp = (globalThis as { __logViewGapRoot?: string }).__logViewGapRoot;
  if (tmp) {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

afterEach(() => {
  panels.length = 0;
});

describe('LogViewerWebView panel guards', () => {
  it('returns early from updateWebView without a panel', () => {
    const webview = new LogViewerWebView(
      { extensionUri: Uri.file('/tmp/kode-logview-gap') } as unknown as vscode.ExtensionContext,
      makeCollector()
    );

    // 无面板:早退,不触发面板创建
    expect(() => internals(webview).updateWebView()).not.toThrow();
    expect(panels).toHaveLength(0);
  });

  it('disposes the panel and clears it, remaining idempotent', () => {
    const webview = new LogViewerWebView(
      { extensionUri: Uri.file('/tmp/kode-logview-gap') } as unknown as vscode.ExtensionContext,
      makeCollector()
    );

    webview.show();
    expect(panels).toHaveLength(1);
    expect(internals(webview).panel).toBe(panels[0]);
    expect(panels[0].revealCalls).toBe(0);

    webview.dispose();
    expect(panels[0].disposed).toBe(true);
    expect(internals(webview).panel).toBeNull();

    // 二次 dispose:panel 守卫直接跳过
    expect(() => webview.dispose()).not.toThrow();
    expect(panels[0].disposed).toBe(true);
  });

  it('reveals the existing panel on a second show', () => {
    const webview = new LogViewerWebView(
      { extensionUri: Uri.file('/tmp/kode-logview-gap') } as unknown as vscode.ExtensionContext,
      makeCollector()
    );

    webview.show();
    webview.show();
    expect(panels).toHaveLength(1);
    expect(panels[0].revealCalls).toBe(1);

    webview.dispose();
  });
});
