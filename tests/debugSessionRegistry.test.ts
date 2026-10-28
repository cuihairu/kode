import { describe, expect, it } from 'vitest';
import {
  DebugSessionRegistry,
  parseDebugSessionName,
  buildDebugTargetBoard
} from '../src/debugSessionRegistry';
import { DEFAULT_TARGET_ID } from '../src/serverManager';

// IDE-DBG-005 调试会话关联到运行目标:按 launch.json 生成条目名
// (表条目=默认实例,`component#targetId` 条目=命名实例)把 VS Code 调试
// 会话挂到对应 serverKey;进程状态来自 serverManager 在册面——同一组件
// 的默认实例与命名实例(两个 cellapp)的会话与状态各自可辨。

interface FakeSession {
  id: string;
  name: string;
  configuration?: { connect?: { port?: number } };
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
