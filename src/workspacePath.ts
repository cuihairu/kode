import * as path from 'path';

export function joinWorkspacePath(basePath: string, ...segments: string[]): string {
  if (usesPosixPath(basePath)) {
    return path.posix.join(basePath, ...segments.map(segment => segment.replace(/\\/g, '/')));
  }

  // 显式走 win32 语义:依赖平台隐式 path 时,在 linux/macOS 主机上
  // path.join 是 posix 实现,会给 C:\ 路径产出生混合分隔符的错误结果。
  return path.win32.join(basePath, ...segments);
}

export function usesPosixPath(targetPath: string): boolean {
  return !/^[A-Za-z]:[\\/]/.test(targetPath) && targetPath.includes('/');
}

/**
 * 展开 ${workspaceFolder} 与 ${env:VAR} 占位符(与 serverManager.getBinPath
 * 同款口径;批112 起 telnet 引擎 defaults 推导与最终配置合成共用此实现)。
 */
export function expandWorkspacePlaceholders(
  value: string,
  workspaceRoot: string | undefined
): string {
  return value
    .replace(/\$\{workspaceFolder\}/g, workspaceRoot || '')
    .replace(/\$\{env:(.+?)\}/g, (_, envVar) => process.env[envVar] || '');
}
