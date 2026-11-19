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
