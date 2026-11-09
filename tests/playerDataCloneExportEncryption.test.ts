import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  executeExportPlan,
  CloneCancelledError,
  openCloneSession,
  probePhysicalTables
} from '../src/backend/playerDataCloneMysql';
import { setKodeCoreShadowGate, type KodeCoreGate } from '../src/kodeCoreShadowFaces';
import {
  runExportCloneCommand,
  type PlayerCloneCommandDeps
} from '../src/backend/playerDataCloneCommands';
import type { CloneProfileStore } from '../src/backend/playerDataCloneProfiles';
import {
  tvBigUInt,
  tvText,
  type QueryPlanWire,
  type TypedRowWire
} from '../src/backend/playerDataCloneWire';

// PDC-0609:导出加密选择(设置默认 + 导出确认页逐次切换)。命令层全流程:
// vi.mock mysql 会话层,gate 走 setKodeCoreShadowGate 真路径——断言最终
// `$/kode/dbClone/export` 载荷的 keyRoot 跟随选择(加密=/keys,明文=undefined
// 字段不传),切换循环反复翻转直至导出/取消。取消时不发 export RPC。

vi.mock('../src/backend/playerDataCloneMysql', () => {
  class CloneCancelledError extends Error {}
  class CloneApplyCancelledError extends Error {}
  return {
    CloneCancelledError,
    CloneApplyCancelledError,
    applyImportPlan: vi.fn(),
    columnOrderFromPlan: vi.fn(() => []),
    executeExportPlan: vi.fn(),
    openCloneSession: vi.fn(),
    probeExistingValues: vi.fn(),
    probePhysicalTables: vi.fn(),
    testCloneConnection: vi.fn(),
    uniqueValuesFromRows: vi.fn(() => [])
  };
});

const plan: QueryPlanWire = {
  entity_name: 'Avatar',
  row_budget: 1000,
  queries: [
    {
      sequence: 0,
      table: 'tbl_Avatar',
      parent_table: null,
      filter: { kind: 'root-id' },
      columns: ['id', 'sm_name'],
      column_types: ['bigint unsigned', 'varchar'],
      select_sql: 'SELECT `id`, `sm_name` FROM `tbl_Avatar` WHERE `id` = ?',
      estimated_rows: 1
    }
  ],
  denied: [],
  missing: [],
  identity: null,
  estimated_rows_total: 1
} as unknown as QueryPlanWire;

const rows: TypedRowWire[] = [
  { table: 'tbl_Avatar', values: [tvBigUInt(7), tvText('hero')] }
];

interface ConfirmMenu {
  items: readonly string[];
  placeHolder: string;
}

/** 按导出流程顺序装配 deps:实体选 Avatar → DBID 7 → 确认页消费 confirmQueue,
 * 同时记录每屏确认菜单供断言(切换循环的文案/初始态)。 */
function makeDeps(
  confirmQueue: string[],
  menus: ConfirmMenu[],
  encryptionDefault?: 'encrypted' | 'plain'
): PlayerCloneCommandDeps {
  return {
    profiles: {
      resolveConnection: async () => ({ host: '127.0.0.1', port: 3306, user: 'root' })
    } as unknown as CloneProfileStore,
    listEntityNames: () => ['Avatar'],
    resolveEntityTables: () => [{ name: 'tbl_Avatar' }],
    showQuickPick: async (items, options) => {
      if (options.placeHolder.includes('选择要导出的实体')) {
        return 'Avatar';
      }
      menus.push({ items, placeHolder: options.placeHolder });
      const next = confirmQueue.shift();
      return next ?? '取消(Cancel)';
    },
    showInputBox: async () => '7',
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    withProgress: (_options, task) => task({ isCancellationRequested: false }),
    pickArchiveSavePath: async () => '/tmp/out.kdpclone',
    pickArchiveOpenPath: async () => undefined,
    writeAuditFile: async () => '/tmp/audit.json',
    listAuditFiles: () => [],
    readAuditFile: async () => null,
    getKeyRoot: () => '/keys',
    ...(encryptionDefault ? { getArchiveEncryptionDefault: () => encryptionDefault } : {}),
    channel: { appendLine: () => undefined, show: () => undefined },
    now: () => 0
  };
}

describe('runExportCloneCommand(导出加密选择,设置默认+确认页切换)', () => {
  let exportParams: Record<string, unknown> | undefined;
  let gate: KodeCoreGate;

  beforeEach(() => {
    vi.mocked(openCloneSession).mockResolvedValue({
      end: async () => undefined
    } as never);
    vi.mocked(probePhysicalTables).mockResolvedValue([{ name: 'tbl_Avatar' }] as never);
    vi.mocked(executeExportPlan).mockResolvedValue(rows);
    exportParams = undefined;
    gate = {
      runInRust: async (method: string, params: unknown) => {
        if (method === '$/kode/dbClone/planExport') {
          return { ok: true, result: plan };
        }
        if (method === '$/kode/dbClone/export') {
          exportParams = params as Record<string, unknown>;
          return { ok: true, result: { entity: 'Avatar', total_rows: 1, tables: [] } };
        }
        return { ok: false, reason: `unexpected method ${method}` };
      }
    } as unknown as KodeCoreGate;
    setKodeCoreShadowGate(gate);
  });

  afterEach(() => {
    setKodeCoreShadowGate(null);
    vi.clearAllMocks();
  });

  it('默认加密:直接导出 → export 载荷带 keyRoot,确认项文案携带加密态', async () => {
    const menus: ConfirmMenu[] = [];
    await runExportCloneCommand(makeDeps(['导出(Export),加密(本机钥匙)'], menus));
    expect(menus).toHaveLength(1);
    expect(menus[0].items[0]).toContain('加密(本机钥匙)');
    expect(menus[0].items.some(item => item.startsWith('切换加密'))).toBe(true);
    expect(exportParams?.keyRoot).toBe('/keys');
    expect(exportParams?.redactSensitive).toBe(true);
  });

  it('确认页切换一次 → 明文导出:载荷 keyRoot undefined,确认项文案翻转为明文', async () => {
    const menus: ConfirmMenu[] = [];
    await runExportCloneCommand(
      makeDeps(['切换加密 → 明文(可跨机转移)', '导出(Export),明文(可跨机转移)'], menus)
    );
    expect(menus).toHaveLength(2);
    expect(menus[0].items[0]).toContain('加密(本机钥匙)');
    expect(menus[1].items[0]).toContain('明文(可跨机转移)');
    expect(exportParams?.keyRoot).toBeUndefined();
  });

  it('设置默认 plain(getArchiveEncryptionDefault) → 无切换即明文导出', async () => {
    const menus: ConfirmMenu[] = [];
    await runExportCloneCommand(
      makeDeps(['导出(Export),明文(可跨机转移)'], menus, 'plain')
    );
    expect(menus[0].items[0]).toContain('明文(可跨机转移)');
    expect(exportParams?.keyRoot).toBeUndefined();
  });

  it('确认页取消 → 不发 export RPC', async () => {
    const menus: ConfirmMenu[] = [];
    await runExportCloneCommand(makeDeps(['取消(Cancel)'], menus));
    expect(exportParams).toBeUndefined();
    expect(vi.mocked(executeExportPlan)).not.toHaveBeenCalled();
  });

  it('取消已关闭的流时，连接关闭错误不覆盖取消状态', async () => {
    const deps = makeDeps(['导出(Export),加密(本机钥匙)'], []);
    const warning = vi.fn(async () => undefined);
    deps.showWarningMessage = warning;
    vi.mocked(executeExportPlan).mockRejectedValueOnce(new CloneCancelledError());
    vi.mocked(openCloneSession).mockResolvedValueOnce({ end: async () => { throw new Error('socket already closed'); } } as never);
    await runExportCloneCommand(deps);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('导出已取消'));
    expect(exportParams).toBeUndefined();
  });
});
