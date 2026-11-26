// IDE-SNP-009: unified root-removal notification. When a workspace root is removed, one
// notification source broadcasts the same root-removal event to every consumer index;
// each consumer index subscribes and then strips that root record by target instead of
// invalidating its whole index and waiting out its own TTL/rescan self-heal. Unlike the
// shared file event merger of IDE-SNP-008: a root removal is a coarse-grained terminal
// event, one emit broadcasts synchronously once, with no windowing/dedup (a repeated
// emit is treated as an independent notification, and consumer-side stripping is
// idempotent).
export interface RootRemovalEvent {
  /** The removed root path verbatim (consumers apply it under their own key rules) */
  readonly rootPath: string;
}

export type RootRemovalHandler = (event: RootRemovalEvent) => void;

export interface RootRemovalNotifier {
  /** Broadcast one root removal (delivered synchronously to all current subscribers) */
  emit(rootPath: string): void;
  /** Subscribe to root removal events; returns an unsubscribe function */
  subscribe(handler: RootRemovalHandler): () => void;
  /** Terminate: clear subscribers, later emits are not delivered */
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
