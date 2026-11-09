import { describe, expect, it } from 'vitest';

import {
  defaultVersionQueryDeps,
  relativeVersionPath,
  summarizeVersionError
} from '../src/gitHistoryDiff';
import type { GitRunOutcome } from '../src/backend/gitRunner';

/**
 * IDE-GIT-006 补臂(版本 diff 查询面剩余分支):
 * 既有 gitHistoryDiff.test.ts 已覆盖相对路径/URI 三键/内容查询/父提交判定/
 * 虚拟文档提供者/diff 打开;本文件专门补基线缺口语句:
 *   - defaultVersionQueryDeps 默认 runGit 经协调门的委托面[43](用只读白名单
 *     外子命令触发 invalid-args,不真启 Git 子进程——确定性)
 *   - relativeVersionPath:filePath===repoRoot → ''[64];含字面反斜杠文件名
 *     拒绝[72](同时执行 segments.some[70] 与 join('/')[71])
 *   - summarizeVersionError:cancelled[162]/output-limit[163]/invalid-args[164]/
 *     未知兜底[165]
 *
 * 死臂(公开 API + 真实 fs 不可达,不强制测试):
 *   - relativeVersionPath 行 70 `if (segments.some(..==='..'||==='.')) return null`
 *     的返回臂:行 65 已保证 abs 以 root+sep 开头(P.resolve 归一后 rel 恒为
 *     干净后代路径,不产出 `..`/`.` 段),故该 if 恒假、返回臂不可达。
 */

describe('defaultVersionQueryDeps 默认 runGit 委托面', () => {
  it('默认 runGit 经协调门:白名单外子命令在启动前拒绝(invalid-args),不启子进程', async () => {
    const deps = defaultVersionQueryDeps();
    const outcome = await deps.runGit(
      ['commit', '-m', 'x'],
      { cwd: '/repo', timeoutMs: 1000, maxOutputBytes: 1024 }
    );
    expect(outcome.kind).toBe('invalid-args');
  });
});

describe('relativeVersionPath 补臂', () => {
  it('filePath===repoRoot → 空串(仓库根即文件)', () => {
    expect(relativeVersionPath('/repo', '/repo')).toBe('');
  });

  it('文件名含字面反斜杠(非分隔)→ 拒绝(维持逃逸口径)', () => {
    // 行 70 segments.some(..==='..'||==='.') 与行 71 join('/') 顺带执行;
    // 行 72 posixRel.includes('\\') 真 → null
    expect(relativeVersionPath('/repo', '/repo/a\\b.py')).toBeNull();
  });
});

describe('summarizeVersionError 补臂', () => {
  it('cancelled / output-limit / invalid-args / 未知兜底各自一行文案', () => {
    expect(summarizeVersionError({ kind: 'cancelled' })).toBe('读取已取消');
    expect(summarizeVersionError({ kind: 'output-limit', limitBytes: 4, receivedBytes: 8 })).toBe(
      '版本内容超限(有界执行已终止)'
    );
    expect(summarizeVersionError({ kind: 'invalid-args', reason: 'args 为空' })).toBe('参数被拒:args 为空');
    expect(summarizeVersionError({ kind: 'ok', stdout: 'x', stderr: '' })).toBe('未知错误');
  });

  it('exit 空 stderr 也落兜底(不匹配 exit 首行分支)', () => {
    const outcome: GitRunOutcome = { kind: 'exit', exitCode: 0, stderr: '' };
    expect(summarizeVersionError(outcome)).toBe('未知错误');
  });
});
