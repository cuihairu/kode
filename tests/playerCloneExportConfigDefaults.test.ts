// UX-2026-11-23 用户令:导出三处弹窗「从配置读取」——kbengine.clone.defaultEntity /
// defaultDbId 生效值内联展示,加密确认页展示 archiveEncryption 生效值。
// 覆盖:实体弹窗配置项(值内联/选中生效/不在清单不猜/空配置零变化/与 last 去重)、
// DBID 提示行与预填(配置值展示/优先级 last>config/空配置零变化)、
// 加密确认页占位文案展示配置生效值。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  executeExportPlan,
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

interface EntityPickArgs {
  items: readonly string[];
  placeHolder: string;
}

interface InputArgs {
  prompt: string;
  value?: string;
}

interface MenuArgs {
  items: readonly string[];
  placeHolder: string;
}

/**
 * 装配 deps。pickArchiveSavePath 可给 undefined 令流程在保存路径处停住
 * (实体/DBID 断言用);给路径则走完整导出链到加密确认页(加密断言用)。
 * entityPick 定制实体弹窗返回(默认返回首项,验证配置项被选中时用)。
 */
function makeDeps(opts: {
  configDefaults?: { defaultEntity?: string; defaultDbId?: string };
  lastExport?: { entityName: string; dbid: string; savePath: string; encrypt: boolean } | null;
  entityNames?: string[];
  savePath?: string;
  encryptionDefault?: 'encrypted' | 'plain';
  menus?: MenuArgs[];
  entityPick?: (items: readonly string[]) => string | undefined;
}): { deps: PlayerCloneCommandDeps; entityPicks: EntityPickArgs[]; inputs: InputArgs[] } {
  const entityPicks: EntityPickArgs[] = [];
  const inputs: InputArgs[] = [];
  const deps = {
    profiles: {
      resolveConnection: async () => ({ host: '127.0.0.1', port: 3306, user: 'root' })
    } as unknown as CloneProfileStore,
    listEntityNames: () => opts.entityNames ?? ['Avatar'],
    resolveEntityTables: vi.fn(() => [{ name: 'tbl_Avatar' }]),
    showQuickPick: async (items: readonly string[], options: { placeHolder: string }) => {
      if (options.placeHolder.includes('Select the entity to export')) {
        entityPicks.push({ items, placeHolder: options.placeHolder });
        return opts.entityPick ? opts.entityPick(items) : items[0];
      }
      if (options.placeHolder.includes('Select the export source connection')) {
        return items[0];
      }
      // 加密确认菜单
      opts.menus?.push({ items, placeHolder: options.placeHolder });
      return items[0];
    },
    showInputBox: async (options: { prompt: string; value?: string }) => {
      inputs.push(options);
      return '7';
    },
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    withProgress: (_options: unknown, task: (token: unknown) => Promise<unknown>) =>
      task({ isCancellationRequested: false }),
    pickArchiveSavePath: async () => opts.savePath,
    pickArchiveOpenPath: async () => undefined,
    writeAuditFile: async () => '/tmp/audit.json',
    listAuditFiles: () => [],
    readAuditFile: async () => null,
    getKeyRoot: () => '/keys',
    ...(opts.encryptionDefault ? { getArchiveEncryptionDefault: () => opts.encryptionDefault } : {}),
    ...(opts.configDefaults ? { getCloneExportConfigDefaults: () => opts.configDefaults } : {}),
    ...(opts.lastExport !== undefined ? { getLastExportSelection: () => opts.lastExport } : {}),
    channel: { appendLine: () => undefined, show: () => undefined },
    now: () => 0
  } as unknown as PlayerCloneCommandDeps;
  return { deps, entityPicks, inputs };
}

describe('runExportCloneCommand 实体弹窗「从配置读取」', () => {
  it('配置实体在清单内 → 首项内联展示值,选中即用配置实体(非展示串)', async () => {
    const { deps, entityPicks } = makeDeps({
      configDefaults: { defaultEntity: 'Guard' },
      entityNames: ['Avatar', 'Guard']
    });
    await runExportCloneCommand(deps);
    expect(entityPicks).toHaveLength(1);
    expect(entityPicks[0].items[0]).toBe('From config: Guard');
    expect(entityPicks[0].items).toContain('Avatar');
    expect(entityPicks[0].items).toContain('Guard');
    // 默认返回首项 = 配置项;真实命令层必须解析回 'Guard'(不拿展示串当实体名)。
    expect(deps.resolveEntityTables).toHaveBeenCalledWith('Guard');
  });

  it('配置实体不在清单 → 不出配置项(不猜实体名)', async () => {
    const { deps, entityPicks } = makeDeps({
      configDefaults: { defaultEntity: 'NoSuchEntity' },
      entityNames: ['Avatar']
    });
    await runExportCloneCommand(deps);
    expect(entityPicks[0].items).toEqual(['Avatar']);
    expect(entityPicks[0].items.some(i => i.startsWith('From config:'))).toBe(false);
  });

  it('空配置(未注入)→ 列表与旧版一致,零配置项', async () => {
    const { deps, entityPicks } = makeDeps({ entityNames: ['Avatar', 'Guard'] });
    await runExportCloneCommand(deps);
    expect(entityPicks[0].items).toEqual(['Avatar', 'Guard']);
  });

  it('配置实体与上次成功导出同实体 → 不重复出配置项(last 置顶已示值)', async () => {
    const { deps, entityPicks } = makeDeps({
      configDefaults: { defaultEntity: 'Avatar' },
      lastExport: { entityName: 'Avatar', dbid: '7', savePath: '/tmp/a.kdpclone', encrypt: true },
      entityNames: ['Avatar', 'Guard']
    });
    await runExportCloneCommand(deps);
    expect(entityPicks[0].items[0]).toBe('Avatar');
    expect(entityPicks[0].items.some(i => i.startsWith('From config:'))).toBe(false);
  });

  it('选配置项回车 → 不经过推导失败告警(实体名有效)', async () => {
    const { deps, entityPicks } = makeDeps({
      configDefaults: { defaultEntity: 'Guard' },
      entityNames: ['Avatar', 'Guard']
    });
    const resolved: string[] = [];
    (deps.resolveEntityTables as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
      resolved.push(name);
      return [{ name: `tbl_${name}` }];
    });
    await runExportCloneCommand(deps);
    expect(entityPicks).toHaveLength(1);
    expect(resolved).toEqual(['Guard']);
  });
});

describe('runExportCloneCommand DBID 输入框「从配置读取」', () => {
  it('配置 DBID → 提示行展示值 + 预填配置值(无历史)', async () => {
    const { deps, inputs } = makeDeps({ configDefaults: { defaultDbId: '4242' } });
    await runExportCloneCommand(deps);
    expect(inputs).toHaveLength(1);
    expect(inputs[0].prompt).toContain('config default: 4242');
    expect(inputs[0].value).toBe('4242');
  });

  it('历史与配置同在 → 预填历史,提示行仍展示配置值', async () => {
    const { deps, inputs } = makeDeps({
      configDefaults: { defaultDbId: '4242' },
      lastExport: { entityName: 'Avatar', dbid: '999', savePath: '/tmp/a.kdpclone', encrypt: true }
    });
    await runExportCloneCommand(deps);
    expect(inputs[0].value).toBe('999');
    expect(inputs[0].prompt).toContain('config default: 4242');
  });

  it('空配置(未注入)→ 提示行与预填与旧版一致', async () => {
    const { deps, inputs } = makeDeps({});
    await runExportCloneCommand(deps);
    expect(inputs[0].prompt).toBe('Root-table DBID (the entity primary key id)');
    expect(inputs[0].value).toBeUndefined();
  });
});

describe('runExportCloneCommand 加密确认页「展示配置的值」', () => {
  let gate: KodeCoreGate;
  beforeEach(() => {
    vi.mocked(openCloneSession).mockResolvedValue({ end: async () => undefined } as never);
    vi.mocked(probePhysicalTables).mockResolvedValue([{ name: 'tbl_Avatar' }] as never);
    vi.mocked(executeExportPlan).mockResolvedValue(rows);
    gate = {
      runInRust: async (method: string) => {
        if (method === '$/kode/dbClone/planExport') {
          return { ok: true, result: plan };
        }
        if (method === '$/kode/dbClone/export') {
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

  it('默认 encrypted → 确认页占位文案展示配置生效值', async () => {
    const menus: MenuArgs[] = [];
    const { deps } = makeDeps({ savePath: '/tmp/out.kdpclone', menus });
    await runExportCloneCommand(deps);
    expect(menus).toHaveLength(1);
    expect(menus[0].placeHolder).toContain(
      'Archive encryption default (kbengine.clone.archiveEncryption): encrypted'
    );
  });

  it('设置默认 plain → 占位文案展示 plain', async () => {
    const menus: MenuArgs[] = [];
    const { deps } = makeDeps({ savePath: '/tmp/out.kdpclone', menus, encryptionDefault: 'plain' });
    await runExportCloneCommand(deps);
    expect(menus[0].placeHolder).toContain(
      'Archive encryption default (kbengine.clone.archiveEncryption): plain'
    );
  });
});
