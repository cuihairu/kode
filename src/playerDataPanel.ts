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

/** 只读查询结果输出通道(展示面,不可编辑) */
export const PLAYER_DATA_CHANNEL_NAME = 'KBEngine 玩家数据(只读)';

/**
 * UX-REVIEW-008a 最近一次状态账本(查询/连接检查各一条;可回看:
 * 结果摘要+结果时间+结果入口都在树上,信息消息一闪而过不再是唯一呈现)。
 */
export const playerTaskStatusStore = new PlayerTaskStatusStore();

/** 结果输出通道(VS Code 按名复用同一实例;详情落通道=可回看结果入口) */
function playerDataChannel(): vscode.OutputChannel {
  return vscode.window.createOutputChannel(PLAYER_DATA_CHANNEL_NAME);
}

/** UX-REVIEW-008a 结果入口:打开结果详情通道(树节点命令与命令面板共用) */
export function showPlayerDataResult(): void {
  playerDataChannel().show(true);
}

/** 结构化运行结果:消息给信息提示,结果态给状态账本(008a 六态) */
export interface PlayerTaskRunResult {
  message: string;
  outcome: Extract<PlayerTaskOutcome, 'empty' | 'success' | 'failed'>;
}

/**
 * UX-REVIEW-008b 与真实原因对应的动作标签:失败给「重试」(可重入),
 * 一切失败/拒绝给「查看详情」(通道落原始诊断);缺配置再加配置定位
 * (发现报告)。动作只指向真实可执行命令,不造按钮。
 */
export const PLAYER_TASK_RETRY_LABEL = '重试';
export const PLAYER_TASK_SHOW_DETAIL_LABEL = '查看详情';

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
      label: '只读查询(DBID)',
      description: '从已持久化数据库读账号行(不代表在线状态)',
      tooltip:
        '只读 SELECT tbl_Account;连接要素只来自引擎配置派生,与克隆 Source/Target 台账无关。',
      commandId: 'kbengine.playerData.queryByDbid',
      contextValue: 'playerDataTaskQuery'
    },
    {
      label: '导出玩家(Export)',
      description: '只读导出持久化数据到 .kdpclone;不代表在线状态',
      tooltip:
        '只读会话执行导出计划;归档是数据库已持久化数据副本(Persisted copy),不代表在线当前状态(Live state)。',
      commandId: 'kbengine.clone.export',
      contextValue: 'playerDataTaskExport'
    },
    {
      label: '导入到本地或测试库(Import)',
      description: '仅 local/test;写入持久化副本,不代表在线状态',
      tooltip:
        '写入前两遍计划预演与本地环境二次确认,取消即回滚;重复导入 fail-closed。',
      commandId: 'kbengine.clone.import',
      contextValue: 'playerDataTaskImport'
    }
  ];
}

// UX-REVIEW-004d:只读查询缺配置闸(纯函数)。降级文案点明连接要素只来自
// 引擎配置派生(dbmgr/databaseInterfaces/default),绝不把克隆 Source/Target
// 台账当成只读查询的配置来源;恢复动作指向真实的发现报告与连接检查命令。
export const READ_ONLY_QUERY_MISSING_CONFIG =
  '只读查询需要引擎数据库配置(dbmgr/databaseInterfaces/default 派生;与克隆 Source/Target 台账无关)——未找到。';
export const READ_ONLY_QUERY_OPEN_REPORT = '打开发现与定位报告';
export const READ_ONLY_QUERY_CHECK_CONNECTION = '重新派生并检查连接';

export function readOnlyQueryConfigGate(
  profile: ReturnType<typeof getDerivedDatabaseProfile>
): string | null {
  return profile ? null : READ_ONLY_QUERY_MISSING_CONFIG;
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
 * 引擎默认值装成最终配置) */
export const PLAYER_DATABASE_DEFAULTS_ONLY_WARNING =
  '未发现元件 kbengine.xml,以上为引擎默认配置(kbengine_defaults.xml)而非最终合成配置;' +
  '若实际部署使用自定义数据库地址,请把元件 kbengine.xml 放到 assetsRoot 的 res/server/ 下' +
  '(或检查 kbengine.assetsRoot 设置)后重试。';

/**
 * 连接档案节点(纯函数,便于单测):密码只出掩码标记,永不出值。
 */
export function buildPlayerDataTreeNodes(
  view: PlayerDatabaseView | null
): PlayerDataNodeItem[] {
  if (!view || !view.available) {
    return [
      {
        label: '未找到数据库配置段',
        description: 'dbmgr/databaseInterfaces/default',
        tooltip:
          '引擎 kbengine.xml / kbengine_defaults.xml 中未找到 ' +
          'dbmgr/databaseInterfaces/default 段。请确认 assetsRoot/binPath 指向引擎资产。',
        collapsibleState: vscode.TreeItemCollapsibleState.None
      }
    ];
  }
  // KODE-REDIS-UI-001:连接面支持 mysql/redis 双后端;redis 的连接要素
  // 与 mysql 同源(引擎 dbInterface),仅键空间/预览走 redis 面。
  const kind = view.dbType === 'mysql' ? 'mysql' : view.dbType === 'redis' ? 'redis' : `${view.dbType}(未知)`;
  const password = view.encrypt
    ? '●●●●●●(RSA 密文,不解读)'
    : view.plainPassword
      ? '●●●●●●(明文可读,仅连接用)'
      : '(未配置)';
  const sourceNote = view.defaultsOnly
    ? `来源:引擎默认配置(未发现元件 kbengine.xml)——${PLAYER_DATABASE_DEFAULTS_ONLY_WARNING}`
    : '来源:最终合成配置(引擎 defaults + 元件 kbengine.xml 同键覆盖,只读)';
  return [
    {
      label: `${kind} default`,
      description: view.defaultsOnly
        ? `${view.host}:${view.port}/${view.databaseName}(引擎默认)`
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
        { label: '类型', description: view.dbType },
        { label: '主机', description: view.host },
        { label: '端口', description: String(view.port) },
        { label: '账号', description: view.username },
        { label: '密码', description: password },
        { label: '数据库', description: view.databaseName },
        { label: '字符集', description: view.characterSet }
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
    const message = '未找到数据库配置段(dbmgr/databaseInterfaces/default)——未测试';
    return { message, outcome: 'failed' };
  }
  if (built.config.encrypt && !built.config.plainPassword) {
    const message =
      '密码为引擎 RSA 密文,不解读——未测试(如需测试请在引擎配置中显式 encrypt=false)';
    return { message, outcome: 'failed' };
  }
  const startedAt = Date.now();
  let executor: DriftQueryExecutor | null = null;
  try {
    executor = await createMysqlDriftExecutor(built.config);
    await executor.runQuery('SELECT 1 AS ok');
    const note = built.defaultsOnly ? `(注意:${PLAYER_DATABASE_DEFAULTS_ONLY_WARNING})` : '';
    const message = `连接成功(${built.config.host}:${built.config.port}/${built.config.databaseName},${Date.now() - startedAt}ms,只读会话)${note}`;
    playerDataChannel().appendLine(`[连接检查 ${formatPlayerTaskTime(Date.now())}] ${message}`);
    return { message, outcome: 'success' };
  } catch (error) {
    const note = built.defaultsOnly ? `(注意:${PLAYER_DATABASE_DEFAULTS_ONLY_WARNING})` : '';
    const message = `连接失败:${maskPlayerTaskErrorText(error instanceof Error ? error.message : String(error))}(只读降级,不影响其他功能)${note}`;
    playerDataChannel().appendLine(`[连接检查 ${formatPlayerTaskTime(Date.now())}] ${message}`);
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
    return { message: 'dbid 仅接受十进制正整数', outcome: 'failed' };
  }
  const built = buildConnectionConfig();
  if (!built) {
    return { message: '未找到数据库配置段——未查询', outcome: 'failed' };
  }
  if (!built.config.plainPassword) {
    return { message: '密码不可读(引擎 RSA 密文或未配置)——未查询', outcome: 'failed' };
  }
  let executor: DriftQueryExecutor | null = null;
  try {
    executor = await createMysqlDriftExecutor(built.config);
    const result = await executor.runQuery(sql);
    const channel = playerDataChannel();
    channel.appendLine(`[dbid ${dbid.trim()}] ${sql}`);
    if (built.defaultsOnly) {
      channel.appendLine(`(注意:${PLAYER_DATABASE_DEFAULTS_ONLY_WARNING})`);
    }
    if (result.rows.length === 0) {
      channel.appendLine('(0 行——该 dbid 不存在或账号表为空)');
    }
    for (const row of result.rows) {
      channel.appendLine(JSON.stringify(row));
    }
    channel.show();
    const note = built.defaultsOnly ? `(注意:${PLAYER_DATABASE_DEFAULTS_ONLY_WARNING})` : '';
    const message = `查询完成:${result.rows.length} 行(结果见输出通道,只读)${note}`;
    return { message, outcome: result.rows.length === 0 ? 'empty' : 'success' };
  } catch (error) {
    const note = built.defaultsOnly ? `(注意:${PLAYER_DATABASE_DEFAULTS_ONLY_WARNING})` : '';
    const message = `查询失败:${maskPlayerTaskErrorText(error instanceof Error ? error.message : String(error))}${note}`;
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
    { task: 'query', label: '玩家查询' },
    { task: 'connection', label: '连接检查' }
  ];
  return tasks.map(({ task, label }) => {
    const status = playerTaskStatusStore.get(task);
    const kindLabel = PLAYER_TASK_OUTCOME_LABELS[status?.outcome ?? 'not-run'];
    const hasDetail = Boolean(status?.detailCommandId);
    return {
      label: `${label}:${kindLabel}`,
      description: status?.finishedAt ? formatPlayerTaskTime(status.finishedAt) : undefined,
      tooltip: status
        ? `${status.summary}${status.finishedAt ? `(完成于 ${formatPlayerTaskTime(status.finishedAt)})` : ''}`
        : '本次会话尚未运行过;结果入口在运行后出现。',
      commandId: hasDetail ? status?.detailCommandId : undefined,
      contextValue: hasDetail ? `playerTaskStatus${task}` : undefined
    };
  });
}
