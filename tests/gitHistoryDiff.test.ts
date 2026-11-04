import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  GIT_HISTORY_VERSION_SCHEME,
  GitHistoryVersionContentProvider,
  decodeVersionUri,
  getParentCommit,
  makeVersionUri,
  openVersionContent,
  openVersionDiff,
  queryVersionContent,
  relativeVersionPath,
  summarizeVersionError,
  type VersionQueryDeps,
} from '../src/gitHistoryDiff';
import type { GitRunOutcome } from '../src/gitRunner';
import { commandRegistry } from './fake-vscode/commandRegistry';
import { workspaceState } from './fake-vscode/workspaceState';
import { windowState } from './fake-vscode/windowState';

/**
 * IDE-GIT-006:打开历史版本并比较对应修改。
 * 验收:点击提交记录在主编辑区打开该版本 vs 父版本只读 diff;提供只读打开
 * 该版本内容;根提交/删除文件/无内容版本明确处理;不覆盖工作区文件(全走
 * 虚拟文档);虚拟文档按仓库/提交/路径隔离。
 *
 * 纯查询面 + 虚拟文档提供者 + diff/内容打开命令(fake-vscode Uri/commands
 * 记账)。命令体薄,真机行为另由 demo 面验证。
 */

function makeDeps(handler?: (args: readonly string[]) => Promise<GitRunOutcome>): {
  deps: VersionQueryDeps;
  runGit: ReturnType<typeof vi.fn>;
} {
  const runGit = vi.fn(async (args: readonly string[]) => {
    if (handler) return handler(args);
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  });
  return { deps: { runGit, timeoutMs: 5000, maxOutputBytes: 1024 * 1024 }, runGit };
}

const okOutcome = (stdout: string): GitRunOutcome => ({ kind: 'ok', stdout, stderr: '' });
const missingOutcome = (): GitRunOutcome => ({
  kind: 'exit',
  exitCode: 128,
  stderr: "fatal: path 'src/a.py' does not exist in 'abc1234'\n",
});

describe('IDE-GIT-006 路径换算与 URI 三键', () => {
  it('relativeVersionPath:仓库内绝对路径 → 相对路径(/ 分隔,防 `..`/反斜杠逃逸)', () => {
    expect(relativeVersionPath('/repo', '/repo/src/a.py')).toBe('src/a.py');
    expect(relativeVersionPath('/repo', '/repo/src/sub/x.py')).toBe('src/sub/x.py');
    expect(relativeVersionPath('/repo', '/repo/a.py')).toBe('a.py');
    // 仓库外与逃逸都拒绝
    expect(relativeVersionPath('/repo', '/other/a.py')).toBeNull();
    expect(relativeVersionPath('/repo', '/repo/../outside.py')).toBeNull();
  });

  it('makeVersionUri/decode:仓库/提交/路径三键独立往返', () => {
    const uri = makeVersionUri('/repo', 'abc1234', '/repo/src/a.py');
    expect(uri.scheme).toBe(GIT_HISTORY_VERSION_SCHEME);
    expect(uri.path).toBe('/repo/src/a.py');
    const decoded = decodeVersionUri(uri);
    expect(decoded.repoRoot).toBe('/repo');
    expect(decoded.commit).toBe('abc1234');
    expect(decoded.filePath).toBe('/repo/src/a.py');
    // 不同仓库/提交/路径不串味
    const other = makeVersionUri('/repo2', 'def5678', '/repo2/b.py');
    expect(decodeVersionUri(other)).toEqual({ repoRoot: '/repo2', commit: 'def5678', filePath: '/repo2/b.py' });
  });

  it('失败摘要:结构化结果 → 一行文案', () => {
    expect(summarizeVersionError({ kind: 'exit', exitCode: 128, stderr: 'fatal: bad rev\n' })).toContain('fatal: bad rev');
    expect(summarizeVersionError({ kind: 'timeout', timeoutMs: 10 })).toContain('超时');
    expect(summarizeVersionError({ kind: 'spawn', message: 'ENOENT' })).toContain('ENOENT');
  });
});

describe('IDE-GIT-006 版本内容查询', () => {
  it('成功:git show <commit>:<path> 原样返回内容', async () => {
    const { deps, runGit } = makeDeps(async () => okOutcome('line1\nline2\n'));
    const result = await queryVersionContent('/repo', 'abc1234', '/repo/src/a.py', deps);
    expect(result).toEqual({ kind: 'content', content: 'line1\nline2\n' });
    expect(runGit).toHaveBeenCalledWith(
      ['show', 'abc1234:src/a.py'],
      expect.objectContaining({ cwd: '/repo' })
    );
  });

  it('路径在该提交不存在(删除/未创建):missing,不报错', async () => {
    const { deps } = makeDeps(async () => missingOutcome());
    const result = await queryVersionContent('/repo', 'abc1234', '/repo/src/a.py', deps);
    expect(result).toEqual({ kind: 'missing' });
  });

  it('空提交哨兵(根提交父侧):missing 且零 Git 调用', async () => {
    const { deps, runGit } = makeDeps();
    const result = await queryVersionContent('/repo', 'EMPTY', '/repo/src/a.py', deps);
    expect(result).toEqual({ kind: 'missing' });
    expect(runGit).not.toHaveBeenCalled();
  });

  it('仓库外路径:error,不查 Git', async () => {
    const { deps, runGit } = makeDeps();
    const result = await queryVersionContent('/repo', 'abc1234', '/other/a.py', deps);
    expect(result.kind).toBe('error');
    expect(runGit).not.toHaveBeenCalled();
  });

  it('git 启动失败:error 带可操作文案', async () => {
    const { deps } = makeDeps(async () => ({ kind: 'spawn', message: 'ENOENT' }) as GitRunOutcome);
    const result = await queryVersionContent('/repo', 'abc1234', '/repo/src/a.py', deps);
    expect(result.kind).toBe('error');
    if (result.kind === 'error') expect(result.message).toContain('ENOENT');
  });
});

describe('IDE-GIT-006 父提交判定', () => {
  it('根提交:无父 → null(左侧为空)', async () => {
    const { deps } = makeDeps(async () => okOutcome('abc1234\n'));
    await expect(getParentCommit('/repo', 'abc1234', deps)).resolves.toBeNull();
  });

  it('普通提交:首父哈希', async () => {
    const { deps } = makeDeps(async () => okOutcome('abc1234 parent9999\n'));
    await expect(getParentCommit('/repo', 'abc1234', deps)).resolves.toBe('parent9999');
  });

  it('判定失败(非 ok):按无父处理,不抛', async () => {
    const { deps } = makeDeps(async () => ({ kind: 'exit', exitCode: 128, stderr: 'bad rev' }) as GitRunOutcome);
    await expect(getParentCommit('/repo', 'nope', deps)).resolves.toBeNull();
  });
});

describe('IDE-GIT-006 虚拟文档提供者', () => {
  it('内容 URI → 内容;缺失 URI → 空串;EMPTY → 空串', async () => {
    const { deps } = makeDeps(async () => okOutcome('hello'));
    const provider = new GitHistoryVersionContentProvider(deps);
    const uri = makeVersionUri('/repo', 'abc1234', '/repo/src/a.py');
    await expect(provider.provideTextDocumentContent(uri)).resolves.toBe('hello');
    await expect(provider.provideTextDocumentContent(makeVersionUri('/repo', 'EMPTY', '/repo/src/a.py'))).resolves.toBe('');
  });

  it('缺失路径(删除版本) → 空串,不抛', async () => {
    const { deps } = makeDeps(async () => missingOutcome());
    const provider = new GitHistoryVersionContentProvider(deps);
    await expect(provider.provideTextDocumentContent(makeVersionUri('/repo', 'abc1234', '/repo/src/a.py'))).resolves.toBe('');
  });

  it('读取失败 → 抛错(用户可见,不静默空)', async () => {
    const { deps } = makeDeps(async () => ({ kind: 'spawn', message: 'ENOENT' }) as GitRunOutcome);
    const provider = new GitHistoryVersionContentProvider(deps);
    await expect(provider.provideTextDocumentContent(makeVersionUri('/repo', 'abc1234', '/repo/src/a.py'))).rejects.toThrow(/abc1234/);
  });
});

describe('IDE-GIT-006 diff 与内容打开命令', () => {
  it('openVersionDiff:主编辑区 vscode.diff,两侧虚拟文档不覆盖工作区', async () => {
    let diffArgs: unknown[] = [];
    const spy = vi
      .spyOn(vscode.commands, 'executeCommand')
      .mockImplementation(async (command: string, ...args: unknown[]) => {
        if (command === 'vscode.diff') diffArgs = args;
        return undefined;
      });
    try {
      const { deps } = makeDeps(async (args) => {
        if (args[0] === 'rev-list') return okOutcome('abc1234 parent9999\n');
        throw new Error(`unexpected: ${args.join(' ')}`);
      });
      await openVersionDiff('/repo/src/a.py', '/repo', 'abc1234', deps);
      expect(diffArgs).toHaveLength(3);
      const [left, right, title] = diffArgs as [vscode.Uri, vscode.Uri, string];
      expect(left.scheme).toBe(GIT_HISTORY_VERSION_SCHEME);
      expect(right.scheme).toBe(GIT_HISTORY_VERSION_SCHEME);
      expect(decodeVersionUri(left).commit).toBe('parent9999');
      expect(decodeVersionUri(right).commit).toBe('abc1234');
      expect(title).toContain('a.py @ abc1234');
    } finally {
      spy.mockRestore();
    }
  });

  it('openVersionDiff:根提交父侧用空哨兵(整文件呈现为新增)', async () => {
    let diffArgs: unknown[] = [];
    const spy = vi
      .spyOn(vscode.commands, 'executeCommand')
      .mockImplementation(async (command: string, ...args: unknown[]) => {
        if (command === 'vscode.diff') diffArgs = args;
        return undefined;
      });
    try {
      const { deps } = makeDeps(async (args) => {
        if (args[0] === 'rev-list') return okOutcome('root0000\n');
        throw new Error(`unexpected: ${args.join(' ')}`);
      });
      await openVersionDiff('/repo/src/a.py', '/repo', 'root0000', deps);
      const left = diffArgs[0] as vscode.Uri;
      expect(decodeVersionUri(left).commit).toBe('EMPTY');
    } finally {
      spy.mockRestore();
    }
  });

  it('openVersionContent:只读打开该版本(虚拟文档,preview:false,不落盘)', async () => {
    const openCalls = workspaceState.openTextDocumentCalls;
    const before = openCalls.length;
    const showCalls = windowState.showTextDocumentCalls;
    const beforeShow = showCalls.length;
    await openVersionContent('/repo/src/a.py', '/repo', 'abc1234');
    expect(openCalls.length).toBe(before + 1);
    const uri = openCalls[before] as vscode.Uri;
    expect(uri.scheme).toBe(GIT_HISTORY_VERSION_SCHEME);
    expect(decodeVersionUri(uri).commit).toBe('abc1234');
    expect(showCalls.length).toBe(beforeShow + 1);
    expect(showCalls[beforeShow].options).toEqual({ preview: false });
  });
});

afterEach(() => {
  commandRegistry.reset();
});
