/**
 * 配置合并可视化面板控制器(SRC-012,docs/design/config-visualization.md
 * §10):只管 vscode 生命周期、消息派发与 `$/kode/config/resolve` 送达。
 * 三树投影在 configVisualizerModel.ts(纯函数),壳 HTML 在
 * configVisualizerPanelHtml.ts(纯字符串)——本文件不拼 HTML、不碰树形。
 *
 * ok/降级分流(AUDIT-007 后口径):resolve 失败经 TS 回落臂出 ok=true
 * (configVisualizerModel 照常投影回落产物),error 态只剩门未接线瞬态;
 * 仅「无工作区 / 无 defaults 文件」两个空态由控制器判定(errorKind),
 * 数据面真值一律出自 core 回包或回落核。
 */

import * as vscode from 'vscode';
import {
  ensureConfigResolved,
  invalidateConfigResolved,
  type ConfigResolvedState
} from './serverConfigResolve';
import {
  buildConfigVizKeyDetail,
  buildConfigVizSummary,
  type ConfigVizKeyDetail,
  type ConfigVizSummary,
  type ConfigVizTreeInput
} from './configVisualizerModel';
import { renderConfigVisualizerWebview } from './configVisualizerPanelHtml';
import { randomNonce } from './webviewSecurity';
import { resolvePanelLocale, strings } from './webviewStrings';

/** §6 回包信封;errorKind 缺省 = 解析失败(非空态,进 §8 error) */
type ConfigVizResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; errorKind?: 'no-workspace' | 'no-config' };

/** webview → 控制器消息(§6 入站:ready/refresh/selectKey/copyFragment/openSource) */
interface ConfigVizWebviewMessage {
  command: string;
  sectionId?: string;
  path?: string;
  file?: string;
}

export class ConfigVisualizerPanel {
  private panel: vscode.WebviewPanel | null = null;
  /** 画代(§5.5):每次 resolve 请求自增;await 返回后代不齐即弃写 */
  private refreshSeq = 0;
  /** 最近一次送达的 resolve 态(keyDetail/copy/openSource 的数据源) */
  private lastState: ConfigResolvedState | null = null;
  private lastSummary: ConfigVizSummary | null = null;

  async show(): Promise<void> {
    if (this.panel) {
      this.panel.reveal();
      await this.resolveAndSend(false);
      return;
    }
    const t = strings(resolvePanelLocale()).configVisualizer;
    this.panel = vscode.window.createWebviewPanel(
      'kbengine.configVisualizer',
      t.title,
      vscode.ViewColumn.Two,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel.onDidDispose(() => {
      this.panel = null;
    });
    this.panel.webview.onDidReceiveMessage((message: ConfigVizWebviewMessage) => {
      void this.onMessage(message);
    });
    this.panel.webview.html = renderConfigVisualizerWebview({
      title: t.title,
      nonce: randomNonce()
    });
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = null;
  }

  private async onMessage(message: ConfigVizWebviewMessage): Promise<void> {
    switch (message.command) {
      case 'ready':
        await this.resolveAndSend(false);
        break;
      case 'refresh':
        await this.resolveAndSend(true);
        break;
      case 'selectKey':
        if (typeof message.sectionId === 'string' && typeof message.path === 'string') {
          this.sendKeyDetail(message.sectionId, message.path);
        }
        break;
      case 'copyFragment':
        await this.copyFragment(message.sectionId, message.path);
        break;
      case 'openSource':
        await this.openSource(message.file);
        break;
    }
  }

  /** 画代守卫(§5.5):面板仍在 + 代未换代;旧代回包静默弃置,客户端另有 generation >= 单调闸双保险(§6.1-2) */
  private canWrite(seq: number): boolean {
    return this.panel !== null && seq === this.refreshSeq;
  }

  private post(message: unknown): void {
    void this.panel?.webview.postMessage(message);
  }

  private treeInput(state: ConfigResolvedState): ConfigVizTreeInput {
    return {
      defaultsTree: state.defaultsTree,
      customTree: state.customTree,
      merged: state.merged,
      defaultsPath: state.defaultsPath,
      customPath: state.customPath
    };
  }

  /**
   * resolve → 六态分流(§8)→ resolveState 送达。force=true(刷新按钮)
   * 先失效缓存再重取,否则同代同指纹下 ensureConfigResolved 直接回落缓存,
   * 刷新成为空操作。
   */
  private async resolveAndSend(force: boolean): Promise<void> {
    const seq = ++this.refreshSeq;
    const t = strings(resolvePanelLocale()).configVisualizer;
    const result = await this.resolveResult(t, force);
    if (!this.canWrite(seq)) {
      return;
    }
    this.post({ command: 'resolveState', generation: seq, result });
  }

  private async resolveResult(
    t: ReturnType<typeof strings>['configVisualizer'],
    force: boolean
  ): Promise<ConfigVizResult<ConfigVizSummary>> {
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
      this.lastState = null;
      this.lastSummary = null;
      return { ok: false, error: t.emptyNoWorkspace, errorKind: 'no-workspace' };
    }
    if (force) {
      invalidateConfigResolved();
    }
    let state: ConfigResolvedState;
    try {
      state = await ensureConfigResolved();
    } catch (error) {
      this.lastState = null;
      this.lastSummary = null;
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    this.lastState = state;
    if (!state.ok) {
      // AUDIT-007 后此分支只剩门未接线瞬态(RPC 失败已由回落臂出 ok=true)
      this.lastSummary = null;
      return { ok: false, error: state.reason ?? t.errorState };
    }
    const summary = buildConfigVizSummary(this.treeInput(state), {
      truncateNote: chars => t.valueTruncated(chars)
    });
    if (!summary) {
      // core ok 但树缺失(理论上不可达;防御性如实空态,不伪造三态)
      this.lastSummary = null;
      return { ok: false, errorKind: 'no-config', error: t.emptyNoConfig };
    }
    this.lastSummary = summary;
    return { ok: true, data: summary };
  }

  /** 键详情懒取(§6):不换代号,客户端按 exact-match 代闸弃过期 */
  private sendKeyDetail(sectionId: string, path: string): void {
    const seq = this.refreshSeq;
    const t = strings(resolvePanelLocale()).configVisualizer;
    const detail = this.lastState?.ok
      ? buildConfigVizKeyDetail(this.treeInput(this.lastState), sectionId, path, vscode.env.language)
      : null;
    const result: ConfigVizResult<ConfigVizKeyDetail> = detail
      ? { ok: true, data: detail }
      : { ok: false, error: t.errorState };
    this.post({ command: 'keyDetail', generation: seq, result });
  }

  private async copyFragment(sectionId?: string, path?: string): Promise<void> {
    const t = strings(resolvePanelLocale()).configVisualizer;
    try {
      if (sectionId === undefined || path === undefined || !this.lastState || !this.lastState.ok) {
        throw new Error(t.errorState);
      }
      const detail = buildConfigVizKeyDetail(
        this.treeInput(this.lastState),
        sectionId,
        path,
        vscode.env.language
      );
      if (!detail) {
        throw new Error(t.errorState);
      }
      await vscode.env.clipboard.writeText(detail.fragmentXml);
      this.post({ command: 'copyDone', result: { ok: true } });
    } catch (error) {
      this.post({
        command: 'copyDone',
        result: { ok: false, error: error instanceof Error ? error.message : String(error) }
      });
    }
  }

  private async openSource(file?: string): Promise<void> {
    if (!this.lastState || (file !== 'defaults' && file !== 'custom')) {
      return;
    }
    const fsPath = file === 'defaults' ? this.lastState.defaultsPath : this.lastState.customPath;
    if (!fsPath) {
      return;
    }
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(fsPath));
    await vscode.window.showTextDocument(document, { preview: true });
  }
}
