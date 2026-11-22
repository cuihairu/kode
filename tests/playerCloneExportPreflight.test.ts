import { expect, it, vi } from 'vitest';
import { setKodeCoreShadowGate } from '../src/backend/kodeCoreShadowFaces';
import type { KodeCoreGate } from '../src/backend/kodeCoreGate';
import type { CloneMysqlModule } from '../src/backend/playerDataCloneMysql';
import {
  CLONE_PROBE_TIMEOUT_MS_DEFAULT,
  CLONE_SUMMARY_SAVE,
  cloneBackendProbe,
  cloneSourceConnectionProbe,
  runExportCloneCommand,
  type PlayerCloneCommandDeps
} from '../src/backend/playerDataCloneCommands';

const NO_GATE =
  'Player Data Clone requires the Rust backend (kode-server) to be available: check the kode-core server configuration.';

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

// ---------------------------------------------------------------------------
// UX-REVIEW-004b 余量:可用后端预检 + 源连接测试入口 + 实体上下文前置
// ---------------------------------------------------------------------------

const sourceConfig = { host: 'localhost', port: 3306, user: 'user', password: 'pw', database: 'game' };

const baseDeps = (extra: Partial<PlayerCloneCommandDeps> & {
  probeCalls?: Array<{ ok: true } | { ok: false; reason: string }>;
}): PlayerCloneCommandDeps => {
  const probeResults = extra.probeCalls ?? [];
  let probeIndex = 0;
  const { probeCalls: _probeCalls, ...rest } = extra;
  return {
    listEntityNames: () => ['Avatar'],
    profiles: {
      get: () => null,
      resolveConnection: async () => sourceConfig
    },
    showQuickPick: vi.fn(async () => undefined),
    showInputBox: vi.fn(async () => undefined),
    showWarningMessage: vi.fn(async () => undefined),
    showErrorMessage: vi.fn(async () => undefined),
    showInformationMessage: vi.fn(async () => undefined),
    probeSourceConnection: vi.fn(async () => {
      const next = probeResults[Math.min(probeIndex, probeResults.length - 1)] ?? { ok: true as const };
      probeIndex += 1;
      return next;
    }),
    ...rest
  } as unknown as PlayerCloneCommandDeps;
};

it('backend probe false → honest error before collecting entity or DBID', async () => {
  const deps = baseDeps({ probeCloneBackend: () => false });
  await runExportCloneCommand(deps);
  expect(deps.showErrorMessage).toHaveBeenCalledWith(NO_GATE);
  expect(deps.showQuickPick).not.toHaveBeenCalled();
  expect(deps.showInputBox).not.toHaveBeenCalled();
  expect(deps.probeSourceConnection).not.toHaveBeenCalled();
});

it('backend probe true → flow proceeds to entity pick', async () => {
  const deps = baseDeps({ probeCloneBackend: () => true });
  await runExportCloneCommand(deps);
  expect(deps.showErrorMessage).not.toHaveBeenCalled();
  expect(deps.showQuickPick).toHaveBeenCalled();
});

it('connection probe ok → straight to entity pick after one probe', async () => {
  const deps = baseDeps({});
  await runExportCloneCommand(deps);
  expect(deps.probeSourceConnection).toHaveBeenCalledTimes(1);
  expect(deps.probeSourceConnection).toHaveBeenCalledWith(sourceConfig);
  expect(deps.showQuickPick).toHaveBeenCalled();
  expect(deps.showInputBox).not.toHaveBeenCalled();
});

it('connection probe fail → reason with retry/configure items; retry passes and flow resumes', async () => {
  const deps = baseDeps({
    probeCalls: [{ ok: false, reason: 'ECONNREFUSED 127.0.0.1:3306' }, { ok: true }]
  });
  vi.mocked(deps.showWarningMessage).mockResolvedValue('Retry connection test');
  await runExportCloneCommand(deps);
  expect(deps.probeSourceConnection).toHaveBeenCalledTimes(2);
  expect(deps.showWarningMessage).toHaveBeenCalledWith(
    'Source connection test failed: ECONNREFUSED 127.0.0.1:3306',
    'Retry connection test',
    'Configure source connection'
  );
  expect(deps.showQuickPick).toHaveBeenCalledTimes(1);
  expect(deps.showInputBox).not.toHaveBeenCalled();
});

it('connection probe fail → configure entry runs wizard, re-probes and resumes', async () => {
  let configured = false;
  const inputs = ['localhost', '3306', 'user', 'secret', 'game'];
  const pick = vi.fn(async (items: readonly string[]) =>
    items.includes(CLONE_SUMMARY_SAVE) ? CLONE_SUMMARY_SAVE : undefined
  );
  const probe = vi.fn(async () =>
    configured ? ({ ok: true } as const) : ({ ok: false, reason: 'Access denied' } as const)
  );
  const deps = {
    listEntityNames: () => ['Avatar'],
    profiles: {
      get: () => null,
      // 配置自始在场:探针#1 失败 → 配置向导 → 保存 → 探针#2 通过
      resolveConnection: async () => ({ host: 'localhost', port: 3306, user: 'user', database: 'game' }),
      save: async () => { configured = true; }
    },
    // 探针失败告警=重试/配置双入口(items[1]=配置入口)
    showWarningMessage: vi.fn(async (_m: string, ...items: string[]) => items[1] ?? items[0]),
    showInputBox: vi.fn(async () => inputs.shift()),
    showQuickPick: pick,
    showErrorMessage: vi.fn(async () => undefined),
    showInformationMessage: vi.fn(async () => undefined),
    probeSourceConnection: probe
  } as unknown as PlayerCloneCommandDeps;
  await runExportCloneCommand(deps);
  expect(configured).toBe(true);
  expect(probe).toHaveBeenCalledTimes(2);
  expect(pick.mock.calls.at(-1)![0]).toEqual(['Avatar']);
});

it('connection probe fail → configure declined inside wizard aborts without entity pick', async () => {
  let resolveCalls = 0;
  const probe = vi.fn(async () => ({ ok: false as const, reason: 'Access denied' }));
  const deps = {
    listEntityNames: () => ['Avatar'],
    profiles: {
      get: () => null,
      // 第 1 次=预检配置在场;向导取消后第 2 次=台账仍为空(未保存半成品)
      resolveConnection: async () => {
        resolveCalls += 1;
        return resolveCalls === 1 ? { host: 'localhost', port: 3306, user: 'user', database: 'game' } : null;
      },
      save: async () => undefined
    },
    showWarningMessage: vi.fn(async (_m: string, ...items: string[]) => items[1] ?? items[0]),
    showInputBox: vi.fn(async () => undefined),
    showQuickPick: vi.fn(async () => undefined),
    showErrorMessage: vi.fn(async () => undefined),
    probeSourceConnection: probe
  } as unknown as PlayerCloneCommandDeps;
  await runExportCloneCommand(deps);
  expect(probe).toHaveBeenCalledTimes(1);
  expect(deps.showQuickPick).not.toHaveBeenCalled();
});

it('connection probe fail → dismissing the dialog aborts without collecting inputs', async () => {
  const deps = baseDeps({ probeCalls: [{ ok: false, reason: 'timeout' }] });
  vi.mocked(deps.showWarningMessage).mockResolvedValue(undefined);
  await runExportCloneCommand(deps);
  expect(deps.probeSourceConnection).toHaveBeenCalledTimes(1);
  expect(deps.showQuickPick).not.toHaveBeenCalled();
  expect(deps.showInputBox).not.toHaveBeenCalled();
});

it('entity context check precedes DBID input: derivation failure does not waste the DBID', async () => {
  const deps = baseDeps({ resolveEntityTables: () => null });
  vi.mocked(deps.showQuickPick).mockResolvedValue('Avatar');
  await runExportCloneCommand(deps);
  expect(deps.showErrorMessage).toHaveBeenCalledWith(
    'Cannot derive table structure for entity Avatar from workspace defs.'
  );
  expect(deps.showInputBox).not.toHaveBeenCalled();
});

it('cloneBackendProbe follows the shadow gate presence', () => {
  const gate = { runInRust: async () => ({ ok: true as const, result: null }) } as unknown as KodeCoreGate;
  const probe = cloneBackendProbe();
  setKodeCoreShadowGate(gate);
  expect(probe()).toBe(true);
  setKodeCoreShadowGate(null);
  expect(probe()).toBe(false);
});

it('cloneSourceConnectionProbe opens a read-only session, reads VERSION and closes', async () => {
  const queries: string[] = [];
  let ended = 0;
  const connection = {
    query: async (sql: string) => {
      queries.push(sql);
      return [[{ v: '8.0.36' }]];
    },
    end: async () => { ended += 1; }
  };
  const loadModule = async () =>
    ({ createConnection: async () => connection }) as unknown as CloneMysqlModule;
  const probe = cloneSourceConnectionProbe(loadModule);
  await expect(probe(sourceConfig)).resolves.toEqual({ ok: true });
  expect(queries).toContain('SET SESSION TRANSACTION READ ONLY');
  expect(queries.some(sql => sql.includes('SELECT VERSION()'))).toBe(true);
  expect(ended).toBe(1);
});

it('cloneSourceConnectionProbe reports the raw failure reason without leaking a fake ok', async () => {
  const loadModule = async () =>
    ({ createConnection: async () => { throw new Error('ECONNREFUSED 127.0.0.1:3306'); } }) as unknown as CloneMysqlModule;
  const probe = cloneSourceConnectionProbe(loadModule);
  await expect(probe(sourceConfig)).resolves.toEqual({ ok: false, reason: 'ECONNREFUSED 127.0.0.1:3306' });
});

// ---------------------------------------------------------------------------
// UX-2026-11-22 整改2:探针独立短超时档(不占导出执行侧长超时)
// ---------------------------------------------------------------------------

it('probe default deadline is the documented 5s (kbengine.clone.probeTimeoutMs default)', () => {
  expect(CLONE_PROBE_TIMEOUT_MS_DEFAULT).toBe(5000);
});

it('probe with a large deadline and a live session resolves ok without spurious timeout', async () => {
  const queries: string[] = [];
  const connection = {
    query: async (sql: string) => {
      queries.push(sql);
      return sql.includes('SELECT VERSION()') ? [[{ v: '8.0.36' }]] : [[]];
    },
    end: async () => undefined
  };
  const loadModule = async () =>
    ({ createConnection: async () => connection }) as unknown as CloneMysqlModule;
  const probe = cloneSourceConnectionProbe(loadModule, () => 100_000);
  await expect(probe(sourceConfig)).resolves.toEqual({ ok: true });
});

it('probe times out after the configured short deadline and reports the timeout reason', async () => {
  // createConnection 永不落定:模拟「连不上/挂死」;短档把体感从长超时(120s)
  // 压到配置档,失败立即回给重试/配置弹窗。
  const hangModule = async () =>
    ({ createConnection: async () => new Promise(() => undefined) }) as unknown as CloneMysqlModule;
  const probe = cloneSourceConnectionProbe(hangModule, () => 25);
  await expect(probe(sourceConfig)).resolves.toEqual({
    ok: false,
    reason: 'source connection probe timed out after 25ms'
  });
});

it('probe deadline is read at fire time (config change between calls is honored)', async () => {
  const queries: string[] = [];
  const connection = {
    query: async (sql: string) => {
      queries.push(sql);
      return sql.includes('SELECT VERSION()') ? [[{ v: '8.0.36' }]] : [[]];
    },
    end: async () => undefined
  };
  const loadModule = async () =>
    ({ createConnection: async () => connection }) as unknown as CloneMysqlModule;
  let deadline = 100_000;
  const probe = cloneSourceConnectionProbe(loadModule, () => deadline);
  await expect(probe(sourceConfig)).resolves.toEqual({ ok: true });
  // 收紧档:同一探针实例,下一次调用即按新档超时——证明读发生在 fire time。
  deadline = 1;
  const hangModule = async () =>
    ({ createConnection: async () => new Promise(() => undefined) }) as unknown as CloneMysqlModule;
  const probe2 = cloneSourceConnectionProbe(hangModule, () => deadline);
  await expect(probe2(sourceConfig)).resolves.toEqual({
    ok: false,
    reason: 'source connection probe timed out after 1ms'
  });
});

it('probe timeout surfaces into the existing retry/configure dialog (no hang, no entity pick)', async () => {
  const hangModule = async () =>
    ({ createConnection: async () => new Promise(() => undefined) }) as unknown as CloneMysqlModule;
  const deps = baseDeps({ probeSourceConnection: cloneSourceConnectionProbe(hangModule, () => 25) });
  await runExportCloneCommand(deps);
  expect(deps.showWarningMessage).toHaveBeenCalledWith(
    'Source connection test failed: source connection probe timed out after 25ms',
    'Retry connection test',
    'Configure source connection'
  );
  expect(deps.showQuickPick).not.toHaveBeenCalled();
  expect(deps.showInputBox).not.toHaveBeenCalled();
});
