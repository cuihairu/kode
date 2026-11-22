import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  executeExportPlan,
  CloneCancelledError,
  openCloneSession,
  probePhysicalTables
} from '../src/backend/playerDataCloneMysql';
import { setKodeCoreShadowGate, type KodeCoreGate } from '../src/backend/kodeCoreShadowFaces';
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
      if (options.placeHolder.includes('Select the entity to export')) {
        return 'Avatar';
      }
      menus.push({ items, placeHolder: options.placeHolder });
      const next = confirmQueue.shift();
      return next ?? 'Cancel';
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
    await runExportCloneCommand(makeDeps(['Export,Encrypted (local key)'], menus));
    expect(menus).toHaveLength(1);
    expect(menus[0].items[0]).toContain('Encrypted (local key)');
    expect(menus[0].items.some(item => item.startsWith('Toggle encryption'))).toBe(true);
    expect(exportParams?.keyRoot).toBe('/keys');
    expect(exportParams?.redactSensitive).toBe(true);
  });

  it('确认页切换一次 → 明文导出:载荷 keyRoot undefined,确认项文案翻转为明文', async () => {
    const menus: ConfirmMenu[] = [];
    await runExportCloneCommand(
      makeDeps(['Toggle encryption → Plaintext (portable)', 'Export,Plaintext (portable)'], menus)
    );
    expect(menus).toHaveLength(2);
    expect(menus[0].items[0]).toContain('Encrypted (local key)');
    expect(menus[1].items[0]).toContain('Plaintext (portable)');
    expect(exportParams?.keyRoot).toBeUndefined();
  });

  it('设置默认 plain(getArchiveEncryptionDefault) → 无切换即明文导出', async () => {
    const menus: ConfirmMenu[] = [];
    await runExportCloneCommand(
      makeDeps(['Export,Plaintext (portable)'], menus, 'plain')
    );
    expect(menus[0].items[0]).toContain('Plaintext (portable)');
    expect(exportParams?.keyRoot).toBeUndefined();
  });

  it('确认页取消 → 不发 export RPC', async () => {
    const menus: ConfirmMenu[] = [];
    await runExportCloneCommand(makeDeps(['Cancel'], menus));
    expect(exportParams).toBeUndefined();
    expect(vi.mocked(executeExportPlan)).not.toHaveBeenCalled();
  });

  it('取消已关闭的流时，连接关闭错误不覆盖取消状态', async () => {
    const deps = makeDeps(['Export,Encrypted (local key)'], []);
    const warning = vi.fn(async () => undefined);
    deps.showWarningMessage = warning;
    vi.mocked(executeExportPlan).mockRejectedValueOnce(new CloneCancelledError());
    vi.mocked(openCloneSession).mockResolvedValueOnce({ end: async () => { throw new Error('socket already closed'); } } as never);
    await runExportCloneCommand(deps);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('Export cancelled'));
    expect(exportParams).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// UX-2026-11-22 整改1/3:记住上次选择 + 计划预览弹窗化
// ---------------------------------------------------------------------------

describe('runExportCloneCommand UX-2026-11-22(记住选择/计划预览弹窗化)', () => {
  let entityMenus: Array<{ items: readonly string[]; placeHolder: string }>;
  let inputOptions: Array<{ prompt: string; value?: string }>;
  let saveArgs: Array<{ defaultName: string; defaultDir?: string }>;
  let confirmMenus: ConfirmMenu[];
  let remembered: Array<{ entityName: string; dbid: string; savePath: string; encrypt: boolean }>;
  let channelLines: string[];

  beforeEach(() => {
    // 兄弟 describe 不继承外层装配:这里复刻同款 gate+mysql mock。
    vi.mocked(openCloneSession).mockResolvedValue({
      end: async () => undefined
    } as never);
    vi.mocked(probePhysicalTables).mockResolvedValue([{ name: 'tbl_Avatar' }] as never);
    vi.mocked(executeExportPlan).mockResolvedValue(rows);
    setKodeCoreShadowGate({
      runInRust: async (method: string) => {
        if (method === '$/kode/dbClone/planExport') {
          return { ok: true, result: plan };
        }
        if (method === '$/kode/dbClone/export') {
          return { ok: true, result: { entity: 'Avatar', total_rows: 1, tables: [] } };
        }
        return { ok: false, reason: `unexpected method ${method}` };
      }
    } as unknown as KodeCoreGate);
    entityMenus = [];
    inputOptions = [];
    saveArgs = [];
    confirmMenus = [];
    remembered = [];
    channelLines = [];
  });

  afterEach(() => {
    setKodeCoreShadowGate(null);
    vi.clearAllMocks();
  });

  const makeUxDeps = (opts: {
    lastExport?: {
      entityName: string;
      dbid: string;
      savePath: string;
      encrypt: boolean;
    } | null;
    confirmQueue?: string[];
    savePath?: string;
  } = {}): PlayerCloneCommandDeps => {
    const confirmQueue = opts.confirmQueue ?? ['Export,Encrypted (local key)'];
    return {
      profiles: {
        resolveConnection: async () => ({ host: '127.0.0.1', port: 3306, user: 'root' })
      } as unknown as CloneProfileStore,
      listEntityNames: () => ['Avatar', 'NPC'],
      resolveEntityTables: () => [{ name: 'tbl_Avatar' }],
      showQuickPick: async (items, options) => {
        if (options.placeHolder.includes('Select the entity to export')) {
          entityMenus.push({ items, placeHolder: options.placeHolder });
          return items[0];
        }
        confirmMenus.push({ items, placeHolder: options.placeHolder });
        return confirmQueue.shift() ?? 'Cancel';
      },
      showInputBox: async options => {
        inputOptions.push(options);
        return '7';
      },
      showInformationMessage: async () => undefined,
      showWarningMessage: async () => undefined,
      showErrorMessage: async () => undefined,
      withProgress: (_options, task) => task({ isCancellationRequested: false }),
      pickArchiveSavePath: async (defaultName, defaultDir) => {
        saveArgs.push({ defaultName, defaultDir });
        return opts.savePath ?? '/tmp/out.kdpclone';
      },
      pickArchiveOpenPath: async () => undefined,
      writeAuditFile: async () => '/tmp/audit.json',
      listAuditFiles: () => [],
      readAuditFile: async () => null,
      getKeyRoot: () => '/keys',
      getLastExportSelection: () => opts.lastExport ?? null,
      rememberExportSelection: selection => {
        remembered.push(selection);
      },
      channel: {
        appendLine: line => {
          channelLines.push(line);
        },
        show: () => undefined
      },
      now: () => 0
    };
  };

  it('上次值预填:实体置顶带 last 提示,DBID/保存目录/加密位回落上次选择,成功后落记忆', async () => {
    const deps = makeUxDeps({
      lastExport: {
        entityName: 'Avatar',
        dbid: '42',
        savePath: '/data/out/Avatar-42.kdpclone',
        encrypt: false
      },
      confirmQueue: ['Export,Plaintext (portable)'],
      savePath: '/data/out/Avatar-7.kdpclone'
    });
    await runExportCloneCommand(deps);
    expect(entityMenus[0].items[0]).toBe('Avatar');
    expect(entityMenus[0].placeHolder).toContain('(last: Avatar)');
    expect(inputOptions[0].value).toBe('42');
    expect(saveArgs[0].defaultDir).toBe('/data/out');
    expect(confirmMenus[0].items[0]).toBe('Export,Plaintext (portable)');
    expect(remembered).toEqual([
      { entityName: 'Avatar', dbid: '7', savePath: '/data/out/Avatar-7.kdpclone', encrypt: false }
    ]);
  });

  it('首次导出无历史值行为不变:原序/无提示/无预填/设置默认加密位', async () => {
    const deps = makeUxDeps({ lastExport: null });
    await runExportCloneCommand(deps);
    expect(entityMenus[0].items).toEqual(['Avatar', 'NPC']);
    expect(entityMenus[0].placeHolder).toBe('Select the entity to export');
    expect(inputOptions[0].value).toBeUndefined();
    expect(saveArgs[0].defaultDir).toBeUndefined();
    expect(confirmMenus[0].items[0]).toBe('Export,Encrypted (local key)');
    expect(remembered).toHaveLength(1);
  });

  it('计划预览摘要并入加密确认占位文案,OUTPUT 留档仍在', async () => {
    const deps = makeUxDeps({ lastExport: null, confirmQueue: ['Cancel'] });
    await runExportCloneCommand(deps);
    const confirm = confirmMenus[0];
    expect(confirm.placeHolder).toContain('Export 1 read-only query results to the archive?');
    expect(confirm.placeHolder).toContain('Tables: tbl_Avatar');
    expect(confirm.placeHolder).toContain('Row budget: 1000');
    const trail = channelLines.join('\n');
    expect(trail).toContain('[Player Clone Export] Avatar DBID=7');
    expect(trail).toContain('Tables: tbl_Avatar');
    expect(trail).toContain('This is a persisted copy of the database, not the live online state.');
  });

  it('计划含 missing 表时,确认占位与 OUTPUT 都带 missing 摘要', async () => {
    const missingGate = {
      runInRust: async (method: string) =>
        method === '$/kode/dbClone/planExport'
          ? { ok: true, result: { ...plan, missing: ['tbl_legacy'] } }
          : { ok: false, reason: `unexpected method ${method}` }
    } as unknown as KodeCoreGate;
    setKodeCoreShadowGate(missingGate);
    const deps = makeUxDeps({ lastExport: null, confirmQueue: ['Cancel'] });
    await runExportCloneCommand(deps);
    expect(confirmMenus[0].placeHolder).toContain('Missing in source: tbl_legacy');
    expect(channelLines.join('\n')).toContain('Missing in source: tbl_legacy');
  });
});
