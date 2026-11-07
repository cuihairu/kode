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
  it('受管根前缀下的副本被剔,原文件保留(默认 .kbengine)', () => {
    const paths = [
      '/proj/scripts/base/Account.py',
      '/proj/.kbengine/inferred/scripts/base/Account.py',
      '/proj/scripts/cell/Entity.py'
    ];
    expect(filterManagedDirCopies(paths, ['/proj/.kbengine'])).toEqual([
      '/proj/scripts/base/Account.py',
      '/proj/scripts/cell/Entity.py'
    ]);
  });

  it('按受管绝对根前缀剔;同名普通目录不误伤(评审三轮 P1 回归)', () => {
    const paths = [
      '/proj/mykb/data/config.py',
      '/proj/mykb/inferred/deep/x.py',
      '/proj/mykbengine/inferred/x.py',
      '/other/assets/mykb/inferred/y.py'
    ];
    // 受管根仅 /proj/mykb:mykbengine 与外部 assets 下的同名目录不误伤
    expect(filterManagedDirCopies(paths, ['/proj/mykb'])).toEqual([
      '/proj/mykbengine/inferred/x.py',
      '/other/assets/mykb/inferred/y.py'
    ]);
  });

  it('多段相对配置(tools/.kbengine)拼出的受管根同样生效(评审三轮 P1 回归)', () => {
    const paths = [
      '/proj/tools/data/config.py',
      '/proj/tools/.kbengine/inferred/config.py'
    ];
    expect(filterManagedDirCopies(paths, ['/proj/tools/.kbengine'])).toEqual([
      '/proj/tools/data/config.py'
    ]);
  });

  it('空受管根集不剔任何路径(防御)', () => {
    const paths = ['/proj/.kbengine/inferred/x.py'];
    expect(filterManagedDirCopies(paths, [])).toEqual(paths);
    expect(filterManagedDirCopies(paths, [''])).toEqual(paths);
  });

  it('withManagedDirSkip:单段名并入黑名单;多段相对值不进名单(走前缀过滤)', () => {
    const skip = withManagedDirSkip(new Set(['node_modules', '.git']), '.kbengine');
    expect(skip.has('.kbengine')).toBe(true);
    expect(skip.has('node_modules')).toBe(true);
    const multi = withManagedDirSkip(new Set(), 'tools/.kbengine');
    expect(multi.size).toBe(0);
  });
});
