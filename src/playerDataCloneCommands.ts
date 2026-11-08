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
  /** Inject VS Code localization at the UI boundary; tests and non-VS Code callers may omit it. */
  localize?(message: string): string;
  profiles: CloneProfileStore;
  listEntityNames(): string[];
  /** 实体 → 推导表(databaseSchema 快照;读不到 = null,不猜)。 */
  resolveEntityTables(entityName: string): EntityTableDescriptorLike[] | null;
  showQuickPick(items: readonly string[], options: { placeHolder: string }): Promise<string | undefined>;
  showInputBox(options: {
    prompt: string;
    /** 既有配置预填(005a:已输入的非密码信息跨前进/返回保留);密码绝不预填 */
    value?: string;
    /** 输入框上方标题(005a:展示角色与步骤序号,如 "Source 2/5") */
    title?: string;
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
// 0501 连接 Profile 配置 / 测试(UX-REVIEW-005a/005c 分步向导)
// ---------------------------------------------------------------------------

/** 摘要页动作(005c):保存 / 测试连接 / 返回修改 / 取消;选择按同一值判断。 */
export const CLONE_SUMMARY_SAVE = '保存(Save)';
export const CLONE_SUMMARY_TEST = '测试连接(Test connection)';
export const CLONE_SUMMARY_EDIT = '返回修改(Edit)';
export const CLONE_SUMMARY_CANCEL = '取消(Cancel)';
/**
 * 保留已存密码(005d 明确保留语义):仅在已存密钥且本次密码输入留空时
 * 出现;选中后以 save(password=undefined) 落盘,SecretStorage 旧密钥原样
 * 保留——与「保存(留空=清除)」形成一对明确语义。
 */
export const CLONE_SUMMARY_KEEP_SECRET = '保留已存密码(Keep stored password)';

/** 输入步骤草稿:全程内存态,只有摘要页选「保存」才落盘(取消不写半成品)。 */
interface CloneProfileDraft {
  host: string;
  portText: string;
  user: string;
  /** '' = 清除已存密码(既有口径);非空 = 覆盖。摘要绝不回显本值。 */
  password: string;
  database: string;
  environment?: 'local' | 'test';
}

const roleLabel = (role: CloneProfileRole): string => (role === 'source' ? 'Source' : 'Target');

export async function runConfigureCloneProfileCommand(
  deps: PlayerCloneCommandDeps,
  role: CloneProfileRole
): Promise<void> {
  const t = (message: string): string => deps.localize?.(message) ?? message;
  const existing = deps.profiles.get(role);
  // 005a:既有配置预填非密码字段(成功保存后可再次修改);密码绝不回填。
  const draft: CloneProfileDraft = {
    host: existing?.host ?? '',
    portText: existing ? String(existing.port) : '',
    user: existing?.user ?? '',
    password: '',
    database: existing?.database ?? '',
    environment: existing?.environment
  };
  const hostPrompt = role === 'source'
    ? t('Source database host')
    : t('Target database host (local or test only)');
  const envPrompt = t('Target environment (production and staging are not allowed)');
  const steps = [
    {
      key: 'host' as const,
      prompt: hostPrompt,
      validate: (value: string): string | null => (value.trim() ? null : t('Enter a host address'))
    },
    {
      key: 'portText' as const,
      prompt: t('Port (default 3306)'),
      validate: (value: string): string | null => {
        if (value === '') { return null; }
        if (!/^\d+$/.test(value)) { return t('Port must be a number'); }
        const port = Number(value);
        return port >= 1 && port <= 65535 ? null : t('Port must be between 1 and 65535');
      }
    },
    {
      key: 'user' as const,
      prompt: t('Username'),
      validate: (value: string): string | null => (value.trim() ? null : t('Enter a username'))
    },
    { key: 'password' as const, prompt: t('Password (leave empty to remove the saved password)'), password: true },
    {
      key: 'database' as const,
      prompt: t('Database'),
      validate: (value: string): string | null => (value.trim() ? null : t('Enter a database name'))
    }
  ];
  const totalSteps = steps.length + (role === 'target' ? 1 : 0);

  // 分步输入(005a):标题带角色与步骤序号;Esc 取消整体放弃,不写半成品。
  for (const [index, step] of steps.entries()) {
    const answer = await deps.showInputBox({
      prompt: step.prompt,
      title: `${roleLabel(role)} ${index + 1}/${totalSteps}`,
      value: step.key === 'password' ? undefined : draft[step.key],
      password: step.password,
      validateInput: step.validate
    });
    if (answer === undefined) {
      return; // 取消:已输入内容不落盘
    }
    draft[step.key] = answer;
  }
  if (role === 'target') {
    // §6.1:目标环境显式声明,只认 local/test。
    const environment = await deps.showQuickPick(['local', 'test'], { placeHolder: envPrompt });
    if (environment !== 'local' && environment !== 'test') {
      return;
    }
    draft.environment = environment;
  }

  // 摘要页(005c):不含密码的摘要 + 保存/测试/返回修改/取消;只有保存落盘。
  // 已存密钥且本次密码留空时额外提供「保留已存密码」(005d 明确保留语义)。
  let keepSecret = false;
  for (;;) {
    const actions = [CLONE_SUMMARY_SAVE];
    if (existing?.hasStoredSecret === true && draft.password === '') {
      actions.push(CLONE_SUMMARY_KEEP_SECRET);
    }
    actions.push(CLONE_SUMMARY_TEST, CLONE_SUMMARY_EDIT, CLONE_SUMMARY_CANCEL);
    const picked = await deps.showQuickPick(actions, {
      placeHolder: cloneSummaryText(t, role, draft, existing?.hasStoredSecret === true)
    });
    if (!picked || picked === CLONE_SUMMARY_CANCEL) {
      return; // 取消:不写入半成品
    }
    if (picked === CLONE_SUMMARY_TEST) {
      await testCloneDraftConnection(deps, role, draft);
      continue;
    }
    if (picked === CLONE_SUMMARY_EDIT) {
      await reviseDraftStep(deps, t, role, draft, { hostPrompt, envPrompt });
      continue;
    }
    if (picked === CLONE_SUMMARY_KEEP_SECRET) {
      keepSecret = true;
      break;
    }
    if (picked === CLONE_SUMMARY_SAVE) {
      break;
    }
    return; // 未知选择(宿主差异/旧脚本)按取消处理,绝不落盘
  }

  // 保存:keepSecret → password=undefined(SecretStorage 旧密钥原样保留);
  // 留空 → null(清除);输入 → 覆盖。密钥面失败如实报错,不虚报已保存。
  const password = keepSecret
    ? undefined
    : draft.password === ''
      ? null
      : draft.password;
  try {
    if (role === 'target') {
      await deps.profiles.save(
        'target',
        {
          host: draft.host,
          port: draft.portText === '' ? 3306 : Number(draft.portText),
          user: draft.user,
          database: draft.database,
          environment: draft.environment
        },
        password
      );
    } else {
      await deps.profiles.save(
        'source',
        {
          host: draft.host,
          port: draft.portText === '' ? 3306 : Number(draft.portText),
          user: draft.user,
          database: draft.database
        },
        password
      );
    }
  } catch (error) {
    await deps.showErrorMessage(
      `保存失败: ${error instanceof Error ? error.message : String(error)}`
    );
    return;
  }
  await deps.showInformationMessage(
    role === 'source' ? t('Source connection saved.') : t('Target connection saved.')
  );
}

/** 摘要文本(005c):连接参数 + 密码状态,绝不回显密码本体。 */
function cloneSummaryText(
  t: (message: string) => string,
  role: CloneProfileRole,
  draft: CloneProfileDraft,
  hasStoredSecret: boolean
): string {
  const passwordState = draft.password !== ''
    ? t('Password: entered, applied on save (never echoed)')
    : hasStoredSecret
      ? t('Password: saved; leaving empty clears it')
      : t('Password: none yet');
  const parts = [
    `Host ${draft.host}`,
    `Port ${draft.portText === '' ? 3306 : Number(draft.portText)}`,
    `User ${draft.user}`,
    `Database ${draft.database}`
  ];
  if (role === 'target') {
    parts.push(`Environment ${draft.environment}`);
  }
  parts.push(passwordState);
  return `${roleLabel(role)}: ${parts.join(' · ')}`;
}

/** 返回修改(005a):选中字段重填,输入预填当前草稿值(密码仍不回显)。 */
async function reviseDraftStep(
  deps: PlayerCloneCommandDeps,
  t: (message: string) => string,
  role: CloneProfileRole,
  draft: CloneProfileDraft,
  prompts: { hostPrompt: string; envPrompt: string }
): Promise<void> {
  const portPrompt = t('Port (default 3306)');
  const userPrompt = t('Username');
  const passwordPrompt = t('Password (leave empty to remove the saved password)');
  const databasePrompt = t('Database');
  const items = [prompts.hostPrompt, portPrompt, userPrompt, passwordPrompt, databasePrompt];
  if (role === 'target') {
    items.push(prompts.envPrompt);
  }
  const picked = await deps.showQuickPick(items, { placeHolder: CLONE_SUMMARY_EDIT });
  if (picked === undefined) {
    return; // 取消修改:草稿不动,回到摘要
  }
  switch (picked) {
    case prompts.hostPrompt: {
      const answer = await deps.showInputBox({
        prompt: prompts.hostPrompt,
        title: `${roleLabel(role)} ${CLONE_SUMMARY_EDIT}`,
        value: draft.host,
        validateInput: value => (value.trim() ? null : t('Enter a host address'))
      });
      if (answer !== undefined) { draft.host = answer; }
      return;
    }
    case portPrompt: {
      const answer = await deps.showInputBox({
        prompt: portPrompt,
        title: `${roleLabel(role)} ${CLONE_SUMMARY_EDIT}`,
        value: draft.portText,
        validateInput: value => {
          if (value === '') { return null; }
          if (!/^\d+$/.test(value)) { return t('Port must be a number'); }
          const port = Number(value);
          return port >= 1 && port <= 65535 ? null : t('Port must be between 1 and 65535');
        }
      });
      if (answer !== undefined) { draft.portText = answer; }
      return;
    }
    case userPrompt: {
      const answer = await deps.showInputBox({
        prompt: userPrompt,
        title: `${roleLabel(role)} ${CLONE_SUMMARY_EDIT}`,
        value: draft.user,
        validateInput: value => (value.trim() ? null : t('Enter a username'))
      });
      if (answer !== undefined) { draft.user = answer; }
      return;
    }
    case passwordPrompt: {
      const answer = await deps.showInputBox({
        prompt: passwordPrompt,
        title: `${roleLabel(role)} ${CLONE_SUMMARY_EDIT}`,
        password: true
      });
      if (answer !== undefined) { draft.password = answer; }
      return;
    }
    case databasePrompt: {
      const answer = await deps.showInputBox({
        prompt: databasePrompt,
        title: `${roleLabel(role)} ${CLONE_SUMMARY_EDIT}`,
        value: draft.database,
        validateInput: value => (value.trim() ? null : t('Enter a database name'))
      });
      if (answer !== undefined) { draft.database = answer; }
      return;
    }
    case prompts.envPrompt: {
      if (role !== 'target') { return; }
      const environment = await deps.showQuickPick(['local', 'test'], { placeHolder: prompts.envPrompt });
      if (environment === 'local' || environment === 'test') { draft.environment = environment; }
      return;
    }
    default:
      return; // 未知选择:草稿不动
  }
}

/**
 * 摘要页「测试连接」(005c):用草稿值建连测试,失败带原始原因;测试不落盘。
 * 密码留空且已存密钥时按保存语义取既有密码测试(与最终保存行为一致)。
 */
async function testCloneDraftConnection(
  deps: PlayerCloneCommandDeps,
  role: CloneProfileRole,
  draft: CloneProfileDraft
): Promise<void> {
  const password =
    draft.password !== ''
      ? draft.password
      : (await deps.profiles.resolveConnection(role))?.password;
  await showCloneConnectionTestResult(deps, role, {
    host: draft.host,
    port: draft.portText === '' ? 3306 : Number(draft.portText),
    user: draft.user,
    password,
    database: draft.database,
    environment: draft.environment
  });
}

/** 连接测试的呈现面(已存配置与摘要页草稿共用):成功带版本,失败带原因。 */
async function showCloneConnectionTestResult(
  deps: PlayerCloneCommandDeps,
  role: CloneProfileRole,
  config: {
    host: string;
    port: number;
    user: string;
    password: string | undefined;
    database: string;
    environment?: 'local' | 'test';
  }
): Promise<void> {
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
  await showCloneConnectionTestResult(deps, role, config);
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
    const message = deps.localize?.('Source connection is not configured.') ?? 'Source connection is not configured.';
    const action = deps.localize?.('Configure source connection') ?? 'Configure source connection';
    const choice = await deps.showWarningMessage(message, action);
    if (choice !== action) { return; }
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
