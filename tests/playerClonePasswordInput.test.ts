import { describe, expect, it, vi } from 'vitest';
import {
  CLONE_SUMMARY_SAVE,
  runConfigureCloneProfileCommand,
  type PlayerCloneCommandDeps
} from '../src/backend/playerDataCloneCommands';

// UX-REVIEW-005a/005c 向导化后的密码面回归:密码只在输入框与保存边界出现,
// 摘要/提示信息一律不含密码本体;留空输入 = 清除已存密码;取消不落盘。

describe.each(['source', 'target'] as const)('clone %s connection', role => {
  it('masks the password and passes it only to the profile store', async () => {
    const inputs = ['localhost', '3306', 'user', 'secret', 'game'];
    const showInputBox = vi.fn(async (_options: { prompt: string; password?: boolean }) => inputs.shift());
    const save = vi.fn(async () => undefined);
    const showInformationMessage = vi.fn(async () => undefined);
    // target:首次快选=环境(local),之后到摘要页;source:直接到摘要页
    const picks = role === 'target' ? ['local', CLONE_SUMMARY_SAVE] : [CLONE_SUMMARY_SAVE];
    const showQuickPick = vi.fn(async () => picks.shift());
    const deps = { showInputBox, profiles: { get: () => null, save }, showInformationMessage,
      showQuickPick } as unknown as PlayerCloneCommandDeps;
    await runConfigureCloneProfileCommand(deps, role);
    // target 需要先经环境选择(local)再到摘要;source 直达摘要
    expect(showInputBox.mock.calls[3][0]).toMatchObject({ password: true });
    for (const [index, [options]] of showInputBox.mock.calls.entries()) {
      if (index !== 3) { expect(options.password).not.toBe(true); }
    }
    expect(save).toHaveBeenCalledWith(role, expect.not.objectContaining({ password: 'secret' }), 'secret');
    expect(JSON.stringify(showInformationMessage.mock.calls)).not.toContain('secret');
  });

  it('passes an empty password as a request to clear the saved secret', async () => {
    const inputs = ['localhost', '3306', 'user', '', 'game'];
    const save = vi.fn(async () => undefined);
    const picks = role === 'target' ? ['local', CLONE_SUMMARY_SAVE] : [CLONE_SUMMARY_SAVE];
    const deps = { showInputBox: async () => inputs.shift(), profiles: { get: () => null, save },
      showInformationMessage: async () => undefined,
      showQuickPick: async () => picks.shift() } as unknown as PlayerCloneCommandDeps;
    await runConfigureCloneProfileCommand(deps, role);
    expect(save).toHaveBeenCalledWith(role, expect.any(Object), null);
  });

  it('does not save if password entry is cancelled', async () => {
    const inputs: (string | undefined)[] = ['localhost', '3306', 'user', undefined];
    const save = vi.fn();
    const deps = { showInputBox: async () => inputs.shift(), profiles: { get: () => null, save } } as unknown as PlayerCloneCommandDeps;
    await runConfigureCloneProfileCommand(deps, role);
    expect(save).not.toHaveBeenCalled();
  });

  it('summary placeholder never echoes the typed password (005c)', async () => {
    const inputs = ['localhost', '3306', 'user', 'super-secret-pw', 'game'];
    const pickPlaceholders: string[] = [];
    const deps = {
      showInputBox: async () => inputs.shift(),
      profiles: { get: () => null, save: async () => undefined },
      showInformationMessage: async () => undefined,
      showQuickPick: async (items: readonly string[], options: { placeHolder: string }) => {
        pickPlaceholders.push(options.placeHolder);
        return role === 'target' && pickPlaceholders.length === 1 ? 'local' : CLONE_SUMMARY_SAVE;
      }
    } as unknown as PlayerCloneCommandDeps;
    await runConfigureCloneProfileCommand(deps, role);
    expect(pickPlaceholders.length).toBeGreaterThan(0);
    for (const placeholder of pickPlaceholders) {
      expect(placeholder).not.toContain('super-secret-pw');
    }
    expect(JSON.stringify(deps)).not.toContain('super-secret-pw');
  });
});
