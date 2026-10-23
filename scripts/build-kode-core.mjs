#!/usr/bin/env node
// kode2 PR-003:kode-server 二进制构建/打包入口(BUILD-003 配套)。
// 用法:
//   node scripts/build-kode-core.mjs            # debug 构建(开发/e2e)
//   node scripts/build-kode-core.mjs --release  # release 构建(打包用)
// 输出:二进制绝对路径(供扩展配置 kbengine.coreServerPath 指向)。
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(new URL('..', import.meta.url).pathname);
const release = process.argv.includes('--release');
const profile = release ? 'release' : 'debug';

const result = spawnSync('cargo', ['build', '-p', 'kode-server', ...(release ? ['--release'] : [])], {
  cwd: repoRoot,
  stdio: 'inherit',
});
if (result.error) {
  console.error(`cargo not available: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
const binary = join(repoRoot, 'target', profile, 'kode-server');
if (!existsSync(binary)) {
  console.error(`binary missing after build: ${binary}`);
  process.exit(1);
}
console.log(binary);
