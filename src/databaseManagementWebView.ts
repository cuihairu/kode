/**
 * KBEngine 数据库管理 WebView(SRC-012 拆半口径:控制器半边)。
 *
 * 职责:面板生命周期/createWebviewPanel/消息处理/数据获取/后端分支。
 * MySQL 半边复用只读 drift 执行器(会话 READ ONLY + 逐语句白名单双保险),
 * Redis 半边复用只读 RedisSession(SCAN/HGETALL 只读命令集);面板自建
 * dbType 分支(mysql/redis/none),不引入 clone 专用写路径——整面零写。
 *
 * 连接生命周期:open-per-operation(每次操作建连→工作→finally 关),不持
 * 长驻连接;切 tab/dispose 仅 bump 代际使在途结果在写入面弃置(轻量
 * KODE-PERF-005 守卫)。
 */

import * as vscode from 'vscode';
import {
  createMysqlDriftExecutor,
  type DriftQueryExecutor
} from './backend/databaseDrift';
import { buildTablePreviewStatement, previewTableData } from './backend/databaseTablePreview';
import { listPreviewTables } from './databaseTablePreviewCommand';
import {
  openRedisSession,
  type RedisConnectionConfig,
  type RedisSession
} from './backend/redisDrift';
import { enumerateRedisKeys } from './redisKeyspaceCommand';
import { formatRedisHashPreview } from './redisKeySpace';
import { getDerivedDatabaseProfile } from './configDerive';
import { resolveDatabaseInterfaceConfig, type DatabaseInterfaceConfig } from './serverConfigMerge';
import { randomNonce } from './webviewSecurity';
import { resolvePanelLocale, strings } from './webviewStrings';
import {
  renderDatabaseManagementWebview,
  type DatabaseBackendType,
  type DatabaseManagementProfileSummary
} from './databaseManagementWebViewHtml';

/** 派生数据库档案(真源 Rust derive_database)。 */
type DerivedDatabaseProfile = NonNullable<ReturnType<typeof getDerivedDatabaseProfile>>;

/** 依赖注入面(单测注入假实现;未注入时默认接真实现)。 */
export interface DatabaseManagementDeps {
  /** 派生档案;null = 未读取到(面板出「无档案」,后端标签禁能)。 */
  resolveProfile(): DerivedDatabaseProfile | null;
  /** 明文连接配置(仅 encrypt=false 有 plainPassword);null = 读不到。 */
  resolveConfig(): DatabaseInterfaceConfig | null;
  /** mysql 执行器工厂(默认 createMysqlDriftExecutor;内部动态装载 mysql2 为既有封装)。 */
  createMysqlExecutor?(config: DatabaseInterfaceConfig): Promise<DriftQueryExecutor>;
  /** redis 会话工厂(默认 openRedisSession)。 */
  openRedisSession?(config: RedisConnectionConfig): Promise<RedisSession>;
  /** 建连超时兜底(默认 10_000ms;0 = 不限时)。 */
  connectTimeoutMs?: number;
}

/** 派生档案 → 面板摘要(去 available/dbType 外的展示字段)。 */
function toProfileSummary(profile: DerivedDatabaseProfile): DatabaseManagementProfileSummary {
  return {
    host: profile.host,
    port: profile.port,
    username: profile.username,
    databaseName: profile.databaseName,
    characterSet: profile.characterSet,
    encrypt: profile.encrypt,
    passwordAvailable: profile.passwordAvailable
  };
}

/** 派生档案 → 面板后端类型('none' = 无档案/未知后端)。 */
function toBackendType(profile: DerivedDatabaseProfile | null): DatabaseBackendType {
  if (!profile) {
    return 'none';
  }
  return profile.dbType === 'mysql' ? 'mysql' : profile.dbType === 'redis' ? 'redis' : 'none';
}

export class DatabaseManagementWebView {
  private panel: vscode.WebviewPanel | null = null;
  /** 代际守卫:切 tab/dispose 使在途结果在写入面弃置(防旧结果渲染进新 tab)。 */
  private generation = 0;
  private readonly deps: DatabaseManagementDeps;

  constructor(
    private context: vscode.ExtensionContext,
    deps: Partial<DatabaseManagementDeps> = {}
  ) {
    this.deps = {
      resolveProfile: deps.resolveProfile ?? (() => getDerivedDatabaseProfile()),
      resolveConfig: deps.resolveConfig ?? (() => resolveDatabaseInterfaceConfig()),
      createMysqlExecutor: deps.createMysqlExecutor ?? createMysqlDriftExecutor,
      openRedisSession: deps.openRedisSession ?? openRedisSession,
      connectTimeoutMs: deps.connectTimeoutMs ?? 10_000
    };
  }

  /** 显示面板(幂等:已开 → reveal;未开 → createWebviewPanel + 渲染)。 */
  show(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    const profile = this.deps.resolveProfile();
    const dbType = toBackendType(profile);
    const title = strings(resolvePanelLocale()).databaseManagement.title;
    this.panel = vscode.window.createWebviewPanel(
      'kbengine.databaseManagement',
      title,
      vscode.ViewColumn.Two,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    this.panel.onDidDispose(() => {
      this.panel = null;
      // KODE-PERF-005 口径:关面板即弃置在途结果
      this.generation += 1;
    });

    this.panel.webview.onDidReceiveMessage(
      message => {
        void this.handleMessage(message);
      },
      undefined,
      this.context.subscriptions
    );

    this.panel.webview.html = this.getWebviewContent(dbType, profile);
  }

  /** 防御性清理(与既有面板同口径)。 */
  dispose(): void {
    if (this.panel) {
      this.panel.dispose();
      this.panel = null;
    }
  }

  /** 获取 Webview 内容(薄委托,SRC-012:补面板态入参后调 HTML 半边)。 */
  private getWebviewContent(
    dbType: DatabaseBackendType,
    profile: DerivedDatabaseProfile | null
  ): string {
    return renderDatabaseManagementWebview({
      dbType,
      profile: profile ? toProfileSummary(profile) : null,
      nonce: randomNonce(),
      cspSource: this.panel?.webview.cspSource ?? 'vscode-webview:'
    });
  }

  /** 消息分发(前端 → 扩展)。 */
  private async handleMessage(message: {
    command?: string;
    table?: unknown;
    key?: unknown;
    tab?: unknown;
  }): Promise<void> {
    switch (message?.command) {
      case 'setTab':
        // 前端本地已切 tab;此处仅弃置在途旧后端结果(防旧结果渲染进新 tab)
        this.generation += 1;
        break;
      case 'loadTables':
        await this.handleLoadTables();
        break;
      case 'previewTable':
        await this.handlePreviewTable(String(message.table ?? ''));
        break;
      case 'scanKeys':
        await this.handleScanKeys();
        break;
      case 'previewKey':
        await this.handlePreviewKey(String(message.key ?? ''));
        break;
    }
  }

  /** MySQL 连接要素解析(档案/后端/密码/配置四重门禁,错误串面向用户)。 */
  private resolveMysqlConfig(): { config: DatabaseInterfaceConfig } | { error: string } {
    const profile = this.deps.resolveProfile();
    if (!profile) {
      return { error: '未读取到引擎数据库档案' };
    }
    if (toBackendType(profile) !== 'mysql') {
      return { error: '当前数据库后端不是 MySQL' };
    }
    if (!profile.passwordAvailable) {
      return { error: '密码不可读(引擎 RSA 密文或未配置)——无法连接' };
    }
    const config = this.deps.resolveConfig();
    if (!config) {
      return { error: '未读取到连接配置' };
    }
    return { config };
  }

  /** Redis 连接要素解析(口径与 buildRedisConnectionConfig 一致:dbIndex 自 databaseName)。 */
  private resolveRedisConfig(): { config: RedisConnectionConfig } | { error: string } {
    const profile = this.deps.resolveProfile();
    if (!profile) {
      return { error: '未读取到引擎数据库档案' };
    }
    if (toBackendType(profile) !== 'redis') {
      return { error: '当前数据库后端不是 Redis' };
    }
    if (!profile.passwordAvailable) {
      return { error: '密码不可读(引擎 RSA 密文或未配置)——无法连接' };
    }
    const config = this.deps.resolveConfig();
    if (!config) {
      return { error: '未读取到连接配置' };
    }
    const index = Number.parseInt(String(profile.databaseName || '0'), 10);
    return {
      config: {
        host: profile.host,
        port: profile.port,
        password: config.plainPassword,
        dbIndex: Number.isFinite(index) ? index : 0
      }
    };
  }

  /** 建连超时兜底:超时 reject,晚落地的执行器/会话经 onLate 关闭防泄漏。 */
  private async connectWithTimeout<T>(
    factory: () => Promise<T>,
    onLate: (value: T) => void,
    errorMessage: string
  ): Promise<T> {
    const ms = this.deps.connectTimeoutMs ?? 10_000;
    const promise = factory();
    if (!ms) {
      return promise;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new Error(errorMessage));
      }, ms);
    });
    // 晚落地(超时后才 resolve)的句柄关闭防泄漏;reject 晚落地无句柄可关
    promise.then(
      value => {
        if (timedOut) {
          onLate(value);
        }
      },
      () => {
        // 忽略:晚落地 reject
      }
    );
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  /** MySQL 表清单。 */
  private async handleLoadTables(): Promise<void> {
    const gen = this.generation;
    const resolved = this.resolveMysqlConfig();
    if ('error' in resolved) {
      this.post({ command: 'tablesLoaded', result: { ok: false, error: resolved.error } });
      return;
    }
    let executor: DriftQueryExecutor | null = null;
    try {
      executor = await this.connectWithTimeout(
        () => this.deps.createMysqlExecutor!(resolved.config),
        ex => {
          void ex.close().catch(() => {});
        },
        `连接 MySQL 超时(${resolved.config.host}:${resolved.config.port})`
      );
      const result = await listPreviewTables(sql => executor!.runQuery(sql));
      if (gen !== this.generation) {
        return;
      }
      this.post({
        command: 'tablesLoaded',
        result: result.ok ? { ok: true, tables: result.tables } : { ok: false, error: result.reason }
      });
    } catch (error) {
      if (gen !== this.generation) {
        return;
      }
      this.post({ command: 'tablesLoaded', result: { ok: false, error: this.errorText(error) } });
    } finally {
      if (executor) {
        await executor.close().catch(() => {});
      }
    }
  }

  /** MySQL 表数据预览(白名单 SELECT * LIMIT,只读)。 */
  private async handlePreviewTable(table: string): Promise<void> {
    const gen = this.generation;
    const resolved = this.resolveMysqlConfig();
    if ('error' in resolved) {
      this.post({ command: 'tablePreview', result: { kind: 'error', message: resolved.error } });
      return;
    }
    // 表名预检:非法表名(仅字母/数字/下划线/美元)不建连,直接拒绝
    const statement = buildTablePreviewStatement(table);
    if ('error' in statement) {
      this.post({ command: 'tablePreview', result: { kind: 'error', message: statement.error } });
      return;
    }
    let executor: DriftQueryExecutor | null = null;
    try {
      executor = await this.connectWithTimeout(
        () => this.deps.createMysqlExecutor!(resolved.config),
        ex => {
          void ex.close().catch(() => {});
        },
        `连接 MySQL 超时(${resolved.config.host}:${resolved.config.port})`
      );
      const result = await previewTableData(table, {
        runQuery: sql => executor!.runQuery(sql)
      });
      if (gen !== this.generation) {
        return;
      }
      this.post({ command: 'tablePreview', result });
    } catch (error) {
      if (gen !== this.generation) {
        return;
      }
      this.post({ command: 'tablePreview', result: { kind: 'error', message: this.errorText(error) } });
    } finally {
      if (executor) {
        await executor.close().catch(() => {});
      }
    }
  }

  /** Redis 键空间枚举(SCAN 循环,页上限截断如实标记)。 */
  private async handleScanKeys(): Promise<void> {
    const gen = this.generation;
    const resolved = this.resolveRedisConfig();
    if ('error' in resolved) {
      this.post({ command: 'keysLoaded', result: { ok: false, error: resolved.error } });
      return;
    }
    let session: RedisSession | null = null;
    try {
      session = await this.connectWithTimeout(
        () => this.deps.openRedisSession!(resolved.config),
        s => {
          s.close();
        },
        `连接 Redis 超时(${resolved.config.host}:${resolved.config.port})`
      );
      const { keys, truncated } = await enumerateRedisKeys(session, 'kbe_*');
      if (gen !== this.generation) {
        return;
      }
      this.post({ command: 'keysLoaded', result: { ok: true, keys, truncated } });
    } catch (error) {
      if (gen !== this.generation) {
        return;
      }
      this.post({ command: 'keysLoaded', result: { ok: false, error: this.errorText(error) } });
    } finally {
      if (session) {
        session.close();
      }
    }
  }

  /** Redis 键哈希预览(HGETALL 只读)。 */
  private async handlePreviewKey(key: string): Promise<void> {
    const gen = this.generation;
    const resolved = this.resolveRedisConfig();
    if ('error' in resolved) {
      this.post({ command: 'keyPreview', result: { ok: false, error: resolved.error } });
      return;
    }
    let session: RedisSession | null = null;
    try {
      session = await this.connectWithTimeout(
        () => this.deps.openRedisSession!(resolved.config),
        s => {
          s.close();
        },
        `连接 Redis 超时(${resolved.config.host}:${resolved.config.port})`
      );
      const fields = await session.hashGetAll(key);
      if (gen !== this.generation) {
        return;
      }
      this.post({
        command: 'keyPreview',
        result: { ok: true, key, fields, text: formatRedisHashPreview(key, fields) }
      });
    } catch (error) {
      if (gen !== this.generation) {
        return;
      }
      this.post({ command: 'keyPreview', result: { ok: false, error: this.errorText(error) } });
    } finally {
      if (session) {
        session.close();
      }
    }
  }

  /** 向前端推送(面板在时才发)。 */
  private post(message: unknown): void {
    if (this.panel) {
      void this.panel.webview.postMessage(message);
    }
  }

  private errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
