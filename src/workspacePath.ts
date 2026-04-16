import * as path from 'path';

export function joinWorkspacePath(basePath: string, ...segments: string[]): string {
  if (usesPosixPath(basePath)) {
    return path.posix.join(basePath, ...segments.map(segment => segment.replace(/\\/g, '/')));
  }

  return path.join(basePath, ...segments);
}

export function usesPosixPath(targetPath: string): boolean {
  return !/^[A-Za-z]:[\\/]/.test(targetPath) && targetPath.includes('/');
}
