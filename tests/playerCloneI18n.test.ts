import { afterEach, expect, it, vi } from 'vitest';
import zhBundle from '../l10n/bundle.l10n.zh-cn.json';
import { l10nText } from '../src/nlsRuntime';
import { CLONE_SUMMARY_SAVE, runExportCloneCommand, type PlayerCloneCommandDeps } from '../src/backend/playerDataCloneCommands';
import { setL10nBundle } from './fake-vscode/l10n';

afterEach(() => setL10nBundle({}));

it.each([
  ['English', {}, 'Configure source connection', 'Source database host', 'Port must be between 1 and 65535'],
  ['中文', zhBundle, '配置源连接', '源库主机', '端口必须在 1 到 65535 之间'],
])('localizes source setup and validation in %s', async (_language, bundle, action, prompt, portError) => {
  setL10nBundle(bundle);
  let configured = false;
  const inputs = ['host', '3306', 'user', 'secret', 'game'];
  const showInputBox = vi.fn(async (_options: { prompt: string; validateInput?: (value: string) => string | null }) => inputs.shift());
  const warning = vi.fn(async (_message: string, ...items: string[]) => items[0]);
  const deps = {
    localize: l10nText,
    listEntityNames: () => ['Avatar'],
    profiles: { resolveConnection: async () => configured ? { host: 'host', port: 3306, user: 'user', database: 'game' } : null,
      get: () => null,
      save: async () => { configured = true; } },
    showWarningMessage: warning,
    showInputBox,
    showInformationMessage: async () => undefined,
    // 摘要页(005c)选「保存」完成配置;返回 undefined 会被当作取消
    showQuickPick: async () => CLONE_SUMMARY_SAVE,
  } as unknown as PlayerCloneCommandDeps;
  await runExportCloneCommand(deps);
  expect(warning.mock.calls[0][1]).toBe(action);
  expect(showInputBox.mock.calls[0][0].prompt).toBe(prompt);
  expect(showInputBox.mock.calls[1][0].validateInput?.('65536')).toBe(portError);
  expect(configured).toBe(true);
});
