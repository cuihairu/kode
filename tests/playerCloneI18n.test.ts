// UX-REVIEW-010d:clone 命令面双态 NLS 锁。缺省(无 bundle)=英文源文;
// setL10nBundle(zhBundle)=中文。关键口径:选择项文案与比较共用同一调用值
// (deps.localize(CLONE_SUMMARY_SAVE) / pickExportEncryption 内部同值),
// 断言在两种语言下都走通同一流程,锁死「比较依赖固定语言文字」的回退。

import { afterEach, expect, it, vi } from 'vitest';
import zhBundle from '../l10n/bundle.l10n.zh-cn.json';
import { l10nText } from '../src/nlsRuntime';
import {
  CLONE_SUMMARY_SAVE,
  EXPORT_CANCEL_ITEM,
  EXPORT_CONFIRM_ITEM,
  pickExportEncryption,
  runExportCloneCommand,
  type PlayerCloneCommandDeps
} from '../src/backend/playerDataCloneCommands';
import { setL10nBundle } from './fake-vscode/l10n';

afterEach(() => setL10nBundle({}));

it.each([
  ['English', {}, 'Configure source connection', 'Source database host', 'Port must be between 1 and 65535'],
  ['中文', zhBundle, '配置源连接', '源库主机', '端口必须在 1 到 65535 之间'],
])('localizes source setup and validation in %s', async (_language, bundle, action, prompt, portError) => {
  setL10nBundle(bundle);
  const localize = (message: string, args?: Record<string, string | number | boolean>): string =>
    l10nText(message, args);
  let configured = false;
  const inputs = ['host', '3306', 'user', 'secret', 'game'];
  const showInputBox = vi.fn(async (_options: { prompt: string; validateInput?: (value: string) => string | null }) => inputs.shift());
  const warning = vi.fn(async (_message: string, ...items: string[]) => items[0]);
  const deps = {
    localize,
    listEntityNames: () => ['Avatar'],
    profiles: { resolveConnection: async () => configured ? { host: 'host', port: 3306, user: 'user', database: 'game' } : null,
      get: () => null,
      save: async () => { configured = true; } },
    showWarningMessage: warning,
    showInputBox,
    showInformationMessage: async () => undefined,
    // 摘要页(005c)选「保存」完成配置;返回值经同一 localize(010d:
    // 比较走调用值,zh bundle 下返回「保存」也必须被摘要循环识别)
    showQuickPick: async () => localize(CLONE_SUMMARY_SAVE),
  } as unknown as PlayerCloneCommandDeps;
  await runExportCloneCommand(deps);
  expect(warning.mock.calls[0][1]).toBe(action);
  expect(showInputBox.mock.calls[0][0].prompt).toBe(prompt);
  expect(showInputBox.mock.calls[1][0].validateInput?.('65536')).toBe(portError);
  expect(configured).toBe(true);
});

it.each([
  ['English', {}, 'Export,Encrypted (local key)', 'Toggle encryption → Plaintext (portable)', 'Cancel', 'Export 3 read-only query results to the archive?'],
  ['中文', zhBundle, '导出,加密(本机钥匙)', '切换加密 → 明文(可跨机转移)', '取消', '确认导出 3 条只读查询的结果到归档?'],
])('localizes the export encryption confirm loop in %s', async (_language, bundle, confirm, toggle, cancel, question) => {
  setL10nBundle(bundle);
  const localize = (message: string, args?: Record<string, string | number | boolean>): string =>
    l10nText(message, args);
  const picks: string[][] = [];
  let call = 0;
  const pick = vi.fn(async (items: readonly string[], options: { placeHolder: string }): Promise<string | undefined> => {
    picks.push([...items]);
    expect(options.placeHolder).toBe(question);
    call += 1;
    // 第一轮切加密(默认加密 → 明文),第二轮点当轮确认项(文案随态刷新)
    return call === 1 ? toggle : picks[picks.length - 1][0];
  });
  const result = await pickExportEncryption(pick, 3, true, localize);
  expect(result).toEqual({ confirmed: true, encrypt: false });
  expect(picks[0]).toEqual([confirm, toggle, cancel]);
  // 第二轮确认项文案携带翻转后的加密态(标签 = 调用值,不是常量;
  // 翻转后的标签恰为切换项「→」之后的同一调用值)
  expect(picks[1][0]).toBe(`${localize(EXPORT_CONFIRM_ITEM)},${toggle.split(' → ')[1]}`);
  // 选项文案全程同一语言(010d:标签由调用时 l10n 值拼装,不混英文源文)
  expect(picks[0].every(item => item === confirm || item === toggle || item === cancel)).toBe(true);
  expect(picks[0]).toContain(localize(EXPORT_CANCEL_ITEM));
  expect(confirm.startsWith(localize(EXPORT_CONFIRM_ITEM))).toBe(true);
});
