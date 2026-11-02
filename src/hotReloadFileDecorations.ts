/**
 * 文件树角标呈现(IDE-HOT-100 §3.4):按状态给文件名角标/颜色——DIRTY 橙/
 * SENT 蓝/APPLIED 绿/FAILED 红/RESTART_REQUIRED 紫,CLEAN 无角标。文件可
 * 属多个目标(跨目标同文件各自状态),角标取最重一个呈现(worst wins),
 * 不混叫、不与 FAILED 混用。状态机是派生视图,本面只把它映射成
 * FileDecoration;读取/目标集经注入面,测试用假体同形。
 */

import * as vscode from 'vscode';

import type { HotReloadTargetStateStore } from './hotReloadTargetState';
import {
  HOT_RELOAD_STATE_FACES,
  worstHotReloadState,
  type HotReloadFileStateMachine,
  type HotReloadFileStateView
} from './hotReloadFileState';

export interface HotReloadFileDecorationDeps {
  readonly stateMachine: HotReloadFileStateMachine;
  readonly ledger: HotReloadTargetStateStore;
  /** 文件 → 归属扫描根(解不到=null,该文件不呈现) */
  resolveRootId(file: string): string | null;
  /** 某 rootId 下的目标集(部署已知;含无记录目标以便首见即注册基线) */
  targetsForRoot(rootId: string): string[] | Promise<string[]>;
  /** 文件当前内容读取(读不到=undefined,派生按不可读分支走) */
  readFileContent(file: string): string | undefined | Promise<string | undefined>;
}

/**
 * 文件树角标 provider:VS Code 对可见文件逐 URI 调 provideFileDecoration,
 * 本面解析 rootId → 目标集 → 逐目标派生 → worst wins → 角标/颜色/tooltip。
 * 无目标或无状态(全 CLEAN)=无角标(undefined)。
 */
export class HotReloadFileDecorationProvider implements vscode.FileDecorationProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri | undefined>();
  readonly onDidChangeFileDecorations = this.emitter.event;

  constructor(private readonly deps: HotReloadFileDecorationDeps) {}

  async provideFileDecoration(
    uri: vscode.Uri,
    _token: vscode.CancellationToken
  ): Promise<vscode.FileDecoration | undefined> {
    const file = uri.fsPath;
    const rootId = this.deps.resolveRootId(file);
    if (rootId === null) {
      return undefined;
    }
    const targets = await this.deps.targetsForRoot(rootId);
    if (targets.length === 0) {
      return undefined;
    }
    const content = await this.deps.readFileContent(file);
    const views: HotReloadFileStateView[] = [];
    for (const targetId of targets) {
      views.push(this.deps.stateMachine.derive(this.deps.ledger, { rootId, targetId }, file, content));
    }
    return this.toDecoration(views);
  }

  /** 角标映射:worst wins;全 CLEAN=无角标;结构性拦下与 FAILED 各有着色不混用 */
  private toDecoration(views: HotReloadFileStateView[]): vscode.FileDecoration | undefined {
    if (views.length === 0) {
      return undefined;
    }
    const worst = worstHotReloadState(views.map(view => view.state));
    const face = HOT_RELOAD_STATE_FACES[worst];
    if (face === undefined) {
      return undefined;
    }
    return new vscode.FileDecoration(face.badge, face.tooltip, new vscode.ThemeColor(face.color));
  }

  /** 状态变更通知(文件保存/发送/回执后调,VS Code 重渲染角标) */
  refresh(): void {
    this.emitter.fire(undefined);
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
