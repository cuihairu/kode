// LogViewerWebView UI 重设计(UI-02):
// - 组件过滤按业务域分组(optgroup:核心服务/管理进程/游戏进程);
// - 面板接入 webviewTheme 统一 token(级别边条旧蓝图/橙/红退场);
// - 全部文案走 webviewStrings(zh 默认/en 全量)。
import { beforeEach, describe, expect, it } from 'vitest';
import type { LogEntry } from '../src/backend/logParser';
import { LogViewerWebView } from '../src/logWebView';
import { configurationOverrides, envState } from './helpers/vscodeStub';

const makeWebView = () =>
  new LogViewerWebView(
    {} as unknown as import('vscode').ExtensionContext,
    { getStatusSummary: () => 'FAKE STATUS', onLogEntry: () => ({ dispose: () => undefined }) } as never
  );

const internals = (webview: LogViewerWebView) =>
  webview as unknown as { getHtml: (logs: LogEntry[]) => string };

const entry = (over: Partial<LogEntry> = {}): LogEntry => ({
  timestamp: new Date(Date.UTC(2026, 8, 24, 12, 0, 0)),
  level: 1,
  component: 'cellapp',
  message: 'boot sequence',
  raw: 'boot sequence',
  ...over
} as LogEntry);

const render = (): string => internals(makeWebView()).getHtml([entry()]);

beforeEach(() => {
  configurationOverrides.delete('kbengine');
  envState.language = 'zh-cn';
});

describe('LogViewerWebView 过滤分组化', () => {
  it('组件过滤按业务域 optgroup 分组:核心服务/管理进程/游戏进程', () => {
    const html = render();
    expect(html).toContain('<optgroup label="核心服务">');
    expect(html).toContain('<optgroup label="管理进程">');
    expect(html).toContain('<optgroup label="游戏进程">');
    // machine/logger/dbmgr 归核心服务;cellapp/baseapp 归游戏进程
    const core = html.slice(html.indexOf('核心服务'), html.indexOf('管理进程'));
    expect(core).toContain('machine');
    expect(core).toContain('logger');
    expect(core).toContain('dbmgr');
    const game = html.slice(html.indexOf('游戏进程'));
    expect(game).toContain('baseapp');
    expect(game).toContain('cellapp');
  });
});

describe('LogViewerWebView 设计系统', () => {
  it('token 进面板,级别边条旧色退场', () => {
    const html = render();
    expect(html).toContain('--kode-ok:#89d185');
    expect(html).toContain('--kode-warn:#cca700');
    expect(html).not.toContain('#2196F3');
    expect(html).not.toContain('#FF9800');
    expect(html).not.toContain('#F44336');
    expect(html).not.toContain('#D32F2F');
  });
});

describe('LogViewerWebView i18n', () => {
  it('zh:工具条沿用现有中文文案', () => {
    const html = render();
    expect(html).toContain('搜索日志...');
    expect(html).toContain('所有级别');
    expect(html).toContain('清空');
    expect(html).toContain('断开');
    const emptyHtml = internals(makeWebView()).getHtml([]);
    expect(emptyHtml).toContain('暂无日志');
  });

  it('en:kbengine.webviewLocale=en 输出英文面板', () => {
    configurationOverrides.set('kbengine', { webviewLocale: 'en' });
    const html = render();
    expect(html).toContain('Search logs...');
    expect(html).toContain('All levels');
    expect(html).toContain('Clear');
    expect(html).toContain('Disconnect');
    expect(html).toContain('Core services');
    expect(html).not.toContain('所有级别');
  });

  it('en:统计条与空态本地化', () => {
    configurationOverrides.set('kbengine', { webviewLocale: 'en' });
    const html = render();
    expect(html).toContain('Showing 1 entries (total 0)');
  });
});
