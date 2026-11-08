import { describe, expect, it, vi } from 'vitest';
import { runConfigureCloneProfileCommand, type PlayerCloneCommandDeps } from '../src/playerDataCloneCommands';

describe.each(['source', 'target'] as const)('clone %s connection', role => {
  it('masks the password and passes it only to the profile store', async () => {
    const inputs = ['localhost', '3306', 'user', 'secret', 'game'];
    const showInputBox = vi.fn(async (_options: { prompt: string; password?: boolean }) => inputs.shift());
    const save = vi.fn(async () => undefined);
    const showInformationMessage = vi.fn(async () => undefined);
    const deps = { showInputBox, profiles: { save }, showInformationMessage,
      showQuickPick: async () => 'local' } as unknown as PlayerCloneCommandDeps;
    await runConfigureCloneProfileCommand(deps, role);
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
    const deps = { showInputBox: async () => inputs.shift(), profiles: { save },
      showInformationMessage: async () => undefined, showQuickPick: async () => 'local' } as unknown as PlayerCloneCommandDeps;
    await runConfigureCloneProfileCommand(deps, role);
    expect(save).toHaveBeenCalledWith(role, expect.any(Object), null);
  });

  it('does not save if password entry is cancelled', async () => {
    const inputs: (string | undefined)[] = ['localhost', '3306', 'user', undefined];
    const save = vi.fn();
    const deps = { showInputBox: async () => inputs.shift(), profiles: { save } } as unknown as PlayerCloneCommandDeps;
    await runConfigureCloneProfileCommand(deps, role);
    expect(save).not.toHaveBeenCalled();
  });
});
