/**
 * TELNET-EZ-001:telnet 会话控制台模式状态机(纯核,零 vscode)。
 *
 * 两种模式并存可切:
 * - whitelist:白名单闸(安全只读快捷集+用户 enableCommands,默认);
 * - python:自由 Python 交互(直接执行引擎侧 Python,面板侧警示色标注)。
 *
 * 契约:模式是「目标键上的会话属性」,断线/重连/重建客户端都不得丢——
 * 断线后模式保留,重连同目标沿用旧模式;只有显式 set-mode 才切换。
 * 会话生命周期事件(connecting/closed)在 reducer 里是恒等迁移,把
 * 「断线不丢模式」钉进类型而非靠调用方自觉。
 */

export type TelnetConsoleMode = 'whitelist' | 'python';

/** 默认白名单模式:安全只读快捷集 */
export const DEFAULT_TELNET_CONSOLE_MODE: TelnetConsoleMode = 'whitelist';

export function isTelnetConsoleMode(value: unknown): value is TelnetConsoleMode {
  return value === 'whitelist' || value === 'python';
}

export interface TelnetConsoleModeState {
  mode: TelnetConsoleMode;
}

export type TelnetConsoleModeAction =
  | { type: 'set-mode'; mode: TelnetConsoleMode }
  /** 建立会话/connectTarget(含断旧建新的重连):模式沿用 */
  | { type: 'session-connecting' }
  /** 会话断开(主动/掉线):模式保留 */
  | { type: 'session-closed' };

export function telnetConsoleModeReducer(
  state: TelnetConsoleModeState,
  action: TelnetConsoleModeAction
): TelnetConsoleModeState {
  switch (action.type) {
    case 'set-mode':
      return { mode: action.mode };
    case 'session-connecting':
    case 'session-closed':
      // 会话生命周期事件不改模式(断线保留/重连沿用)
      return state;
  }
}
