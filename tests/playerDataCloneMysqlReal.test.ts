import { describe, expect, it } from 'vitest';
import { createConnection } from 'mysql2/promise';
import { cellToTypedValue, typedValueToBind } from '../src/playerDataCloneWire';
import { executeExportPlan, openCloneSession, type CloneMysqlConnection } from '../src/playerDataCloneMysql';

const port = Number(process.env.KODE_CLONE_TEST_MYSQL_PORT ?? 0);
describe.skipIf(!port)('clone mysql real', () => {
  it('keeps a consistent snapshot and preserves 64-bit and binary values', async () => {
    const config = { host: '127.0.0.1', port, user: 'root', database: 'test' };
    const admin = await createConnection(config);
    // Unique identifiers ensure this opt-in test never drops another test's tables.
    const suffix = `${process.pid}_${Date.now()}`;
    const parent = `clone_parent_${suffix}`;
    const child = `clone_child_${suffix}`;
    await admin.query(`CREATE TABLE ${parent} (id BIGINT UNSIGNED PRIMARY KEY, payload BLOB) ENGINE=InnoDB`);
    await admin.query(`CREATE TABLE ${child} (id BIGINT UNSIGNED PRIMARY KEY, parentID BIGINT UNSIGNED, val VARCHAR(30)) ENGINE=InnoDB`);
    await admin.query(`INSERT INTO ${parent} VALUES (?, ?)`, ['9007199254740993', Buffer.from([0, 255, 128])]);
    await admin.query(`INSERT INTO ${child} VALUES (?, ?, ?)`, ['18446744073709551615', '9007199254740993', 'before']);
    const reader = await openCloneSession(config);
    let updated = false;
    const connection: CloneMysqlConnection = {
      query: async (sql, values) => {
        const result = await reader.query(sql, values);
        if (!updated && sql.includes(`FROM ${parent}`)) {
          updated = true;
          await admin.query(`UPDATE ${child} SET val = 'after'`);
        }
        return result;
      },
      end: () => reader.end()
    };
    try {
      const rows = await executeExportPlan(connection, {
        entity_name: 'Avatar', row_budget: 10, denied: [], missing: [],
        queries: [
          { sequence: 0, table: parent, columns: ['id', 'payload'], column_types: ['bigint unsigned', 'blob'], select_sql: `SELECT id, payload FROM ${parent} WHERE id = ?`, filter: 'root-id' },
          { sequence: 1, table: 'clone_child', parent_table: parent, columns: ['id', 'parentID', 'val'], column_types: ['bigint unsigned', 'bigint unsigned', 'varchar'], select_sql: `SELECT id, parentID, val FROM ${child} WHERE parentID = ?`, filter: 'parent-id' }
        ]
      }, BigInt('9007199254740993'));
      expect(rows[0].values[0]).toEqual({ t: 'big-u-int', v: '9007199254740993' });
      expect(rows[1].values[0]).toEqual({ t: 'big-u-int', v: '18446744073709551615' });
      expect(rows[1].values[2].v).toBe('before');
      await admin.query(`UPDATE ${parent} SET payload = ? WHERE id = ?`, [typedValueToBind(rows[0].values[1]), '9007199254740993']);
      const [read] = await admin.query(`SELECT payload FROM ${parent} WHERE id = ?`, ['9007199254740993']);
      expect(cellToTypedValue((read as Array<{payload: Buffer}>)[0].payload, 'blob')).toEqual(rows[0].values[1]);
    } finally {
      await reader.end();
      await admin.query(`DROP TABLE IF EXISTS ${child}, ${parent}`);
      await admin.end();
    }
  }, 30_000);
});
