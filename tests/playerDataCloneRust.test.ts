import { afterEach, describe, expect, it } from 'vitest';
import {
  inspectCloneArchive,
  planCloneExport,
  planCloneImport,
  readCloneArchiveRows,
  writeCloneArchive
} from '../src/playerDataCloneRust';
import { setKodeCoreShadowGate, type KodeCoreGate } from '../src/kodeCoreShadowFaces';
import {
  tvBigUInt,
  tvText,
  type QueryPlanWire,
  type TargetSnapshotWire
} from '../src/playerDataCloneWire';

// PDC-0607 §2.2 缺口的接线(归档加密):TS 桥只传 keyRoot(密钥存储根目录
// 路径),密钥材料全程留 Rust。本文件锁「载荷契约」——export 恒带
// redactSensitive:true + keyRoot;读面(inspect/readRows/planImport)同传
// keyRoot;keyRoot 缺省时载荷不带该字段(旧装配向后兼容)。加密本身的
// 行为证明在 Rust 侧 db_clone.rs(加密落盘/缺钥如实报/结构性拒绝)。

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

const archiveMeta = {
  entity: 'Avatar',
  total_rows: 1,
  tables: [{ name: 'tbl_Avatar', rows: 1 }],
  encrypted: true,
  format: 'kdpclone',
  checksum: 'deadbeef'
};

const importPlan = {
  entity_name: 'Avatar',
  order: ['tbl_Avatar'],
  statements: [
    { table: 'tbl_Avatar', columns: ['id'], cells: [], insert_sql: 'INSERT' }
  ],
  summary: {}
};

const target = {
  environment: 'local',
  dbInterface: 'mysql',
  writable: true,
  host: '127.0.0.1',
  port: 3306,
  database: 'kbe_local'
};

const snapshot: TargetSnapshotWire = { uniqueKeys: [], existingValues: [] };

describe('playerDataCloneRust(归档加密 keyRoot 载荷契约)', () => {
  it('export 载荷恒带 redactSensitive:true + keyRoot(加密导出契约)', async () => {
    let calledMethod = '';
    let calledParams: Record<string, unknown> | null = null;
    const fakeGate = {
      runInRust: async (method: string, params: unknown) => {
        calledMethod = method;
        calledParams = params as Record<string, unknown>;
        return { ok: true, result: { entity: 'Avatar', total_rows: 1, tables: [] } };
      }
    } as unknown as KodeCoreGate;
    setKodeCoreShadowGate(fakeGate);
    try {
      const call = await writeCloneArchive(
        '/tmp/avatar.kdpclone',
        'Avatar',
        [{ table: 'tbl_Avatar', values: [tvBigUInt(7), tvText('hero')] }],
        plan,
        '/globalStorage/clone-keys'
      );
      expect(call.status).toBe('ok');
      expect(calledMethod).toBe('$/kode/dbClone/export');
      expect(calledParams?.redactSensitive).toBe(true);
      expect(calledParams?.keyRoot).toBe('/globalStorage/clone-keys');
    } finally {
      setKodeCoreShadowGate(null);
    }
  });

  it('读面(inspect/readRows/planImport)载荷同传 keyRoot', async () => {
    const seen: Array<{ method: string; keyRoot: unknown }> = [];
    const fakeGate = {
      runInRust: async (method: string, params: unknown) => {
        const record = params as Record<string, unknown>;
        seen.push({ method, keyRoot: record.keyRoot });
        if (method === '$/kode/dbClone/inspectArchive') {
          return { ok: true, result: archiveMeta };
        }
        if (method === '$/kode/dbClone/readArchiveRows') {
          return {
            ok: true,
            result: { tables: [{ name: 'tbl_Avatar', rows: [] }] }
          };
        }
        return { ok: true, result: importPlan };
      }
    } as unknown as KodeCoreGate;
    setKodeCoreShadowGate(fakeGate);
    try {
      const inspected = await inspectCloneArchive('/tmp/a.kdpclone', '/keys');
      expect(inspected.status).toBe('ok');
      const rows = await readCloneArchiveRows('/tmp/a.kdpclone', '/keys');
      expect(rows.status).toBe('ok');
      const planned = await planCloneImport(
        '/tmp/a.kdpclone',
        target,
        { tables: [] },
        [],
        snapshot,
        '/keys'
      );
      expect(planned.status).toBe('ok');
      expect(seen.map(s => s.method)).toEqual([
        '$/kode/dbClone/inspectArchive',
        '$/kode/dbClone/readArchiveRows',
        '$/kode/dbClone/planImport'
      ]);
      expect(seen.every(s => s.keyRoot === '/keys')).toBe(true);
    } finally {
      setKodeCoreShadowGate(null);
    }
  });

  it('keyRoot 缺省:载荷不带该字段(旧装配向后兼容,归档写明文)', async () => {
    let exportParams: Record<string, unknown> | null = null;
    let inspectParams: Record<string, unknown> | null = null;
    const fakeGate = {
      runInRust: async (_method: string, params: unknown) => {
        const record = params as Record<string, unknown>;
        if (_method === '$/kode/dbClone/export') {
          exportParams = record;
          return { ok: true, result: { entity: 'Avatar', total_rows: 0, tables: [] } };
        }
        inspectParams = record;
        return { ok: true, result: archiveMeta };
      }
    } as unknown as KodeCoreGate;
    setKodeCoreShadowGate(fakeGate);
    try {
      const call = await writeCloneArchive('/tmp/a.kdpclone', 'Avatar', [], plan);
      expect(call.status).toBe('ok');
      // keyRoot 缺省=undefined;序列化面(runInRust 经 JSON 过线)undefined
      // 字段即不传——Rust 侧 #[serde(default)] Option 接 None → 明文归档
      // (向后兼容)。
      expect(exportParams?.keyRoot).toBeUndefined();

      const inspected = await inspectCloneArchive('/tmp/a.kdpclone');
      expect(inspected.status).toBe('ok');
      expect(inspectParams?.keyRoot).toBeUndefined();
    } finally {
      setKodeCoreShadowGate(null);
    }
  });

describe('playerDataCloneRust 缺口臂(no-gate/ok:false/形状不合规)', () => {
  afterEach(() => {
    setKodeCoreShadowGate(null);
  });

  it('无 gate:五面如实 no-gate(不假装算了)', async () => {
    setKodeCoreShadowGate(null);
    await expect(inspectCloneArchive('/a.kdpclone')).resolves.toEqual({ status: 'no-gate' });
    await expect(readCloneArchiveRows('/a.kdpclone')).resolves.toEqual({ status: 'no-gate' });
    await expect(planCloneExport({}, [])).resolves.toEqual({ status: 'no-gate' });
    await expect(writeCloneArchive('/a.kdpclone', 'Avatar', [], plan)).resolves.toEqual({ status: 'no-gate' });
    await expect(planCloneImport('/a.kdpclone', target, {}, [], snapshot)).resolves.toEqual({ status: 'no-gate' });
  });

  it('桥 ok:false:各面如实 error 携原因(不猜字段)', async () => {
    setKodeCoreShadowGate({
      runInRust: async () => ({ ok: false, reason: 'backend gone' })
    });
    const inspect = await inspectCloneArchive('/a.kdpclone');
    expect(inspect).toEqual({ status: 'error', reason: 'backend gone' });
    const rows = await readCloneArchiveRows('/a.kdpclone');
    expect(rows).toEqual({ status: 'error', reason: 'backend gone' });
    const exported = await writeCloneArchive('/a.kdpclone', 'Avatar', [], plan);
    expect(exported).toEqual({ status: 'error', reason: 'backend gone' });
    const plannedExport = await planCloneExport({}, []);
    expect(plannedExport).toEqual({ status: 'error', reason: 'backend gone' });
  });

  it('形状不合规:toCall guard(inspect/planExport/planImport)与手写 guard(readRows/export)', async () => {
    setKodeCoreShadowGate({
      runInRust: async () => ({ ok: true, result: { junk: true } })
    });
    const inspect = await inspectCloneArchive('/a.kdpclone');
    expect(inspect.status).toBe('error');
    if (inspect.status === 'error') {
      expect(inspect.reason).toContain('inspectArchive: unexpected result shape');
    }
    const plannedExport = await planCloneExport({}, []);
    expect(plannedExport.status).toBe('error');
    if (plannedExport.status === 'error') {
      expect(plannedExport.reason).toContain('planExport: unexpected result shape');
    }
    const plannedImport = await planCloneImport('/a.kdpclone', target, {}, [], snapshot);
    expect(plannedImport.status).toBe('error');
    if (plannedImport.status === 'error') {
      expect(plannedImport.reason).toContain('planImport: unexpected result shape');
    }
    const rows = await readCloneArchiveRows('/a.kdpclone');
    expect(rows.status).toBe('error');
    if (rows.status === 'error') {
      expect(rows.reason).toContain('readArchiveRows: unexpected result shape');
    }
    const exported = await writeCloneArchive('/a.kdpclone', 'Avatar', [], plan);
    expect(exported.status).toBe('error');
    if (exported.status === 'error') {
      expect(exported.reason).toContain('export: unexpected result shape');
    }
  });
});

});
