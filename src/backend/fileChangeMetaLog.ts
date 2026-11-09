/**
 * 文件变化元信息 · 索引侧消费端(python 索引事件腿)。
 *
 * 热更审计腿在 src/hotReload.ts(auditLine 后逐文件补元信息行);本模块是
 * python 索引事件腿:合并器交付的事件 → 懒解析元信息 → 落既有 jumpLog 通道
 * (前缀 [kode-jump],索引维护日志今天就走这里,如「py 解析失败」)。
 *
 * 口径:
 * - 沿用既有 kbengine.jumpLog 开关(默认关)——**关时零 IO**(连解析都不发起),
 *   不新增设置项、不进新的输出通道;
 * - 解析是懒异步的:不动老订阅者同步收单的口径,失败静默(不产生未处理拒绝);
 * - 行格式与热更审计共用 formatFileChangeMeta(一行看清 module/process/
 *   sha256/version)。
 * 本模块 import navigationLog(带 vscode),故与纯逻辑的 fileChangeMeta 分家。
 */

import { formatFileChangeMeta, type FileChangeMetaResolver } from './fileChangeMeta';
import { isJumpLogEnabled, jumpLog } from '../navigationLog';
import type { SharedFileEvent } from './sharedFileEvents';

/**
 * 记一条索引侧文件变更元信息行。jumpLog 关闭即返回(零 IO);解析失败静默
 * ——日志缺行好过把 watcher 回调链拖出未处理拒绝。
 */
export function logIndexFileChangeMeta(
  resolver: FileChangeMetaResolver,
  event: SharedFileEvent
): void {
  if (!isJumpLogEnabled()) {
    return;
  }
  void resolver.metaFor(event).then(
    meta => jumpLog('info', () => `py 变更 ${formatFileChangeMeta(meta)}`),
    () => undefined
  );
}
