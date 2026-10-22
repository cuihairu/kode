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
} from './defCallChainViewLogic';

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
    if (!chain) {
      vscode.window.showInformationMessage(`${methodName} is not an indexed entity def method`);
      return;
    }
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

    return [
      '<!DOCTYPE html>',
      '<html>',
      '<head>',
      '<meta charset="utf-8">',
      // CSP:脚本只认扩展自带 bundle(nonce),不加载任何外部/CDN 资源
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: ${cspSource}; style-src 'unsafe-inline'; script-src ${cspSource} 'nonce-${nonce}';">`,
      '<title>KBEngine Def Call Chain</title>',
      '</head>',
      '<body>',
      '<header>',
      '<div role="tablist" id="call-chain-tabs">',
      `<button type="button" role="tab" id="call-chain-tab-graph" data-call-chain-tab="graph" aria-selected="${initialTab === 'graph' ? 'true' : 'false'}">Graph</button>`,
      `<button type="button" role="tab" id="call-chain-tab-text" data-call-chain-tab="text" aria-selected="${initialTab === 'text' ? 'true' : 'false'}">Text</button>`,
      '</div>',
      '<div id="call-chain-notice" role="status" hidden></div>',
      '</header>',
      `<main><div data-call-chain-pane="graph" data-mermaid="${encodeURIComponent(mermaid)}"${initialTab === 'graph' ? '' : ' hidden'}></div>`,
      `<pre data-call-chain-pane="text"${initialTab === 'text' ? '' : ' hidden'}>${escapeHtml(this.chainText(chain))}</pre></main>`,
      `<script type="application/json" id="call-chain-payload" nonce="${nonce}">${payload}</script>`,
      `<script nonce="${nonce}" src="${scriptUri}"></script>`,
      '</body>',
      '</html>'
    ].join('');
  }
}
