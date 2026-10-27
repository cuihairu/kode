// IDE-SNP-008:共享文件事件按 URI 合并。同一保存经常触发多次 watcher 通知
// (多 watcher 匹配同一文件/编辑器写盘多段通知),不经合并时消费索引会把
// 同一版本更新应用多遍。每个消费索引自持一个合并器(实例互不串线):
// - 首报即达:事件同步投递(消费端测试与同步断言口径不变);
// - 窗口内纯重复(同 URI 同 kind)被吞掉,窗口从最后一次上报起算(防抖);
// - kind 变化(change→delete 等)是不同版本语义,立即投递,不延迟;
// - 归一键 = normalizeFileIdentity(斜杠/点段归一;Linux 不折叠大小写——
//   不同大小写在真实文件系统是不同文件)。
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
  deliveredKind: SharedFileEventKind;
  timer: NodeJS.Timeout;
}

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

  return {
    emit(fsPath: string, kind: SharedFileEventKind): void {
      if (disposed) {
        return;
      }
      const identity = normalizeFileIdentity(fsPath);
      const existing = mergeByUri.get(identity);
      if (existing) {
        clearTimeout(existing.timer);
        existing.timer = setTimeout(() => { mergeByUri.delete(identity); }, windowMs);
        if (existing.deliveredKind === kind) {
          return; // 窗口内同 kind 纯重复:吞掉,只续窗
        }
        existing.deliveredKind = kind;
        deliver(fsPath, identity, kind);
        return;
      }
      mergeByUri.set(identity, {
        deliveredKind: kind,
        timer: setTimeout(() => { mergeByUri.delete(identity); }, windowMs)
      });
      deliver(fsPath, identity, kind);
    },
    subscribe(handler: SharedFileEventHandler): () => void {
      subscribers.add(handler);
      return () => { subscribers.delete(handler); };
    },
    flushForTests(): void {
      for (const [identity, state] of [...mergeByUri.entries()]) {
        clearTimeout(state.timer);
        mergeByUri.delete(identity);
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
