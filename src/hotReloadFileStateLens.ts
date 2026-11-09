/**
 * 文件顶部状态点呈现(IDE-HOT-100 §3.4):在文件顶部(首个实体定义上方,
 * 简化为首行)挂 CodeLens 状态点 + 当前基线 hash 前 12 位 + 最近一次投递
 * detail。跨目标取最重态呈现(worst wins),与文件树角标同口径。点击命令
 * 打开「KBEngine 热更新」通道落完整状态报告(经注入 view,测试用假体)。
 */

import * as vscode from 'vscode';

import type { HotReloadTargetStateStore } from './backend/hotReloadTargetState';
import {
  worstHotReloadState,
  type HotReloadFileStateMachine,
  type HotReloadFileStateView
} from './backend/hotReloadFileState';

export const HOT_RELOAD_SHOW_FILE_STATE_COMMAND = 'kbengine.hotReload.showFileState';

export interface HotReloadFileStateLensDeps {
  readonly stateMachine: HotReloadFileStateMachine;
  readonly ledger: HotReloadTargetStateStore;
  resolveRootId(file: string): string | null;
  targetsForRoot(rootId: string): string[] | Promise<string[]>;
}

/** 状态点文字(状态 + 基线 hash 前 12 位 + 最近 detail);纯函数便于直测 */
export function formatHotReloadStateLens(view: HotReloadFileStateView): string {
  const parts: string[] = [`$(circle-filled) 热更: ${view.state}`];
  if (view.baselineDigest !== undefined) {
    parts.push(`基线 ${view.baselineDigest.slice(0, 12)}…`);
  }
  const tail = view.reason ?? view.annotation ?? view.detail;
  if (tail !== undefined) {
    parts.push(tail);
  }
  return parts.join(' | ');
}

/**
 * CodeLens provider:文档顶部挂最重态的状态点,command 点击落完整报告。
 * 无目标/无文档内容(空文档)=无 lens。读取文档现内容派生,编辑中即反映。
 */
export class HotReloadFileStateCodeLensProvider implements vscode.CodeLensProvider {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;

  constructor(private readonly deps: HotReloadFileStateLensDeps) {}

  async provideCodeLenses(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken
  ): Promise<vscode.CodeLens[]> {
    const file = document.uri.fsPath;
    const rootId = this.deps.resolveRootId(file);
    if (rootId === null) {
      return [];
    }
    const targets = await this.deps.targetsForRoot(rootId);
    if (targets.length === 0) {
      return [];
    }
    const content = document.getText();
    const views: HotReloadFileStateView[] = [];
    for (const targetId of targets) {
      views.push(this.deps.stateMachine.derive(this.deps.ledger, { rootId, targetId }, file, content));
    }
    const worst = worstHotReloadState(views.map(view => view.state));
    const primary = views.find(view => view.state === worst);
    if (primary === undefined) {
      return [];
    }
    const lens = new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
      title: formatHotReloadStateLens(primary),
      command: HOT_RELOAD_SHOW_FILE_STATE_COMMAND,
      arguments: [file]
    });
    return [lens];
  }

  refresh(): void {
    this.emitter.fire();
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
