/**
 * IDE-GEN-005:生成器写盘的原子替换。先写同目录临时文件,再 rename 落位
 * (同目录保证同一文件系统,rename 原子)。写入或改名中断时旧文件字节
 * 原封——要么完整新内容,要么完整旧内容,不留半截文本;新文件场景要么
 * 完整出现,要么不出现。失败路径清理临时文件,清理失败不掩盖原始错误。
 */

import * as fs from 'fs';

let tempCounter = 0;

/** 原子替换写入:临时文件+rename;任何失败都保证目标路径不被部分写入 */
export function writeFileAtomic(filePath: string, content: string): void {
  tempCounter += 1;
  const tempPath = `${filePath}.kode-tmp-${process.pid}-${tempCounter}`;
  try {
    fs.writeFileSync(tempPath, content, 'utf8');
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch {
      // 清理失败不掩盖原始错误
    }
    throw error;
  }
}
