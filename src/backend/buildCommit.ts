// IDE-MET-002/REL-004:扩展产物的构建提交标识。构建脚本
// scripts/write-build-commit.mjs 在 compile 前把 git rev-parse HEAD 写进
// out/buildCommit.json;VSIX 打包面保留该文件(.vscodeignore
// !out/buildCommit.json),安装后位于 <ext>/out/buildCommit.json,运行时
// 从 extensionPath/out 读取——安装产物报告的提交与构建输入一致。任何
// 缺失/损坏都落 'unknown' 不猜,绝不回落源码目录的 git 状态(源码目录
// 版本不冒充已安装版本)——报告读者能把 package version 与源码 SHA
// 分开对账。
import * as fs from 'fs';
import { join } from 'path';

interface BuildCommitFile {
  commit?: unknown;
}

/** 读 extensionPath/out/buildCommit.json 的构建提交;读不到/损坏/字段异常=unknown */
export function readBuildCommit(extensionPath: string): string {
  try {
    const raw = fs.readFileSync(join(extensionPath, 'out', 'buildCommit.json'), 'utf8');
    const parsed = JSON.parse(raw) as BuildCommitFile;
    return typeof parsed.commit === 'string' && parsed.commit ? parsed.commit : 'unknown';
  } catch {
    return 'unknown';
  }
}
