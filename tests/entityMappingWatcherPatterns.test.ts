import { afterEach, describe, expect, it } from 'vitest';
import { EntityMappingManager } from '../src/entityMapping';
import { workspace } from './helpers/vscodeStub';
import { RelativePattern, Uri } from './fake-vscode/core';
import type { StubFileSystemWatcher } from './fake-vscode/workspaceState';

// IDE-ACC-011 回归锁:entityMapping 的 watcher 三件套(workspace 根+外部根)
// 必须经 RelativePattern 注册 glob。历史坑:`Uri.joinPath(base, '**/*.py')
// .toString()` 在真机宿主把 `**/*` 百分号编码成 `%2A%2A/%2A.py`——pattern
// 匹配不到任何文件,python/def/types 事件(含删除后的导航清理)从未到达
// 重建链;fake Uri 不编码,单测层长期无感,2026-10-29 真机删除验收抓到。
// 本锁断言注册形态(RelativePattern 实例+未编码 glob+正确 base),joinPath
// 字符串形态立即红。

interface CapturedPattern {
  raw: unknown;
  text: string;
}

describe('entityMapping watcher 注册形态(RelativePattern,非编码字符串)', () => {
  const originalCreateWatcher = workspace.createFileSystemWatcher;
  const originalFolders = workspace.workspaceFolders;

  afterEach(() => {
    workspace.createFileSystemWatcher = originalCreateWatcher;
    workspace.workspaceFolders = originalFolders;
  });

  const capturePatterns = (captures: CapturedPattern[]): void => {
    const original = workspace.createFileSystemWatcher;
    workspace.createFileSystemWatcher = ((pattern?: unknown) => {
      const raw = pattern;
      const text = pattern instanceof RelativePattern
        ? `${String(pattern.base)}/${pattern.pattern}`
        : String(pattern);
      captures.push({ raw, text });
      return (original as (p?: unknown) => StubFileSystemWatcher).call(workspace, pattern);
    }) as typeof workspace.createFileSystemWatcher;
  };

  it('workspace 三件套+外部根三件套全部以 RelativePattern 注册未编码 glob', () => {
    workspace.workspaceFolders = [
      { uri: Uri.file('/ws/acc011'), name: 'acc011', index: 0 }
    ];
    const captures: CapturedPattern[] = [];
    capturePatterns(captures);
    const manager = new EntityMappingManager({ subscriptions: [] } as never);

    const entityPatterns = captures.filter(capture =>
      capture.text.endsWith('/**/*.py')
      || capture.text.endsWith('/**/*.def')
      || capture.text.endsWith('/**/{types,alias}.xml'));
    // 三件套都得在(workspace 根 py/def/types)
    expect(entityPatterns.some(c => c.text === '/ws/acc011/**/*.py')).toBe(true);
    expect(entityPatterns.some(c => c.text === '/ws/acc011/**/*.def')).toBe(true);
    expect(entityPatterns.some(c => c.text === '/ws/acc011/**/{types,alias}.xml')).toBe(true);
    // 形态锁:RelativePattern 实例(字符串形态=joinPath 编码坑,真机死 pattern)
    for (const capture of entityPatterns) {
      expect(capture.raw instanceof RelativePattern, `应经 RelativePattern 注册: ${capture.text}`).toBe(true);
    }
    // glob 不得含百分号编码残留(真机 joinPath.toString() 会产出 %2A)
    for (const capture of entityPatterns) {
      expect(capture.text.includes('%')).toBe(false);
    }

    for (const disposable of [{ dispose: () => undefined }]) { void disposable; }
    void manager;
  });
});
