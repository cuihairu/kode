/**
 * CLONE-P5 骨架(用户令 2026-11-06):「玩家数据」专用**只读**面板。
 *
 * 硬约束(用户令,非建议):
 * - 不做通用 MySQL 客户端;界面**零编辑字段**——连接要素只来自引擎**最终
 *   合成配置**(resolve dbInterface:defaults+元件 kbengine.xml 同键覆盖真值,
 *   与引擎实跑同源;用户令 2026-11-09),不接受任何手填/改写;
 * - 只能查询:连接测试(SELECT 1)与按 dbid 查询玩家(只读 SELECT);
 *   一切查询经 databaseDrift 只读执行器(语句白名单 + READ ONLY 会话双保险);
 * - 密码永不回显:面板只显示掩码/密文标记;明文仅在连接期由
 *   serverConfigMerge 就地读取(与引擎配置同源,RSA 密文不解读)。
 *
 * 写操作(导入/回写)不属于本面——只走计划书 §2 的专门 Import 边界
 * (kode-db-clone apply),与现有数据库面板同样保持只读。
 */
import * as vscode from 'vscode';

import { l10nText } from './nlsRuntime';
import { ensureConfigDerivedScanRoot, getDerivedDatabaseProfile } from './configDerive';
import { createMysqlDriftExecutor, type DriftQueryExecutor } from './backend/databaseDrift';
import {
  PLAYER_TASK_OUTCOME_LABELS,
  PlayerTaskStatusStore,
  formatPlayerTaskTime,
  type PlayerTaskKind,
  type PlayerTaskOutcome
} from './backend/playerTaskStatus';
import {
  buildConfigTreePair,
  resolveDatabaseInterfaceConfig,
  type DatabaseInterfaceConfig
} from './serverConfigMerge';
import { maskConnectionSecrets } from './backend/reproductionSummary';

/** 只读查询结果输出通道(展示面,不可编辑;值 = l10n 英文源串) */
export const PLAYER_DATA_CHANNEL_NAME = 'KBEngine Player Data (read-only)';

/**
 * UX-REVIEW-008a 最近一次状态账本(查询/连接检查各一条;可回看:
 * 结果摘要+结果时间+结果入口都在树上,信息消息一闪而过不再是唯一呈现)。
 */
export const playerTaskStatusStore = new PlayerTaskStatusStore();

/** 结果输出通道(VS Code 按名复用同一实例;详情落通道=可回看结果入口) */
function playerDataChannel(): vscode.OutputChannel {
  return vscode.window.createOutputChannel(l10nText(PLAYER_DATA_CHANNEL_NAME));
}

/** UX-REVIEW-008a 结果入口:打开结果详情通道(树节点命令与命令面板共用) */
export function showPlayerDataResult(): void {
  playerDataChannel().show(true);
}

/** 结构化运行结果:消息给信息提示,结果态给状态账本(008a 六态);
 *  reason = 与语言无关的失败原因码,动作面按原因给按钮(010d:比较不依赖
 *  固定语言文字),不按译文匹配。 */
export interface PlayerTaskRunResult {
  message: string;
  outcome: Extract<PlayerTaskOutcome, 'empty' | 'success' | 'failed'>;
  reason?: 'missing-config' | 'password-unreadable';
}

/**
 * UX-REVIEW-008b 与真实原因对应的动作标签:失败给「重试」(可重入),
 * 一切失败/拒绝给「查看详情」(通道落原始诊断);缺配置再加配置定位
 * (发现报告)。动作只指向真实可执行命令,不造按钮。
 * UX-REVIEW-010d:标签调用期取词(英文 'Run' 同约定——选中值与比对值取
 * 同一翻译,比较不依赖固定语言文字)。
 */
export const playerTaskRetryLabel = (): string => l10nText('Retry');
export const playerTaskShowDetailLabel = (): string => l10nText('View details');

/** 原始错误用于诊断但不暴露密码:赋值形态/URL userinfo 一律遮蔽(008b) */
export function maskPlayerTaskErrorText(text: string): string {
  return maskConnectionSecrets(text);
}

interface PlayerDataNodeItem {
  label: string;
  description?: string;
  tooltip?: string | vscode.MarkdownString;
  collapsibleState?: vscode.TreeItemCollapsibleState;
  children?: PlayerDataNodeItem[];
  /** 点击执行的既有命令 id(004a 任务入口;缺省 = 纯说明条目) */
  commandId?: string;
  contextValue?: string;
}

/**
 * UX-REVIEW-004a 玩家数据任务入口(纯函数,便于单测):只读查询 / 导出玩家 /
 * 导入到本地或测试库三条真实可执行路径,说明文案点明「数据来自已持久化
 * 数据库,不代表在线状态」。条目全部指向既有真实命令,不新增不可执行按钮。
 */
export function buildPlayerDataTaskEntries(): PlayerDataNodeItem[] {
  return [
    {
      label: l10nText('Read-only query (DBID)'),
      description: l10nText('Reads persisted account rows (not the live state)'),
      tooltip: l10nText(
        'Read-only SELECT tbl_Account; connection facts come from the engine config derivation, unrelated to clone Source/Target profiles.'
      ),
      commandId: 'kbengine.playerData.queryByDbid',
      contextValue: 'playerDataTaskQuery'
    },
    {
      label: l10nText('Export players (Export)'),
      description: l10nText('Read-only export of persisted data to .kdpclone; not the live state'),
      tooltip: l10nText(
        'The read-only session runs the export plan; the archive is a persisted copy of the database (Persisted copy), not the live state (Live state).'
      ),
      commandId: 'kbengine.clone.export',
      contextValue: 'playerDataTaskExport'
    },
    {
      label: l10nText('Import to local or test database (Import)'),
      description: l10nText('local/test only; writes a persisted copy, not the live state'),
      tooltip: l10nText(
        'Two-pass plan preview and a local environment double-check before writing; cancel rolls back; re-import is fail-closed.'
      ),
      commandId: 'kbengine.clone.import',
      contextValue: 'playerDataTaskImport'
    }
  ];
}

// UX-REVIEW-004d:只读查询缺配置闸(纯函数)。降级文案点明连接要素只来自
// 引擎配置派生(dbmgr/databaseInterfaces/default),绝不把克隆 Source/Target
// 台账当成只读查询的配置来源;恢复动作指向真实的发现报告与连接检查命令。
// UX-REVIEW-010d:文案/标签调用期取词;动作判定改用与语言无关的原因码
// (PlayerTaskRunResult.reason),不按译文匹配。
export const readOnlyQueryMissingConfigMessage = (): string =>
  l10nText(
    'Read-only query needs the engine database config (derived from dbmgr/databaseInterfaces/default; unrelated to clone Source/Target profiles) — not found.'
  );
export const readOnlyQueryOpenReportLabel = (): string =>
  l10nText('Open discovery and location report');
export const readOnlyQueryCheckConnectionLabel = (): string =>
  l10nText('Re-derive and check connection');

export function readOnlyQueryConfigGate(
  profile: ReturnType<typeof getDerivedDatabaseProfile>
): string | null {
  return profile ? null : readOnlyQueryMissingConfigMessage();
}

/**
 * 连接档案面板视图(用户令 2026-11-09):连接要素一律以**最终合成配置**
 * (resolve dbInterface,defaults+custom 同键覆盖真值)为准——引擎实跑读的
 * 就是这份;Rust 派生档案(configDerive 缓存)只补 dbType,并在 core 不可知
 * 时作如实回落。defaults+custom 两面缓存失效时机不同,主真源唯一后不再
 * 出现「host 来自派生缓存、密码来自 resolve 缓存」的异源组合。
 *
 * defaultsOnly = 未发现元件 kbengine.xml(发现链 customTree 为空):此时
 * 最终配置就是引擎默认值,连接大概率不通——如实标注,绝不装成实际连接值。
 */
export interface PlayerDatabaseView {
  available: boolean;
  dbType: string;
  host: string;
  port: number;
  username: string;
  databaseName: string;
  encrypt: boolean;
  characterSet: string;
  /** 明文密码(仅 encrypt=false 时由 resolve 面提取;RSA 密文不解读) */
  plainPassword?: string;
  /** true = 未发现元件 kbengine.xml,当前值为引擎默认(非最终部署真值) */
  defaultsOnly: boolean;
}

/** 面板视图装配(同步读两缓存;async 入口须先 ensureConfigDerivedScanRoot) */
export function buildPlayerDatabaseView(): PlayerDatabaseView | null {
  const final = resolveDatabaseInterfaceConfig();
  if (final) {
    const defaultsOnly = buildConfigTreePair().customTree === null;
    const profile = getDerivedDatabaseProfile();
    return {
      available: true,
      dbType: profile?.dbType || 'mysql',
      host: final.host,
      port: final.port,
      username: final.username,
      databaseName: final.databaseName,
      encrypt: final.encrypt,
      characterSet: final.characterSet,
      plainPassword: final.plainPassword,
      defaultsOnly
    };
  }
  // resolve 无 dbInterface(core 不可知/RPC 失败):派生档案如实回落
  // (密码不在派生面,plaintextUnavailable 由调用方按无密码处理)。
  const profile = getDerivedDatabaseProfile();
  if (!profile) {
    return null;
  }
  return {
    available: true,
    dbType: profile.dbType,
    host: profile.host,
    port: profile.port,
    username: profile.username,
    databaseName: profile.databaseName,
    encrypt: profile.encrypt,
    characterSet: profile.characterSet,
    defaultsOnly: true
  };
}

/** defaults-only 告警文案(面板描述/tooltip 与命令结果共用,用户令:不许把
 * 引擎默认值装成最终配置;UX-REVIEW-010d 调用期取词) */
export const playerDatabaseDefaultsOnlyWarning = (): string =>
  l10nText(
    'Component kbengine.xml was not found; the values above are engine defaults (kbengine_defaults.xml), not the final merged config. If your deployment uses a custom database address, place kbengine.xml under assetsRoot res/server/ (or check the kbengine.assetsRoot setting) and retry.'
  );

/**
 * 连接档案节点(纯函数,便于单测):密码只出掩码标记,永不出值。
 */
export function buildPlayerDataTreeNodes(
  view: PlayerDatabaseView | null
): PlayerDataNodeItem[] {
  if (!view || !view.available) {
    return [
      {
        label: l10nText('Database config section not found'),
        description: 'dbmgr/databaseInterfaces/default',
        tooltip: l10nText(
          'No dbmgr/databaseInterfaces/default section found in the engine kbengine.xml / kbengine_defaults.xml. Check that assetsRoot/binPath points at engine assets.'
        ),
        collapsibleState: vscode.TreeItemCollapsibleState.None
      }
    ];
  }
  // KODE-REDIS-UI-001:连接面支持 mysql/redis 双后端;redis 的连接要素
  // 与 mysql 同源(引擎 dbInterface),仅键空间/预览走 redis 面。
  const kind = view.dbType === 'mysql' ? 'mysql' : view.dbType === 'redis' ? 'redis' : `${view.dbType}${l10nText(' (unknown)')}`;
  const password = view.encrypt
    ? l10nText('●●●●●● (RSA ciphertext, not decrypted)')
    : view.plainPassword
      ? l10nText('●●●●●● (plaintext, connection only)')
      : l10nText('(not configured)');
  const sourceNote = view.defaultsOnly
    ? l10nText('Source: engine defaults (component kbengine.xml not found) — {warning}', { warning: playerDatabaseDefaultsOnlyWarning() })
    : l10nText('Source: final merged config (engine defaults + component kbengine.xml same-key override, read-only)');
  return [
    {
      label: `${kind} default`,
      description: view.defaultsOnly
        ? `${view.host}:${view.port}/${view.databaseName}${l10nText(' (engine default)')}`
        : `${view.host}:${view.port}/${view.databaseName}`,
      tooltip: new vscode.MarkdownString(
        [
          '```',
          `type         ${view.dbType}`,
          `host         ${view.host}`,
          `port         ${view.port}`,
          `username     ${view.username}`,
          `password     ${password}`,
          `database     ${view.databaseName}`,
          `charset      ${view.characterSet}`,
          '```',
          sourceNote
        ].join('\n')
      ),
      collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
      children: [
        { label: l10nText('Type'), description: view.dbType },
        { label: l10nText('Host'), description: view.host },
        { label: l10nText('Port'), description: String(view.port) },
        { label: l10nText('Account'), description: view.username },
        { label: l10nText('Password'), description: password },
        { label: l10nText('Database'), description: view.databaseName },
        { label: l10nText('Charset'), description: view.characterSet }
      ]
    }
  ];
}

interface PlayerDataNode extends vscode.TreeItem {
  children?: PlayerDataNodeItem[];
}

function toItem(item: PlayerDataNodeItem): PlayerDataNode {
  const node = new vscode.TreeItem(
    item.label,
    item.collapsibleState ?? vscode.TreeItemCollapsibleState.None
  );
  node.description = item.description;
  node.tooltip = item.tooltip;
  if (item.contextValue) {
    node.contextValue = item.contextValue;
  }
  if (item.commandId) {
    node.command = { command: item.commandId, title: item.label, arguments: [] };
  }
  return { ...node, children: item.children };
}

export class PlayerDataTreeProvider implements vscode.TreeDataProvider<PlayerDataNode> {
  private readonly emitter = new vscode.EventEmitter<PlayerDataNode | undefined | null>();
  readonly onDidChangeTreeData = this.event;

  get event(): vscode.Event<PlayerDataNode | undefined | null> {
    return this.emitter.event;
  }

  refresh(): void {
    this.emitter.fire(null);
  }

  getTreeItem(element: PlayerDataNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: PlayerDataNode): PlayerDataNode[] {
    if (element?.children) {
      return element.children.map(toItem);
    }
    // 首取顺手触发派生(幂等);未就绪时本帧如实展示「未找到」,下一轮刷新补。
    void ensureConfigDerivedScanRoot().catch(() => {
      /* 派生失败:面板如实降级为未找到 */
    });
    // 顶层 = 任务入口(004a)+ 连接档案 + 最近一次状态(008a 可回看);
    // 任务条目指向既有真实命令。
    return [
      ...buildPlayerDataTaskEntries().map(toItem),
      ...buildPlayerDataTreeNodes(buildPlayerDatabaseView()).map(toItem),
      ...buildPlayerTaskStatusNodes().map(toItem)
    ];
  }
}

/** 最终配置视图 → 只读连接(密码只在此处聚合,不落任何日志/展示) */
function buildConnectionConfig(): {
  config: DatabaseInterfaceConfig;
  plaintextUnavailable: boolean;
  defaultsOnly: boolean;
} | null {
  const view = buildPlayerDatabaseView();
  if (!view) {
    return null;
  }
  return {
    config: {
      host: view.host,
      port: view.port,
      username: view.username,
      databaseName: view.databaseName,
      encrypt: view.encrypt,
      characterSet: view.characterSet,
      plainPassword: view.plainPassword
    },
    plaintextUnavailable: !view.plainPassword,
    defaultsOnly: view.defaultsOnly
  };
}

/**
 * 连接测试(只读 SELECT 1):成功给出耗时,失败如实降级(不回显密码)。
 * 结构化结果供 008a 状态账本记账;结果行同步落输出通道(可回看)。
 */
export async function runPlayerConnectionTest(): Promise<PlayerTaskRunResult> {
  const built = buildConnectionConfig();
  if (!built) {
    const message = l10nText(
      'Database config section not found (dbmgr/databaseInterfaces/default) — not tested'
    );
    return { message, outcome: 'failed', reason: 'missing-config' };
  }
  if (built.config.encrypt && !built.config.plainPassword) {
    const message = l10nText(
      'Password is engine RSA ciphertext, not decrypted — not tested (set encrypt=false explicitly in the engine config to enable testing)'
    );
    return { message, outcome: 'failed', reason: 'password-unreadable' };
  }
  const startedAt = Date.now();
  let executor: DriftQueryExecutor | null = null;
  try {
    executor = await createMysqlDriftExecutor(built.config);
    await executor.runQuery('SELECT 1 AS ok');
    const note = built.defaultsOnly ? l10nText('(note: {warning})', { warning: playerDatabaseDefaultsOnlyWarning() }) : '';
    const message = l10nText(
      'Connection OK ({host}:{port}/{database}, {elapsed}ms, read-only session){note}',
      {
        host: built.config.host,
        port: built.config.port,
        database: built.config.databaseName,
        elapsed: Date.now() - startedAt,
        note
      }
    );
    playerDataChannel().appendLine(l10nText('[Connection check {time}] {message}', { time: formatPlayerTaskTime(Date.now()), message }));
    return { message, outcome: 'success' };
  } catch (error) {
    const note = built.defaultsOnly ? l10nText('(note: {warning})', { warning: playerDatabaseDefaultsOnlyWarning() }) : '';
    const message = l10nText(
      'Connection failed: {error} (read-only fallback; other features unaffected){note}',
      { error: maskPlayerTaskErrorText(error instanceof Error ? error.message : String(error)), note }
    );
    playerDataChannel().appendLine(l10nText('[Connection check {time}] {message}', { time: formatPlayerTaskTime(Date.now()), message }));
    return { message, outcome: 'failed' };
  } finally {
    await executor?.close().catch(() => {
      /* 关闭失败不掩盖主结果 */
    });
  }
}

/** 连接测试(字符串呈现;状态记账与通道落盘见 runPlayerConnectionTest) */
export async function testPlayerDatabaseConnection(): Promise<string> {
  return (await runPlayerConnectionTest()).message;
}

/** dbid 输入校验:仅十进制正整数(安全内联;非参数面经白名单执行器) */
export function buildPlayerQuerySql(dbid: string, tablePrefix: string): string | null {
  if (!/^\d+$/.test(dbid.trim())) {
    return null;
  }
  const prefix = tablePrefix.trim() || 'tbl_';
  return 'SELECT * FROM `' + prefix.replace(/`/g, '') + 'Account` WHERE `id` = ' + dbid.trim();
}

/**
 * 按 dbid 查询玩家(只读):结果整表 JSON 落输出通道展示,零编辑。
 * 结构化结果区分空结果/成功/失败,供 008a 状态账本记账。
 */
export async function runPlayerQueryByDbid(dbid: string): Promise<PlayerTaskRunResult> {
  const sql = buildPlayerQuerySql(
    dbid,
    vscode.workspace.getConfiguration('kbengine').get<string>('db.tablePrefix', '')
  );
  if (!sql) {
    return { message: l10nText('dbid accepts decimal positive integers only'), outcome: 'failed' };
  }
  const built = buildConnectionConfig();
  if (!built) {
    return {
      message: l10nText('Database config section not found — not queried'),
      outcome: 'failed',
      reason: 'missing-config'
    };
  }
  if (!built.config.plainPassword) {
    return {
      message: l10nText('Password unreadable (engine RSA ciphertext or not configured) — not queried'),
      outcome: 'failed',
      reason: 'password-unreadable'
    };
  }
  let executor: DriftQueryExecutor | null = null;
  try {
    executor = await createMysqlDriftExecutor(built.config);
    const result = await executor.runQuery(sql);
    const channel = playerDataChannel();
    channel.appendLine(`[dbid ${dbid.trim()}] ${sql}`);
    if (built.defaultsOnly) {
      channel.appendLine(l10nText('(note: {warning})', { warning: playerDatabaseDefaultsOnlyWarning() }));
    }
    if (result.rows.length === 0) {
      channel.appendLine(l10nText('(0 rows — this dbid does not exist or the account table is empty)'));
    }
    for (const row of result.rows) {
      channel.appendLine(JSON.stringify(row));
    }
    channel.show();
    const note = built.defaultsOnly ? l10nText('(note: {warning})', { warning: playerDatabaseDefaultsOnlyWarning() }) : '';
    const message = l10nText('Query finished: {count} rows (results in the output channel, read-only){note}', { count: result.rows.length, note });
    return { message, outcome: result.rows.length === 0 ? 'empty' : 'success' };
  } catch (error) {
    const note = built.defaultsOnly ? l10nText('(note: {warning})', { warning: playerDatabaseDefaultsOnlyWarning() }) : '';
    const message = l10nText('Query failed: {error}{note}', {
      error: maskPlayerTaskErrorText(error instanceof Error ? error.message : String(error)),
      note
    });
    return { message, outcome: 'failed' };
  } finally {
    await executor?.close().catch(() => {
      /* 关闭失败不掩盖主结果 */
    });
  }
}

/** 按 dbid 查询玩家(字符串呈现;状态记账见 runPlayerQueryByDbid) */
export async function queryPlayerByDbid(dbid: string): Promise<string> {
  return (await runPlayerQueryByDbid(dbid)).message;
}

/**
 * UX-REVIEW-008a 最近一次状态节点(纯装配,便于单测):查询/连接检查各一条,
 * 六态渲染——未运行(无时间无入口,不造不可执行按钮)/进行中/终态(带
 * 结果时间与结果入口)。summary 进 tooltip,不进树行(树行保持一行可读)。
 */
export function buildPlayerTaskStatusNodes(): PlayerDataNodeItem[] {
  const tasks: Array<{ task: PlayerTaskKind; label: string }> = [
    { task: 'query', label: l10nText('Player query') },
    { task: 'connection', label: l10nText('Connection check') }
  ];
  return tasks.map(({ task, label }) => {
    const status = playerTaskStatusStore.get(task);
    const kindLabel = l10nText(PLAYER_TASK_OUTCOME_LABELS[status?.outcome ?? 'not-run']);
    const hasDetail = Boolean(status?.detailCommandId);
    return {
      label: `${label}:${kindLabel}`,
      description: status?.finishedAt ? formatPlayerTaskTime(status.finishedAt) : undefined,
      tooltip: status
        ? `${status.summary}${status.finishedAt ? l10nText(' (finished at {time})', { time: formatPlayerTaskTime(status.finishedAt) }) : ''}`
        : l10nText('Not run in this session yet; the result entry appears after a run.'),
      commandId: hasDetail ? status?.detailCommandId : undefined,
      contextValue: hasDetail ? `playerTaskStatus${task}` : undefined
    };
  });
}
