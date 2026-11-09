// KODE-ARCH-002:extension.ts 装配模块——数据库域(schema 打开/模拟/漂移/
// 表预览/schema 影响/玩家数据克隆与连接档案)。纯移动:命令体/通道/缓存逐行
// 迁出 activate,装配顺序由调用方保持。
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { l10nText } from './nlsRuntime';
import { onDidChangeActiveProfile, resolveActiveProfile } from './activeProfile';
import { findEngineRoot } from './backend/engineCompatibility';
import { getRegisteredEntities, getWorkspaceRootForDocument } from './definitionWorkspace';
import {
  getDatabaseSchemaSnapshot,
  locateDatabaseSchemaLine,
  resolveEntityTableName,
  resolveSchemaTablePrefix
} from './databaseSchema';
import { createDatabaseSchemaUri, KBEngineDatabaseSchemaProvider } from './databaseSchemaPresentation';
import {
  checkDatabaseDrift,
  checkDatabaseDriftForSnapshots,
  createMysqlDriftExecutor,
  DATABASE_DRIFT_CHANNEL_NAME,
  publishDriftReport,
  type DriftReport
} from './backend/databaseDrift';
import { classifyDriftEvidence, DriftEvidenceStore } from './backend/databaseDriftEvidence';
import {
  DRIFT_EVIDENCE_STATE_KEY,
  formatDriftEvidenceSaveLine,
  formatDriftEvidenceSkipLine,
  recordDriftEvidenceFromReport,
  runShowDriftEvidenceCommand
} from './databaseDriftEvidenceIntegration';
import { runTablePreviewCommand } from './databaseTablePreviewCommand';
import { createPreviewColumnSourceTableResolver } from './backend/databasePreviewColumnSource';
import { runSchemaImpactCommand } from './databaseSchemaImpactCommand';
import {
  runConfigureCloneProfileCommand,
  runExportCloneCommand,
  runImportCloneCommand,
  runInspectCloneArchiveCommand,
  runShowCloneAuditCommand,
  runTestCloneConnectionCommand,
  type PlayerCloneCommandDeps
} from './backend/playerDataCloneCommands';
import { CloneProfileStore } from './backend/playerDataCloneProfiles';
import { guardConnectionFactoryWithQueryLifecycle, type QueryGuard } from './databaseQueryLifecycleIntegration';
import {
  createDatabaseSimulationUri,
  getSimulationEntityName,
  isDatabaseSimulationDocument
} from './databaseSimulator';
import { readEngineVersionMarker } from './backend/engineApiMetadata';
import { getEngineVersion } from './engineVersion';
import { detectEngineVersionMarker, engineVersionSuggestion } from './backend/engineVersionDetect';
import { type DatabaseInterfaceConfig } from './serverConfigMerge';
import { ensureConfigResolved } from './serverConfigResolve';
import { DatabaseConnectionRegistry, DatabaseQueryResultCache } from './backend/databaseConnectionRegistry';
import {
  DATABASE_CONNECTIONS_STATE_KEY,
  ProfileDatabaseConnectionService,
  WORKSPACE_DEFAULT_DATABASE_PROFILE_ID,
  createProfileScopedDriftExecutor,
  getProfileDatabaseConnections,
  installProfileDatabaseConnections,
  resolveProfileDatabaseInterfaceConfig,
  profileConfigResolveOverrides
} from './backend/profileDatabaseConnection';

export interface DatabaseWiringDeps {
  databaseSchemaProvider: KBEngineDatabaseSchemaProvider;
}

export function wireDatabase(context: vscode.ExtensionContext, deps: DatabaseWiringDeps): void {
  const { databaseSchemaProvider } = deps;

  const openDatabaseSchemaCommand = vscode.commands.registerCommand(
    'kbengine.database.open',
    async (entityName?: string, tableName?: string, fieldName?: string, workspaceRoot?: string) => {
      // 命令面板无参直开时取活动 .def 推断实体,与 simulate 同口径;仍无实体
      // 如实提示——此前命令体直接 return,面板点了毫无反应,数据库表结构入口
      // 找不到(Entities 视图的数据库条目是唯一可达路径)
      const resolvedEntityName = entityName ?? resolveActiveDefEntityName();
      if (!resolvedEntityName) {
        vscode.window.showInformationMessage('请先打开一个实体 .def 文件');
        return;
      }
      // AUD-055:根身份贯穿——视图/CodeLens 显式传根优先;面板直开从活动
      // 文档解析所在根(A/B 同名实体可各开各根,不串根)
      const resolvedRoot = workspaceRoot
        ?? getWorkspaceRootForDocument(vscode.window.activeTextEditor?.document);

      try {
        const uri = createDatabaseSchemaUri(resolvedEntityName, resolvedRoot);
        const document = await vscode.workspace.openTextDocument(uri);
        // IDE-SCH-010:优先用「屏上这一代」渲染定位(展示与跳转同源,await 期间
        // def/配置变更不撕裂行号);未发布过才退独立快照口径
        const publishedSnapshot = databaseSchemaProvider.getPublishedSnapshot(uri);
        const line = publishedSnapshot !== undefined
          ? databaseSchemaProvider.locateInPublishedContent(
              uri,
              tableName || resolveEntityTableName(resolvedEntityName, publishedSnapshot),
              fieldName
            ) ?? 1
          : (() => {
              const snapshot = getDatabaseSchemaSnapshot(resolvedEntityName, resolvedRoot ?? undefined);
              return snapshot
                ? locateDatabaseSchemaLine(snapshot, tableName || resolveEntityTableName(resolvedEntityName, snapshot), fieldName)
                : 1;
            })();
        const position = new vscode.Position(Math.max(line - 1, 0), 0);
        const selection = new vscode.Range(position, position);
        await vscode.window.showTextDocument(document, { selection });
      } catch (error) {
        vscode.window.showWarningMessage(
          `打开数据库结构失败: ${resolvedEntityName}${tableName ? ` (${tableName}${fieldName ? `.${fieldName}` : ''})` : ''} (${error})`
        );
      }
    }
  );
  context.subscriptions.push(openDatabaseSchemaCommand);

  // 活动编辑器的 .def 路径给出实体名;非 .def 返回 undefined(批122)
  function resolveActiveDefEntityName(): string | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'kbengine-def') {
      return undefined;
    }
    return path.basename(editor.document.uri.fsPath, '.def');
  }

  // 数据库模拟(批122):活动 .def 为实体打开模拟文档;无活动 .def 如实提示,
  // 不静默空转
  const simulateDatabaseCommand = vscode.commands.registerCommand(
    'kbengine.database.simulate',
    async (entityName?: string) => {
      const resolvedEntityName = entityName ?? resolveActiveDefEntityName();
      if (!resolvedEntityName) {
        vscode.window.showInformationMessage('请先打开一个实体 .def 文件');
        return;
      }
      try {
        const uri = createDatabaseSimulationUri(resolvedEntityName);
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
      } catch (error) {
        vscode.window.showWarningMessage(`打开数据库模拟失败: ${resolvedEntityName} (${error})`);
      }
    }
  );
  context.subscriptions.push(simulateDatabaseCommand);

  // 数据库模拟导出(批122):当前模拟文档全文经 showSaveDialog 落盘;取消直接
  // 返回,写出失败进错误通道不裸抛
  const exportDatabaseSimulationCommand = vscode.commands.registerCommand(
    'kbengine.database.exportSimulation',
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !isDatabaseSimulationDocument(editor.document)) {
        vscode.window.showWarningMessage('请先打开数据库模拟文档');
        return;
      }
      const defaultUri = vscode.Uri.file(
        `${getSimulationEntityName(editor.document.uri)}-simulation.md`
      );
      const target = await vscode.window.showSaveDialog({
        defaultUri,
        filters: { Markdown: ['md'] }
      });
      if (!target) {
        return;
      }
      try {
        await vscode.workspace.fs.writeFile(target, Buffer.from(editor.document.getText(), 'utf8'));
      } catch (error) {
        vscode.window.showErrorMessage(`导出数据库模拟失败: ${error}`);
      }
    }
  );
  context.subscriptions.push(exportDatabaseSimulationCommand);

  // 数据库漂移校验(批C):用真实表结构反向校验 def 推导的虚拟表结构——
  // 属性→字段映射算错时唯一会暴露的地方。连接要素读引擎配置,不新增配置项;
  // 语句白名单 + 只读会话双保险;连不上降级为「未校验」不报错
  //
  // IDE-REV-015:连接配置经 profile 台账取——活动 profile 的引擎根/资产根
  // 各自推导 dbmgr 连接要素入 DatabaseConnectionRegistry,命令只认台账;
  // 台账无记录 = 如实「读不到配置」,绝不回退邻居 profile/工作区设置。
  // 切换活动 profile 即释放旧 profile 的结果缓存;查询结果按 profile
  // 缓存(TTL 内同 SQL 不再下发连接)。
  const databaseDriftChannel = vscode.window.createOutputChannel(DATABASE_DRIFT_CHANNEL_NAME);
  context.subscriptions.push(databaseDriftChannel);
  const databaseConnectionRegistry = new DatabaseConnectionRegistry({
    now: () => Date.now(),
    load: () => context.workspaceState?.get(DATABASE_CONNECTIONS_STATE_KEY),
    save: data => { void context.workspaceState?.update(DATABASE_CONNECTIONS_STATE_KEY, data); }
  });
  const databaseQueryResultCache = new DatabaseQueryResultCache({ now: () => Date.now() });
  const databaseConnections = new ProfileDatabaseConnectionService({
    registry: databaseConnectionRegistry,
    queryResultCache: databaseQueryResultCache,
    resolveConfig: resolveProfileDatabaseInterfaceConfig
  });
  installProfileDatabaseConnections(databaseConnections);
  context.subscriptions.push({
    dispose: () => {
      // 只卸自己:后续激活装的新服务不被旧上下文卸掉
      if (getProfileDatabaseConnections() === databaseConnections) {
        installProfileDatabaseConnections(null);
      }
    }
  });
  // 切换即释放:活动 profile 换人时立刻清旧 profile 的会话面(不等下次命令)
  context.subscriptions.push(
    onDidChangeActiveProfile(() => {
      const profile = resolveActiveProfile(context.workspaceState);
      // KODE-CFG-009:切 profile 即按其根组合预取 core 解析(消费缓存)
      void ensureConfigResolved(profileConfigResolveOverrides(profile)).catch(() => {});
      databaseConnections.selectActive(
        profile?.id ?? WORKSPACE_DEFAULT_DATABASE_PROFILE_ID,
        profile
      );
    })
  );
  // KODE-CFG-009:连接读值消费 core 解析缓存——命令执行面先按当前活动
  // profile 的根组合等 core 解析就绪再读缓存(旧同步解析「首取即得」语义
  // 保留;IDE-REV-015 两项目两配置测试钉住首次执行即生效,fire-and-forget
  // 版首取未就绪会让首次执行误降级为「读不到配置」)
  const ensureCommandConfigResolved = async (): Promise<void> => {
    const profile = resolveActiveProfile(context.workspaceState);
    await ensureConfigResolved(profileConfigResolveOverrides(profile)).catch(() => {});
  };
  /**
   * 命令取连接:每次执行按当前活动 profile 重选(引擎配置变更即时生效),
   * 只认台账。IDE-AUD-011:附资产根作用域——列来源/实体表反查按当前连接
   * 的资产根限定,不跨 workspace 首命中(两项目同名表只看当前连接项目)。
   * 作用域根 = 活动 profile 的资产根;profile 无自己的根(空串/无 profile
   * = 工作区默认链,连接配置经 resolveDatabaseInterfaceConfig 全局设置链)
   * 时回落首个工作区文件夹——工作区默认项目的资产根,与 schema 快照按
   * 工作区文件夹键的口径一致(schema 快照在给定根下找 scripts/,无引擎
   * 探针也能建;发现链要 kbengine.xml 才认根,对纯资产 fixture 过严)。
   */
  const resolveCommandDatabaseConnection = (): {
    profileId: string;
    config: DatabaseInterfaceConfig;
    assetsRoot: string | null;
  } | null => {
    const profile = resolveActiveProfile(context.workspaceState);
    const profileId = profile?.id ?? WORKSPACE_DEFAULT_DATABASE_PROFILE_ID;
    // KODE-CFG-009:连接读值消费 core 解析缓存,取前先刷新(async 命令内
    // fire-and-forget 不阻塞;首取未就绪时本命令如实降级,下次执行即生效)
    void ensureConfigResolved(profileConfigResolveOverrides(profile)).catch(() => {});
    databaseConnections.selectActive(profileId, profile);
    const config = databaseConnections.getActiveConfig(profileId);
    if (!config) {
      return null;
    }
    const profileRoot = profile?.assetsRoot ?? '';
    if (profileRoot) {
      return { profileId, config, assetsRoot: profileRoot };
    }
    const firstRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    return { profileId, config, assetsRoot: firstRoot || null };
  };
  // IDE-REV-017 查询生命周期接线:漂移校验/表预览的真实数据库入口(建连+
  // 每条只读查询)都过 databaseQueryLifecycle——时限走 kbengine.databaseQueryTimeoutMs
  // (0 或负值不限时,与附加调试同口径),取消走 withProgress 进度通知令牌;
  // 超时/取消立即带原因返回,连接等底层结算(上限 min(5s, 时限))后 close/
  // destroy 恰一次,建连晚落地也兜底关掉。
  const DATABASE_QUERY_TIMEOUT_DEFAULT_MS = 10000;
  const readDatabaseQueryTimeoutMs = (): number => {
    const raw = vscode.workspace.getConfiguration('kbengine').get<number>('databaseQueryTimeoutMs');
    if (raw === undefined) {
      return DATABASE_QUERY_TIMEOUT_DEFAULT_MS;
    }
    return raw > 0 ? raw : Number.POSITIVE_INFINITY;
  };
  const runDatabaseQueryCommand = <T>(
    title: string,
    work: (guard: QueryGuard) => Promise<T>
  ): Thenable<T> =>
    vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title, cancellable: true },
      (_progress, token) => {
        const timeoutMs = readDatabaseQueryTimeoutMs();
        return work({
          timeoutMs,
          isCancelled: () => token.isCancellationRequested,
          releaseDeadlineMs: timeoutMs < 5000 ? timeoutMs : undefined
        });
      }
    );
  const lifecycleGuardedFactory = (
    guard: QueryGuard,
    profileId: string
  ): ReturnType<typeof createProfileScopedDriftExecutor> =>
    guardConnectionFactoryWithQueryLifecycle(
      createProfileScopedDriftExecutor(profileId, databaseQueryResultCache, createMysqlDriftExecutor),
      guard
    );
  // IDE-REV-020 漂移校验证据:真实执行(checked=true,确实查询过库)按引
  // 擎版本落 workspaceState,重查走 showDriftEvidence 命令;未校验不落
  // (模拟面单独存在也不冒充联调结果);版本探不到记 unknown——分类面
  // 按未知版本悬置结论,不宣称兼容。版本口径与 engineCompatibility 同源
  // (readEngineVersionMarker 版本宏读取,引擎根=活动 profile 根 → 设置根
  // → 工作区树探测)。
  const driftEvidenceStore = new DriftEvidenceStore({
    now: () => Date.now(),
    load: () => context.workspaceState?.get(DRIFT_EVIDENCE_STATE_KEY),
    save: data => { void context.workspaceState?.update(DRIFT_EVIDENCE_STATE_KEY, data); }
  });
  const resolveActiveEngineVersion = (): string | null => {
    const profile = resolveActiveProfile(context.workspaceState);
    const explicitRoot =
      profile?.engineRoot?.trim() ||
      vscode.workspace.getConfiguration('kbengine').get<string>('engineRoot', '').trim() ||
      undefined;
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const root = findEngineRoot(folder.uri.fsPath, explicitRoot);
      if (root) {
        return readEngineVersionMarker(root, probe => fs.readFileSync(probe, 'utf8'));
      }
    }
    return null;
  };
  // KB-VER-004 版本自动探测:打开项目时从引擎安装目录读版本标记并「建议」
  // kbengine.engineVersion 值,绝不自动改用户设置。忽略按探测到的版本值记
  // 入 workspaceState(版本变了可再建议);探测失败静默,不阻塞激活。
  const ENGINE_VERSION_SUGGEST_DISMISS_KEY = 'kbengine.engineVersionSuggestionDismissed';
  const maybeSuggestEngineVersion = (): void => {
    void (async () => {
      try {
        const folders = (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath);
        if (!folders.length) return;
        const profile = resolveActiveProfile(context.workspaceState);
        const explicitRoot =
          profile?.engineRoot?.trim() ||
          vscode.workspace.getConfiguration('kbengine').get<string>('engineRoot', '').trim() ||
          undefined;
        const detected = detectEngineVersionMarker(folders, explicitRoot, {
          findRoot: findEngineRoot,
          readMarker: root => readEngineVersionMarker(root, probe => fs.readFileSync(probe, 'utf8'))
        });
        const dismissed = context.workspaceState?.get<string>(ENGINE_VERSION_SUGGEST_DISMISS_KEY);
        const decision = engineVersionSuggestion(getEngineVersion(), detected, dismissed);
        if (decision.kind !== 'suggest') return;
        const set = '设置';
        const ignore = '忽略';
        const pick = await vscode.window.showInformationMessage(
          `检测到引擎版本标记 ${decision.version}(${detected!.engineRoot});是否将 kbengine.engineVersion 设为 ${decision.version}?`,
          set,
          ignore
        );
        if (pick === set) {
          await vscode.workspace.getConfiguration('kbengine').update(
            'engineVersion',
            decision.version,
            vscode.ConfigurationTarget.Workspace
          );
        } else if (pick === ignore) {
          await context.workspaceState?.update(ENGINE_VERSION_SUGGEST_DISMISS_KEY, decision.version);
        }
      } catch {
        // 探测/建议面不可用则静默——不因建议失败阻塞激活
      }
    })();
  };
  maybeSuggestEngineVersion();
  const appendDriftEvidenceForReport = (report: DriftReport): void => {
    const evidence = recordDriftEvidenceFromReport(report, {
      resolveEngineVersion: resolveActiveEngineVersion,
      now: () => Date.now()
    });
    if (evidence) {
      const saved = driftEvidenceStore.save(evidence);
      databaseDriftChannel.appendLine(formatDriftEvidenceSaveLine(saved, classifyDriftEvidence(saved)));
    } else {
      databaseDriftChannel.appendLine(formatDriftEvidenceSkipLine(report.reason ?? '未知原因'));
    }
  };
  const checkDatabaseDriftCommand = vscode.commands.registerCommand(
    'kbengine.database.checkDrift',
    async (entityName?: string) => {
      const resolvedEntityName = entityName ?? resolveActiveDefEntityName();
      if (!resolvedEntityName) {
        vscode.window.showInformationMessage('请先打开一个实体 .def 文件');
        return;
      }
      const snapshot = getDatabaseSchemaSnapshot(resolvedEntityName);
      if (!snapshot) {
        vscode.window.showWarningMessage(`读取实体定义失败: ${resolvedEntityName}(未找到 .def 文件)`);
        return;
      }
      await ensureCommandConfigResolved();
      const connection = resolveCommandDatabaseConnection();
      if (!connection) {
        vscode.window.showInformationMessage(
          '数据库漂移未校验:读不到引擎数据库配置(检查活动 profile 的引擎根/资产根,或 kbengine.binPath / assetsRoot 设置)'
        );
        return;
      }
      const report = await runDatabaseQueryCommand('KBEngine 数据库漂移校验', guard =>
        checkDatabaseDrift(
          snapshot,
          connection.config,
          resolveSchemaTablePrefix(),
          lifecycleGuardedFactory(guard, connection.profileId)
        )
      );
      publishDriftReport(databaseDriftChannel, vscode.window, report);
      appendDriftEvidenceForReport(report);
    }
  );
  context.subscriptions.push(checkDatabaseDriftCommand);

  const checkAllDatabaseDriftCommand = vscode.commands.registerCommand(
    'kbengine.database.checkAllDrift',
    async () => {
      const folders = vscode.workspace.workspaceFolders ?? [];
      const snapshots = folders.flatMap(folder =>
        getRegisteredEntities(folder.uri.fsPath)
          .map(entity => getDatabaseSchemaSnapshot(entity.name, folder.uri.fsPath))
          .filter((snapshot): snapshot is NonNullable<typeof snapshot> => snapshot !== null)
      );
      if (snapshots.length === 0) {
        vscode.window.showInformationMessage('数据库漂移未校验:工作区没有可检查的实体定义');
        return;
      }
      await ensureCommandConfigResolved();
      const connection = resolveCommandDatabaseConnection();
      if (!connection) {
        vscode.window.showInformationMessage(
          '数据库漂移未校验:读不到引擎数据库配置(检查活动 profile 的引擎根/资产根,或 kbengine.binPath / assetsRoot 设置)'
        );
        return;
      }
      const report = await runDatabaseQueryCommand('KBEngine 数据库全量漂移校验', guard =>
        checkDatabaseDriftForSnapshots(
          snapshots,
          connection.config,
          resolveSchemaTablePrefix(),
          lifecycleGuardedFactory(guard, connection.profileId)
        )
      );
      publishDriftReport(databaseDriftChannel, vscode.window, report);
      appendDriftEvidenceForReport(report);
    }
  );
  context.subscriptions.push(checkAllDatabaseDriftCommand);

  // IDE-REV-020 证据重查:已存证据按版本渲染进漂移通道,结论走
  // classifyDriftEvidence(未知版本悬置/纯模拟未验证/实测两态),无证据如实说无
  const showDriftEvidenceCommand = vscode.commands.registerCommand(
    'kbengine.database.showDriftEvidence',
    () =>
      runShowDriftEvidenceCommand({
        loadRecords: () => driftEvidenceStore.byVersion(),
        channel: databaseDriftChannel,
        showInformationMessage: message => vscode.window.showInformationMessage(message)
      })
  );
  context.subscriptions.push(showDriftEvidenceCommand);

  // IDE-REV-016 单表只读预览:同一条 profile 连接台账取连接,SHOW TABLES
  // 选表(拿不到退手输)→ 白名单限量 SELECT → 专用输出通道渲染;取消选表
  // 不发预览查询,连不上如实报错。IDE-REV-017:建连/查询过生命周期守卫,
  // 进度通知可取消,超时/取消带原因返回并释放连接。
  const tablePreviewChannel = vscode.window.createOutputChannel('KBEngine 数据库预览');
  context.subscriptions.push(tablePreviewChannel);
  const previewTableCommand = vscode.commands.registerCommand(
    'kbengine.database.previewTable',
    async () => {
      // KODE-CFG-009:runner 内同步取连接,先等 core 解析就绪(首取即得)
      await ensureCommandConfigResolved();
      return runDatabaseQueryCommand('KBEngine 数据库预览', guard =>
        runTablePreviewCommand({
          resolveConnection: resolveCommandDatabaseConnection,
            createConnection: (profileId, config) => lifecycleGuardedFactory(guard, profileId)(config),
          showQuickPick: (items, options) => vscode.window.showQuickPick(items, options),
          showInputBox: options => vscode.window.showInputBox(options),
          showInformationMessage: message => vscode.window.showInformationMessage(message),
          showErrorMessage: message => vscode.window.showErrorMessage(message),
          channel: tablePreviewChannel,
          // IDE-REV-018:预览表名反查虚拟 schema(逐注册实体含子表),
          // 列来源段给 def/type 声明处点击定位面
          resolveColumnSourceTable: createPreviewColumnSourceTableResolver({
            listEntityRoots: () =>
              (vscode.workspace.workspaceFolders ?? []).flatMap(folder =>
                getRegisteredEntities(folder.uri.fsPath).map(entity => ({
                  rootPath: folder.uri.fsPath,
                  entityName: entity.name
                }))
              ),
            getSnapshot: (entityName, rootPath) => getDatabaseSchemaSnapshot(entityName, rootPath)
          })
        }));
    }
  );
  context.subscriptions.push(previewTableCommand);

  // IDE-REV-019 单实体结构影响预览:真实库结构(只读 SHOW FULL COLUMNS)
  // 对照 def 推导虚拟 schema,输出新增/移除/类型变化清单——纯只读报告,
  // 全程无 DDL/写库通路;实体选择 = 命令参数 / 活动 .def / 注册实体选择
  // 器;建连与查询同过 IDE-REV-017 守卫。
  const schemaImpactChannel = vscode.window.createOutputChannel('KBEngine 结构影响预览');
  context.subscriptions.push(schemaImpactChannel);
  const previewSchemaImpactCommand = vscode.commands.registerCommand(
    'kbengine.database.previewSchemaImpact',
    async (entityName?: string) => {
      // KODE-CFG-009:runner 内同步取连接,先等 core 解析就绪(首取即得)
      await ensureCommandConfigResolved();
      return runDatabaseQueryCommand('KBEngine 结构影响预览', guard =>
        runSchemaImpactCommand({
          resolveEntityName: () => entityName ?? resolveActiveDefEntityName(),
          // IDE-AUD-011/012:实体全部表反查按当前连接的作用域根(scopeRootPath
          // =资产根)限定——只认该根内声明,无根/无命中如实 null,不跨
          // workspace 首命中;返回快照全部表(根表 + ARRAY/组件子表),子表
          // 变更进报告不被根表无变化掩盖
          resolveEntityTables: (name, scopeRootPath) => {
            if (!scopeRootPath) {
              return null;
            }
            const snapshot = getDatabaseSchemaSnapshot(name, scopeRootPath);
            return snapshot ? snapshot.tables : null;
          },
          resolveConnection: resolveCommandDatabaseConnection,
          createConnection: (profileId, config) => lifecycleGuardedFactory(guard, profileId)(config),
          listEntityNames: () =>
            (vscode.workspace.workspaceFolders ?? []).flatMap(folder =>
              getRegisteredEntities(folder.uri.fsPath).map(entity => entity.name)
            ),
          showQuickPick: (items, options) => vscode.window.showQuickPick(items, options),
          showInformationMessage: message => vscode.window.showInformationMessage(message),
          showWarningMessage: message => vscode.window.showWarningMessage(message),
          showErrorMessage: message => vscode.window.showErrorMessage(message),
          channel: schemaImpactChannel
        }));
    }
  );
  context.subscriptions.push(previewSchemaImpactCommand);

  // CLONE-P5 玩家数据克隆(导出/导入/归档浏览/审计):编排面在
  // playerDataCloneCommands(UI/连接/文件全注入,单测驱动纯编排),此处接
  // 真实 vscode 面。Profile 台账 = workspaceState + SecretStorage(密码不
  // 落配置);实体表推导 = databaseSchema 快照按工作区根逐个取首个命中;
  // 审计落盘 .kode/clone-runs(首工作区根)。Rust 桥($/kode/dbClone/*)
  // 无 TS 兜底,gate 缺席时命令层如实报「需要 Rust 后端」。deps 惰性组装
  // (首个克隆命令才建台账/通道)——测试替身的极简 context 不带
  // workspaceState/secrets,activate 期急切构造会炸装配。
  let playerCloneDeps: PlayerCloneCommandDeps | null = null;
  const getPlayerCloneDeps = (): PlayerCloneCommandDeps => {
    if (playerCloneDeps) {
      return playerCloneDeps;
    }
    const playerCloneChannel = vscode.window.createOutputChannel('KBEngine Player Clone');
    context.subscriptions.push(playerCloneChannel);
    const cloneRunsDir = (): vscode.Uri | null => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      return folder ? vscode.Uri.joinPath(folder.uri, '.kode', 'clone-runs') : null;
    };
    playerCloneDeps = {
    localize: message => l10nText(message),
    profiles: new CloneProfileStore({
      load: () => context.workspaceState.get('kode.playerClone.profiles'),
      save: data => {
        void context.workspaceState.update('kode.playerClone.profiles', data);
      },
      secrets: {
        get: async key => context.secrets.get(key),
        store: async (key, value) => context.secrets.store(key, value),
        delete: async key => context.secrets.delete(key)
      }
    }),
    listEntityNames: () =>
      (vscode.workspace.workspaceFolders ?? []).flatMap(folder =>
        getRegisteredEntities(folder.uri.fsPath).map(entity => entity.name)
      ),
    resolveEntityTables: entityName => {
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        const snapshot = getDatabaseSchemaSnapshot(entityName, folder.uri.fsPath);
        if (snapshot && snapshot.tables.length > 0) {
          return snapshot.tables;
        }
      }
      return null;
    },
    showQuickPick: async (items, options) => vscode.window.showQuickPick(items, options),
    showInputBox: async options => vscode.window.showInputBox(options),
    showInformationMessage: async message => vscode.window.showInformationMessage(message),
    showWarningMessage: async (message, ...items) => vscode.window.showWarningMessage(message, ...items),
    showErrorMessage: async message => vscode.window.showErrorMessage(message),
    withProgress: async (options, task) =>
      vscode.window.withProgress(
        { ...options, location: vscode.ProgressLocation.Notification },
        (_progress, token) => Promise.resolve(task(token))
      ),
    pickArchiveSavePath: async defaultName => {
      const picked = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(defaultName),
        filters: { 'KBEngine Player Data Clone': ['kdpclone'] }
      });
      return picked?.fsPath;
    },
    pickArchiveOpenPath: async () => {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: '选择归档(Select archive)',
        filters: { 'KBEngine Player Data Clone': ['kdpclone'] }
      });
      return picked?.[0]?.fsPath;
    },
    writeAuditFile: async (name, content) => {
      const dir = cloneRunsDir();
      if (!dir) {
        throw new Error('Player Clone 审计需要至少一个工作区文件夹(.kode/clone-runs)。');
      }
      await vscode.workspace.fs.createDirectory(dir);
      const file = vscode.Uri.joinPath(dir, name);
      await vscode.workspace.fs.writeFile(file, Buffer.from(content, 'utf8'));
      return file.fsPath;
    },
    listAuditFiles: async () => {
      const dir = cloneRunsDir();
      if (!dir) {
        return [];
      }
      try {
        const entries = await vscode.workspace.fs.readDirectory(dir);
        return entries
          .filter(([name, type]) => type === vscode.FileType.File && name.endsWith('.json'))
          .map(([name]) => name)
          .sort()
          .reverse();
      } catch {
        return [];
      }
    },
    readAuditFile: async name => {
      const dir = cloneRunsDir();
      if (!dir) {
        return null;
      }
      try {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, name));
        return Buffer.from(bytes).toString('utf8');
      } catch {
        return null;
      }
    },
    // 归档加密密钥根(globalStorage 下 clone-keys:机器域,不落工作区/VCS,
    // 归档移机时钥匙不跟走→读侧如实报密钥缺失)。目录由 Rust 侧按需创建;
    // 密钥材料全程留 Rust(FileKeyStore 0600),TS 只传目录路径。
    getKeyRoot: () => vscode.Uri.joinPath(context.globalStorageUri, 'clone-keys').fsPath,
    // 加密默认值读设置(PDC-0609):window 域,plain=跨机转移场景;导出确认页
    // 每次可切换,这里只给初始态。读面不受影响(加密位探测定)。
    getArchiveEncryptionDefault: () =>
      vscode.workspace.getConfiguration('kbengine.clone').get<string>('archiveEncryption') ===
      'plain'
        ? 'plain'
        : 'encrypted',
    channel: playerCloneChannel,
    now: () => Date.now()
    };
    return playerCloneDeps;
  };
  const cloneCommandEntries: Array<[string, (uri?: vscode.Uri) => Promise<void>]> = [
    ['kbengine.clone.configureSource', () => runConfigureCloneProfileCommand(getPlayerCloneDeps(), 'source')],
    ['kbengine.clone.configureTarget', () => runConfigureCloneProfileCommand(getPlayerCloneDeps(), 'target')],
    ['kbengine.clone.testSource', () => runTestCloneConnectionCommand(getPlayerCloneDeps(), 'source')],
    ['kbengine.clone.testTarget', () => runTestCloneConnectionCommand(getPlayerCloneDeps(), 'target')],
    [
      'kbengine.clone.inspectArchive',
      uri => runInspectCloneArchiveCommand(getPlayerCloneDeps(), uri?.fsPath)
    ],
    ['kbengine.clone.export', () => runExportCloneCommand(getPlayerCloneDeps())],
    ['kbengine.clone.import', uri => runImportCloneCommand(getPlayerCloneDeps(), uri?.fsPath)],
    ['kbengine.clone.showAudit', () => runShowCloneAuditCommand(getPlayerCloneDeps())]
  ];
  for (const [id, run] of cloneCommandEntries) {
    context.subscriptions.push(vscode.commands.registerCommand(id, run));
  }
}
