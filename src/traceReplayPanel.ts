/**
 * KFLOW 回放实例级流转面板(FLOW-028 的 vscode 控制器,薄壳):导入 trace
 * 会话 JSON → 串联面(buildTraceCorrelations)→ 回放模型(buildTraceReplayModel)
 * → 零脚本静态页(renderTraceReplayHtml)入 webview。
 *
 * 口径:
 *   - 入口=文件打开对话框选 trace 会话 .json(RawMonitoringSession 形,
 *     FLOW-024/025 采集产物同形);取消=不开面板;
 *   - 数据面全在纯核(backend/traceImport/traceCorrelation/traceReplayModel/
 *     traceReplayHtml),本文件只管 vscode 生命周期;
 *   - 零脚本硬纪律:enableScripts=false——回放页无跳转桥,展示即全量
 *     (候选解释/缺失标记都是静态文本,无交互语义可丢);
 *   - 失败诚实:导入/串联/装配抛错 → showErrorMessage 原样报,不开空面板。
 */

import * as vscode from 'vscode';
import { TextDecoder } from 'node:util';
import { importMonitoringSession } from './backend/traceImport';
import { buildTraceCorrelations } from './backend/traceCorrelation';
import { buildTraceReplayModel } from './backend/traceReplayModel';
import { renderTraceReplayHtml } from './backend/traceReplayHtml';

export interface TraceReplayPanelDeps {
  /** 注入口:默认 vscode.window.showOpenDialog */
  showOpenDialog?: typeof vscode.window.showOpenDialog;
  /** 注入口:默认 vscode.workspace.fs.readFile */
  readFile?: (uri: vscode.Uri) => Thenable<Uint8Array>;
  /** 注入口:默认 vscode.window.createWebviewPanel */
  createWebviewPanel?: typeof vscode.window.createWebviewPanel;
}

export const TRACE_REPLAY_VIEW_TYPE = 'kbengine.flow.traceReplay';

export class TraceReplayPanel {
  private readonly deps: TraceReplayPanelDeps;

  constructor(deps: TraceReplayPanelDeps = {}) {
    this.deps = deps;
  }

  async show(): Promise<void> {
    const openDialog = this.deps.showOpenDialog ?? vscode.window.showOpenDialog.bind(vscode.window);
    const picked = await openDialog({
      canSelectMany: false,
      openLabel: '打开 trace 会话',
      filters: { 'Trace session (json)': ['json'] }
    });
    if (!picked || picked.length === 0) return;

    const readFile = this.deps.readFile ?? ((uri: vscode.Uri) => vscode.workspace.fs.readFile(uri));
    let html: string;
    let sessionId: string;
    try {
      const bytes = await readFile(picked[0]);
      const raw = JSON.parse(new TextDecoder('utf-8').decode(bytes));
      const session = importMonitoringSession(raw, picked[0].fsPath);
      const correlation = buildTraceCorrelations(session);
      const model = buildTraceReplayModel(session, correlation);
      sessionId = session.sessionId;
      html = renderTraceReplayHtml(model, { title: `Trace replay: ${session.sessionId}` });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await vscode.window.showErrorMessage(`Trace replay failed: ${message}`);
      return;
    }

    const createPanel =
      this.deps.createWebviewPanel ?? vscode.window.createWebviewPanel.bind(vscode.window);
    const panel = createPanel(TRACE_REPLAY_VIEW_TYPE, `Trace replay: ${sessionId}`, vscode.ViewColumn.One, {
      enableScripts: false,
      retainContextWhenHidden: false
    });
    panel.webview.html = html;
  }
}
