// IDE-SNP-008:共享文件事件按 URI 合并。同一保存经常触发多次 watcher 通知
// (多 watcher 匹配同一文件/编辑器写盘多段通知),不经合并时消费索引会把
// 同一版本更新应用多遍。每个消费索引自持一个合并器(实例互不串线):
// - 首报即达:事件同步投递(消费端测试与同步断言口径不变);
// - 窗口内纯重复(同 URI 同 kind)被吞掉,窗口从最后一次上报起算(防抖);
// - kind 变化(change→delete 等)是不同版本语义,立即投递,不延迟;
// - 归一键 = normalizeFileIdentity(斜杠/点段归一;Linux 不折叠大小写——
//   不同大小写在真实文件系统是不同文件)。
//
// 2026-10-28 审核整改(第二次真实写入不再丢失):窗口内同 kind 吞并不能
// 区分「同一版本的重复通知」与「两次真实写入」。交付时记下盘上版本
// (mtimeMs:size),窗口到期核对:版本已前进则补投一条同 kind 尾随事件
// ——第二次更新最多延迟一个窗口到达,绝不永久丢失。delete 是终态(缺file
// 即目标态)不补投;盘上版本不可得(路径不存在/stat 失败)无法核对,不补投。
import * as fs from 'fs';
import { normalizeFileIdentity } from './pathIdentity';

export type SharedFileEventKind = 'create' | 'change' | 'delete';

export interface SharedFileEvent {
  /** 首报的原样路径(消费端按自身键规则使用) */
  readonly fsPath: string;
  /** 归一身份键(合并口径) */
  readonly identity: string;
  readonly kind: SharedFileEventKind;
}

export type SharedFileEventHandler = (event: SharedFileEvent) => void;

const DEFAULT_MERGE_WINDOW_MS = 30;

interface UriMergeState {
  /** 交付时上报的原样路径(尾随补投沿用) */
  fsPath: string;
  deliveredKind: SharedFileEventKind;
  /** 交付时的盘上版本(mtimeMs:size);stat 不可得为 undefined */
  deliveredVersion: string | undefined;
  timer: NodeJS.Timeout;
}

/** 盘上版本 token:两次 stat 相同 = 同一版本(纯重复);不同 = 有真实写入 */
const fileVersionToken = (fsPath: string): string | undefined => {
  try {
    const stats = fs.statSync(fsPath);
    return `${stats.mtimeMs}:${stats.size}`;
  } catch {
    return undefined;
  }
};

export interface SharedFileEventMerger {
  /** 上报一条原始文件事件(经合并后投递给本合并器的全部订阅者) */
  emit(fsPath: string, kind: SharedFileEventKind): void;
  /** 订阅合并后的事件;返回退订函数 */
  subscribe(handler: SharedFileEventHandler): () => void;
  /** 结束全部抑制窗口(测试面,同步) */
  flushForTests(): void;
  /** 终结:清订阅与在窗状态 */
  dispose(): void;
}

/** 合并窗口可注入(默认 30ms;测试用) */
export function createSharedFileEventMerger(windowMs: number = DEFAULT_MERGE_WINDOW_MS): SharedFileEventMerger {
  const subscribers = new Set<SharedFileEventHandler>();
  const mergeByUri = new Map<string, UriMergeState>();
  let disposed = false;

  const deliver = (fsPath: string, identity: string, kind: SharedFileEventKind): void => {
    const event: SharedFileEvent = { fsPath, identity, kind };
    for (const handler of [...subscribers]) {
      handler(event);
    }
  };

  /** 窗口到期:核对盘上版本,已前进则补投同 kind 尾随事件 */
  const endWindow = (identity: string): void => {
    const state = mergeByUri.get(identity);
    if (!state) {
      return;
    }
    mergeByUri.delete(identity);
    if (state.deliveredKind === 'delete' || state.deliveredVersion === undefined) {
      return; // 终态或版本不可知:无尾随核对
    }
    const current = fileVersionToken(state.fsPath);
    if (current !== undefined && current !== state.deliveredVersion) {
      deliver(state.fsPath, identity, state.deliveredKind);
    }
  };

  const armWindow = (state: UriMergeState, identity: string): void => {
    state.timer = setTimeout(() => { endWindow(identity); }, windowMs);
  };

  return {
    emit(fsPath: string, kind: SharedFileEventKind): void {
      if (disposed) {
        return;
      }
      const identity = normalizeFileIdentity(fsPath);
      const existing = mergeByUri.get(identity);
      if (existing) {
        clearTimeout(existing.timer);
        armWindow(existing, identity);
        if (existing.deliveredKind === kind) {
          return; // 窗口内同 kind 上报:立即仍吞,窗口到期按盘上版本决定是否补投
        }
        existing.fsPath = fsPath;
        existing.deliveredKind = kind;
        existing.deliveredVersion = fileVersionToken(fsPath);
        deliver(fsPath, identity, kind);
        return;
      }
      const state: UriMergeState = {
        fsPath,
        deliveredKind: kind,
        deliveredVersion: fileVersionToken(fsPath),
        timer: setTimeout(() => { endWindow(identity); }, windowMs)
      };
      mergeByUri.set(identity, state);
      deliver(fsPath, identity, kind);
    },
    subscribe(handler: SharedFileEventHandler): () => void {
      subscribers.add(handler);
      return () => { subscribers.delete(handler); };
    },
    flushForTests(): void {
      for (const identity of [...mergeByUri.keys()]) {
        const state = mergeByUri.get(identity);
        if (state) {
          clearTimeout(state.timer);
        }
        endWindow(identity);
      }
    },
    dispose(): void {
      disposed = true;
      subscribers.clear();
      for (const state of mergeByUri.values()) {
        clearTimeout(state.timer);
      }
      mergeByUri.clear();
    }
  };
}
