/** Keep workspace discovery and external-root walking on the same exclusion list. */
export const PY_SCAN_EXCLUDED_DIRS = new Set([
  'node_modules', 'third_party', '.git', 'vcpkg', 'build', 'dist',
  'out', '.tmp', 'perf', '.venv', 'venv', 'site-packages', '__pycache__'
]);

export const PY_SCAN_EXCLUDE =
  `**/{${[...PY_SCAN_EXCLUDED_DIRS].join(',')}}/**`;

/**
 * KODE-CFG-017:托管目录副本剔除(防镜像双计)。`.kbengine/inferred/` 镜像
 * scripts 树的 .py 副本会被 kode 自身扫描当独立文件再算一遍;隔离面只写
 * search.exclude / files.watcherExclude(findFiles 不吃 search.exclude),
 * 故扫描出口剔掉托管目录路径。评审三轮 P1:按**绝对路径前缀**判定
 * (workspaceRoot ∪ 外部扫描根 + managedDir 相对值拼出受管根,支持多段
 * 相对配置如 `tools/.kbengine`),不按任意同名段全局剔除——用户工作区里
 * 恰好同名的普通子目录/祖先目录不误伤。
 */
export function filterManagedDirCopies(
  paths: readonly string[],
  managedRoots: readonly string[]
): string[] {
  const roots = managedRoots
    .map(r => r.replace(/\/+$/, ''))
    .filter(r => r.length > 0);
  if (roots.length === 0) {
    return [...paths];
  }
  return paths.filter(p => !roots.some(r => p === r || p.startsWith(r.endsWith('/') ? r : `${r}/`)));
}

/** 外部根遍历目录黑名单并入托管目录名(managedDir 落在扫描根内时同剔) */
export function withManagedDirSkip(dirs: ReadonlySet<string>, managedDir: string): Set<string> {
  const out = new Set(dirs);
  if (managedDir && !managedDir.includes('/')) {
    out.add(managedDir);
  }
  return out;
}

/**
 * ENGINE-LIB-SCAN-005 刀1:KBEngine 引擎仓自带的 Python 标准库镜像
 * (kbe/scripts/common/Lib,纯库文件非业务代码,数千量级)按**路径形态**剔出
 * 业务 python 扫描——只在 `kbe/scripts/common/Lib` 段序下的路径才剔,
 * 普通项目自己的 `Lib`/`lib` 目录不受影响(照 KODE-CFG-017 的「形态/前缀
 * 锚定,不按任意同名段全局剔除」先例)。大小写不敏感(Windows 引擎仓);
 * 分隔符 \ 与 / 都认。
 */
const ENGINE_LIB_SEGMENT_TAIL = ['kbe', 'scripts', 'common', 'lib'] as const;

export function isEnginePythonLibPath(fsPath: string): boolean {
  const parts = fsPath.toLowerCase().split(/[\\/]+/);
  const tail: readonly string[] = ENGINE_LIB_SEGMENT_TAIL;
  if (parts.length < tail.length) {
    return false;
  }
  outer: for (let i = 0; i + tail.length <= parts.length; i++) {
    for (let j = 0; j < tail.length; j++) {
      if (parts[i + j] !== tail[j]) {
        continue outer;
      }
    }
    return true;
  }
  return false;
}
