/**
 * 事件索引的纯数据类型(IDE-ARC-002 抽离):本模块不依赖 vscode。
 * 事件语法分析(eventApi)与索引实现(workspaceIndex)通过小接口
 * EventCallIndex 互用——provider 只消费本接口成员,
 * 不再 import 整个索引实现。
 *
 * RUST-004-W3:就绪/取消语义贯穿接口面——标注查询带预算竞速与取消
 * (未就绪时已蓄调用照流 partial-real,ready 只做标注),就绪通知让
 * 消费端在初扫完成后自动刷新(不能只加标注方法而不改调用者)。
 */
import type { ColdIndexToken } from '../coldIndexReadiness';

/** 单条事件调用(语法分析产物;偏移落在事件名末段上) */
export type EventCall = { api: 'addEvent' | 'registerEvent' | 'emitEvent' | 'removeEvent' | 'deregisterEvent'; event: string; eventOffset: number; callback?: string; callbackOffset?: number }

/** 索引侧的事件调用:带上文件与所在行,消费端不再读盘换算 */
export interface IndexedEventCall {
  readonly file: string;
  readonly call: EventCall;
  /** eventOffset 所在行(建索引时算好,消费端不再读盘换算) */
  readonly line: number;
}

/** 标注查询结果:calls 恒真实流出(未就绪时事件驱动面已蓄调用照流,
 * partial-real——强制空族丢真实内容),ready 只做标注(未建≠空结果)。 */
export interface EventCallsMarkedQuery {
  readonly calls: readonly IndexedEventCall[];
  readonly ready: boolean;
}

/** 就绪通知订阅句柄(dispose 解订阅) */
export interface EventIndexReadySubscription {
  dispose(): void;
}

/** 事件索引消费面(IDE-EVT-012 共享索引):实现由注入方给,provider 不自持实例 */
export interface EventCallIndex {
  /** 全量事件调用(离线程序化语义:硬 await 初扫完成) */
  allEventCalls(): Promise<readonly IndexedEventCall[]>;
  /**
   * 标注查询(RUST-004-W3):带 token 走冷索引预算竞速——取消 → null;
   * 预算耗尽 → 已蓄部分真实调用 + ready:false(初扫继续后台预热);
   * 就绪 → 全量 + ready:true。无 token 等全量(离线语义)。初扫失败
   * 原样抛出,不吞错装空。
   */
  allEventCallsMarked(token?: ColdIndexToken, budgetMs?: number): Promise<EventCallsMarkedQuery | null>;
  /** 就绪通知:初扫完成(未就绪→就绪)或索引弃置时回调;消费端据此重渲染(完成后能刷新)。 */
  onReady(listener: () => void): EventIndexReadySubscription;
}
