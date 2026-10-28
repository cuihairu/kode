// IDE-MET-002:构建期把源码提交写进产物。npm compile 前置步骤:
//   node scripts/write-build-commit.mjs [--out out/buildCommit.json]
// git rev-parse HEAD 失败(无 git 的打包环境)写 unknown,不阻断构建。
import { execSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outPath = resolve(
  outIndex >= 0 && args[outIndex + 1] ? args[outIndex + 1] : 'out/buildCommit.json'
);

let commit = 'unknown';
try {
  commit = execSync('git rev-parse HEAD', { cwd: process.cwd() })
    .toString()
    .trim();
} catch {
  // 无 git 环境:如实写 unknown(运行时报告呈现 unknown,不猜)
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify({ commit }, null, 2)}\n`);
process.stdout.write(`build commit ${commit} -> ${outPath}\n`);
