import * as path from 'path';
import { substituteVariables, type VariableFolderRef } from './variableSubstitution';

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
 * WIN-3:纯路径逻辑按输入路径风格选 path 实现。POSIX 平台 path 即 posix;
 * win32 上反斜杠是平台风格信号(盘符/绝对 fsPath)——含 `\` 走平台 path,
 * `/` 开头与相对纯 `/` 形态走 path.posix(单测与 uri.path 派生面)。混用会
 * 让 win32 的 join/resolve/relative 把 /ws/repo 归一成 \ws\repo 并锚到当
 * 前盘,或把合法 cwd 内路径判成越界,输出与消费方期望双双失真。
 */
export function pathApiFor(samplePath: string): path.PlatformPath {
  if (process.platform !== 'win32') {
    return path;
  }
  return samplePath.includes('\\') ? path.win32 : path.posix;
}

/**
 * 展开 VS Code 官方变量(批141 起委派 src/variableSubstitution,替换逻辑
 * 单一真源;与 serverManager.getBinPath 同款口径,批112 起 telnet 引擎
 * defaults 推导与最终配置合成共用此实现)。
 *
 * 沿用本函数既有的「未解析落空串」口径:路径类设置读不到变量时当没写,
 * 不让一个缺失的环境变量把扩展装配整挂。抛错口径由 quickActionConfig
 * 的命令侧自己选。
 */
export function expandWorkspacePlaceholders(
  value: string,
  workspaceRoot: string | undefined
): string {
  const folders: VariableFolderRef[] = workspaceRoot
    ? [{ fsPath: workspaceRoot, name: '' }]
    : [];
  const resolved = substituteVariables(value, { folders });
  if (resolved.length === 0 || path.isAbsolute(resolved)) {
    return resolved;
  }
  // 相对结果一律以仓库根为基准解析(用户令 2026-10-16:不许假设当前 cwd);
  // 无工作区根可锚 → 空串(调用方按「未解析出」跳过,绝不相对 cwd 探测)
  return workspaceRoot ? joinWorkspacePath(workspaceRoot, resolved) : '';
}
