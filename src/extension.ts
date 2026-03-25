import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { KBENGINE_HOOKS, getHookByName, HOOK_CATEGORY_NAMES } from './hooks';
import { KBEngineServerManager, SERVER_COMPONENTS, ServerStatus } from './serverManager';
import { KBEngineLogCollector, CollectorStatus, LogCollectorConfig } from './logCollector';
import { LogViewerWebView } from './logWebView';
import { DebugConfigManager } from './debugConfig';
import { MonitoringWebView } from './monitoringWebView';
import { MonitoringCollector } from './monitoringCollector';
import { EntityMappingManager } from './entityMapping';

/**
 * Kode - KBEngine Development Environment
 * KBEngine VSCode 扩展主入口
 */

// KBEngine 支持的类型
const KBENGINE_TYPES = [
  // 基础类型
  { name: 'UINT8', detail: '无符号8位整数', documentation: '范围: 0-255, 占用1字节' },
  { name: 'UINT16', detail: '无符号16位整数', documentation: '范围: 0-65535, 占用2字节' },
  { name: 'UINT32', detail: '无符号32位整数', documentation: '范围: 0-4294967295, 占用4字节' },
  { name: 'UINT64', detail: '无符号64位整数', documentation: '范围: 0-18446744073709551615, 占用8字节' },
  { name: 'INT8', detail: '有符号8位整数', documentation: '范围: -128-127, 占用1字节' },
  { name: 'INT16', detail: '有符号16位整数', documentation: '范围: -32768-32767, 占用2字节' },
  { name: 'INT32', detail: '有符号32位整数', documentation: '范围: -2147483648-2147483647, 占用4字节' },
  { name: 'INT64', detail: '有符号64位整数', documentation: '范围: -9223372036854775808-9223372036854775807, 占用8字节' },
  { name: 'FLOAT', detail: '单精度浮点数', documentation: '32位IEEE 754浮点数' },
  { name: 'DOUBLE', detail: '双精度浮点数', documentation: '64位IEEE 754浮点数' },
  { name: 'BOOL', detail: '布尔值', documentation: 'true 或 false' },
  { name: 'STRING', detail: '字符串', documentation: '变长字符串类型' },
  { name: 'VECTOR2', detail: '2D向量', documentation: '包含 x, y 两个浮点数' },
  { name: 'VECTOR3', detail: '3D向量', documentation: '包含 x, y, z 三个浮点数' },
  { name: 'VECTOR4', detail: '4D向量', documentation: '包含 x, y, z, w 四个浮点数' },
  { name: 'MAILBOX', detail: '实体引用', documentation: '指向其他实体的引用类型' },
  // 容器类型
  { name: 'ARRAY', detail: '数组', documentation: '动态数组类型: ARRAY<TYPE>' },
  { name: 'FIXED_DICT', detail: '固定字典', documentation: '类Python字典结构，需要定义实现类' },
  { name: 'TUPLE', detail: '元组', documentation: '固定长度元组，每个位置可以指定不同类型' }
];

// KBEngine 支持的 Flags
const KBENGINE_FLAGS = [
  {
    name: 'BASE',
    detail: 'BaseApp存储',
    documentation: '数据存储在BaseApp，不会自动分片'
  },
  {
    name: 'CLIENT',
    detail: '客户端可见',
    documentation: '数据会同步到客户端'
  },
  {
    name: 'BASE_CLIENT',
    detail: 'BaseApp存储 + 客户端可见',
    documentation: '数据存储在BaseApp并同步到客户端（最常用组合）'
  },
  {
    name: 'CELL_PUBLIC',
    detail: 'CellApp公开',
    documentation: '其他实体可以访问该属性'
  },
  {
    name: 'CELL_PRIVATE',
    detail: 'CellApp私有',
    documentation: '只有实体自己可以访问该属性'
  },
  {
    name: 'CELL_PUBLIC_AND_PRIVATE',
    detail: 'CellApp公开+私有',
    documentation: '同时设置CELL_PUBLIC和CELL_PRIVATE标志'
  },
  {
    name: 'ALL_CLIENTS',
    detail: '所有客户端可见',
    documentation: '属性会广播给所有能感知到该实体的客户端'
  },
  {
    name: 'OWN_CLIENT',
    detail: '仅拥有者可见',
    documentation: '属性只同步给控制该实体的客户端'
  }
];

// Detail Level 常量
const DETAIL_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

// KBEngine 热更新相关函数
const KBENGINE_RELOAD_FUNCTIONS = [
  {
    name: 'KBEngine.reloadEntityDef',
    detail: '重新加载实体定义',
    documentation: '热更新实体定义，使修改后的 .def 文件生效。\n\n**参数**:\n- fullReload (bool): True=完全重新加载所有实体，False=只加载新的实体\n\n**示例**:\n```python\nimport KBEngine\n# 完全重新加载\nKBEngine.reloadEntityDef(True)\n# 或只加载新的\nKBEngine.reloadEntityDef(False)\n```\n\n**注意**:\n- 修改了 .def 文件中的属性或方法定义后需要调用\n- fullReload=True 会重新加载所有实体定义，可能会影响性能\n- 修改后需要重新创建实体才能看到新的属性或方法\n\n**源码位置**: `kbe/src/lib/entitydef/entitydef.cpp:120-150`'
  },
  {
    name: 'KBEngine.isReload',
    detail: '检查是否热更新',
    documentation: '检查当前是否是热更新场景。\n\n**返回值**: bool\n- True: 当前是热更新场景\n- False: 当前是正常启动场景\n\n**示例**:\n```python\nimport KBEngine\n\ndef onEntitiesEnabled(self):\n    if KBEngine.isReload():\n        INFO_MSG(\"Hot-reloaded!\")\n    else:\n        INFO_MSG(\"Normal startup!\")\n```\n\n**使用场景**:\n- 在 onEntitiesEnabled 中区分热更新和正常启动\n- 热更新后需要重新初始化某些状态时使用\n\n**源码位置**: `kbe/src/lib/entitydef/entitydef.cpp:114-117`'
  },
  {
    name: 'importlib.reload',
    detail: 'Python 脚本热更新',
    documentation: '重新加载 Python 模块，用于热更新 Python 脚本代码。\n\n**参数**:\n- module: 要重新加载的模块对象\n\n**返回值**: 重新加载后的模块对象\n\n**示例**:\n```python\nimport importlib\nimport my_module\n\n# 修改了 my_module.py 后\nmy_module = importlib.reload(my_module)\n```\n\n**注意**:\n- 只对修改了 Python 方法的代码有效\n- 如果修改了 .def 文件，需要使用 KBEngine.reloadEntityDef()\n- 重新加载模块后，需要重新导入模块中的类和函数\n- 已存在的实例不会自动更新\n\n**使用场景**:\n- 修改了实体类的 Python 方法\n- 修改了游戏逻辑代码\n- 调试时快速测试代码修改\n\n**限制**:\n- 不能修改属性定义（需要用 reloadEntityDef）\n- 不能修改方法签名（参数、返回值）\n- 不能修改继承关系'
  }
];

export function activate(context: vscode.ExtensionContext) {
  console.log('KBEngine Language Extension is now active!');

  // 注册智能提示提供者
  const completionProvider = vscode.languages.registerCompletionItemProvider(
    { language: 'kbengine-def', scheme: 'file' },
    new KBEngineCompletionProvider(),
    '<', ' ', '\t'
  );
  context.subscriptions.push(completionProvider);

  // 注册悬停文档提供者
  const hoverProvider = vscode.languages.registerHoverProvider(
    { language: 'kbengine-def', scheme: 'file' },
    new KBEngineHoverProvider()
  );
  context.subscriptions.push(hoverProvider);

  // 注册定义跳转提供者（.def 文件）
  const definitionProvider = vscode.languages.registerDefinitionProvider(
    { language: 'kbengine-def', scheme: 'file' },
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
      if (event.document.languageId === 'kbengine-def') {
        validateDocument(event.document, diagnostics);
      }
    });
    context.subscriptions.push(watcher);

    // 初始检查所有 .def 文件
    vscode.workspace.findFiles('**/*.def', null).then(files => {
      files.forEach(uri => {
        vscode.workspace.textDocuments.forEach(doc => {
          if (doc.uri.toString() === uri.toString()) {
            validateDocument(doc, diagnostics);
          }
        });
      });
    });
  }

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
    (component) => {
      if (component) {
        serverManager.startComponent(component);
      } else {
        serverManager.startAutoComponents();
      }
    }
  );
  context.subscriptions.push(startServerCommand);

  const stopServerCommand = vscode.commands.registerCommand(
    'kbengine.server.stop',
    (component) => {
      if (component) {
        serverManager.stopComponent(component.name);
      } else {
        serverManager.stopAll();
      }
    }
  );
  context.subscriptions.push(stopServerCommand);

  const restartServerCommand = vscode.commands.registerCommand(
    'kbengine.server.restart',
    (component) => serverManager.restartComponent(component.name)
  );
  context.subscriptions.push(restartServerCommand);

  const showLogsCommand = vscode.commands.registerCommand(
    'kbengine.server.showLogs',
    (component) => {
      // 日志会在启动时自动显示在输出通道
      vscode.window.showInformationMessage(`查看 ${component.displayName} 日志`);
    }
  );
  context.subscriptions.push(showLogsCommand);

  // 初始化日志收集器
  const logConfig: LogCollectorConfig = {
    host: '127.0.0.1',
    port: 20022,
    autoReconnect: true,
    reconnectInterval: 5000,
    maxBufferSize: 10000
  };

  const logCollector = new KBEngineLogCollector(logConfig, context);

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
    async (component) => {
      if (component && component.name) {
        await debugConfigManager.startDebugging(component.name);
      } else {
        vscode.window.showQuickPick(
          SERVER_COMPONENTS.map(c => ({
            label: c.displayName,
            description: c.description,
            name: c.name
          })),
          {
            placeHolder: '选择要调试的组件'
          }
        ).then(async (selection) => {
          if (selection) {
            await debugConfigManager.startDebugging(selection.name);
          }
        });
      }
    }
  );
  context.subscriptions.push(startDebuggingCommand);

  const attachToComponentCommand = vscode.commands.registerCommand(
    'kbengine.debug.attach',
    async (component) => {
      if (component && component.name) {
        await debugConfigManager.attachToComponent(component.name);
      } else {
        vscode.window.showQuickPick(
          SERVER_COMPONENTS.map(c => ({
            label: c.displayName,
            description: c.description,
            name: c.name
          })),
          {
            placeHolder: '选择要附加的组件'
          }
        ).then(async (selection) => {
          if (selection) {
            await debugConfigManager.attachToComponent(selection.name);
          }
        });
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
    () => monitoringWebView.show()
  );
  context.subscriptions.push(showMonitoringCommand);

  // 创建状态栏项
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'kbengine.serverControl';
  context.subscriptions.push(statusBarItem);

  // 更新状态栏
  function updateStatusBar(manager: KBEngineServerManager) {
    const runningCount = manager.getRunningServers().size;
    const totalCount = SERVER_COMPONENTS.length;

    if (runningCount > 0) {
      statusBarItem.text = `$(server) KBEngine: ${runningCount}/${totalCount} Running`;
      statusBarItem.backgroundColor = new vscode.ThemeColor('terminal.ansiGreen');
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
    }
  });
}

/**
 * 智能提示提供者
 */
class KBEngineCompletionProvider implements vscode.CompletionItemProvider {
  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.CompletionItem[]> {

    const line = document.lineAt(position.line);
    const lineText = line.text.substring(0, position.character);
    const items: vscode.CompletionItem[] = [];

    // 在 <Type> 标签内提示类型
    if (lineText.match(/<Type>\s*\w*$/)) {
      KBENGINE_TYPES.forEach(type => {
        const item = new vscode.CompletionItem(type.name, vscode.CompletionItemKind.Class);
        item.detail = type.detail;
        item.documentation = new vscode.MarkdownString(type.documentation);
        items.push(item);
      });
      return items;
    }

    // 在 <Flags> 标签内提示标志
    if (lineText.match(/<Flags>\s*\w*$/)) {
      KBENGINE_FLAGS.forEach(flag => {
        const item = new vscode.CompletionItem(flag.name, vscode.CompletionItemKind.Enum);
        item.detail = flag.detail;
        item.documentation = new vscode.MarkdownString(flag.documentation);
        items.push(item);
      });
      return items;
    }

    // 在 <DetailLevel> 标签内提示级别
    if (lineText.match(/<DetailLevel>\s*\w*$/)) {
      DETAIL_LEVELS.forEach(level => {
        const item = new vscode.CompletionItem(level, vscode.CompletionItemKind.Constant);
        items.push(item);
      });
      return items;
    }

    // 提示 XML 标签
    if (lineText.endsWith('<')) {
      const tags = [
        'Properties', 'ClientMethods', 'BaseMethods', 'CellMethods',
        'Type', 'Flags', 'Default', 'Database', 'Identifier', 'DetailLevel', 'Arg'
      ];
      tags.forEach(tag => {
        const item = new vscode.CompletionItem(tag, vscode.CompletionItemKind.Property);
        items.push(item);
      });
      return items;
    }

    // 提示钩子方法（在方法名位置）
    if (lineText.match(/<[A-Za-z]+Methods>[\s\S]*<[a-zA-Z]/)) {
      // 检查是否在定义方法名
      const methodMatch = lineText.match(/<([a-zA-Z]+)>/);
      if (methodMatch) {
        const methodName = methodMatch[1];
        // 如果已经输入了部分钩子名，提示匹配的钩子
        KBENGINE_HOOKS.forEach(hook => {
          if (hook.name.toLowerCase().startsWith(methodName.toLowerCase())) {
            const item = new vscode.CompletionItem(hook.name, vscode.CompletionItemKind.Method);
            item.detail = `${HOOK_CATEGORY_NAMES[hook.category]} - ${hook.description}`;
            item.documentation = new vscode.MarkdownString(
              `**${hook.name}**\n\n${hook.documentation}\n\n调用时机: ${hook.timing}\n\n签名:\n\`\`\`python\n${hook.signature}\n\`\`\``
            );
            items.push(item);
          }
        });
        return items;
      }
    }

    // 检查是否在输入钩子名（以 on 开头）
    if (lineText.match(/<on[a-zA-Z]*$/)) {
      KBENGINE_HOOKS.forEach(hook => {
        const item = new vscode.CompletionItem(hook.name, vscode.CompletionItemKind.Method);
        item.detail = `${HOOK_CATEGORY_NAMES[hook.category]} - ${hook.description}`;
        item.documentation = new vscode.MarkdownString(
          `**${hook.name}**\n\n${hook.documentation}\n\n调用时机: ${hook.timing}`
        );
        items.push(item);
      });
      return items;
    }

    // 检查是否在 Python 脚本中输入热更新相关函数
    if (document.fileName.endsWith('.py') || document.fileName.endsWith('.def')) {
      // 检查 KBEngine. 或 importlib. 开头
      if (lineText.match(/KBEngine\.[a-zA-Z]*$/)) {
        KBENGINE_RELOAD_FUNCTIONS.filter(fn => fn.name.startsWith('KBEngine.')).forEach(fn => {
          const shortName = fn.name.replace('KBEngine.', '');
          const item = new vscode.CompletionItem(shortName, vscode.CompletionItemKind.Function);
          item.detail = fn.detail;
          item.documentation = new vscode.MarkdownString(fn.documentation);
          items.push(item);
        });
        return items;
      }

      // 检查 importlib.reload
      if (lineText.match(/importlib\.[a-zA-Z]*$/)) {
        const fn = KBENGINE_RELOAD_FUNCTIONS.find(f => f.name === 'importlib.reload');
        if (fn) {
          const item = new vscode.CompletionItem('reload', vscode.CompletionItemKind.Function);
          item.detail = fn.detail;
          item.documentation = new vscode.MarkdownString(fn.documentation);
          items.push(item);
        }
        return items;
      }
    }

    return items;
  }
}

/**
 * 悬停文档提供者
 */
class KBEngineHoverProvider implements vscode.HoverProvider {
  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.Hover> {

    const range = document.getWordRangeAtPosition(position, /\w+/);
    if (!range) {
      return null;
    }

    const word = document.getText(range);

    // 查找类型文档
    const type = KBENGINE_TYPES.find(t => t.name === word);
    if (type) {
      const markdown = new vscode.MarkdownString();
      markdown.appendMarkdown(`**${type.name}**\n\n`);
      markdown.appendMarkdown(`${type.detail}\n\n`);
      markdown.appendMarkdown('**说明**:\n');
      markdown.appendMarkdown(type.documentation);
      return new vscode.Hover(markdown);
    }

    // 查找 Flag 文档
    const flag = KBENGINE_FLAGS.find(f => f.name === word);
    if (flag) {
      const markdown = new vscode.MarkdownString();
      markdown.appendMarkdown(`**${flag.name}**\n\n`);
      markdown.appendMarkdown(`${flag.detail}\n\n`);
      markdown.appendMarkdown('**说明**:\n');
      markdown.appendMarkdown(flag.documentation);
      return new vscode.Hover(markdown);
    }

    // 查找钩子文档
    const hook = getHookByName(word);
    if (hook) {
      const markdown = new vscode.MarkdownString();
      markdown.appendMarkdown(`**${hook.name}** - ${HOOK_CATEGORY_NAMES[hook.category]}\n\n`);
      markdown.appendMarkdown(`${hook.description}\n\n`);
      markdown.appendMarkdown('**调用时机**: ' + hook.timing + '\n\n');
      markdown.appendMarkdown('**函数签名**:\n');
      markdown.appendCodeblock(hook.signature, 'python');
      markdown.appendMarkdown('\n**详细说明**:\n');
      markdown.appendMarkdown(hook.documentation);
      if (hook.sourceLocation) {
        markdown.appendMarkdown('\n\n**源码位置**: `' + hook.sourceLocation + '`');
      }
      if (hook.example) {
        markdown.appendMarkdown('\n\n**使用示例**:\n');
        markdown.appendCodeblock(hook.example, 'python');
      }
      return new vscode.Hover(markdown);
    }

    // 查找热更新函数文档
    const reloadFunc = KBENGINE_RELOAD_FUNCTIONS.find(f => f.name.endsWith(word) || word === f.name);
    if (reloadFunc) {
      const markdown = new vscode.MarkdownString();
      markdown.appendMarkdown(`**${reloadFunc.name}**\n\n`);
      markdown.appendMarkdown(`${reloadFunc.detail}\n\n`);
      markdown.appendMarkdown(reloadFunc.documentation);
      return new vscode.Hover(markdown);
    }

    return null;
  }
}

/**
 * 定义跳转提供者
 */
class KBEngineDefinitionProvider implements vscode.DefinitionProvider {
  provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.Location> {

    const range = document.getWordRangeAtPosition(position, /\w+/);
    if (!range) {
      return null;
    }

    const word = document.getText(range);

    // 从 entities.xml 跳转到对应的 .def 文件
    if (document.fileName.endsWith('entities.xml')) {
      const defPath = findEntityDefFile(word);
      if (defPath) {
        return new vscode.Location(vscode.Uri.file(defPath), new vscode.Position(0, 0));
      }
    }

    return null;
  }
}

/**
 * 查找实体定义文件
 */
function findEntityDefFile(entityName: string): string | null {
  if (!vscode.workspace.workspaceFolders) {
    return null;
  }

  const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const possiblePaths = [
    path.join(workspaceRoot, 'scripts/entity_defs', `${entityName}.def`),
    path.join(workspaceRoot, '**/entity_defs', `${entityName}.def`),
    path.join(workspaceRoot, '**', `${entityName}.def`)
  ];

  for (const possiblePath of possiblePaths) {
    if (fs.existsSync(possiblePath)) {
      return possiblePath;
    }
  }

  return null;
}

/**
 * 验证文档
 */
function validateDocument(
  document: vscode.TextDocument,
  diagnostics: vscode.DiagnosticCollection
): void {
  const diagnosticsList: vscode.Diagnostic[] = [];
  const text = document.getText();

  // 检查类型名称
  KBENGINE_TYPES.forEach(type => {
    const regex = new RegExp(`<Type>\\s*(${type.name})\\s*</Type>`, 'g');
    let match;
    while ((match = regex.exec(text)) !== null) {
      // 类型有效，无需检查
    }
  });

  // 检查 Flags 组合
  const baseAndCellRegex = /<Flags>\s*.*\bBASE\b.*\bCELL_\w+\b.*<\/Flags>/g;
  let match;
  while ((match = baseAndCellRegex.exec(text)) !== null) {
    const startPos = document.positionAt(match.index);
    const endPos = document.positionAt(match.index + match[0].length);
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(startPos, endPos),
      'BASE 和 CELL 标志不能同时使用',
      vscode.DiagnosticSeverity.Warning
    );
    diagnosticsList.push(diagnostic);
  }

  diagnostics.set(document.uri, diagnosticsList);
}

/**
 * 实体浏览器提供者
 */
class EntityExplorerProvider implements vscode.TreeDataProvider<EntityTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<EntityTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: EntityTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: EntityTreeItem): Promise<EntityTreeItem[]> {
    if (!vscode.workspace.workspaceFolders) {
      return [];
    }

    if (!element) {
      // 根节点：显示所有实体
      return this.getEntityList();
    }

    return [];
  }

  private async getEntityList(): Promise<EntityTreeItem[]> {
    const entities: EntityTreeItem[] = [];

    if (!vscode.workspace.workspaceFolders) {
      return entities;
    }

    const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const entitiesXmlPath = path.join(workspaceRoot, 'scripts/entities.xml');

    if (!fs.existsSync(entitiesXmlPath)) {
      return entities;
    }

    const content = fs.readFileSync(entitiesXmlPath, 'utf-8');
    const entityMatches = content.matchAll(/<(\w+)\s+([^>]+)>/g);

    for (const match of entityMatches) {
      const entityName = match[1];
      const attributes = match[2];

      const hasCell = /\bhasCell\s*=\s*"true"/i.test(attributes);
      const hasBase = /\bhasBase\s*=\s*"true"/i.test(attributes);
      const hasClient = /\bhasClient\s*=\s*"true"/i.test(attributes);

      const description = [];
      if (hasCell) description.push('Cell');
      if (hasBase) description.push('Base');
      if (hasClient) description.push('Client');

      entities.push(new EntityTreeItem(
        entityName,
        description.join(', '),
        vscode.TreeItemCollapsibleState.Collapsed
      ));
    }

    return entities;
  }
}

/**
 * 实体树项
 */
class EntityTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly description: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(label, collapsibleState);
    this.description = description;
    this.iconPath = new vscode.ThemeIcon('symbol-namespace');
  }
}

/**
 * 服务器控制树项
 */
class ServerTreeItem extends vscode.TreeItem {
  constructor(
    public readonly component: any,
    public readonly status: ServerStatus,
    public readonly pid?: number
  ) {
    super(component.displayName, vscode.TreeItemCollapsibleState.None);

    const statusIcon = getStatusIcon(status);
    this.iconPath = new vscode.ThemeIcon(statusIcon);
    this.contextValue = `server_${component.name}`;

    if (status === ServerStatus.Running) {
      this.description = `PID: ${pid}`;
    } else if (status === ServerStatus.Starting) {
      this.description = '启动中...';
    } else if (status === ServerStatus.Stopping) {
      this.description = '停止中...';
    } else if (status === ServerStatus.Error) {
      this.description = '错误';
    }

    this.tooltip = `${component.displayName}\n${component.description}\n状态: ${status}`;
  }
}

/**
 * 获取状态图标
 */
function getStatusIcon(status: ServerStatus): string {
  switch (status) {
    case ServerStatus.Running:
      return 'circle-filled';
    case ServerStatus.Starting:
      return 'clock';
    case ServerStatus.Stopping:
      return 'loading';
    case ServerStatus.Error:
      return 'error';
    case ServerStatus.Stopped:
    default:
      return 'circle-large-outline';
  }
}

/**
 * 服务器控制提供者
 */
class ServerControlProvider implements vscode.TreeDataProvider<ServerTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<ServerTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private serverManager: KBEngineServerManager) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: ServerTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: ServerTreeItem): Promise<ServerTreeItem[]> {
    if (element) {
      return [];
    }

    const components = this.serverManager.getAllServers();
    const runningServers = this.serverManager.getRunningServers();

    return components.map(component => {
      const runningServer = runningServers.get(component.name);
      const status = runningServer?.status || ServerStatus.Stopped;
      const pid = runningServer?.pid;

      return new ServerTreeItem(component, status, pid);
    });
  }
}

/**
 * Python 文件定义提供者
 * 从生成的 Python 文件跳转回 .def 文件
 */
class PythonDefinitionProvider implements vscode.DefinitionProvider {
  constructor(private entityMappingManager: EntityMappingManager) {}

  provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.Location | vscode.Location[]> {

    const range = document.getWordRangeAtPosition(position, /[\w.]+/);
    if (!range) {
      return null;
    }

    const word = document.getText(range);
    const line = document.lineAt(position.line);
    const lineText = line.text;

    // 获取实体名称（从文件名推断）
    const entityName = path.basename(document.fileName, '.py');

    // 检查是否在访问属性或方法
    // 例如: self.propertyName, self.methodName()
    const propertyMatch = lineText.match(/self\.(\w+)/);
    if (propertyMatch) {
      const symbolName = propertyMatch[1];

      // 尝试作为属性查找
      const mapping = this.entityMappingManager.getMapping(entityName);
      if (mapping) {
        // 检查是否是属性
        if (mapping.properties[symbolName]) {
          const location = mapping.properties[symbolName];
          return new vscode.Location(
            vscode.Uri.file(location.defFile),
            new vscode.Position(location.line - 1, 0)
          );
        }

        // 检查是否是方法
        if (mapping.methods[symbolName]) {
          const location = mapping.methods[symbolName];
          return new vscode.Location(
            vscode.Uri.file(location.defFile),
            new vscode.Position(location.line - 1, 0)
          );
        }
      }
    }

    return null;
  }
}

/**
 * Python 文件智能提示提供者
 * 提供 .def 文件中定义的属性和方法
 */
class PythonCompletionProvider implements vscode.CompletionItemProvider {
  constructor(private entityMappingManager: EntityMappingManager) {}

  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.CompletionItem[]> {

    const line = document.lineAt(position.line);
    const lineText = line.text.substring(0, position.character);

    // 检查是否在输入 self.xxx
    const selfMatch = lineText.match(/self\.(\w*)$/);
    if (!selfMatch) {
      return null;
    }

    // 获取实体名称
    const entityName = path.basename(document.fileName, '.py');
    const mapping = this.entityMappingManager.getMapping(entityName);

    if (!mapping) {
      return null;
    }

    const items: vscode.CompletionItem[] = [];

    // 添加属性提示
    for (const [propName, propInfo] of Object.entries(mapping.properties)) {
      const item = new vscode.CompletionItem(propName, vscode.CompletionItemKind.Property);
      item.detail = 'Entity Property';
      item.documentation = new vscode.MarkdownString(
        `定义于: \`${path.basename(propInfo.defFile)}:${propInfo.line}\`\n\n从 .def 文件自动生成的实体属性。`
      );
      items.push(item);
    }

    // 添加方法提示
    for (const [methodName, methodInfo] of Object.entries(mapping.methods)) {
      const item = new vscode.CompletionItem(methodName, vscode.CompletionItemKind.Method);
      item.detail = 'Entity Method';
      item.documentation = new vscode.MarkdownString(
        `定义于: \`${path.basename(methodInfo.defFile)}:${methodInfo.line}\`\n\n从 .def 文件自动生成的实体方法。`
      );
      items.push(item);
    }

    return items;
  }
}


export function deactivate() {
  console.log('KBEngine Language Extension is now deactivated!');
}
