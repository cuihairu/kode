import * as path from 'path';
import * as vscode from 'vscode';
import { parsePythonMethodBlocks, type EntityMappingManager } from './entityMapping';
import {
  buildDefCallChain,
  findDefMethodByStart,
  renderDefCallChainMermaid
} from './backend/defCallChain';
import type { DefCallChain } from './backend/defCallChain';
import { findPythonMethodDeclarations } from './backend/rpcCodeLens';
import { withInteractiveScanBudget } from './hoverBudget';
import {
  CALL_CHAIN_TAB_STATE_KEY,
  normalizeCallChainTab,
  resolveInitialCallChainTab
} from './backend/defCallChainViewLogic';
import { WEBVIEW_THEME_CSS } from './webviewTheme';
import { htmlLang, resolvePanelLocale, strings } from './webviewStrings';
import { CALL_CHAIN_VIEW, supportsDiagnosticsSidebar } from './diagnosticsSidebar';

export interface CallChainPickItem extends vscode.QuickPickItem {
  line: number;
  methodName: string;
}

/** 装配面注入(extension.ts 传真实 context;测试传替身/缺省) */
export interface CallChainControllerContext {
  extensionUri?: vscode.Uri;
  workspaceState?: vscode.Memento;
}

interface CallChainOrigin {
  uri: vscode.Uri;
  position: vscode.Position;
  group?: vscode.TabGroup;
  viewColumn?: vscode.ViewColumn;
}

interface CallChainNavigation {
  version: number;
  origin: CallChainOrigin;
  chain: DefCallChain;
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

export class CallChainController implements vscode.WebviewViewProvider {
  private readonly onDidChangeCodeLensesEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.onDidChangeCodeLensesEmitter.event;
  private panel: vscode.WebviewPanel | null = null;
  private sidebar?: vscode.WebviewView;
  private panelSubscriptions: Array<{ dispose(): void }> = [];
  private commandQueue: Promise<void> = Promise.resolve();
  private navigation?: CallChainNavigation;
  private renderVersion = 0;

  constructor(
    private readonly entityMappingManager: EntityMappingManager,
    private readonly context: CallChainControllerContext = {}
  ) {}

  dispose(): void {
    this.panelSubscriptions.splice(0).forEach(subscription => subscription.dispose());
    this.panel?.dispose();
    this.panel = null;
    this.sidebar = undefined;
    this.navigation = undefined;
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

  async provideCodeLenses(document: vscode.TextDocument, token?: vscode.CancellationToken): Promise<vscode.CodeLens[]> {
    // RUST-149 批 3:取消令牌贯穿——逐方法 def 反查是 await 面;取消/关文档即
    // 停,不继续解析后续方法(与 rpc/property/mroChain CodeLens 同口径)
    const cancelled = () => !!token?.isCancellationRequested || document.isClosed;
    if (cancelled() || !this.enabled() || document.languageId !== 'python') {
      return [];
    }

    const declarations = findPythonMethodDeclarations(document.getText());
    const lenses: vscode.CodeLens[] = [];
    for (const declaration of declarations) {
      if (cancelled()) {
        return [];
      }
      const definition = await this.entityMappingManager.resolveMethodDefinition(
        document.fileName,
        declaration.methodName
      );
      if (!definition) {
        continue;
      }
      if (cancelled()) {
        return [];
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
    return cancelled() ? [] : lenses;
  }

  async showForActiveEditor(
    uri?: vscode.Uri,
    line?: number,
    methodName?: string
  ): Promise<void> {
    const activeEditor = vscode.window.activeTextEditor;
    const editor = !uri || activeEditor?.document.uri.toString() === uri.toString()
      ? activeEditor
      : vscode.window.visibleTextEditors?.find(visible => visible.document.uri.toString() === uri.toString());
    const cursor = editor?.selection?.active;
    const viewColumn = editor?.viewColumn;
    const group = vscode.window.tabGroups?.all.find(candidate => candidate.viewColumn === viewColumn);
    const operation = this.commandQueue.then(() =>
      this.showForActiveEditorInternal(uri, line, methodName, editor?.document, cursor, viewColumn, group)
    );
    this.commandQueue = operation.catch(() => undefined);
    return operation;
  }

  private async showForActiveEditorInternal(
    uri?: vscode.Uri,
    line?: number,
    methodName?: string,
    document?: vscode.TextDocument,
    cursor?: vscode.Position,
    viewColumn?: vscode.ViewColumn,
    group?: vscode.TabGroup
  ): Promise<void> {
    if (!this.enabled()) {
      vscode.window.showInformationMessage('Def call chain hints are disabled');
      return;
    }

    let position: vscode.Position | undefined;
    if ((!uri || !methodName || !line) && document?.languageId === 'python') {
      const enclosing = cursor && this.methodAtCursor(document, cursor.line);
      const selected = await this.pickMethod(document, enclosing);
      uri = document.uri;
      line = selected?.line;
      methodName = selected?.methodName;
      if (enclosing && enclosing.line === line) {
        position = cursor;
      }
    }
    if (!uri || !methodName || !line) {
      vscode.window.showInformationMessage('Open a Python entity script to show a call chain');
      return;
    }

    let index = this.entityMappingManager.getIndexForPythonFile(uri.fsPath);
    if (!index) {
      // 故障 C(2026-11-18 P0):先查已有索引(增量命中即用)——命中不进这里。
      // 未命中才走兜底等待:交互预算(1s)内首扫完成则重查一次,超时即放行
      // 按 miss 收口。旧版在此干等首扫 5s,大树首扫秒级+时命令应答常态卡死。
      const ready = await withInteractiveScanBudget(this.entityMappingManager.waitForInitialScan());
      if (ready) {
        index = this.entityMappingManager.getIndexForPythonFile(uri.fsPath);
      }
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
    await this.showPreview(chain, { uri, position: position ?? new vscode.Position(line - 1, 0), viewColumn, group });
  }

  private methodAtCursor(document: vscode.TextDocument, line: number) {
    const line1 = line + 1;
    return parsePythonMethodBlocks(document.getText(), document.fileName)
      .reverse()
      .find(method => method.line <= line1 && method.endLine >= line1);
  }

  private async pickMethod(
    document: vscode.TextDocument,
    method?: Pick<CallChainPickItem, 'line' | 'methodName'>
  ): Promise<CallChainPickItem | undefined> {
    if (method) {
      const definition = await this.entityMappingManager.resolveMethodDefinition(
        document.fileName, method.methodName
      );
      if (definition) {
        return { label: method.methodName, line: method.line, methodName: method.methodName };
      }
    }
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

  private handleWebviewMessage(message: unknown): void {
    const request = message as { type?: string; tab?: unknown; version?: unknown; node?: unknown } | null;
    const tab = normalizeCallChainTab(request?.tab);
    if (request?.type === 'callChainTab' && tab) {
      void this.context.workspaceState?.update(CALL_CHAIN_TAB_STATE_KEY, tab);
    }
    const navigation = this.navigation;
    if (request?.type !== 'callChainSource' || !navigation || request.version !== navigation.version) {
      return;
    }
    if (request.node === 'origin') {
      void this.openSource(navigation, navigation.origin.uri, navigation.origin.position);
    } else if (typeof request.node === 'number' && Number.isInteger(request.node)) {
      const source = navigation.chain.nodes[request.node]?.source;
      if (source) {
        void this.openSource(navigation, vscode.Uri.file(source.filePath), new vscode.Position(source.line - 1, source.character));
      }
    }
  }

  private async openSource(navigation: CallChainNavigation, uri: vscode.Uri, position: vscode.Position): Promise<void> {
    const { origin } = navigation;
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      if (navigation !== this.navigation) {
        return;
      }
      const panelColumn = this.panel?.viewColumn;
      const groups = vscode.window.tabGroups?.all;
      const sourceGroup = groups?.find(group => group === origin.group && group.viewColumn !== panelColumn);
      const viewColumn = sourceGroup?.viewColumn ??
        groups?.find(group => group.viewColumn === origin.viewColumn && group.viewColumn !== panelColumn)?.viewColumn ??
        groups?.find(group => group.viewColumn !== panelColumn)?.viewColumn ??
        (groups && panelColumn ? vscode.ViewColumn.Beside : origin.viewColumn);
      const target = document.validatePosition(position);
      const selection = new vscode.Range(target, target);
      const editor = await vscode.window.showTextDocument(document, { viewColumn, selection, preview: false });
      editor.revealRange(selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    } catch {
      if (navigation === this.navigation) {
        void vscode.window.showWarningMessage(`${strings(resolvePanelLocale()).defCallChain.sourceUnavailable} ${path.basename(uri.fsPath)}`);
      }
    }
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.sidebar = view;
    view.webview.options = this.panelOptions();
    const messages = view.webview.onDidReceiveMessage(message => this.handleWebviewMessage(message));
    const disposal = view.onDidDispose(() => {
      messages.dispose();
      disposal.dispose();
      if (this.sidebar === view) {
        this.sidebar = undefined;
      }
    });
    if (this.navigation) {
      this.renderSidebar(view, this.navigation.chain);
    } else {
      const t = strings(resolvePanelLocale()).defCallChain;
      view.webview.html = `<!DOCTYPE html><meta charset="utf-8"><p>${t.selectMethod}</p>`;
    }
  }

  private renderSidebar(view: vscode.WebviewView, chain: DefCallChain): void {
    view.description = `${chain.root.entity}.${chain.root.methodName}`;
    view.webview.html = this.html(chain, renderDefCallChainMermaid(chain), view.webview);
  }

  private async showPreview(chain: DefCallChain, origin: CallChainOrigin): Promise<void> {
    this.navigation = { version: ++this.renderVersion, origin, chain };
    if (supportsDiagnosticsSidebar()) {
      if (this.sidebar) {
        this.renderSidebar(this.sidebar, chain);
        this.sidebar.show(true);
      } else {
        await vscode.commands.executeCommand(`${CALL_CHAIN_VIEW}.focus`, { preserveFocus: true });
      }
      return;
    }
    const mermaid = renderDefCallChainMermaid(chain);
    const title = `${strings(resolvePanelLocale()).defCallChain.title} · ${chain.root.entity}.${chain.root.methodName}`;
    if (this.panel) {
      this.panel.title = title;
      this.panel.webview.html = this.html(chain, mermaid);
      this.panel.reveal(undefined, true);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'kbengine.defCallChain',
      title,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
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
        this.navigation = undefined;
      }
    }));
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

  private chainTextHtml(chain: DefCallChain): string {
    const nodes = new Map(chain.nodes.map((node, index) => [node.id, { node, index }]));
    const label = (id: string): string => {
      const entry = nodes.get(id);
      const text = escapeHtml(entry?.node.signature ?? id);
      return entry?.node.source
        ? `<button type="button" class="call-chain-link" data-source-node="${entry.index}">${text}</button>`
        : text;
    };
    return [
      label(chain.root.id),
      ...chain.edges.map(edge => `${label(edge.from)} --${edge.receiver}--&gt; ${label(edge.to)}`)
    ].join('\n');
  }

  private html(chain: DefCallChain, mermaid: string, webview = this.panel?.webview): string {
    const nonce = randomNonce();
    const cspSource = webview?.cspSource ?? 'vscode-webview:';
    const scriptUri = webview && typeof webview.asWebviewUri === 'function' && this.context.extensionUri
      ? String(webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'defCallChainViewer.js')))
      : 'media/defCallChainViewer.js';
    const initialTab = resolveInitialCallChainTab(this.configuredView(), this.storedTab());
    const payload = toEmbeddableJson({
      mermaid,
      version: this.navigation?.version,
      sourceNodes: chain.nodes.flatMap((node, index) => node.source ? [index] : []),
      sourceAction: strings(resolvePanelLocale()).defCallChain.openSource,
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
.call-chain-toolbar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 4px 12px; }
.call-chain-link { max-width: 100%; border: 0; padding: 0; background: transparent; color: var(--vscode-textLink-foreground); font: inherit; text-align: left; text-decoration: underline; cursor: pointer; overflow-wrap: anywhere; }
.call-chain-origin { padding: 4px 0; font-family: var(--kode-ui); font-size: var(--kode-t-meta); }
.call-chain-link:focus-visible, .call-chain-source-node:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
.call-chain-source-node { cursor: pointer; }
.call-chain-source-node:hover .nodeLabel { text-decoration: underline; }
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
  display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: center; padding: 8px 12px;
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
      '<div class="call-chain-toolbar">',
      '<div role="tablist" id="call-chain-tabs" class="call-chain-tabs">',
      `<button type="button" role="tab" id="call-chain-tab-graph" data-call-chain-tab="graph" aria-selected="${initialTab === 'graph' ? 'true' : 'false'}">${t.tabGraph}</button>`,
      `<button type="button" role="tab" id="call-chain-tab-text" data-call-chain-tab="text" aria-selected="${initialTab === 'text' ? 'true' : 'false'}">${t.tabText}</button>`,
      '</div>',
      `<button type="button" class="call-chain-link call-chain-origin" data-source-node="origin">${t.returnToSource}</button>`,
      '</div>',
      `<div class="call-chain-hint">${t.tabHint}</div>`,
      '<div id="call-chain-notice" role="status" class="call-chain-notice kode-notice warn" hidden></div>',
      '</header>',
      `<main><div data-call-chain-pane="graph" data-mermaid="${encodeURIComponent(mermaid)}"${initialTab === 'graph' ? '' : ' hidden'}></div>`,
      `<pre data-call-chain-pane="text"${initialTab === 'text' ? '' : ' hidden'}>${this.chainTextHtml(chain)}</pre></main>`,
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
