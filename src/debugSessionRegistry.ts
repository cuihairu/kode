/**
 * 调试会话关联到运行目标(IDE-DBG-005):launch.json 生成条目的名字本身
 * 携带目标身份(表条目=组件默认实例,`component#targetId` 条目=命名实例,
 * DBG-001)——据此把 VS Code 调试会话挂回对应 serverKey。进程状态来自
 * serverManager 在册面,合板后同一组件的默认实例与命名实例(两个
 * cellapp)的调试会话与进程状态各自可辨。事件面注入(vscode.debug 的
 * onStart/onTerminate),测试可回放。
 * R2-F15:进程模式条目(名无 debugpy 口,实际生成
 * `KBEngine: Python attach to cellapp`)也解析挂链——旧正则只认带口形态,
 * 进程模式会话 links=0;进程模式无固定口,尝试身份取用户选中的进程
 * (configuration.processId)。
 */

import { DEFAULT_TARGET_ID } from './serverManager';

/** 会话的最小识别面(id+名字;configuration 兜底读取) */
export interface DebugSessionLike {
  id: string;
  name: string;
  configuration?: {
    connect?: { port?: number };
    /** 进程模式 attach 的进程选择结果(pickProcess 解析后的 PID) */
    processId?: number | string;
  };
}

/** 事件订阅面(生产传 vscode.debug 的 onDidStart/terminateDebugSession) */
export interface DebugSessionEvents {
  onStart(listener: (session: DebugSessionLike) => void): { dispose(): void };
  onTerminate(listener: (session: DebugSessionLike) => void): { dispose(): void };
}

/** 会话→目标的挂链 */
export interface DebugSessionLink {
  session: DebugSessionLike;
  component: string;
  targetId: string;
  /** connect 形态的 debugpy 口;进程模式无固定口=undefined */
  port?: number;
  /** 进程模式尝试身份(用户选中进程的 PID;同名并发会话以此可辨) */
  processId?: number;
  serverKey: string;
}

const TABLE_ENTRY_PATTERN = /^KBEngine: Python attach to (.+?) \(debugpy (\d+)\)$/;
const INSTANCE_ENTRY_PATTERN = /^KBEngine: Python attach to (.+?)#(.+?) \(debugpy (\d+)\)$/;
// 进程模式:名无 debugpy 口(debugConfig 表条目 `KBEngine: Python attach to
// <component>`);`#` 可带命名实例。须在带口形态之后匹配,避免抢吃
// `(debugpy N)` 后缀;remote 形态是 `attach `(无 to),本 pattern 不匹配。
const PROCESS_ENTRY_PATTERN = /^KBEngine: Python attach to (.+?)(?:#(.+?))?$/;

/**
 * 条目名解析:带口形态=connect(表条目=默认实例,`#`=命名实例);
 * 无口形态=进程模式(同样表/`#` 实例);其余(remote/用户条目)null。
 * 进程模式无固定口,port=undefined。
 */
export function parseDebugSessionName(
  name: string
): { component: string; targetId: string; port: number | undefined } | null {
  const instance = INSTANCE_ENTRY_PATTERN.exec(name);
  if (instance) {
    return { component: instance[1], targetId: instance[2], port: Number(instance[3]) };
  }
  const table = TABLE_ENTRY_PATTERN.exec(name);
  if (table) {
    return { component: table[1], targetId: DEFAULT_TARGET_ID, port: Number(table[2]) };
  }
  const process = PROCESS_ENTRY_PATTERN.exec(name);
  if (process) {
    return {
      component: process[1],
      targetId: process[2] ?? DEFAULT_TARGET_ID,
      port: undefined
    };
  }
  return null;
}

/** 进程模式尝试身份:configuration.processId 解析为数字(字符串数字也收) */
function attemptProcessId(session: DebugSessionLike): number | undefined {
  const raw = session.configuration?.processId;
  if (typeof raw === 'number') {
    return raw;
  }
  if (typeof raw === 'string' && raw !== '' && !Number.isNaN(Number(raw))) {
    return Number(raw);
  }
  return undefined;
}

/** serverKey 组装(serverManager 同构:组件名[#targetId]) */
function serverKeyOf(component: string, targetId: string): string {
  return targetId === DEFAULT_TARGET_ID ? component : `${component}#${targetId}`;
}

/**
 * 会话注册表:登记/摘除按 session.id;只收名字可解析的会话(我们生成的
 * attach 条目),remote 与用户自建会话不挂。
 */
export class DebugSessionRegistry {
  private readonly links = new Map<string, DebugSessionLink>();
  private readonly subscriptions: Array<{ dispose(): void }>;

  private readonly linkTerminatedListeners = new Set<(link: DebugSessionLink) => void>();

  constructor(events: DebugSessionEvents) {
    this.subscriptions = [
      events.onStart(session => this.register(session)),
      events.onTerminate(session => this.unregister(session))
    ];
  }

  private register(session: DebugSessionLike): void {
    const parsed = parseDebugSessionName(session.name);
    if (!parsed) {
      return;
    }
    this.links.set(session.id, {
      session,
      component: parsed.component,
      targetId: parsed.targetId,
      port: parsed.port,
      // 进程模式(无固定口)才取 processId 当尝试身份;connect 形态身份=口
      processId: parsed.port === undefined ? attemptProcessId(session) : undefined,
      serverKey: serverKeyOf(parsed.component, parsed.targetId)
    });
  }

  /** 某运行目标的在挂会话(同目标多会话都返回) */
  linksFor(serverKey: string): DebugSessionLink[] {
    return [...this.links.values()].filter(link => link.serverKey === serverKey);
  }

  /** 全部在挂链(面板/合板消费) */
  all(): DebugSessionLink[] {
    return [...this.links.values()];
  }

  /**
   * 订阅「链随会话结束摘除」事件(DBG-006):只对挂过链的会话触发
   * (无关会话终止不产生事件);先回调再删链。可释放。
   */
  onLinkTerminated(listener: (link: DebugSessionLink) => void): { dispose(): void } {
    this.linkTerminatedListeners.add(listener);
    return {
      dispose: () => {
        this.linkTerminatedListeners.delete(listener);
      }
    };
  }

  private unregister(session: DebugSessionLike): void {
    const link = this.links.get(session.id);
    if (!link) {
      return;
    }
    this.links.delete(session.id);
    for (const listener of [...this.linkTerminatedListeners]) {
      listener(link);
    }
  }

  dispose(): void {
    this.links.clear();
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
  }
}

/** 在册运行目标的最小面(合板只读这几个字段) */
export interface RunningTargetLike {
  component: string;
  targetId: string;
  status: string;
}

/**
 * 会话×进程状态合板:逐运行目标一行(serverKey 唯一,两个 cellapp 各占
 * 一行),带自己的进程状态与在挂调试会话数——「区分两个 cellapp 的调试
 * 会话与进程状态」的判定面。
 */
export function buildDebugTargetBoard(
  running: Map<string, RunningTargetLike>,
  registry: Pick<DebugSessionRegistry, 'linksFor'>
): Array<{
  serverKey: string;
  component: string;
  targetId: string;
  processStatus: string;
  attachedSessions: number;
}> {
  return [...running.entries()].map(([serverKey, target]) => ({
    serverKey,
    component: target.component,
    targetId: target.targetId,
    processStatus: target.status,
    attachedSessions: registry.linksFor(serverKey).length
  }));
}

/** 会话结束行为(DBG-006):detach=会话结束进程照跑;stop-process=停该目标进程 */
export type DebugSessionEndBehavior = 'detach' | 'stop-process';

/** 默认行为:detach(会话结束进程照跑,其他实例一律不动) */
export const SESSION_END_BEHAVIOR_DEFAULT: DebugSessionEndBehavior = 'detach';

/**
 * 断开只影响指定目标(DBG-006):按配置决定会话结束时是否停进程。
 * detach(默认)零停止——其他实例与未关联进程一律不动;stop-process 只对
 * 该会话自己的目标发起 stopTarget(component, targetId),同一组件的
 * 其他实例不受牵连。纯函数:进程控制面由调用方注入。
 */
export function applySessionEndBehavior(
  behavior: DebugSessionEndBehavior,
  link: DebugSessionLink,
  stopTarget: (component: string, targetId: string) => void
): void {
  if (behavior === 'stop-process') {
    stopTarget(link.component, link.targetId);
  }
}
