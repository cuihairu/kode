import * as vscode from 'vscode';
import { randomNonce } from './webviewSecurity';
import { WEBVIEW_THEME_CSS } from './webviewTheme';
import { htmlLang, resolvePanelLocale, strings } from './webviewStrings';
import {
  discoverLocalComponents,
  querySpaces,
  queryWatcherPath,
  type KBEngineComponentInfo,
  type SpaceQueryResult,
  type WatcherQueryResult
} from './backend/kbengineProtocol';
import {
  createObservationFreshnessTracker,
  type ObservationFreshnessTracker,
  type ObservationFreshnessState
} from './observationConnectionState';
import { observationTargetFor } from './observationIdentity';

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

/** 流式轮询的新鲜度状态(面板展示;过期=断连后旧值,恢复以真实成功为准) */
export interface RuntimeFreshnessState {
  state: ObservationFreshnessState;
  targetKey: string;
  text: string;
}

export class RuntimeQueryWebView {
  private panel: vscode.WebviewPanel | null = null;
  private components: KBEngineComponentInfo[] = [];
  private error: RuntimeQueryError | null = null;
  private watchPaths: string[] = [];
  private streaming = false;
  private streamTimer: NodeJS.Timeout | null = null;
  private streamComponent: KBEngineComponentInfo | null = null;
  private freshnessTracker: ObservationFreshnessTracker = createObservationFreshnessTracker();

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
        this.error = { kind: 'watchList', message: strings(resolvePanelLocale()).runtimeQuery.errEnterPathToAdd };
        this.postState();
        return;
      }
      if (this.watchPaths.includes(path)) {
        this.error = { kind: 'watchList', message: strings(resolvePanelLocale()).runtimeQuery.errDuplicatePath(path) };
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
        message: strings(resolvePanelLocale()).runtimeQuery.errSelectComponent
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
          message: strings(resolvePanelLocale()).runtimeQuery.errStreamDisabled
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
      this.error = { kind: 'watcher', componentKey, message: strings(resolvePanelLocale()).runtimeQuery.errEnterPath };
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
    // 主动停流不是断连:清掉新鲜度痕迹,下次开流从干净状态起步
    if (this.streamComponent) {
      this.freshnessTracker.reset(observationTargetFor(this.streamComponent).targetKey);
    }
    this.streaming = false;
    this.streamComponent = null;
  }

  private async runStreamRound(): Promise<void> {
    const component = this.streamComponent;
    if (!component || !this.streaming) return;
    const paths = [...this.watchPaths];
    if (paths.length === 0) return;
    const target = observationTargetFor(component);
    try {
      const frames = await Promise.all(
        paths.map(path => this.protocol.queryWatcherPath(component, path, 1200))
      );
      if (!this.streaming) return; // 面板已关/已停则不回灌过期状态
      // 真实成功一轮才恢复实时(LIV-006)
      this.freshnessTracker.recordRound(target, true);
      this.error = null;
      this.postState({ watcherRows: watcherResultRows(frames.flat()) });
    } catch (error) {
      if (!this.streaming) return;
      // 断连:旧值保留但标过期,重连成功前不转实时(LIV-006)
      this.freshnessTracker.recordRound(target, false);
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
      freshness: this.freshnessView(),
      result: {
        spaces: toSpaceView(result.spaces),
        watcherRows: result.watcherRows ?? []
      }
    });
  }

  /** 流式目标的新鲜度视图(过期=旧值仍显示但明确标记,恢复以真实成功为准) */
  private freshnessView(): RuntimeFreshnessState | null {
    if (!this.streamComponent) return null;
    const target = observationTargetFor(this.streamComponent);
    const freshness = this.freshnessTracker.view(target.targetKey);
    if (!freshness) return null;
    const t = strings(resolvePanelLocale()).runtimeQuery;
    const text =
      freshness.state === 'stale'
        ? t.freshnessStale(
            freshness.lastFailureAt ?? '?',
            freshness.consecutiveFailures,
            freshness.lastSuccessAt
          )
        : t.freshnessLive(freshness.lastSuccessAt ?? '?');
    return { state: freshness.state, targetKey: target.targetKey, text };
  }

  private render(): string {
    const nonce = randomNonce();
    const locale = resolvePanelLocale();
    const t = strings(locale).runtimeQuery;
    return `<!doctype html>
<html lang="${htmlLang(locale)}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
${WEBVIEW_THEME_CSS}
body { padding: 0; }
/* UI-04:左操作轨 + 右结果页签(原型 #rt) */
.rt-body { flex: 1; display: flex; min-height: calc(100vh - 49px); }
#rt-rail { width: 280px; flex: none; border-right: 1px solid var(--kode-border); padding: 14px 16px; display: flex; flex-direction: column; gap: 14px; background: var(--kode-surface); }
#rt-rail .fld label { display: block; font-size: var(--kode-t-tag); color: var(--kode-fg-3); margin-bottom: 4px; }
#rt-rail .row { display: flex; gap: 8px; }
#rt-rail .sel, #rt-rail .inp { width: 100%; }
#rt-rail .inp.mono { font-family: var(--kode-mono); }
#watch-list { list-style: none; }
#watch-list li { display: flex; align-items: center; gap: 6px; padding: 5px 0; border-bottom: 1px solid var(--kode-border-soft); font-family: var(--kode-mono); font-size: 12px; color: var(--kode-accent); }
#watch-list li .x { margin-left: auto; color: var(--kode-fg-4); cursor: pointer; border: none; background: none; font-size: 12px; }
#watch-list li .x:hover { color: var(--kode-err); }
#rt-rail .hint { font-size: var(--kode-t-tag); color: var(--kode-fg-4); line-height: 1.5; }
#rt-main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.rt-tabs { display: flex; border-bottom: 1px solid var(--kode-border); flex: none; }
.rt-tab { padding: 8px 18px; font-size: var(--kode-t-meta); color: var(--kode-fg-3); cursor: pointer; border: none; background: none; border-bottom: 2px solid transparent; }
.rt-tab.on { color: #fff; border-bottom-color: var(--kode-accent); font-weight: 600; }
.rt-pane { flex: 1; overflow: auto; }
#watcher-result th, #spaces-result th { font-weight: 500; color: var(--kode-fg-3); text-align: left; padding: 7px 14px; border-bottom: 1px solid var(--kode-border); font-size: var(--kode-t-tag); }
#watcher-result td, #spaces-result td { padding: 6px 14px; border-bottom: 1px solid var(--kode-border-soft); font-family: var(--kode-mono); font-size: 12px; color: var(--kode-fg-2); }
#watcher-result td.path, #spaces-result td.path { color: var(--kode-fg); }
#message { padding: 6px 14px; color: var(--kode-err); font-size: var(--kode-t-meta); min-height: 1.2em; }
#freshness { padding: 2px 14px; font-size: var(--kode-t-meta); min-height: 1.2em; color: var(--kode-fg-3); }
#freshness.stale { color: var(--kode-err); }
#spaces-result td.path { color: var(--kode-fg); }
.rt-empty { padding: 40px 0; text-align: center; color: var(--kode-fg-4); font-size: var(--kode-t-meta); }
</style>
</head>
<body>
  <header class="kode-head">
    <h1>${t.title}</h1>
    <button id="refresh" class="kode-btn primary" type="button">${t.refreshComponents}</button>
  </header>
  <div class="rt-body">
    <nav id="rt-rail">
      <div class="fld">
        <label for="component">${t.component}</label>
        <select id="component" class="sel"></select>
      </div>
      <div class="fld">
        <label for="path">${t.watcherPath}</label>
        <div class="row">
          <input id="path" class="inp mono" type="text" value="/" spellcheck="false">
          <button id="watcher" class="kode-btn primary" type="button">${t.query}</button>
        </div>
      </div>
      <div class="fld">
        <label>${t.watchList}</label>
        <ul id="watch-list"></ul>
        <div class="row" style="margin-top:10px">
          <button id="add-watcher" class="kode-btn" style="flex:1" type="button">${t.addToWatch}</button>
          <button id="stream" class="kode-btn primary" style="flex:1" type="button" disabled>▶ ${t.startStream}</button>
        </div>
        <div class="hint" style="margin-top:6px">${t.streamHint}</div>
      </div>
    </nav>
    <main id="rt-main">
      <div class="rt-tabs">
        <button id="tab-watcher" class="rt-tab on" type="button">${t.watcherTab}</button>
        <button id="tab-spaces" class="rt-tab" type="button">${t.spacesTab}</button>
      </div>
      <output id="message" aria-live="polite"></output>
      <output id="freshness" aria-live="polite"></output>
      <section class="rt-pane" id="pane-watcher">
        <table id="watcher-result" hidden class="kode-table">
          <caption hidden>${t.watcherTab}</caption>
          <thead>
            <tr>
              <th scope="col">${t.colPath}</th>
              <th scope="col">${t.colKind}</th>
              <th scope="col">${t.colValue}</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
        <p id="empty" class="rt-empty" hidden>${t.emptyWatcher}</p>
      </section>
      <section class="rt-pane" id="pane-spaces" hidden>
        <div style="padding:8px 14px;border-bottom:1px solid var(--kode-border-soft)">
          <button id="spaces" class="kode-btn primary" type="button">${t.spacesQuery}</button>
        </div>
        <table id="spaces-result" hidden class="kode-table">
          <thead>
            <tr>
              <th scope="col">${t.colSpaceId}</th>
              <th scope="col">${t.colCellappId}</th>
              <th scope="col">${t.colScriptModule}</th>
              <th scope="col">${t.colCells}</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
        <p id="spaces-empty" class="rt-empty" hidden>${t.emptySpaces}</p>
      </section>
    </main>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const kindLabels = ${JSON.stringify({ value: t.kindValue, child: t.kindChild })};
    const streamLabels = ${JSON.stringify({ start: `▶ ${t.startStream}`, stop: `■ ${t.stopStream}` })};
    const removeLabel = ${JSON.stringify(t.remove)};
    const component = document.getElementById('component');
    const path = document.getElementById('path');
    const message = document.getElementById('message');
    const freshness = document.getElementById('freshness');
    const watcherTable = document.getElementById('watcher-result');
    const watcherBody = document.getElementById('watcher-result').querySelector('tbody');
    const spacesTable = document.getElementById('spaces-result');
    const spacesBody = spacesTable.querySelector('tbody');
    const spacesEmpty = document.getElementById('spaces-empty');
    const empty = document.getElementById('empty');
    const addWatcher = document.getElementById('add-watcher');
    const stream = document.getElementById('stream');
    const watchList = document.getElementById('watch-list');
    const paneWatcher = document.getElementById('pane-watcher');
    const paneSpaces = document.getElementById('pane-spaces');
    const tabWatcher = document.getElementById('tab-watcher');
    const tabSpaces = document.getElementById('tab-spaces');
    const setTab = (which) => {
      const watcher = which !== 'spaces';
      paneWatcher.hidden = !watcher;
      paneSpaces.hidden = watcher;
      tabWatcher.classList.toggle('on', watcher);
      tabSpaces.classList.toggle('on', !watcher);
    };
    tabWatcher.addEventListener('click', () => setTab('watcher'));
    tabSpaces.addEventListener('click', () => setTab('spaces'));
    document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ command: 'refresh' }));
    document.getElementById('spaces').addEventListener('click', () => vscode.postMessage({ command: 'querySpaces', componentKey: component.value }));
    document.getElementById('watcher').addEventListener('click', () => vscode.postMessage({ command: 'queryWatcher', componentKey: component.value, path: path.value }));
    addWatcher.addEventListener('click', () => vscode.postMessage({ command: 'addWatcher', path: path.value }));
    stream.addEventListener('click', () => vscode.postMessage({ command: 'toggleStream', componentKey: component.value }));
    const renderWatchers = (rows) => {
      watcherBody.replaceChildren(...rows.map(row => {
        const tr = document.createElement('tr');
        const cells = [
          { tag: 'th', scope: 'row', text: row.path, cls: 'path' },
          { tag: 'td', text: kindLabels[row.kind] || row.kind },
          { tag: 'td', text: row.value }
        ];
        for (const cell of cells) {
          const element = document.createElement(cell.tag);
          if (cell.scope) element.scope = cell.scope;
          if (cell.cls) element.className = cell.cls;
          element.textContent = cell.text;
          tr.append(element);
        }
        return tr;
      }));
      watcherTable.hidden = rows.length === 0;
      empty.hidden = rows.length !== 0;
    };
    const renderSpaces = (groups) => {
      const snapshots = groups.flatMap(group => group.spaces || []);
      spacesBody.replaceChildren(...snapshots.map(snapshot => {
        const tr = document.createElement('tr');
        for (const text of [snapshot.spaceID, snapshot.cellappID, snapshot.scriptModuleName, (snapshot.cells || []).join(', ')]) {
          const td = document.createElement('td');
          td.textContent = String(text);
          tr.append(td);
        }
        return tr;
      }));
      spacesTable.hidden = snapshots.length === 0;
      spacesEmpty.hidden = snapshots.length !== 0;
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
      const freshnessView = state.freshness || null;
      freshness.textContent = freshnessView ? freshnessView.text : '';
      freshness.className = freshnessView && freshnessView.state === 'stale' ? 'stale' : '';
      renderWatchers(state.result ? state.result.watcherRows || [] : []);
      renderSpaces(state.result ? state.result.spaces || [] : []);
      const watchPaths = state.watchPaths || [];
      watchList.replaceChildren(...watchPaths.map(item => {
        const li = document.createElement('li');
        const label = document.createElement('span');
        label.textContent = item;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'x';
        remove.textContent = removeLabel;
        remove.addEventListener('click', () => vscode.postMessage({ command: 'removeWatcher', path: item }));
        li.append(label, remove);
        return li;
      }));
      stream.textContent = state.streaming ? streamLabels.stop : streamLabels.start;
      stream.disabled = !state.streaming && watchPaths.length === 0;
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
