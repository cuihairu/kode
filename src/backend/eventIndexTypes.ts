/**
 * 事件索引的纯数据类型(IDE-ARC-002 抽离):本模块不依赖 vscode。
 * 事件语法分析(eventApi)与索引实现(workspaceIndex)通过小接口
 * EventCallIndex 互用——provider 只消费 allEventCalls 一个成员,
 * 不再 import 整个索引实现。
 */

/** 单条事件调用(语法分析产物;偏移落在事件名末段上) */
export type EventCall = { api: 'addEvent' | 'registerEvent' | 'emitEvent' | 'removeEvent' | 'deregisterEvent'; event: string; eventOffset: number; callback?: string; callbackOffset?: number }

/** 索引侧的事件调用:带上文件与所在行,消费端不再读盘换算 */
export interface IndexedEventCall {
  readonly file: string;
  readonly call: EventCall;
  /** eventOffset 所在行(建索引时算好,消费端不再读盘换算) */
  readonly line: number;
}

/** 事件索引消费面(IDE-EVT-012 共享索引):实现由注入方给,provider 不自持实例 */
export interface EventCallIndex {
  allEventCalls(): Promise<readonly IndexedEventCall[]>;
}
