import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  describeSelectionMap,
  editorSelectionToRange,
  mapRangeViaHunks,
  mapSelectionToHeadRange,
  parseDiffHunks,
  type DiffHunk,
  type GitSelectionMapDeps,
} from '../src/gitSelectionMap';
import { runGitReadOnly, type GitRunOutcome } from '../src/gitRunner';

/**
 * IDE-GIT-008:把编辑器选区映射到已提交(HEAD)行范围。
 * 验收:支持单行与多行选区;覆盖插入/删除导致的偏移;未保存/未提交新增行
 * 不能准确映射时明确提示,不把当前行号直接当 HEAD 行号。
 *
 * 纯 hunk 算术 + 依赖注入流程(mock)+ 真实临时仓库内容对拍(映射到的 HEAD
 * 行内容与工作区行内容逐行相等)。
 */

const realDeps: GitSelectionMapDeps = {
  runGit: (args, cwd) => runGitReadOnly(args, { cwd, timeoutMs: 10000, maxOutputBytes: 2097152 }),
};

const ok = (stdout: string): GitRunOutcome => ({ kind: 'ok', stdout, stderr: '' });

function makeDeps(handler?: (args: readonly string[]) => Promise<GitRunOutcome> | GitRunOutcome): {
  deps: GitSelectionMapDeps;
  runGit: ReturnType<typeof vi.fn>;
} {
  const runGit = vi.fn(async (args: readonly string[]) => {
    if (handler) return handler(args);
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  });
  return { deps: { runGit }, runGit };
}

/** 默认 mock:已跟踪 + 干净工作区(ls-files 命中,diff 无 hunk)。 */
function cleanHandler(rel = 'src/a.py'): (args: readonly string[]) => GitRunOutcome {
  return (args) => {
    if (args[0] === 'ls-files') return ok(`${rel}\n`);
    if (args[0] === 'diff') return ok('');
    throw new Error(`unexpected: ${args.join(' ')}`);
  };
}

describe('IDE-GIT-008 parseDiffHunks', () => {
  it('标准 hunk(带计数)、计数缺省=1、新文件/整删特殊形态', () => {
    const hunks = parseDiffHunks(
      [
        'diff --git a/src/a.py b/src/a.py',
        'index 111..222 100644',
        '--- a/src/a.py',
        '+++ b/src/a.py',
        '@@ -1,3 +1,5 @@',
        '+x',
        '@@ -3 +3 @@',
        '-a',
        '+b',
        '@@ -0,0 +1,4 @@',
        '@@ -1,4 +0,0 @@',
        '\\ No newline at end of file',
      ].join('\n')
    );
    expect(hunks).toEqual([
      { oldStart: 1, oldCount: 3, newStart: 1, newCount: 5 },
      { oldStart: 3, oldCount: 1, newStart: 3, newCount: 1 },
      { oldStart: 0, oldCount: 0, newStart: 1, newCount: 4 },
      { oldStart: 1, oldCount: 4, newStart: 0, newCount: 0 },
    ]);
  });

  it('空输出/纯头无 hunk → 空数组', () => {
    expect(parseDiffHunks('')).toEqual([]);
    expect(parseDiffHunks('diff --git a/x b/x\nindex 1..2\n')).toEqual([]);
  });
});

describe('IDE-GIT-008 mapRangeViaHunks 纯算术', () => {
  const h = (oldStart: number, oldCount: number, newStart: number, newCount: number): DiffHunk => ({
    oldStart,
    oldCount,
    newStart,
    newCount,
  });

  it('干净文件(无 hunk):当前行=HEAD 行,单行/多行一致', () => {
    expect(mapRangeViaHunks([], { startLine: 3, endLine: 7 })).toEqual({
      segments: [{ firstLine: 3, lastLine: 7, headFirstLine: 3, headLastLine: 7 }],
      unmappedLines: 0,
    });
    expect(mapRangeViaHunks([], { startLine: 4, endLine: 4 })).toEqual({
      segments: [{ firstLine: 4, lastLine: 4, headFirstLine: 4, headLastLine: 4 }],
      unmappedLines: 0,
    });
  });

  it('上方插入(偏移):选区 HEAD 行上移', () => {
    // 顶部插 2 行:@@ -0,0 +1,2 @@ → 工作区行 3-4 = HEAD 行 1-2
    const r = mapRangeViaHunks([h(0, 0, 1, 2)], { startLine: 3, endLine: 4 });
    expect(r.segments).toEqual([{ firstLine: 3, lastLine: 4, headFirstLine: 1, headLastLine: 2 }]);
    expect(r.unmappedLines).toBe(0);
    // 行 2 后插 3 行:@@ -1,0 +2,3 @@ → 工作区行 5-6 = HEAD 行 2-3
    const r2 = mapRangeViaHunks([h(1, 0, 2, 3)], { startLine: 5, endLine: 6 });
    expect(r2.segments).toEqual([{ firstLine: 5, lastLine: 6, headFirstLine: 2, headLastLine: 3 }]);
  });

  it('上方删除(偏移):选区 HEAD 行下移', () => {
    // HEAD 行 2-3 删除:@@ -2,2 +2,0 @@ → 工作区行 3-4 = HEAD 行 5-6
    const r = mapRangeViaHunks([h(2, 2, 2, 0)], { startLine: 3, endLine: 4 });
    expect(r.segments).toEqual([{ firstLine: 3, lastLine: 4, headFirstLine: 5, headLastLine: 6 }]);
    // 顶部删 2 行:@@ -1,2 +0,0 @@ → 工作区行 1 = HEAD 行 3
    const r2 = mapRangeViaHunks([h(1, 2, 0, 0)], { startLine: 1, endLine: 1 });
    expect(r2.segments).toEqual([{ firstLine: 1, lastLine: 1, headFirstLine: 3, headLastLine: 3 }]);
  });

  it('选区内修改行:分段 + 该行计入 unmapped,不假装可映射', () => {
    // HEAD 行 3 被改:@@ -3 +3 @@;选区 1-5 → [1-2]→[1-2]、[4-5]→[4-5],行 3 unmapped
    const r = mapRangeViaHunks([h(3, 1, 3, 1)], { startLine: 1, endLine: 5 });
    expect(r.segments).toEqual([
      { firstLine: 1, lastLine: 2, headFirstLine: 1, headLastLine: 2 },
      { firstLine: 4, lastLine: 5, headFirstLine: 4, headLastLine: 5 },
    ]);
    expect(r.unmappedLines).toBe(1);
  });

  it('选区内纯插入:两侧分段,插入行 unmapped,后段 HEAD 行回收', () => {
    // HEAD 4/5 之间插 2 行:@@ -4,0 +5,2 @@;选区 4-7 → [4]→[4]、[7]→[5]
    const r = mapRangeViaHunks([h(4, 0, 5, 2)], { startLine: 4, endLine: 7 });
    expect(r.segments).toEqual([
      { firstLine: 4, lastLine: 4, headFirstLine: 4, headLastLine: 4 },
      { firstLine: 7, lastLine: 7, headFirstLine: 5, headLastLine: 5 },
    ]);
    expect(r.unmappedLines).toBe(2);
  });

  it('选区全落在变更区:零段、全 unmapped', () => {
    const r = mapRangeViaHunks([h(3, 2, 3, 4)], { startLine: 4, endLine: 5 });
    expect(r.segments).toEqual([]);
    expect(r.unmappedLines).toBe(2);
  });

  it('多 hunk 叠加:插入+删除+修改累积偏移', () => {
    // 顶插 2(h0,0+1,2)、删 HEAD 5(h5,1+6,0)、改工作区 9(h8,1+9,1)
    const hunks = [h(0, 0, 1, 2), h(5, 1, 6, 0), h(8, 1, 9, 1)];
    // 工作区行 7-8(=HEAD 6-7)与 10-11(=HEAD 9-10)
    const r = mapRangeViaHunks(hunks, { startLine: 7, endLine: 11 });
    expect(r.segments).toEqual([
      { firstLine: 7, lastLine: 8, headFirstLine: 6, headLastLine: 7 },
      { firstLine: 10, lastLine: 11, headFirstLine: 9, headLastLine: 10 },
    ]);
    expect(r.unmappedLines).toBe(1);
  });

  it('选区在 hunk 之间的清洁区:一段且偏移正确', () => {
    // 顶插 2 + 尾部改(工作区 10):选区 5-9 全清洁 → HEAD 3-7
    const r = mapRangeViaHunks([h(0, 0, 1, 2), h(8, 1, 10, 1)], { startLine: 5, endLine: 9 });
    expect(r.segments).toEqual([{ firstLine: 5, lastLine: 9, headFirstLine: 3, headLastLine: 7 }]);
    expect(r.unmappedLines).toBe(0);
  });
});

describe('IDE-GIT-008 流程(依赖注入)', () => {
  it('参数面:先 ls-files 探测,再 diff HEAD -U0,路径仓库相对 + `--`', async () => {
    const { deps, runGit } = makeDeps(cleanHandler('src/a.py'));
    const r = await mapSelectionToHeadRange('/repo/src/a.py', '/repo', { startLine: 2, endLine: 3 }, deps);
    expect(r.kind).toBe('mapped');
    expect(runGit).toHaveBeenNthCalledWith(1, ['ls-files', '--', 'src/a.py'], '/repo', undefined);
    expect(runGit).toHaveBeenNthCalledWith(2, ['diff', 'HEAD', '--unified=0', '--', 'src/a.py'], '/repo', undefined);
    expect(runGit).toHaveBeenCalledTimes(2);
  });

  it('未跟踪:ls-files 空 → untracked,不再 diff', async () => {
    const { deps, runGit } = makeDeps((args) => (args[0] === 'ls-files' ? ok('') : ok('')));
    const r = await mapSelectionToHeadRange('/repo/new.py', '/repo', { startLine: 1, endLine: 2 }, deps);
    expect(r).toEqual({ kind: 'untracked' });
    expect(runGit).toHaveBeenCalledTimes(1);
  });

  it('ls-files 非 ok(如启动失败)→ git-error,不冒充未跟踪', async () => {
    const { deps } = makeDeps((args) =>
      args[0] === 'ls-files' ? ({ kind: 'spawn', message: 'ENOENT' } as GitRunOutcome) : ok('')
    );
    const r = await mapSelectionToHeadRange('/repo/a.py', '/repo', { startLine: 1, endLine: 1 }, deps);
    expect(r.kind).toBe('git-error');
  });

  it('无提交仓库:diff 报 unknown revision → rev-parse 探测 → no-commits', async () => {
    const { deps, runGit } = makeDeps((args) => {
      if (args[0] === 'ls-files') return ok('a.py\n');
      if (args[0] === 'diff')
        return {
          kind: 'exit',
          exitCode: 128,
          stderr: "fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree.\n",
        } as GitRunOutcome;
      if (args[0] === 'rev-parse')
        return { kind: 'exit', exitCode: 128, stderr: 'fatal: Needed a single revision\n' } as GitRunOutcome;
      throw new Error(`unexpected: ${args.join(' ')}`);
    });
    const r = await mapSelectionToHeadRange('/repo/a.py', '/repo', { startLine: 1, endLine: 1 }, deps);
    expect(r).toEqual({ kind: 'no-commits' });
    expect(runGit).toHaveBeenLastCalledWith(['rev-parse', '--verify', 'HEAD'], '/repo', undefined);
  });

  it('diff 其它 128 失败:rev-parse 正常 → git-error 原样透传', async () => {
    const { deps } = makeDeps((args) => {
      if (args[0] === 'ls-files') return ok('a.py\n');
      if (args[0] === 'diff')
        return { kind: 'exit', exitCode: 128, stderr: 'fatal: bad object\n' } as GitRunOutcome;
      if (args[0] === 'rev-parse') return ok('abc1234\n');
      throw new Error(`unexpected: ${args.join(' ')}`);
    });
    const r = await mapSelectionToHeadRange('/repo/a.py', '/repo', { startLine: 1, endLine: 1 }, deps);
    expect(r.kind).toBe('git-error');
  });

  it('diff 启动失败 → git-error,不再探测', async () => {
    const { deps } = makeDeps((args) => {
      if (args[0] === 'ls-files') return ok('a.py\n');
      return { kind: 'spawn', message: 'ENOENT' } as GitRunOutcome;
    });
    const r = await mapSelectionToHeadRange('/repo/a.py', '/repo', { startLine: 1, endLine: 1 }, deps);
    expect(r.kind).toBe('git-error');
  });

  it('二进制差异(无 hunk 但报 Binary files)→ binary', async () => {
    const { deps } = makeDeps((args) => {
      if (args[0] === 'ls-files') return ok('a.bin\n');
      return ok('diff --git a/a.bin b/a.bin\nindex 1..2 100644\nBinary files a/a.bin and b/a.bin differ\n');
    });
    const r = await mapSelectionToHeadRange('/repo/a.bin', '/repo', { startLine: 1, endLine: 3 }, deps);
    expect(r).toEqual({ kind: 'binary' });
  });

  it('非法选区(0 行/倒置/非整数)与仓库外路径:invalid-selection,零 Git 调用', async () => {
    const { deps, runGit } = makeDeps();
    const a = await mapSelectionToHeadRange('/repo/a.py', '/repo', { startLine: 0, endLine: 2 }, deps);
    const b = await mapSelectionToHeadRange('/repo/a.py', '/repo', { startLine: 5, endLine: 4 }, deps);
    const c = await mapSelectionToHeadRange('/repo/a.py', '/repo', { startLine: 1.5, endLine: 2 }, deps);
    const d = await mapSelectionToHeadRange('/other/a.py', '/repo', { startLine: 1, endLine: 1 }, deps);
    expect(a.kind).toBe('invalid-selection');
    expect(b.kind).toBe('invalid-selection');
    expect(c.kind).toBe('invalid-selection');
    expect(d.kind).toBe('invalid-selection');
    expect(runGit).not.toHaveBeenCalled();
  });

  it('editorSelectionToRange:0 基编辑器行 → 1 基选区', () => {
    expect(editorSelectionToRange(2, 5)).toEqual({ startLine: 3, endLine: 6 });
  });
});

describe('IDE-GIT-008 describeSelectionMap 文案', () => {
  it('mapped 单段/多段', () => {
    expect(
      describeSelectionMap({
        kind: 'mapped',
        selectionLineCount: 4,
        segments: [{ firstLine: 3, lastLine: 6, headFirstLine: 1, headLastLine: 4 }],
      })
    ).toContain('已提交(HEAD)行 1-4');
    expect(
      describeSelectionMap({
        kind: 'mapped',
        selectionLineCount: 4,
        segments: [
          { firstLine: 1, lastLine: 2, headFirstLine: 1, headLastLine: 2 },
          { firstLine: 5, lastLine: 6, headFirstLine: 4, headLastLine: 5 },
        ],
      })
    ).toContain('共 2 段');
  });

  it('has-uncommitted:明确「未提交/未保存」「不直接当 HEAD 行号」与可操作指引', () => {
    const text = describeSelectionMap({
      kind: 'has-uncommitted',
      selectionLineCount: 5,
      unmappedLines: 2,
      segments: [{ firstLine: 3, lastLine: 5, headFirstLine: 1, headLastLine: 3 }],
    });
    expect(text).toContain('未提交');
    expect(text).toContain('不直接当作 HEAD 行号');
    expect(text).toContain('保存后重试');
    expect(text).toContain('HEAD 行 1-3');
    const all = describeSelectionMap({
      kind: 'has-uncommitted',
      selectionLineCount: 2,
      unmappedLines: 2,
      segments: [],
    });
    expect(all).toContain('2 行');
    expect(all).not.toContain('已提交部分');
  });

  it('各终态文案', () => {
    expect(describeSelectionMap({ kind: 'untracked' })).toContain('未纳入 Git 跟踪');
    expect(describeSelectionMap({ kind: 'no-commits' })).toContain('尚无提交');
    expect(describeSelectionMap({ kind: 'binary' })).toContain('二进制');
    expect(describeSelectionMap({ kind: 'invalid-selection', reason: '选区起始行必须 ≥ 1' })).toContain('≥ 1');
    expect(
      describeSelectionMap({ kind: 'git-error', outcome: { kind: 'timeout', timeoutMs: 10 } })
    ).toContain('超时');
  });
});

describe('IDE-GIT-008 真实临时仓库:偏移换算与内容对拍', () => {
  function makeRepo(): string {
    const root = mkdtempSync(join(tmpdir(), 'kode-selmap-'));
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'T'], { cwd: root });
    return root;
  }

  function commitAll(root: string, message: string): void {
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['commit', '-q', '-m', message], { cwd: root });
  }

  function headLines(root: string, rel: string): string[] {
    return execFileSync('git', ['show', `HEAD:${rel}`], { cwd: root, maxBuffer: 16 * 1024 * 1024 })
      .toString()
      .split('\n');
  }

  it('插入+删除+修改叠加:干净区段映射正确,HEAD 行内容与工作区行逐行相等', async () => {
    const root = makeRepo();
    // HEAD:l1..l10;工作区:顶插 2 行 + 删 l5 + 改 l8
    writeFileSync(join(root, 'a.py'), Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join('\n') + '\n');
    commitAll(root, 'base');
    const work = ['new-a', 'new-b', 'l1', 'l2', 'l3', 'l4', 'l6', 'l7', 'l8-mod', 'l9', 'l10'];
    writeFileSync(join(root, 'a.py'), work.join('\n') + '\n');

    // 选区工作区行 3-6(插入偏移后)→ HEAD 行 1-4,内容对拍逐行相等
    const r = await mapSelectionToHeadRange(join(root, 'a.py'), root, { startLine: 3, endLine: 6 }, realDeps);
    expect(r.kind).toBe('mapped');
    if (r.kind === 'mapped') {
      expect(r.segments).toEqual([{ firstLine: 3, lastLine: 6, headFirstLine: 1, headLastLine: 4 }]);
      const head = headLines(root, 'a.py');
      for (let i = 0; i < 4; i += 1) {
        expect(work[2 + i]).toBe(head[i]); // work 行 3+i ↔ HEAD 行 i+1(0 基索引 i)
      }
    }

    // 选区工作区行 7-8(删除偏移后)→ HEAD 行 6-7
    const r2 = await mapSelectionToHeadRange(join(root, 'a.py'), root, { startLine: 7, endLine: 8 }, realDeps);
    expect(r2.kind).toBe('mapped');
    if (r2.kind === 'mapped') {
      expect(r2.segments[0]).toMatchObject({ headFirstLine: 6, headLastLine: 7 });
      const head = headLines(root, 'a.py');
      expect(work[6]).toBe(head[5]);
      expect(work[7]).toBe(head[6]);
    }
  // WIN-3:win32 逐次 git.exe spawn 慢,平台化超时
  }, 20000);

  it('选区含修改/插入行:如实 has-uncommitted,干净行仍给出 HEAD 段', async () => {
    const root = makeRepo();
    writeFileSync(join(root, 'a.py'), 'l1\nl2\nl3\nl4\nl5\n');
    commitAll(root, 'base');
    // 顶插 1 行 + 改 l3
    writeFileSync(join(root, 'a.py'), 'top\nl1\nl2\nl3-mod\nl4\nl5\n');
    const work = ['top', 'l1', 'l2', 'l3-mod', 'l4', 'l5'];

    const r = await mapSelectionToHeadRange(join(root, 'a.py'), root, { startLine: 1, endLine: 6 }, realDeps);
    expect(r.kind).toBe('has-uncommitted');
    if (r.kind === 'has-uncommitted') {
      expect(r.unmappedLines).toBe(2);
      expect(r.segments).toEqual([
        { firstLine: 2, lastLine: 3, headFirstLine: 1, headLastLine: 2 },
        { firstLine: 5, lastLine: 6, headFirstLine: 4, headLastLine: 5 },
      ]);
      // 干净段内容与 HEAD 逐行相等
      const head = headLines(root, 'a.py');
      expect(work[1]).toBe(head[0]);
      expect(work[4]).toBe(head[3]);
    }

    // 纯新增区(单行):零段全 unmapped
    const r2 = await mapSelectionToHeadRange(join(root, 'a.py'), root, { startLine: 1, endLine: 1 }, realDeps);
    expect(r2).toMatchObject({ kind: 'has-uncommitted', unmappedLines: 1, segments: [] });
  // WIN-3:win32 逐次 git.exe spawn 慢(冷启动/AV 扫描),平台化超时
  }, 20000);

  it('干净工作区:恒等映射,单行与多行选区', async () => {
    const root = makeRepo();
    writeFileSync(join(root, 'a.py'), 'a\nb\nc\nd\ne\n');
    commitAll(root, 'base');
    const single = await mapSelectionToHeadRange(join(root, 'a.py'), root, { startLine: 2, endLine: 2 }, realDeps);
    expect(single).toMatchObject({
      kind: 'mapped',
      segments: [{ firstLine: 2, lastLine: 2, headFirstLine: 2, headLastLine: 2 }],
    });
    const multi = await mapSelectionToHeadRange(join(root, 'a.py'), root, { startLine: 2, endLine: 4 }, realDeps);
    expect(multi).toMatchObject({
      kind: 'mapped',
      segments: [{ firstLine: 2, lastLine: 4, headFirstLine: 2, headLastLine: 4 }],
    });
  // WIN-3:win32 逐次 git.exe spawn 慢,平台化超时
  }, 20000);

  it('中文与空格文件名:路径逐字往返,映射不受影响', async () => {
    const root = makeRepo();
    const rel = 'scripts/脚本 一.py';
    execFileSync('mkdir', ['-p', join(root, 'scripts')]);
    writeFileSync(join(root, rel), 'x = 1\ny = 2\n');
    commitAll(root, 'base');
    writeFileSync(join(root, rel), 'x = 1\ny = 2\nz = 3\n');
    const r = await mapSelectionToHeadRange(join(root, rel), root, { startLine: 3, endLine: 3 }, realDeps);
    expect(r).toMatchObject({ kind: 'has-uncommitted', unmappedLines: 1 });
    const r2 = await mapSelectionToHeadRange(join(root, rel), root, { startLine: 2, endLine: 2 }, realDeps);
    expect(r2).toMatchObject({
      kind: 'mapped',
      segments: [{ firstLine: 2, lastLine: 2, headFirstLine: 2, headLastLine: 2 }],
    });
  // WIN-3:win32 逐次 git.exe spawn 慢,平台化超时
  }, 20000);

  it('未跟踪文件 → untracked;已暂存新文件(仓库有提交)→ 整文件无 HEAD 对应', async () => {
    const root = makeRepo();
    writeFileSync(join(root, 'base.py'), 'b\n');
    commitAll(root, 'base');
    writeFileSync(join(root, 'untracked.py'), 'u1\nu2\n');
    const r = await mapSelectionToHeadRange(join(root, 'untracked.py'), root, { startLine: 1, endLine: 2 }, realDeps);
    expect(r).toEqual({ kind: 'untracked' });

    // staged.py:已暂存新文件(在 index、不在 HEAD)→ 整文件无 HEAD 对应
    writeFileSync(join(root, 'staged.py'), 's1\ns2\n');
    execFileSync('git', ['add', 'staged.py'], { cwd: root });
    const r2 = await mapSelectionToHeadRange(join(root, 'staged.py'), root, { startLine: 1, endLine: 2 }, realDeps);
    expect(r2).toMatchObject({ kind: 'has-uncommitted', unmappedLines: 2, segments: [] });
  // WIN-3:win32 逐次 git.exe spawn 慢,平台化超时
  }, 20000);

  it('无提交仓库 → no-commits', async () => {
    const root = makeRepo();
    writeFileSync(join(root, 'a.py'), 'a\n');
    execFileSync('git', ['add', 'a.py'], { cwd: root });
    const r = await mapSelectionToHeadRange(join(root, 'a.py'), root, { startLine: 1, endLine: 1 }, realDeps);
    expect(r).toEqual({ kind: 'no-commits' });
  });
});
