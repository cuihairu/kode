/**
 * KODE-CFG-017 推断层：pyrefly infer 外置二进制发现 + 参数构造 + 写权限闸。
 * 纯逻辑层不 import vscode；装配层入口在文件尾部的 sync 入口（同
 * pythonExtraPaths 模式：纯函数重测，执行器薄）。
 *
 * 验证结论（todo KODE-CFG-017）：正确子命令是 `infer`（激进推断，本地字面量
 * + 引用链）而非 `stubgen`（1.4.0 对无标注全落 Incomplete）；def 真值经
 * `--search-path`（.kbengine/stubs）喂入后推断沿真值链走。
 */

import * as path from 'path';

// ---------------------------------------------------------------------------
// 写权限闸（用户令 2026-11-03）：scope 外写一律拒绝，不静默。
// Rust 核搬移前，本函数是全部落盘路径的强制关卡；语义与 Rust 侧一致：
// Managed（默认，仅 .kbengine/**）| UserSource（另含 scripts/**，须显式开启）。
// ---------------------------------------------------------------------------

export type SourceWriteScope = 'managed' | 'user';

export const SOURCE_WRITE_SCOPE_MANAGED: SourceWriteScope = 'managed';
export const SOURCE_WRITE_SCOPE_USER: SourceWriteScope = 'user';

export interface WriteScopeDecision {
  allowed: boolean;
  /** 拒绝原因（allowed=false 时必有，供诊断播报，不静默） */
  reason?: string;
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * 闸判定（纯函数）：target 是否落在 scope 允许的写域内。
 * - managed：仅 <workspaceRoot>/<managedDir>/** 内可写；
 * - user：managed 域 ∪ <scriptsRoot>/**（须用户显式开启
 *   `kbengine.infer.sourceWrite=user`，默认 managed）。
 */
export function assertWritable(
  target: string,
  scope: SourceWriteScope,
  workspaceRoot: string,
  managedDir: string,
  scriptsRoot: string
): WriteScopeDecision {
  const managedRoot = path.join(workspaceRoot, managedDir);
  if (isInside(managedRoot, target)) {
    return { allowed: true };
  }
  if (scope === SOURCE_WRITE_SCOPE_USER && isInside(scriptsRoot, target)) {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason:
      scope === SOURCE_WRITE_SCOPE_MANAGED
        ? `write denied outside managed dir (${managedDir}/): ${target}`
        : `write denied outside managed dir (${managedDir}/) and scripts root: ${target}`
  };
}

// ---------------------------------------------------------------------------
// 二进制发现：设置 > PATH > pipx 默认位。
// ---------------------------------------------------------------------------

export interface PyreflyDiscoveryDeps {
  exists: (absPath: string) => boolean;
  /** PATH 环境变量串（装配层传 process.env.PATH；测试注入） */
  envPath?: string;
  /** 用户主目录（pipx 默认位 ~/.local/bin） */
  homeDir?: string;
}

const PYREFLY_BINARY = 'pyrefly';
const PYREFLY_WINDOWS_BINARY = 'pyrefly.exe';

/** 发现 pyrefly 可执行文件绝对路径；找不到返回 null（功能降级不报错） */
export function discoverPyrefly(settingPath: unknown, deps: PyreflyDiscoveryDeps): string | null {
  if (typeof settingPath === 'string' && settingPath.trim() !== '') {
    const candidate = settingPath.trim();
    return deps.exists(candidate) ? candidate : null;
  }
  const pathEnv = deps.envPath ?? '';
  const names = pathEnv.includes(';') ? [PYREFLY_WINDOWS_BINARY, PYREFLY_BINARY] : [PYREFLY_BINARY];
  for (const dir of pathEnv.split(path.delimiter).filter(segment => segment !== '')) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (deps.exists(candidate)) {
        return candidate;
      }
    }
  }
  if (deps.homeDir) {
    const candidate = path.join(deps.homeDir, '.local', 'bin', PYREFLY_BINARY);
    if (deps.exists(candidate)) {
      return candidate;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 参数构造。
// ---------------------------------------------------------------------------

/**
 * `pyrefly infer --python-version <v> --search-path <stubs>... <targetDir>`
 * （目标 Python 3.7 是 KBEngine 内嵌解释器版本；search-path 喂 def 真值）。
 */
export function buildInferArgs(
  pythonVersion: string,
  searchPaths: readonly string[],
  targetDir: string
): string[] {
  const args = ['infer', '--python-version', pythonVersion];
  for (const searchPath of searchPaths) {
    args.push('--search-path', searchPath);
  }
  args.push(targetDir);
  return args;
}

// ---------------------------------------------------------------------------
// 执行（装配层注入 spawn；测试不依赖真 pyrefly）。
// ---------------------------------------------------------------------------

export interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { cwd?: string }
) => Promise<SpawnResult>;

export type PyreflyRunStatus = 'ran' | 'ran-with-errors' | 'not-found';

export interface PyreflyRunOutcome {
  status: PyreflyRunStatus;
  /** 进程退出码（not-found 无） */
  code?: number;
  /** 退出码非 0 时的 stderr 摘要（供诊断） */
  stderr?: string;
}
