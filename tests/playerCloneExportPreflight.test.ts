import { expect, it, vi } from 'vitest';
import { CLONE_SUMMARY_SAVE, runExportCloneCommand, type PlayerCloneCommandDeps } from '../src/playerDataCloneCommands';

it('offers source setup before asking for an entity or DBID and resumes afterwards', async () => {
  let configured = false;
  const inputs = ['localhost', '3306', 'user', 'secret', 'game'];
  // 首次快选=配置向导摘要页(005c)选「保存」;其后才是实体选择(返回 undefined 取消导出)
  const pick = vi.fn(async (items: readonly string[]) =>
    items.includes(CLONE_SUMMARY_SAVE) ? CLONE_SUMMARY_SAVE : undefined
  );
  const input = vi.fn(async () => inputs.shift());
  const deps = {
    listEntityNames: () => ['Avatar'],
    profiles: {
      get: () => null,
      resolveConnection: async () => configured ? { host: 'localhost', port: 3306, user: 'user', database: 'game' } : null,
      save: async () => { configured = true; },
    },
    showWarningMessage: vi.fn(async () => 'Configure source connection'),
    showInformationMessage: vi.fn(async () => undefined),
    showInputBox: input,
    showQuickPick: pick,
  } as unknown as PlayerCloneCommandDeps;
  await runExportCloneCommand(deps);
  expect(configured).toBe(true);
  expect(input).toHaveBeenCalledTimes(5);
  expect(pick).toHaveBeenCalledTimes(2);
  expect(pick.mock.calls[1][0]).toEqual(['Avatar']);
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
