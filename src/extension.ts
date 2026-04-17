import * as vscode from 'vscode';
import { KBEngineServerManager, SERVER_COMPONENTS } from './serverManager';
import { KBEngineLogCollector, LogCollectorConfig } from './logCollector';
import { LogViewerWebView } from './logWebView';
import { DebugConfigManager } from './debugConfig';
import { MonitoringWebView } from './monitoringWebView';
import { MonitoringCollector } from './monitoringCollector';
import { EntityMappingManager } from './entityMapping';
import { EntityDependencyWebView } from './entityDependencyWebView';
import { KBEngineCodeGenerator } from './codeGenerator';
import {
  EntityExplorerProvider,
  pickServerComponent,
  ServerControlProvider
} from './explorerProviders';
import { resolveServerComponent } from './serverCommandTarget';
import {
  KBEngineCompletionProvider,
  KBEngineDefinitionProvider,
  KBEngineHoverProvider,
  PythonCompletionProvider,
  PythonDefinitionProvider,
  validateDocument
} from './languageProviders';
import { findEntityDefinitionFile } from './definitionWorkspace';

/**
 * Kode - KBEngine Development Environment
 * KBEngine VSCode 扩展主入口
 */

export function activate(context: vscode.ExtensionContext) {
  console.log('KBEngine Language Extension is now active!');
  const defDocumentSelector: vscode.DocumentSelector = [
    { language: 'kbengine-def', scheme: 'file' },
    { scheme: 'file', pattern: '**/*.def' },
    { language: 'kbengine-def', scheme: 'untitled' }
  ];

  const isDefDocument = (document: vscode.TextDocument): boolean =>
    document.languageId === 'kbengine-def' || document.fileName.toLowerCase().endsWith('.def');

  // 注册智能提示提供者
  const completionProvider = vscode.languages.registerCompletionItemProvider(
    defDocumentSelector,
    new KBEngineCompletionProvider(),
    '<', ' ', '\t', '>', '/', ':'
  );
  context.subscriptions.push(completionProvider);

  // 注册悬停文档提供者
  const hoverProvider = vscode.languages.registerHoverProvider(
    defDocumentSelector,
    new KBEngineHoverProvider()
  );
  context.subscriptions.push(hoverProvider);

  // 注册定义跳转提供者（.def 文件）
  const definitionProvider = vscode.languages.registerDefinitionProvider(
    defDocumentSelector,
    new KBEngineDefinitionProvider()
  );
  context.subscriptions.push(definitionProvider);

  // 初始化实体映射管理器
  const entityMappingManager = new EntityMappingManager(context);

  // 注册 Python 文件的定义提供者（Python → .def 跳转）
  const pythonDefinitionProvider = vscode.languages.registerDefinitionProvider(
    { language: 'python', scheme: 'file' },
    new PythonDefinitionProvider(entityMappingManager)
  );
  context.subscriptions.push(pythonDefinitionProvider);

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
  vscode.window.registerTreeDataProvider(
    'kbengine.entityExplorer',
    entityExplorerProvider
  );

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
          `鎵撳紑瀹炰綋瀹氫箟澶辫触: ${entityName}.def (鏈壘鍒板畾涔夋枃浠?`
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

  // 初始化服务器管理器
  const serverManager = new KBEngineServerManager(context);

  // 注册服务器控制视图
  const serverControlProvider = new ServerControlProvider(serverManager);
  vscode.window.registerTreeDataProvider(
    'kbengine.serverControl',
    serverControlProvider
  );

  // 服务器状态变化时刷新视图
  serverManager.onDidChangeStatus(() => {
    serverControlProvider.refresh();
    updateStatusBar(serverManager);
  });

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
