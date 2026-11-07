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
 * 故扫描出口按路径段剔掉托管目录。目录名来自 kbengine.managedDir 设置值,
 * 非硬编码 .kbengine;段匹配(分隔符界定,`mykb` 不误伤 `mykbengine`)。
 */
export function filterManagedDirCopies(paths: readonly string[], managedDir: string): string[] {
  if (!managedDir) {
    return [...paths];
  }
  return paths.filter(p => !p.split('/').includes(managedDir));
}

/** 外部根遍历目录黑名单并入托管目录名(managedDir 落在扫描根内时同剔) */
export function withManagedDirSkip(dirs: ReadonlySet<string>, managedDir: string): Set<string> {
  const out = new Set(dirs);
  if (managedDir) {
    out.add(managedDir);
  }
  return out;
}
