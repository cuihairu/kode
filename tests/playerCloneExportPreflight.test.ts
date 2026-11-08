import { expect, it, vi } from 'vitest';
import { runExportCloneCommand, type PlayerCloneCommandDeps } from '../src/playerDataCloneCommands';

it('offers source setup before asking for an entity or DBID and resumes afterwards', async () => {
  let configured = false;
  const inputs = ['localhost', '3306', 'user', 'secret', 'game'];
  const pick = vi.fn(async () => undefined);
  const input = vi.fn(async () => inputs.shift());
  const deps = {
    listEntityNames: () => ['Avatar'],
    profiles: {
      resolveConnection: async () => configured ? { host: 'localhost', port: 3306, user: 'user', database: 'game' } : null,
      save: async () => { configured = true; },
    },
    showWarningMessage: vi.fn(async () => '配置源连接'),
    showInformationMessage: vi.fn(async () => undefined),
    showInputBox: input,
    showQuickPick: pick,
  } as unknown as PlayerCloneCommandDeps;
  await runExportCloneCommand(deps);
  expect(configured).toBe(true);
  expect(input).toHaveBeenCalledTimes(5);
  expect(pick).toHaveBeenCalledOnce();
  expect(pick.mock.calls[0][0]).toEqual(['Avatar']);
});

it('stops without asking for entity or DBID when setup is declined', async () => {
  const pick = vi.fn();
  const input = vi.fn();
  const deps = { listEntityNames: () => ['Avatar'], profiles: { resolveConnection: async () => null },
    showWarningMessage: async () => undefined, showInputBox: input, showQuickPick: pick } as unknown as PlayerCloneCommandDeps;
  await runExportCloneCommand(deps);
  expect(pick).not.toHaveBeenCalled();
  expect(input).not.toHaveBeenCalled();
});
