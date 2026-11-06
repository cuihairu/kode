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
 * WIN-3:纯路径逻辑按输入路径风格选 path 实现(平台参数化纯函数,可测)。
 * POSIX 平台 path 即 posix;win32 上反斜杠与盘符前缀(驱动+正/反斜杠,
 * `C:/` 与 `C:\`)都是平台风格信号——含 `\` 或盘符前缀走 path.win32,
 * `/` 开头与相对纯 `/` 形态走 path.posix(单测与 uri.path 派生面)。混用会
 * 让 win32 的 join/resolve/relative 把 /ws/repo 归一成 \ws\repo 并锚到当
 * 前盘,或把合法 cwd 内路径判成越界,输出与消费方期望双双失真。
 * 审核发现修复:旧实现只以 includes('\\') 判风格,盘符+正斜杠路径
 * (`C:/repo/...`) 被误判为 posix,path.posix.resolve 会错误锚到 cwd;
 * 与 usesPosixPath(同样认 `^[A-Za-z]:[\\/]` 盘符)保持一致。
 */
export function selectPathApiForPlatform(
  platform: NodeJS.Platform,
  samplePath: string
): path.PlatformPath {
  if (platform !== 'win32') {
    return path;
  }
  return /^[A-Za-z]:[\\/]/.test(samplePath) || samplePath.includes('\\') ? path.win32 : path.posix;
}

/** 按当前宿主平台选 path 实现(经 selectPathApiForPlatform 参数化)。 */
export function pathApiFor(samplePath: string): path.PlatformPath {
  return selectPathApiForPlatform(process.platform, samplePath);
}

/**
 * 路径模板渲染单一真源(委派 src/variableSubstitution 的官方变量表):
 * `${workspaceFolder}`、`${env:...}` 等占位 → 渲染后的纯文本,**不含任何
 * join/锚定**——锚到工作区根仍由各链自己的路径口径负责。
 *
 * 两链同用本函数,同输入必须同输出(等价性由 tests/pathTemplateEquivalence
 * .test.ts 锁定):
 * - 手工输入链 definitionWorkspace.resolveWorkspacePath(kbengine.entityDefsPath
 *   等配置项 → layout 候选)
 * - 发现链 workspaceDiscovery.resolveAgainstWorkspace(诊断报告的显式配置盘点)
 * 此前手工链漏渲染,配置里的 `${workspaceFolder}/...` 被当相对路径字面拼进
 * def 根(`<root>/${workspaceFolder}/scripts/entity_defs`,必然不存在),与发现链
 * 结论不一致 → def 根定位错位。
 */
export function renderPathTemplate(value: string, workspaceRoot: string): string {
  const folders: VariableFolderRef[] = [{ fsPath: workspaceRoot, name: '' }];
  return substituteVariables(value, { folders });
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
  const resolved = workspaceRoot
    ? renderPathTemplate(value, workspaceRoot)
    : substituteVariables(value, { folders: [] });
  if (resolved.length === 0 || path.isAbsolute(resolved)) {
    return resolved;
  }
  // 相对结果一律以仓库根为基准解析(用户令 2026-10-16:不许假设当前 cwd);
  // 无工作区根可锚 → 空串(调用方按「未解析出」跳过,绝不相对 cwd 探测)
  return workspaceRoot ? joinWorkspacePath(workspaceRoot, resolved) : '';
}
