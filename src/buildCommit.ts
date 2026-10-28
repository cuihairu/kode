// IDE-MET-002:扩展产物的构建提交标识。构建脚本 scripts/write-build-commit.mjs
// 在 compile 前把 git rev-parse HEAD 写进 out/buildCommit.json(vsce 打包
// out/ 全量,vsix 自包含);运行时从这里读取,任何缺失/损坏都落 'unknown'
// 不猜——报告读者能把 package version 与源码 SHA 分开对账。
import * as fs from 'fs';
import { join } from 'path';

interface BuildCommitFile {
  commit?: unknown;
}

/** 读 extensionPath/buildCommit.json 的构建提交;读不到/损坏/字段异常=unknown */
export function readBuildCommit(extensionPath: string): string {
  try {
    const raw = fs.readFileSync(join(extensionPath, 'buildCommit.json'), 'utf8');
    const parsed = JSON.parse(raw) as BuildCommitFile;
    return typeof parsed.commit === 'string' && parsed.commit ? parsed.commit : 'unknown';
  } catch {
    return 'unknown';
  }
}
