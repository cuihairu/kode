import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runImportCloneCommand, type PlayerCloneCommandDeps } from '../src/backend/playerDataCloneCommands';
import { applyImportPlan, CloneCommitUnknownError, ClonePostCommitError, openCloneSession } from '../src/backend/playerDataCloneMysql';
import { fingerprintCloneArchive, reserveCloneImport } from '../src/backend/playerDataCloneImportGuard';
import type { CloneProfileStore } from '../src/backend/playerDataCloneProfiles';

vi.mock('../src/backend/playerDataCloneMysql', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/backend/playerDataCloneMysql')>()),
  openCloneSession: vi.fn(), probePhysicalTables: vi.fn(async () => []),
  applyImportPlan: vi.fn(), columnOrderFromPlan: vi.fn(() => new Map()),
  uniqueValuesFromRows: vi.fn(() => [])
}));
vi.mock('../src/backend/playerDataCloneRust', () => ({
  inspectCloneArchive: vi.fn(async () => ({ status: 'ok', result: { entity: 'Avatar' } })),
  readCloneArchiveRows: vi.fn(async () => ({ status: 'ok', result: { tables: [] } })),
  planCloneImport: vi.fn(async () => ({ status: 'ok', result: {
    entity_name: 'Avatar', mode: 'allocate', autoload_policy: 'disabled', order: [], statements: [],
    summary: { statements_per_table: {}, id_categories: {}, unique_conflicts: 0, unresolved_reference_risks: 0 },
    account_binding: { note: 'none' }, warnings: []
  } }))
}));
vi.mock('../src/backend/playerDataCloneImportGuard', () => ({
  fingerprintCloneArchive: vi.fn(async () => 'f'.repeat(64)),
  reserveCloneImport: vi.fn(async () => ({ duplicate: false, reservation: '/tmp/reservation' }))
}));

function makeDeps(errors: string[]): PlayerCloneCommandDeps {
  return {
    profiles: { resolveConnection: async () => ({ host: '127.0.0.1', port: 3306, database: 'test', user: 'root', environment: 'local' }) } as unknown as CloneProfileStore,
    listEntityNames: () => [], resolveEntityTables: () => [{ name: 'tbl_Avatar' }],
    showQuickPick: async items => items[0], showInputBox: async () => undefined,
    showInformationMessage: async () => undefined, showWarningMessage: async () => undefined,
    showErrorMessage: async message => { errors.push(message); },
    withProgress: async (_options, task) => task({ isCancellationRequested: false }),
    pickArchiveSavePath: async () => undefined, pickArchiveOpenPath: async () => undefined,
    writeAuditFile: async () => { throw new Error('audit unavailable'); },
    listAuditFiles: async () => [], readAuditFile: async () => null,
    getKeyRoot: () => '/keys', channel: { appendLine: () => undefined, show: () => undefined }, now: () => 1
  };
}

describe('clone import failure reporting', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(fingerprintCloneArchive).mockResolvedValue('f'.repeat(64));
    vi.mocked(reserveCloneImport).mockResolvedValue({ duplicate: false, reservation: '/tmp/reservation' });
    vi.mocked(openCloneSession)
      // 004c:探测会话建立后先跑真实 SELECT VERSION() 连接预检,fixtures 须带 query
      .mockResolvedValueOnce({ end: async () => undefined, query: async () => [[{ v: '8.0.36' }], []] } as never)
      .mockResolvedValueOnce({ end: async () => { throw new Error('close failed'); }, query: async () => [[{ v: '8.0.36' }], []] } as never);
  });
  it('does not let a close failure hide an ambiguous COMMIT', async () => {
    const errors: string[] = [];
    vi.mocked(applyImportPlan).mockRejectedValue(new CloneCommitUnknownError('connection lost'));
    await runImportCloneCommand(makeDeps(errors), '/archive');
    expect(errors[0]).toContain('结果不确定');
    expect(errors[0]).not.toContain('已回滚');
  });
  it('reports committed when verification fails even if closing also fails', async () => {
    const errors: string[] = [];
    vi.mocked(applyImportPlan).mockRejectedValue(new ClonePostCommitError('verification failed'));
    await runImportCloneCommand(makeDeps(errors), '/archive');
    expect(errors[0]).toContain('已提交');
  });
  it('reports committed when audit writing fails', async () => {
    const errors: string[] = [];
    vi.mocked(applyImportPlan).mockResolvedValue({ verify: [], insertedPerTable: {}, resolvedIds: {}, newRootId: 1, cleanup: [] });
    await runImportCloneCommand(makeDeps(errors), '/archive');
    expect(errors[0]).toContain('已提交');
    expect(errors[0]).toContain('audit unavailable');
  });
  it('requires an explicit choice before repeating a reserved import', async () => {
    const errors: string[] = [];
    vi.mocked(reserveCloneImport).mockResolvedValue({ duplicate: true, reservation: '/tmp/reservation', prior: 'previous attempt' });
    await runImportCloneCommand(makeDeps(errors), '/archive');
    expect(applyImportPlan).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
  });
  it('allows a repeat only after the explicit create-another-copy choice', async () => {
    const errors: string[] = [];
    const deps = makeDeps(errors);
    deps.showQuickPick = async items => items.find(item => item.startsWith('明确另建副本')) ?? items[0];
    vi.mocked(reserveCloneImport).mockResolvedValue({ duplicate: true, reservation: '/tmp/reservation' });
    vi.mocked(applyImportPlan).mockResolvedValue({ verify: [], insertedPerTable: {}, resolvedIds: {}, newRootId: 1, cleanup: [] });
    await runImportCloneCommand(deps, '/archive');
    expect(applyImportPlan).toHaveBeenCalledTimes(1);
  });
});

describe('clone import preflight (UX-REVIEW-004c)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(fingerprintCloneArchive).mockResolvedValue('f'.repeat(64));
    vi.mocked(reserveCloneImport).mockResolvedValue({ duplicate: false, reservation: '/tmp/reservation' });
    vi.mocked(openCloneSession).mockReset();
  });

  it('Target 未配置 → 提供向导入口;拒绝动作则不进向导,取消向导则不收集后续信息', async () => {
    const errors: string[] = [];
    const deps = makeDeps(errors);
    const inputs: string[] = [];
    deps.showInputBox = async options => {
      inputs.push(options.prompt);
      return undefined; // 向导首步即取消:什么都不写
    };
    deps.profiles = {
      get: () => null,
      resolveConnection: async role => (role === 'target' ? undefined : { host: 'h', port: 3306, database: 'd', user: 'u', environment: 'local' })
    } as unknown as CloneProfileStore;
    // 默认 showWarningMessage 返回 undefined ≠ 动作 → 拒绝入口,不进向导
    await runImportCloneCommand(deps, '/archive');
    expect(inputs).toEqual([]);
    expect(openCloneSession).not.toHaveBeenCalled();
    expect(applyImportPlan).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
    // 接受「配置 Target 连接」动作 → 进入向导;首步取消 → 仍无会话/无写入
    const depsAccept = makeDeps(errors);
    depsAccept.profiles = deps.profiles;
    depsAccept.showInputBox = async options => {
      inputs.push(options.prompt);
      return undefined;
    };
    depsAccept.showWarningMessage = async () => '配置 Target 连接';
    await runImportCloneCommand(depsAccept, '/archive');
    expect(inputs.length).toBeGreaterThan(0); // 向导确实被拉起(004c 新行为)
    expect(openCloneSession).not.toHaveBeenCalled();
    expect(applyImportPlan).not.toHaveBeenCalled();
  });

  it('Target 环境非 local/test → 环境闸拒绝,不建连', async () => {
    const errors: string[] = [];
    const deps = makeDeps(errors);
    deps.profiles = {
      resolveConnection: async () => ({ host: 'h', port: 3306, database: 'd', user: 'u', environment: 'prod' })
    } as unknown as CloneProfileStore;
    await runImportCloneCommand(deps, '/archive');
    expect(errors[0]).toContain('Target 环境仅接受 local/test');
    expect(openCloneSession).not.toHaveBeenCalled();
    expect(applyImportPlan).not.toHaveBeenCalled();
  });

  it('探测会话连接失败 → 「目标连接失败:…(导入未开始)」,不登记防重', async () => {
    const errors: string[] = [];
    const deps = makeDeps(errors);
    vi.mocked(openCloneSession).mockResolvedValueOnce({
      end: async () => undefined,
      query: async () => { throw new Error('ECONNREFUSED'); }
    } as never);
    await runImportCloneCommand(deps, '/archive');
    expect(errors[0]).toContain('目标连接失败: ECONNREFUSED(导入未开始)');
    // 导入未开始:防重登记与写入面都不触达
    expect(reserveCloneImport).not.toHaveBeenCalled();
    expect(applyImportPlan).not.toHaveBeenCalled();
    // 探测会话仍被 finally 关闭
    expect(vi.mocked(openCloneSession)).toHaveBeenCalledTimes(1);
  });
});
