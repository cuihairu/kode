/**
 * Player Data Clone 命令编排(CLONE-P5 / PDC-0501..0507,计划书 §7):
 * - 连接 Profile 配置/测试(0501):Source 只读源 + Target 本地可写目标;
 * - 导出(0502):实体/DBID 选择 → 只读计划预览 → 只读会话执行 → .kdpclone;
 * - 归档浏览(0503):清单/哈希状态/脱敏状态;不回行值,默认不展示敏感值;
 * - 导入(0504/0505):两遍计划(pass-1 列序 → 唯一值有界探测 → pass-2 冲突
 *   预演)→ 预览(冲突/绑定/告警/Persisted≠Live)→ 本地环境二次确认 →
 *   进度+取消(取消即回滚)→ 审计落盘;
 * - 审计查看(0505):.kode/clone-runs/ 下的 run 记录回显;
 * - 加载验证(0506):提交后 COUNT 复核如实展示;引擎侧原生加载验证需要
 *   本地 KBEngine 运行环境,未接线部分如实说明,不虚报。
 *
 * 文案双语(0507):zh 主文案 + 括注英文术语;关键告示「数据库已持久化数据副本
 * (Persisted copy)≠ 在线当前状态(Live state)」在导出/导入两面都出现。
 *
 * 无 vscode import:UI/连接/文件面全部经 deps 注入(单测驱动纯编排)。
 */

import type { CloneProfileRole, CloneProfileStore } from './playerDataCloneProfiles';
import { fingerprintCloneArchive, reserveCloneImport } from './playerDataCloneImportGuard';
import {
  applyImportPlan,
  CloneApplyCancelledError,
  CloneCancelledError,
  CloneCommitUnknownError,
  ClonePostCommitError,
  CloneRollbackUnknownError,
  columnOrderFromPlan,
  executeExportPlan,
  openCloneSession,
  probeExistingValues,
  probePhysicalTables,
  testCloneConnection,
  uniqueValuesFromRows
} from './playerDataCloneMysql';
import {
  inspectCloneArchive,
  planCloneExport,
  planCloneImport,
  readCloneArchiveRows,
  writeCloneArchive
} from './playerDataCloneRust';
import type { ArchiveMetaWire, ImportPlanWire, TypedRowWire } from './playerDataCloneWire';

/** 实体推导表描述符(结构子集;形状由 databaseSchema 快照保证)。 */
export interface EntityTableDescriptorLike {
  name: string;
}

export interface PlayerCloneCommandDeps {
  profiles: CloneProfileStore;
  listEntityNames(): string[];
  /** 实体 → 推导表(databaseSchema 快照;读不到 = null,不猜)。 */
  resolveEntityTables(entityName: string): EntityTableDescriptorLike[] | null;
  showQuickPick(items: readonly string[], options: { placeHolder: string }): Promise<string | undefined>;
  showInputBox(options: {
    prompt: string;
    password?: boolean;
    validateInput?(value: string): string | null;
  }): Promise<string | undefined>;
  showInformationMessage(message: string): Promise<unknown>;
  showWarningMessage(message: string, ...items: string[]): Promise<unknown>;
  showErrorMessage(message: string): Promise<unknown>;
  withProgress<R>(
    options: { title: string; cancellable: boolean },
    task: (token: { isCancellationRequested: boolean }) => Promise<R>
  ): Promise<R>;
  /** 导出归档保存路径选择;取消 = undefined。 */
  pickArchiveSavePath(defaultName: string): Promise<string | undefined>;
  /** 导入归档选择;取消 = undefined。 */
  pickArchiveOpenPath(): Promise<string | undefined>;
  /** 审计落盘面;路径由调用方决定(工作区 .kode/clone-runs)。 */
  writeAuditFile(name: string, content: string): Promise<string>;
  listAuditFiles(): Promise<string[]>;
  readAuditFile(path: string): Promise<string | null>;
  /**
   * 归档加密密钥根目录(globalStorage 下的 clone-keys;密钥材料全程留
   * Rust,TS 只传目录路径)。undefined=不加密(测试替身/旧装配兼容)。
   */
  getKeyRoot(): string | undefined;
  /**
   * 归档加密默认值(kbengine.clone.archiveEncryption;缺省 = 'encrypted')。
   * 只作导出确认页的初始态,导出时每次可切换(PDC-0609);读面不受影响
   * (加密位探测定,明文/加密归档都能读)。
   */
  getArchiveEncryptionDefault?(): 'encrypted' | 'plain';
  channel: { appendLine(line: string): void; show(preserveFocus?: boolean): void };
  now(): number;
}

const PERSISTED_NOT_LIVE =
  '这是数据库已持久化数据副本(Persisted copy),不代表在线当前状态(Live state)。';

const noGateMessage =
  'Player Data Clone 需要 Rust 后端(kode-server)可用:请检查 kode-core server 配置。';

function describeCallFailure(what: string, reason: string): string {
  return `${what}失败: ${reason}`;
}

// ---------------------------------------------------------------------------
// 0609 导出加密选择(设置默认 + 导出确认页逐次切换)
// ---------------------------------------------------------------------------

export const EXPORT_CONFIRM_ITEM = '导出(Export)';
export const EXPORT_CANCEL_ITEM = '取消(Cancel)';
const ENCRYPTED_LABEL = '加密(本机钥匙)';
const PLAIN_LABEL = '明文(可跨机转移)';

/**
 * 导出确认页的加密选择循环:确认项文案携带当前加密态,切换项反复翻转,
 * 直至导出/取消。confirmed=false 即退出导出流程(取消/关窗)。
 */
export async function pickExportEncryption(
  pick: (
    items: readonly string[],
    options: { placeHolder: string }
  ) => Promise<string | undefined>,
  queryCount: number,
  defaultEncrypt: boolean
): Promise<{ confirmed: boolean; encrypt: boolean }> {
  let encrypt = defaultEncrypt;
  for (;;) {
    const picked = await pick(
      [
        `${EXPORT_CONFIRM_ITEM},${encrypt ? ENCRYPTED_LABEL : PLAIN_LABEL}`,
        `切换加密 → ${encrypt ? PLAIN_LABEL : ENCRYPTED_LABEL}`,
        EXPORT_CANCEL_ITEM
      ],
      { placeHolder: `确认导出 ${queryCount} 条只读查询的结果到归档?` }
    );
    if (!picked || picked === EXPORT_CANCEL_ITEM) {
      return { confirmed: false, encrypt };
    }
    if (picked.startsWith('切换加密')) {
      encrypt = !encrypt;
      continue;
    }
    return { confirmed: true, encrypt };
  }
}

// ---------------------------------------------------------------------------
// 0501 连接 Profile 配置 / 测试
// ---------------------------------------------------------------------------

export async function runConfigureCloneProfileCommand(
  deps: PlayerCloneCommandDeps,
  role: CloneProfileRole
): Promise<void> {
  const host = await deps.showInputBox({
    prompt: role === 'source' ? '源库主机(Source host)' : '目标库主机(Target host,仅本地/测试库)',
    validateInput: value => value.trim() ? null : '请输入主机地址'
  });
  if (host === undefined) {
    return;
  }
  const portText = await deps.showInputBox({
    prompt: '端口(Port,默认 3306)',
    validateInput: value => {
      if (value === '') { return null; }
      if (!/^\d+$/.test(value)) { return '端口必须是数字'; }
      const port = Number(value);
      return port >= 1 && port <= 65535 ? null : '端口必须在 1 到 65535 之间';
    }
  });
  if (portText === undefined) {
    return;
  }
  const user = await deps.showInputBox({ prompt: '用户名(User)', validateInput: value => value.trim() ? null : '请输入用户名' });
  if (user === undefined) {
    return;
  }
  const password = await deps.showInputBox({ prompt: '密码(Password,留空 = 不保存;只存 SecretStorage,不进配置文件)', password: true });
  if (password === undefined) {
    return;
  }
  const database = await deps.showInputBox({ prompt: '数据库(Database)', validateInput: value => value.trim() ? null : '请输入数据库名称' });
  if (database === undefined) {
    return;
  }
  if (role === 'target') {
    // §6.1:目标环境显式声明,只认 local/test。
    const environment = await deps.showQuickPick(['local', 'test'], {
      placeHolder: '目标环境(Environment;prod/staging 不允许导入)'
    });
    if (environment !== 'local' && environment !== 'test') {
      return;
    }
    await deps.profiles.save(
      'target',
      { host, port: portText === '' ? 3306 : Number(portText), user, database, environment },
      password === '' ? null : password
    );
  } else {
    await deps.profiles.save(
      'source',
      { host, port: portText === '' ? 3306 : Number(portText), user, database },
      password === '' ? null : password
    );
  }
  await deps.showInformationMessage(
    role === 'source' ? 'Source 连接配置已保存。' : 'Target 连接配置已保存。'
  );
}

export async function runTestCloneConnectionCommand(
  deps: PlayerCloneCommandDeps,
  role: CloneProfileRole
): Promise<void> {
  const config = await deps.profiles.resolveConnection(role);
  if (!config) {
    await deps.showWarningMessage(
      role === 'source' ? '尚未配置 Source 连接。' : '尚未配置 Target 连接。'
    );
    return;
  }
  try {
    const connection = await openCloneSession(config);
    try {
      const result = await testCloneConnection(connection);
      if (result.ok) {
        await deps.showInformationMessage(
          `${role === 'source' ? 'Source' : 'Target'} 连接成功(服务器版本 ${result.version})。`
        );
      } else {
        await deps.showErrorMessage(`连接失败: ${result.reason}`);
      }
    } finally {
      await connection.end();
    }
  } catch (error) {
    await deps.showErrorMessage(
      `连接失败: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

// ---------------------------------------------------------------------------
// 0503 归档浏览
// ---------------------------------------------------------------------------

function renderArchiveSummary(meta: ArchiveMetaWire): string[] {
  const lines = [
    `归档实体(Entity): ${meta.entity}`,
    `格式(Format): ${meta.format} v${meta.version}`,
    `总行数(Rows): ${meta.total_rows}`,
    `数据帧字节(Data bytes): ${meta.total_bytes}`,
    `加密(Encrypted): ${meta.encrypted ? '是' : '否(明文)'}`
  ];
  for (const table of meta.tables) {
    lines.push(`- ${table.name}: ${table.rows} 行`);
  }
  lines.push(`校验文件(Checksums): ${meta.files.includes('checksums.json') ? 'checksums.json ✓' : '缺失'}`);
  lines.push(`脱敏报告(Redaction report): ${meta.files.includes('redaction-report.json') ? 'redaction-report.json ✓' : '缺失'}`);
  lines.push(PERSISTED_NOT_LIVE);
  return lines;
}

export async function runInspectCloneArchiveCommand(
  deps: PlayerCloneCommandDeps,
  archivePath?: string
): Promise<void> {
  const path = archivePath ?? (await deps.pickArchiveOpenPath());
  if (!path) {
    return;
  }
  const inspected = await inspectCloneArchive(path, deps.getKeyRoot());
  if (inspected.status === 'no-gate') {
    await deps.showErrorMessage(noGateMessage);
    return;
  }
  if (inspected.status === 'error') {
    await deps.showErrorMessage(describeCallFailure('读取归档清单', inspected.reason));
    return;
  }
  const lines = [`[Player Clone] ${path}`, ...renderArchiveSummary(inspected.result)];
  deps.channel.appendLine(lines.join('\n'));
  deps.channel.show(true);
  await deps.showInformationMessage(`归档清单已输出(${inspected.result.entity},${inspected.result.total_rows} 行)。${PERSISTED_NOT_LIVE}`);
}

// ---------------------------------------------------------------------------
// 0502 导出
// ---------------------------------------------------------------------------

export async function runExportCloneCommand(deps: PlayerCloneCommandDeps): Promise<void> {
  const entityNames = deps.listEntityNames();
  if (entityNames.length === 0) {
    await deps.showWarningMessage('工作区未发现已注册实体(请先打开 KBEngine 工程)。');
    return;
  }
  let config = await deps.profiles.resolveConnection('source');
  if (!config) {
    const choice = await deps.showWarningMessage('尚未配置 Source 连接(先运行「配置 Source 连接」)。', '配置源连接');
    if (choice !== '配置源连接') { return; }
    await runConfigureCloneProfileCommand(deps, 'source');
    config = await deps.profiles.resolveConnection('source');
    if (!config) { return; }
  }
  const entityName = await deps.showQuickPick(entityNames, {
    placeHolder: '选择要导出的实体(Entity)'
  });
  if (!entityName) {
    return;
  }
  const dbidText = await deps.showInputBox({
    prompt: '根表 DBID(实体主键 id)',
    validateInput: value => (/^\d+$/.test(value) ? null : 'DBID 必须是数字')
  });
  if (dbidText === undefined) {
    return;
  }
  const derivationTables = deps.resolveEntityTables(entityName);
  if (!derivationTables || derivationTables.length === 0) {
    await deps.showErrorMessage(`无法从工作区 def 推导实体 ${entityName} 的表结构。`);
    return;
  }

  const savePath = await deps.pickArchiveSavePath(`${entityName}-${dbidText}.kdpclone`);
  if (!savePath) {
    return;
  }

  try {
    const connection = await openCloneSession(config);
    try {
      const tableNames = derivationTables.map(table => table.name);
      const physicalTables = await probePhysicalTables(connection, tableNames);
      const plan = await planCloneExport({ tables: derivationTables }, physicalTables);
      if (plan.status === 'no-gate') {
        await deps.showErrorMessage(noGateMessage);
        return;
      }
      if (plan.status === 'error') {
        await deps.showErrorMessage(describeCallFailure('生成导出计划', plan.reason));
        return;
      }
      const preview = [
        `[Player Clone Export] ${entityName} DBID=${dbidText}`,
        `表(Tables): ${plan.result.queries.map(q => q.table).join(', ')}`,
        `行预算(Row budget): ${plan.result.row_budget}`
      ];
      if (plan.result.missing.length > 0) {
        preview.push(`源库缺失表(Missing in source): ${plan.result.missing.join(', ')}`);
      }
      preview.push(PERSISTED_NOT_LIVE);
      deps.channel.appendLine(preview.join('\n'));
      deps.channel.show(true);

      const encryptionChoice = await pickExportEncryption(
        deps.showQuickPick,
        plan.result.queries.length,
        (deps.getArchiveEncryptionDefault?.() ?? 'encrypted') === 'encrypted'
      );
      if (!encryptionChoice.confirmed) {
        return;
      }

      const rows = await deps.withProgress(
        { title: `Player Clone: 读取 ${entityName} 数据(可取消)`, cancellable: true },
        token => executeExportPlan(connection, plan.result, BigInt(dbidText), {
          shouldCancel: () => token.isCancellationRequested
        })
      );
      if (rows.length === 0) {
        await deps.showWarningMessage(`DBID=${dbidText} 在源库没有读到任何行(未导出)。`);
        return;
      }
      const written = await writeCloneArchive(
        savePath,
        entityName,
        rows,
        plan.result,
        encryptionChoice.encrypt ? deps.getKeyRoot() : undefined
      );
      if (written.status === 'no-gate') {
        await deps.showErrorMessage(noGateMessage);
        return;
      }
      if (written.status === 'error') {
        await deps.showErrorMessage(describeCallFailure('写归档', written.reason));
        return;
      }
      await deps.showInformationMessage(
        `导出完成:${written.result.total_rows} 行 → ${savePath}(敏感列已脱敏,` +
          `${encryptionChoice.encrypt ? '归档已加密' : '归档为明文(未加密)'})。${PERSISTED_NOT_LIVE}`
      );
    } finally {
      try {
        await connection.end();
      } catch (closeError) {
        // A cancelled or timed-out stream may already have closed the socket.
        // Do not replace the original export outcome with a close error.
        deps.channel.appendLine(`[Player Clone] 关闭只读连接失败: ${String(closeError)}`);
      }
    }
  } catch (error) {
    if (error instanceof CloneCancelledError) {
      await deps.showWarningMessage('导出已取消(只读面,无需回滚)。');
      return;
    }
    await deps.showErrorMessage(
      `导出失败: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

// ---------------------------------------------------------------------------
// 0504/0505 导入(两遍计划 + 预演 + 二次确认 + 单事务 Apply + 审计)
// ---------------------------------------------------------------------------

export async function runImportCloneCommand(
  deps: PlayerCloneCommandDeps,
  archivePath?: string
): Promise<void> {
  const path = archivePath ?? (await deps.pickArchiveOpenPath());
  if (!path) {
    return;
  }
  const targetConfig = await deps.profiles.resolveConnection('target');
  if (!targetConfig) {
    await deps.showWarningMessage('尚未配置 Target 连接(仅 local/test;先运行「配置 Target 连接」)。');
    return;
  }

  const inspected = await inspectCloneArchive(path, deps.getKeyRoot());
  if (inspected.status !== 'ok') {
    await deps.showErrorMessage(
      inspected.status === 'no-gate' ? noGateMessage : describeCallFailure('读取归档清单', inspected.reason)
    );
    return;
  }
  const entityName = inspected.result.entity;
  const derivationTables = deps.resolveEntityTables(entityName);
  if (!derivationTables || derivationTables.length === 0) {
    await deps.showErrorMessage(`无法从工作区 def 推导实体 ${entityName} 的表结构(导入需要目标 schema 对账)。`);
    return;
  }

  let committed = false;
  try {
    const plannedFingerprint = await fingerprintCloneArchive(path);
    const connection = await openCloneSession(targetConfig);
    let plan: ImportPlanWire | null = null;
    let rowsByTable = new Map<string, TypedRowWire[]>();
    let columnOrder = new Map<string, string[]>();
    try {
      const tableNames = derivationTables.map(table => table.name);
      const physicalTables = await probePhysicalTables(connection, tableNames);
      // 唯一键 = 目标单列唯一索引(探测自 information_schema;复合键 v1 不预演,
      // 插入期冲突仍会 fail-closed 回滚)。
      const uniqueKeys = physicalTables
        .filter(table => table.indexes.some(columns => columns.length === 1))
        .flatMap(table =>
          table.indexes
            .filter(columns => columns.length === 1)
            .map(columns => ({ table: table.name, column: columns[0] }))
        );

      // pass-1:空快照计划 → 列序(归档行不带列名,值序=导出列序)。
      const pass1 = await planCloneImport(
        path,
        {
          environment: targetConfig.environment === 'test' ? 'test' : 'local',
          dbInterface: 'mysql',
          writable: true,
          host: targetConfig.host,
          port: targetConfig.port,
          database: targetConfig.database
        },
        { tables: derivationTables },
        physicalTables,
        { uniqueKeys, existingValues: [] },
        deps.getKeyRoot()
      );
      if (pass1.status === 'no-gate') {
        await deps.showErrorMessage(noGateMessage);
        return;
      }
      if (pass1.status === 'error') {
        await deps.showErrorMessage(describeCallFailure('生成导入计划', pass1.reason));
        return;
      }
      columnOrder = columnOrderFromPlan(pass1.result);

      // 归档行 → 唯一值候选 → 目标既有值有界探测 → pass-2 冲突预演。
      const rowsCall = await readCloneArchiveRows(path, deps.getKeyRoot());
      if (rowsCall.status === 'no-gate') {
        await deps.showErrorMessage(noGateMessage);
        return;
      }
      if (rowsCall.status === 'error') {
        await deps.showErrorMessage(describeCallFailure('读取归档行', rowsCall.reason));
        return;
      }
      rowsByTable = new Map(rowsCall.result.tables.map(t => [t.name, t.rows]));
      const candidates = uniqueValuesFromRows(rowsByTable, columnOrder, uniqueKeys);
      const existingValues =
        candidates.length > 0 ? await probeExistingValues(connection, candidates) : [];

      const pass2 = await planCloneImport(
        path,
        {
          environment: targetConfig.environment === 'test' ? 'test' : 'local',
          dbInterface: 'mysql',
          writable: true,
          host: targetConfig.host,
          port: targetConfig.port,
          database: targetConfig.database
        },
        { tables: derivationTables },
        physicalTables,
        { uniqueKeys, existingValues },
        deps.getKeyRoot()
      );
      if (pass2.status !== 'ok') {
        await deps.showErrorMessage(
          pass2.status === 'no-gate' ? noGateMessage : describeCallFailure('导入预演', pass2.reason)
        );
        return;
      }
      plan = pass2.result;
    } finally {
      // 探测连接是只读会话;Apply 需要写事务,重开一条(同配置)。
      await connection.end();
    }
    if (!plan) {
      return;
    }
    const confirmedPlan: ImportPlanWire = plan;

    // ---- 预览(PDC-0504:逐表/逐类别/冲突/绑定/告警 + Persisted≠Live) ----
    const perTable = Object.entries(plan.summary.statements_per_table)
      .map(([table, count]) => `${table}×${count}`)
      .join(', ');
    const categories = Object.entries(plan.summary.id_categories)
      .map(([label, count]) => `${label}×${count}`)
      .join(', ');
    const previewLines = [
      `[Player Clone Import] ${path}`,
      `实体(Entity): ${plan.entity_name}`,
      `语句(Statements): ${perTable}`,
      `ID 变更类别(ID categories): ${categories || '无'}`,
      `唯一键冲突(Unique conflicts): ${plan.summary.unique_conflicts}(策略:本地重建 _imported 后缀)`,
      `账号绑定(Account binding): ${plan.account_binding.note}`,
      `未解决引用风险(Unresolved references): ${plan.summary.unresolved_reference_risks}`
    ];
    for (const warning of plan.warnings) {
      previewLines.push(`- 告警: ${warning}`);
    }
    previewLines.push(PERSISTED_NOT_LIVE);
    deps.channel.appendLine(previewLines.join('\n'));
    deps.channel.show(true);

    const firstConfirm = await deps.showQuickPick(
      ['继续到确认(Continue)', '取消(Cancel)'],
      { placeHolder: `导入 ${plan.statements.length} 条语句到 ${targetConfig.database}?` }
    );
    if (firstConfirm !== '继续到确认(Continue)') {
      return;
    }
    // 本地环境二次确认(§6.1:目标必须是本地/测试库,写入不可伪装成预演)。
    const secondConfirm = await deps.showQuickPick(
      [
        `确认写入本地库 ${targetConfig.host}:${targetConfig.port}/${targetConfig.database}(Confirm import)`,
        '取消(Cancel)'
      ],
      { placeHolder: '第二次确认:这是对本地/测试数据库的真实写入(单事务,失败全量回滚)。'
      }
    );
    if (!secondConfirm || !secondConfirm.startsWith('确认写入')) {
      return;
    }

    // Persist before any database writes. An interrupted or ambiguous attempt must
    // continue to block automatic retries across extension restarts.
    const keyRoot = deps.getKeyRoot();
    if (!keyRoot) {
      throw new Error('缺少持久化目录，无法保护重复导入');
    }
    const fingerprint = await fingerprintCloneArchive(path);
    if (fingerprint !== plannedFingerprint) {
      throw new Error('归档在导入计划期间发生变化，请重新预演');
    }
    const reservation = await reserveCloneImport(keyRoot, fingerprint, targetConfig);
    if (reservation.duplicate) {
      deps.channel.appendLine(`[Player Clone] 检测到此前导入或未完成尝试: ${reservation.reservation}\n${reservation.prior ?? ''}`);
      deps.channel.show(true);
      const choice = await deps.showQuickPick(
        ['取消(Cancel)', '明确另建副本(Create another copy)'],
        { placeHolder: '此归档已在本机向该目标导入或尝试过，先核对目标数据库。' }
      );
      if (choice !== '明确另建副本(Create another copy)') {
        return;
      }
    }

    // ---- Apply:重开连接(写事务;readonly:false)+ 进度 + 取消(§6.4 取消即回滚) ----
    const writeConnection = await openCloneSession(targetConfig, { readonly: false });
    try {
      const result = await deps.withProgress(
        { title: `Player Clone: 导入 ${entityName}(取消 = 回滚)`, cancellable: true },
        token =>
          applyImportPlan(writeConnection, confirmedPlan, rowsByTable, columnOrder, {
            shouldCancel: () => token.isCancellationRequested
          })
      );
      committed = true;
      const verifyOk = result.verify.every(check => check.ok);
      const audit = {
        kind: 'player-clone-import-run',
        finished_at_unix: Math.floor(deps.now() / 1000),
        archive_path: path,
        entity: plan.entity_name,
        mode: plan.mode,
        autoload_policy: plan.autoload_policy,
        inserted_per_table: result.insertedPerTable,
        resolved_ids: result.resolvedIds,
        new_root_id: result.newRootId,
        verify: result.verify,
        cleanup_plan_not_executed: result.cleanup,
        load_verification: {
          attempted: false,
          note: '引擎侧加载验证需要本地 KBEngine 运行环境(PDC-0003),当前未接线;提交后 COUNT 复核如上。'
        }
      };
      const auditPath = await deps.writeAuditFile(
        `import-${plan.entity_name}-${Math.floor(deps.now() / 1000)}.json`,
        JSON.stringify(audit, null, 2)
      );
      if (!verifyOk) {
        await deps.showErrorMessage(
          `导入已提交但复核未全过(见审计 ${auditPath});数据本身原子完整,请人工核对。`
        );
        return;
      }
      await deps.showInformationMessage(
        `导入完成:新 DBID=${result.newRootId ?? '(保留原值)'};审计 ${auditPath};清理计划已生成未执行。${PERSISTED_NOT_LIVE}`
      );
    } finally {
      try {
        await writeConnection.end();
      } catch (closeError) {
        deps.channel.appendLine(`[Player Clone] 关闭连接失败: ${String(closeError)}`);
      }
    }
  } catch (error) {
    const target = `${targetConfig.host}:${targetConfig.port}/${targetConfig.database}`;
    const detail = error instanceof Error ? error.message : String(error);
    if (committed || error instanceof ClonePostCommitError) {
      await deps.showErrorMessage(`导入已提交，但复核或审计失败：${detail}。请先核对目标 ${target} 和归档 ${path}，不要直接重试。`);
      return;
    }
    if (error instanceof CloneCommitUnknownError || error instanceof CloneRollbackUnknownError) {
      await deps.showErrorMessage(`导入结果不确定：${detail}。请先核对目标 ${target} 和归档 ${path}，不要直接重试。`);
      return;
    }
    if (error instanceof CloneApplyCancelledError) {
      await deps.showWarningMessage('导入已取消:事务已回滚,未写入任何行。');
      return;
    }
    await deps.showErrorMessage(
      `导入失败：${detail}。目标 ${target}；请核对后再重试。`
    );
  }
}

// ---------------------------------------------------------------------------
// 0505 审计查看
// ---------------------------------------------------------------------------

export async function runShowCloneAuditCommand(deps: PlayerCloneCommandDeps): Promise<void> {
  const files = await deps.listAuditFiles();
  if (files.length === 0) {
    await deps.showWarningMessage('暂无导入审计记录(.kode/clone-runs/)。');
    return;
  }
  const picked = await deps.showQuickPick(files, { placeHolder: '选择要查看的导入审计(Import run)' });
  if (!picked) {
    return;
  }
  const content = await deps.readAuditFile(picked);
  if (content === null) {
    await deps.showErrorMessage(`读取审计失败: ${picked}`);
    return;
  }
  deps.channel.appendLine(`[Player Clone Audit] ${picked}\n${content}`);
  deps.channel.show(true);
}
