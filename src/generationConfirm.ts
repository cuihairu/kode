/**
 * 生成计划确认(IDE-GEN-008):实体向导与表单向导共用的同一确认面。
 * 确认行列出将新增/改写的目标与准确路径,只有选"确认生成"才继续;
 * Esc、选计划行或取消都视为未确认,调用方整体中止不写盘。
 */

import * as vscode from 'vscode';

export interface GenerationPlanItem {
  label: string;
  description: string;
}

export async function confirmGenerationPlanItems(items: readonly GenerationPlanItem[]): Promise<boolean> {
  const picked = await vscode.window.showQuickPick(
    [{ label: '确认生成', description: '按清单落盘' }, ...items],
    { placeHolder: '核对将生成的文件（选择"确认生成"继续，Esc 取消）' }
  );

  return picked?.label === '确认生成';
}
