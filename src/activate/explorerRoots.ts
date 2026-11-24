/**
 * 双根角标装配:注册 provider + 监听(profile 切换/根设置变更即时重渲染)。
 * 无开关门(2026-11-24 用户需求定版:双根是事实标记,非装饰偏好,恒开;
 * FOLDER-COLOR-001 的「开关+Kode 主题族」双门不适用本面)。
 */

import * as vscode from 'vscode';

import { onDidChangeActiveProfile } from '../activeProfile';
import {
  ExplorerRootDecorationProvider,
  explorerRootDecorationDeps
} from '../explorerRootDecorations';

export function activateExplorerRootDecorations(
  context: vscode.ExtensionContext
): ExplorerRootDecorationProvider {
  const provider = new ExplorerRootDecorationProvider(explorerRootDecorationDeps(context));
  context.subscriptions.push(vscode.window.registerFileDecorationProvider(provider));
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(event => {
      if (
        event.affectsConfiguration('kbengine.assetsRoot') ||
        event.affectsConfiguration('kbengine.engineRoot')
      ) {
        provider.refresh();
      }
    })
  );
  context.subscriptions.push(onDidChangeActiveProfile(() => provider.refresh()));
  context.subscriptions.push(provider);
  return provider;
}
