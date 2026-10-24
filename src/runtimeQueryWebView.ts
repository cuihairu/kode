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

/**
 * 空间查询结果过 webview 边界前的 JSON 安全形态。`SpaceQueryResult` 里有三处
 * bigint(componentID / snapshot.componentID / cellappID),而 `postMessage`
 * 与 webview 侧 `JSON.stringify` 都吃不下 bigint——不转换的话整个 state 消息
 * 直接抛 "Do not know how to serialize a BigInt",面板静默空掉。
 */
export interface SpaceSnapshotView {
  componentType: number;
  componentID: string;
  cellappID: string;
  spaceID: number;
  geomappingPath: string;
  scriptModuleName: string;
  cells: number[];
}

export interface SpaceQueryView {
  componentType: number;
  componentID: string;
  spaces: SpaceSnapshotView[];
}

export function toSpaceView(spaces: SpaceQueryResult[] = []): SpaceQueryView[] {
  return spaces.map(space => ({
    componentType: space.componentType,
    componentID: space.componentID.toString(),
    spaces: space.spaces.map(snapshot => ({
      componentType: snapshot.componentType,
      componentID: snapshot.componentID.toString(),
      cellappID: snapshot.cellappID.toString(),
      spaceID: snapshot.spaceID,
      geomappingPath: snapshot.geomappingPath,
      scriptModuleName: snapshot.scriptModuleName,
      cells: snapshot.cells
    }))
  }));
}

/**
 * watcher 结果表格的一行(C-2)。两种来源对应引擎 `Watcher.py:73-137` 的两种
 * 回执形态:
 * - `type === 0` 是叶子读数段,给出的是父路径 + `values` 里的叶子名,
 *   全路径按引擎 `Watcher.py:82` 的 fullpath 口径拼(`path + '/' + name`,
 *   父路径为空时只有 name);
 * - `type !== 0` 是目录清单段,`keys` 里直接是子路径全名。
 * 值统一转字符串:解析层已经按线型解出 number/boolean/string,表格不再区分类型列。
 */
export interface WatcherResultRow {
  path: string;
  kind: 'value' | 'child';
  value: string;
}

/** 引擎 `Watcher.py:82` 的 fullpath 口径:父路径非空才补斜杠 */
export function joinWatcherPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

/**
 * watcher 查询结果 → 表格行。纯函数、保序(不重排引擎给出的线序),
 * 空输入返回空数组而不是伪造占位行。抽成导出函数是为了让表格口径有
 * 单测执行面——webview 内联脚本只是一层渲染,不再自己推导行。
 */
export function watcherResultRows(watchers: WatcherQueryResult[] = []): WatcherResultRow[] {
  const rows: WatcherResultRow[] = [];
  for (const item of watchers) {
    if (item.type === 0) {
      for (const name of Object.keys(item.values)) {
        rows.push({
          path: joinWatcherPath(item.path, name),
          kind: 'value',
          value: String(item.values[name])
        });
      }
      continue;
    }
    for (const key of item.keys) {
      rows.push({ path: key, kind: 'child', value: '' });
    }
  }
  return rows;
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
      result: {
        spaces: toSpaceView(result.spaces),
        watcherRows: watcherResultRows(result.watchers)
      }
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
    <table id="watcher-result" hidden>
      <caption>Watcher query results</caption>
      <thead>
        <tr>
          <th scope="col">Path</th>
          <th scope="col">Kind</th>
          <th scope="col">Value</th>
        </tr>
      </thead>
      <tbody></tbody>
    </table>
    <p id="empty" hidden>No watcher results yet.</p>
    <p><strong>Spaces</strong></p>
    <pre id="result" hidden></pre>
  </main>
  <script>
    const vscode = acquireVsCodeApi();
    const component = document.getElementById('component');
    const path = document.getElementById('path');
    const message = document.getElementById('message');
    const result = document.getElementById('result');
    const watcherTable = document.getElementById('watcher-result');
    const watcherBody = document.getElementById('watcher-result').querySelector('tbody');
    const empty = document.getElementById('empty');
    document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ command: 'refresh' }));
    document.getElementById('spaces').addEventListener('click', () => vscode.postMessage({ command: 'querySpaces', componentKey: component.value }));
    document.getElementById('watcher').addEventListener('click', () => vscode.postMessage({ command: 'queryWatcher', componentKey: component.value, path: path.value }));
    const renderWatchers = (rows) => {
      watcherBody.replaceChildren(...rows.map(row => {
        const tr = document.createElement('tr');
        const cells = [
          { tag: 'th', scope: 'row', text: row.path },
          { tag: 'td', text: row.kind },
          { tag: 'td', text: row.value }
        ];
        for (const cell of cells) {
          const element = document.createElement(cell.tag);
          if (cell.scope) element.scope = cell.scope;
          element.textContent = cell.text;
          tr.append(element);
        }
        return tr;
      }));
      watcherTable.hidden = rows.length === 0;
      empty.hidden = rows.length !== 0;
    };
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
      renderWatchers(state.result ? state.result.watcherRows || [] : []);
      const spaces = state.result ? state.result.spaces || [] : [];
      result.textContent = spaces.length ? JSON.stringify(spaces, null, 2) : '';
      result.hidden = spaces.length === 0;
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
