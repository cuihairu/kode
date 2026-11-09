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
 * 文案国际化(UX-REVIEW-010d):key=英文源串,zh-cn 经 deps.localize(装配面
 * 注 l10nText)取词,无注入回落英文源串;比较选项一律与同一调用值判等
 * (不依赖固定语言文字)。关键告示「持久化副本(Persisted copy)≠ 在线
 * 当前状态(Live state)」在导出/导入两面都出现。
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

/** {name} 占位符实参(译文内替换;口径同 nlsRuntime.NlsArgs)。 */
export type L10nArgs = Record<string, string | number | boolean>;

/** 取词包装形态:装配面注入 localize(= l10nText),无注入回落英文源串。 */
export type CloneL10n = (message: string, args?: L10nArgs) => string;

/** 无 localize 注入时的回退:英文源串内 {name} 按 args 原位替换。 */
export function withL10nArgs(message: string, args?: L10nArgs): string {
  if (!args) {
    return message;
  }
  return message.replace(/\{(\w+)\}/g, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(args, key) ? String(args[key]) : whole
  );
}

export interface PlayerCloneCommandDeps {
  /** Inject VS Code localization at the UI boundary; tests and non-VS Code callers may omit it. */
  localize?(message: string, args?: L10nArgs): string;
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
  'This is a persisted copy of the database, not the live online state.';

const noGateMessage =
  'Player Data Clone requires the Rust backend (kode-server) to be available: check the kode-core server configuration.';

// ---------------------------------------------------------------------------
// 0609 导出加密选择(设置默认 + 导出确认页逐次切换)
// ---------------------------------------------------------------------------

export const EXPORT_CONFIRM_ITEM = 'Export';
export const EXPORT_CANCEL_ITEM = 'Cancel';
const ENCRYPTED_LABEL = 'Encrypted (local key)';
const PLAIN_LABEL = 'Plaintext (portable)';
const TOGGLE_ENCRYPTION_LABEL = 'Toggle encryption';

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
  defaultEncrypt: boolean,
  localize?: CloneL10n
): Promise<{ confirmed: boolean; encrypt: boolean }> {
  const l10n: CloneL10n = localize ?? withL10nArgs;
  let encrypt = defaultEncrypt;
  for (;;) {
    // 选项文案与比较共用同一调用值(010d:比较不依赖固定语言文字)。
    const confirmItem = `${l10n(EXPORT_CONFIRM_ITEM)},${encrypt ? l10n(ENCRYPTED_LABEL) : l10n(PLAIN_LABEL)}`;
    const toggleItem = `${l10n(TOGGLE_ENCRYPTION_LABEL)} → ${encrypt ? l10n(PLAIN_LABEL) : l10n(ENCRYPTED_LABEL)}`;
    const cancelItem = l10n(EXPORT_CANCEL_ITEM);
    const picked = await pick(
      [confirmItem, toggleItem, cancelItem],
      { placeHolder: l10n('Export {count} read-only query results to the archive?', { count: queryCount }) }
    );
    if (!picked || picked === cancelItem) {
      return { confirmed: false, encrypt };
    }
    if (picked === toggleItem) {
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
export const CLONE_SUMMARY_SAVE = 'Save';
export const CLONE_SUMMARY_TEST = 'Test connection';
export const CLONE_SUMMARY_EDIT = 'Edit';
export const CLONE_SUMMARY_CANCEL = 'Cancel';
/**
 * 保留已存密码(005d 明确保留语义):仅在已存密钥且本次密码输入留空时
 * 出现;选中后以 save(password=undefined) 落盘,SecretStorage 旧密钥原样
 * 保留——与「保存(留空=清除)」形成一对明确语义。
 */
export const CLONE_SUMMARY_KEEP_SECRET = 'Keep stored password';

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
  const l10n: CloneL10n = (message, args) =>
    deps.localize?.(message, args) ?? withL10nArgs(message, args);
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
    ? l10n('Source database host')
    : l10n('Target database host (local or test only)');
  const envPrompt = l10n('Target environment (production and staging are not allowed)');
  const steps = [
    {
      key: 'host' as const,
      prompt: hostPrompt,
      validate: (value: string): string | null => (value.trim() ? null : l10n('Enter a host address'))
    },
    {
      key: 'portText' as const,
      prompt: l10n('Port (default 3306)'),
      validate: (value: string): string | null => {
        if (value === '') { return null; }
        if (!/^\d+$/.test(value)) { return l10n('Port must be a number'); }
        const port = Number(value);
        return port >= 1 && port <= 65535 ? null : l10n('Port must be between 1 and 65535');
      }
    },
    {
      key: 'user' as const,
      prompt: l10n('Username'),
      validate: (value: string): string | null => (value.trim() ? null : l10n('Enter a username'))
    },
    { key: 'password' as const, prompt: l10n('Password (leave empty to remove the saved password)'), password: true },
    {
      key: 'database' as const,
      prompt: l10n('Database'),
      validate: (value: string): string | null => (value.trim() ? null : l10n('Enter a database name'))
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
    // 选项与比较共用同一调用值(010d:比较不依赖固定语言文字)。
    const saveLabel = l10n(CLONE_SUMMARY_SAVE);
    const keepSecretLabel = l10n(CLONE_SUMMARY_KEEP_SECRET);
    const testLabel = l10n(CLONE_SUMMARY_TEST);
    const editLabel = l10n(CLONE_SUMMARY_EDIT);
    const cancelLabel = l10n(CLONE_SUMMARY_CANCEL);
    const actions = [saveLabel];
    if (existing?.hasStoredSecret === true && draft.password === '') {
      actions.push(keepSecretLabel);
    }
    actions.push(testLabel, editLabel, cancelLabel);
    const picked = await deps.showQuickPick(actions, {
      placeHolder: cloneSummaryText(l10n, role, draft, existing?.hasStoredSecret === true)
    });
    if (!picked || picked === cancelLabel) {
      return; // 取消:不写入半成品
    }
    if (picked === testLabel) {
      await testCloneDraftConnection(deps, role, draft);
      continue;
    }
    if (picked === editLabel) {
      await reviseDraftStep(deps, l10n, role, draft, { hostPrompt, envPrompt });
      continue;
    }
    if (picked === keepSecretLabel) {
      keepSecret = true;
      break;
    }
    if (picked === saveLabel) {
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
      l10n('Save failed: {reason}', { reason: error instanceof Error ? error.message : String(error) })
    );
    return;
  }
  await deps.showInformationMessage(
    role === 'source' ? l10n('Source connection saved.') : l10n('Target connection saved.')
  );
}

/** 摘要文本(005c):连接参数 + 密码状态,绝不回显密码本体。 */
function cloneSummaryText(
  l10n: CloneL10n,
  role: CloneProfileRole,
  draft: CloneProfileDraft,
  hasStoredSecret: boolean
): string {
  const passwordState = draft.password !== ''
    ? l10n('Password: entered, applied on save (never echoed)')
    : hasStoredSecret
      ? l10n('Password: saved; leaving empty clears it')
      : l10n('Password: none yet');
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
  l10n: CloneL10n,
  role: CloneProfileRole,
  draft: CloneProfileDraft,
  prompts: { hostPrompt: string; envPrompt: string }
): Promise<void> {
  const portPrompt = l10n('Port (default 3306)');
  const userPrompt = l10n('Username');
  const passwordPrompt = l10n('Password (leave empty to remove the saved password)');
  const databasePrompt = l10n('Database');
  const items = [prompts.hostPrompt, portPrompt, userPrompt, passwordPrompt, databasePrompt];
  if (role === 'target') {
    items.push(prompts.envPrompt);
  }
  const picked = await deps.showQuickPick(items, { placeHolder: l10n(CLONE_SUMMARY_EDIT) });
  if (picked === undefined) {
    return; // 取消修改:草稿不动,回到摘要
  }
  switch (picked) {
    case prompts.hostPrompt: {
      const answer = await deps.showInputBox({
        prompt: prompts.hostPrompt,
        title: `${roleLabel(role)} ${l10n(CLONE_SUMMARY_EDIT)}`,
        value: draft.host,
        validateInput: value => (value.trim() ? null : l10n('Enter a host address'))
      });
      if (answer !== undefined) { draft.host = answer; }
      return;
    }
    case portPrompt: {
      const answer = await deps.showInputBox({
        prompt: portPrompt,
        title: `${roleLabel(role)} ${l10n(CLONE_SUMMARY_EDIT)}`,
        value: draft.portText,
        validateInput: value => {
          if (value === '') { return null; }
          if (!/^\d+$/.test(value)) { return l10n('Port must be a number'); }
          const port = Number(value);
          return port >= 1 && port <= 65535 ? null : l10n('Port must be between 1 and 65535');
        }
      });
      if (answer !== undefined) { draft.portText = answer; }
      return;
    }
    case userPrompt: {
      const answer = await deps.showInputBox({
        prompt: userPrompt,
        title: `${roleLabel(role)} ${l10n(CLONE_SUMMARY_EDIT)}`,
        value: draft.user,
        validateInput: value => (value.trim() ? null : l10n('Enter a username'))
      });
      if (answer !== undefined) { draft.user = answer; }
      return;
    }
    case passwordPrompt: {
      const answer = await deps.showInputBox({
        prompt: passwordPrompt,
        title: `${roleLabel(role)} ${l10n(CLONE_SUMMARY_EDIT)}`,
        password: true
      });
      if (answer !== undefined) { draft.password = answer; }
      return;
    }
    case databasePrompt: {
      const answer = await deps.showInputBox({
        prompt: databasePrompt,
        title: `${roleLabel(role)} ${l10n(CLONE_SUMMARY_EDIT)}`,
        value: draft.database,
        validateInput: value => (value.trim() ? null : l10n('Enter a database name'))
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
  const l10n: CloneL10n = (message, args) =>
    deps.localize?.(message, args) ?? withL10nArgs(message, args);
  try {
    const connection = await openCloneSession(config);
    try {
      const result = await testCloneConnection(connection);
      if (result.ok) {
        await deps.showInformationMessage(
          l10n('{role} connection succeeded (server version {version}).', {
            role: role === 'source' ? 'Source' : 'Target',
            version: result.version
          })
        );
      } else {
        await deps.showErrorMessage(l10n('Connection failed: {reason}', { reason: result.reason }));
      }
    } finally {
      await connection.end();
    }
  } catch (error) {
    await deps.showErrorMessage(
      l10n('Connection failed: {reason}', { reason: error instanceof Error ? error.message : String(error) })
    );
  }
}

export async function runTestCloneConnectionCommand(
  deps: PlayerCloneCommandDeps,
  role: CloneProfileRole
): Promise<void> {
  const l10n: CloneL10n = (message, args) =>
    deps.localize?.(message, args) ?? withL10nArgs(message, args);
  const config = await deps.profiles.resolveConnection(role);
  if (!config) {
    await deps.showWarningMessage(
      l10n('{role} connection is not configured.', { role: roleLabel(role) })
    );
    return;
  }
  await showCloneConnectionTestResult(deps, role, config);
}

// ---------------------------------------------------------------------------
// 0503 归档浏览
// ---------------------------------------------------------------------------

function renderArchiveSummary(l10n: CloneL10n, meta: ArchiveMetaWire): string[] {
  const lines = [
    l10n('Archive entity: {entity}', { entity: meta.entity }),
    l10n('Format: {format} v{version}', { format: meta.format, version: meta.version }),
    l10n('Total rows: {rows}', { rows: meta.total_rows }),
    l10n('Data bytes: {bytes}', { bytes: meta.total_bytes }),
    l10n('Encrypted: {state}', { state: meta.encrypted ? l10n('yes') : l10n('no (plaintext)') })
  ];
  for (const table of meta.tables) {
    lines.push(l10n('- {table}: {rows} rows', { table: table.name, rows: table.rows }));
  }
  lines.push(l10n('Checksums: {state}', {
    state: meta.files.includes('checksums.json') ? 'checksums.json ✓' : l10n('missing')
  }));
  lines.push(l10n('Redaction report: {state}', {
    state: meta.files.includes('redaction-report.json') ? 'redaction-report.json ✓' : l10n('missing')
  }));
  lines.push(l10n(PERSISTED_NOT_LIVE));
  return lines;
}

export async function runInspectCloneArchiveCommand(
  deps: PlayerCloneCommandDeps,
  archivePath?: string
): Promise<void> {
  const l10n: CloneL10n = (message, args) =>
    deps.localize?.(message, args) ?? withL10nArgs(message, args);
  const path = archivePath ?? (await deps.pickArchiveOpenPath());
  if (!path) {
    return;
  }
  const inspected = await inspectCloneArchive(path, deps.getKeyRoot());
  if (inspected.status === 'no-gate') {
    await deps.showErrorMessage(l10n(noGateMessage));
    return;
  }
  if (inspected.status === 'error') {
    await deps.showErrorMessage(
      l10n('Failed to read the archive manifest: {reason}', { reason: inspected.reason })
    );
    return;
  }
  const lines = [`[Player Clone] ${path}`, ...renderArchiveSummary(l10n, inspected.result)];
  deps.channel.appendLine(lines.join('\n'));
  deps.channel.show(true);
  await deps.showInformationMessage(
    l10n('Archive manifest written to the output ({entity}, {rows} rows). {persisted}', {
      entity: inspected.result.entity,
      rows: inspected.result.total_rows,
      persisted: l10n(PERSISTED_NOT_LIVE)
    })
  );
}

// ---------------------------------------------------------------------------
// 0502 导出
// ---------------------------------------------------------------------------

export async function runExportCloneCommand(deps: PlayerCloneCommandDeps): Promise<void> {
  const l10n: CloneL10n = (message, args) =>
    deps.localize?.(message, args) ?? withL10nArgs(message, args);
  const entityNames = deps.listEntityNames();
  if (entityNames.length === 0) {
    await deps.showWarningMessage(
      l10n('No registered entities found in the workspace (open a KBEngine project first).')
    );
    return;
  }
  let config = await deps.profiles.resolveConnection('source');
  if (!config) {
    const message = l10n('Source connection is not configured.');
    const action = l10n('Configure source connection');
    const choice = await deps.showWarningMessage(message, action);
    if (choice !== action) { return; }
    await runConfigureCloneProfileCommand(deps, 'source');
    config = await deps.profiles.resolveConnection('source');
    if (!config) { return; }
  }
  const entityName = await deps.showQuickPick(entityNames, {
    placeHolder: l10n('Select the entity to export')
  });
  if (!entityName) {
    return;
  }
  const dbidText = await deps.showInputBox({
    prompt: l10n('Root-table DBID (the entity primary key id)'),
    validateInput: value => (/^\d+$/.test(value) ? null : l10n('DBID must be a number'))
  });
  if (dbidText === undefined) {
    return;
  }
  const derivationTables = deps.resolveEntityTables(entityName);
  if (!derivationTables || derivationTables.length === 0) {
    await deps.showErrorMessage(
      l10n('Cannot derive table structure for entity {entity} from workspace defs.', { entity: entityName })
    );
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
        await deps.showErrorMessage(l10n(noGateMessage));
        return;
      }
      if (plan.status === 'error') {
        await deps.showErrorMessage(
          l10n('Failed to generate the export plan: {reason}', { reason: plan.reason })
        );
        return;
      }
      const preview = [
        `[Player Clone Export] ${entityName} DBID=${dbidText}`,
        l10n('Tables: {tables}', { tables: plan.result.queries.map(q => q.table).join(', ') }),
        l10n('Row budget: {budget}', { budget: plan.result.row_budget })
      ];
      if (plan.result.missing.length > 0) {
        preview.push(l10n('Missing in source: {tables}', { tables: plan.result.missing.join(', ') }));
      }
      preview.push(l10n(PERSISTED_NOT_LIVE));
      deps.channel.appendLine(preview.join('\n'));
      deps.channel.show(true);

      const encryptionChoice = await pickExportEncryption(
        deps.showQuickPick,
        plan.result.queries.length,
        (deps.getArchiveEncryptionDefault?.() ?? 'encrypted') === 'encrypted',
        l10n
      );
      if (!encryptionChoice.confirmed) {
        return;
      }

      const rows = await deps.withProgress(
        { title: l10n('Player Clone: reading {entity} data (cancellable)', { entity: entityName }), cancellable: true },
        token => executeExportPlan(connection, plan.result, BigInt(dbidText), {
          shouldCancel: () => token.isCancellationRequested
        })
      );
      if (rows.length === 0) {
        await deps.showWarningMessage(
          l10n('DBID={dbid} returned no rows from the source database (nothing exported).', { dbid: dbidText })
        );
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
        await deps.showErrorMessage(l10n(noGateMessage));
        return;
      }
      if (written.status === 'error') {
        await deps.showErrorMessage(
          l10n('Failed to write the archive: {reason}', { reason: written.reason })
        );
        return;
      }
      await deps.showInformationMessage(
        l10n('Export finished: {rows} rows → {path} (sensitive columns redacted, {encryption}). {persisted}', {
          rows: written.result.total_rows,
          path: savePath,
          encryption: encryptionChoice.encrypt
            ? l10n('archive is encrypted')
            : l10n('archive is plaintext (not encrypted)'),
          persisted: l10n(PERSISTED_NOT_LIVE)
        })
      );
    } finally {
      try {
        await connection.end();
      } catch (closeError) {
        // A cancelled or timed-out stream may already have closed the socket.
        // Do not replace the original export outcome with a close error.
        deps.channel.appendLine(`[Player Clone] ${l10n('Failed to close the read-only connection: {reason}', { reason: String(closeError) })}`);
      }
    }
  } catch (error) {
    if (error instanceof CloneCancelledError) {
      await deps.showWarningMessage(l10n('Export cancelled (read-only surface; no rollback needed).'));
      return;
    }
    await deps.showErrorMessage(
      l10n('Export failed: {reason}', { reason: error instanceof Error ? error.message : String(error) })
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
  // UX-REVIEW-004c:导入前先检查目标配置(缺配置直接进入向导,取消不收集
  // 后续信息)与目标环境(仅 local/test,§6.1 双保险);连接可达性在探测
  // 会话建立后第一时间校验(见下 testCloneConnection),失败如实报因、
  // 导入未开始(不登记防重、不写入)。
  const l10n: CloneL10n = (message, args) =>
    deps.localize?.(message, args) ?? withL10nArgs(message, args);
  let targetConfig = await deps.profiles.resolveConnection('target');
  if (!targetConfig) {
    const action = l10n('Configure Target connection');
    const choice = await deps.showWarningMessage(
      l10n('Target connection is not configured (local/test only; run "{action}" first).', { action }),
      action
    );
    if (choice !== action) {
      return;
    }
    await runConfigureCloneProfileCommand(deps, 'target');
    targetConfig = await deps.profiles.resolveConnection('target');
    if (!targetConfig) {
      return; // 配置向导被取消:不收集后续信息
    }
  }
  // §6.1 双保险:台账配置闸已拒 prod/staging;导入执行前再落一道环境闸。
  if (targetConfig.environment !== 'local' && targetConfig.environment !== 'test') {
    await deps.showErrorMessage(
      l10n('Target environment accepts local/test only (import never writes production/staging).')
    );
    return;
  }

  const path = archivePath ?? (await deps.pickArchiveOpenPath());
  if (!path) {
    return;
  }

  const inspected = await inspectCloneArchive(path, deps.getKeyRoot());
  if (inspected.status !== 'ok') {
    await deps.showErrorMessage(
      inspected.status === 'no-gate'
        ? l10n(noGateMessage)
        : l10n('Failed to read the archive manifest: {reason}', { reason: inspected.reason })
    );
    return;
  }
  const entityName = inspected.result.entity;
  const derivationTables = deps.resolveEntityTables(entityName);
  if (!derivationTables || derivationTables.length === 0) {
    await deps.showErrorMessage(
      l10n('Cannot derive table structure for entity {entity} from workspace defs (import needs target schema reconciliation).', { entity: entityName })
    );
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
      // 004c:探测会话建立后先验连接可达(真实 SELECT),失败如实报因——
      // 导入未开始:不登记防重、不生成计划、不写入。
      const probe = await testCloneConnection(connection);
      if (!probe.ok) {
        await deps.showErrorMessage(
          l10n('Target connection failed: {reason} (import not started)', { reason: probe.reason })
        );
        return;
      }
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
        await deps.showErrorMessage(l10n(noGateMessage));
        return;
      }
      if (pass1.status === 'error') {
        await deps.showErrorMessage(
          l10n('Failed to generate the import plan: {reason}', { reason: pass1.reason })
        );
        return;
      }
      columnOrder = columnOrderFromPlan(pass1.result);

      // 归档行 → 唯一值候选 → 目标既有值有界探测 → pass-2 冲突预演。
      const rowsCall = await readCloneArchiveRows(path, deps.getKeyRoot());
      if (rowsCall.status === 'no-gate') {
        await deps.showErrorMessage(l10n(noGateMessage));
        return;
      }
      if (rowsCall.status === 'error') {
        await deps.showErrorMessage(
          l10n('Failed to read archive rows: {reason}', { reason: rowsCall.reason })
        );
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
          pass2.status === 'no-gate'
            ? l10n(noGateMessage)
            : l10n('Failed to rehearse the import: {reason}', { reason: pass2.reason })
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
      l10n('Entity: {entity}', { entity: plan.entity_name }),
      l10n('Statements: {statements}', { statements: perTable }),
      l10n('ID categories: {categories}', { categories: categories || l10n('none') }),
      l10n('Unique conflicts: {count} (strategy: local rebuild with an _imported suffix)', {
        count: plan.summary.unique_conflicts
      }),
      l10n('Account binding: {note}', { note: plan.account_binding.note }),
      l10n('Unresolved references: {count}', { count: plan.summary.unresolved_reference_risks })
    ];
    for (const warning of plan.warnings) {
      previewLines.push(l10n('- warning: {warning}', { warning }));
    }
    previewLines.push(l10n(PERSISTED_NOT_LIVE));
    deps.channel.appendLine(previewLines.join('\n'));
    deps.channel.show(true);

    // 选项与比较共用同一调用值(010d:比较不依赖固定语言文字)。
    const continueLabel = l10n('Continue to confirmation');
    const firstCancelLabel = l10n(EXPORT_CANCEL_ITEM);
    const firstConfirm = await deps.showQuickPick(
      [continueLabel, firstCancelLabel],
      { placeHolder: l10n('Import {count} statements into {database}?', {
          count: plan.statements.length,
          database: targetConfig.database
        }) }
    );
    if (firstConfirm !== continueLabel) {
      return;
    }
    // 本地环境二次确认(§6.1:目标必须是本地/测试库,写入不可伪装成预演)。
    const confirmWriteLabel = l10n('Confirm write to local database {host}:{port}/{database}', {
      host: targetConfig.host,
      port: targetConfig.port,
      database: targetConfig.database
    });
    const secondConfirm = await deps.showQuickPick(
      [confirmWriteLabel, firstCancelLabel],
      { placeHolder: l10n('Second confirmation: this is a real write to a local/test database (single transaction, full rollback on failure).') }
    );
    if (!secondConfirm || secondConfirm !== confirmWriteLabel) {
      return;
    }

    // Persist before any database writes. An interrupted or ambiguous attempt must
    // continue to block automatic retries across extension restarts.
    const keyRoot = deps.getKeyRoot();
    if (!keyRoot) {
      throw new Error(l10n('Missing persistence directory; cannot guard against duplicate imports'));
    }
    const fingerprint = await fingerprintCloneArchive(path);
    if (fingerprint !== plannedFingerprint) {
      throw new Error(l10n('The archive changed while the import was being planned; rehearse again'));
    }
    const reservation = await reserveCloneImport(keyRoot, fingerprint, targetConfig);
    if (reservation.duplicate) {
      deps.channel.appendLine(`[Player Clone] ${l10n('A previous import or unfinished attempt was detected: {reservation}', { reservation: reservation.reservation })}\n${reservation.prior ?? ''}`);
      deps.channel.show(true);
      const copyLabel = l10n('Create another copy anyway');
      const choice = await deps.showQuickPick(
        [firstCancelLabel, copyLabel],
        { placeHolder: l10n('This archive has already been imported (or attempted) on this machine for this target; verify the target database first.') }
      );
      if (choice !== copyLabel) {
        return;
      }
    }

    // ---- Apply:重开连接(写事务;readonly:false)+ 进度 + 取消(§6.4 取消即回滚) ----
    const writeConnection = await openCloneSession(targetConfig, { readonly: false });
    try {
      const result = await deps.withProgress(
        { title: l10n('Player Clone: importing {entity} (cancel = rollback)', { entity: entityName }), cancellable: true },
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
          note: l10n('Engine-side load verification requires a local KBEngine runtime (PDC-0003) and is not wired yet; the post-commit COUNT recheck above is what runs.')
        }
      };
      const auditPath = await deps.writeAuditFile(
        `import-${plan.entity_name}-${Math.floor(deps.now() / 1000)}.json`,
        JSON.stringify(audit, null, 2)
      );
      if (!verifyOk) {
        await deps.showErrorMessage(
          l10n('Import committed but verification did not fully pass (see audit {path}); the data itself is atomically intact — verify manually.', { path: auditPath })
        );
        return;
      }
      await deps.showInformationMessage(
        l10n('Import finished: new DBID={dbid}; audit {path}; cleanup plan generated but not executed. {persisted}', {
          dbid: result.newRootId ?? l10n('(kept as-is)'),
          path: auditPath,
          persisted: l10n(PERSISTED_NOT_LIVE)
        })
      );
    } finally {
      try {
        await writeConnection.end();
      } catch (closeError) {
        deps.channel.appendLine(`[Player Clone] ${l10n('Failed to close the connection: {reason}', { reason: String(closeError) })}`);
      }
    }
  } catch (error) {
    const target = `${targetConfig.host}:${targetConfig.port}/${targetConfig.database}`;
    const detail = error instanceof Error ? error.message : String(error);
    if (committed || error instanceof ClonePostCommitError) {
      await deps.showErrorMessage(
        l10n('Import committed, but verification or audit failed: {detail}. Check the target {target} and the archive {path} first; do not retry blindly.', { detail, target, path })
      );
      return;
    }
    if (error instanceof CloneCommitUnknownError || error instanceof CloneRollbackUnknownError) {
      await deps.showErrorMessage(
        l10n('Import outcome uncertain: {detail}. Check the target {target} and the archive {path} first; do not retry blindly.', { detail, target, path })
      );
      return;
    }
    if (error instanceof CloneApplyCancelledError) {
      await deps.showWarningMessage(
        l10n('Import cancelled: the transaction was rolled back; no rows were written.')
      );
      return;
    }
    await deps.showErrorMessage(
      l10n('Import failed: {detail}. Target {target}; verify before retrying.', { detail, target })
    );
  }
}

// ---------------------------------------------------------------------------
// 0505 审计查看
// ---------------------------------------------------------------------------

export async function runShowCloneAuditCommand(deps: PlayerCloneCommandDeps): Promise<void> {
  const l10n: CloneL10n = (message, args) =>
    deps.localize?.(message, args) ?? withL10nArgs(message, args);
  const files = await deps.listAuditFiles();
  if (files.length === 0) {
    await deps.showWarningMessage(l10n('No import audit records yet (.kode/clone-runs/).'));
    return;
  }
  const picked = await deps.showQuickPick(files, { placeHolder: l10n('Select an import audit to view') });
  if (!picked) {
    return;
  }
  const content = await deps.readAuditFile(picked);
  if (content === null) {
    await deps.showErrorMessage(l10n('Failed to read the audit: {path}', { path: picked }));
    return;
  }
  deps.channel.appendLine(`[Player Clone Audit] ${picked}\n${content}`);
  deps.channel.show(true);
}
