import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

// IDE-REL-003 VSIX 包含 parser worker 产物:验收动作=真实打包后包内
// 可直接找到 out/pythonParserWorker.js 并从包内路径启动(2026-10-29 以
// /tmp/rel003 核验通过:unzip 见 worker 文件,node Worker 从解包目录启动,
// 协议回包 id/revision/parsed 俱全)。本文件是结构守卫,锁三处不被回退:
// 1) .vscodeignore 先排除 out/** 再显式保留 worker;
// 2) bundle 脚本持续产出 worker 的自包含 bundle;
// 3) worker 与其解析依赖不 import vscode(包内启动不依赖扩展宿主注入)。

const repoRoot = path.resolve(__dirname, '..');

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('VSIX worker 产物结构守卫(IDE-REL-003)', () => {
  it('.vscodeignore:先排除 out/** 再显式保留 pythonParserWorker.js', () => {
    const lines = readRepoFile('.vscodeignore').split('\n').map(line => line.trim());
    const excludeIndex = lines.indexOf('out/**');
    const keepWorkerIndex = lines.indexOf('!out/pythonParserWorker.js');
    expect(excludeIndex).toBeGreaterThanOrEqual(0);
    expect(keepWorkerIndex).toBeGreaterThan(excludeIndex);
    expect(lines).toContain('!out/extension.js');
  });

  it('.vscodeignore:同样保留构建身份 out/buildCommit.json(IDE-REL-004)', () => {
    const lines = readRepoFile('.vscodeignore').split('\n').map(line => line.trim());
    const excludeIndex = lines.indexOf('out/**');
    const keepCommitIndex = lines.indexOf('!out/buildCommit.json');
    expect(excludeIndex).toBeGreaterThanOrEqual(0);
    expect(keepCommitIndex).toBeGreaterThan(excludeIndex);
  });

  it('bundle 脚本:esbuild 以 src/pythonParserWorker.ts 为入口产出自包含 bundle', () => {
    const scripts = JSON.parse(readRepoFile('package.json')).scripts as Record<string, string>;
    const bundle = scripts.bundle;
    expect(bundle).toContain('src/pythonParserWorker.ts --bundle --outfile=out/pythonParserWorker.js');
  });

  it('worker 与解析依赖不 import vscode(包内路径可独立启动)', () => {
    for (const relativePath of ['src/pythonParserWorker.ts', 'src/backend/pythonParser.ts']) {
      const source = readRepoFile(relativePath);
      expect(source.includes('from \'vscode\'')).toBe(false);
    }
  });

  it('vsix-staging:stage 名单必须含顶层 typings/(KBEngine 桩包模板随包分发)', () => {
    // 结构守卫:运行时从 <extensionPath>/typings 读内置模板(src/pythonStubExport.ts
    // KBENGINE_STUB_TEMPLATE_RELATIVE_ROOT),stage 名单漏掉 typings 时打包安装的
    // 宿主只会收到「桩包内置模板读不到」告警(2026-11-11 004b 真机走查抓到)。
    const lines = readRepoFile(path.join('scripts', 'vsix-staging.mjs')).split('\n').map(line => line.trim());
    expect(lines.some(line => line.includes("'typings'"))).toBe(true);
  });
});
