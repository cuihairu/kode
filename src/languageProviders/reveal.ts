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
  // revealRange 的时机:编辑器必须在返回的这一帧完成 layout。后退(alt+←)后焦点
  // 落回原位、tab 尚未真正激活/渲染完时,同一 tick 里的 revealRange 被忽略——
  // 表现为「点一次没反应,得点两次」(2026-11-23 用户报 MRO 链跳转即此形)。
  // 因此:首帧 reveal 一次,再在编辑器切换落定(onDidChangeActiveTextEditor)与
  // 下一微任务各补一次,保证滚显真正生效;三次都在同一命令内,不引入延迟感。
  const reveal = (editor: unknown): void => {
    if (!selection || !editor || typeof (editor as vscode.TextEditor).revealRange !== 'function') {
      return;
    }
    // TextEditorRevealType 缺失(fake 环境/枚举未就绪)时退 0(Default),不炸
    const revealDefault =
      (vscode as unknown as { TextEditorRevealType?: { Default?: number } }).TextEditorRevealType?.Default ?? 0;
    (editor as vscode.TextEditor).revealRange(selection, revealDefault);
  };
  reveal(editor);
  revealOnActiveEditorChange(reveal);
  revealOnNextMicrotask(reveal);
}

/** 等编辑器切换落定后再滚显一次;落定即退订,不残留监听。 */
function revealOnActiveEditorChange(reveal: (editor: unknown) => void): void {
  if (!vscode.window?.onDidChangeActiveTextEditor) {
    return;
  }
  let settled = false;
  const subscription = vscode.window.onDidChangeActiveTextEditor((active: unknown) => {
    if (settled) {
      return;
    }
    settled = true;
    reveal(active);
    subscription.dispose();
  });
}

/** 下一微任务再滚显一次:layout 晚于命令返回的常规情形。 */
function revealOnNextMicrotask(reveal: (editor: unknown) => void): void {
  const active = (): unknown => (vscode.window?.activeTextEditor as unknown) ?? null;
  Promise.resolve().then(() => {
    reveal(active());
    setTimeout(() => reveal(active()), 0);
  });
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
