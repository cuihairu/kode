import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runImportCloneCommand, type PlayerCloneCommandDeps } from '../src/playerDataCloneCommands';
import { applyImportPlan, CloneCommitUnknownError, ClonePostCommitError, openCloneSession } from '../src/playerDataCloneMysql';
import type { CloneProfileStore } from '../src/playerDataCloneProfiles';

vi.mock('../src/playerDataCloneMysql', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/playerDataCloneMysql')>()),
  openCloneSession: vi.fn(), probePhysicalTables: vi.fn(async () => []),
  applyImportPlan: vi.fn(), columnOrderFromPlan: vi.fn(() => new Map()),
  uniqueValuesFromRows: vi.fn(() => [])
}));
vi.mock('../src/playerDataCloneRust', () => ({
  inspectCloneArchive: vi.fn(async () => ({ status: 'ok', result: { entity: 'Avatar' } })),
  readCloneArchiveRows: vi.fn(async () => ({ status: 'ok', result: { tables: [] } })),
  planCloneImport: vi.fn(async () => ({ status: 'ok', result: {
    entity_name: 'Avatar', mode: 'allocate', autoload_policy: 'disabled', order: [], statements: [],
    summary: { statements_per_table: {}, id_categories: {}, unique_conflicts: 0, unresolved_reference_risks: 0 },
    account_binding: { note: 'none' }, warnings: []
  } }))
}));
vi.mock('../src/playerDataCloneImportGuard', () => ({
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
    vi.mocked(openCloneSession)
      .mockResolvedValueOnce({ end: async () => undefined } as never)
      .mockResolvedValueOnce({ end: async () => { throw new Error('close failed'); } } as never);
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
});
