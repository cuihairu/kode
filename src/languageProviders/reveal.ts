// KODE-ARCH-001 pure-move split from src/languageProviders.ts (zero behavior change).
import * as vscode from 'vscode';
import { EntityMappingManager } from '../entityMapping';
/**
 * 批159(用户令 2026-10-26「点击 codelens 跳 def 后 alt+← 后退,再点没反应」):
 * 镜链不再用内置 vscode.open —— 它对「已打开且已定位」的目标常跳过 reveal,
 * 退回原文件后再点就毫无反应。自建打开链:showTextDocument 带 selection 后,
 * 再对活动编辑器显式 revealRange(若命中),后退后再点也强制滚回。
 * 命令参数与旧 arguments 完全同形(uri, { selection }),测试/调用点零迁移成本。
 */

export interface KbengineSourceRevealArgs {
  uri: vscode.Uri;
  options?: { selection?: vscode.Range };
}

export async function revealSourceCommand(
  uriArg?: vscode.Uri,
  options?: { selection?: vscode.Range }
): Promise<void> {
  if (!uriArg) {
    return;
  }
  const document = await vscode.workspace.openTextDocument(uriArg);
  const selection = options?.selection;
  const editor = await vscode.window.showTextDocument(document, selection ? { selection } : undefined);
  if (selection && editor && typeof (editor as vscode.TextEditor).revealRange === 'function') {
    // TextEditorRevealType 缺失(fake 环境/枚举未就绪)时退 0(Default),不炸
    const revealDefault =
      (vscode as unknown as { TextEditorRevealType?: { Default?: number } }).TextEditorRevealType?.Default ?? 0;
    (editor as vscode.TextEditor).revealRange(selection, revealDefault);
  }
}

/** 开档预热(批159):开 Python 档即触发对应实体 .def 的定向首解析,首次
 * hover/CodeLens 不再吃冷启动等待。索引未就绪时后台补,失败静默(预热是
 * 优化不是功能,不准失败上浮)。 */
export function prewarmKbengineIndex(
  manager: EntityMappingManager,
  document: vscode.TextDocument
): void {
  if (document.languageId !== 'python') {
    return;
  }
  void manager.resolveMethodDefinition(document.fileName, '__prewarm__').catch(() => undefined);
}
