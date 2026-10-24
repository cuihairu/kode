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

/**
 * 操作面开关读取器(C-3)。默认直接读 `kbengine.runtimeQuery.*` 配置;测试注入
 * 固定值,不依赖假 vscode 的配置段覆写。
 */
export interface RuntimeQueryOptions {
  enabled?: () => boolean;
  pollIntervalMs?: () => number;
}

export const defaultRuntimeQueryOptions: RuntimeQueryOptions = {
  enabled: () =>
    vscode.workspace.getConfiguration('kbengine').get<boolean>(
      'runtimeQuery.enabled',
      false
    ),
  pollIntervalMs: () =>
    vscode.workspace.getConfiguration('kbengine').get<number>(
      'runtimeQuery.pollIntervalMs',
      2000
    )
};

interface RuntimeQueryMessage {
  command: 'refresh' | 'querySpaces' | 'queryWatcher' | 'addWatcher' | 'removeWatcher' | 'toggleStream';
  componentKey?: unknown;
  path?: unknown;
}

type RuntimeQueryError =
  | { kind: 'discovery'; message: string }
  | { kind: 'spaces'; componentKey: string; message: string }
  | { kind: 'watcher'; componentKey: string; message: string }
  | { kind: 'watchList'; message: string };

export class RuntimeQueryWebView {
  private panel: vscode.WebviewPanel | null = null;
  private components: KBEngineComponentInfo[] = [];
  private error: RuntimeQueryError | null = null;
  private watchPaths: string[] = [];
  private streaming = false;
  private streamTimer: NodeJS.Timeout | null = null;
  private streamComponent: KBEngineComponentInfo | null = null;

  constructor(
    private context: vscode.ExtensionContext,
    private protocol: RuntimeQueryProtocol = defaultRuntimeQueryProtocol,
    private options: RuntimeQueryOptions = defaultRuntimeQueryOptions
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
        this.stopStream();
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

    // 增删 watcher 是面板侧的查询目标清单管理——引擎的 addWatcher/delWatcher
    // 是进程内脚本 API(pywatcher.cpp),不在控制台协议上,面板无法远程增删引擎
    // watcher(见设计文档 §5/§8);因此这两个操作不依赖已选组件
    if (message.command === 'removeWatcher') {
      this.watchPaths = this.watchPaths.filter(
        existing => existing !== (typeof message.path === 'string' ? message.path.trim() : '')
      );
      this.error = null;
      this.postState();
      return;
    }

    if (message.command === 'addWatcher') {
      const path = typeof message.path === 'string' ? message.path.trim() : '';
      if (!path) {
        this.error = { kind: 'watchList', message: 'Enter a watcher path to add.' };
        this.postState();
        return;
      }
      if (this.watchPaths.includes(path)) {
        this.error = { kind: 'watchList', message: `Watcher path already on the list: ${path}` };
        this.postState();
        return;
      }
      this.watchPaths = [...this.watchPaths, path];
      this.error = null;
      this.postState();
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

    if (message.command === 'toggleStream') {
      if (this.streaming) {
        this.stopStream();
        this.postState();
        return;
      }
      if (!this.options.enabled?.()) {
        this.error = {
          kind: 'watchList',
          message: 'Result stream is off by default; enable kbengine.runtimeQuery.enabled.'
        };
        this.postState();
        return;
      }
      this.startStream(component);
      // 先回灌一次 streaming 状态,轮询轮次稍后才带结果回来
      this.postState();
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
      this.postState({ watcherRows: watcherResultRows(watchers) });
    } catch (error) {
      this.error = { kind: 'watcher', componentKey, message: errorMessage(error) };
      this.postState();
    }
  }

  private startStream(component: KBEngineComponentInfo): void {
    this.streamComponent = component;
    this.streaming = true;
    this.error = null;
    const intervalMs = Math.max(500, this.options.pollIntervalMs?.() ?? 2000);
    this.streamTimer = setInterval(() => void this.runStreamRound(), intervalMs);
    void this.runStreamRound();
  }

  private stopStream(): void {
    if (this.streamTimer !== null) {
      clearInterval(this.streamTimer);
      this.streamTimer = null;
    }
    this.streaming = false;
    this.streamComponent = null;
  }

  private async runStreamRound(): Promise<void> {
    const component = this.streamComponent;
    if (!component || !this.streaming) return;
    const paths = [...this.watchPaths];
    if (paths.length === 0) return;
    try {
      const frames = await Promise.all(
        paths.map(path => this.protocol.queryWatcherPath(component, path, 1200))
      );
      if (!this.streaming) return; // 面板已关/已停则不回灌过期状态
      this.error = null;
      this.postState({ watcherRows: watcherResultRows(frames.flat()) });
    } catch (error) {
      if (!this.streaming) return;
      this.error = { kind: 'watchList', message: errorMessage(error) };
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
    result: { spaces?: SpaceQueryResult[]; watcherRows?: WatcherResultRow[] } = {}
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
      watchPaths: [...this.watchPaths],
      streaming: this.streaming,
      result: {
        spaces: toSpaceView(result.spaces),
        watcherRows: result.watcherRows ?? []
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
    <section>
      <button id="add-watcher" type="button">Add to watch list</button>
      <button id="stream" type="button" disabled>Start stream</button>
    </section>
    <ul id="watch-list"></ul>
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
    const addWatcher = document.getElementById('add-watcher');
    const stream = document.getElementById('stream');
    const watchList = document.getElementById('watch-list');
    document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ command: 'refresh' }));
    document.getElementById('spaces').addEventListener('click', () => vscode.postMessage({ command: 'querySpaces', componentKey: component.value }));
    document.getElementById('watcher').addEventListener('click', () => vscode.postMessage({ command: 'queryWatcher', componentKey: component.value, path: path.value }));
    addWatcher.addEventListener('click', () => vscode.postMessage({ command: 'addWatcher', path: path.value }));
    stream.addEventListener('click', () => vscode.postMessage({ command: 'toggleStream', componentKey: component.value }));
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
      const watchPaths = state.watchPaths || [];
      watchList.replaceChildren(...watchPaths.map(item => {
        const li = document.createElement('li');
        const label = document.createElement('span');
        label.textContent = item;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = 'Remove';
        remove.addEventListener('click', () => vscode.postMessage({ command: 'removeWatcher', path: item }));
        li.append(label, remove);
        return li;
      }));
      stream.textContent = state.streaming ? 'Stop stream' : 'Start stream';
      stream.disabled = !state.streaming && watchPaths.length === 0;
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
