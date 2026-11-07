import { describe, expect, it } from 'vitest';
import { createConnection } from 'mysql2/promise';
import { Readable } from 'stream';
import { mkdtemp, rm } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { KodeCoreClient } from '../src/kodeCoreClient';
import { cellToTypedValue, typedValueToBind } from '../src/playerDataCloneWire';
import { applyImportPlan, columnOrderFromPlan, executeExportPlan, openCloneSession, probePhysicalTables, type CloneMysqlConnection } from '../src/playerDataCloneMysql';
import type { ImportPlanWire, QueryPlanWire, TypedRowWire } from '../src/playerDataCloneWire';

const port = Number(process.env.KODE_CLONE_TEST_MYSQL_PORT ?? 0);
describe.skipIf(!port)('clone mysql real', () => {
  it('keeps a consistent snapshot and preserves 64-bit and binary values', async () => {
    const config = { host: '127.0.0.1', port, user: 'root', database: 'test' };
    const admin = await createConnection({ ...config, supportBigNumbers: true, bigNumberStrings: true });
    // Unique identifiers ensure this opt-in test never drops another test's tables.
    const suffix = `${process.pid}_${Date.now()}`;
    const parent = `clone_parent_${suffix}`;
    const child = `clone_child_${suffix}`;
    const targetDb = `clone_target_${suffix}`;
    let targetCreated = false;
    let targetSession: CloneMysqlConnection | undefined;
    const derivation = { tables: [
      { name: parent, kind: 'entity', propertyPath: 'Avatar', fields: [
        { name: 'id', typeLabel: 'bigint unsigned', synthetic: true },
        { name: 'payload', typeLabel: 'blob' }, { name: 'fixed_bytes', typeLabel: 'binary(3)' },
        { name: 'signed_value', typeLabel: 'bigint' }, { name: 'signed_max', typeLabel: 'bigint' },
        { name: 'unsigned_value', typeLabel: 'bigint unsigned' }, { name: 'empty_blob', typeLabel: 'blob' },
        { name: 'null_blob', typeLabel: 'blob' }, { name: 'var_bytes', typeLabel: 'varbinary(4)' }
      ] },
      { name: child, kind: 'array', parentTableName: parent, propertyPath: 'Avatar.items', fields: [
        { name: 'id', typeLabel: 'bigint unsigned', synthetic: true },
        { name: 'parentID', typeLabel: 'bigint unsigned', synthetic: true },
        { name: 'val', typeLabel: 'varchar(30)' }
      ] }
    ] };
    await admin.query(`CREATE TABLE ${parent} (id BIGINT UNSIGNED PRIMARY KEY, payload BLOB, fixed_bytes BINARY(3), signed_value BIGINT, signed_max BIGINT, unsigned_value BIGINT UNSIGNED, empty_blob BLOB, null_blob BLOB, var_bytes VARBINARY(4)) ENGINE=InnoDB`);
    await admin.query(`CREATE TABLE ${child} (id BIGINT UNSIGNED PRIMARY KEY, parentID BIGINT UNSIGNED, val VARCHAR(30)) ENGINE=InnoDB`);
    await admin.query(`INSERT INTO ${parent} VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, ['9007199254740993', Buffer.from([0, 255, 128]), Buffer.from([255, 0, 128]), '-9223372036854775808', '9223372036854775807', '18446744073709551615', Buffer.alloc(0), null, Buffer.from([0, 254])]);
    await admin.query(`INSERT INTO ${child} VALUES (?, ?, ?)`, ['18446744073709551615', '9007199254740993', 'before']);
    const reader = await openCloneSession(config);
    let updated = false;
    const connection: CloneMysqlConnection = {
      streamRows: (sql, values) => Readable.from((async function* () {
        for await (const row of reader.streamRows!(sql, values)) {
          yield row;
        }
        if (!updated && (sql.includes(`FROM ${parent}`) || sql.includes(`FROM \`${parent}\``))) {
          updated = true;
          await admin.query(`UPDATE ${child} SET val = 'after'`);
        }
      })()),
      query: async (sql, values) => {
        const result = await reader.query(sql, values);
        return result;
      },
      end: () => reader.end()
    };
    const server = process.env.KODE_CLONE_TEST_SERVER
      ? new KodeCoreClient({ binaryPath: process.env.KODE_CLONE_TEST_SERVER }) : undefined;
    const dir = server ? await mkdtemp(path.join(os.tmpdir(), 'kode-clone-rpc-')) : undefined;
    try {
      const fallback: QueryPlanWire = {
        entity_name: 'Avatar', row_budget: 10, denied: [], missing: [],
        queries: [
          { sequence: 0, table: parent, columns: ['id', 'payload', 'fixed_bytes', 'signed_value', 'signed_max', 'unsigned_value', 'empty_blob', 'null_blob'], column_types: ['bigint unsigned', 'blob', 'binary(3)', 'bigint', 'bigint', 'bigint unsigned', 'blob', 'blob'], select_sql: `SELECT id, payload, fixed_bytes, signed_value, signed_max, unsigned_value, empty_blob, null_blob FROM ${parent} WHERE id = ?`, filter: { kind: 'root-id' } },
          { sequence: 1, table: child, parent_table: parent, columns: ['id', 'parentID', 'val'], column_types: ['bigint unsigned', 'bigint unsigned', 'varchar'], select_sql: `SELECT id, parentID, val FROM ${child} WHERE parentID = ?`, filter: { kind: 'parent-id' } }
        ]
      };
      let plan = fallback;
      if (server) {
        await server.start();
        const physicalTables = await probePhysicalTables(reader, [parent, child]);
        plan = await server.request('$/kode/rpc', { method: '$/kode/dbClone/planExport', params: {
          derivation, physicalTables
        } }) as QueryPlanWire;
        expect(plan.queries[0].filter).toEqual({ kind: 'root-id' });
      }
      let rows = await executeExportPlan(connection, plan, BigInt('9007199254740993'));
      if (server && dir) {
        const archive = path.join(dir, 'player.kdpclone');
        await server.request('$/kode/rpc', { method: '$/kode/dbClone/export', params: {
          path: archive, entity: 'Avatar', rows, plan, redactSensitive: false
        } });
        const result = await server.request('$/kode/rpc', { method: '$/kode/dbClone/readArchiveRows', params: { path: archive } }) as { tables: Array<{ name: string; rows: TypedRowWire[] }> };
        rows = [parent, child].flatMap(table => result.tables.find(entry => entry.name === table)?.rows ?? []);
        await admin.query(`CREATE DATABASE ${targetDb}`);
        targetCreated = true;
        await admin.query(`CREATE TABLE ${targetDb}.${parent} (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, payload BLOB, fixed_bytes BINARY(3), signed_value BIGINT, signed_max BIGINT, unsigned_value BIGINT UNSIGNED, empty_blob BLOB, null_blob BLOB, var_bytes VARBINARY(4)) ENGINE=InnoDB AUTO_INCREMENT=9007199254740993`);
        await admin.query(`CREATE TABLE ${targetDb}.${child} (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, parentID BIGINT UNSIGNED, val VARCHAR(30)) ENGINE=InnoDB`);
        targetSession = await openCloneSession({ ...config, database: targetDb }, { readonly: false });
        const physicalTables = await probePhysicalTables(targetSession, [parent, child]);
        const importPlan = await server.request('$/kode/rpc', { method: '$/kode/dbClone/planImport', params: {
          path: archive, derivation, physicalTables,
          target: { environment: 'test', dbInterface: 'mysql', writable: true, host: config.host, port, database: targetDb },
          snapshot: { uniqueKeys: [], existingValues: [] }
        } }) as ImportPlanWire;
        const applied = await applyImportPlan(targetSession, importPlan,
          new Map(result.tables.map(entry => [entry.name, entry.rows])), columnOrderFromPlan(importPlan));
        expect(applied.newRootId).toBe('9007199254740993');
        const [imported] = await admin.query(`SELECT payload, fixed_bytes, signed_value, signed_max, unsigned_value, empty_blob, null_blob, var_bytes FROM ${targetDb}.${parent} WHERE id = ?`, [applied.newRootId]);
        const value = (imported as Array<{ payload: Buffer; fixed_bytes: Buffer; signed_value: string; signed_max: string; unsigned_value: string; empty_blob: Buffer; null_blob: null; var_bytes: Buffer }>)[0];
        expect(value.payload).toEqual(Buffer.from([0, 255, 128]));
        expect(value.fixed_bytes).toEqual(Buffer.from([255, 0, 128]));
        expect(value.signed_value).toBe('-9223372036854775808');
        expect(value.signed_max).toBe('9223372036854775807');
        expect(value.unsigned_value).toBe('18446744073709551615');
        expect(value.empty_blob).toEqual(Buffer.alloc(0));
        expect(value.null_blob).toBeNull();
        expect(value.var_bytes).toEqual(Buffer.from([0, 254]));
        const [children] = await admin.query(`SELECT parentID, val FROM ${targetDb}.${child}`);
        expect((children as Array<{ parentID: string; val: string }>)[0]).toMatchObject({ parentID: '9007199254740993', val: 'before' });
      }
      expect(rows[0].values[0]).toEqual({ t: 'big-u-int', v: '9007199254740993' });
      expect(rows[0].values[3]).toEqual({ t: 'int', v: '-9223372036854775808' });
      expect(rows[1].values[0]).toEqual({ t: 'big-u-int', v: '18446744073709551615' });
      expect(rows[1].values[2].v).toBe('before');
      await admin.query(`UPDATE ${parent} SET payload = ?, fixed_bytes = ?, signed_value = ? WHERE id = ?`, [typedValueToBind(rows[0].values[1]), typedValueToBind(rows[0].values[2]), typedValueToBind(rows[0].values[3]), '9007199254740993']);
      const [read] = await admin.query(`SELECT payload, fixed_bytes, signed_value FROM ${parent} WHERE id = ?`, ['9007199254740993']);
      expect(cellToTypedValue((read as Array<{payload: Buffer}>)[0].payload, 'blob')).toEqual(rows[0].values[1]);
      expect(cellToTypedValue((read as Array<{fixed_bytes: Buffer}>)[0].fixed_bytes, 'binary(3)')).toEqual(rows[0].values[2]);
      expect(cellToTypedValue((read as Array<{signed_value: string}>)[0].signed_value, 'bigint')).toEqual(rows[0].values[3]);
      const budgetReader = await openCloneSession(config);
      await expect(executeExportPlan(budgetReader, {
        entity_name: 'Avatar', row_budget: 10, denied: [], missing: [],
        queries: [{ sequence: 0, table: parent, columns: ['id', 'payload'], column_types: ['bigint unsigned', 'blob'], select_sql: `SELECT id, payload FROM ${parent} WHERE id = ?`, filter: { kind: 'root-id' } }]
      }, BigInt('9007199254740993'), { maxBytes: 5 })).rejects.toThrow(/byte budget/);
    } finally {
      if (server) { await server.dispose(); }
      if (dir) { await rm(dir, { recursive: true, force: true }); }
      if (targetSession) { await targetSession.end(); }
      if (targetCreated) { await admin.query(`DROP DATABASE ${targetDb}`); }
      await reader.end();
      await admin.query(`DROP TABLE IF EXISTS ${child}, ${parent}`);
      await admin.end();
    }
  }, 30_000);
});
