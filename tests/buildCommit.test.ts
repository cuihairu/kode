import { execSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { readBuildCommit } from '../src/buildCommit';

// IDE-MET-002/REL-004:扩展产物写入构建提交——安装产物报告的提交与构建
// 输入一致。三面:①构建脚本 scripts/write-build-commit.mjs 把 git
// rev-parse HEAD 写进 out/buildCommit.json;②VSIX 的打包面保留该文件
// (.vscodeignore !out/buildCommit.json,安装后位于 <ext>/out/),运行时
// readBuildCommit 从 extensionPath/out 读 json,任何缺失/损坏都落
// 'unknown' 不猜——绝不回落源码目录的 git 状态,源码目录版本不冒充
// 已安装版本;③报告呈现面由 extensionIdentity.test.ts 锁(build commit 行)。

const scratchDirs: string[] = [];

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 造一个模拟已安装扩展目录:<dir>/out/buildCommit.json */
function makeInstalledLayout(dir: string): string {
  const outDir = join(dir, 'out');
  mkdirSync(outDir, { recursive: true });
  return join(outDir, 'buildCommit.json');
}

describe('buildCommit.readBuildCommit', () => {
  it('从 extensionPath/out 读出构建时写入的源码 SHA(=安装产物布局)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kode-buildcommit-'));
    scratchDirs.push(dir);
    writeFileSync(makeInstalledLayout(dir), JSON.stringify({ commit: 'a'.repeat(40) }));
    expect(readBuildCommit(dir)).toBe('a'.repeat(40));
  });

  it('产物缺失/损坏/字段异常都落 unknown,不猜不抛', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kode-buildcommit-'));
    scratchDirs.push(dir);
    // 开发树/异常包:json 不存在
    expect(readBuildCommit(dir)).toBe('unknown');
    // 损坏 json
    writeFileSync(makeInstalledLayout(dir), '{not json');
    expect(readBuildCommit(dir)).toBe('unknown');
    // 字段缺失与非字符串
    writeFileSync(makeInstalledLayout(dir), JSON.stringify({}));
    expect(readBuildCommit(dir)).toBe('unknown');
    writeFileSync(makeInstalledLayout(dir), JSON.stringify({ commit: 123 }));
    expect(readBuildCommit(dir)).toBe('unknown');
  });

  it('json 只在根级不在 out/ 下 → unknown(不回落其他位置)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kode-buildcommit-'));
    scratchDirs.push(dir);
    writeFileSync(join(dir, 'buildCommit.json'), JSON.stringify({ commit: 'b'.repeat(40) }));
    expect(readBuildCommit(dir)).toBe('unknown');
  });
});

describe('buildCommit 构建脚本', () => {
  it('write-build-commit.mjs 写出的 commit 等于 git rev-parse HEAD(仓库内运行)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kode-buildcommit-out-'));
    scratchDirs.push(dir);
    const outPath = makeInstalledLayout(dir);
    execSync(`node scripts/write-build-commit.mjs --out ${JSON.stringify(outPath)}`, { cwd: process.cwd() });
    const head = execSync('git rev-parse HEAD', { cwd: process.cwd() }).toString().trim();
    expect(readBuildCommit(dir)).toBe(head);
  });
});
