import * as vscode from 'vscode';

import { PY_SCAN_EXCLUDED_DIRS } from './backend/pythonScanRules';

// KODE-PERF 重复扫描抑制:watchPythonIndex 在 workspace folders 变化与
// assetsRoot/enableMroJump 配置变化两处被整组拆除重建。两类事件都可能重复
// 触发(同配置的重复通知、无实质变化的 folders 事件),每次重建都伴随
// invalidate + 全量后台重扫——用户侧观感即「一直在扫描一直在加载」。
// 两条抑制面:
// ① 签名守卫:patterns(工作区 glob + 外部根 RelativePattern 集)未变化时
//    跳过整组重建——watcher 集是 patterns 的纯函数,同签名重建是空转;
// ② 排除目录出口过滤:node_modules/.git/out/dist 等 PY_SCAN_EXCLUDED_DIRS
//    命中的路径事件在 watcher 出口即丢弃,不再进合并器/消费索引(消费面
//    各自内部早有同口径过滤,这里是把空转挡在最上游)。

/** patterns 签名:字符串 glob 原样,RelativePattern 用 base::pattern 拼接 */
export function watcherPatternSignature(
  patterns: ReadonlyArray<vscode.GlobPattern>
): string {
  return patterns
    .map(pattern => {
      if (typeof pattern === 'string') {
        return pattern;
      }
      const relative = pattern as vscode.RelativePattern;
      return `${relative.base}::${relative.pattern}`;
    })
    .join('|');
}

/** 路径任一段命中扫描排除目录(node_modules/.git/out/dist 等同口径) */
export function isExcludedScanPath(fsPath: string): boolean {
  return fsPath
    .split(/[\\/]/)
    .some(part => PY_SCAN_EXCLUDED_DIRS.has(part));
}
