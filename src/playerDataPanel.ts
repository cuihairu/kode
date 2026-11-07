/**
 * CLONE-P5 骨架(用户令 2026-11-06):「玩家数据」专用**只读**面板。
 *
 * 硬约束(用户令,非建议):
 * - 不做通用 MySQL 客户端;界面**零编辑字段**——连接要素只来自引擎配置
 *   (Rust derive_database 单一真源),不接受任何手填/改写;
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
import { createMysqlDriftExecutor, type DriftQueryExecutor } from './databaseDrift';
import {
  resolveDatabaseInterfaceConfig,
  type DatabaseInterfaceConfig
} from './serverConfigMerge';

/** 只读查询结果输出通道(展示面,不可编辑) */
export const PLAYER_DATA_CHANNEL_NAME = 'KBEngine 玩家数据(只读)';

interface PlayerDataNodeItem {
  label: string;
  description?: string;
  tooltip?: string | vscode.MarkdownString;
  collapsibleState?: vscode.TreeItemCollapsibleState;
  children?: PlayerDataNodeItem[];
}

/**
 * 连接档案节点(纯函数,便于单测):密码只出掩码标记,永不出值。
 */
export function buildPlayerDataTreeNodes(
  profile: ReturnType<typeof getDerivedDatabaseProfile>
): PlayerDataNodeItem[] {
  if (!profile) {
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
  const kind = profile.dbType === 'mysql' ? 'mysql' : profile.dbType === 'redis' ? 'redis' : `${profile.dbType}(未知)`;
  const password = profile.encrypt
    ? '●●●●●●(RSA 密文,不解读)'
    : profile.passwordAvailable
      ? '●●●●●●(明文可读,仅连接用)'
      : '(未配置)';
  return [
    {
      label: `${kind} default`,
      description: `${profile.host}:${profile.port}/${profile.databaseName}`,
      tooltip: new vscode.MarkdownString(
        [
          '```',
          `type         ${profile.dbType}`,
          `host         ${profile.host}`,
          `port         ${profile.port}`,
          `username     ${profile.username}`,
          `password     ${password}`,
          `database     ${profile.databaseName}`,
          `charset      ${profile.characterSet}`,
          '```',
          '来源:引擎配置(Rust derive_database 派生,只读)'
        ].join('\n')
      ),
      collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
      children: [
        { label: '类型', description: profile.dbType },
        { label: '主机', description: profile.host },
        { label: '端口', description: String(profile.port) },
        { label: '账号', description: profile.username },
        { label: '密码', description: password },
        { label: '数据库', description: profile.databaseName },
        { label: '字符集', description: profile.characterSet }
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
    return buildPlayerDataTreeNodes(getDerivedDatabaseProfile()).map(toItem);
  }
}

/** 派生档案 + 引擎明文密码 → 只读连接(密码只在此处聚合,不落任何日志/展示) */
function buildConnectionConfig(): {
  config: DatabaseInterfaceConfig;
  plaintextUnavailable: boolean;
} | null {
  const profile = getDerivedDatabaseProfile();
  if (!profile) {
    return null;
  }
  // 明文密码与派生档案同源(引擎配置):RSA 密文读不出明文 → undefined。
  const plain = resolveDatabaseInterfaceConfig()?.plainPassword;
  return {
    config: {
      host: profile.host,
      port: profile.port,
      username: profile.username,
      databaseName: profile.databaseName,
      encrypt: profile.encrypt,
      characterSet: profile.characterSet,
      plainPassword: plain
    },
    plaintextUnavailable: !plain
  };
}

/** 连接测试(只读 SELECT 1):成功给出耗时,失败如实降级(不回显密码)。 */
export async function testPlayerDatabaseConnection(): Promise<string> {
  const built = buildConnectionConfig();
  if (!built) {
    return '未找到数据库配置段(dbmgr/databaseInterfaces/default)——未测试';
  }
  if (built.config.encrypt && !built.config.plainPassword) {
    return '密码为引擎 RSA 密文,不解读——未测试(如需测试请在引擎配置中显式 encrypt=false)';
  }
  const startedAt = Date.now();
  let executor: DriftQueryExecutor | null = null;
  try {
    executor = await createMysqlDriftExecutor(built.config);
    await executor.runQuery('SELECT 1 AS ok');
    return `连接成功(${built.config.host}:${built.config.port}/${built.config.databaseName},${Date.now() - startedAt}ms,只读会话)`;
  } catch (error) {
    return `连接失败:${error instanceof Error ? error.message : String(error)}(只读降级,不影响其他功能)`;
  } finally {
    await executor?.close().catch(() => {
      /* 关闭失败不掩盖主结果 */
    });
  }
}

/** dbid 输入校验:仅十进制正整数(安全内联;非参数面经白名单执行器) */
export function buildPlayerQuerySql(dbid: string, tablePrefix: string): string | null {
  if (!/^\d+$/.test(dbid.trim())) {
    return null;
  }
  const prefix = tablePrefix.trim() || 'tbl_';
  return 'SELECT * FROM `' + prefix.replace(/`/g, '') + 'Account` WHERE `id` = ' + dbid.trim();
}

/** 按 dbid 查询玩家(只读):结果整表 JSON 落输出通道展示,零编辑。 */
export async function queryPlayerByDbid(dbid: string): Promise<string> {
  const sql = buildPlayerQuerySql(
    dbid,
    vscode.workspace.getConfiguration('kbengine').get<string>('db.tablePrefix', '')
  );
  if (!sql) {
    return 'dbid 仅接受十进制正整数';
  }
  const built = buildConnectionConfig();
  if (!built) {
    return '未找到数据库配置段——未查询';
  }
  if (!built.config.plainPassword) {
    return '密码不可读(引擎 RSA 密文或未配置)——未查询';
  }
  let executor: DriftQueryExecutor | null = null;
  try {
    executor = await createMysqlDriftExecutor(built.config);
    const result = await executor.runQuery(sql);
    const channel = vscode.window.createOutputChannel(PLAYER_DATA_CHANNEL_NAME);
    channel.appendLine(`[dbid ${dbid.trim()}] ${sql}`);
    if (result.rows.length === 0) {
      channel.appendLine('(0 行——该 dbid 不存在或账号表为空)');
    }
    for (const row of result.rows) {
      channel.appendLine(JSON.stringify(row));
    }
    channel.show();
    return `查询完成:${result.rows.length} 行(结果见输出通道,只读)`;
  } catch (error) {
    return `查询失败:${error instanceof Error ? error.message : String(error)}`;
  } finally {
    await executor?.close().catch(() => {
      /* 关闭失败不掩盖主结果 */
    });
  }
}
