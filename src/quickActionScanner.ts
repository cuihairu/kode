/**
 * 首装扫描纯层(设计 1.4,2026-10-15 已代决;2026-10-16 用户令更新):
 * - 对调用方给出的每个根只扫一层、收 `.bat` 与 `.ps1`,不递归;
 * - 启停/导表词表只定分类(category),**不再过滤**——非词表脚本同样进候选,
 *   分类留空(写配置时省略;schema 本就「可省」),由用户在清单里勾选;
 * - 按绝对路径去重;
 * - 目录读取整体注入,本层不碰 vscode.workspace.fs(真实目录读的适配在 quickActions)。
 */

import * as path from 'path';
import { classifyBatchScript } from './quickActionConfig';
import type { QuickActionCategory } from './quickActionConfig';

/** vscode.FileSystemKind 的取值(File=1);fake-vscode 未导出该枚举,这里按真值常量收口 */
export const FILE_SYSTEM_KIND_FILE = 1;

const SCRIPT_PATTERN = /\.(bat|ps1)$/i;

export interface DirectoryEntry {
  name: string;
  /** FileSystemKind;缺省视为非文件(真 vscode 恒有值,注入替身可能不带) */
  type?: number;
}

export interface BatchScriptCandidate {
  path: string;
  /** 词表命中的分类(启停/导表);非词表脚本为 null,写配置时省略该字段 */
  category: QuickActionCategory | null;
}

/** 是否被扫进候选(一层 .bat/.ps1,词表只随行给分类不过滤);分类与路径一并返回便于去重 */
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
    if (!SCRIPT_PATTERN.test(entry.name)) {
      continue;
    }
    const candidatePath = path.join(root, entry.name);
    const normalized = path.resolve(candidatePath).replace(/\\/g, '/');
    const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    candidates.push({ path: candidatePath, category: classifyBatchScript(entry.name) });
  }
  return candidates;
}

/** 扫描多个根目录并按规范化绝对路径去重。 */
export function scanBatchScriptsInRoots(
  roots: readonly string[],
  readDir: (root: string) => DirectoryEntry[]
): BatchScriptCandidate[] {
  const byPath = new Map<string, BatchScriptCandidate>();
  for (const root of roots) {
    for (const candidate of scanBatchScripts(root, readDir)) {
      const normalized = path.resolve(candidate.path).replace(/\\/g, '/');
      const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
      if (!byPath.has(key)) byPath.set(key, candidate);
    }
  }
  return [...byPath.values()];
}
