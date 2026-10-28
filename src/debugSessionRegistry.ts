/**
 * 调试会话关联到运行目标(IDE-DBG-005):launch.json 生成条目的名字本身
 * 携带目标身份(表条目=组件默认实例,`component#targetId` 条目=命名实例,
 * DBG-001)——据此把 VS Code 调试会话挂回对应 serverKey。进程状态来自
 * serverManager 在册面,合板后同一组件的默认实例与命名实例(两个
 * cellapp)的调试会话与进程状态各自可辨。事件面注入(vscode.debug 的
 * onStart/onTerminate),测试可回放。
 */

import { DEFAULT_TARGET_ID } from './serverManager';

/** 会话的最小识别面(id+名字;configuration 兜底读取) */
export interface DebugSessionLike {
  id: string;
  name: string;
  configuration?: { connect?: { port?: number } };
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
  port: number;
  serverKey: string;
}

const TABLE_ENTRY_PATTERN = /^KBEngine: Python attach to (.+?) \(debugpy (\d+)\)$/;
const INSTANCE_ENTRY_PATTERN = /^KBEngine: Python attach to (.+?)#(.+?) \(debugpy (\d+)\)$/;

/** 条目名解析:表条目=默认实例;`#` 条目=命名实例;其余(remote/用户条目)null */
export function parseDebugSessionName(
  name: string
): { component: string; targetId: string; port: number } | null {
  const instance = INSTANCE_ENTRY_PATTERN.exec(name);
  if (instance) {
    return { component: instance[1], targetId: instance[2], port: Number(instance[3]) };
  }
  const table = TABLE_ENTRY_PATTERN.exec(name);
  if (table) {
    return { component: table[1], targetId: DEFAULT_TARGET_ID, port: Number(table[2]) };
  }
  return null;
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

  constructor(events: DebugSessionEvents) {
    this.subscriptions = [
      events.onStart(session => this.register(session)),
      events.onTerminate(session => this.links.delete(session.id))
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
