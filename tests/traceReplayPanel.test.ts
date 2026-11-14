import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  panelRegistry,
  Uri,
  window as stubWindow
} from './helpers/vscodeStub';
import { memoryFileSystem } from './fake-vscode/workspaceState';
import { messages, windowState } from './fake-vscode/windowState';
import { TRACE_REPLAY_VIEW_TYPE, TraceReplayPanel } from '../src/traceReplayPanel';
import type { RawMonitoringSession } from '../src/backend/traceImport';

// FLOW-028 面板钉(vscode 控制器薄壳):真实采集工件(session-001.json)
// 经 打开对话框→workspace.fs→导入→串联→回放模型→零脚本静态页 全链入面板;
// 取消=不开面板;导入失败=showErrorMessage 原样报且不开空面板;零脚本硬
// 纪律=enableScripts:false + CSP default-src 'none' + 页内无 <script>。

const FIXTURE = path.join(__dirname, 'fixtures', 'trace', 'session-001.json');
const RAW = JSON.parse(readFileSync(FIXTURE, 'utf8')) as RawMonitoringSession;

const originalOpenDialog = stubWindow.showOpenDialog;

beforeEach(() => {
  windowState.reset();
  panelRegistry.reset();
  memoryFileSystem.reset();
});

afterEach(() => {
  stubWindow.showOpenDialog = originalOpenDialog;
});

const openWith = (fsPath: string): void => {
  stubWindow.showOpenDialog = async () => [Uri.file(fsPath)];
};

describe('FLOW-028 回放面板', () => {
  it('真实采集工件全链入面板:泳道列+徽标+来源备注,零脚本', async () => {
    memoryFileSystem.set(FIXTURE, readFileSync(FIXTURE, 'utf8'));
    openWith(FIXTURE);
    await new TraceReplayPanel().show();

    const panels = panelRegistry.panels;
    expect(panels).toHaveLength(1);
    const panel = panels[0];
    expect(panel.viewType).toBe(TRACE_REPLAY_VIEW_TYPE);
    expect(panel.title).toContain('session-001');
    const html = panel.webview.html;
    // 零脚本硬纪律
    expect(panel.options).toMatchObject({ enableScripts: false });
    expect(html).toContain("default-src 'none'");
    expect(html).not.toContain('<script');
    // 真实工件内容:来源备注与徽标面
    expect(html).toContain('sys-monitoring');
    expect(html).toContain('入口链');
    expect(html).toContain('实例身份');
    // 真实工件帧序入泳道(不手写行号,断言真负载的函数名)
    expect(html).toContain('onClientEnabled');
    expect(html).toContain('workload_login.py');
  });

  it('对话框取消=不开面板、不报错', async () => {
    stubWindow.showOpenDialog = async () => undefined;
    await new TraceReplayPanel().show();
    expect(panelRegistry.panels).toHaveLength(0);
    expect(messages.error).toHaveLength(0);
  });

  it('文件不存在=readFile 抛错→showErrorMessage 且不开面板', async () => {
    openWith('/does-not-exist/session.json');
    await new TraceReplayPanel().show();
    expect(panelRegistry.panels).toHaveLength(0);
    expect(messages.error.length).toBeGreaterThan(0);
    expect(messages.error[0]).toContain('Trace replay failed');
    expect(messages.error[0]).toContain('ENOENT');
  });

  it('来源非法(非 sys-monitoring)=导入面红线抛错→原样报,不开面板', async () => {
    const bogus = JSON.parse(JSON.stringify(RAW)) as RawMonitoringSession;
    bogus.meta.collector = 'py-spy-record';
    memoryFileSystem.set('/ws/trace/bogus.json', JSON.stringify(bogus));
    openWith('/ws/trace/bogus.json');
    await new TraceReplayPanel().show();
    expect(panelRegistry.panels).toHaveLength(0);
    expect(messages.error.length).toBeGreaterThan(0);
    expect(messages.error[0]).toContain('Trace replay failed');
  });
});
