// KODE-CFG-017:scanRoots 托管目录排除(防镜像双计)。
//
// .kbengine/inferred/ 镜像 scripts 树(CFG-017 接入批次),其中的 .py 副本
// 会被 kode 自身扫描(pythonClassIndex **/*.py 等)当作独立文件再算一遍——
// 原文件 + 副本双计。隔离面(managedDirExclusions)只写 search.exclude /
// files.watcherExclude(用户令:不让 VS Code 搜索到 .kbengine,但资源管理器
// 不藏),findFiles 不吃 search.exclude,所以 kode 自身扫描必须在
// findFilesAcrossRoots 出口把托管目录段剔掉。按 kbengine.managedDir 设置值
// 排除,非硬编码 .kbengine。
//
// 纯逻辑面在 pythonScanRules(零 vscode);scanRoots 接线由 fake workspace
// 行为测试锁定。

import { describe, expect, it } from 'vitest';
import {
  filterManagedDirCopies,
  withManagedDirSkip
} from '../src/pythonScanRules';

describe('filterManagedDirCopies(托管目录副本剔除,CFG-017)', () => {
  it('路径含托管目录段(默认 .kbengine)的副本被剔,原文件保留', () => {
    const paths = [
      '/proj/scripts/base/Account.py',
      '/proj/.kbengine/inferred/scripts/base/Account.py',
      '/proj/scripts/cell/Entity.py'
    ];
    expect(filterManagedDirCopies(paths, '.kbengine')).toEqual([
      '/proj/scripts/base/Account.py',
      '/proj/scripts/cell/Entity.py'
    ]);
  });

  it('按配置的目录名剔(非硬编码);同名前缀目录不误伤', () => {
    const paths = [
      '/proj/mykb/data/config.py',
      '/proj/mykbengine/inferred/x.py',
      '/proj/mykb/inferred/deep/x.py'
    ];
    // managedDir = 'mykb':'/proj/mykb/...' 段命中被剔;'mykbengine' 是不同段
    expect(filterManagedDirCopies(paths, 'mykb')).toEqual([
      '/proj/mykbengine/inferred/x.py'
    ]);
  });

  it('空名不剔任何路径(防御)', () => {
    const paths = ['/proj/.kbengine/inferred/x.py'];
    expect(filterManagedDirCopies(paths, '')).toEqual(paths);
  });

  it('withManagedDirSkip:外部根遍历黑名单并入托管目录名', () => {
    const skip = withManagedDirSkip(new Set(['node_modules', '.git']), '.kbengine');
    expect(skip.has('.kbengine')).toBe(true);
    expect(skip.has('node_modules')).toBe(true);
  });
});
