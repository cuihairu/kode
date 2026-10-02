import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { KBEngineServerManager, SERVER_COMPONENTS } from './serverManager';
import { KBEngineLogCollector, LogCollectorConfig } from './logCollector';
import { LogViewerWebView } from './logWebView';
import { DebugConfigManager } from './debugConfig';
import { MonitoringWebView } from './monitoringWebView';
import { MonitoringCollector } from './monitoringCollector';
import {
  DefinitionSymbolIdentity,
  EntityMappingManager,
  EntityMethodSection
} from './entityMapping';
import { EntityDependencyWebView } from './entityDependencyWebView';
import { KBEngineCodeGenerator } from './codeGenerator';
import {
  EntityExplorerProvider,
  pickServerComponent,
  ServerControlProvider
} from './explorerProviders';
import { resolveServerComponent } from './serverCommandTarget';
import {
  KBEngineCallHierarchyProvider,
  KBEngineCompletionProvider,
  KBEngineDefinitionProvider,
  KBEngineHoverProvider,
  KBEngineRenameProvider,
  PythonCompletionProvider,
  PythonDefinitionProvider,
  validateDocument
} from './languageProviders';
import {
  createDatabaseSchemaUri,
  getDatabaseSchemaSnapshot,
  KBEngineDatabaseSchemaProvider,
  locateDatabaseSchemaLine
} from './databaseSchema';
import { findEntityDefinitionFile } from './definitionWorkspace';
import { analyzeDefDocument, formatDefAnalysisReport } from './defAnalyzer';
import { joinWorkspacePath } from './workspacePath';
import {
  CUSTOM_SNIPPETS_RELATIVE_PATH,
  mergeSnippetEntry,
  selectionToSnippetBody
} from './snippetGenerator';
import type { MergeSnippetResult } from './snippetGenerator';

/**
 * Kode - KBEngine Development Environment
 * KBEngine VSCode 扩展主入口
 */

export function activate(context: vscode.ExtensionContext) {
  console.log('KBEngine Language Extension is now active!');
  const databaseSchemaProvider = new KBEngineDatabaseSchemaProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('kbengine-db-schema', databaseSchemaProvider)
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

  // 初始化实体映射管理器
  const entityMappingManager = new EntityMappingManager(context);

  // 注册定义跳转提供者（.def 文件）
  const definitionProvider = vscode.languages.registerDefinitionProvider(
    definitionNavigationSelector,
    new KBEngineDefinitionProvider(entityMappingManager)
  );
  context.subscriptions.push(definitionProvider);

  // 注册 Python 文件的定义提供者（Python → .def 跳转）
  const pythonDefinitionProvider = vscode.languages.registerDefinitionProvider(
    { language: 'python', scheme: 'file' },
    new PythonDefinitionProvider(entityMappingManager)
  );
  context.subscriptions.push(pythonDefinitionProvider);

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
      }
    });
    context.subscriptions.push(watcher);

    // 初始检查所有 .def 文件
    const openWatcher = vscode.workspace.onDidOpenTextDocument(document => {
      if (isDefDocument(document)) {
        validateDocument(document, diagnostics);
      }
    });
    context.subscriptions.push(openWatcher);

    vscode.workspace.textDocuments.forEach(document => {
      if (isDefDocument(document)) {
        validateDocument(document, diagnostics);
      }
    });
  }

  const configWatcher = vscode.workspace.onDidChangeConfiguration(event => {
    if (!event.affectsConfiguration('kbengine')) {
      return;
    }

    vscode.workspace.textDocuments.forEach(doc => {
      if (isDefDocument(doc)) {
        validateDocument(doc, diagnostics);
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
    async (entityName: string, tableName?: string, fieldName?: string) => {
      if (!entityName) {
        return;
      }

      try {
        const uri = createDatabaseSchemaUri(entityName);
        const document = await vscode.workspace.openTextDocument(uri);
        const snapshot = getDatabaseSchemaSnapshot(entityName);
        const line = snapshot
          ? locateDatabaseSchemaLine(snapshot, tableName || `tbl_${entityName}`, fieldName)
          : 1;
        const position = new vscode.Position(Math.max(line - 1, 0), 0);
        const selection = new vscode.Range(position, position);
        await vscode.window.showTextDocument(document, { selection });
      } catch (error) {
        vscode.window.showWarningMessage(
          `打开数据库结构失败: ${entityName}${tableName ? ` (${tableName}${fieldName ? `.${fieldName}` : ''})` : ''} (${error})`
        );
      }
    }
  );
  context.subscriptions.push(openDatabaseSchemaCommand);

  // 初始化服务器管理器
  const serverManager = new KBEngineServerManager(context);

  // 注册服务器控制视图
  const serverControlProvider = new ServerControlProvider(serverManager);
  const serverControlRegistration = vscode.window.registerTreeDataProvider(
    'kbengine.serverControl',
    serverControlProvider
  );
  context.subscriptions.push(serverControlRegistration);

  // 服务器状态变化时刷新视图
  const serverStatusSubscription = serverManager.onDidChangeStatus(() => {
    serverControlProvider.refresh();
    updateStatusBar(serverManager);
  });
  context.subscriptions.push(serverStatusSubscription);

  // 注册服务器控制命令
  const startServerCommand = vscode.commands.registerCommand(
    'kbengine.server.start',
    (target) => {
      const component = resolveServerComponent(target);
      if (component) {
        void serverManager.startComponent(component);
      } else {
        void serverManager.startAutoComponents();
      }
    }
  );
  context.subscriptions.push(startServerCommand);

  const stopServerCommand = vscode.commands.registerCommand(
    'kbengine.server.stop',
    (target) => {
      const component = resolveServerComponent(target);
      if (component) {
        void serverManager.stopComponent(component.name);
      } else {
        void serverManager.stopAll();
      }
    }
  );
  context.subscriptions.push(stopServerCommand);

  const restartServerCommand = vscode.commands.registerCommand(
    'kbengine.server.restart',
    (target) => {
      const component = resolveServerComponent(target);
      if (!component) {
        return;
      }

      void serverManager.restartComponent(component.name);
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

  // .def 静态分析建议(性能分析):扫描工作区全部 .def,报告写入输出面板
  // 并以诊断形式落到问题列表
  const defAnalysisOutputChannel = vscode.window.createOutputChannel('KBEngine Def 分析');
  const defAnalysisDiagnostics = vscode.languages.createDiagnosticCollection(
    'kbengine-def-analysis'
  );
  const analyzeDefCommand = vscode.commands.registerCommand(
    'kbengine.def.analyze',
    async () => {
      const defUris = await vscode.workspace.findFiles('**/*.def');
      if (defUris.length === 0) {
        vscode.window.showInformationMessage('未找到 .def 文件,无法分析');
        return;
      }

      defAnalysisOutputChannel.clear();
      defAnalysisDiagnostics.clear();
      let totalFindings = 0;
      for (const uri of defUris.sort((a, b) => a.fsPath.localeCompare(b.fsPath))) {
        const document = await vscode.workspace.openTextDocument(uri);
        const findings = analyzeDefDocument(document.getText());
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

      const body = selectionToSnippetBody(editor.document.getText(editor.selection));
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
      const existingContent = fs.existsSync(snippetsFilePath)
        ? fs.readFileSync(snippetsFilePath, 'utf8')
        : null;

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

      fs.mkdirSync(path.dirname(snippetsFilePath), { recursive: true });
      fs.writeFileSync(snippetsFilePath, merged.content, 'utf8');

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

  // 清理资源
  context.subscriptions.push({
    dispose: () => {
      serverManager.dispose();
      logCollector.dispose();
      logViewer.dispose();
      debugConfigManager.dispose();
      monitoringWebView.dispose();
      monitoringCollector.dispose();
      entityMappingManager.dispose();
      dependencyWebView.dispose();
      codeGenerator.dispose();
      outputChannel.dispose();
    }
  });
}

export function deactivate() {
  console.log('KBEngine Language Extension is now deactivated!');
}
