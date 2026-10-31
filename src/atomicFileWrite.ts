/**
 * IDE-GEN-005:生成器写盘的原子替换。先写同目录临时文件,再 rename 落位
 * (同目录保证同一文件系统,rename 原子)。写入或改名中断时旧文件字节
 * 原封——要么完整新内容,要么完整旧内容,不留半截文本;新文件场景要么
 * 完整出现,要么不出现。失败路径清理临时文件,清理失败不掩盖原始错误。
 *
 * AUD-032(R2-F08):noClobber 走 fs.link(硬链接)而非 rename——目标已存在时
 * link 原子报 EEXIST,绝不覆盖并发出现的文件(rename 会静默替换)。link
 * 成功后目标与临时文件同 inode,unlink 临时文件留下完整目标,仍是原子落位。
 */

import * as fs from 'fs';

let tempCounter = 0;

/** 原子写选项:noClobber=true 拒绝覆盖已存在目标(EEXIST 安全创建) */
export interface WriteFileAtomicOptions {
  noClobber?: boolean;
}

/** 原子替换写入:临时文件+rename(noClobber 时 link+unlink);任何失败都保证目标路径不被部分写入 */
export function writeFileAtomic(filePath: string, content: string, options: WriteFileAtomicOptions = {}): void {
  tempCounter += 1;
  const tempPath = `${filePath}.kode-tmp-${process.pid}-${tempCounter}`;
  try {
    fs.writeFileSync(tempPath, content, 'utf8');
    if (options.noClobber) {
      fs.linkSync(tempPath, filePath);
      fs.unlinkSync(tempPath);
    } else {
      fs.renameSync(tempPath, filePath);
    }
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
