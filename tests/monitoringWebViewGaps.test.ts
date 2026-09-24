import { describe, expect, it } from 'vitest';
import { MonitoringWebView } from '../src/monitoringWebView';
import type { MonitoringCollector } from '../src/monitoringCollector';
import type * as vscode from 'vscode';
import { Uri } from './helpers/vscodeStub';

// MonitoringWebView 的 updateWebView 无面板早退:不 show 直接调用,
// 不触碰 collector 的数据读取。updateTimer 字段只有声明与两处清理
// (面板 onDidDispose 与 dispose),没有任何调度赋值点,清理分支内部
// 语句为结构死分支,如实记录不补用例。

const internals = (webview: MonitoringWebView) =>
  webview as unknown as { updateWebView: () => void; panel: unknown };

const makeFakeCollector = () =>
  ({
    onMetricsUpdate: () => ({ dispose: () => undefined }),
    getAllMetrics: () => {
      throw new Error('should not be called');
    },
    getDiagnostics: () => {
      throw new Error('should not be called');
    }
  }) as unknown as MonitoringCollector;

describe('MonitoringWebView updateWebView guard', () => {
  it('returns early from updateWebView without a panel', () => {
    const webview = new MonitoringWebView(
      { extensionUri: Uri.file('/ext/root') } as unknown as vscode.ExtensionContext,
      makeFakeCollector()
    );

    expect(internals(webview).panel).toBeNull();
    expect(() => internals(webview).updateWebView()).not.toThrow();
    expect(internals(webview).panel).toBeNull();
  });
});
