// UX-2026-11-23 用户令:Export players 源连接须有「从最终配置读取」选项且展示配置值。
// 覆盖:quickpick 项渲染(值内联、密码不回显)、最终配置选中生效、defaults-only 告警、
// 最终配置不可用时的降级链。
import { expect, it, vi } from 'vitest';
import {
  runExportCloneCommand,
  formatExportSourceConnectionItem,
  type PlayerCloneCommandDeps
} from '../src/backend/playerDataCloneCommands';

const profileConn = { host: 'localhost', port: 3306, user: 'user', password: 'pw', database: 'game' };
const finalConn = {
  config: { host: '10.0.0.8', port: 3307, user: 'engine', password: 'engpw', database: 'kbengine_game' },
  defaultsOnly: false
};

const baseDeps = (extra: Partial<PlayerCloneCommandDeps>): PlayerCloneCommandDeps =>
  ({
    listEntityNames: () => ['Avatar'],
    profiles: { get: () => null, resolveConnection: async () => profileConn },
    resolveEntityTables: () => [{ name: 'tbl_Account' }],
    showQuickPick: vi.fn(async (items: readonly string[]) => items[0]),
    showInputBox: vi.fn(async () => '1'),
    showWarningMessage: vi.fn(async () => undefined),
    showErrorMessage: vi.fn(async () => undefined),
    showInformationMessage: vi.fn(async () => undefined),
    pickArchiveSavePath: vi.fn(async () => undefined),
    probeSourceConnection: vi.fn(async () => ({ ok: true as const })),
    ...extra
  }) as unknown as PlayerCloneCommandDeps;

it('formatExportSourceConnectionItem shows host:port/user/db inline, never the password', () => {
  const l10n = (m: string) => m;
  const item = formatExportSourceConnectionItem('Final config', finalConn.config, l10n);
  expect(item).toContain('10.0.0.8:3307');
  expect(item).toContain('user=engine');
  expect(item).toContain('db=kbengine_game');
  expect(item).toContain('password: stored');
  expect(item).not.toContain('engpw');
});

it('source quickpick offers Final config (with values) before Clone profile', async () => {
  const deps = baseDeps({ resolveFinalConfigSourceConnection: async () => finalConn });
  await runExportCloneCommand(deps);
  const firstPick = (deps.showQuickPick as ReturnType<typeof vi.fn>).mock.calls[0][0] as string[];
  expect(firstPick[0]).toMatch(/^Final config: 10\.0\.0\.8:3307/);
  expect(firstPick[1]).toMatch(/^Clone profile: localhost:3306/);
});

it('picking Final config probes with the final-config values, not the profile', async () => {
  const deps = baseDeps({ resolveFinalConfigSourceConnection: async () => finalConn });
  await runExportCloneCommand(deps);
  expect(deps.probeSourceConnection).toHaveBeenCalledWith(finalConn.config);
  expect(deps.probeSourceConnection).not.toHaveBeenCalledWith(profileConn);
});

it('defaults-only final config warns honestly before use', async () => {
  const warn = vi.fn(async () => undefined);
  const deps = baseDeps({
    resolveFinalConfigSourceConnection: async () => ({ ...finalConn, defaultsOnly: true }),
    showWarningMessage: warn
  });
  await runExportCloneCommand(deps);
  const warned = warn.mock.calls.map(c => String(c[0]));
  expect(warned.some(m => m.includes('engine defaults') && m.includes('kbengine.xml'))).toBe(true);
});

it('final config unavailable → only profile item; both unavailable → legacy not-configured dialog', async () => {
  const deps = baseDeps({ resolveFinalConfigSourceConnection: async () => null });
  await runExportCloneCommand(deps);
  const firstPick = (deps.showQuickPick as ReturnType<typeof vi.fn>).mock.calls[0][0] as string[];
  expect(firstPick.some(i => i.startsWith('Final config'))).toBe(false);
  expect(firstPick.some(i => i.startsWith('Clone profile'))).toBe(true);

  const none = baseDeps({
    resolveFinalConfigSourceConnection: async () => null,
    profiles: { get: () => null, resolveConnection: async () => null } as PlayerCloneCommandDeps['profiles']
  });
  await runExportCloneCommand(none);
  expect(none.showWarningMessage).toHaveBeenCalledWith(
    'Source connection is not configured.',
    'Configure source connection'
  );
});
