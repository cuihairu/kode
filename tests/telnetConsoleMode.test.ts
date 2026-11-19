import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TELNET_CONSOLE_MODE,
  isTelnetConsoleMode,
  telnetConsoleModeReducer
} from '../src/telnetConsoleMode';

// TELNET-EZ-001 ①:会话控制台模式状态机契约——白名单(安全只读)↔自由
// Python 双模式并存可切;断线/重连/重建会话不丢模式(生命周期事件是恒等
// 迁移),只有显式 set-mode 切换;未知值进不了状态。

describe('telnetConsoleMode 状态机契约(TELNET-EZ-001)', () => {
  it('默认白名单模式(安全只读快捷集)', () => {
    expect(DEFAULT_TELNET_CONSOLE_MODE).toBe('whitelist');
  });

  it('类型守卫:只认 whitelist/python,未知值拒绝', () => {
    expect(isTelnetConsoleMode('whitelist')).toBe(true);
    expect(isTelnetConsoleMode('python')).toBe(true);
    expect(isTelnetConsoleMode('free')).toBe(false);
    expect(isTelnetConsoleMode('')).toBe(false);
    expect(isTelnetConsoleMode(undefined)).toBe(false);
    expect(isTelnetConsoleMode(123)).toBe(false);
  });

  it('互切:whitelist → python → whitelist 往返', () => {
    let state = { mode: DEFAULT_TELNET_CONSOLE_MODE };
    state = telnetConsoleModeReducer(state, { type: 'set-mode', mode: 'python' });
    expect(state.mode).toBe('python');
    state = telnetConsoleModeReducer(state, { type: 'set-mode', mode: 'whitelist' });
    expect(state.mode).toBe('whitelist');
    // 再切回 python:同键可反复切换,无终态
    state = telnetConsoleModeReducer(state, { type: 'set-mode', mode: 'python' });
    expect(state.mode).toBe('python');
  });

  it('断线保留模式:session-closed 是恒等迁移', () => {
    const state = { mode: 'python' as const };
    expect(telnetConsoleModeReducer(state, { type: 'session-closed' })).toEqual({ mode: 'python' });
    expect(telnetConsoleModeReducer({ mode: 'whitelist' }, { type: 'session-closed' })).toEqual({
      mode: 'whitelist'
    });
  });

  it('重连沿用旧模式:session-connecting 是恒等迁移(含断旧建新)', () => {
    const state = { mode: 'python' as const };
    expect(telnetConsoleModeReducer(state, { type: 'session-connecting' })).toEqual({
      mode: 'python'
    });
    // 断线→重连→再断线:整条生命周期链后模式不变
    let walked = state;
    walked = telnetConsoleModeReducer(walked, { type: 'session-closed' });
    walked = telnetConsoleModeReducer(walked, { type: 'session-connecting' });
    walked = telnetConsoleModeReducer(walked, { type: 'session-closed' });
    expect(walked.mode).toBe('python');
  });

  it('set-mode 到同值:状态对象语义上无迁移(reducer 仍返回合法态)', () => {
    const state = { mode: 'whitelist' as const };
    const next = telnetConsoleModeReducer(state, { type: 'set-mode', mode: 'whitelist' });
    expect(next).toEqual({ mode: 'whitelist' });
  });
});
