import { execSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { readBuildCommit } from '../src/buildCommit';

// IDE-MET-002:扩展产物写入构建提交——运行中的诊断报告能追溯准确源码 SHA,
// 不只显示 package version。三面:①构建脚本 scripts/write-build-commit.mjs
// 把 git rev-parse HEAD 写进 out/buildCommit.json(vsce 打包 out/ 全量,vsix
// 自包含);②运行时 readBuildCommit 从 extensionPath 读 json,任何缺失/损坏
// 都落 'unknown' 不猜;③报告呈现面由 extensionIdentity.test.ts 锁
// (build commit 行)。

const scratchDirs: string[] = [];

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('buildCommit.readBuildCommit', () => {
  it('读出构建时写入的源码 SHA', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kode-buildcommit-'));
    scratchDirs.push(dir);
    writeFileSync(join(dir, 'buildCommit.json'), JSON.stringify({ commit: 'a'.repeat(40) }));
    expect(readBuildCommit(dir)).toBe('a'.repeat(40));
  });

  it('产物缺失/损坏/字段异常都落 unknown,不猜不抛', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kode-buildcommit-'));
    scratchDirs.push(dir);
    // 开发树/异常包:json 不存在
    expect(readBuildCommit(dir)).toBe('unknown');
    // 损坏 json
    writeFileSync(join(dir, 'buildCommit.json'), '{not json');
    expect(readBuildCommit(dir)).toBe('unknown');
    // 字段缺失与非字符串
    writeFileSync(join(dir, 'buildCommit.json'), JSON.stringify({}));
    expect(readBuildCommit(dir)).toBe('unknown');
    writeFileSync(join(dir, 'buildCommit.json'), JSON.stringify({ commit: 123 }));
    expect(readBuildCommit(dir)).toBe('unknown');
  });
});

describe('buildCommit 构建脚本', () => {
  it('write-build-commit.mjs 写出的 commit 等于 git rev-parse HEAD(仓库内运行)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kode-buildcommit-out-'));
    scratchDirs.push(dir);
    const outPath = join(dir, 'buildCommit.json');
    execSync(`node scripts/write-build-commit.mjs --out ${JSON.stringify(outPath)}`, { cwd: process.cwd() });
    const head = execSync('git rev-parse HEAD', { cwd: process.cwd() }).toString().trim();
    expect(readBuildCommit(dir)).toBe(head);
  });
});
