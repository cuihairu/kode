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
