import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

// 全仓拼写门(用户令 2026-11-06):旧示例的参数名是拼写错误(rel+aod),端点
// 改为 127.0.0.1:8090/hotfix + module_name 后该串一处都不该再留——文档/测试/
// 源码(含 .rs/锁文件等非 TS 面)任何一处回潮都算红。
// 清单取 git 的「已跟踪 + 未跟踪未忽略」(嵌套 worktree 目录不是文件,跳过),
// 内容按二进制(含 NUL 字节)判定跳过,不按扩展名挑——扩展名白名单会漏面。

const root = path.join(__dirname, '..');

/**
 * 待禁字面量按片段拼接:门测自身若写全字面量,全仓 grep 会先命中自己。
 * 同理,断言「该串不存在」的用例也必须拼接书写。
 */
const FORBIDDEN = ['rel', 'aod'].join('');

/** 仓库文件清单:git 已跟踪 + 未跟踪未忽略(尊重 .gitignore 的产物不算) */
const repositoryFiles = (): string[] =>
  execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8'
  })
    .split('\0')
    .filter(Boolean);

/**
 * 扫描给定目录下的给定相对路径:二进制内容(含 NUL 字节)跳过,其余按 utf8
 * 全文比对(大小写不敏感)。清单里的目录项(嵌套 worktree)与已删文件如实跳过。
 */
const findForbiddenSpelling = (dir: string, files: readonly string[]): string[] => {
  const offenders: string[] = [];
  for (const relative of files) {
    const file = path.join(dir, relative);
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(file);
    } catch {
      continue;
    }
    if (bytes.includes(0)) {
      continue;
    }
    if (bytes.toString('utf8').toLowerCase().includes(FORBIDDEN)) {
      offenders.push(relative);
    }
  }
  return offenders;
};

describe('旧示例错误拼写全仓门', () => {
  it('仓库全部文本文件(已跟踪 + 未跟踪未忽略)零命中', () => {
    const offenders = findForbiddenSpelling(root, repositoryFiles());
    expect(offenders, `旧拼写回潮文件: ${offenders.join(', ')}`).toEqual([]);
  });

  it('扫描面名副其实:非 TS 面(.rs/锁文件/无扩展名)同样被扫(仓外夹具自证)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-spelling-gate-'));
    try {
      // 真字面量只写进仓外临时夹具,仓库内仍是拼接书写
      fs.writeFileSync(path.join(dir, 'engine.rs'), `pub fn hotfix() -> &'static str { "${FORBIDDEN}" }\n`);
      fs.writeFileSync(path.join(dir, 'Cargo.lock'), '# nothing to see\n');
      fs.writeFileSync(path.join(dir, 'noext'), 'plain text\n');
      expect(findForbiddenSpelling(dir, ['engine.rs', 'Cargo.lock', 'noext'])).toEqual(['engine.rs']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
