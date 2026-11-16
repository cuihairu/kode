/**
 * RUST-167 类型预览视图适配层:纯核 typePreviewModel 的 TreeView 外衣。
 * 数据不缓存——每次 getChildren 经 deps.getModel 现算(导出/注册表变动后
 * 视图自然跟上,不挂任何事件链);跳转走内部命令,行号 1 起→编辑器 0 基。
 * 受限宿主(fake-vscode 无 createTreeView)退化为 registerTreeDataProvider
 * (与 hotReloadHistoryView 同口径)。
 */

import * as vscode from 'vscode';
import {
  type TypePreviewJump,
  type TypePreviewModel,
  type TypePreviewNode
} from './backend/typePreviewModel';

export const TYPE_PREVIEW_VIEW_ID = 'kbengine.typePreview';
export const TYPE_PREVIEW_JUMP_COMMAND = 'kbengine.typePreview.jump';
export const TYPE_PREVIEW_REFRESH_COMMAND = 'kbengine.typePreview.refresh';

export interface TypePreviewViewDeps {
  /** 生产传 vscode.window.registerTreeDataProvider;测试注入记录替身 */
  registerTreeDataProvider: (viewId: string, provider: vscode.TreeDataProvider<TypePreviewNode>) => unknown;
  registerCommand: (id: string, callback: (...args: never[]) => unknown) => unknown;
  /** 来源跳转执行面:生产=openTextDocument+showTextDocument(reveal 行);测试注入记录替身 */
  openSource: (jump: TypePreviewJump) => void | Promise<void>;
  /** 模型供给面(现算):装配层从 managers/自定义类型注册表现场构造 */
  getModel: () => TypePreviewModel;
}

export interface TypePreviewViewHandle {
  refresh(): void;
  dispose(): void;
}

export function registerTypePreviewView(deps: TypePreviewViewDeps): TypePreviewViewHandle {
  const emitter = new vscode.EventEmitter<void>();
  let model: TypePreviewModel;

  const provider: vscode.TreeDataProvider<TypePreviewNode> = {
    onDidChangeTreeData: emitter.event,
    getTreeItem(node: TypePreviewNode): vscode.TreeItem {
      const item = new vscode.TreeItem(
        node.label,
        node.children && node.children.length > 0
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.None
      );
      if (node.description) {
        item.description = node.description;
      }
      if (node.jump) {
        item.command = {
          command: TYPE_PREVIEW_JUMP_COMMAND,
          title: '跳转来源',
          arguments: [node.jump]
        };
      }
      return item;
    },
    getChildren(node?: TypePreviewNode): TypePreviewNode[] {
      if (!node) {
        model = deps.getModel();
        return model.root.children ?? [];
      }
      return node.children ?? [];
    }
  };

  const jumpDisposable = deps.registerCommand(TYPE_PREVIEW_JUMP_COMMAND, ((jump: TypePreviewJump) => {
    return deps.openSource(jump);
  }) as never);
  const refreshDisposable = deps.registerCommand(TYPE_PREVIEW_REFRESH_COMMAND, (() => {
    emitter.fire(undefined);
  }) as never);
  const providerDisposable = deps.registerTreeDataProvider(TYPE_PREVIEW_VIEW_ID, provider);

  return {
    refresh: (): void => {
      emitter.fire(undefined);
    },
    dispose: (): void => {
      emitter.dispose();
      for (const disposable of [jumpDisposable, refreshDisposable, providerDisposable]) {
        (disposable as { dispose?: () => void })?.dispose?.();
      }
    }
  };
}

/** 装配层默认跳转执行面:打开真实源文件并 reveal 到 1 基行(编辑器 0 基) */
export async function openTypePreviewSource(jump: TypePreviewJump): Promise<void> {
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(jump.uri));
  const editor = await vscode.window.showTextDocument(document);
  const line = Math.max(0, Math.min(jump.line - 1, document.lineCount - 1));
  editor.revealRange(
    new vscode.Range(line, 0, line, 0),
    vscode.TextEditorRevealType.InCenter
  );
}

/** 纯核再出口:装配层(buildTypePreviewInputFromManagers)与测试共用一个进口 */
export { buildTypePreviewModel } from './backend/typePreviewModel';
export type { TypePreviewModel, TypePreviewNode, TypePreviewInput, TypePreviewCoverage, TypePreviewJump } from './backend/typePreviewModel';
