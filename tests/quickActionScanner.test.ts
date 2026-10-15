import { describe, expect, it } from 'vitest';
import { scanBatchScripts } from '../src/quickActionScanner';
import type { DirectoryEntry } from '../src/quickActionScanner';

// 首装扫描纯层(设计 1.4 已代决口径):一层 .bat、词表分类、路径+类别去重。
// 目录读取整体注入,不直接碰 vscode.workspace.fs;真实目录读的适配在
// quickActionManager 侧,由其用例经内存 fs 驱动。

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

  it('ignores subdirectories, non-bat files and unmatched bat names', () => {
    const entries: DirectoryEntry[] = [
      { name: 'scripts', type: 2 },
      { name: 'start_server.bat', type: 1 },
      { name: 'readme.txt', type: 1 },
      { name: 'readme.bat', type: 1 },
      { name: 'BOOT_SH.bat', type: 1 }
    ];

    expect(scanBatchScripts('/ws', readDirOf(entries))).toEqual([
      { path: '/ws/start_server.bat', category: 'server' },
      { path: '/ws/BOOT_SH.bat', category: 'server' }
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

  it('dedupes by path plus category and keeps the server match first', () => {
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
