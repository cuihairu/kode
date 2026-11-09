// IDE-SNP-009:统一移除根通知。工作区根被移除时,一个通知源向全部消费索引
// 广播同一根移除事件;各消费索引订阅后定向摘除该根记录,不再整库失效等
// 各自 TTL/重扫自愈。与 IDE-SNP-008 的共享文件事件合并器不同:根移除是
// 粗粒度终态事件,一次 emit 同步广播一次,不做窗口/去重(重复 emit 视为
// 独立通知,消费面摘除幂等)。
export interface RootRemovalEvent {
  /** 移除根的原样路径(消费端按自身键规则应用) */
  readonly rootPath: string;
}

export type RootRemovalHandler = (event: RootRemovalEvent) => void;

export interface RootRemovalNotifier {
  /** 广播一次根移除(同步投递给当前全部订阅者) */
  emit(rootPath: string): void;
  /** 订阅根移除事件;返回退订函数 */
  subscribe(handler: RootRemovalHandler): () => void;
  /** 终结:清订阅,后续 emit 不投递 */
  dispose(): void;
}

export function createRootRemovalNotifier(): RootRemovalNotifier {
  const subscribers = new Set<RootRemovalHandler>();
  let disposed = false;

  return {
    emit(rootPath: string): void {
      if (disposed) {
        return;
      }
      const event: RootRemovalEvent = { rootPath };
      for (const handler of [...subscribers]) {
        handler(event);
      }
    },
    subscribe(handler: RootRemovalHandler): () => void {
      subscribers.add(handler);
      return () => { subscribers.delete(handler); };
    },
    dispose(): void {
      disposed = true;
      subscribers.clear();
    }
  };
}
