/**
 * KFLOW 调用图泳道面板(FLOW-015,G2 泳道视图的 vscode 面板控制器)。
 *
 * 验收:Client/Base/Cell 和已涉及其他进程按角色分泳道;静态角色不冒充
 * 运行中实例,运行实例带组件 ID。
 *
 * 口径:
 *   - 入口=活动 Python 编辑器:光标所在函数(def 声明行语法锚)直开,
 *     免快选;光标不在函数内/目标不在图面(叶函数无调用不入图)回退
 *     函数清单快选(FLOW-018);
 *   - 数据=assembleFlowCallGraph(FLOW-015 数据装配核):有界收集 workspace
 *     scripts 目录下全部 .py(确定序截断,上限与 KODE-PERF-004 同源
 *     10000),def/实现经 entityMappingManager 解析(实体×段×方法);
 *   - 泳道按角色分列(已涉及角色各一条);泳道头标注「静态角色(非运行
 *     实例)」——静态分析没有运行实例,不冒充;运行实例属 G3/TRACE
 *     泳道,届时带组件 ID;
 *   - 渲染=flowReviewSample 自包含 HTML(CSP default-src 'none';工件本体
 *     零脚本,面板只注入 nonce 跳转桥:点击调用点/声明标注跳编辑器
 *     对应行,FLOW-016;R1/R3 词汇红线已由生成核锁定);
 *   - 选中反查=点击候选帧节点(FLOW-018):flowNodeInspect 纯核全工作区
 *     反查上游/下游,未知(原因码)与歧义(跨进程同名实体待证)可查看;
 *   - 导航历史=反查视图里「打开图」跳到调用者/被调者场景,旧入口入栈,
 *     「返回上一视图」出栈重开;面板关闭即清;
 *   - 有界初装=FLOW-019:初次装配按 FLOW_DEFAULT_DEPTH 深度界走查,
 *     超界帧标注「截断边界」并给「继续展开」入口(续开新场景);进度
 *     可取消(token 传入装配核,各阶段间停扩展,取消与失败分报);
 *     面板注入工具条=搜索/过滤(回车定位)/缩放/重置——工具条与脚本
 *     只在面板层,工件本体仍零脚本;
 *   - 面板只管 vscode 生命周期与装配调度;数据/HTML 全在纯核
 *     (flowCallGraphData.ts + backend/flowReviewSample.ts +
 *     backend/flowNodeInspect.ts)。
 */

import * as vscode from 'vscode';
import { resolveFlowCallSites } from './backend/flowCallResolver';
import {
  assembleFlowCallGraph,
  type FlowCallGraphSource
} from './flowCallGraphData';
import { buildFlowNodeInspect } from './backend/flowNodeInspect';
import { buildFlowTextPath } from './backend/flowTextPath';
import type { FlowReviewFrame, FlowReviewSample } from './backend/flowReviewSample';
import { randomNonce } from './webviewSecurity';
import { resolvePanelLocale, strings } from './webviewStrings';
import type { EntityMappingManager } from './entityMapping';

/** 有界收集上限(与 KODE-PERF-004 callgraph 收集同源;截断在明细中如实) */
const FLOW_FILE_LIMIT = 10_000;

/**
 * FLOW-019 初装深度界:初次只装配有界场景子图,超界截断在帧上标注
 * 「截断边界/继续展开」,不一次性铺满大图(按需展开的入口在帧上)。
 */
const FLOW_DEFAULT_DEPTH = 6;

export interface FlowSwimlaneDeps {
  entityMappingManager: EntityMappingManager;
  /** 测试注入:替换工作区数据源工厂(缺省=makeWorkspaceFlowSource) */
  sourceFactory?: (rootKey: string) => FlowCallGraphSource;
}

/** 实体脚本文件判定:路径含 scripts/<face>/ 目录(face=base/cell/client/bots/interfaces/machine/logger/dbmgr) */
const isEntityScriptFile = (fsPath: string): boolean =>
  /[/\\]scripts[/\\](base|cell|client|bots|interfaces|machine|logger|dbmgr)[/\\][^/\\]+\.py$/.test(fsPath);

/** 工作区数据源:有界多根收集(确定序截断)+ 实体归属/def/实现解析(经 manager) */
export function makeWorkspaceFlowSource(
  deps: FlowSwimlaneDeps,
  rootKey: string,
  onTruncated?: (kept: number, total: number) => void
): FlowCallGraphSource {
  const manager = deps.entityMappingManager;
  return {
    rootKey,
    async listScriptFiles() {
      const found = await vscode.workspace.findFiles('**/scripts/**/*.py', undefined, FLOW_FILE_LIMIT);
      const sorted = found
        .map(uri => uri.fsPath)
        .filter(isEntityScriptFile)
        .sort((left, right) => left.localeCompare(right));
      if (sorted.length >= FLOW_FILE_LIMIT && onTruncated) {
        onTruncated(sorted.length, sorted.length);
      }
      return sorted;
    },
    async readFile(filePath) {
      try {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
        return document.getText();
      } catch {
        return null;
      }
    },
    async entityForFile(filePath) {
      const mapping = manager.getMappingForPythonFile(filePath);
      return mapping?.name ?? null;
    },
    async resolveDefMethod(entity, section, methodName) {
      const def = await manager.resolveMethodDefinitionForClass(entity, methodName, section);
      return def
        ? {
            defFile: def.defFile,
            line: def.line,
            declaredArgs: def.declaredArgs ?? [],
            declaredReturnType: def.declaredReturnType ?? null
          }
        : null;
    },
    async resolveImplementation(entity, section, methodName) {
      const def = await manager.resolveMethodDefinitionForClass(entity, methodName, section);
      if (!def) {
        return null;
      }
      const impl = await manager.resolveMethodImplementationByIdentity(def.identity);
      if (!impl) {
        return null;
      }
      // signature 与解析器同式:实现 def 行整行 trim(行号 0 基;行缺失=空签名)
      let signature = '';
      try {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(impl.filePath));
        const lineText = document.lineAt(impl.line).text;
        signature = lineText.trim();
      } catch {
        signature = '';
      }
      return {
        filePath: impl.filePath,
        line: impl.line,
        signature,
        className: entity,
        inheritedFrom: null
      };
    }
  };
}

/**
 * 面板跳转脚本(FLOW-016 调用点/声明跳转 + FLOW-018 节点反查/打开图/返回):
 * 评审工件 HTML 本身零脚本,交互面只在面板内以 nonce 内联脚本激活。
 * 优先级:跳转 > 打开图 > 返回 > 节点反查(帧节点)。
 */
const FLOW_JUMP_SCRIPT = `
(function() {
  var vscode = acquireVsCodeApi();
  // 键盘操作面(FLOW-020):交互元素可聚焦,Enter/Space 同点击
  var interactive = document.querySelectorAll(
    '[data-flow-jump],[data-flow-open-file],[data-flow-back],[data-flow-view],[data-node]'
  );
  for (var i = 0; i < interactive.length; i++) {
    interactive[i].setAttribute('tabindex', '0');
  }
  document.addEventListener('keydown', function(event) {
    if (event.key !== 'Enter' && event.key !== ' ') { return; }
    var t = event.target;
    if (!t || !t.getAttribute) { return; }
    var hit = t.getAttribute('data-flow-jump') !== null ||
      t.getAttribute('data-flow-open-file') !== null ||
      t.hasAttribute('data-flow-back') ||
      t.getAttribute('data-flow-view') !== null ||
      t.getAttribute('data-node') !== null;
    if (hit) {
      event.preventDefault();
      t.click();
    }
  });
  document.addEventListener('click', function(event) {
    var target = event.target;
    while (target && target !== document.body) {
      if (target.getAttribute && target.getAttribute('data-flow-jump')) {
        vscode.postMessage({
          command: 'flowJump',
          target: target.getAttribute('data-flow-jump')
        });
        return;
      }
      if (target.getAttribute && target.getAttribute('data-flow-open-file')) {
        vscode.postMessage({
          command: 'flowOpen',
          file: target.getAttribute('data-flow-open-file'),
          functionName: target.getAttribute('data-flow-open-fn')
        });
        return;
      }
      if (target.hasAttribute && target.hasAttribute('data-flow-back')) {
        vscode.postMessage({ command: 'flowBack' });
        return;
      }
      if (target.getAttribute && target.getAttribute('data-flow-view')) {
        vscode.postMessage({
          command: 'flowView',
          mode: target.getAttribute('data-flow-view')
        });
        return;
      }
      if (target.getAttribute && target.getAttribute('data-node')) {
        vscode.postMessage({
          command: 'flowInspect',
          nodeId: target.getAttribute('data-node')
        });
        return;
      }
      target = target.parentNode;
    }
  });
})();
`;

/**
 * FLOW-019 工具条脚本(仅面板注入,工件本体仍零脚本):搜索/过滤行
 * (回车定位首个匹配)+ 缩放(body zoom,0.5–2 夹取)+ 重置。
 */
const FLOW_TOOLBAR_SCRIPT = `
(function() {
  var body = document.body;
  var level = 1;
  var applyZoom = function() { body.style.zoom = String(level); };
  var search = document.querySelector('.flow-search');
  var rows = function() {
    return Array.prototype.slice.call(document.querySelectorAll('li, tr'));
  };
  var filter = function() {
    var query = search && search.value ? search.value.toLowerCase() : '';
    var visible = [];
    rows().forEach(function(row) {
      var hit = !query || (row.textContent || '').toLowerCase().indexOf(query) >= 0;
      row.style.display = hit ? '' : 'none';
      if (hit) { visible.push(row); }
    });
    return visible;
  };
  if (search) {
    search.addEventListener('input', filter);
    search.addEventListener('keydown', function(event) {
      if (event.key === 'Enter') {
        var visible = filter();
        if (visible.length > 0) { visible[0].scrollIntoView({ block: 'center' }); }
      }
    });
  }
  var bindZoom = function(selector, delta) {
    var button = document.querySelector(selector);
    if (button) {
      button.addEventListener('click', function() {
        level = Math.min(2, Math.max(0.5, level + delta));
        applyZoom();
      });
    }
  };
  bindZoom('.flow-zoom-in', 0.1);
  bindZoom('.flow-zoom-out', -0.1);
  var reset = document.querySelector('.flow-zoom-reset');
  if (reset) {
    reset.addEventListener('click', function() { level = 1; applyZoom(); });
  }
})();
`;

/** 解析 data-flow-jump 值(file:0 基行;file 含冒号按最后一个冒号切) */
const parseJumpTarget = (target: unknown): { file: string; line0: number } | null => {
  if (typeof target !== 'string') {
    return null;
  }
  const lastColon = target.lastIndexOf(':');
  if (lastColon <= 0) {
    return null;
  }
  const line0 = Number.parseInt(target.slice(lastColon + 1), 10);
  if (!Number.isInteger(line0) || line0 < 0) {
    return null;
  }
  return { file: target.slice(0, lastColon), line0 };
};

/** 装配取消(FLOW-019):纯核各阶段间检查抛出的哨兵错误,与装配失败分报 */
const isCancelError = (error: unknown): boolean =>
  error instanceof Error && error.message === 'flow assembly cancelled';

/** 活动编辑器函数清单(解析核;解析失败/无函数=空) */
export function listEntryFunctions(text: string, filePath: string, rootKey: string): string[] {
  try {
    const result = resolveFlowCallSites({ text, filePath, rootKey });
    const names = new Set<string>();
    for (const node of result.nodes) {
      if (node.kind === 'function' && node.fn) {
        names.add(node.fn.name);
      }
    }
    return [...names].sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

/**
 * 光标所在函数(FLOW-018):def 声明行语法锚——光标行之前(含)最近的
 * `def name(` 行。语法锚是事实;「包含」判断在叶函数/类间空隙的边界
 * 属启发,所以宿主只在结果同时出现在图面函数清单时才直开,否则回退快选。
 */
export function resolveCursorFunction(text: string, line0: number): string | null {
  const lines = text.split('\n');
  let best: { name: string; line: number } | null = null;
  const defPattern = /^\s*def\s+([A-Za-z_]\w*)\s*\(/;
  for (let i = 0; i <= line0 && i < lines.length; i++) {
    const match = lines[i].match(defPattern);
    if (match) {
      best = { name: match[1], line: i };
    }
  }
  return best?.name ?? null;
}

/** 帧节点 id → 反查目标(fn 段=`文件#函数名`;pending-def 声明节点不反查) */
const inspectTargetOfNodeId = (
  nodeId: string
): { filePath: string; functionName: string } | null => {
  const fnPart = nodeId.split('\u001f')[4];
  if (!fnPart) {
    return null;
  }
  const hash = fnPart.lastIndexOf('#');
  if (hash <= 0) {
    return null;
  }
  const filePath = fnPart.slice(0, hash);
  const functionName = fnPart.slice(hash + 1);
  if (!functionName || filePath.startsWith('pending-def:')) {
    return null;
  }
  return { filePath, functionName };
};

export class FlowSwimlanePanel {
  private panel: vscode.WebviewPanel | null = null;
  /** 当前渲染场景入口(反查/导航历史的基准;装配成功才更新) */
  private currentEntry: { filePath: string; functionName: string } | null = null;
  private currentRootKey: string | null = null;
  private currentSource: FlowCallGraphSource | null = null;
  /** 当前场景全部帧节点(候选帧选择反查用) */
  private frameNodes: FlowReviewFrame[] = [];
  /** 最近一次装配成功的样本(图/文本两面消费同一模型;装配失败保留旧值) */
  private lastSample: FlowReviewSample | null = null;
  /** 导航历史:反查视图「打开图」压栈,「返回上一视图」出栈 */
  private history: Array<{ filePath: string; functionName: string }> = [];
  /** 当前视图形态:walk=泳道走查;inspect=节点反查;text=文本路径;back 回 walk 不走历史 */
  private viewMode: 'walk' | 'inspect' | 'text' = 'walk';
  /** 当前场景最近一次泳道 HTML(反查视图返回复用,不重装配) */
  private lastWalkHtml: string | null = null;

  constructor(private readonly deps: FlowSwimlaneDeps) {}

  async show(): Promise<void> {
    const t = strings(resolvePanelLocale()).flowSwimlane;
    const editor = vscode.window.activeTextEditor;
    if (!editor || !editor.document.fileName.endsWith('.py')) {
      void vscode.window.showInformationMessage(t.errorNoFile);
      return;
    }
    const filePath = editor.document.uri.fsPath;
    const rootKey =
      vscode.workspace.getWorkspaceFolder(editor.document.uri)?.uri.fsPath ??
      editor.document.uri.fsPath;
    const functions = listEntryFunctions(editor.document.getText(), filePath, rootKey);
    if (functions.length === 0) {
      void vscode.window.showInformationMessage(t.errorNoFunctions);
      return;
    }
    // FLOW-018:光标所在函数(语法锚)且在图面 → 免快选直开;否则快选回退
    const cursorLine = (editor.selection?.active as { line?: number } | undefined)?.line;
    const cursorFn =
      typeof cursorLine === 'number'
        ? resolveCursorFunction(editor.document.getText(), cursorLine)
        : null;
    const picked =
      cursorFn !== null && functions.includes(cursorFn)
        ? cursorFn
        : functions.length === 1
          ? functions[0]
          : await vscode.window.showQuickPick(functions, { placeHolder: t.pickEntry });
    if (!picked) {
      return;
    }
    try {
      await this.open(rootKey, { filePath, functionName: picked });
    } catch (error) {
      // 装配失败如实告知并可重试;旧视图状态保留(状态只在装配成功后变更)
      await this.reportAssembleFailure(error, () =>
        this.open(rootKey, { filePath, functionName: picked })
      );
    }
  }

  async open(
    rootKey: string,
    entry: { filePath: string; functionName: string }
  ): Promise<void> {
    const t = strings(resolvePanelLocale()).flowSwimlane;
    const title = `${t.title} · ${entry.functionName}`;
    if (this.panel) {
      this.panel.reveal();
      // 标题在装配成功后更新(装配失败视图停留,标题不假装已切换)
    } else {
      this.panel = vscode.window.createWebviewPanel(
        'kbengine.flowSwimlane',
        title,
        vscode.ViewColumn.Two,
        { enableScripts: true, retainContextWhenHidden: true }
      );
      // FLOW-016/018:跳转编辑器/节点反查/打开图/返回上一视图
      this.panel.webview.onDidReceiveMessage(message => {
        const cmd = (message as { command?: string } | null)?.command;
        if (cmd === 'flowJump') {
          const jump = parseJumpTarget((message as { target?: unknown }).target);
          if (jump) {
            void this.revealLocation(jump.file, jump.line0);
          }
          return;
        }
        if (cmd === 'flowInspect') {
          const nodeId = (message as { nodeId?: unknown }).nodeId;
          if (typeof nodeId === 'string') {
            void this.inspectByNodeId(nodeId);
          }
          return;
        }
        if (cmd === 'flowOpen') {
          const file = (message as { file?: unknown }).file;
          const functionName = (message as { functionName?: unknown }).functionName;
          if (typeof file === 'string' && typeof functionName === 'string') {
            void this.navigate(rootKey, { filePath: file, functionName });
          }
          return;
        }
        if (cmd === 'flowBack') {
          void this.goBack();
          return;
        }
        if (cmd === 'flowView') {
          const mode = (message as { mode?: unknown }).mode;
          if (mode === 'text') {
            this.renderTextFace();
          } else if (mode === 'graph') {
            this.renderGraphFace();
          }
        }
      });
      this.panel.onDidDispose(() => {
        this.panel = null;
        this.currentEntry = null;
        this.currentRootKey = null;
        this.currentSource = null;
        this.frameNodes = [];
        this.lastSample = null;
        this.history = [];
        this.viewMode = 'walk';
        this.lastWalkHtml = null;
      });
    }
    const panel = this.panel;
    const source = this.deps.sourceFactory
      ? this.deps.sourceFactory(rootKey)
      : makeWorkspaceFlowSource(this.deps, rootKey);
    // FLOW-019:初装有界深度;进度可取消,取消后各装配阶段间停扩展
    const sample: FlowReviewSample = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: t.progress,
        cancellable: true
      },
      (_progress, token) =>
        assembleFlowCallGraph(source, entry, {
          maxDepth: FLOW_DEFAULT_DEPTH,
          cancellationToken: token
        })
    );
    if (!this.panel || this.panel !== panel) {
      return; // 装配期间面板已关/换代:弃写
    }
    this.currentEntry = entry;
    this.currentRootKey = rootKey;
    this.currentSource = source;
    this.frameNodes = sample.swimlanes.flatMap(lane => lane.frames);
    this.lastSample = sample;
    this.viewMode = 'walk';
    this.lastWalkHtml = sample.html;
    this.panel.title = title;
    this.renderWebview(sample.html);
  }

  /** 节点反查(FLOW-018):全工作区上游/下游,未知与歧义可查看 */
  private async inspectByNodeId(nodeId: string): Promise<void> {
    const target = inspectTargetOfNodeId(nodeId);
    const source = this.currentSource;
    const rootKey = this.currentRootKey;
    if (!target || !source || !rootKey) {
      return; // 非函数帧(声明/未解析)不反查:如实不动
    }
    try {
      const files = new Map<string, string>();
      for (const filePath of await source.listScriptFiles()) {
        const text = await source.readFile(filePath);
        if (text !== null) {
          files.set(filePath, text);
        }
      }
      const entities = new Map<string, string | null>();
      for (const filePath of files.keys()) {
        entities.set(filePath, await source.entityForFile(filePath));
      }
      const inspect = buildFlowNodeInspect({
        rootKey,
        target,
        files,
        entityForFile: filePath => entities.get(filePath) ?? null,
        canGoBack: this.lastWalkHtml !== null
      });
      if (!this.panel) {
        return; // 反查期间面板已关:弃写
      }
      this.viewMode = 'inspect';
      this.renderWebview(inspect.html);
    } catch (error) {
      void vscode.window.showWarningMessage(
        `反查失败:${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /** 「打开图」导航:旧入口压栈(装配成功才压),新场景重开 */
  private async navigate(
    rootKey: string,
    entry: { filePath: string; functionName: string }
  ): Promise<void> {
    const previous = this.currentEntry;
    try {
      await this.open(rootKey, entry);
    } catch (error) {
      await this.reportAssembleFailure(error, () => this.open(rootKey, entry));
      return;
    }
    if (previous && this.currentEntry === entry) {
      this.history.push(previous);
    }
  }

  /**
   * 装配失败/取消如实上报(FLOW-020 错误恢复):取消=信息;失败=错误消息
   * 带「重试」动作,选中即重开同一入口。已有视图与样本状态不受影响
   * (open 只在装配成功后变更状态),重试再失败如实再报、不再递归弹重试。
   */
  private async reportAssembleFailure(
    error: unknown,
    retry: () => Promise<void>
  ): Promise<void> {
    const t = strings(resolvePanelLocale()).flowSwimlane;
    if (isCancelError(error)) {
      void vscode.window.showInformationMessage(t.errorCancelled);
      return;
    }
    const picked = await vscode.window.showErrorMessage(t.errorAssemble, t.retry);
    if (picked !== t.retry) {
      return;
    }
    try {
      await retry();
    } catch (retryError) {
      if (!isCancelError(retryError)) {
        void vscode.window.showErrorMessage(t.errorAssemble);
      }
    }
  }

  /** 文本路径面(FLOW-020):与 HTML 面消费同一样本,渲染失败路径仍在 */
  private renderTextFace(): void {
    const t = strings(resolvePanelLocale()).flowSwimlane;
    if (!this.panel || !this.lastSample) {
      void vscode.window.showInformationMessage(t.noSample);
      return;
    }
    this.viewMode = 'text';
    this.renderWebview(buildFlowTextPath(this.lastSample).html);
  }

  /** 图面(泳道走查):文本面切回,缓存复用不重装配 */
  private renderGraphFace(): void {
    if (!this.panel || this.lastWalkHtml === null) {
      return; // 无泳道在背后(罕见):如实不动
    }
    this.viewMode = 'walk';
    this.renderWebview(this.lastWalkHtml);
  }

  /** 「返回上一视图」:反查/文本视图回泳道(缓存复用);泳道视图出栈重开 */
  private async goBack(): Promise<void> {
    if (this.viewMode === 'text') {
      this.renderGraphFace();
      return;
    }
    if (this.viewMode === 'inspect') {
      if (this.lastWalkHtml === null) {
        return; // 无泳道在背后(罕见):如实不动
      }
      this.viewMode = 'walk';
      this.renderWebview(this.lastWalkHtml);
      return;
    }
    const previous = this.history.pop();
    const rootKey = this.currentRootKey;
    if (!previous || !rootKey) {
      void vscode.window.showInformationMessage('没有上一视图');
      return;
    }
    try {
      await this.open(rootKey, previous);
    } catch (error) {
      await this.reportAssembleFailure(error, () => this.open(rootKey, previous));
    }
  }

  /** 渲染(CSP 注入 + nonce 交互桥 + FLOW-019 工具条;零外部面) */
  private renderWebview(html: string): void {
    if (!this.panel) {
      return;
    }
    const t = strings(resolvePanelLocale()).flowSwimlane;
    const nonce = randomNonce();
    const toolbar =
      `<div class="flow-toolbar">` +
      `<input class="flow-search" placeholder="${t.searchPlaceholder}" />` +
      `<button class="flow-view-graph" data-flow-view="graph">${t.viewGraph}</button>` +
      `<button class="flow-view-text" data-flow-view="text">${t.viewText}</button>` +
      `<button class="flow-zoom-in">${t.zoomIn}</button>` +
      `<button class="flow-zoom-out">${t.zoomOut}</button>` +
      `<button class="flow-zoom-reset">${t.zoomReset}</button>` +
      `</div>`;
    this.panel.webview.html = html
      .replace('<body>', `<body>${toolbar}`)
      .replace(
        '<head>',
        `<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"><style>[data-flow-jump],[data-flow-open-file],[data-flow-back]{cursor:pointer;text-decoration:underline dotted;}.flow-toolbar{position:sticky;top:0;display:flex;gap:6px;padding:6px 12px;background:#f6f6f6;border-bottom:1px solid #ddd;z-index:9;}.flow-toolbar input{flex:1;}</style><script nonce="${nonce}">${FLOW_JUMP_SCRIPT}</script><script nonce="${nonce}">${FLOW_TOOLBAR_SCRIPT}</script>`
      );
  }

  /** 跳转编辑器(file:0 基行;越界钳到末行,如实打开不虚构) */
  private async revealLocation(file: string, line0: number): Promise<void> {
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      const line = Math.max(0, Math.min(line0, document.lineCount - 1));
      const editor = await vscode.window.showTextDocument(document, { preview: false });
      const position = new vscode.Position(line, 0);
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
      editor.selection = new vscode.Selection(position, position);
    } catch {
      void vscode.window.showWarningMessage(`无法打开 ${file}`);
    }
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = null;
  }
}
