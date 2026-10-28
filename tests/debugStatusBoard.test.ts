import { describe, expect, it } from 'vitest';
import { buildDebugStatusRows, resolveTargetDebugPhase } from '../src/debugStatusBoard';
import { DebugSessionRegistry, type DebugSessionLink } from '../src/debugSessionRegistry';
import { DEFAULT_TARGET_ID } from '../src/serverManager';

// IDE-DBG-008 工作台目标调试状态:把三份事实(进程在册面/注入结果面/
// 会话挂链面)合成逐目标一行四态板——未注入(无注入事实)/监听(注入成
// 功或等待模式持听)/已附加(有在挂会话,优先级最高)/失败(注入尝试
// 落败)。板只看运行中的目标:进程停了行即消失,残留注入事实不产行。

describe('resolveTargetDebugPhase(四态归因)', () => {
  it('无注入事实=未注入;listening=监听;failed=失败', () => {
    expect(resolveTargetDebugPhase(0, undefined)).toBe('not-injected');
    expect(resolveTargetDebugPhase(0, { outcome: 'listening', port: 5678 })).toBe('listening');
    expect(
      resolveTargetDebugPhase(0, { outcome: 'failed', detail: 'telnet 未就绪' })
    ).toBe('failed');
  });

  it('在挂会话一票定已附加(压过监听/失败)', () => {
    expect(resolveTargetDebugPhase(1, { outcome: 'listening', port: 5678 })).toBe('attached');
    expect(resolveTargetDebugPhase(2, { outcome: 'failed', detail: 'x' })).toBe('attached');
  });
});

describe('buildDebugStatusRows(会话×注入×进程合板)', () => {
  const registryLike = (sessions: string[]): Pick<DebugSessionRegistry, 'linksFor'> => ({
    linksFor: (serverKey: string) =>
      sessions
        .filter(name => parseKey(name) === serverKey)
        .map(name => ({ session: { id: name, name }, serverKey })) as DebugSessionLink[]
  });
  // 条目名即目标身份(DBG-005 口径):表条目=默认实例,#条目=命名实例
  const parseKey = (name: string): string => {
    const match = /^KBEngine: Python attach to (.+?)(?:#(.+?))? \(debugpy \d+\)$/.exec(name);
    return match ? (match[2] ? `${match[1]}#${match[2]}` : match[1]) : '';
  };

  it('四态并陈:未注入/监听/已附加/失败各归各位,行带进程状态与端口', () => {
    const running = new Map([
      ['cellapp', { component: 'cellapp', targetId: DEFAULT_TARGET_ID, status: 'Running' }],
      ['cellapp#a', { component: 'cellapp', targetId: 'a', status: 'Running' }],
      ['baseapp', { component: 'baseapp', targetId: DEFAULT_TARGET_ID, status: 'Running' }],
      ['dbmgr', { component: 'dbmgr', targetId: DEFAULT_TARGET_ID, status: 'Starting' }]
    ]);
    const injections = new Map([
      ['cellapp#a', { outcome: 'listening' as const, port: 5708 }],
      ['baseapp', { outcome: 'listening' as const, port: 5678 }],
      ['dbmgr', { outcome: 'failed' as const, detail: 'telnet 60s 未就绪,放弃注入' }]
    ]);
    const registry = registryLike(['KBEngine: Python attach to baseapp (debugpy 5678)']);

    const rows = buildDebugStatusRows(running, injections, registry);

    expect(rows.map(row => `${row.serverKey}:${row.phase}`)).toEqual([
      'cellapp:not-injected',
      'cellapp#a:listening',
      'baseapp:attached',
      'dbmgr:failed'
    ]);
    expect(rows[0]).toMatchObject({
      component: 'cellapp',
      targetId: DEFAULT_TARGET_ID,
      processStatus: 'Running',
      port: undefined,
      attachedSessions: 0
    });
    expect(rows[1].port).toBe(5708);
    expect(rows[2].attachedSessions).toBe(1);
    expect(rows[3].detail).toContain('放弃注入');
  });

  it('会话结束回退到监听(注入事实仍在);进程停了行即消失', () => {
    const runningBase = new Map([
      ['cellapp', { component: 'cellapp', targetId: DEFAULT_TARGET_ID, status: 'Running' }]
    ]);
    const injections = new Map([
      ['cellapp', { outcome: 'listening' as const, port: 5679 }],
      ['loginapp', { outcome: 'listening' as const, port: 5680 }] // 进程不在册:不产行
    ]);

    const attached = buildDebugStatusRows(
      runningBase,
      injections,
      registryLike(['KBEngine: Python attach to cellapp (debugpy 5679)'])
    );
    expect(attached[0].phase).toBe('attached');

    const detached = buildDebugStatusRows(runningBase, injections, registryLike([]));
    expect(detached[0].phase).toBe('listening');
  });
});
