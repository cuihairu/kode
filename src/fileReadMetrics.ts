// IDE-MET-004:文件读取量与读取字节数记录。验收口径:一次普通 hover 可
// 核对实际读盘范围(哪些文件、多少字节),关闭详细记录时开销有界。
// 设计:累计计数(reads/bytes)永远只做两次加法,零分配;明细(路径+字节)
// 仅在 verbose 开关打开时进定长环形缓冲(容量 256,满则丢最旧),关闭即
// 清空不再保留——内存占用与读取次数无关,这就是「有界」的兑现面。
// 语言链的读盘入口(entityMapping 属主解析/形参闸/方法定位、definitionWorkspace
// types.xml/alias.xml、python def 全树 walk)统一换 readFileUtf8Recorded*
// 记账;测试/审计面用 resetFileReadMetrics + getRecentFileReads 对账。

import * as fs from 'fs';

export interface FileReadRecord {
  path: string;
  bytes: number;
}

/** 明细环形缓冲容量:超过即丢最旧(有界内存,不随读取次数增长) */
export const FILE_READ_RING_LIMIT = 256;

let totalReads = 0;
let totalBytes = 0;
let verbose = false;
let ring: FileReadRecord[] = [];

/** verbose 开:记录逐次明细;关:清空明细,只留累计计数(默认关) */
export function setFileReadVerbose(enabled: boolean): void {
  verbose = enabled;
  if (!enabled) {
    ring = [];
  }
}

export function isFileReadVerbose(): boolean {
  return verbose;
}

/** 记一次成功读取;读失败不记账(未完成的读取不进审计面) */
export function recordFileRead(path: string, bytes: number): void {
  totalReads += 1;
  totalBytes += bytes;
  if (verbose) {
    ring.push({ path, bytes });
    if (ring.length > FILE_READ_RING_LIMIT) {
      ring.splice(0, ring.length - FILE_READ_RING_LIMIT);
    }
  }
}

/** 累计计数(与 verbose 无关,始终可对账) */
export function getFileReadTotals(): { reads: number; bytes: number } {
  return { reads: totalReads, bytes: totalBytes };
}

/** 最近读取明细;verbose 关闭时恒为空 */
export function getRecentFileReads(): readonly FileReadRecord[] {
  return ring;
}

/** 清零(测试与单次操作审计用:reset → 操作 → 对账) */
export function resetFileReadMetrics(): void {
  totalReads = 0;
  totalBytes = 0;
  ring = [];
}

/** 同步读盘入口:读成功才记账,异常原样抛出 */
export function readFileSyncUtf8Recorded(path: string): string {
  const content = fs.readFileSync(path, 'utf8');
  recordFileRead(path, Buffer.byteLength(content, 'utf8'));
  return content;
}

/** 异步读盘入口(全树 walk 等协路径):读成功才记账 */
export async function readFileUtf8Recorded(path: string): Promise<string> {
  const content = await fs.promises.readFile(path, 'utf8');
  recordFileRead(path, Buffer.byteLength(content, 'utf8'));
  return content;
}
