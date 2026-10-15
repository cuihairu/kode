/**
 * 首装扫描纯层(设计 1.4,2026-10-15 巡检代决口径):
 * - 只扫工作区根一层、只收 .bat——本地脚本基本就是启停服务器与导配置表两类,不做泛化;
 * - 分类走词表(classifyBatchScript),按「绝对路径 + 类别」去重;
 * - 目录读取整体注入,本层不碰 vscode.workspace.fs(真实目录读的适配在 quickActions)。
 */

import { classifyBatchScript } from './quickActionConfig';
import type { QuickActionCategory } from './quickActionConfig';

/** vscode.FileSystemKind 的取值(File=1);fake-vscode 未导出该枚举,这里按真值常量收口 */
export const FILE_SYSTEM_KIND_FILE = 1;

const BAT_SCRIPT_PATTERN = /\.bat$/i;

export interface DirectoryEntry {
  name: string;
  /** FileSystemKind;缺省视为非文件(真 vscode 恒有值,注入替身可能不带) */
  type?: number;
}

export interface BatchScriptCandidate {
  path: string;
  category: QuickActionCategory;
}

/** 是否被扫进候选(一层 .bat + 词表命中);路径与类别一并返回便于去重 */
export function scanBatchScripts(
  root: string,
  readDir: (root: string) => DirectoryEntry[]
): BatchScriptCandidate[] {
  let entries: DirectoryEntry[];
  try {
    entries = readDir(root);
  } catch {
    // 根目录读不到(权限/未选工作区):静默返回空清单,由调用方决定提示与否
    return [];
  }

  const candidates: BatchScriptCandidate[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== FILE_SYSTEM_KIND_FILE) {
      continue;
    }
    if (!BAT_SCRIPT_PATTERN.test(entry.name)) {
      continue;
    }
    const category = classifyBatchScript(entry.name);
    if (category === null) {
      continue;
    }
    const path = `${root}/${entry.name}`;
    const key = `${category}:${path}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    candidates.push({ path, category });
  }
  return candidates;
}
