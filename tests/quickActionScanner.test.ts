import { existsSync, readdirSync, statSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { scanBatchScripts, scanBatchScriptsInRoots } from '../src/quickActionScanner';
import type { DirectoryEntry } from '../src/quickActionScanner';

// 首装扫描纯层(设计 1.4;2026-10-16 用户令更新):一层 .bat/.ps1 全收,
// 启停/导表词表只定分类不过滤;目录读取整体注入,不直接碰 vscode.workspace.fs。
// 真实目录读的适配在 quickActionManager 侧,由其用例经内存 fs 驱动。

const readDirOf = (entries: DirectoryEntry[]) => () => entries;

describe('scanBatchScripts', () => {
  it('collects top-level bat scripts that match the word list', () => {
    const entries: DirectoryEntry[] = [
      { name: 'start_server.bat', type: 1 },
      { name: 'stop.bat', type: 1 },
      { name: 'EXPORT_TABLES.bat', type: 1 }
    ];

    expect(scanBatchScripts('/ws', readDirOf(entries))).toEqual([
      { path: '/ws/start_server.bat', category: 'server' },
      { path: '/ws/stop.bat', category: 'server' },
      { path: '/ws/EXPORT_TABLES.bat', category: 'export' }
    ]);
  });

  it('ignores subdirectories and non-script files but keeps every .bat/.ps1', () => {
    const entries: DirectoryEntry[] = [
      { name: 'scripts', type: 2 },
      { name: 'start_server.bat', type: 1 },
      { name: 'readme.txt', type: 1 },
      { name: 'readme.bat', type: 1 },
      { name: 'BOOT_SH.bat', type: 1 },
      { name: 'build.ps1', type: 1 }
    ];

    expect(scanBatchScripts('/ws', readDirOf(entries))).toEqual([
      { path: '/ws/start_server.bat', category: 'server' },
      { path: '/ws/readme.bat', category: null },
      { path: '/ws/BOOT_SH.bat', category: 'server' },
      { path: '/ws/build.ps1', category: null }
    ]);
  });

  it('treats entries without a filesystem kind as non-files', () => {
    const entries: DirectoryEntry[] = [
      { name: 'start_server.bat' },
      { name: 'convert.bat', type: 1 }
    ];

    expect(scanBatchScripts('/ws', readDirOf(entries))).toEqual([
      { path: '/ws/convert.bat', category: 'export' }
    ]);
  });

  it('dedupes by path and keeps the first occurrence', () => {
    const entries: DirectoryEntry[] = [
      { name: 'start_export.bat', type: 1 },
      { name: 'start_export.bat', type: 1 }
    ];

    expect(scanBatchScripts('/ws', readDirOf(entries))).toEqual([
      { path: '/ws/start_export.bat', category: 'server' }
    ]);
  });

  it('returns an empty list for an empty or failing directory', () => {
    expect(scanBatchScripts('/ws', readDirOf([]))).toEqual([]);
    expect(scanBatchScripts('/ws', () => {
      throw new Error('ENOENT');
    })).toEqual([]);
  });
});

describe('scanBatchScriptsInRoots', () => {
  it('combines workspace and assets roots and de-duplicates overlapping files', () => {
    const roots = ['/ws', '/assets', '/ws'];
    const result = scanBatchScriptsInRoots(roots, root =>
      root === '/ws'
        ? [{ name: 'start.bat', type: 1 }]
        : [{ name: 'export.ps1', type: 1 }]
    );
    expect(result.map(item => item.path)).toEqual(['/ws/start.bat', '/assets/export.ps1']);
  });
});

// 真实 kbengine 目录验收(只读;路径不存在的机器自动跳过)
describe('scanBatchScripts on the real kbengine workspace', () => {
  const KBENGINE = 'D:/workspaces/kbengine';

  it('lists the top-level .bat/.ps1 scripts actually present there', () => {
    if (!existsSync(KBENGINE)) {
      console.warn(`skip: kbengine not at ${KBENGINE}`);
      return;
    }
    const candidates = scanBatchScripts(KBENGINE, root =>
      readdirSync(root).map(name => ({
        name,
        type: statSync(`${root}/${name}`).isFile() ? 1 : 2
      }))
    );
    const names = candidates.map(candidate => candidate.path.slice(KBENGINE.length + 1));

    // 真实在盘脚本:词表外的 bat 与 .ps1 都必须在(2026-10-16 口径)
    expect(names).toEqual(
      expect.arrayContaining(['build.bat', 'build.ps1', 'docs-dev.bat', 'docs-dev-clean.bat', 'new_assets.bat'])
    );
    // 一层口径:全部直接位于根下,且都是 .bat/.ps1
    expect(names.every(name => !name.includes('/'))).toBe(true);
    expect(names.every(name => /\.(bat|ps1)$/i.test(name))).toBe(true);
    // 词表外脚本分类留空(不写 category),词表命中才给分类
    expect(candidates.find(candidate => candidate.path.endsWith('build.ps1'))?.category).toBeNull();
    expect(candidates.find(candidate => candidate.path.endsWith('build.bat'))?.category).toBeNull();
  });
});
