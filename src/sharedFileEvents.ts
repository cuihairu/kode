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
//
// 文件变化元信息(方案 B):去重那次 stat 的产物顺手随事件交付
// (SharedFileEvent.version),下游懒解析器按 identity+version 记忆化——同一
// 版本只读一次,不为 version 另开 IO。首报/kind 变更是同步交付而 stat 是异步
// (KR-AUD-30),故首报的 version 落定后回填同一事件对象;窗口尾随补投在补投
// 时已 await 核对 stat,直接带补投时点已前进的版本。口径见
// docs/design/file-change-meta.md。
import * as fs from 'fs';
import { normalizeFileIdentity } from './pathIdentity';

export type SharedFileEventKind = 'create' | 'change' | 'delete';

export interface SharedFileEvent {
  /** 首报的原样路径(消费端按自身键规则使用) */
  readonly fsPath: string;
  /** 归一身份键(合并口径) */
  readonly identity: string;
  readonly kind: SharedFileEventKind;
  /**
   * 交付时点的盘上版本 token(`${mtimeMs}:${size}`),复用合并去重那次 stat,
   * 零新增 IO。三条交付口径:
   * - 首报 / 窗口内 kind 变化:同步交付,异步 stat 此刻未落定 → 先 undefined,
   *   落定后回填**同一事件对象**(合并器是唯一写方,消费端只读;不重投);
   * - 窗口尾随补投:补投前已 await 核对 stat,直接带补投时点已前进的版本
   *   (带旧版本会让下游按同版本命中缓存,第二次写入的元信息就丢了)。
   * 拿不到 version 的消费端走 fileChangeMeta 懒解析自行 stat,不猜。
   */
  readonly version?: string;
}

export type SharedFileEventHandler = (event: SharedFileEvent) => void;

const DEFAULT_MERGE_WINDOW_MS = 30;

interface UriMergeState {
  /** 交付时上报的原样路径(尾随补投沿用) */
  fsPath: string;
  deliveredKind: SharedFileEventKind;
  /** 交付时的盘上版本(mtimeMs:size);stat 不可得为 undefined。
   *  KR-AUD-30:改异步 fs.stat,promise 在窗口到期核对时 await。 */
  deliveredVersion: Promise<string | undefined>;
  timer: NodeJS.Timeout;
}

/** 盘上版本 token(异步):两次 stat 相同 = 同一版本(纯重复);不同 = 有真实写入。
 *  KR-AUD-30:事件热路径不再 statSync(同步 IO 阻塞主线程),改 promises.stat。 */
const statVersionToken = async (fsPath: string): Promise<string | undefined> => {
  try {
    const stats = await fs.promises.stat(fsPath);
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

  /**
   * 交付一条合并后事件。`versionSource`:
   * - 字符串 = 交付时点已解析的版本(窗口尾随补投);
   * - Promise = 在途的去重 stat(首报/kind 变化):同步先交付(首报即达口径
   *   不变),落定后回填同一事件对象的 version,不重投;
   * - undefined = 无版本可得(如 delete 后 stat 失败)。
   */
  const deliver = (
    fsPath: string,
    identity: string,
    kind: SharedFileEventKind,
    versionSource: string | Promise<string | undefined> | undefined
  ): void => {
    let settled: string | undefined = typeof versionSource === 'string' ? versionSource : undefined;
    const event: SharedFileEvent = {
      fsPath,
      identity,
      kind,
      get version(): string | undefined {
        return settled;
      }
    };
    if (typeof versionSource !== 'string' && versionSource !== undefined) {
      void versionSource.then(
        value => { settled = value; },
        () => undefined // statVersionToken 自吞错误;双保险不让回填产生未处理拒绝
      );
    }
    for (const handler of [...subscribers]) {
      handler(event);
    }
  };

  /** 窗口到期:核对盘上版本(KR-AUD-30:异步 stat),已前进则补投同 kind 尾随事件 */
  const endWindow = (identity: string): void => {
    const state = mergeByUri.get(identity);
    if (!state) {
      return;
    }
    mergeByUri.delete(identity);
    if (state.deliveredKind === 'delete') {
      return; // 终态:无尾随核对
    }
    void Promise.all([state.deliveredVersion, statVersionToken(state.fsPath)]).then(
      ([delivered, current]) => {
        if (delivered !== undefined && current !== undefined && current !== delivered) {
          // 补投带的是**已前进的 current**(不是首报那份 deliveredVersion):
          // 下游按 version 记忆化,带旧版本会命中旧缓存吞掉第二次写入的元信息
          deliver(state.fsPath, identity, state.deliveredKind, current);
        }
      }
    );
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
        existing.deliveredVersion = statVersionToken(fsPath);
        deliver(fsPath, identity, kind, existing.deliveredVersion);
        return;
      }
      const state: UriMergeState = {
        fsPath,
        deliveredKind: kind,
        deliveredVersion: statVersionToken(fsPath),
        timer: setTimeout(() => { endWindow(identity); }, windowMs)
      };
      mergeByUri.set(identity, state);
      deliver(fsPath, identity, kind, state.deliveredVersion);
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
