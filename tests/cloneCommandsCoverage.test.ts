// Player Data Clone 命令编排覆盖(测试新文件,不动既有用例):
// Rust 桥接面(playerDataCloneRust)在 RPC 边界 mock;mysql 会话只 mock
// openCloneSession(其余 probe/execute/apply 走真实实现 + 记录型假连接);
// 导入防重_reservation(fingerprintCloneArchive/reserveCloneImport)走真实现,
// 以临时目录落盘验证「先持久化后写入」与重复导入 fail-closed。
//
// 覆盖面:0501 配置/测试连接、0502 导出(计划/预览/加密选择/执行/写档)、
// 0503 归档浏览、0504/0505 导入(两遍计划/预览/双确认/防重/Apply/审计)、
// 0505 审计查看,以及各 catch 分类的如实文案。

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLONE_SUMMARY_CANCEL,
  CLONE_SUMMARY_SAVE,
  EXPORT_CANCEL_ITEM,
  EXPORT_CONFIRM_ITEM,
  pickExportEncryption,
  runConfigureCloneProfileCommand,
  runExportCloneCommand,
  runImportCloneCommand,
  runInspectCloneArchiveCommand,
  runShowCloneAuditCommand,
  runTestCloneConnectionCommand,
  type PlayerCloneCommandDeps
} from '../src/backend/playerDataCloneCommands';
import type { CloneProfile, CloneProfileRole } from '../src/backend/playerDataCloneProfiles';
import {
  type CloneConnectionConfig,
  type CloneMysqlConnection
} from '../src/backend/playerDataCloneMysql';
import {
  tvBigUInt,
  tvText,
  tvUInt,
  type ArchiveMetaWire,
  type ImportPlanWire,
  type QueryPlanWire,
  type TypedRowWire
} from '../src/backend/playerDataCloneWire';

vi.mock('../src/backend/playerDataCloneMysql', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/backend/playerDataCloneMysql')>();
  return { ...actual, openCloneSession: vi.fn() };
});
vi.mock('../src/backend/playerDataCloneRust', () => ({
  inspectCloneArchive: vi.fn(),
  readCloneArchiveRows: vi.fn(),
  planCloneExport: vi.fn(),
  writeCloneArchive: vi.fn(),
  planCloneImport: vi.fn()
}));

// 依赖 mock 后的模块(import 顺序须在 vi.mock 之后)
import { openCloneSession } from '../src/backend/playerDataCloneMysql';
import {
  inspectCloneArchive,
  planCloneExport,
  planCloneImport,
  readCloneArchiveRows,
  writeCloneArchive
} from '../src/backend/playerDataCloneRust';

const NO_GATE = 'Player Data Clone requires the Rust backend (kode-server) to be available: check the kode-core server configuration.';
const PERSISTED_NOT_LIVE = 'This is a persisted copy of the database, not the live online state.';

/** 记录型假连接:预置语句结果(needle → rows/Error),记录全部执行。 */
class FakeMysqlConnection implements CloneMysqlConnection {
  readonly log: Array<{ sql: string; values?: unknown[] }> = [];
  private readonly results = new Map<string, unknown>();
  private autoId = 1000;
  ended = 0;

  reply(sqlNeedle: string, rows: unknown): void {
    this.results.set(sqlNeedle, rows);
  }

  failOn(sqlNeedle: string): void {
    this.results.set(sqlNeedle, new Error(`boom: ${sqlNeedle}`));
  }

  async query(sql: string, values?: unknown[]): Promise<[unknown, unknown]> {
    this.log.push({ sql, values });
    for (const [needle, rows] of this.results) {
      if (sql.includes(needle)) {
        if (rows instanceof Error) {
          throw rows;
        }
        return [rows, []];
      }
    }
    if (/^INSERT INTO/.test(sql)) {
      const insertId = this.autoId;
      this.autoId += 1;
      return [{ insertId, affectedRows: 1 }, undefined];
    }
    return [[], []];
  }

  async end(): Promise<void> {
    this.ended += 1;
  }
}

// ---------------------------------------------------------------------------
// deps 脚本化替身
// ---------------------------------------------------------------------------

interface DepsScript {
  entities?: string[];
  entityTables?: Record<string, Array<{ name: string }> | null>;
  source?: CloneConnectionConfig | null;
  target?: CloneConnectionConfig | null;
  /** 既有 profile(005a 预填面);缺省 = 无既有配置 */
  sourceProfile?: CloneProfile | null;
  targetProfile?: CloneProfile | null;
  inputs?: Array<string | undefined>;
  picks?: Array<string | undefined | ((options: { placeHolder: string }) => string | undefined)>;
  savePath?: string;
  openPath?: string;
  keyRoot?: string;
  encryptionDefault?: 'encrypted' | 'plain';
  cancelledProgress?: boolean;
  auditFiles?: string[];
  auditContent?: string | null;
  failAuditWrite?: boolean;
  endThrows?: boolean;
}

const makeDeps = (script: DepsScript = {}) => {
  const recorded = {
    info: [] as string[],
    warn: [] as string[],
    error: [] as string[],
    lines: [] as string[],
    shows: 0,
    saved: [] as Array<{ role: CloneProfileRole | string; config: unknown; password: unknown }>,
    inputPrompts: [] as string[],
    inputOptions: [] as Array<{ prompt: string; validateInput?: (value: string) => string | null }>,
    pickOptions: [] as Array<{ placeHolder: string }>,
    progressTitles: [] as string[],
    auditWrites: [] as Array<{ name: string; content: string }>
  };
  const connection = new FakeMysqlConnection();
  if (script.endThrows) {
    connection.end = async () => {
      throw new Error('socket already closed');
    };
  }
  const inputs = [...(script.inputs ?? [])];
  const picks = [...(script.picks ?? [])];
  const deps: PlayerCloneCommandDeps = {
    profiles: {
      get: (role: CloneProfileRole) =>
        (role === 'source' ? script.sourceProfile : script.targetProfile) ?? null,
      save: async (role, config, password) => {
        recorded.saved.push({ role, config, password });
      },
      resolveConnection: async (role: CloneProfileRole) => (role === 'source' ? script.source ?? null : script.target ?? null)
    } as unknown as PlayerCloneCommandDeps['profiles'],
    listEntityNames: () => script.entities ?? [],
    resolveEntityTables: (entityName: string) =>
      script.entityTables ? script.entityTables[entityName] ?? null : null,
    showQuickPick: async (items, options) => {
      recorded.pickOptions.push({ placeHolder: options.placeHolder });
      void items;
      const next = picks.shift();
      if (typeof next === 'function') {
        return await next(options);
      }
      return next;
    },
    showInputBox: async options => {
      recorded.inputPrompts.push(options.prompt);
      recorded.inputOptions.push(options);
      return inputs.shift();
    },
    showInformationMessage: async message => {
      recorded.info.push(message);
      return undefined;
    },
    showWarningMessage: async message => {
      recorded.warn.push(message);
      return undefined;
    },
    showErrorMessage: async message => {
      recorded.error.push(message);
      return undefined;
    },
    withProgress: async (options, task) => {
      recorded.progressTitles.push(options.title);
      return await task({ isCancellationRequested: script.cancelledProgress === true });
    },
    pickArchiveSavePath: async () => script.savePath,
    pickArchiveOpenPath: async () => script.openPath,
    writeAuditFile: async (name, content) => {
      if (script.failAuditWrite) {
        throw new Error('audit disk full');
      }
      recorded.auditWrites.push({ name, content });
      return path.join('/audit-out', name);
    },
    listAuditFiles: async () => script.auditFiles ?? [],
    readAuditFile: async () => script.auditContent ?? null,
    getKeyRoot: () => script.keyRoot,
    getArchiveEncryptionDefault: () => script.encryptionDefault,
    channel: {
      appendLine: line => {
        recorded.lines.push(line);
      },
      show: () => {
        recorded.shows += 1;
      }
    },
    now: () => 1_700_000_000_000
  };
  const openAsThis = (): void => {
    vi.mocked(openCloneSession).mockResolvedValue(connection as unknown as CloneMysqlConnection);
  };
  return { deps, recorded, connection, openAsThis };
};

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const archiveMeta = (files: string[] = ['checksums.json', 'redaction-report.json']): ArchiveMetaWire => ({
  format: 'kdpclone',
  version: 1,
  entity: 'Avatar',
  created_at_unix: 1_700_000_000,
  encrypted: true,
  total_rows: 2,
  total_bytes: 64,
  tables: [
    { name: 'tbl_Avatar', rows: 1, bytes: 32 },
    { name: 'tbl_Avatar_items', rows: 1 }
  ],
  files
});

const sourceConfig = (): CloneConnectionConfig => ({
  host: '127.0.0.1',
  port: 13306,
  user: 'kbe',
  password: 'pw',
  database: 'kbe'
});

const targetConfig = (): CloneConnectionConfig & { environment: 'local' } => ({
  host: '127.0.0.1',
  port: 13307,
  user: 'kbe',
  password: 'pw',
  database: 'kbe_local',
  environment: 'local'
});

const avatarTables = (): Array<{ name: string }> => [{ name: 'tbl_Avatar' }, { name: 'tbl_Avatar_items' }];

const replyInformationSchema = (connection: FakeMysqlConnection): void => {
  connection.reply('FROM information_schema.TABLES', [{ ENGINE: 'InnoDB' }]);
  connection.reply('FROM information_schema.COLUMNS', [
    { COLUMN_NAME: 'id', COLUMN_TYPE: 'bigint(20) unsigned' },
    { COLUMN_NAME: 'sm_name', COLUMN_TYPE: 'varchar(255)' }
  ]);
  connection.reply('FROM information_schema.STATISTICS', [
    { INDEX_NAME: 'PRIMARY', NON_UNIQUE: 0, SEQ_IN_INDEX: 1, COLUMN_NAME: 'id' },
    { INDEX_NAME: 'uk_name', NON_UNIQUE: 0, SEQ_IN_INDEX: 1, COLUMN_NAME: 'sm_name' }
  ]);
};

const exportPlan = (overrides: Partial<QueryPlanWire> = {}): QueryPlanWire => ({
  entity_name: 'Avatar',
  row_budget: 100,
  queries: [
    {
      sequence: 0,
      table: 'tbl_Avatar',
      columns: ['id', 'sm_name'],
      column_types: ['bigint unsigned', 'varchar'],
      select_sql: 'SELECT id, sm_name FROM tbl_Avatar WHERE id = ?',
      filter: { kind: 'root-id' }
    },
    {
      sequence: 1,
      table: 'tbl_Avatar_items',
      parent_table: 'tbl_Avatar',
      columns: ['id', 'sm_name'],
      column_types: ['bigint unsigned', 'varchar'],
      select_sql: 'SELECT id, sm_name FROM tbl_Avatar_items WHERE parentID = ?',
      filter: { kind: 'parent-id' }
    }
  ],
  denied: [],
  missing: [],
  ...overrides
});

const exportRows = (): TypedRowWire[] => [
  { table: 'tbl_Avatar', values: [tvBigUInt(7), tvText('hero')] },
  { table: 'tbl_Avatar_items', values: [tvBigUInt(100), tvText('sword')] }
];

const importPlan = (overrides: Partial<ImportPlanWire> = {}): ImportPlanWire => ({
  entity_name: 'Avatar',
  mode: 'allocate-new-ids',
  autoload_policy: 'force-disabled',
  order: ['tbl_Avatar', 'tbl_Avatar_items'],
  statements: [
    {
      sequence: 0,
      table: 'tbl_Avatar',
      row_index: 0,
      columns: ['id', 'sm_autoLoad', 'sm_name'],
      cells: [
        { kind: 'new-key', placeholder: 1 },
        { kind: 'policy-override' },
        { kind: 'remapped' }
      ],
      insert_sql: 'INSERT INTO tbl_Avatar (id, sm_autoLoad, sm_name) VALUES (?, ?, ?)'
    },
    {
      sequence: 1,
      table: 'tbl_Avatar_items',
      row_index: 0,
      columns: ['id', 'parentID', 'sm_value'],
      cells: [
        { kind: 'new-key', placeholder: 2 },
        { kind: 'key-reference', placeholder: 1 },
        { kind: 'literal' }
      ],
      insert_sql: 'INSERT INTO tbl_Avatar_items (id, parentID, sm_value) VALUES (?, ?, ?)'
    }
  ],
  idmap: [
    {
      key: { table: 'tbl_Avatar', column: 'sm_name', old: tvText('hero') },
      mapped: { kind: 'rebuilt', value: tvText('hero_imported1') },
      category: 'rebuilt-identity'
    }
  ],
  conflicts: [],
  account_binding: { declaration: null, login_ready: false, note: '按邮箱声明绑定' },
  schema_notes: [],
  warnings: [],
  summary: {
    entity_name: 'Avatar',
    mode: 'allocate-new-ids',
    autoload_policy: 'force-disabled',
    statements_per_table: { tbl_Avatar: 1, tbl_Avatar_items: 1 },
    id_categories: { rebuilt: 1 },
    unique_conflicts: 0,
    login_ready: false,
    unresolved_reference_risks: 0
  },
  ...overrides
});

const importRowsCall = () => ({
  status: 'ok' as const,
  result: {
    tables: [
      { name: 'tbl_Avatar', rows: [{ table: 'tbl_Avatar', values: [tvBigUInt(7), tvUInt(1), tvText('hero')] }] },
      {
        name: 'tbl_Avatar_items',
        rows: [{ table: 'tbl_Avatar_items', values: [tvBigUInt(100), tvBigUInt(7), tvText('sword')] }]
      }
    ]
  }
});

const CONFIRM_FIRST = 'Continue to confirmation';
const CONFIRM_WRITE = 'Confirm write to local database 127.0.0.1:13307/kbe_local';
const CONFIRM_COPY = 'Create another copy anyway';

let tmpRoot = '';

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clone-cmd-'));
});

// ---------------------------------------------------------------------------
// 0609 导出加密选择
// ---------------------------------------------------------------------------

describe('pickExportEncryption(导出确认页加密循环)', () => {
  const itemsOf = (options: { placeHolder: string }): never => {
    throw new Error(`unexpected pick: ${options.placeHolder}`);
  };

  it('默认加密:确认项携带加密态,直接确认', async () => {
    let seenItems: readonly string[] = [];
    const result = await pickExportEncryption(async (items, options) => {
      seenItems = items;
      expect(options.placeHolder).toContain('3 read-only query results');
      return items[0];
    }, 3, true);
    expect(result).toEqual({ confirmed: true, encrypt: true });
    expect(seenItems[0]).toContain(EXPORT_CONFIRM_ITEM);
    expect(seenItems[0]).toContain('Encrypted (local key)');
    expect(seenItems[2]).toBe(EXPORT_CANCEL_ITEM);
  });

  it('切换两次后确认:加密态翻转', async () => {
    let round = 0;
    const result = await pickExportEncryption(async items => {
      round += 1;
      if (round === 1) {
        // 初始明文:切换项目标态是加密
        expect(items[0]).toContain('Plaintext (portable)');
        expect(items[1]).toContain('Toggle encryption');
        expect(items[1]).toContain('Encrypted (local key)');
        return items[1];
      }
      // 翻转后确认项携带加密态
      expect(items[0]).toContain(EXPORT_CONFIRM_ITEM);
      expect(items[0]).toContain('Encrypted (local key)');
      return items[0];
    }, 1, false);
    expect(result).toEqual({ confirmed: true, encrypt: true });
  });

  it('取消项/关窗 → confirmed:false(维持当前加密态)', async () => {
    const cancelled = await pickExportEncryption(async items => items[2], 1, true);
    expect(cancelled).toEqual({ confirmed: false, encrypt: true });
    const dismissed = await pickExportEncryption(async () => undefined, 1, false);
    expect(dismissed).toEqual({ confirmed: false, encrypt: false });
    void itemsOf;
  });
});

// ---------------------------------------------------------------------------
// 0501 连接 Profile 配置 / 测试
// ---------------------------------------------------------------------------

describe('runConfigureCloneProfileCommand(0501)', () => {
  it('source:输入齐全 → 摘要选保存 → save(source)+ 提示;端口数字落 Number', async () => {
    const { deps, recorded } = makeDeps({
      inputs: ['db.host', '3307', 'kbe', 'pw', 'kbe_db'],
      picks: [CLONE_SUMMARY_SAVE]
    });
    await runConfigureCloneProfileCommand(deps, 'source');
    expect(recorded.saved).toEqual([
      { role: 'source', config: { host: 'db.host', port: 3307, user: 'kbe', database: 'kbe_db' }, password: 'pw' }
    ]);
    expect(recorded.info).toEqual(['Source connection saved.']);
  });

  it('target:环境仅 local/test;端口留空落 3306;密码留空不存密钥;摘要选保存', async () => {
    const { deps, recorded } = makeDeps({
      inputs: ['t.host', '', 't.user', '', 'kbe_local'],
      picks: ['local', CLONE_SUMMARY_SAVE]
    });
    await runConfigureCloneProfileCommand(deps, 'target');
    expect(recorded.saved).toEqual([
      {
        role: 'target',
        config: { host: 't.host', port: 3306, user: 't.user', database: 'kbe_local', environment: 'local' },
        password: null
      }
    ]);
    expect(recorded.info).toEqual(['Target connection saved.']);
    expect(recorded.pickOptions[0].placeHolder).toContain('production and staging are not allowed');
  });

  it('端口输入校验:非数字拒,空串与纯数字过', async () => {
    const { deps, recorded } = makeDeps({ inputs: ['h', '3306', 'u', 'p', 'd'], picks: ['test', CLONE_SUMMARY_CANCEL] });
    await runConfigureCloneProfileCommand(deps, 'target');
    const validate = recorded.inputOptions[1].validateInput;
    expect(validate).toBeDefined();
    expect(validate!('abc')).toBe('Port must be a number');
    expect(validate!('')).toBeNull();
    expect(validate!('3306')).toBeNull();
    expect(validate!('1')).toBeNull();
    expect(validate!('65535')).toBeNull();
    expect(validate!('0')).toBe('Port must be between 1 and 65535');
    expect(validate!('65536')).toBe('Port must be between 1 and 65535');
    expect(recorded.inputOptions[0].validateInput!('  ')).toBe('Enter a host address');
    expect(recorded.inputOptions[2].validateInput!('')).toBe('Enter a username');
    expect(recorded.inputOptions[4].validateInput!('')).toBe('Enter a database name');
  });

  it('环境声明不是 local/test(quickpick 脚本给 prod)→ 不保存', async () => {
    const { deps, recorded } = makeDeps({ inputs: ['h', '1', 'u', 'p', 'd'], picks: ['prod'] });
    await runConfigureCloneProfileCommand(deps, 'target');
    expect(recorded.saved).toHaveLength(0);
    expect(recorded.info).toHaveLength(0);
  });

  it('环境声明取消 → 不保存', async () => {
    const { deps, recorded } = makeDeps({ inputs: ['h', '1', 'u', 'p', 'd'], picks: [undefined] });
    await runConfigureCloneProfileCommand(deps, 'target');
    expect(recorded.saved).toHaveLength(0);
  });

  it.each([
    ['host 取消', [undefined]],
    ['port 取消', ['h', undefined]],
    ['user 取消', ['h', '1', undefined]],
    ['password 取消', ['h', '1', 'u', undefined]],
    ['database 取消', ['h', '1', 'u', 'p', undefined]]
  ])('任一输入取消(%s)→ 不保存不提示', async (_label, inputs) => {
    const { deps, recorded } = makeDeps({ inputs: inputs as Array<string | undefined> });
    await runConfigureCloneProfileCommand(deps, 'source');
    expect(recorded.saved).toHaveLength(0);
    expect(recorded.info).toHaveLength(0);
  });
});

describe('runTestCloneConnectionCommand(0501 测试连接)', () => {
  it('未配置 → 如实警告', async () => {
    const { deps, recorded } = makeDeps({});
    await runTestCloneConnectionCommand(deps, 'target');
    expect(recorded.warn).toEqual(['Target connection is not configured.']);
  });

  it('连通:版本回显;连接用毕关闭', async () => {
    const { deps, recorded, connection, openAsThis } = makeDeps({ source: sourceConfig() });
    connection.reply('SELECT VERSION()', [{ v: '8.0.30' }]);
    openAsThis();
    await runTestCloneConnectionCommand(deps, 'source');
    expect(recorded.info).toEqual(['Source connection succeeded (server version 8.0.30).']);
    expect(connection.ended).toBe(1);
  });

  it('连接成功但测试查询失败 → 失败原因如实回显', async () => {
    const { deps, recorded, connection, openAsThis } = makeDeps({ target: targetConfig() });
    connection.failOn('SELECT VERSION()');
    openAsThis();
    await runTestCloneConnectionCommand(deps, 'target');
    expect(recorded.error).toHaveLength(1);
    expect(recorded.error[0]).toContain('Connection failed: boom');
    expect(connection.ended).toBe(1);
  });

  it('建连失败 → catch 如实回显', async () => {
    const { deps, recorded } = makeDeps({ source: sourceConfig() });
    vi.mocked(openCloneSession).mockRejectedValue(new Error('connection refused'));
    await runTestCloneConnectionCommand(deps, 'source');
    expect(recorded.error).toEqual(['Connection failed: connection refused']);
  });
});

// ---------------------------------------------------------------------------
// 0503 归档浏览
// ---------------------------------------------------------------------------

describe('runInspectCloneArchiveCommand(0503)', () => {
  it('未选归档 → 直接返回', async () => {
    const { deps, recorded } = makeDeps({});
    await runInspectCloneArchiveCommand(deps);
    expect(recorded.lines).toHaveLength(0);
    expect(recorded.info).toHaveLength(0);
  });

  it('no-gate → 如实告知需要 Rust 后端', async () => {
    const { deps, recorded } = makeDeps({ openPath: '/tmp/a.kdpclone' });
    vi.mocked(inspectCloneArchive).mockResolvedValue({ status: 'no-gate' });
    await runInspectCloneArchiveCommand(deps);
    expect(recorded.error).toEqual([NO_GATE]);
  });

  it('读清单出错 → 错误原因如实回显', async () => {
    const { deps, recorded } = makeDeps({ openPath: '/tmp/a.kdpclone' });
    vi.mocked(inspectCloneArchive).mockResolvedValue({ status: 'error', reason: 'archive truncated' });
    await runInspectCloneArchiveCommand(deps);
    expect(recorded.error).toEqual(['Failed to read the archive manifest: archive truncated']);
  });

  it('ok:清单落输出通道(校验/脱敏报告齐备);Persisted≠Live 提示在案', async () => {
    const { deps, recorded } = makeDeps({ openPath: '/tmp/a.kdpclone' });
    vi.mocked(inspectCloneArchive).mockResolvedValue({ status: 'ok', result: archiveMeta() });
    await runInspectCloneArchiveCommand(deps);
    const text = recorded.lines.join('\n');
    expect(text).toContain('[Player Clone] /tmp/a.kdpclone');
    expect(text).toContain('Archive entity: Avatar');
    expect(text).toContain('Total rows: 2');
    expect(text).toContain('Encrypted: yes');
    expect(text).toContain('- tbl_Avatar: 1 rows');
    expect(text).toContain('checksums.json ✓');
    expect(text).toContain('redaction-report.json ✓');
    expect(text).toContain(PERSISTED_NOT_LIVE);
    expect(recorded.shows).toBe(1);
    expect(recorded.info[0]).toContain('Archive manifest written to the output (Avatar, 2 rows)');
    expect(recorded.info[0]).toContain(PERSISTED_NOT_LIVE);
  });

  it('ok:校验文件/脱敏报告缺失 → 如实标缺失', async () => {
    const { deps, recorded } = makeDeps({ openPath: '/tmp/a.kdpclone' });
    vi.mocked(inspectCloneArchive).mockResolvedValue({ status: 'ok', result: archiveMeta([]) });
    await runInspectCloneArchiveCommand(deps);
    const text = recorded.lines.join('\n');
    expect(text).toContain('Checksums: missing');
    expect(text).toContain('Redaction report: missing');
  });
});

// ---------------------------------------------------------------------------
// 0502 导出
// ---------------------------------------------------------------------------

describe('runExportCloneCommand(0502)', () => {
  it('工作区无实体 → 警告', async () => {
    const { deps, recorded } = makeDeps({ entities: [] });
    await runExportCloneCommand(deps);
    expect(recorded.warn).toEqual(['No registered entities found in the workspace (open a KBEngine project first).']);
  });

  it.each([
    ['实体选择取消', { picks: [undefined] }],
    ['DBID 输入取消', { picks: ['Avatar'], inputs: [undefined] }]
  ])('早期取消(%s)→ 不建连不导出', async (_label, script) => {
    const { deps, recorded } = makeDeps({ entities: ['Avatar'], entityTables: { Avatar: avatarTables() }, source: sourceConfig(), ...script });
    await runExportCloneCommand(deps);
    expect(recorded.info).toHaveLength(0);
    expect(recorded.lines).toHaveLength(0);
  });

  it('未配置 Source 连接 → 警告指引', async () => {
    const { deps, recorded } = makeDeps({ entities: ['Avatar'], picks: ['Avatar'], inputs: ['42'] });
    await runExportCloneCommand(deps);
    expect(recorded.warn).toEqual(['Source connection is not configured.']);
    expect(recorded.inputPrompts).toEqual([]);
    expect(recorded.pickOptions).toEqual([]);
  });

  it('导出 DBID 输入校验:非数字拒,纯数字过', async () => {
    const { deps, recorded } = makeDeps({ entities: ['Avatar'], picks: ['Avatar'], inputs: ['42'], source: sourceConfig() });
    await runExportCloneCommand(deps);
    const validate = recorded.inputOptions[0].validateInput;
    expect(validate).toBeDefined();
    expect(validate!('abc')).toBe('DBID must be a number');
    expect(validate!('')).toBe('DBID must be a number');
    expect(validate!('42')).toBeNull();
  });

  it.each([
    ['def 推导不可用(null)', { entityTables: {} }],
    ['def 推导为空表', { entityTables: { Avatar: [] } }]
  ])('表结构推导不可用(%s)→ 如实报错', async (_label, script) => {
    const { deps, recorded } = makeDeps({
      entities: ['Avatar'],
      picks: ['Avatar'],
      inputs: ['42'],
      source: sourceConfig(),
      ...script
    });
    await runExportCloneCommand(deps);
    expect(recorded.error).toEqual(['Cannot derive table structure for entity Avatar from workspace defs.']);
  });

  it('保存路径取消 → 返回', async () => {
    const { deps, recorded } = makeDeps({
      entities: ['Avatar'],
      entityTables: { Avatar: avatarTables() },
      picks: ['Avatar'],
      inputs: ['42'],
      source: sourceConfig()
    });
    await runExportCloneCommand(deps);
    expect(recorded.info).toHaveLength(0);
    expect(recorded.error).toHaveLength(0);
  });

  it('计划 no-gate → 如实告知需要 Rust 后端', async () => {
    const { deps, recorded, connection, openAsThis } = makeDeps({
      entities: ['Avatar'],
      entityTables: { Avatar: avatarTables() },
      picks: ['Avatar'],
      inputs: ['42'],
      source: sourceConfig(),
      savePath: '/tmp/out.kdpclone'
    });
    replyInformationSchema(connection);
    openAsThis();
    vi.mocked(planCloneExport).mockResolvedValue({ status: 'no-gate' });
    await runExportCloneCommand(deps);
    expect(recorded.error).toEqual([NO_GATE]);
    expect(connection.ended).toBe(1);
  });

  it('计划出错 → 原因如实回显', async () => {
    const { deps, recorded, connection, openAsThis } = makeDeps({
      entities: ['Avatar'],
      entityTables: { Avatar: avatarTables() },
      picks: ['Avatar'],
      inputs: ['42'],
      source: sourceConfig(),
      savePath: '/tmp/out.kdpclone'
    });
    replyInformationSchema(connection);
    openAsThis();
    vi.mocked(planCloneExport).mockResolvedValue({ status: 'error', reason: 'table denied' });
    await runExportCloneCommand(deps);
    expect(recorded.error).toEqual(['Failed to generate the export plan: table denied']);
  });

  it('加密确认取消 → 不执行导出', async () => {
    const { deps, recorded, connection, openAsThis } = makeDeps({
      entities: ['Avatar'],
      entityTables: { Avatar: avatarTables() },
      picks: ['Avatar', EXPORT_CANCEL_ITEM],
      inputs: ['42'],
      source: sourceConfig(),
      savePath: '/tmp/out.kdpclone'
    });
    replyInformationSchema(connection);
    connection.reply('FROM tbl_Avatar WHERE', [{ id: 7, sm_name: 'hero' }]);
    openAsThis();
    vi.mocked(planCloneExport).mockResolvedValue({ status: 'ok', result: exportPlan({ missing: ['tbl_ghost'] }) });
    await runExportCloneCommand(deps);
    // 预览已落通道(含缺失表),但未执行导出、未写档
    const text = recorded.lines.join('\n');
    expect(text).toContain('Missing in source: tbl_ghost');
    expect(text).toContain(PERSISTED_NOT_LIVE);
    expect(recorded.info).toHaveLength(0);
    expect(connection.log.some(entry => entry.sql === 'COMMIT')).toBe(false);
    expect(vi.mocked(writeCloneArchive)).not.toHaveBeenCalled();
  });

  it('happy:预览 → 确认加密 → 执行 → 写档 → 完成提示;连接用毕关闭', async () => {
    const { deps, recorded, connection, openAsThis } = makeDeps({
      entities: ['Avatar'],
      entityTables: { Avatar: avatarTables() },
      picks: ['Avatar', `${EXPORT_CONFIRM_ITEM},Encrypted (local key)`],
      inputs: ['42'],
      source: sourceConfig(),
      savePath: '/tmp/out.kdpclone',
      keyRoot: path.join(tmpRoot, 'keys')
    });
    replyInformationSchema(connection);
    connection.reply('FROM tbl_Avatar WHERE', [{ id: 7, sm_name: 'hero' }]);
    connection.reply('FROM tbl_Avatar_items WHERE', [{ id: 100, sm_name: 'sword' }]);
    openAsThis();
    vi.mocked(planCloneExport).mockResolvedValue({ status: 'ok', result: exportPlan() });
    vi.mocked(writeCloneArchive).mockResolvedValue({
      status: 'ok',
      result: { entity: 'Avatar', total_rows: 2, tables: [] }
    });
    await runExportCloneCommand(deps);

    const text = recorded.lines.join('\n');
    expect(text).toContain('[Player Clone Export] Avatar DBID=42');
    expect(text).toContain('Tables: tbl_Avatar, tbl_Avatar_items');
    expect(text).toContain('Row budget: 100');
    expect(text).toContain(PERSISTED_NOT_LIVE);
    expect(recorded.progressTitles).toEqual(['Player Clone: reading Avatar data (cancellable)']);
    expect(vi.mocked(writeCloneArchive)).toHaveBeenCalledWith(
      '/tmp/out.kdpclone',
      'Avatar',
      exportRows(),
      exportPlan(),
      path.join(tmpRoot, 'keys')
    );
    expect(recorded.info[0]).toContain('Export finished: 2 rows → /tmp/out.kdpclone');
    expect(recorded.info[0]).toContain('archive is encrypted');
    expect(recorded.info[0]).toContain(PERSISTED_NOT_LIVE);
    // 根查询按 DBID 绑定(bigint 直传)
    const rootRun = connection.log.find(entry => entry.sql.includes('FROM tbl_Avatar WHERE'));
    expect(rootRun?.values).toEqual([42n]);
    // 只读快照控制语句与 COMMIT 在案;连接用毕关闭
    const log = connection.log.map(entry => entry.sql);
    expect(log).toContain('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    expect(log).toContain('COMMIT');
    expect(connection.ended).toBe(1);
  });

  it('默认明文设置:确认页初始明文,完成提示标明文', async () => {
    const { deps, recorded, connection, openAsThis } = makeDeps({
      entities: ['Avatar'],
      entityTables: { Avatar: avatarTables() },
      picks: ['Avatar', `${EXPORT_CONFIRM_ITEM},x`],
      inputs: ['42'],
      source: sourceConfig(),
      savePath: '/tmp/out.kdpclone',
      keyRoot: path.join(tmpRoot, 'keys'),
      encryptionDefault: 'plain'
    });
    replyInformationSchema(connection);
    connection.reply('FROM tbl_Avatar WHERE', [{ id: 7, sm_name: 'hero' }]);
    connection.reply('FROM tbl_Avatar_items WHERE', [{ id: 100, sm_name: 'sword' }]);
    openAsThis();
    vi.mocked(planCloneExport).mockResolvedValue({ status: 'ok', result: exportPlan() });
    vi.mocked(writeCloneArchive).mockResolvedValue({
      status: 'ok',
      result: { entity: 'Avatar', total_rows: 2, tables: [] }
    });
    await runExportCloneCommand(deps);
    expect(recorded.info[0]).toContain('archive is plaintext (not encrypted)');
    // 明文导出不带 keyRoot
    expect(vi.mocked(writeCloneArchive)).toHaveBeenCalledWith(
      '/tmp/out.kdpclone',
      'Avatar',
      exportRows(),
      exportPlan(),
      undefined
    );
  });

  it('一行未读到 → 警告不导出', async () => {
    const { deps, recorded, connection, openAsThis } = makeDeps({
      entities: ['Avatar'],
      entityTables: { Avatar: avatarTables() },
      picks: ['Avatar', `${EXPORT_CONFIRM_ITEM},x`],
      inputs: ['42'],
      source: sourceConfig(),
      savePath: '/tmp/out.kdpclone'
    });
    replyInformationSchema(connection);
    connection.reply('FROM tbl_Avatar WHERE', []);
    openAsThis();
    vi.mocked(planCloneExport).mockResolvedValue({ status: 'ok', result: exportPlan() });
    await runExportCloneCommand(deps);
    expect(recorded.warn).toEqual(['DBID=42 returned no rows from the source database (nothing exported).']);
    expect(vi.mocked(writeCloneArchive)).not.toHaveBeenCalled();
  });

  it('写档 no-gate / 出错 → 如实报错', async () => {
    const { deps, recorded, connection, openAsThis } = makeDeps({
      entities: ['Avatar'],
      entityTables: { Avatar: avatarTables() },
      picks: ['Avatar', `${EXPORT_CONFIRM_ITEM},x`],
      inputs: ['42'],
      source: sourceConfig(),
      savePath: '/tmp/out.kdpclone'
    });
    replyInformationSchema(connection);
    connection.reply('FROM tbl_Avatar WHERE', [{ id: 7, sm_name: 'hero' }]);
    connection.reply('FROM tbl_Avatar_items WHERE', [{ id: 100, sm_name: 'sword' }]);
    openAsThis();
    vi.mocked(planCloneExport).mockResolvedValue({ status: 'ok', result: exportPlan() });
    vi.mocked(writeCloneArchive).mockResolvedValue({ status: 'no-gate' });
    await runExportCloneCommand(deps);
    expect(recorded.error).toEqual([NO_GATE]);

    const second = makeDeps({
      entities: ['Avatar'],
      entityTables: { Avatar: avatarTables() },
      picks: ['Avatar', `${EXPORT_CONFIRM_ITEM},x`],
      inputs: ['42'],
      source: sourceConfig(),
      savePath: '/tmp/out.kdpclone'
    });
    replyInformationSchema(second.connection);
    second.connection.reply('FROM tbl_Avatar WHERE', [{ id: 7, sm_name: 'hero' }]);
    second.connection.reply('FROM tbl_Avatar_items WHERE', [{ id: 100, sm_name: 'sword' }]);
    second.openAsThis();
    vi.mocked(planCloneExport).mockResolvedValue({ status: 'ok', result: exportPlan() });
    vi.mocked(writeCloneArchive).mockResolvedValue({ status: 'error', reason: 'disk full' });
    await runExportCloneCommand(second.deps);
    expect(second.recorded.error).toEqual(['Failed to write the archive: disk full']);
  });

  it('连接关闭失败不吞导出结果(通道记账)', async () => {
    const { deps, recorded, connection, openAsThis } = makeDeps({
      entities: ['Avatar'],
      entityTables: { Avatar: avatarTables() },
      picks: ['Avatar', `${EXPORT_CONFIRM_ITEM},x`],
      inputs: ['42'],
      source: sourceConfig(),
      savePath: '/tmp/out.kdpclone',
      endThrows: true
    });
    replyInformationSchema(connection);
    connection.reply('FROM tbl_Avatar WHERE', [{ id: 7, sm_name: 'hero' }]);
    connection.reply('FROM tbl_Avatar_items WHERE', [{ id: 100, sm_name: 'sword' }]);
    openAsThis();
    vi.mocked(planCloneExport).mockResolvedValue({ status: 'ok', result: exportPlan() });
    vi.mocked(writeCloneArchive).mockResolvedValue({
      status: 'ok',
      result: { entity: 'Avatar', total_rows: 2, tables: [] }
    });
    await runExportCloneCommand(deps);
    expect(recorded.info[0]).toContain('Export finished');
    expect(recorded.lines.join('\n')).toContain('Failed to close the read-only connection: Error: socket already closed');
  });

  it('导出中途取消 → 警告(只读面无需回滚)', async () => {
    const { deps, recorded, connection, openAsThis } = makeDeps({
      entities: ['Avatar'],
      entityTables: { Avatar: avatarTables() },
      picks: ['Avatar', `${EXPORT_CONFIRM_ITEM},x`],
      inputs: ['42'],
      source: sourceConfig(),
      savePath: '/tmp/out.kdpclone',
      cancelledProgress: true
    });
    replyInformationSchema(connection);
    openAsThis();
    vi.mocked(planCloneExport).mockResolvedValue({ status: 'ok', result: exportPlan() });
    await runExportCloneCommand(deps);
    expect(recorded.warn).toEqual(['Export cancelled (read-only surface; no rollback needed).']);
    expect(recorded.error).toHaveLength(0);
    expect(connection.log.map(entry => entry.sql)).not.toContain('COMMIT');
  });

  it('探测面抛错(不安全表名)→ catch 如实回显', async () => {
    const { deps, recorded, connection, openAsThis } = makeDeps({
      entities: ['Avatar'],
      entityTables: { Avatar: [{ name: 'tbl; DROP' }] },
      picks: ['Avatar'],
      inputs: ['42'],
      source: sourceConfig(),
      savePath: '/tmp/out.kdpclone'
    });
    openAsThis();
    await runExportCloneCommand(deps);
    expect(recorded.error[0]).toContain('Export failed:');
    expect(recorded.error[0]).toContain('unsafe table name');
    void connection;
  });
});

// ---------------------------------------------------------------------------
// 0504/0505 导入
// ---------------------------------------------------------------------------

/** 建临时归档文件(供真实 fingerprint/reservation 使用)。 */
const writeArchiveFile = (content = 'archive-bytes-v1'): string => {
  const archivePath = path.join(tmpRoot, 'avatar.kdpclone');
  fs.writeFileSync(archivePath, content, 'utf8');
  return archivePath;
};

const happyImportScript = (archivePath: string, keyRoot: string, picks: DepsScript['picks']) => ({
  openPath: archivePath,
  target: targetConfig(),
  entityTables: { Avatar: avatarTables() },
  keyRoot,
  picks
});

describe('runImportCloneCommand(0504/0505)', () => {
  it('未选归档 → 直接返回(目标已配置,预检通过)', async () => {
    // 004c 后目标配置预检前移:取消选档路径需带已配置 target 才可达
    const { deps, recorded } = makeDeps({ target: targetConfig() });
    await runImportCloneCommand(deps);
    expect(recorded.info).toHaveLength(0);
    expect(recorded.error).toHaveLength(0);
    expect(recorded.warn).toHaveLength(0);
  });

  it('未配置 Target → 警告指引', async () => {
    const { deps, recorded } = makeDeps({ openPath: '/tmp/a.kdpclone' });
    await runImportCloneCommand(deps);
    expect(recorded.warn).toEqual(['Target connection is not configured (local/test only; run "Configure Target connection" first).']);
  });

  it('清单 no-gate / 出错 → 如实报错', async () => {
    const { deps, recorded } = makeDeps({ openPath: '/tmp/a.kdpclone', target: targetConfig() });
    vi.mocked(inspectCloneArchive).mockResolvedValue({ status: 'no-gate' });
    await runImportCloneCommand(deps);
    expect(recorded.error).toEqual([NO_GATE]);

    const second = makeDeps({ openPath: '/tmp/a.kdpclone', target: targetConfig() });
    vi.mocked(inspectCloneArchive).mockResolvedValue({ status: 'error', reason: 'bad archive' });
    await runImportCloneCommand(second.deps);
    expect(second.recorded.error).toEqual(['Failed to read the archive manifest: bad archive']);
  });

  it('def 推导不可用 → 如实报错(导入需要目标 schema 对账)', async () => {
    const { deps, recorded } = makeDeps({ openPath: '/tmp/a.kdpclone', target: targetConfig() });
    vi.mocked(inspectCloneArchive).mockResolvedValue({ status: 'ok', result: archiveMeta() });
    await runImportCloneCommand(deps);
    expect(recorded.error).toEqual(['Cannot derive table structure for entity Avatar from workspace defs (import needs target schema reconciliation).']);
  });

  it.each([
    ['pass-1 no-gate', 'pass1-no-gate'],
    ['pass-1 出错', 'pass1-error'],
    ['归档行 no-gate', 'rows-no-gate'],
    ['归档行出错', 'rows-error'],
    ['pass-2 出错', 'pass2-error']
  ])('两遍计划中断面(%s)→ 如实报错并关闭探测连接', async (_label, mode) => {
    const archivePath = writeArchiveFile();
    const { deps, recorded, connection, openAsThis } = makeDeps(
      happyImportScript(archivePath, path.join(tmpRoot, 'keys'), [])
    );
    replyInformationSchema(connection);
    openAsThis();
    vi.mocked(inspectCloneArchive).mockResolvedValue({ status: 'ok', result: archiveMeta() });

    if (mode === 'pass1-no-gate') {
      vi.mocked(planCloneImport).mockResolvedValue({ status: 'no-gate' });
    } else if (mode === 'pass1-error') {
      vi.mocked(planCloneImport).mockResolvedValue({ status: 'error', reason: 'unsupported schema' });
    } else {
      vi.mocked(planCloneImport).mockResolvedValue({ status: 'ok', result: importPlan() });
      if (mode === 'pass2-error') {
        // pass-1 ok;pass-2 预演失败
        vi.mocked(planCloneImport).mockResolvedValueOnce({ status: 'ok', result: importPlan() });
        vi.mocked(planCloneImport).mockResolvedValueOnce({ status: 'error', reason: 'boom pass2' });
      }
    }
    if (mode === 'rows-no-gate') {
      vi.mocked(readCloneArchiveRows).mockResolvedValue({ status: 'no-gate' });
    } else if (mode === 'rows-error') {
      vi.mocked(readCloneArchiveRows).mockResolvedValue({ status: 'error', reason: 'row decode failed' });
    } else {
      vi.mocked(readCloneArchiveRows).mockResolvedValue(importRowsCall());
    }
    await runImportCloneCommand(deps);
    if (mode === 'pass1-no-gate') {
      expect(recorded.error).toEqual([NO_GATE]);
    } else if (mode === 'pass1-error') {
      expect(recorded.error).toEqual(['Failed to generate the import plan: unsupported schema']);
    } else if (mode === 'rows-no-gate') {
      expect(recorded.error).toEqual([NO_GATE]);
    } else if (mode === 'rows-error') {
      expect(recorded.error).toEqual(['Failed to read archive rows: row decode failed']);
    } else {
      expect(recorded.error).toEqual(['Failed to rehearse the import: boom pass2']);
      // 两次 planImport 都携 keyRoot(加密档取钥)
      expect(vi.mocked(planCloneImport).mock.calls[0][5]).toBe(path.join(tmpRoot, 'keys'));
      expect(vi.mocked(planCloneImport).mock.calls[1][5]).toBe(path.join(tmpRoot, 'keys'));
    }
    // 探测连接(只读会话)用毕关闭
    expect(connection.ended).toBe(1);
  });

  it('happy:预览(告警/绑定/冲突)→ 双确认 → 防重登记 → Apply → 审计落盘', async () => {
    const archivePath = writeArchiveFile();
    const keyRoot = path.join(tmpRoot, 'keys');
    const { deps, recorded, connection, openAsThis } = makeDeps(
      happyImportScript(archivePath, keyRoot, [CONFIRM_FIRST, CONFIRM_WRITE])
    );
    replyInformationSchema(connection);
    // 唯一值探测(SELECT sm_name AS v ... WHERE sm_name IN)与提交后 COUNT
    // 分开预置,避免 needle 互咬。
    connection.reply('sm_name IN', [{ v: 'hero' }]);
    connection.reply('SELECT COUNT(*)', [{ c: 1 }]);
    openAsThis();
    const plan = importPlan({ warnings: ['账号邮箱为空,登录绑定跳过'] });
    vi.mocked(inspectCloneArchive).mockResolvedValue({ status: 'ok', result: archiveMeta() });
    vi.mocked(planCloneImport).mockResolvedValue({ status: 'ok', result: plan });
    vi.mocked(readCloneArchiveRows).mockResolvedValue(importRowsCall());

    await runImportCloneCommand(deps);

    // 预览面:逐表/类别/冲突/绑定/未解决引用 + 告警 + Persisted≠Live
    const preview = recorded.lines[0];
    expect(preview).toContain(`[Player Clone Import] ${archivePath}`);
    expect(preview).toContain('Entity: Avatar');
    expect(preview).toContain('Statements: tbl_Avatar×1, tbl_Avatar_items×1');
    expect(preview).toContain('ID categories: rebuilt×1');
    expect(preview).toContain('Unique conflicts: 0');
    expect(preview).toContain('Account binding: 按邮箱声明绑定');
    expect(preview).toContain('Unresolved references: 0');
    expect(preview).toContain('- warning: 账号邮箱为空,登录绑定跳过');
    expect(preview).toContain(PERSISTED_NOT_LIVE);
    expect(recorded.shows).toBeGreaterThanOrEqual(1);

    // 防重登记先于写入:reservation 文件已落 keyRoot
    const reservationDir = path.join(keyRoot, 'import-reservations');
    expect(fs.readdirSync(reservationDir)).toHaveLength(1);

    // Apply 面单事务:START TRANSACTION → 两条 INSERT → COMMIT,无 DELETE 执行
    const log = connection.log.map(entry => entry.sql);
    expect(log).toContain('START TRANSACTION');
    expect(log.filter(sql => sql.startsWith('INSERT INTO'))).toHaveLength(2);
    expect(log).toContain('COMMIT');
    expect(log.some(sql => sql.startsWith('DELETE'))).toBe(false);
    // 根行 NULL + 禁用 + 重建值;子行引用回填的真实新主键
    expect(connection.log.find(entry => entry.sql.includes('INSERT INTO tbl_Avatar '))?.values).toEqual([
      null,
      0,
      'hero_imported1'
    ]);
    expect(connection.log.find(entry => entry.sql.includes('INSERT INTO tbl_Avatar_items'))?.values).toEqual([
      null,
      1000,
      'sword'
    ]);

    // 审计面
    expect(recorded.auditWrites).toHaveLength(1);
    expect(recorded.auditWrites[0].name).toBe('import-Avatar-1700000000.json');
    const audit = JSON.parse(recorded.auditWrites[0].content);
    expect(audit.kind).toBe('player-clone-import-run');
    expect(audit.archive_path).toBe(archivePath);
    expect(audit.entity).toBe('Avatar');
    expect(audit.mode).toBe('allocate-new-ids');
    expect(audit.autoload_policy).toBe('force-disabled');
    expect(audit.inserted_per_table).toEqual({ tbl_Avatar: 1, tbl_Avatar_items: 1 });
    expect(audit.resolved_ids).toEqual({ 1: 1000, 2: 1001 });
    expect(audit.new_root_id).toBe(1000);
    expect(audit.verify.every((check: { ok: boolean }) => check.ok)).toBe(true);
    expect(audit.cleanup_plan_not_executed).toHaveLength(2);
    expect(audit.load_verification).toEqual({
      attempted: false,
      note: expect.stringContaining('not wired yet')
    });

    expect(recorded.info[0]).toContain('Import finished: new DBID=1000');
    expect(recorded.info[0]).toContain('audit /audit-out/import-Avatar-1700000000.json');
    expect(recorded.info[0]).toContain(PERSISTED_NOT_LIVE);
    expect(recorded.error).toHaveLength(0);
    // 探测连接 + 写连接各关闭一次
    expect(connection.ended).toBe(2);
  });

  it('提交后 COUNT 复核不足 → 已提交但如实报错(审计仍落盘)', async () => {
    const archivePath = writeArchiveFile();
    const { deps, recorded, connection, openAsThis } = makeDeps(
      happyImportScript(archivePath, path.join(tmpRoot, 'keys'), [CONFIRM_FIRST, CONFIRM_WRITE])
    );
    replyInformationSchema(connection);
    connection.reply('SELECT COUNT(*)', [{ c: 0 }]);
    openAsThis();
    vi.mocked(inspectCloneArchive).mockResolvedValue({ status: 'ok', result: archiveMeta() });
    vi.mocked(planCloneImport).mockResolvedValue({ status: 'ok', result: importPlan() });
    vi.mocked(readCloneArchiveRows).mockResolvedValue(importRowsCall());
    await runImportCloneCommand(deps);
    expect(recorded.auditWrites).toHaveLength(1);
    expect(recorded.error[0]).toContain('Import committed but verification did not fully pass');
    expect(recorded.error[0]).toContain('/audit-out/import-Avatar-1700000000.json');
  });

  it('首次确认取消 → 返回(不写不登记)', async () => {
    const archivePath = writeArchiveFile();
    const { deps, recorded, connection, openAsThis } = makeDeps(
      happyImportScript(archivePath, path.join(tmpRoot, 'keys'), ['Cancel'])
    );
    replyInformationSchema(connection);
    openAsThis();
    vi.mocked(inspectCloneArchive).mockResolvedValue({ status: 'ok', result: archiveMeta() });
    vi.mocked(planCloneImport).mockResolvedValue({ status: 'ok', result: importPlan() });
    vi.mocked(readCloneArchiveRows).mockResolvedValue(importRowsCall());
    await runImportCloneCommand(deps);
    expect(recorded.lines.join('\n')).toContain('[Player Clone Import]');
    expect(connection.log.map(entry => entry.sql)).not.toContain('START TRANSACTION');
    expect(recorded.auditWrites).toHaveLength(0);
    expect(fs.existsSync(path.join(tmpRoot, 'keys', 'import-reservations'))).toBe(false);
  });

  it('二次确认取消 → 返回(不写不登记)', async () => {
    const archivePath = writeArchiveFile();
    const { deps, recorded, connection, openAsThis } = makeDeps(
      happyImportScript(archivePath, path.join(tmpRoot, 'keys'), [CONFIRM_FIRST, 'Cancel'])
    );
    replyInformationSchema(connection);
    openAsThis();
    vi.mocked(inspectCloneArchive).mockResolvedValue({ status: 'ok', result: archiveMeta() });
    vi.mocked(planCloneImport).mockResolvedValue({ status: 'ok', result: importPlan() });
    vi.mocked(readCloneArchiveRows).mockResolvedValue(importRowsCall());
    await runImportCloneCommand(deps);
    expect(connection.log.map(entry => entry.sql)).not.toContain('START TRANSACTION');
    expect(recorded.auditWrites).toHaveLength(0);
    // 二次确认页文案点明「真实写入」(第二次 showQuickPick 调用)
    expect(recorded.pickOptions[1].placeHolder).toContain('Second confirmation');
    expect(recorded.pickOptions[1].placeHolder).toContain('full rollback on failure');
  });

  it('keyRoot 缺失 → fail-closed(Import failed,不建写连接)', async () => {
    const archivePath = writeArchiveFile();
    const script = happyImportScript(archivePath, undefined as unknown as string, [CONFIRM_FIRST, CONFIRM_WRITE]);
    const { deps, recorded, connection, openAsThis } = makeDeps(script);
    replyInformationSchema(connection);
    openAsThis();
    vi.mocked(inspectCloneArchive).mockResolvedValue({ status: 'ok', result: archiveMeta() });
    vi.mocked(planCloneImport).mockResolvedValue({ status: 'ok', result: importPlan() });
    vi.mocked(readCloneArchiveRows).mockResolvedValue(importRowsCall());
    await runImportCloneCommand(deps);
    expect(recorded.error[0]).toContain('Import failed');
    expect(recorded.error[0]).toContain('Missing persistence directory');
    expect(connection.log.map(entry => entry.sql)).not.toContain('START TRANSACTION');
  });

  it('归档在计划期间变化 → fingerprint 不一致,fail-closed', async () => {
    const archivePath = writeArchiveFile();
    const { deps, recorded, connection, openAsThis } = makeDeps(
      happyImportScript(archivePath, path.join(tmpRoot, 'keys'), [
        // 首次确认时偷偷改归档 → 预演与提交前两次指纹不一致
        () => {
          fs.appendFileSync(archivePath, 'tampered');
          return CONFIRM_FIRST;
        },
        CONFIRM_WRITE
      ])
    );
    replyInformationSchema(connection);
    openAsThis();
    vi.mocked(inspectCloneArchive).mockResolvedValue({ status: 'ok', result: archiveMeta() });
    vi.mocked(planCloneImport).mockResolvedValue({ status: 'ok', result: importPlan() });
    vi.mocked(readCloneArchiveRows).mockResolvedValue(importRowsCall());
    await runImportCloneCommand(deps);
    expect(recorded.error[0]).toContain('Import failed');
    expect(recorded.error[0]).toContain('The archive changed while the import was being planned');
    expect(connection.log.map(entry => entry.sql)).not.toContain('START TRANSACTION');
  });

  it('重复导入登记 → 先核对指引;取消即返', async () => {
    const archivePath = writeArchiveFile();
    const keyRoot = path.join(tmpRoot, 'keys');
    // 第一次完整导入建立 reservation
    const first = makeDeps(happyImportScript(archivePath, keyRoot, [CONFIRM_FIRST, CONFIRM_WRITE]));
    replyInformationSchema(first.connection);
    first.connection.reply('sm_name IN', [{ v: 'hero' }]);
    first.connection.reply('SELECT COUNT(*)', [{ c: 1 }]);
    first.openAsThis();
    vi.mocked(inspectCloneArchive).mockResolvedValue({ status: 'ok', result: archiveMeta() });
    vi.mocked(planCloneImport).mockResolvedValue({ status: 'ok', result: importPlan() });
    vi.mocked(readCloneArchiveRows).mockResolvedValue(importRowsCall());
    await runImportCloneCommand(first.deps);
    expect(first.recorded.info).toHaveLength(1);

    // 同归档同目标再次导入 → duplicate 检出;选「取消」即返
    const second = makeDeps(happyImportScript(archivePath, keyRoot, [CONFIRM_FIRST, CONFIRM_WRITE, 'Cancel']));
    replyInformationSchema(second.connection);
    second.connection.reply('sm_name IN', [{ v: 'hero' }]);
    second.connection.reply('SELECT COUNT(*)', [{ c: 1 }]);
    second.openAsThis();
    vi.mocked(inspectCloneArchive).mockResolvedValue({ status: 'ok', result: archiveMeta() });
    vi.mocked(planCloneImport).mockResolvedValue({ status: 'ok', result: importPlan() });
    vi.mocked(readCloneArchiveRows).mockResolvedValue(importRowsCall());
    await runImportCloneCommand(second.deps);
    expect(second.recorded.lines.join('\n')).toContain('A previous import or unfinished attempt was detected');
    expect(second.recorded.pickOptions[2].placeHolder).toContain('This archive has already been imported (or attempted) on this machine for this target');
    expect(second.recorded.info).toHaveLength(0);
    // 未再写入(第二个连接无事务)
    expect(second.connection.log.map(entry => entry.sql)).not.toContain('START TRANSACTION');
  });

  it('重复导入登记 → 明确另建副本可继续导入', async () => {
    const archivePath = writeArchiveFile();
    const keyRoot = path.join(tmpRoot, 'keys');
    const first = makeDeps(happyImportScript(archivePath, keyRoot, [CONFIRM_FIRST, CONFIRM_WRITE]));
    replyInformationSchema(first.connection);
    first.connection.reply('sm_name IN', [{ v: 'hero' }]);
    first.connection.reply('SELECT COUNT(*)', [{ c: 1 }]);
    first.openAsThis();
    vi.mocked(inspectCloneArchive).mockResolvedValue({ status: 'ok', result: archiveMeta() });
    vi.mocked(planCloneImport).mockResolvedValue({ status: 'ok', result: importPlan() });
    vi.mocked(readCloneArchiveRows).mockResolvedValue(importRowsCall());
    await runImportCloneCommand(first.deps);

    const second = makeDeps(happyImportScript(archivePath, keyRoot, [CONFIRM_FIRST, CONFIRM_WRITE, CONFIRM_COPY]));
    replyInformationSchema(second.connection);
    second.connection.reply('sm_name IN', [{ v: 'hero' }]);
    second.connection.reply('SELECT COUNT(*)', [{ c: 1 }]);
    second.openAsThis();
    vi.mocked(inspectCloneArchive).mockResolvedValue({ status: 'ok', result: archiveMeta() });
    vi.mocked(planCloneImport).mockResolvedValue({ status: 'ok', result: importPlan() });
    vi.mocked(readCloneArchiveRows).mockResolvedValue(importRowsCall());
    await runImportCloneCommand(second.deps);
    expect(second.recorded.info[0]).toContain('Import finished');
  });

  it('Apply 期取消 → 警告回滚(未写入任何行)', async () => {
    const archivePath = writeArchiveFile();
    const { deps, recorded, connection, openAsThis } = makeDeps({
      ...happyImportScript(archivePath, path.join(tmpRoot, 'keys'), [CONFIRM_FIRST, CONFIRM_WRITE]),
      cancelledProgress: true
    });
    replyInformationSchema(connection);
    connection.reply('sm_name IN', [{ v: 'hero' }]);
    openAsThis();
    vi.mocked(inspectCloneArchive).mockResolvedValue({ status: 'ok', result: archiveMeta() });
    vi.mocked(planCloneImport).mockResolvedValue({ status: 'ok', result: importPlan() });
    vi.mocked(readCloneArchiveRows).mockResolvedValue(importRowsCall());
    await runImportCloneCommand(deps);
    expect(recorded.auditWrites).toHaveLength(0);
    expect(recorded.warn).toEqual(['Import cancelled: the transaction was rolled back; no rows were written.']);
    const log = connection.log.map(entry => entry.sql);
    expect(log).toContain('ROLLBACK');
    expect(log).not.toContain('COMMIT');
    // 取消在第一条 INSERT 前抵达(循环顶检查)
    expect(log.filter(sql => sql.startsWith('INSERT INTO'))).toHaveLength(0);
  });

  it('COMMIT 结果不确定 → 「Import outcome uncertain」指引(不引导重试)', async () => {
    const archivePath = writeArchiveFile();
    const { deps, recorded, connection, openAsThis } = makeDeps(
      happyImportScript(archivePath, path.join(tmpRoot, 'keys'), [CONFIRM_FIRST, CONFIRM_WRITE])
    );
    replyInformationSchema(connection);
    connection.reply('FROM tbl_Avatar WHERE', [{ v: 'hero' }]);
    connection.failOn('COMMIT');
    openAsThis();
    vi.mocked(inspectCloneArchive).mockResolvedValue({ status: 'ok', result: archiveMeta() });
    vi.mocked(planCloneImport).mockResolvedValue({ status: 'ok', result: importPlan() });
    vi.mocked(readCloneArchiveRows).mockResolvedValue(importRowsCall());
    await runImportCloneCommand(deps);
    expect(recorded.error[0]).toContain('Import outcome uncertain');
    expect(recorded.error[0]).toContain('COMMIT outcome unknown');
    expect(recorded.error[0]).toContain('do not retry blindly');
  });

  it('提交后复核抛错(ClonePostCommitError)→ 与已提交同指引', async () => {
    const archivePath = writeArchiveFile();
    const { deps, recorded, connection, openAsThis } = makeDeps(
      happyImportScript(archivePath, path.join(tmpRoot, 'keys'), [CONFIRM_FIRST, CONFIRM_WRITE])
    );
    replyInformationSchema(connection);
    connection.reply('FROM tbl_Avatar WHERE', [{ v: 'hero' }]);
    connection.failOn('SELECT COUNT(*)');
    openAsThis();
    vi.mocked(inspectCloneArchive).mockResolvedValue({ status: 'ok', result: archiveMeta() });
    vi.mocked(planCloneImport).mockResolvedValue({ status: 'ok', result: importPlan() });
    vi.mocked(readCloneArchiveRows).mockResolvedValue(importRowsCall());
    await runImportCloneCommand(deps);
    expect(recorded.error[0]).toContain('Import committed, but verification or audit failed');
    expect(recorded.error[0]).toContain('do not retry blindly');
  });

  it('审计落盘失败(已提交)→ 与已提交同指引', async () => {
    const archivePath = writeArchiveFile();
    const { deps, recorded, connection, openAsThis } = makeDeps({
      ...happyImportScript(archivePath, path.join(tmpRoot, 'keys'), [CONFIRM_FIRST, CONFIRM_WRITE]),
      failAuditWrite: true
    });
    replyInformationSchema(connection);
    connection.reply('FROM tbl_Avatar WHERE', [{ v: 'hero' }]);
    connection.reply('SELECT COUNT(*)', [{ c: 1 }]);
    openAsThis();
    vi.mocked(inspectCloneArchive).mockResolvedValue({ status: 'ok', result: archiveMeta() });
    vi.mocked(planCloneImport).mockResolvedValue({ status: 'ok', result: importPlan() });
    vi.mocked(readCloneArchiveRows).mockResolvedValue(importRowsCall());
    await runImportCloneCommand(deps);
    expect(recorded.error[0]).toContain('Import committed, but verification or audit failed');
    expect(recorded.error[0]).toContain('audit disk full');
  });

  it('写连接建立失败 → 通用失败指引(携目标)', async () => {
    const archivePath = writeArchiveFile();
    const { deps, recorded } = makeDeps(
      happyImportScript(archivePath, path.join(tmpRoot, 'keys'), [CONFIRM_FIRST, CONFIRM_WRITE])
    );
    vi.mocked(inspectCloneArchive).mockResolvedValue({ status: 'ok', result: archiveMeta() });
    vi.mocked(planCloneImport).mockResolvedValue({ status: 'ok', result: importPlan() });
    vi.mocked(readCloneArchiveRows).mockResolvedValue(importRowsCall());
    // 第一次建连(探测)成功,第二次(写事务)拒绝
    vi.mocked(openCloneSession)
      .mockResolvedValueOnce(new FakeMysqlConnection() as unknown as CloneMysqlConnection)
      .mockRejectedValueOnce(new Error('write conn refused'));
    await runImportCloneCommand(deps);
    expect(recorded.error[0]).toContain('Import failed');
    expect(recorded.error[0]).toContain('write conn refused');
    expect(recorded.error[0]).toContain('127.0.0.1:13307/kbe_local');
  });

  it('连接关闭失败不吞导入结果(通道记账)', async () => {
    const archivePath = writeArchiveFile();
    const { deps, recorded } = makeDeps(
      happyImportScript(archivePath, path.join(tmpRoot, 'keys'), [CONFIRM_FIRST, CONFIRM_WRITE])
    );
    // 探测连接正常;写连接 end 抛错(只影响收尾记账,不吞导入结果)
    const probe = new FakeMysqlConnection();
    replyInformationSchema(probe);
    probe.reply('sm_name IN', [{ v: 'hero' }]);
    const write = new FakeMysqlConnection();
    write.reply('SELECT COUNT(*)', [{ c: 1 }]);
    write.end = async () => {
      throw new Error('socket already closed');
    };
    vi.mocked(openCloneSession)
      .mockResolvedValueOnce(probe as unknown as CloneMysqlConnection)
      .mockResolvedValueOnce(write as unknown as CloneMysqlConnection);
    vi.mocked(inspectCloneArchive).mockResolvedValue({ status: 'ok', result: archiveMeta() });
    vi.mocked(planCloneImport).mockResolvedValue({ status: 'ok', result: importPlan() });
    vi.mocked(readCloneArchiveRows).mockResolvedValue(importRowsCall());
    await runImportCloneCommand(deps);
    expect(recorded.info[0]).toContain('Import finished');
    expect(recorded.lines.join('\n')).toContain('Failed to close the connection: Error: socket already closed');
  });
});

// ---------------------------------------------------------------------------
// 0505 审计查看
// ---------------------------------------------------------------------------

describe('runShowCloneAuditCommand(0505)', () => {
  it('无审计记录 → 警告', async () => {
    const { deps, recorded } = makeDeps({ auditFiles: [] });
    await runShowCloneAuditCommand(deps);
    expect(recorded.warn).toEqual(['No import audit records yet (.kode/clone-runs/).']);
  });

  it('选择取消 → 返回', async () => {
    const { deps, recorded } = makeDeps({ auditFiles: ['a.json'], picks: [undefined] });
    await runShowCloneAuditCommand(deps);
    expect(recorded.lines).toHaveLength(0);
    expect(recorded.pickOptions[0].placeHolder).toContain('Select an import audit to view');
  });

  it('读取失败 → 如实报错', async () => {
    const { deps, recorded } = makeDeps({ auditFiles: ['a.json'], picks: ['a.json'], auditContent: null });
    await runShowCloneAuditCommand(deps);
    expect(recorded.error).toEqual(['Failed to read the audit: a.json']);
  });

  it('读取成功 → 审计全文落输出通道', async () => {
    const { deps, recorded } = makeDeps({
      auditFiles: ['a.json'],
      picks: ['a.json'],
      auditContent: '{"kind":"player-clone-import-run"}'
    });
    await runShowCloneAuditCommand(deps);
    expect(recorded.lines).toEqual([
      '[Player Clone Audit] a.json\n{"kind":"player-clone-import-run"}'
    ]);
    expect(recorded.shows).toBe(1);
  });
});
