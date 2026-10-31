import { describe, expect, it } from 'vitest';
import {
  DebugSessionRegistry,
  parseDebugSessionName,
  buildDebugTargetBoard,
  applySessionEndBehavior
} from '../src/debugSessionRegistry';
import { buildDebugStatusRows } from '../src/debugStatusBoard';
import { DEFAULT_TARGET_ID } from '../src/serverManager';

// IDE-DBG-005 调试会话关联到运行目标:按 launch.json 生成条目名
// (表条目=默认实例,`component#targetId` 条目=命名实例)把 VS Code 调试
// 会话挂到对应 serverKey;进程状态来自 serverManager 在册面——同一组件
// 的默认实例与命名实例(两个 cellapp)的会话与状态各自可辨。
// R2-F15:进程模式条目名(无 debugpy 口)也挂——实际生成名
// `KBEngine: Python attach to cellapp` 旧正则不认得,links=0。

interface FakeSession {
  id: string;
  name: string;
  configuration?: { connect?: { port?: number }; processId?: number | string };
}

type Listener = (session: FakeSession) => void;

const makeEvents = () => {
  const startListeners: Listener[] = [];
  const terminateListeners: Listener[] = [];
  return {
    events: {
      onStart: (listener: Listener) => {
        startListeners.push(listener);
        return { dispose: () => void 0 };
      },
      onTerminate: (listener: Listener) => {
        terminateListeners.push(listener);
        return { dispose: () => void 0 };
      }
    },
    start: (session: FakeSession) => {
      for (const listener of startListeners) {
        listener(session);
      }
    },
    terminate: (session: FakeSession) => {
      for (const listener of terminateListeners) {
        listener(session);
      }
    }
  };
};

describe('parseDebugSessionName(条目名解析)', () => {
  it('表条目名=默认实例;#条目名=命名实例;remote/用户条目不匹配', () => {
    expect(parseDebugSessionName('KBEngine: Python attach to cellapp (debugpy 5679)')).toEqual({
      component: 'cellapp',
      targetId: DEFAULT_TARGET_ID,
      port: 5679
    });
    expect(parseDebugSessionName('KBEngine: Python attach to cellapp#a (debugpy 5708)')).toEqual({
      component: 'cellapp',
      targetId: 'a',
      port: 5708
    });
    expect(parseDebugSessionName('KBEngine: Python attach 外网 (remote)')).toBeNull();
    expect(parseDebugSessionName('My python attach')).toBeNull();
  });

  it('R2-F15:进程模式条目名(无 debugpy 口)也解析;connect 形态优先不被吃', () => {
    expect(parseDebugSessionName('KBEngine: Python attach to cellapp')).toEqual({
      component: 'cellapp',
      targetId: DEFAULT_TARGET_ID,
      port: undefined
    });
    expect(parseDebugSessionName('KBEngine: Python attach to cellapp#a')).toEqual({
      component: 'cellapp',
      targetId: 'a',
      port: undefined
    });
    // 带口形态仍按原语义解析(进程模式 pattern 不抢)
    expect(parseDebugSessionName('KBEngine: Python attach to cellapp (debugpy 5679)')).toEqual({
      component: 'cellapp',
      targetId: DEFAULT_TARGET_ID,
      port: 5679
    });
    expect(parseDebugSessionName('KBEngine: Python attach 外网 (remote)')).toBeNull();
  });
});

describe('R2-F15 进程模式会话(实际 PID 挂链)', () => {
  it('进程模式会话挂链:结构化 component/targetId/processId 尝试身份,板显 attached', () => {
    const harness = makeEvents();
    const registry = new DebugSessionRegistry(harness.events);

    harness.start({
      id: 's1',
      name: 'KBEngine: Python attach to cellapp',
      configuration: { processId: 4242 }
    });

    const links = registry.linksFor('cellapp');
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      component: 'cellapp',
      targetId: DEFAULT_TARGET_ID,
      port: undefined,
      processId: 4242,
      serverKey: 'cellapp'
    });

    // 工作台状态:进程模式会话也把目标推为 attached(旧码 links=0,不挂)
    const running = new Map<string, { component: string; targetId: string; status: string }>([
      ['cellapp', { component: 'cellapp', targetId: DEFAULT_TARGET_ID, status: 'Running' }]
    ]);
    const rows = buildDebugStatusRows(running, new Map(), registry);
    expect(rows[0].phase).toBe('attached');
    expect(rows[0].attachedSessions).toBe(1);
  });

  it('同名并发两个 PID 会话不误认:各持各 processId,结束只摘自己', () => {
    const harness = makeEvents();
    const registry = new DebugSessionRegistry(harness.events);

    harness.start({
      id: 's1',
      name: 'KBEngine: Python attach to cellapp',
      configuration: { processId: 4242 }
    });
    harness.start({
      id: 's2',
      name: 'KBEngine: Python attach to cellapp',
      configuration: { processId: 5252 }
    });

    const links = registry.linksFor('cellapp');
    expect(links).toHaveLength(2);
    expect(links.map(link => link.processId).sort()).toEqual([4242, 5252]);

    harness.terminate({
      id: 's1',
      name: 'KBEngine: Python attach to cellapp',
      configuration: { processId: 4242 }
    });
    expect(registry.linksFor('cellapp').map(link => link.processId)).toEqual([5252]);
  });

  it('进程模式链断开/停止只作用该目标(默认实例)', () => {
    const harness = makeEvents();
    const registry = new DebugSessionRegistry(harness.events);
    harness.start({
      id: 's1',
      name: 'KBEngine: Python attach to cellapp',
      configuration: { processId: 4242 }
    });

    const stopped: Array<[string, string | undefined]> = [];
    const link = registry.linksFor('cellapp')[0];
    applySessionEndBehavior('stop-process', link, (component, targetId) => {
      stopped.push([component, targetId]);
    });
    expect(stopped).toEqual([['cellapp', DEFAULT_TARGET_ID]]);
  });
});

describe('DebugSessionRegistry(会话挂目标)', () => {
  it('两个 cellapp 会话各自挂到自己的 serverKey,无关会话不挂', () => {
    const harness = makeEvents();
    const registry = new DebugSessionRegistry(harness.events);

    harness.start({ id: 's1', name: 'KBEngine: Python attach to cellapp (debugpy 5679)' });
    harness.start({ id: 's2', name: 'KBEngine: Python attach to cellapp#a (debugpy 5708)' });
    harness.start({ id: 's3', name: 'KBEngine: Python attach 外网 (remote)' });
    harness.start({ id: 's4', name: '别的会话' });

    expect(registry.linksFor('cellapp').map(link => link.session.name)).toEqual([
      'KBEngine: Python attach to cellapp (debugpy 5679)'
    ]);
    expect(registry.linksFor('cellapp#a').map(link => link.port)).toEqual([5708]);
    expect(registry.linksFor('baseapp')).toEqual([]);
  });

  it('会话终止只摘自己:cellapp#a 的会话结束不影响 cellapp', () => {
    const harness = makeEvents();
    const registry = new DebugSessionRegistry(harness.events);
    const def = { id: 's1', name: 'KBEngine: Python attach to cellapp (debugpy 5679)' };
    const named = { id: 's2', name: 'KBEngine: Python attach to cellapp#a (debugpy 5708)' };
    harness.start(def);
    harness.start(named);

    harness.terminate(named);

    expect(registry.linksFor('cellapp#a')).toEqual([]);
    expect(registry.linksFor('cellapp')).toHaveLength(1);
  });

  it('同目标多会话都挂(旧会话未断时再附加)', () => {
    const harness = makeEvents();
    const registry = new DebugSessionRegistry(harness.events);
    harness.start({ id: 's1', name: 'KBEngine: Python attach to cellapp#a (debugpy 5708)' });
    harness.start({ id: 's2', name: 'KBEngine: Python attach to cellapp#a (debugpy 5708)' });

    expect(registry.linksFor('cellapp#a')).toHaveLength(2);
  });
});

describe('onLinkTerminated(会话结束事件,DBG-006)', () => {
  it('结束哪个会话就带哪个目标的链;订阅可释放', () => {
    const harness = makeEvents();
    const registry = new DebugSessionRegistry(harness.events);
    const ended: string[] = [];
    const subscription = registry.onLinkTerminated(link => ended.push(link.serverKey));

    const def = { id: 's1', name: 'KBEngine: Python attach to cellapp (debugpy 5679)' };
    const named = { id: 's2', name: 'KBEngine: Python attach to cellapp#a (debugpy 5708)' };
    const unrelated = { id: 's3', name: '无关会话' };
    harness.start(def);
    harness.start(named);
    harness.start(unrelated);

    harness.terminate(named);
    expect(ended).toEqual(['cellapp#a']);
    harness.terminate(def);
    expect(ended).toEqual(['cellapp#a', 'cellapp']);
    // 无关会话终止不产生链事件(从未登记)
    harness.terminate(unrelated);
    expect(ended).toEqual(['cellapp#a', 'cellapp']);

    subscription.dispose();
    harness.terminate({ id: 's1', name: 'KBEngine: Python attach to cellapp (debugpy 5679)' });
    expect(ended).toEqual(['cellapp#a', 'cellapp']);
  });
});

describe('applySessionEndBehavior(断开只影响指定目标,DBG-006)', () => {
  const link = {
    session: { id: 's1', name: 'KBEngine: Python attach to cellapp#a (debugpy 5708)' },
    component: 'cellapp',
    targetId: 'a',
    port: 5708,
    serverKey: 'cellapp#a'
  };

  it('detach(默认):会话结束零停止——进程与其他实例一律不动', () => {
    const stopped: Array<[string, string | undefined]> = [];
    applySessionEndBehavior('detach', link, (component, targetId) => {
      stopped.push([component, targetId]);
    });
    expect(stopped).toEqual([]);
  });

  it('stop-process:只停该会话的目标(组件名+targetId 精确到实例)', () => {
    const stopped: Array<[string, string | undefined]> = [];
    applySessionEndBehavior('stop-process', link, (component, targetId) => {
      stopped.push([component, targetId]);
    });
    expect(stopped).toEqual([['cellapp', 'a']]);
  });

  it('默认实例的链 targetId=default,停止调用按同键传递', () => {
    const stopped: Array<[string, string | undefined]> = [];
    applySessionEndBehavior(
      'stop-process',
      { ...link, targetId: DEFAULT_TARGET_ID, serverKey: 'cellapp' },
      (component, targetId) => {
        stopped.push([component, targetId]);
      }
    );
    expect(stopped).toEqual([['cellapp', DEFAULT_TARGET_ID]]);
  });
});

describe('buildDebugTargetBoard(会话×进程状态合板)', () => {
  it('两个 cellapp:进程状态与调试会话各自可辨', () => {
    const harness = makeEvents();
    const registry = new DebugSessionRegistry(harness.events);
    harness.start({ id: 's1', name: 'KBEngine: Python attach to cellapp (debugpy 5679)' });

    const running = new Map<string, { component: string; targetId: string; status: string }>([
      ['cellapp', { component: 'cellapp', targetId: DEFAULT_TARGET_ID, status: 'Starting' }],
      ['cellapp#a', { component: 'cellapp', targetId: 'a', status: 'Running' }],
      ['baseapp', { component: 'baseapp', targetId: DEFAULT_TARGET_ID, status: 'Running' }]
    ]);

    const board = buildDebugTargetBoard(running, registry);
    expect(board.map(row => row.serverKey)).toEqual(['cellapp', 'cellapp#a', 'baseapp']);
    expect(board[0]).toMatchObject({
      component: 'cellapp',
      targetId: DEFAULT_TARGET_ID,
      processStatus: 'Starting',
      attachedSessions: 1
    });
    expect(board[1]).toMatchObject({
      component: 'cellapp',
      targetId: 'a',
      processStatus: 'Running',
      attachedSessions: 0
    });
    expect(board[2].attachedSessions).toBe(0);
  });
});
