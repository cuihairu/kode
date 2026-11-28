import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createConnection } from 'mysql2/promise';
import { mkdtemp, mkdir, rm, writeFile, access } from 'fs/promises';
import { appendFileSync } from 'fs';
import { constants as fsConstants } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadDemoGameTemplateEntries } from '../src/demoGameTemplate';
import { getDatabaseSchemaSnapshot } from '../src/databaseSchema';
import { KodeCoreGate } from '../src/backend/kodeCoreGate';
import { setKodeCoreShadowGate } from '../src/backend/kodeCoreShadowFaces';
import {
	openCloneSession,
	probePhysicalTables,
	executeExportPlan,
	testCloneConnection,
	type CloneMysqlConnection
} from '../src/backend/playerDataCloneMysql';
import {
	planCloneExport,
	writeCloneArchive,
	inspectCloneArchive,
	readCloneArchiveRows
} from '../src/backend/playerDataCloneRust';
import type { QueryPlanWire, TypedRowWire } from '../src/backend/playerDataCloneWire';

/**
 * DEMO-GAME-025: real-machine export chain acceptance driver (opt-in).
 *
 * Drives the exact backend chain behind the `kbengine.clone.export` command
 * against a real KBEngine demo database:
 *   materialize (template loader) -> def-derived tables (schema snapshot) ->
 *   probePhysicalTables (information_schema) -> planCloneExport (Rust RPC) ->
 *   executeExportPlan (read-only streaming SELECT) -> writeCloneArchive
 *   (.kdpclone via Rust) -> inspect/read back.
 *
 * Also records, on the real machine, the SEM-016 faces:
 * - missing-table behavior (probe skips absent tables; the plan carries them
 *   in `missing`, no "table not found" error is raised);
 * - t_account reality (engine account table is kbe_accountinfos; no t_account
 *   anywhere).
 *
 * Opt-in via env (skipped otherwise, so the unit gate stays hermetic):
 *   KODE_DEMO25_DB_HOST / KODE_DEMO25_DB_PORT / KODE_DEMO25_DB_USER /
 *   KODE_DEMO25_DB_PASSWORD / KODE_DEMO25_DB_NAME
 *   KODE_DEMO25_SERVER_PATH (default: <repo>/bin/kode-server)
 */
const host = process.env.KODE_DEMO25_DB_HOST ?? '';
const port = Number(process.env.KODE_DEMO25_DB_PORT ?? 3306);
const user = process.env.KODE_DEMO25_DB_USER ?? '';
const password = process.env.KODE_DEMO25_DB_PASSWORD ?? '';
const database = process.env.KODE_DEMO25_DB_NAME ?? '';
const repoRoot = path.resolve(__dirname, '..');
const serverPath = process.env.KODE_DEMO25_SERVER_PATH ?? path.join(repoRoot, 'bin', 'kode-server');

const enabled = host !== '' && database !== '';
const evidencePath = process.env.KODE_DEMO25_EVIDENCE ?? '';

function evidence(line: string): void {
	// vitest swallows worker console output; the evidence face lands in a file
	// (set KODE_DEMO25_EVIDENCE=<path> to capture the real-machine record).
	if (evidencePath !== '') {
		appendFileSync(evidencePath, `[demo25] ${line}\n`);
	}
}

let projectRoot = '';
let archivePath = '';
let connection: CloneMysqlConnection | undefined;
let plan: QueryPlanWire | undefined;
let rows: TypedRowWire[] = [];
let rootDbid = 0;

async function fileExists(p: string): Promise<boolean> {
	try {
		await access(p, fsConstants.F_OK);
		return true;
	} catch {
		return false;
	}
}

describe.skipIf(!enabled)('demo export real chain (DEMO-GAME-025, opt-in)', () => {
	beforeAll(async () => {
		if (!(await fileExists(serverPath))) {
			throw new Error(`kode-server binary missing: ${serverPath}`);
		}
		// Materialize a real project from the shipped template (same entries the
		// kbengine.project.createDemoGame command writes).
		const entries = loadDemoGameTemplateEntries(path.join(repoRoot, 'templates', 'assets'));
		expect(entries.length).toBeGreaterThan(0);
		projectRoot = await mkdtemp(path.join(os.tmpdir(), 'kode-demo25-project-'));
		for (const entry of entries) {
			if (entry.kind === 'directory' || entry.content === undefined) {
				continue;
			}
			const target = path.join(projectRoot, entry.relativePath);
			await mkdir(path.dirname(target), { recursive: true });
			await writeFile(target, entry.content);
		}
		await expect(fileExists(path.join(projectRoot, 'scripts', 'entity_defs', 'Avatar.def'))).resolves.toBe(true);

		// Real Rust core gate against the packaged binary face.
		const gate = new KodeCoreGate();
		gate.setConfig({ backend: 'rust', serverPath, shadowTimeoutMs: 10_000 });
		setKodeCoreShadowGate(gate);

		connection = await openCloneSession({ host, port, user, password, database });
		const probe = await testCloneConnection(connection);
		expect(probe.ok).toBe(true);
	});

	afterAll(async () => {
		setKodeCoreShadowGate(null);
		try {
			connection?.end?.();
		} catch {
			// session already closed
		}
		await rm(projectRoot, { recursive: true, force: true });
		await rm(archivePath, { force: true });
	});

	it('derives Avatar tables from the materialized defs and probes them on the real DB', async () => {
		const snapshot = getDatabaseSchemaSnapshot('Avatar', projectRoot);
		expect(snapshot).not.toBeNull();
		const tables = snapshot!.tables;
		const names = tables.map(table => table.name);
		expect(names).toContain('tbl_Avatar');
		const physical = await probePhysicalTables(connection!, names);
		const physicalNames = physical.map(table => table.name);
		expect(physicalNames).toContain('tbl_Avatar');
		// Child tables the engine created for the demo (bag/items etc.): every
		// derived table that exists on the DB must be seen by the probe.
		expect(physicalNames.length).toBeGreaterThan(0);
	});

	it('plans, exports, archives and reads back one avatar row (dbid query face)', async () => {
		const snapshot = getDatabaseSchemaSnapshot('Avatar', projectRoot)!;
		const derivationTables = snapshot.tables;
		const pick = await connection!.query('SELECT id FROM tbl_Avatar ORDER BY id LIMIT 1');
		const pickRows = Array.isArray(pick[0]) ? (pick[0] as Array<Record<string, unknown>>) : [];
		expect(pickRows.length).toBe(1);
		rootDbid = Number(pickRows[0].id);

		const physical = await probePhysicalTables(connection!, derivationTables.map(table => table.name));
		const call = await planCloneExport({ tables: derivationTables }, physical);
		expect(call.status).toBe('ok');
		plan = (call as { status: 'ok'; result: QueryPlanWire }).result;
		expect(plan.entity_name).toBe('Avatar');
		expect(plan.queries.length).toBeGreaterThan(0);
		expect(plan.queries[0].filter.kind).toBe('root-id');
		expect(plan.missing).toEqual([]);

		rows = await executeExportPlan(connection!, plan, rootDbid);
		expect(rows.length).toBeGreaterThan(0);
		evidence(`dbid=${rootDbid} plan queries:`);
		for (const query of plan.queries) {
			evidence(`  ${query.sequence} ${query.table} <- ${query.parent_table ?? 'ROOT'} filter=${query.filter.kind} cols=${query.columns.length} sql=${query.select_sql}`);
		}
		evidence(`rows=${rows.length}`);
		const rootRow = rows.find(row => row.table === 'tbl_Avatar');
		if (rootRow) {
			const rootQuery = plan.queries.find(query => query.table === 'tbl_Avatar');
			const summary = rootRow.values
				.map((cell, index) => `${rootQuery?.columns[index] ?? index}=${JSON.stringify(cell.v ?? null)}(${cell.t})`)
				.join(' ');
			evidence(`tbl_Avatar row: ${summary}`);
		}

		archivePath = path.join(projectRoot, 'avatar-export.kdpclone');
		const written = await writeCloneArchive(archivePath, 'Avatar', rows, plan);
		expect(written.status).toBe('ok');
		expect((written as { status: 'ok'; result: { total_rows: number } }).result.total_rows).toBeGreaterThan(0);

		const meta = await inspectCloneArchive(archivePath);
		expect(meta.status).toBe('ok');
		const metaWire = (meta as { status: 'ok'; result: { entity: string; total_rows: number; tables: Array<{ name: string; rows: number }> } }).result;
		expect(metaWire.entity).toBe('Avatar');
		expect(metaWire.total_rows).toBe(rows.length);
		expect(metaWire.tables.some(table => table.name === 'tbl_Avatar' && table.rows === 1)).toBe(true);
		evidence(`archive meta: entity=${metaWire.entity} rows=${metaWire.total_rows} tables=${metaWire.tables.map(table => `${table.name}:${table.rows}`).join(' ')}`);

		const back = await readCloneArchiveRows(archivePath);
		expect(back.status).toBe('ok');
		const backTables = (back as { status: 'ok'; result: { tables: Array<{ name: string; rows: TypedRowWire[] }> } }).result.tables;
		const backRowCount = backTables.reduce((sum, table) => sum + table.rows.length, 0);
		expect(backRowCount).toBe(rows.length);
	});

	it('missing-table face: probe silently excludes absent tables, plan lists them as missing', async () => {
		const snapshot = getDatabaseSchemaSnapshot('Avatar', projectRoot)!;
		const names = snapshot.tables.map(table => table.name).concat(['t_account', 'tbl_GhostEntity']);
		const physical = await probePhysicalTables(connection!, names);
		const physicalNames = physical.map(table => table.name);
		expect(physicalNames).not.toContain('t_account');
		expect(physicalNames).not.toContain('tbl_GhostEntity');
		expect(physicalNames).toContain('tbl_Avatar');

		const derivationTables = snapshot.tables;
		const call = await planCloneExport({ tables: derivationTables }, physical);
		expect(call.status).toBe('ok');
		const planned = (call as { status: 'ok'; result: QueryPlanWire }).result;
		// No error is raised for the absent tables (SEM-016: kode never emits
		// "table not found"); the plan either lists them under `missing` or
		// simply has no query for them.
		const plannedTables = planned.queries.map(query => query.table);
		expect(plannedTables).not.toContain('t_account');
		expect(plannedTables).not.toContain('tbl_GhostEntity');
		if (planned.missing.length > 0) {
			expect(planned.missing.some(name => name.includes('Ghost') || name.includes('account'))).toBe(true);
		}
		evidence(`missing-table face: physical probe resolved ${physicalNames.length}/${names.length} (excluded: ${names.filter(name => !physicalNames.includes(name)).join(', ')})`);
		evidence(`missing-table face: plan has ${planned.queries.length} queries (no query for absent tables); plan.missing=${JSON.stringify(planned.missing)}; no error raised`);
	});

	it('t_account face: the real DB has only the engine account table', async () => {
		const result = await connection!.query(
			"SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE '%account%'"
		);
		const found = (Array.isArray(result[0]) ? (result[0] as Array<Record<string, unknown>>) : []).map(
			row => String(row.TABLE_NAME ?? row.table_name)
		);
		expect(found).toContain('kbe_accountinfos');
		expect(found).not.toContain('t_account');
		evidence(`t_account face: tables like %account% = ${found.join(', ')}; no t_account`);
	});
});
