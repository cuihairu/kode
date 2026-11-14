/**
 * KFLOW 调用图泳道面板(FLOW-015,G2 泳道视图的 vscode 面板控制器)。
 *
 * 验收:Client/Base/Cell 和已涉及其他进程按角色分泳道;静态角色不冒充
 * 运行中实例,运行实例带组件 ID。
 *
 * 口径:
 *   - 入口=活动 Python 编辑器:解析该文件函数清单 → 快速选择入口函数
 *     (节点无行域,光标映射归 FLOW-018 选中反查;v1 快选如实);
 *   - 数据=assembleFlowCallGraph(FLOW-015 数据装配核):有界收集 workspace
 *     scripts 目录下全部 .py(确定序截断,上限与 KODE-PERF-004 同源
 *     10000),def/实现经 entityMappingManager 解析(实体×段×方法);
 *   - 泳道按角色分列(已涉及角色各一条);泳道头标注「静态角色(非运行
 *     实例)」——静态分析没有运行实例,不冒充;运行实例属 G3/TRACE
 *     泳道,届时带组件 ID;
 *   - 渲染=flowReviewSample 自包含 HTML(CSP default-src 'none';工件本体
 *     零脚本,面板只注入 nonce 跳转桥:点击调用点/声明标注跳编辑器
 *     对应行,FLOW-016;R1/R3 词汇红线已由生成核锁定);
 *   - 面板只管 vscode 生命周期与装配调度;数据/HTML 全在纯核
 *     (flowCallGraphData.ts + backend/flowReviewSample.ts)。
 */

import * as vscode from 'vscode';
import { resolveFlowCallSites } from './backend/flowCallResolver';
import {
  assembleFlowCallGraph,
  type FlowCallGraphSource
} from './flowCallGraphData';
import { randomNonce } from './webviewSecurity';
import { resolvePanelLocale, strings } from './webviewStrings';
import type { EntityMappingManager } from './entityMapping';

/** 有界收集上限(与 KODE-PERF-004 callgraph 收集同源;截断在明细中如实) */
const FLOW_FILE_LIMIT = 10_000;

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
      return def ? { defFile: def.defFile, line: def.line } : null;
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
 * 面板跳转脚本(FLOW-016 调用点/声明分别跳转):评审工件 HTML 本身零脚本,
 * 跳转面只在面板内以 nonce 内联脚本激活——点击带 data-flow-jump 的调用点/
 * 声明标注,postMessage 给宿主打开对应文件行。值格式 `${file}:${0 基行}`。
 */
const FLOW_JUMP_SCRIPT = `
(function() {
  var vscode = acquireVsCodeApi();
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
      target = target.parentNode;
    }
  });
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

export class FlowSwimlanePanel {
  private panel: vscode.WebviewPanel | null = null;

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
    const picked =
      functions.length === 1
        ? functions[0]
        : await vscode.window.showQuickPick(functions, { placeHolder: t.pickEntry });
    if (!picked) {
      return;
    }
    try {
      await this.open(rootKey, { filePath, functionName: picked });
    } catch {
      // 装配失败如实告知(入口在装配间隙消失/文件不可读等),不静默
      void vscode.window.showErrorMessage(t.errorAssemble);
    }
  }

  async open(
    rootKey: string,
    entry: { filePath: string; functionName: string }
  ): Promise<void> {
    const t = strings(resolvePanelLocale()).flowSwimlane;
    const title = `${t.title} · ${entry.functionName}`;
    if (this.panel) {
      this.panel.title = title;
      this.panel.reveal();
    } else {
      this.panel = vscode.window.createWebviewPanel(
        'kbengine.flowSwimlane',
        title,
        vscode.ViewColumn.Two,
        { enableScripts: true, retainContextWhenHidden: true }
      );
      // FLOW-016:点击调用点/声明标注跳转编辑器(file:0 基行;行界钳制)
      this.panel.webview.onDidReceiveMessage(message => {
        const jump = parseJumpTarget(
          (message as { command?: string; target?: unknown })?.target
        );
        if ((message as { command?: string })?.command !== 'flowJump' || !jump) {
          return;
        }
        void this.revealLocation(jump.file, jump.line0);
      });
      this.panel.onDidDispose(() => {
        this.panel = null;
      });
    }
    const panel = this.panel;
    const source = this.deps.sourceFactory
      ? this.deps.sourceFactory(rootKey)
      : makeWorkspaceFlowSource(this.deps, rootKey);
    const html = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: t.progress, cancellable: false },
      () => assembleFlowCallGraph(source, entry).then(sample => sample.html)
    );
    if (!this.panel || this.panel !== panel) {
      return; // 装配期间面板已关/换代:弃写
    }
    this.panel.title = title;
    const nonce = randomNonce();
    // 零外部面 CSP;inline style 唯一样式来源;脚本只有本 nonce 的跳转桥
    this.panel.webview.html = html.replace(
      '<head>',
      `<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"><style>[data-flow-jump]{cursor:pointer;text-decoration:underline dotted;}</style><script nonce="${nonce}">${FLOW_JUMP_SCRIPT}</script>`
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
