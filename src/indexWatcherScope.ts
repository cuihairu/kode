import * as vscode from 'vscode';

import { PY_SCAN_EXCLUDED_DIRS } from './pythonScanRules';

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

/** 排除目录名统一小写比较(Windows 路径大小写不敏感) */
const PY_SCAN_EXCLUDED_DIRS_LOWER = new Set(
  [...PY_SCAN_EXCLUDED_DIRS].map(name => name.toLowerCase())
);

/**
 * 大小写折叠按平台:Windows 文件系统大小写不敏感才折叠;POSIX 大小写敏感,
 * 无条件折叠会把仅大小写不同的两个路径当成同一路径(误选根/误剥前缀)。
 * 测试可用显式实参覆盖平台默认。
 */
const CASE_INSENSITIVE_FS = process.platform === 'win32';

/** 比较用规范化:统一正斜杠、去尾斜杠,Windows 再折叠大小写 */
function normalizePathForCompare(
  p: string,
  caseInsensitive: boolean = CASE_INSENSITIVE_FS
): string {
  const normalized = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return caseInsensitive ? normalized.toLowerCase() : normalized;
}

/** child 是否落在 parent 之内(含相等),规范化与大小写口径同上 */
export function isPathWithin(
  childPath: string,
  parentPath: string,
  caseInsensitive: boolean = CASE_INSENSITIVE_FS
): boolean {
  const child = normalizePathForCompare(childPath, caseInsensitive);
  const parent = normalizePathForCompare(parentPath, caseInsensitive);
  return child === parent || child.startsWith(`${parent}/`);
}

/**
 * 路径段命中扫描排除目录(node_modules/.git/out/dist 等同口径)。
 * 三轮评审修复:只检查监视根以下的段——排除名单里的普通名(out/build/perf)
 * 也可能是工作区或外部根自身的祖先(如 /home/user/out/proj),按整径匹配会
 * 把整个根的事件全数丢弃;传入监视根集时先剥最长匹配根前缀再查段,大小写
 * 不敏感(Windows)。路径不在任何已知根下时退回整径段检查(旧口径兜底)。
 */
export function isExcludedScanPath(
  fsPath: string,
  rootPaths?: ReadonlyArray<string>,
  caseInsensitive: boolean = CASE_INSENSITIVE_FS
): boolean {
  let relative = normalizePathForCompare(fsPath, caseInsensitive);
  if (rootPaths && rootPaths.length > 0) {
    let matchedRootLength = -1;
    for (const root of rootPaths) {
      const rootKey = normalizePathForCompare(root, caseInsensitive);
      const contained = relative === rootKey || relative.startsWith(`${rootKey}/`);
      if (contained && rootKey.length > matchedRootLength) {
        matchedRootLength = rootKey.length;
      }
    }
    if (matchedRootLength >= 0) {
      relative = relative.slice(matchedRootLength);
    }
  }
  return relative
    .split('/')
    .some(part => PY_SCAN_EXCLUDED_DIRS_LOWER.has(part));
}
