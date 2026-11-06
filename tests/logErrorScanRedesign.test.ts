// LogErrorScanView UI 重设计(UI-08):红色警示条改中性大数字汇总条
// (错误感只留给真正的错误数据)、文件清单收成芯片行、命中表签名列等宽;
// 接入统一 token;全部文案走字符串表(zh/en)。
import { beforeEach, describe, expect, it } from 'vitest';
import { LogErrorScanView } from '../src/logErrorScan';
import { configurationOverrides, envState } from './helpers/vscodeStub';

const report = {
  files: [
    { name: 'cellapp.log', lineCount: 18422, errorCount: 37, readError: null },
    { name: 'baseapp.log', lineCount: 0, errorCount: 0, readError: 'ENOENT file' }
  ],
  totalLines: 18422,
  totalErrors: 37,
  hits: [
    {
      count: 12,
      level: 3,
      component: 'dbmgr',
      signature: 'saveAvatar(N) failed: not found',
      lastRaw: 'saveAvatar(4471) failed: not found',
      firstFile: 'cellapp.log',
      firstLine: 100,
      lastTime: new Date(Date.UTC(2026, 10, 6, 8, 30, 39))
    }
  ]
} as unknown as Parameters<LogErrorScanView['renderReport']>[0];

const render = (): string => {
  const webview = new LogErrorScanView({ subscriptions: [] } as unknown as import('vscode').ExtensionContext);
  return (webview as unknown as { getHtml: (r: typeof report) => string }).getHtml(report);
};

beforeEach(() => {
  configurationOverrides.delete('kbengine');
  envState.language = 'zh-cn';
});

describe('LogErrorScanView 设计系统', () => {
  it('token 进面板,level 徽标旧红退场', () => {
    const html = render();
    expect(html).toContain('--kode-ok:#89d185');
    expect(html).not.toContain('#F44336');
    expect(html).not.toContain('#D32F2F');
  });

  it('汇总条改中性大数字,红色只留给错误计数', () => {
    const html = render();
    expect(html).toContain('class="scan-sum"');
    expect(html).toContain('class="sum-v err"');
    expect(html).not.toContain('inputValidation-errorBackground');
  });

  it('文件清单收成芯片行(含读取失败态)', () => {
    const html = render();
    expect(html).toContain('scan-file-chip');
    expect(html).toContain('scan-file-chip bad');
  });
});

describe('LogErrorScanView i18n', () => {
  it('zh:沿用现有中文文案', () => {
    const html = render();
    expect(html).toContain('重新扫描');
    expect(html).toContain('扫描文件');
    expect(html).toContain('读取失败: ENOENT file');
    const webview = new LogErrorScanView({ subscriptions: [] } as unknown as import('vscode').ExtensionContext);
    const noHits = { files: report.files, totalLines: 1, totalErrors: 0, hits: [] } as unknown as typeof report;
    expect((webview as unknown as { getHtml: (r: typeof report) => string }).getHtml(noHits)).toContain('未发现 ERROR/CRITICAL 行');
  });

  it('en:kbengine.webviewLocale=en 输出英文面板', () => {
    configurationOverrides.set('kbengine', { webviewLocale: 'en' });
    const html = render();
    expect(html).toContain('Rescan');
    expect(html).toContain('Scanned files');
    expect(html).toContain('Read failed: ENOENT file');
    expect(html).not.toContain('重新扫描');
  });

  it('空文件清单回落 zh 空态', () => {
    const webview = new LogErrorScanView({ subscriptions: [] } as unknown as import('vscode').ExtensionContext);
    const empty = { files: [], totalLines: 0, totalErrors: 0, hits: [] } as unknown as typeof report;
    const html = (webview as unknown as { getHtml: (r: typeof report) => string }).getHtml(empty);
    expect(html).toContain('没有可扫描的日志文件');
  });
});
