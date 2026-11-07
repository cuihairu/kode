/**
 * 生成计划确认(IDE-GEN-008):实体向导与表单向导共用的同一确认面。
 * 确认行列出将新增/改写的目标与准确路径,只有选"确认生成"才继续;
 * Esc、选计划行或取消都视为未确认,调用方整体中止不写盘。
 */

import * as vscode from 'vscode';
import { l10nText } from './nlsRuntime';

export interface GenerationPlanItem {
  label: string;
  description: string;
}

export async function confirmGenerationPlanItems(items: readonly GenerationPlanItem[]): Promise<boolean> {
  const picked = await vscode.window.showQuickPick(
    [{ label: l10nText('Confirm generation'), description: l10nText('Write files per the manifest') }, ...items],
    { placeHolder: l10nText('Review the files to generate (pick Confirm generation to continue, Esc to cancel)') }
  );

  return picked?.label === l10nText('Confirm generation');
}
