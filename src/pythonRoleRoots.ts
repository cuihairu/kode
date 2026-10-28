/**
 * 按 base/cell 角色隔离 Python 分析根(IDE-PRJ-006)。KBEngine 服务端
 * scripts/base/<实体>.py 与 scripts/cell/<实体>.py 常有同名模块(base 的
 * Avatar 与 cell 的 Avatar 是两个实现);把两个角色目录合并进同一份
 * python.analysis.extraPaths,谁排前面谁赢 `import Avatar`,跨角色误解析
 * 由顺序决定。
 *
 * 隔离口径:角色目录(服务端分析角色=base/cell,与 scriptFoldersForRole
 * 同源;client/bots 不属服务端分析角色)永不进合并列表——合并列表只收
 * scripts 根本身;同名模块集合如实上报(findCrossRoleModuleCollisions),
 * 供健康汇总/同步播报,顺序不再决定解析。用户手填路径不在此模块管辖
 * (extraPaths 只管自己那段)。
 */

import { scriptFoldersForRole } from './definitionWorkspace';

/** 服务端分析角色(client/bots 是客户端/机器人面,不进服务端分析根) */
export type PythonAnalysisRole = 'base' | 'cell';

export interface RoleAnalysisRoots {
  /** scripts 根(合并列表的合法成员) */
  scriptsRoot: string;
  /** 磁盘上真实存在的角色目录(base/cell) */
  roleRoots: Array<{ role: PythonAnalysisRole; root: string }>;
}

export interface RoleRootDeps {
  /** 路径存在性判定(测试注入) */
  exists: (path: string) => boolean;
  /** 列目录下的 .py 文件名(含扩展名;测试注入) */
  listPyFiles: (dir: string) => string[];
}

function toPosix(candidate: string): string {
  return candidate.replace(/\\/g, '/');
}

/** 解析 scripts 根下的角色目录:只收 base/cell 中磁盘上真实存在的 */
export function resolveRoleAnalysisRoots(scriptsRoot: string, deps: Pick<RoleRootDeps, 'exists'>): RoleAnalysisRoots {
  const roleRoots: Array<{ role: PythonAnalysisRole; root: string }> = [];
  for (const role of ['base', 'cell'] as const) {
    for (const folder of scriptFoldersForRole(role)) {
      const root = toPosix(`${scriptsRoot.replace(/[\\/]+$/, '')}/${folder}`);
      if (deps.exists(root)) {
        roleRoots.push({ role, root });
      }
    }
  }
  return { scriptsRoot: toPosix(scriptsRoot), roleRoots };
}

/**
 * 跨角色同名模块清单:出现在 ≥2 个角色目录里的模块名(剥 .py,精确同名),
 * 排序输出。这些模块正是「顺序合并会被误解析」的对象,上报后由隔离口径
 * 兜底(合并列表不含角色根,谁也赢不了)。
 */
export function findCrossRoleModuleCollisions(
  roots: RoleAnalysisRoots,
  deps: Pick<RoleRootDeps, 'listPyFiles'>
): string[] {
  const byModule = new Map<string, Set<PythonAnalysisRole>>();
  for (const { role, root } of roots.roleRoots) {
    for (const fileName of deps.listPyFiles(root)) {
      if (!fileName.endsWith('.py')) {
        continue;
      }
      const moduleName = fileName.slice(0, -'.py'.length);
      const roles = byModule.get(moduleName) ?? new Set<PythonAnalysisRole>();
      roles.add(role);
      byModule.set(moduleName, roles);
    }
  }
  return [...byModule.entries()]
    .filter(([, roles]) => roles.size > 1)
    .map(([moduleName]) => moduleName)
    .sort();
}

/**
 * 隔离闸:从合并列表剥掉与角色根完全一致的条目(顶层同名模块的顺序敏感
 * 解析只发生在角色根一级;更深的条目与角色根不同名空间,不动)。顺序无关
 * ——无论输入顺序,输出 kept 集合不含任何角色根,跨角色同名模块在合并
 * 列表里没有可赢的条目。
 */
export function enforceRoleIsolation(
  paths: readonly string[],
  roots: RoleAnalysisRoots
): { kept: string[]; removedRoleRoots: string[] } {
  const roleRootSet = new Set(roots.roleRoots.map(entry => entry.root));
  const kept: string[] = [];
  const removedRoleRoots: string[] = [];
  for (const candidate of paths) {
    const normalized = toPosix(candidate.replace(/[\\/]+$/, ''));
    if (roleRootSet.has(normalized)) {
      removedRoleRoots.push(normalized);
      continue;
    }
    kept.push(candidate);
  }
  return { kept, removedRoleRoots };
}
