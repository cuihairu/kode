import { describe, expect, it } from 'vitest';
import {
  enforceRoleIsolation,
  findCrossRoleModuleCollisions,
  resolveRoleAnalysisRoots
} from '../src/pythonRoleRoots';
import { planPythonExtraPaths } from '../src/pythonExtraPaths';

// IDE-PRJ-006:按 base/cell 角色隔离 Python 分析根。KBEngine 服务端
// scripts/base/<实体>.py 与 scripts/cell/<实体>.py 常有同名模块——合并进
// 一份 extraPaths 后谁排前面谁赢,跨角色误解析。隔离口径:角色目录
// (base/cell,client/bots 不属服务端分析角色)永不进合并列表,合并列表只
// 收 scripts 根本身;同名模块集合如实上报,顺序不再决定解析。

describe('role analysis roots (IDE-PRJ-006)', () => {
  const deps = {
    exists: (candidate: string): boolean =>
      ['/ws/scripts', '/ws/scripts/base', '/ws/scripts/cell', '/ws/scripts/client'].includes(candidate),
    listPyFiles: (): string[] => []
  };

  it('resolves base/cell role dirs under the scripts root (client is not a server analysis role)', () => {
    const roots = resolveRoleAnalysisRoots('/ws/scripts', deps);
    expect(roots.roleRoots.map(entry => entry.role)).toEqual(['base', 'cell']);
    expect(roots.roleRoots.map(entry => entry.root)).toEqual(['/ws/scripts/base', '/ws/scripts/cell']);
  });

  it('reports same-named modules across roles, not same-role duplicates', () => {
    const fileDeps = {
      ...deps,
      listPyFiles: (dir: string): string[] =>
        dir === '/ws/scripts/base'
          ? ['Avatar.py', 'OnlyBase.py']
          : dir === '/ws/scripts/cell'
            ? ['Avatar.py', 'Monster.py']
            : []
    };
    const roots = resolveRoleAnalysisRoots('/ws/scripts', deps);
    // Avatar 两角色同名→上报;OnlyBase/Monster 单角色→不上报
    expect(findCrossRoleModuleCollisions(roots, fileDeps)).toEqual(['Avatar']);
  });

  it('keeps the merged list free of role roots regardless of order', () => {
    const roots = resolveRoleAnalysisRoots('/ws/scripts', deps);
    const merged = ['/ws/scripts/base', '/ws/scripts', '/ws/scripts/cell', '/ws/.kbengine/stubs'];
    const forward = enforceRoleIsolation(merged, roots);
    expect(forward.kept).toEqual(['/ws/scripts', '/ws/.kbengine/stubs']);
    expect(forward.removedRoleRoots.sort()).toEqual(['/ws/scripts/base', '/ws/scripts/cell']);

    // 倒序输入结果集合相同:顺序不再决定谁赢
    const reversed = enforceRoleIsolation([...merged].reverse(), roots);
    expect(reversed.kept.slice().sort()).toEqual(['/ws/.kbengine/stubs', '/ws/scripts'].sort());
  });
});

describe('extraPaths plan isolation (IDE-PRJ-006)', () => {
  it('managed segment never contains role dirs even when they exist on disk', () => {
    const deps = {
      exists: (candidate: string): boolean =>
        ['/ws/scripts', '/ws/scripts/base', '/ws/scripts/cell'].includes(candidate),
      listSubdirs: (): string[] => []
    };

    const plan = planPythonExtraPaths({
      workspaceRoot: '/ws',
      currentPaths: [],
      previouslyManaged: [],
      deps
    });

    expect(plan.nextPaths).toEqual(['/ws/scripts']);
    expect(plan.managedPaths).toEqual(['/ws/scripts']);
    // 角色目录在盘上也不进合并列表:base/Avatar 与 cell/Avatar 不会因
    // extraPaths 顺序跨角色误解析
    expect(plan.nextPaths).not.toContain('/ws/scripts/base');
    expect(plan.nextPaths).not.toContain('/ws/scripts/cell');
  });

  it('user-entered role dirs are left untouched (own-segment-only policy)', () => {
    const deps = {
      exists: (candidate: string): boolean => candidate === '/ws/scripts',
      listSubdirs: (): string[] => []
    };

    const plan = planPythonExtraPaths({
      workspaceRoot: '/ws',
      currentPaths: ['/my/base'],
      previouslyManaged: [],
      deps
    });

    // 用户手填的角色目录不动(只管自己那段);本扩展管理段只收 scripts 根
    expect(plan.nextPaths).toEqual(['/my/base', '/ws/scripts']);
  });
});
