import * as vscode from 'vscode';
import {
  discoverLocalComponents,
  querySpaces,
  queryWatcherPath,
  type KBEngineComponentInfo,
  type SpaceQueryResult,
  type WatcherQueryResult
} from './kbengineProtocol';

export interface RuntimeQueryProtocol {
  discoverComponents(timeoutMs?: number): Promise<KBEngineComponentInfo[]>;
  querySpaces(component: KBEngineComponentInfo, timeoutMs?: number): Promise<SpaceQueryResult>;
  queryWatcherPath(
    component: KBEngineComponentInfo,
    path: string,
    timeoutMs?: number
  ): Promise<WatcherQueryResult[]>;
}

export const defaultRuntimeQueryProtocol: RuntimeQueryProtocol = {
  discoverComponents: (timeoutMs?: number) => discoverLocalComponents({ timeoutMs }),
  querySpaces,
  queryWatcherPath
};

interface RuntimeQueryMessage {
  command: 'refresh' | 'querySpaces' | 'queryWatcher';
  componentKey?: unknown;
  path?: unknown;
}

type RuntimeQueryError =
  | { kind: 'discovery'; message: string }
  | { kind: 'spaces'; componentKey: string; message: string }
  | { kind: 'watcher'; componentKey: string; message: string };

export class RuntimeQueryWebView {
  private panel: vscode.WebviewPanel | null = null;
  private components: KBEngineComponentInfo[] = [];
  private error: RuntimeQueryError | null = null;

  constructor(
    private context: vscode.ExtensionContext,
    private protocol: RuntimeQueryProtocol = defaultRuntimeQueryProtocol
  ) {}

  show(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'kbengine.runtimeQuery',
      'KBEngine Runtime Queries',
      vscode.ViewColumn.Two,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel.webview.html = this.render();
    this.panel.webview.onDidReceiveMessage(
      message => void this.handleMessage(message as RuntimeQueryMessage),
      undefined,
      this.context.subscriptions
    );
    this.panel.onDidDispose(
      () => {
        this.panel = null;
      },
      undefined,
      this.context.subscriptions
    );
    void this.refresh();
  }

  private async handleMessage(message: RuntimeQueryMessage): Promise<void> {
    if (message.command === 'refresh') {
      await this.refresh();
      return;
    }

    const componentKey = typeof message.componentKey === 'string' ? message.componentKey : '';
    const component = this.findComponent(componentKey);
    if (!component) {
      this.error = {
        kind: message.command === 'querySpaces' ? 'spaces' : 'watcher',
        componentKey,
        message: 'Select a running component first.'
      };
      this.postState();
      return;
    }

    if (message.command === 'querySpaces') {
      try {
        const spaces = await this.protocol.querySpaces(component, 1200);
        this.postState({ spaces: [spaces] });
      } catch (error) {
        this.error = { kind: 'spaces', componentKey, message: errorMessage(error) };
        this.postState();
      }
      return;
    }

    const path = typeof message.path === 'string' ? message.path.trim() : '';
    if (!path) {
      this.error = { kind: 'watcher', componentKey, message: 'Enter a watcher path.' };
      this.postState();
      return;
    }

    try {
      const watchers = await this.protocol.queryWatcherPath(component, path, 1200);
      this.postState({ watchers });
    } catch (error) {
      this.error = { kind: 'watcher', componentKey, message: errorMessage(error) };
      this.postState();
    }
  }

  private async refresh(): Promise<void> {
    this.error = null;
    try {
      this.components = await this.protocol.discoverComponents(1200);
    } catch (error) {
      this.components = [];
      this.error = { kind: 'discovery', message: errorMessage(error) };
    }
    this.postState();
  }

  private findComponent(componentKey: string): KBEngineComponentInfo | undefined {
    return this.components.find(
      component =>
        this.componentKey(component) === componentKey ||
        component.fullName === componentKey ||
        component.componentName === componentKey
    );
  }

  private componentKey(component: KBEngineComponentInfo): string {
    return `${component.componentType}:${component.componentID.toString()}`;
  }

  private postState(
    result: { spaces?: SpaceQueryResult[]; watchers?: WatcherQueryResult[] } = {}
  ): void {
    if (!this.panel) return;
    void this.panel.webview.postMessage({
      command: 'state',
      components: this.components.map(component => ({
        key: this.componentKey(component),
        name: component.fullName,
        type: component.componentType,
        address: `${component.intaddr}:${component.intport}`
      })),
      error: this.error,
      result
    });
  }

  private render(): string {
    return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';"></head>
<body>
  <main>
    <header><h1>Runtime Queries</h1><button id="refresh" type="button">Refresh components</button></header>
    <section>
      <label for="component">Component</label>
      <select id="component"></select>
      <button id="spaces" type="button">Query spaces</button>
    </section>
    <section>
      <label for="path">Watcher path</label>
      <input id="path" type="text" value="/" spellcheck="false">
      <button id="watcher" type="button">Query watcher</button>
    </section>
    <output id="message" aria-live="polite"></output>
    <pre id="result"></pre>
  </main>
  <script>
    const vscode = acquireVsCodeApi();
    const component = document.getElementById('component');
    const path = document.getElementById('path');
    const message = document.getElementById('message');
    const result = document.getElementById('result');
    document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ command: 'refresh' }));
    document.getElementById('spaces').addEventListener('click', () => vscode.postMessage({ command: 'querySpaces', componentKey: component.value }));
    document.getElementById('watcher').addEventListener('click', () => vscode.postMessage({ command: 'queryWatcher', componentKey: component.value, path: path.value }));
    window.addEventListener('message', event => {
      const state = event.data;
      if (state.command !== 'state') return;
      const selected = component.value;
      component.replaceChildren(...state.components.map(item => {
        const option = document.createElement('option');
        option.value = item.key;
        option.textContent = item.name + ' — ' + item.address;
        return option;
      }));
      if (state.components.some(item => item.key === selected)) component.value = selected;
      const error = state.error ? state.error.kind + ': ' + state.error.message : '';
      message.textContent = error;
      result.textContent = JSON.stringify(state.result, null, 2);
    });
    vscode.postMessage({ command: 'refresh' });
  </script>
</body>
</html>`;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
