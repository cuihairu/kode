import * as path from 'path';
import * as vscode from 'vscode';
import type { EntityMappingManager } from './entityMapping';
import {
  buildDefCallChain,
  findDefMethodByStart,
  renderDefCallChainMermaid
} from './defCallChain';
import type { DefCallChain } from './defCallChain';
import { findPythonMethodDeclarations } from './rpcCodeLens';
import { withInitialScanTimeout } from './hoverBudget';
import {
  CALL_CHAIN_TAB_STATE_KEY,
  normalizeCallChainTab,
  resolveInitialCallChainTab
} from './backend/defCallChainViewLogic';
import { WEBVIEW_THEME_CSS } from './webviewTheme';
import { htmlLang, resolvePanelLocale, strings } from './webviewStrings';

export interface CallChainPickItem extends vscode.QuickPickItem {
  line: number;
  methodName: string;
}

/** 装配面注入(extension.ts 传真实 context;测试传替身/缺省) */
export interface CallChainControllerContext {
  extensionUri?: vscode.Uri;
  workspaceState?: vscode.Memento;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function toEmbeddableJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

export class CallChainController {
  private readonly onDidChangeCodeLensesEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.onDidChangeCodeLensesEmitter.event;
  private panel: vscode.WebviewPanel | null = null;
  private panelSubscriptions: Array<{ dispose(): void }> = [];
  private commandQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly entityMappingManager: EntityMappingManager,
    private readonly context: CallChainControllerContext = {}
  ) {}

  dispose(): void {
    this.panelSubscriptions.splice(0).forEach(subscription => subscription.dispose());
    this.panel?.dispose();
    this.panel = null;
    this.onDidChangeCodeLensesEmitter.dispose();
  }

  fireConfigurationChanged(): void {
    this.onDidChangeCodeLensesEmitter.fire();
  }

  private enabled(): boolean {
    return vscode.workspace.getConfiguration('kbengine.python')
      .get<boolean>('callChainHints', true);
  }

  /** kbengine.python.callChainView:graph(默认)|text */
  private configuredView(): string {
    return vscode.workspace.getConfiguration('kbengine.python')
      .get<string>('callChainView', 'graph');
  }

  private storedTab(): unknown {
    return this.context.workspaceState?.get<unknown>(CALL_CHAIN_TAB_STATE_KEY) ?? null;
  }

  async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    if (!this.enabled() || document.languageId !== 'python') {
      return [];
    }

    const declarations = findPythonMethodDeclarations(document.getText());
    const lenses: vscode.CodeLens[] = [];
    for (const declaration of declarations) {
      const definition = await this.entityMappingManager.resolveMethodDefinition(
        document.fileName,
        declaration.methodName
      );
      if (!definition) {
        continue;
      }
      lenses.push(new vscode.CodeLens(
        new vscode.Range(declaration.line, declaration.character, declaration.line, declaration.character),
        {
          title: 'Call Chain',
          command: 'kbengine.python.showCallChain',
          arguments: [document.uri, declaration.line + 1, declaration.methodName]
        }
      ));
    }
    return lenses;
  }

  async showForActiveEditor(
    uri?: vscode.Uri,
    line?: number,
    methodName?: string
  ): Promise<void> {
    const operation = this.commandQueue.then(() =>
      this.showForActiveEditorInternal(uri, line, methodName)
    );
    this.commandQueue = operation.catch(() => undefined);
    return operation;
  }

  private async showForActiveEditorInternal(
    uri?: vscode.Uri,
    line?: number,
    methodName?: string
  ): Promise<void> {
    if (!this.enabled()) {
      vscode.window.showInformationMessage('Def call chain hints are disabled');
      return;
    }

    let selected: CallChainPickItem | undefined;
    const editor = vscode.window.activeTextEditor;
    if ((!uri || !methodName || !line) && editor?.document.languageId === 'python') {
      selected = await this.pickMethod(editor.document);
      uri = editor.document.uri;
      line = selected?.line;
      methodName = selected?.methodName;
    }
    if (!uri || !methodName || !line) {
      vscode.window.showInformationMessage('Open a Python entity script to show a call chain');
      return;
    }

    let index = this.entityMappingManager.getIndexForPythonFile(uri!.fsPath);
    if (!index) {
      // 首扫超时闸(用户令 2026-10-22):大树首扫可秒级+,不拖死命令应答
      await withInitialScanTimeout(this.entityMappingManager.waitForInitialScan());
      index = this.entityMappingManager.getIndexForPythonFile(uri!.fsPath);
    }
    if (!index) {
      vscode.window.showInformationMessage(`No entity mapping found for ${path.basename(uri.fsPath)}`);
      return;
    }

    const startDefinition = findDefMethodByStart(index, { filePath: uri.fsPath, line, methodName });
    if (!startDefinition) {
      vscode.window.showInformationMessage(`${methodName} is not an indexed entity def method`);
      return;
    }

    const chain = buildDefCallChain(index, { filePath: uri.fsPath, line, methodName });
    // 重复守卫无触发输入——buildDefCallChain 内部先用同一 key 重跑
    // findDefMethodByStart,其上一步(startDefinition)已非空,且两处调用间无
    // await,索引不变,chain 恒非空;tests/cov-defcallchain.test.ts 以「索引有
    // 但起点未登记」用例锁死上一守卫。
    /* istanbul ignore start */
    if (!chain) {
      vscode.window.showInformationMessage(`${methodName} is not an indexed entity def method`);
      return;
    }
    /* istanbul ignore stop */
    this.showPreview(chain);
  }

  private async pickMethod(
    document: vscode.TextDocument
  ): Promise<CallChainPickItem | undefined> {
    const declarations = findPythonMethodDeclarations(document.getText());
    if (declarations.length === 0) {
      return undefined;
    }
    const checked = await Promise.all(declarations.map(async declaration => ({
      declaration,
      definition: await this.entityMappingManager.resolveMethodDefinition(
        document.fileName,
        declaration.methodName
      )
    })));
    const items = checked
      .filter(item => item.definition)
      .map(item => ({
        label: item.declaration.methodName,
        description: item.definition?.section,
        line: item.declaration.line + 1,
        methodName: item.declaration.methodName
      }));
    if (items.length === 0) {
      return undefined;
    }
    if (items.length === 1) {
      return items[0];
    }
    return await vscode.window.showQuickPick(items, {
      placeHolder: 'Select an entity method'
    }) as CallChainPickItem | undefined;
  }

  /** tab 选择持久到工作区状态(webview 消息驱动;无 workspaceState 时不记忆) */
  private handleWebviewMessage(message: unknown): void {
    const tab = normalizeCallChainTab(
      (message as { type?: string; tab?: unknown } | null)?.tab
    );
    if ((message as { type?: string } | null)?.type === 'callChainTab' && tab) {
      void this.context.workspaceState?.update(CALL_CHAIN_TAB_STATE_KEY, tab);
    }
  }

  private showPreview(chain: DefCallChain): void {
    const mermaid = renderDefCallChainMermaid(chain);
    if (this.panel) {
      this.panel.webview.html = this.html(chain, mermaid);
      this.panel.reveal();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'kbengine.defCallChain',
      'KBEngine Def Call Chain',
      vscode.ViewColumn.Beside,
      this.panelOptions()
    );
    this.panel = panel;
    this.panel.webview.html = this.html(chain, mermaid);
    this.panelSubscriptions.push(panel.webview.onDidReceiveMessage(message =>
      this.handleWebviewMessage(message)
    ));
    this.panelSubscriptions.push(panel.onDidDispose(() => {
      if (this.panel === panel) {
        this.panel = null;
      }
    }));
    this.panel = panel;
  }

  private panelOptions(): vscode.WebviewPanelOptions & vscode.WebviewOptions {
    if (this.context.extensionUri) {
      // webview 脚本(media/defCallChainViewer.js,mermaid 已打包)只从扩展自带媒体目录加载
      return {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
      };
    }
    return { enableScripts: true };
  }

  /** 文本链(兜底视图/无脚本宿主可见) */
  private chainText(chain: DefCallChain): string {
    return [
      chain.root.signature,
      ...chain.edges.map(edge => {
        const target = chain.nodes.find(node => node.id === edge.to);
        return `${edge.from} --${edge.receiver}--> ${target?.signature ?? edge.to}`;
      })
    ].join('\n');
  }

  private html(chain: DefCallChain, mermaid: string): string {
    const nonce = randomNonce();
    const webview = this.panel?.webview;
    const cspSource = webview?.cspSource ?? 'vscode-webview:';
    const scriptUri = webview && typeof webview.asWebviewUri === 'function' && this.context.extensionUri
      ? String(webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'defCallChainViewer.js')))
      : 'media/defCallChainViewer.js';
    const initialTab = resolveInitialCallChainTab(this.configuredView(), this.storedTab());
    const payload = toEmbeddableJson({
      mermaid,
      text: this.chainText(chain),
      configView: this.configuredView(),
      storedTab: initialTab
    });
    const t = strings(resolvePanelLocale()).defCallChain;

    return [
      '<!DOCTYPE html>',
      `<html lang="${htmlLang(resolvePanelLocale())}">`,
      '<head>',
      '<meta charset="utf-8">',
      // CSP:脚本只认扩展自带 bundle(nonce),不加载任何外部/CDN 资源
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: ${cspSource}; style-src 'unsafe-inline'; script-src ${cspSource} 'nonce-${nonce}';">`,
      `<title>${t.title}</title>`,
      '<style>',
      WEBVIEW_THEME_CSS,
      `
/* UI-07:唯一零 CSS 壳面板补上系统——样式化页签 + warn notice + 三色图例 */
body { padding: 0; }
header { padding: 10px 16px 0; border-bottom: 1px solid var(--kode-border); background: var(--kode-surface); }
.call-chain-tabs { display: flex; gap: 4px; }
.call-chain-tabs [role="tab"] {
  padding: 6px 16px; font-size: var(--kode-t-meta); color: var(--kode-fg-3);
  border: 1px solid transparent; border-bottom: none; border-radius: 4px 4px 0 0;
  cursor: pointer; background: transparent; font-family: var(--kode-ui);
}
.call-chain-tabs [role="tab"]:hover { color: var(--kode-fg-2); }
.call-chain-tabs [role="tab"][aria-selected="true"] {
  color: #fff; background: var(--kode-surface-2); border-color: var(--kode-border);
}
.call-chain-notice { margin: 10px 16px; }
.call-chain-hint { padding: 0 16px 6px; font-size: var(--kode-t-tag); color: var(--kode-fg-4); }
.call-chain-legend {
  display: flex; gap: 16px; align-items: center; padding: 8px 16px;
  border-top: 1px solid var(--kode-border); background: var(--kode-surface);
  font-size: var(--kode-t-meta); color: var(--kode-fg-3); position: fixed; bottom: 0; left: 0; right: 0;
}
.call-chain-legend .li { display: flex; gap: 6px; align-items: center; }
.call-chain-legend .dot { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
main { padding: 12px 16px 56px; }
pre { font-family: var(--kode-mono); font-size: 12.5px; color: var(--kode-fg-2); white-space: pre-wrap; }`,
      '</style>',
      '</head>',
      '<body>',
      '<header>',
      '<div role="tablist" id="call-chain-tabs" class="call-chain-tabs">',
      `<button type="button" role="tab" id="call-chain-tab-graph" data-call-chain-tab="graph" aria-selected="${initialTab === 'graph' ? 'true' : 'false'}">${t.tabGraph}</button>`,
      `<button type="button" role="tab" id="call-chain-tab-text" data-call-chain-tab="text" aria-selected="${initialTab === 'text' ? 'true' : 'false'}">${t.tabText}</button>`,
      '</div>',
      `<div class="call-chain-hint">${t.tabHint}</div>`,
      '<div id="call-chain-notice" role="status" class="call-chain-notice kode-notice warn" hidden></div>',
      '</header>',
      `<main><div data-call-chain-pane="graph" data-mermaid="${encodeURIComponent(mermaid)}"${initialTab === 'graph' ? '' : ' hidden'}></div>`,
      `<pre data-call-chain-pane="text"${initialTab === 'text' ? '' : ' hidden'}>${escapeHtml(this.chainText(chain))}</pre></main>`,
      `<div class="call-chain-legend" id="call-chain-legend">` +
      `<span class="li"><span class="dot" style="background:#1d3a2a;border:1px solid #89d185"></span>${t.legendCell}</span>` +
      `<span class="li"><span class="dot" style="background:#173a5e;border:1px solid #3794ff"></span>${t.legendBase}</span>` +
      `<span class="li"><span class="dot" style="background:#3a2d10;border:1px solid #cca700"></span>${t.legendClient}</span>` +
      `</div>`,
      `<script type="application/json" id="call-chain-payload" nonce="${nonce}">${payload}</script>`,
      `<script nonce="${nonce}" src="${scriptUri}"></script>`,
      '</body>',
      '</html>'
    ].join('');
  }
}
