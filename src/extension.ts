import { findFilesAcrossRoots, getExternalScanRoots, resetScanRootCache, resolveAssetsRootForWorkspace } from './scanRoots';
import { setJumpLogEnabled } from './navigationLog';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { KBEngineServerManager, SERVER_COMPONENTS } from './serverManager';
import { KBEngineLogCollector, LogCollectorConfig } from './logCollector';
import { LogViewerWebView } from './logWebView';
import {
  LogErrorScanView,
  realLogErrorScanDeps,
  runLogErrorScanCommand,
  scanRawLogErrors
} from './logErrorScan';
import { DebugConfigManager } from './debugConfig';
import { MonitoringWebView } from './monitoringWebView';
import { MonitoringCollector } from './monitoringCollector';
import {
  DefinitionSymbolIdentity,
  EntityMappingManager,
  EntityMethodSection
} from './entityMapping';
import { EntityDependencyWebView } from './entityDependencyWebView';
import { EntityFlowWebView } from './entityFlowWebView';
import { KBEngineCodeGenerator } from './codeGenerator';
import { runGeneratorFormWizard } from './generatorForms';
import { runClientSdkGenerateCommand } from './clientSdkGenerator';
import {
  EntityExplorerProvider,
  pickServerComponent,
  ServerControlProvider
} from './explorerProviders';
import { resolveServerComponent } from './serverCommandTarget';
import { parseHttpRequestEntries } from './httpRequests';
import { HttpRequestService } from './httpRequestService';
import { QuickActionManager } from './quickActions';
import { QuickActionTreeProvider } from './quickActionTree';
import { setupHotReload } from './hotReload';
import { fileSystemScriptRootDeps, syncPythonExtraPaths } from './pythonExtraPaths';
import { exportKbeStubs, fileSystemStubExportDeps } from './pythonStubExport';
import { exportPythonTypeStubs, setupTypeStubRegeneration } from './pythonTypeStubs';
import {
  DEBUG_CONFIG_CHANNEL_NAME,
  ensureDebugConfig,
  fileSystemBootstrapDeps
} from './debugConfigBootstrap';
import {
  readTelnetTargetsFromSettings,
  TelnetService,
  updateTelnetStatusBar
} from './telnetService';
import { TelnetWebView } from './telnetWebView';
import {
  KBEngineCallHierarchyProvider,
  KBEngineCompletionProvider,
  EventCodeLensProvider,
  KBEngineDefinitionProvider,
  KBEngineHoverProvider,
  KBEngineRenameProvider,
  PythonCompletionProvider,
  PythonDefinitionProvider,
  PropertyCodeLensProvider,
  RpcCodeLensProvider,
  TypesXmlCodeLensProvider,
  isPythonMroJumpEnabled,
  setPythonMroJumpEnabled,
  validateDocument,
  validateEntitiesXmlDocument
} from './languageProviders';
import { PythonTypeInlayHintsProvider } from './typeInlayHints';
import { PythonClassIndex } from './pythonClassIndex';
import {
  createDatabaseSchemaUri,
  getDatabaseSchemaSnapshot,
  KBEngineDatabaseSchemaProvider,
  locateDatabaseSchemaLine,
  resolveEntityTableName,
  resolveSchemaTablePrefix
} from './databaseSchema';
import {
  checkDatabaseDrift,
  checkDatabaseDriftForSnapshots,
  createMysqlDriftExecutor,
  DATABASE_DRIFT_CHANNEL_NAME,
  publishDriftReport
} from './databaseDrift';
import {
  createDatabaseSimulationUri,
  getSimulationEntityName,
  isDatabaseSimulationDocument,
  KBENGINE_DATABASE_SIMULATION_SCHEME,
  KBEngineDatabaseSimulationProvider
} from './databaseSimulator';
import { findEntityDefinitionFile, getDefinitionWorkspaceLayout, getRegisteredEntities } from './definitionWorkspace';
import { analyzeDefDocument, collectInheritedNames, formatDefAnalysisReport } from './defAnalyzer';
import { joinWorkspacePath } from './workspacePath';
import {
  CUSTOM_SNIPPETS_RELATIVE_PATH,
  mergeSnippetEntry,
  selectionToSnippetBody
} from './snippetGenerator';
import type { MergeSnippetResult } from './snippetGenerator';
import { KBE_SCHEME, buildKbeStubDocument } from './kbeModuleIndex';
import {
  SERVER_CONFIG_SELECTOR,
  ServerConfigHoverProvider
} from './serverConfigHover';
import {
  KBE_CONFIG_SCHEME,
  KBE_CONFIG_VIRTUAL_PATH,
  FinalConfigContentProvider,
  FinalConfigTreeProvider,
  buildFinalServerConfig,
  resetDatabaseInterfaceConfigCache,
  resolveDatabaseInterfaceConfig
} from './serverConfigMerge';
import type { DiscoveryKey, DiscoveryLayoutFacts, DiscoveryPromptDeps } from './workspaceDiscovery';
import {
  buildDiscoveryReport,
  renderDiscoveryReport,
  runWorkspaceDiscovery
} from './workspaceDiscovery';
import { TelnetTreeProvider } from './telnetTree';

/**
 * Kode - KBEngine Development Environment
 * KBEngine VSCode 扩展主入口
 */

export function activate(context: vscode.ExtensionContext) {
  console.log('KBEngine Language Extension is now active!');
  // 跳转决策路径日志开关(默认关闭;Settings 搜 kbengine.jumpLog 随时切换)
  setJumpLogEnabled(vscode.workspace.getConfiguration('kbengine').get<boolean>('jumpLog', false));
  // 层2 python-mro(mixin 函数导航)开关(默认开;Settings 搜 kbengine.python.enableMroJump 随时切换)
  setPythonMroJumpEnabled(vscode.workspace.getConfiguration('kbengine.python').get<boolean>('enableMroJump', true));
  const databaseSchemaProvider = new KBEngineDatabaseSchemaProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('kbengine-db-schema', databaseSchemaProvider)
  );
  // 数据库模拟(批122):schema 快照之上的行模拟虚拟文档,scheme 与
  // databaseSchema 的 kbengine-db-schema 并列
  const databaseSimulationProvider = new KBEngineDatabaseSimulationProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      KBENGINE_DATABASE_SIMULATION_SCHEME,
      databaseSimulationProvider
    )
  );
  // kbe 模块符号桩文档(批108):go-to-definition 的只读跳转源
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(KBE_SCHEME, {
      provideTextDocumentContent(): string {
        return buildKbeStubDocument().content;
      }
    })
  );
  const defDocumentSelector: vscode.DocumentSelector = [
    { language: 'kbengine-def', scheme: 'file' },
    { scheme: 'file', pattern: '**/*.def' },
    { language: 'kbengine-def', scheme: 'untitled' }
  ];
  const kbengineXmlSelector: vscode.DocumentSelector = [
    { language: 'xml', scheme: 'file', pattern: '**/types.xml' },
    { language: 'xml', scheme: 'file', pattern: '**/entities.xml' }
  ];
  const definitionNavigationSelector: vscode.DocumentSelector = [
    ...defDocumentSelector,
    ...kbengineXmlSelector
  ];
  const pythonDocumentSelector: vscode.DocumentSelector = [
    { language: 'python', scheme: 'file' }
  ];

  const isDefDocument = (document: vscode.TextDocument): boolean =>
    document.languageId === 'kbengine-def' || document.fileName.toLowerCase().endsWith('.def');
  // entities.xml 清单诊断(source-analysis 设计 D3):与 .def 共用同一
  // 诊断 collection 与文档事件生命周期
  const isEntitiesXmlDocument = (document: vscode.TextDocument): boolean =>
    document.fileName.endsWith('entities.xml');

  // 注册智能提示提供者（.def 结构补全 + Python 热更 API 补全）
  const completionProvider = vscode.languages.registerCompletionItemProvider(
    [
      ...defDocumentSelector,
      ...pythonDocumentSelector
    ],
    new KBEngineCompletionProvider(),
    '<', ' ', '\t', '>', '/', ':', '.'
  );
  context.subscriptions.push(completionProvider);

  // 注册悬停文档提供者（.def/xml 与 Python 实体脚本均可查看 hook 文档）
  const hoverProvider = vscode.languages.registerHoverProvider(
    [
      ...definitionNavigationSelector,
      ...pythonDocumentSelector
    ],
    new KBEngineHoverProvider()
  );
  context.subscriptions.push(hoverProvider);

  // 元件 kbengine.xml / 引擎 kbengine_defaults.xml 字段悬浮文档(批112 用户令:
  // 悬停配置字段显示引擎源码注释整理的作用说明)
  const serverConfigHoverProvider = vscode.languages.registerHoverProvider(
    SERVER_CONFIG_SELECTOR,
    new ServerConfigHoverProvider()
  );
  context.subscriptions.push(serverConfigHoverProvider);

  // 初始化实体映射管理器
  const entityMappingManager = new EntityMappingManager(context);

  // 注册定义跳转提供者（.def 文件）
  const definitionProvider = vscode.languages.registerDefinitionProvider(
    definitionNavigationSelector,
    new KBEngineDefinitionProvider(entityMappingManager)
  );
  context.subscriptions.push(definitionProvider);

  // Python 方法使用优先跳实现；属性、声明与实现缺失时保留 .def 导航。
  const pythonClassIndex = new PythonClassIndex();
  const pythonDefinitionProvider = vscode.languages.registerDefinitionProvider(
    { language: 'python', scheme: 'file' },
    new PythonDefinitionProvider(entityMappingManager, pythonClassIndex)
  );
  context.subscriptions.push(pythonDefinitionProvider);
  let pythonIndexWatchers: vscode.Disposable[] = [];
  const watchPythonIndex = () => {
    pythonIndexWatchers.forEach(watcher => watcher.dispose());
    pythonIndexWatchers = [];
    const patterns: vscode.GlobPattern[] = [
      '**/*.{py,def,xml}',
      ...getExternalScanRoots().map(root => new vscode.RelativePattern(root, '**/*.{py,def,xml}'))
    ];
    for (const pattern of patterns) {
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      const invalidate = (uri: vscode.Uri) => pythonClassIndex.invalidate(uri.fsPath);
      pythonIndexWatchers.push(watcher, watcher.onDidCreate(invalidate),
        watcher.onDidChange(uri => { void pythonClassIndex.onFileChanged(uri.fsPath); }), watcher.onDidDelete(invalidate));
    }
  };
  watchPythonIndex();
  context.subscriptions.push(
    { dispose: () => pythonIndexWatchers.forEach(watcher => watcher.dispose()) },
    vscode.workspace.onDidCloseTextDocument(document => pythonClassIndex.onDocumentClosed(document)),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      resetScanRootCache();
      pythonClassIndex.invalidate();
      watchPythonIndex();
    })
  );

  // RPC 方法标记(批126 用户令:Python 侧函数看不出哪些是 def 声明的
  // RPC):在实现脚本里命中 def 方法声明的声明行上方出一行可点 CodeLens
  // (区块/Exposed/来源 def,点击回声明),普通函数不出;批154 起配独立
  // 开关 kbengine.codeLens.rpc,实例留在具名变量供配置监听 fire
  const rpcCodeLensProviderImpl = new RpcCodeLensProvider(entityMappingManager);
  const rpcCodeLensProvider = vscode.languages.registerCodeLensProvider(
    pythonDocumentSelector,
    rpcCodeLensProviderImpl
  );
  context.subscriptions.push(rpcCodeLensProvider);

  // 属性访问标记(批135 用户令:types.xml 能跳到代码,代码侧没有等价的反向
  // 标记):self.<属性> 访问处出一行 CodeLens,标 def 声明的类型与可见域,
  // 点击回 def 声明行;只认 self.<属性> 形态,与属性 F12 同口径;批154 起
  // 配独立开关 kbengine.codeLens.property
  const propertyCodeLensProviderImpl = new PropertyCodeLensProvider(entityMappingManager);
  const propertyCodeLensProvider = vscode.languages.registerCodeLensProvider(
    pythonDocumentSelector,
    propertyCodeLensProviderImpl
  );
  context.subscriptions.push(propertyCodeLensProvider);

  // 事件回调标记(批154 从 RPC 镜链返回值里拆出独立注册):addEvent/
  // registerEvent 的回调 def 声明处标「事件回调 · EV_X」、emitEvent 处标
  // 监听数,独立开关 kbengine.codeLens.eventCallbacks,与 RPC 互不影响
  const eventCodeLensProviderImpl = new EventCodeLensProvider();
  const eventCodeLensProvider = vscode.languages.registerCodeLensProvider(
    pythonDocumentSelector,
    eventCodeLensProviderImpl
  );
  context.subscriptions.push(eventCodeLensProvider);

  // types.xml 类型声明行的引用反扫镜(批134 用户拍板「形态 + 引用反扫
  // CodeLens」):声明行上方列真实使用(实体.属性 → 落库表.列),点击开
  // schema 文档定位到列;def/types.xml/entities.xml 改动由 provider 内
  // watcher 失效重扫;批154 起配独立开关 kbengine.codeLens.typesXml
  const typesXmlCodeLensProviderImpl = new TypesXmlCodeLensProvider();
  const typesXmlCodeLensProvider = vscode.languages.registerCodeLensProvider(
    [{ language: 'xml', scheme: 'file', pattern: '**/types.xml' }],
    typesXmlCodeLensProviderImpl
  );
  context.subscriptions.push(typesXmlCodeLensProvider);

  // types.xml 数据类型 inlay hints(批154 用户令 todo:7):python 侧
  // self.<属性> 访问处原位渲染 def 声明的 <Type> 取值,与属性 F12 同索引;
  // 一枚独立开关 kbengine.inlayHints.typeData(默认开),inlay 无变更事件,
  // provider 现读配置下一次渲染即生效,不需要配置监听 fire
  const typeInlayHintsProvider = vscode.languages.registerInlayHintsProvider(
    pythonDocumentSelector,
    new PythonTypeInlayHintsProvider(entityMappingManager)
  );
  context.subscriptions.push(typeInlayHintsProvider);

  const callHierarchyProvider = vscode.languages.registerCallHierarchyProvider(
    [
      ...definitionNavigationSelector,
      { language: 'python', scheme: 'file' }
    ],
    new KBEngineCallHierarchyProvider(entityMappingManager)
  );
  context.subscriptions.push(callHierarchyProvider);

  // 注册重命名提供者(.def 属性/方法 F2 重命名,引用面见 defRenamer 头注)
  const renameProvider = vscode.languages.registerRenameProvider(
    defDocumentSelector,
    new KBEngineRenameProvider()
  );
  context.subscriptions.push(renameProvider);

  // 注册 Python 文件的智能提示提供者（提供来自 .def 的属性和方法）
  const pythonCompletionProvider = vscode.languages.registerCompletionItemProvider(
    { language: 'python', scheme: 'file' },
    new PythonCompletionProvider(entityMappingManager),
    '.' // 输入 . 时触发
  );
  context.subscriptions.push(pythonCompletionProvider);

  // 注册诊断检查器
  const diagnostics = vscode.languages.createDiagnosticCollection('kbengine');
  context.subscriptions.push(diagnostics);

  // 监听文档变化，实时检查
  if (vscode.workspace.workspaceFolders) {
    const watcher = vscode.workspace.onDidChangeTextDocument(event => {
      if (isDefDocument(event.document)) {
        validateDocument(event.document, diagnostics);
      } else if (isEntitiesXmlDocument(event.document)) {
        validateEntitiesXmlDocument(event.document, diagnostics);
      }
      // Python 类索引增量失效:只重解析该文件,避免大仓全量扫描卡输入;
      // 层2 关闭时索引不参与跳转,变更喂给索引纯属后台空转,一并跳过
      if (isPythonMroJumpEnabled()) {
        void pythonClassIndex.onDocumentChanged(event.document);
      }
    });
    context.subscriptions.push(watcher);

    // 初始检查所有 .def 文件
    const openWatcher = vscode.workspace.onDidOpenTextDocument(document => {
      if (isDefDocument(document)) {
        validateDocument(document, diagnostics);
      } else if (isEntitiesXmlDocument(document)) {
        validateEntitiesXmlDocument(document, diagnostics);
      }
    });
    context.subscriptions.push(openWatcher);

    vscode.workspace.textDocuments.forEach(document => {
      if (isDefDocument(document)) {
        validateDocument(document, diagnostics);
      } else if (isEntitiesXmlDocument(document)) {
        validateEntitiesXmlDocument(document, diagnostics);
      }
    });
  }

  const configWatcher = vscode.workspace.onDidChangeConfiguration(event => {
    if (!event.affectsConfiguration('kbengine')) {
      return;
    }

    // 跳转日志开关变更即时生效(不重载窗口)
    if (event.affectsConfiguration('kbengine.jumpLog')) {
      setJumpLogEnabled(vscode.workspace.getConfiguration('kbengine').get<boolean>('jumpLog', false));
    }

    // 层2 python-mro(mixin 函数导航)开关变更即时生效(不重载窗口)
    if (event.affectsConfiguration('kbengine.python.enableMroJump')) {
      setPythonMroJumpEnabled(vscode.workspace.getConfiguration('kbengine.python').get<boolean>('enableMroJump', true));
    }

    // CodeLens 各功能开关变更即时生效(批154):四类镜链 provider 每次
    // 调用现读配置,这里只需各自 fire 让 VS Code 重取;hover 面(含
    // serverConfig)同样现读,不需要 fire
    if (event.affectsConfiguration('kbengine.codeLens')) {
      rpcCodeLensProviderImpl.fireConfigurationChanged();
      eventCodeLensProviderImpl.fireConfigurationChanged();
      propertyCodeLensProviderImpl.fireConfigurationChanged();
      typesXmlCodeLensProviderImpl.fireConfigurationChanged();
    }

    if (event.affectsConfiguration('kbengine.assetsRoot') ||
        event.affectsConfiguration('kbengine.python.enableMroJump')) {
      resetScanRootCache();
      pythonClassIndex.invalidate();
      watchPythonIndex();
    }

    // binPath/configPath 变更影响数据库连接读值(批131),重算后再扫文档
    resetDatabaseInterfaceConfigCache();
    vscode.workspace.textDocuments.forEach(doc => {
      if (isDefDocument(doc)) {
        validateDocument(doc, diagnostics);
      } else if (isEntitiesXmlDocument(doc)) {
        validateEntitiesXmlDocument(doc, diagnostics);
      }
    });
  });
  context.subscriptions.push(configWatcher);

  // 注册侧边栏视图
  const entityExplorerProvider = new EntityExplorerProvider();
  const entityExplorerRegistration = vscode.window.registerTreeDataProvider(
    'kbengine.entityExplorer',
    entityExplorerProvider
  );
  context.subscriptions.push(entityExplorerRegistration);

  // 刷新实体浏览器的命令
  const refreshCommand = vscode.commands.registerCommand(
    'kbengine.refreshExplorer',
    () => entityExplorerProvider.refresh()
  );
  context.subscriptions.push(refreshCommand);

  const openEntityCommand = vscode.commands.registerCommand(
    'kbengine.entity.open',
    async (entityName: string) => {
      if (!entityName) {
        return;
      }

      const definitionPath = findEntityDefinitionFile(entityName);
      if (!definitionPath) {
        vscode.window.showWarningMessage(
          `打开实体定义失败: ${entityName}.def (未找到定义文件)`
        );
        return;
      }

      try {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(definitionPath));
        await vscode.window.showTextDocument(document);
      } catch (error) {
        vscode.window.showWarningMessage(
          `打开实体定义失败: ${entityName}.def (${error})`
        );
      }
    }
  );
  context.subscriptions.push(openEntityCommand);

  const openEntityMethodCommand = vscode.commands.registerCommand(
    'kbengine.entity.method.open',
    async (
      identityOrEntityName: DefinitionSymbolIdentity | string,
      methodName?: string,
      section?: EntityMethodSection
    ) => {
      // 空目标早退必须先于 label 拼接:原实现先读 identityOrEntityName.ownerName,
      // 无参调用(命令面板)会在守卫前抛 TypeError——装配测试锁定的真实缺陷
      if (!identityOrEntityName) {
        return;
      }

      const label = typeof identityOrEntityName === 'string'
        ? `${identityOrEntityName}.${methodName || ''} (${section || ''})`
        : `${identityOrEntityName.ownerName}.${identityOrEntityName.symbolName} (${identityOrEntityName.section || ''})`;

      try {
        const didOpen = typeof identityOrEntityName === 'string'
          ? await entityMappingManager.openMethodTarget(identityOrEntityName, methodName, section)
          : await entityMappingManager.openMethodTarget(identityOrEntityName);
        // 不可达(批71 定性):该 if 的隐式 else 臂(v8-to-istanbul 记为 arm#1
        // armLoc=undefined)为负数伪影。真实行为由既有用例锁定:
        // - "method.open 成功侧静默"(extension.test.ts)与
        // - extensionBranches.test.ts 两文件 4 个用例分别以字符串/identity
        // 形态调用并断言无 warning,即 didOpen=true 走隐式 else。
        // v8 对无显式 else 块的 if 语句,隐式 else 计数器不随执行增量
        // (见 TESTING.md 批71 段),属工具链已知缺陷,不反映真实可达性。
        /* istanbul ignore start */
        if (!didOpen) {
        /* istanbul ignore stop */
          vscode.window.showWarningMessage(
            `打开实体方法失败: ${label}`
          );
        }
      } catch (error) {
        vscode.window.showWarningMessage(
          `打开实体方法失败: ${label} (${error})`
        );
      }
    }
  );
  context.subscriptions.push(openEntityMethodCommand);

  const openDatabaseSchemaCommand = vscode.commands.registerCommand(
    'kbengine.database.open',
    async (entityName?: string, tableName?: string, fieldName?: string) => {
      // 命令面板无参直开时取活动 .def 推断实体,与 simulate 同口径;仍无实体
      // 如实提示——此前命令体直接 return,面板点了毫无反应,数据库表结构入口
      // 找不到(Entities 视图的数据库条目是唯一可达路径)
      const resolvedEntityName = entityName ?? resolveActiveDefEntityName();
      if (!resolvedEntityName) {
        vscode.window.showInformationMessage('请先打开一个实体 .def 文件');
        return;
      }

      try {
        const uri = createDatabaseSchemaUri(resolvedEntityName);
        const document = await vscode.workspace.openTextDocument(uri);
        const snapshot = getDatabaseSchemaSnapshot(resolvedEntityName);
        const line = snapshot
          ? locateDatabaseSchemaLine(snapshot, tableName || resolveEntityTableName(resolvedEntityName, snapshot), fieldName)
          : 1;
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
  const databaseDriftChannel = vscode.window.createOutputChannel(DATABASE_DRIFT_CHANNEL_NAME);
  context.subscriptions.push(databaseDriftChannel);
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
      const database = resolveDatabaseInterfaceConfig();
      if (!database) {
        vscode.window.showInformationMessage(
          '数据库漂移未校验:读不到引擎数据库配置(检查 kbengine.binPath / assetsRoot)'
        );
        return;
      }
      const report = await checkDatabaseDrift(
        snapshot,
        database,
        resolveSchemaTablePrefix(),
        createMysqlDriftExecutor
      );
      publishDriftReport(databaseDriftChannel, vscode.window, report);
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
      const database = resolveDatabaseInterfaceConfig();
      if (!database) {
        vscode.window.showInformationMessage(
          '数据库漂移未校验:读不到引擎数据库配置(检查 kbengine.binPath / assetsRoot)'
        );
        return;
      }
      const report = await checkDatabaseDriftForSnapshots(
        snapshots, database, resolveSchemaTablePrefix(), createMysqlDriftExecutor
      );
      publishDriftReport(databaseDriftChannel, vscode.window, report);
    }
  );
  context.subscriptions.push(checkAllDatabaseDriftCommand);

  // 初始化服务器管理器
  const serverManager = new KBEngineServerManager(context);

  // telnet 探测与联动(工单:telnet 探测+联动):目标解析 设置 →
  // kbengine.xml <telnet_service>(未指定路径时按 configPath/约定路径探测)
  // → 引擎 kbengine_defaults.xml(批112 用户令);配置未开 telnet → 空目标;
  // 5s 低频探测
  const telnetService = new TelnetService({
    getTargets: () => {
      const targets = readTelnetTargetsFromSettings();
      // 批111 用户令:配置未开 telnet 不展示 telnet 相关的东西——状态灯、
      // 独立树视图与命令面板入口随空目标/context key 自然隐藏。探测每轮
      // 重读目标,context 同步刷新。
      void vscode.commands.executeCommand(
        'setContext',
        'kbengine.telnetConfigured',
        targets.length > 0
      );
      return targets;
    },
    intervalMs: Math.max(1, vscode.workspace.getConfiguration('kbengine').get<number>('telnet.probeIntervalSeconds', 5)) * 1000
  });
  telnetService.start();

  // Servers 进程树(批112 用户令:telnet 不与 server 进程混置,已移出本树)
  const serverControlProvider = new ServerControlProvider(serverManager);
  const serverControlRegistration = vscode.window.registerTreeDataProvider(
    'kbengine.serverControl',
    serverControlProvider
  );
  context.subscriptions.push(serverControlRegistration);

  // telnet 独立树视图(批112 用户令:单独分类,与 server 进程分开)
  const telnetTreeProvider = new TelnetTreeProvider(telnetService);
  const telnetTreeRegistration = vscode.window.registerTreeDataProvider(
    'kbengine.telnetStatus',
    telnetTreeProvider
  );
  context.subscriptions.push(telnetTreeRegistration);

  // 服务器状态变化时刷新视图
  const serverStatusSubscription = serverManager.onDidChangeStatus(() => {
    serverControlProvider.refresh();
    updateStatusBar(serverManager);
  });
  context.subscriptions.push(serverStatusSubscription);

  // telnet 面板与状态灯
  const telnetWebView = new TelnetWebView(context, telnetService);
  const telnetStatusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    99
  );
  const showTelnetPanelCommand = vscode.commands.registerCommand('kbengine.telnet.showPanel', () => {
    telnetWebView.show();
  });
  // 断开当前 telnet 会话:面板 Ctrl+]/Ctrl+D 与顶部入口(telnet 树标题栏
  // 按钮/命令面板)共用此命令
  const disconnectTelnetCommand = vscode.commands.registerCommand('kbengine.telnet.disconnect', () => {
    telnetWebView.disconnectActive();
  });
  context.subscriptions.push(showTelnetPanelCommand, disconnectTelnetCommand, telnetStatusBarItem);
  const telnetStateSubscription = telnetService.onDidChange(() => {
    telnetTreeProvider.refresh();
    updateTelnetStatusBar(telnetService, telnetStatusBarItem);
  });
  context.subscriptions.push(telnetStateSubscription);
  updateTelnetStatusBar(telnetService, telnetStatusBarItem);

  // HTTP 快捷请求(批105):OUTPUT 流水 + 列表 quick pick + 具名运行
  // (实际快捷键经「键盘快捷方式」为本命令配 args.name 绑定)
  const quickActionManagerRef: { current?: QuickActionManager } = {};
  const httpRequestChannel = vscode.window.createOutputChannel('KBEngine HTTP 快捷请求');
  const httpRequestService = new HttpRequestService({
    getEntries: () =>
      parseHttpRequestEntries(vscode.workspace.getConfiguration('kbengine').get('httpRequests')),
    log: line => httpRequestChannel.appendLine(line),
    notifyError: message => {
      void vscode.window.showErrorMessage(message);
    },
    getTemplateContext: () => {
      const editor = vscode.window.activeTextEditor;
      return {
        filePath: editor?.document.uri.fsPath,
        cursorLineZeroBased: editor?.selection.active.line,
        selection: editor ? editor.document.getText(editor.selection) : undefined,
        workspaceRoots: (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath)
      };
    },
    // ${module} 包边界探针:目录含 __init__.py 才算包段(base/cell 等
    // 角色目录无 __init__.py 即不算模块,批153 用户令)
    isPackageDir: dirPath => fs.existsSync(path.join(dirPath, '__init__.py'))
  });
  const runHttpQuickPickCommand = vscode.commands.registerCommand(
    'kbengine.httpRequests.run',
    async () => {
      const combined = quickActionManagerRef.current
        ? (await quickActionManagerRef.current.getTreeData()).httpRequests
        : [];
      const entries = combined;
      const configuredEntries = parseHttpRequestEntries(vscode.workspace.getConfiguration('kbengine').get('httpRequests'));
      if (entries.length === 0) {
        void vscode.window.showInformationMessage(
          '没有已启用的 HTTP 快捷请求(可配置于 .kbengine/debug.json 或设置 kbengine.httpRequests)'
        );
        return;
      }
      const picked = await vscode.window.showQuickPick(
        entries.map(entry => ({
          label: entry.name,
          description: `${entry.method} ${entry.target}`,
          detail: `${entry.requestSource === 'settings' ? '来源：kbengine.httpRequests 设置' : '来源：.kbengine/debug.json'}${entry.requestSource === 'settings' && configuredEntries[entry.requestIndex]?.keybinding ? ` · 键位: ${configuredEntries[entry.requestIndex].keybinding}` : ''}`,
          entry
        })),
        { placeHolder: '选择要运行的 HTTP 快捷请求' }
      );
      if (picked) {
        await quickActionManagerRef.current?.runByName(`@http:${picked.entry.requestSource}:${picked.entry.requestIndex}`);
      }
    }
  );
  const runNamedHttpCommand = vscode.commands.registerCommand(
    'kbengine.httpRequest.run',
    async (args?: { name?: string }) => {
      const name = args?.name;
      if (!name) {
        void vscode.window.showWarningMessage(
          'kbengine.httpRequest.run 需要 args.name(在键盘快捷方式里以 args 传入);或改用 kbengine.httpRequests.run 从合并列表选择'
        );
        return;
      }
      const manager = quickActionManagerRef.current;
      if (manager) {
        const entry = (await manager.getTreeData()).httpRequests.find(item => item.name === name);
        if (entry) await manager.runByName(`@http:${entry.requestSource}:${entry.requestIndex}`);
        else await httpRequestService.runByName(name);
      }
    }
  );
  context.subscriptions.push(httpRequestChannel, runHttpQuickPickCommand, runNamedHttpCommand);

  // 注册服务器控制命令
  const startServerCommand = vscode.commands.registerCommand(
    'kbengine.server.start',
    (target) => {
      const component = resolveServerComponent(target);
      // 2026-10-10 fix(CI 38027480815):必须返回 Promise,否则 executeCommand 立刻
      // 返回、在途启动的报错渗进后续测试(beforeEach 已清,旧 async 仍会吐错)。
      return component
        ? serverManager.startComponent(component)
        : serverManager.startAutoComponents();
    }
  );
  context.subscriptions.push(startServerCommand);

  const stopServerCommand = vscode.commands.registerCommand(
    'kbengine.server.stop',
    (target) => {
      const component = resolveServerComponent(target);
      return component
        ? serverManager.stopComponent(component.name)
        : serverManager.stopAll();
    }
  );
  context.subscriptions.push(stopServerCommand);

  const restartServerCommand = vscode.commands.registerCommand(
    'kbengine.server.restart',
    (target) => {
      const component = resolveServerComponent(target);
      if (!component) {
        return undefined;
      }

      return serverManager.restartComponent(component.name);
    }
  );
  context.subscriptions.push(restartServerCommand);

  const showLogsCommand = vscode.commands.registerCommand(
    'kbengine.server.showLogs',
    (target) => {
      const component = resolveServerComponent(target);
      if (!component) {
        return;
      }

      serverManager.showComponentLogs(component.name);
      logViewer.show();
    }
  );
  context.subscriptions.push(showLogsCommand);

  // 初始化日志收集器
  const kbengineConfig = vscode.workspace.getConfiguration('kbengine');
  const logAutoConnect = kbengineConfig.get<boolean>('logAutoConnect', true);
  const logConfig: LogCollectorConfig = {
    host: '127.0.0.1',
    port: kbengineConfig.get<number>('loggerPort', 20022),
    autoReconnect: true,
    reconnectInterval: 5000,
    maxBufferSize: kbengineConfig.get<number>('maxLogEntries', 10000)
  };

  const logCollector = new KBEngineLogCollector(logConfig, context);

  if (logAutoConnect) {
    void logCollector.connect().catch(() => {
      // logger 可能尚未启动，collector 内部会继续按配置重连
    });
  }

  // 初始化日志查看器
  const logViewer = new LogViewerWebView(context, logCollector);

  // 注册日志相关命令
  const showLogViewerCommand = vscode.commands.registerCommand(
    'kbengine.logs.showViewer',
    () => logViewer.show()
  );
  context.subscriptions.push(showLogViewerCommand);

  const connectLoggerCommand = vscode.commands.registerCommand(
    'kbengine.logs.connect',
    async () => {
      vscode.window.showWarningMessage(
        KBEngineLogCollector.PROTOCOL_WARNING
      );
      try {
        await logCollector.connect();
      } catch (error) {
        vscode.window.showErrorMessage(`连接日志收集器失败: ${error}`);
      }
    }
  );
  context.subscriptions.push(connectLoggerCommand);

  const disconnectLoggerCommand = vscode.commands.registerCommand(
    'kbengine.logs.disconnect',
    () => logCollector.disconnect()
  );
  context.subscriptions.push(disconnectLoggerCommand);

  const clearLogsCommand = vscode.commands.registerCommand(
    'kbengine.logs.clear',
    () => logViewer.clearLogs()
  );
  context.subscriptions.push(clearLogsCommand);

  const exportLogsCommand = vscode.commands.registerCommand(
    'kbengine.logs.export',
    () => logViewer.exportLogs()
  );
  context.subscriptions.push(exportLogsCommand);

  // 原始日志 ERROR 扫描(盘点 G6):离线聚合日志文件里的 ERROR/CRITICAL 行;
  // 重扫按上一批文件重跑,不再弹对话框
  const logErrorScanView = new LogErrorScanView(context, previous =>
    scanRawLogErrors(
      previous.files.map(file => file.uri),
      realLogErrorScanDeps
    )
  );
  const scanRawLogErrorsCommand = vscode.commands.registerCommand(
    'kbengine.logs.scanErrors',
    () => runLogErrorScanCommand(logErrorScanView)
  );
  context.subscriptions.push(scanRawLogErrorsCommand);

  // 初始化调试配置管理器
  const debugConfigManager = new DebugConfigManager(context);

  // 注册调试相关命令
  const updateLaunchJsonCommand = vscode.commands.registerCommand(
    'kbengine.debug.updateLaunchJson',
    async () => {
      await debugConfigManager.updateLaunchJson();
    }
  );
  context.subscriptions.push(updateLaunchJsonCommand);

  // 最终服务端配置合成(批112 用户令:defaults 先载、元件 kbengine.xml 覆盖)。
  // 默认开启令:激活即出(后台预览不抢焦点)、侧栏常驻节点、文件保存联动刷新,
  // 命令入口保留不删。
  const finalConfigProvider = new FinalConfigContentProvider();
  const finalConfigContentProvider = vscode.workspace.registerTextDocumentContentProvider(
    KBE_CONFIG_SCHEME,
    finalConfigProvider
  );
  context.subscriptions.push(finalConfigContentProvider);

  // 打开合成视图。auto = 激活自动路径:定位失败静默跳过不弹错、后台标签;
  // 手动命令 = 明示报错、正常聚焦打开。
  const openFinalConfig = async (auto: boolean): Promise<void> => {
    if (buildFinalServerConfig().text.length === 0) {
      if (!auto) {
        vscode.window.showErrorMessage(
          '无法定位引擎默认配置 kbengine_defaults.xml(请检查 kbengine.binPath 是否指向引擎的 kbe/bin/server)'
        );
      }
      return;
    }
    const uri = vscode.Uri.parse(`${KBE_CONFIG_SCHEME}:${KBE_CONFIG_VIRTUAL_PATH}`);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(
      document,
      auto ? { preview: true, preserveFocus: true } : undefined
    );
  };

  // types.xml 落盘后自动重生成类型桩(§4 二期):静默、零写纪律兜底,
  // stubExport 关掉时导出函数自门,watcher 实际停摆。挂在终配 watcher
  // 之前:activate 期 watcher 创建次序是既有探针测试的隐含契约
  setupTypeStubRegeneration(context);

  const showFinalConfigCommand = vscode.commands.registerCommand(
    'kbengine.config.showFinal',
    () => openFinalConfig(false)
  );
  context.subscriptions.push(showFinalConfigCommand);

  // 侧栏常驻入口:始终可见可回,不随配置门控
  const finalConfigTreeRegistration = vscode.window.registerTreeDataProvider(
    'kbengine.config',
    new FinalConfigTreeProvider()
  );
  context.subscriptions.push(finalConfigTreeRegistration);

  // 变更联动:defaults / 元件 kbengine.xml 保存或增删后重算已打开的合成文档
  if (
    vscode.workspace.getConfiguration('kbengine').get<boolean>('autoRefreshFinalConfig', true)
  ) {
    const finalConfigWatcher = vscode.workspace.createFileSystemWatcher('**/kbengine*.xml');
    // kbengine*.xml 增删改同时影响数据库连接读值(批131):失效缓存再联动
    finalConfigWatcher.onDidChange(() => {
      resetDatabaseInterfaceConfigCache();
      finalConfigProvider.refresh();
    });
    finalConfigWatcher.onDidCreate(() => {
      resetDatabaseInterfaceConfigCache();
      finalConfigProvider.refresh();
    });
    finalConfigWatcher.onDidDelete(() => {
      resetDatabaseInterfaceConfigCache();
      finalConfigProvider.refresh();
    });
    context.subscriptions.push(finalConfigWatcher);
  }

  const createDebugConfigCommand = vscode.commands.registerCommand(
    'kbengine.debug.createConfig',
    async () => {
      await debugConfigManager.createExampleConfig();
    }
  );
  context.subscriptions.push(createDebugConfigCommand);

  const startDebuggingCommand = vscode.commands.registerCommand(
    'kbengine.debug.start',
    async (target) => {
      const component = resolveServerComponent(target);
      if (component) {
        await debugConfigManager.startDebugging(component.name);
      } else {
        const selection = await pickServerComponent('选择要调试的组件');
        if (selection) {
          await debugConfigManager.startDebugging(selection.name);
        }
      }
    }
  );
  context.subscriptions.push(startDebuggingCommand);

  const attachToComponentCommand = vscode.commands.registerCommand(
    'kbengine.debug.attach',
    async (target) => {
      const component = resolveServerComponent(target);
      if (component) {
        await debugConfigManager.attachToComponent(component.name);
      } else {
        const selection = await pickServerComponent('选择要附加的组件');
        if (selection) {
          await debugConfigManager.attachToComponent(selection.name);
        }
      }
    }
  );
  context.subscriptions.push(attachToComponentCommand);

  // 远程附加(批112 用户令:配置服务器 IP 数组,点击远程弹目标选择)
  const attachRemoteCommand = vscode.commands.registerCommand(
    'kbengine.debug.attachRemote',
    async () => {
      await debugConfigManager.attachRemote();
    }
  );
  context.subscriptions.push(attachRemoteCommand);

  // 初始化监控面板
  const monitoringCollector = new MonitoringCollector(context);
  const monitoringWebView = new MonitoringWebView(context, monitoringCollector);

  // 注册监控相关命令
  const showMonitoringCommand = vscode.commands.registerCommand(
    'kbengine.monitoring.show',
    () => {
      monitoringWebView.show();
    }
  );
  context.subscriptions.push(showMonitoringCommand);

  // 初始化实体依赖关系图
  const outputChannel = vscode.window.createOutputChannel('KBEngine Dependency');
  const dependencyWebView = new EntityDependencyWebView(context, outputChannel);

  // 注册依赖关系相关命令
  const showDependencyCommand = vscode.commands.registerCommand(
    'kbengine.dependency.show',
    () => dependencyWebView.show()
  );
  context.subscriptions.push(showDependencyCommand);

  // 实体架构流程图(批124):客户端到 base/cell 的方法调用与属性自动同步,
  // 边语义按 Flags 位带引擎出处。实体名缺省取活动 .def 编辑器。
  const flowWebView = new EntityFlowWebView(context);
  const showEntityFlowCommand = vscode.commands.registerCommand(
    'kbengine.flow.show',
    (entityName?: string) => flowWebView.show(entityName)
  );
  context.subscriptions.push(showEntityFlowCommand);

  // 快速执行动作(批126):动作清单由 .kbengine/debug.json 的 quickActions 驱动,
  // 独立树视图逐行执行;Servers 与编辑器标题栏保留清单入口。
  // 首装扫一层 .bat/.ps1 的提示在激活末跑一次(不 await,不挡激活)。
  // 批136:保留 runDefault 命令,供命令面板一键跑上次执行的动作。
  const quickActionManager = new QuickActionManager(context, {
    getSettingHttpEntries: () => parseHttpRequestEntries(vscode.workspace.getConfiguration('kbengine').get('httpRequests')),
    runHttpEntry: entry => httpRequestService.runEntry(entry)
  });
  quickActionManagerRef.current = quickActionManager;
  const quickActionTreeProvider = new QuickActionTreeProvider({
    getActions: () => quickActionManager.getTreeData()
  });
  context.subscriptions.push(vscode.window.registerTreeDataProvider('kbengine.quickActions', quickActionTreeProvider));
  const runQuickActionByNameCommand = vscode.commands.registerCommand(
    'kbengine.quickActions.runByName',
    (name: string) => quickActionManager.runByName(name)
  );
  context.subscriptions.push(runQuickActionByNameCommand);
  const showQuickActionsCommand = vscode.commands.registerCommand('kbengine.quickActions.show', () =>
    quickActionManager.show()
  );
  context.subscriptions.push(showQuickActionsCommand);
  const rescanQuickActionScriptsCommand = vscode.commands.registerCommand(
    'kbengine.quickActions.scanScripts',
    async () => {
      await quickActionManager.scanScriptsAndRefresh();
      quickActionTreeProvider.refresh();
    }
  );
  context.subscriptions.push(rescanQuickActionScriptsCommand);
  const runDefaultQuickActionCommand = vscode.commands.registerCommand(
    'kbengine.quickActions.runDefault',
    () => quickActionManager.runDefault()
  );
  context.subscriptions.push(runDefaultQuickActionCommand);

  // 自动热重载(盘点 G5):文件保存/监视 → 按名触发 quick action。门控默认关
  // 防误触;无人值守通道跳过确认框,找不到名字只落 OUTPUT 流水不弹窗。
  setupHotReload(context, actionName =>
    quickActionManager.runByName(actionName, { suppressConfirm: true })
  );

  // Python 生态接线(盘点 G1/G2):先导出 .kbengine/stubs/KBEngine.pyi
  // (符号索引发射,盘点 G2),再同步 python.analysis.extraPaths(scripts 根
  // + 存根目录,盘点 G1)——顺序保证首次激活存根就进得了 extraPaths。
  // 激活期全程零提示不打扰开窗;命令面板留手动重跑入口(存根导出命令
  // 导出后链一次同步,新目录即刻生效)。
  const syncPythonExtraPathsCommand = vscode.commands.registerCommand(
    'kbengine.python.syncExtraPaths',
    () => syncPythonExtraPaths(context)
  );
  context.subscriptions.push(syncPythonExtraPathsCommand);
  const exportKbeStubsCommand = vscode.commands.registerCommand(
    'kbengine.python.exportStubs',
    async () => {
      await exportKbeStubs();
      await syncPythonExtraPaths(context);
    }
  );
  context.subscriptions.push(exportKbeStubsCommand);
  // types.xml 自定义类型桩(docs/design/def-pyi-stubs.md §6):kbe_types.py 与
  // KBEngine.pyi 同开关同目录,命令导出后同样链一次同步让新目录即刻生效
  const exportPythonTypeStubsCommand = vscode.commands.registerCommand(
    'kbengine.python.exportTypeStubs',
    async () => {
      await exportPythonTypeStubs();
      await syncPythonExtraPaths(context);
    }
  );
  context.subscriptions.push(exportPythonTypeStubsCommand);
  void (async () => {
    await exportKbeStubs(fileSystemStubExportDeps, { silent: true });
    await exportPythonTypeStubs(fileSystemStubExportDeps, { silent: true });
    await syncPythonExtraPaths(context, fileSystemScriptRootDeps, { silent: true });
  })();
  // 批142(用户单 kode-debug-json.md):`.kbengine/debug.json` 缺失即生成带注释
  // 的骨架,并按脚本扫描填 quickActions。放在首装扫描之前——骨架里已经有动作
  // 时,首装扫描不再重复问用户。生效工作目录与来源落 OUTPUT 通道。
  const debugConfigChannel = vscode.window.createOutputChannel(DEBUG_CONFIG_CHANNEL_NAME);
  context.subscriptions.push(debugConfigChannel);
  const bootstrap = ensureDebugConfig(
    { ...fileSystemBootstrapDeps, log: (line: string): void => debugConfigChannel.appendLine(line) },
    {
      workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map(folder => ({
        name: folder.name,
        fsPath: folder.uri.fsPath
      })),
      scanRoots: (vscode.workspace.workspaceFolders ?? []).slice(0, 1)
        .map(folder => resolveAssetsRootForWorkspace(folder.uri.fsPath))
        .filter((root): root is string => root.length > 0)
    }
  );
  const firstWorkspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  const assetsRoot = firstWorkspaceRoot ? resolveAssetsRootForWorkspace(firstWorkspaceRoot) : '';
  quickActionManager.setConfigurationRoots(
    bootstrap.workspaceRoot,
    assetsRoot ? [assetsRoot] : []
  );
  // 首装扫描要读写 workspaceState(取消记忆);宿主没给(嵌入/烟测替身)就不扫
  if (context.workspaceState) {
    void quickActionManager.offerScanOnActivate();
  }

  // 初始化代码生成器
  const codeGenerator = new KBEngineCodeGenerator(context);

  // 注册代码生成器相关命令
  const showGeneratorWizardCommand = vscode.commands.registerCommand(
    'kbengine.generator.wizard',
    () => codeGenerator.showWizard()
  );
  context.subscriptions.push(showGeneratorWizardCommand);

  const showTemplatesCommand = vscode.commands.registerCommand(
    'kbengine.generator.templates',
    () => codeGenerator.showTemplates()
  );
  context.subscriptions.push(showTemplatesCommand);

  // 定义形态生成(盘点 G7):代理/空间/组件/固定字典四种形态的向导,实体向导之外
  // 的定义面(此前只能手写)。已代决按「先出骨架 + 引擎装载口径附带改写」落地
  const showGeneratorFormWizardCommand = vscode.commands.registerCommand(
    'kbengine.generator.formWizard',
    () => runGeneratorFormWizard()
  );
  context.subscriptions.push(showGeneratorFormWizardCommand);

  // 客户端实体 SDK 生成(盘点 G4):按 entities.xml 登记实体生成客户端语言骨架,
  // 语言清单在命令内选(已代决首批 TS + C#)
  const clientSdkGenerateCommand = vscode.commands.registerCommand(
    'kbengine.clientSdk.generate',
    () => runClientSdkGenerateCommand()
  );
  context.subscriptions.push(clientSdkGenerateCommand);

  // .def 静态分析建议(性能分析):扫描工作区全部 .def,报告写入输出面板
  // 并以诊断形式落到问题列表
  const defAnalysisOutputChannel = vscode.window.createOutputChannel('KBEngine Def 分析');
  const defAnalysisDiagnostics = vscode.languages.createDiagnosticCollection(
    'kbengine-def-analysis'
  );
  const analyzeDefCommand = vscode.commands.registerCommand(
    'kbengine.def.analyze',
    async () => {
      const defUris = await findFilesAcrossRoots('**/*.def');
      if (defUris.length === 0) {
        vscode.window.showInformationMessage('未找到 .def 文件,无法分析');
        return;
      }

      defAnalysisOutputChannel.clear();
      defAnalysisDiagnostics.clear();
      // 每个 .def 只打开一次:文本缓存供单文件检查与继承链闭包(collectInheritedNames)共用
      const sortedUris = defUris.sort((a, b) => a.fsPath.localeCompare(b.fsPath));
      const openedDocuments = new Map<string, vscode.TextDocument>();
      const defTexts = new Map<string, string>();
      for (const uri of sortedUris) {
        const document = await vscode.workspace.openTextDocument(uri);
        openedDocuments.set(uri.fsPath, document);
        defTexts.set(path.resolve(uri.fsPath), document.getText());
      }
      const readDefText = (filePath: string): string | null =>
        defTexts.get(path.resolve(filePath)) ?? null;

      let totalFindings = 0;
      for (const uri of sortedUris) {
        const document = openedDocuments.get(uri.fsPath) as vscode.TextDocument;
        const findings = analyzeDefDocument(document.getText(), collectInheritedNames(uri.fsPath, readDefText));
        totalFindings += findings.length;
        defAnalysisOutputChannel.appendLine(
          formatDefAnalysisReport(uri.fsPath, findings)
        );
        defAnalysisDiagnostics.set(
          uri,
          findings.map(item => {
            const start = document.positionAt(item.offset);
            const end = document.positionAt(item.offset + item.length);
            return new vscode.Diagnostic(
              new vscode.Range(start, end),
              item.message,
              item.severity === 'error'
                ? vscode.DiagnosticSeverity.Error
                : item.severity === 'warning'
                  ? vscode.DiagnosticSeverity.Warning
                  : vscode.DiagnosticSeverity.Information
            );
          })
        );
      }

      defAnalysisOutputChannel.show();
      vscode.window.showInformationMessage(
        `Def 分析完成: ${defUris.length} 个文件, ${totalFindings} 条建议`
      );
    }
  );
  context.subscriptions.push(analyzeDefCommand);
  context.subscriptions.push(defAnalysisOutputChannel);
  context.subscriptions.push(defAnalysisDiagnostics);

  // 自定义代码片段生成器:把选区文本做片段语法转义(\$ 与 \\)并去公共缩进
  // 为片段体,经名称/前缀/描述三步输入后合并写入工作区
  // .vscode/kbengine-custom.code-snippets;手改出注释/坏 JSON 的片段文件
  // 不静默改写,报错让用户先整理
  const generateSnippetCommand = vscode.commands.registerCommand(
    'kbengine.snippets.generateFromSelection',
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        vscode.window.showInformationMessage('请先在编辑器中选中要生成片段的文本');
        return;
      }

      const snippetName = await vscode.window.showInputBox({
        prompt: '输入代码片段名称',
        placeHolder: 'MyDefTemplate',
        validateInput: (value) => (!value || value.trim() === '' ? '片段名称不能为空' : null)
      });
      if (!snippetName) {
        return;
      }

      const prefix = await vscode.window.showInputBox({
        prompt: '输入触发前缀',
        placeHolder: `kbe-${snippetName.toLowerCase()}`,
        value: `kbe-${snippetName.toLowerCase()}`,
        validateInput: (value) => (!value || value.trim() === '' ? '触发前缀不能为空' : null)
      });
      if (!prefix) {
        return;
      }

      // 描述可选:取消(Esc)按仓库既有口径视为继续,记空串不写该字段
      const description = await vscode.window.showInputBox({
        prompt: '输入片段描述(可选)',
        value: ''
      }) ?? '';

      // tabSize 列语义参与去公共缩进:选区 tab/空格混用时字符数口径
      // 保不住相对层级(审计块18 遗留①);d.ts 声明 tabSize 为 string|number,
      // 非数字回落默认 4
      const editorTabSize = typeof editor.options.tabSize === 'number'
        ? editor.options.tabSize
        : 4;
      const body = selectionToSnippetBody(
        editor.document.getText(editor.selection),
        editorTabSize
      );
      if (body.length === 0) {
        vscode.window.showInformationMessage('选区不含有效文本,未生成片段');
        return;
      }

      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        vscode.window.showErrorMessage('没有打开的工作区,无法保存自定义片段');
        return;
      }

      const snippetsFilePath = joinWorkspacePath(
        workspaceFolder.uri.fsPath,
        CUSTOM_SNIPPETS_RELATIVE_PATH
      );
      // 读取/写入的底层 IO 失败(权限、路径被文件占位等)不裸抛给宿主,
      // 落到错误通道并给出片段文件路径
      let existingContent: string | null;
      try {
        existingContent = fs.existsSync(snippetsFilePath)
          ? fs.readFileSync(snippetsFilePath, 'utf8')
          : null;
      } catch (error) {
        vscode.window.showErrorMessage(
          `无法读取自定义片段文件: ${snippetsFilePath}(${(error as Error).message})`
        );
        return;
      }

      let merged: MergeSnippetResult;
      try {
        merged = mergeSnippetEntry(existingContent, snippetName, {
          prefix,
          body,
          description,
          scope: editor.document.languageId
        });
      } catch {
        vscode.window.showErrorMessage(
          `自定义片段文件不是合法的对象 JSON,请先手工整理后再生成: ${snippetsFilePath}`
        );
        return;
      }

      try {
        fs.mkdirSync(path.dirname(snippetsFilePath), { recursive: true });
        fs.writeFileSync(snippetsFilePath, merged.content, 'utf8');
      } catch (error) {
        vscode.window.showErrorMessage(
          `无法写入自定义片段文件: ${snippetsFilePath}(${(error as Error).message})`
        );
        return;
      }

      if (merged.overwritten) {
        vscode.window.showWarningMessage(
          `已覆盖同名自定义片段 ${snippetName}: ${snippetsFilePath}`
        );
      } else {
        vscode.window.showInformationMessage(
          `已生成自定义代码片段 ${snippetName}(前缀 ${prefix}): ${snippetsFilePath}`
        );
      }
    }
  );
  context.subscriptions.push(generateSnippetCommand);

  // 创建状态栏项
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'workbench.view.extension.kbengine-explorer';
  context.subscriptions.push(statusBarItem);

  // 更新状态栏
  function updateStatusBar(manager: KBEngineServerManager) {
    const runningCount = manager.getRunningServers().size;
    const totalCount = SERVER_COMPONENTS.length;

    if (runningCount > 0) {
      statusBarItem.text = `$(server) KBEngine: ${runningCount}/${totalCount} Running`;
      statusBarItem.show();
    } else {
      statusBarItem.hide();
    }
  }

  // 启动时更新状态栏
  updateStatusBar(serverManager);

  // 批125 自动发现:激活期盘点工作区锚点(entities.xml/entity_defs/types.xml/
  // kbe 源码根),多候选弹一次 quick pick 并记忆(workspaceState 回放,后续
  // 会话不再询问);单候选/零命中零打扰。显式配置永远优先于发现结果。
  // workspaceState 缺失(测试替身/嵌入场景)时静默跳过,不做磁盘级记忆。
  const primaryWorkspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  // 批127 发现与定位诊断:定位失败不再静默——报告摊开每个键的显式配置/
  // 约定链/深扫描/记忆选择与最终取用,写入输出通道供复制回传。
  const discoveryReportChannel = vscode.window.createOutputChannel('KBEngine 发现与定位');
  const writeDiscoveryReport = (workspaceRoot: string): number => {
    const config = vscode.workspace.getConfiguration('kbengine');
    const layout = getDefinitionWorkspaceLayout(workspaceRoot);
    const facts: DiscoveryLayoutFacts = {
      // 不可达(批64 定性):layout.entityDefsRoot 恒为非空字符串(见
      // definitionWorkspace.ts 同口径区间),空值臂无来源;保留守卫防布局
      // 契约变更时静默出错。
      /* istanbul ignore start */
      entityDefsRoot: layout.entityDefsRoot || '',
      /* istanbul ignore stop */
      entityScriptsRoot: layout.entityScriptsRoot,
      interfacesRoot: layout.interfacesRoot,
      componentsRoot: layout.componentsRoot,
      entitiesXmlPath: layout.entitiesXmlPath,
      typesXmlPath: layout.typesXmlPath,
      configPath: config.get<string>('assetsRoot', ''),
      // 生效资产根走管理器口径(原值探针命中优先,否则发现兜底,批128)
      configPathEffective: serverManager.getConfigPath(),
      binPathSetting: config.get<string>('binPath', ''),
      binPath: serverManager.getBinPath(),
      entityDefsPathSetting: config.get<string>('entityDefsPath', ''),
      entitiesXmlPathSetting: config.get<string>('entitiesXmlPath', ''),
      // types.xml 无独立配置项,布局内硬编码候选链,显式配置恒空
      typesXmlPathSetting: ''
    };
    const report = buildDiscoveryReport(workspaceRoot, facts);
    discoveryReportChannel.clear();
    discoveryReportChannel.appendLine(renderDiscoveryReport(report));
    return report.issues.length;
  };
  const discoveryReportCommand = vscode.commands.registerCommand(
    'kbengine.discovery.report',
    () => {
      if (!primaryWorkspaceRoot) {
        vscode.window.showWarningMessage('未打开工作区,无法生成发现与定位诊断');
        return;
      }
      const issueCount = writeDiscoveryReport(primaryWorkspaceRoot);
      discoveryReportChannel.show(true);
      if (issueCount > 0) {
        vscode.window.showWarningMessage(
          `发现与定位存在 ${issueCount} 项问题,详见「KBEngine 发现与定位」输出面板`
        );
      } else {
        vscode.window.showInformationMessage('发现与定位全部正常');
      }
    }
  );
  context.subscriptions.push(discoveryReportCommand, discoveryReportChannel);

  // 激活期发现完成后自动落一份报告;有问题时提示用户到输出面板看/复制回传
  const discoveryRoot = primaryWorkspaceRoot;
  if (discoveryRoot && context.workspaceState) {
    const workspaceState = context.workspaceState;
    const discoveryStateKey = `kbengine.discovery.${discoveryRoot}`;
    const discoveryDeps: DiscoveryPromptDeps = {
      showQuickPick: (items, title) =>
        vscode.window.showQuickPick(items, { placeHolder: title, ignoreFocusOut: true }),
      recall: () =>
        workspaceState.get<Partial<Record<DiscoveryKey, string>>>(discoveryStateKey),
      remember: (_root, choices) =>
        void workspaceState.update(discoveryStateKey, choices)
    };
    void runWorkspaceDiscovery(discoveryDeps, discoveryRoot).then(() => {
      const issueCount = writeDiscoveryReport(discoveryRoot);
      if (issueCount > 0) {
        vscode.window.showWarningMessage(
          `发现与定位存在 ${issueCount} 项问题,详见「KBEngine 发现与定位」输出面板`
        );
      }
    });
  }

  // 默认开启令:激活即出最终配置视图(后台标签,不抢焦点);定位不到
  // defaults(未配 binPath 或引擎目录不在)静默跳过,不弹错
  if (
    vscode.workspace.getConfiguration('kbengine').get<boolean>('showFinalConfigOnOpen', true)
  ) {
    void openFinalConfig(true);
  }

  // 清理资源
  context.subscriptions.push({
    dispose: () => {
      telnetService.dispose();
      telnetWebView.dispose();
      serverManager.dispose();
      logCollector.dispose();
      logViewer.dispose();
      debugConfigManager.dispose();
      monitoringWebView.dispose();
      monitoringCollector.dispose();
      entityMappingManager.dispose();
      dependencyWebView.dispose();
      flowWebView.dispose();
      codeGenerator.dispose();
      outputChannel.dispose();
    }
  });
}

export function deactivate() {
  console.log('KBEngine Language Extension is now deactivated!');
}
