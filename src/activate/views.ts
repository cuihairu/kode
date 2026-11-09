// SRC-001 L5 抽象层(KODE-ARCH 纯移动,零行为变更):组合根的视图激活器组。
// 职责(分析文档 docs/design/src-001-extension-abstraction-layers.md L5):
// 六个视图域各自成激活器,由组合根在原位调用保持装配顺序与 watcher 创建
// 次序契约——①实体浏览器树+open/refresh 命令;②HTTP 快捷请求服务与命令;
// ③最终配置合成(内容 provider/打开/手动命令);④文件历史/范围历史树视图、
// 版本虚拟文档 provider 与六命令(查询门/开关门随域);⑤最终配置常驻树 +
// kbengine*.xml 联动 watcher;⑥快捷动作树视图与四命令。
// 形态:跨域消费面经返回句柄(Q1→Q2 的 httpRequestService/quickActionManagerRef、
// FC1→FC2 的 finalConfigProvider、根部尾令的 openFinalConfig、热更/监控/
// 临时编辑的 quickActionManager/httpRequestChannel);hotReloadVersionRefresh
// 前向引用 holder 经 deps 传入(调用位在其声明之后),区域原文零改动。

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { DefinitionSymbolIdentity, EntityMethodSection } from '../entityMapping';
import { EntityExplorerProvider } from '../explorerProviders';
import { parseHttpRequestEntries } from '../backend/httpRequests';
import { HttpRequestService } from '../backend/httpRequestService';
import { QuickActionManager } from '../quickActions';
import { QuickActionTreeProvider } from '../quickActionTree';
import { setupTypeStubRegeneration } from '../pythonTypeStubs';
import {
  findEntityDefinitionFile,
} from '../definitionWorkspace';
import {
  GIT_HISTORY_CONTEXT_KEY,
  GIT_HISTORY_ENABLED_SETTING,
  GIT_HISTORY_SHOW_COMMAND,
  GIT_HISTORY_SHOW_RANGE_COMMAND,
  readGitHistoryEnabled,
  runGitHistoryWhenEnabled,
  rangeHistoryDirtyGuard,
} from '../backend/gitHistory';
import {
  GitHistoryTreeProvider,
  defaultGitHistoryDeps,
  historyViewTitle,
  type GitHistoryItem,
} from '../gitHistoryTree';
import {
  GIT_HISTORY_VERSION_SCHEME,
  GitHistoryVersionContentProvider,
  defaultVersionQueryDeps,
  makeVersionUri,
  openVersionContent,
  openVersionDiff,
} from '../gitHistoryDiff';
import {
  GitRangeHistoryTreeProvider,
  defaultRangeHistoryDeps,
  rangeHistoryViewTitle,
  type RangeHistoryItem,
} from '../gitRangeHistoryTree';
import { editorSelectionToRange } from '../backend/gitSelectionMap';
import { sharedGitQueryGate } from '../backend/gitQueryGate';
import {
  KBE_CONFIG_SCHEME,
  KBE_CONFIG_VIRTUAL_PATH,
  FinalConfigContentProvider,
  FinalConfigTreeProvider,
  buildFinalServerConfig,
  resetDatabaseInterfaceConfigCache,
} from '../serverConfigMerge';
import { ensureConfigResolved } from '../serverConfigResolve';
import type { EntityMappingManager } from '../entityMapping';

export interface EntityExplorerViewsDeps {
  context: vscode.ExtensionContext;
  entityMappingManager: EntityMappingManager;
}

export interface ViewsDeps {
  context: vscode.ExtensionContext;
}

export interface HttpRequestViewsDeps {
  context: vscode.ExtensionContext;
}

/** Q1 共享句柄:Q2 装配与临时编辑热更日志经此消费 */
export interface HttpRequestViewsShared {
  httpRequestService: HttpRequestService;
  quickActionManagerRef: { current?: QuickActionManager };
  httpRequestChannel: vscode.OutputChannel;
}

export interface FinalConfigViewsDeps {
  context: vscode.ExtensionContext;
}

/** FC1 共享句柄:激活尾默认开启令/常驻树/联动 watcher 经此消费 */
export interface FinalConfigViewsShared {
  openFinalConfig: (auto: boolean) => Promise<void>;
  finalConfigProvider: FinalConfigContentProvider;
}

export interface FinalConfigTreeViewsDeps {
  context: vscode.ExtensionContext;
  finalConfigProvider: FinalConfigContentProvider;
}

export interface QuickActionTreeViewsDeps {
  context: vscode.ExtensionContext;
  httpRequestService: HttpRequestService;
  quickActionManagerRef: { current?: QuickActionManager };
  hotReloadVersionRefresh: { refresh?: (forceRender?: boolean) => void };
}

export interface QuickActionTreeViewsShared {
  quickActionManager: QuickActionManager;
}

export function activateEntityExplorerViews(deps: EntityExplorerViewsDeps): void {
  const { context, entityMappingManager } = deps;

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

}


export function activateHttpRequestViews(deps: HttpRequestViewsDeps): HttpRequestViewsShared {
  const { context } = deps;

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

  return {
    httpRequestService,
    quickActionManagerRef,
    httpRequestChannel
  };
}


export function activateFinalConfigViews(deps: FinalConfigViewsDeps): FinalConfigViewsShared {
  const { context } = deps;

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
  // KODE-CFG-009:合成读值经 core 解析(`$/kode/config/resolve`)。激活期门
  // 可能尚未就绪(核心服务冷启动/单测替身在 activate 后才装),首取不可得
  // 时 auto 路径做一次有界延迟重试——期间接线完成即出视图,仍不可得维持
  // 静默跳过;手动命令不做重试(用户在场,失败即明示)。
  const FINAL_CONFIG_AUTO_RETRY_MS = 300;
  const openFinalConfig = async (auto: boolean): Promise<void> => {
    await ensureConfigResolved().catch(() => {});
    if (auto && buildFinalServerConfig().text.length === 0) {
      await new Promise(resolve => setTimeout(resolve, FINAL_CONFIG_AUTO_RETRY_MS));
      await ensureConfigResolved().catch(() => {});
    }
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

  return {
    openFinalConfig,
    finalConfigProvider
  };
}


export function activateGitHistoryViews(deps: ViewsDeps): void {
  const { context } = deps;

  // IDE-GIT-001:文件历史功能开关(默认开启)。入口可见性由上下文键驱动,
  // 激活时置一次,开关变更即时刷新;查询(IDE-GIT-002..005)后续接入,
  // 本里程碑命令体绝不触达 Git(用户约束 2026-10-29:按需查询,零预取)。
  const refreshGitHistoryContext = () => {
    const enabled = readGitHistoryEnabled(
      vscode.workspace.getConfiguration('kbengine')
    );
    void vscode.commands.executeCommand('setContext', GIT_HISTORY_CONTEXT_KEY, enabled);
    // IDE-GIT-011:禁用配置即取消在途/排队历史查询并清缓存(门保持可用,重启用恢复)。
    if (!enabled) {
      sharedGitQueryGate.cancelAll();
    }
  };
  refreshGitHistoryContext();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration(GIT_HISTORY_ENABLED_SETTING)) {
        refreshGitHistoryContext();
      }
    })
  );
  // IDE-GIT-005:文件历史侧边栏视图(kbengine.gitHistory)与命令体接入。
  // 视图挂在既有 kbengine-explorer 容器;命令只在用户入口触发查询(按需,
  // 空闲零 Git 调用)。视图标题随状态刷新(文件名 @ 基准提交)。
  const gitHistoryProvider = new GitHistoryTreeProvider(defaultGitHistoryDeps());
  // IDE-GIT-011:卸载/关闭视图取消该视图全部在途历史查询(不残留子进程)。
  context.subscriptions.push({ dispose: () => gitHistoryProvider.dispose() });
  if (typeof vscode.window.createTreeView === 'function') {
    // 真宿主:TreeView 可动态设标题(文件名 @ 基准提交)并可聚焦
    const gitHistoryTree = vscode.window.createTreeView('kbengine.gitHistory', {
      treeDataProvider: gitHistoryProvider,
      showCollapseAll: false,
    });
    context.subscriptions.push(gitHistoryTree);
    // IDE-GIT-011:视图隐藏即取消该视图在途查询(不残留 Git 子进程;重开可用)。
    gitHistoryTree.onDidChangeVisibility?.(event => {
      if (!event.visible) gitHistoryProvider.cancelInFlight();
    });
    gitHistoryTree.title = historyViewTitle(gitHistoryProvider.getState());
    context.subscriptions.push(
      gitHistoryProvider.onDidChangeTreeData(() => {
        gitHistoryTree.title = historyViewTitle(gitHistoryProvider.getState());
      })
    );
  } else {
    // 受限宿主(单元测试 fake-vscode 无 createTreeView):退化为仅注册数据
    // 提供者——视图仍渲染,标题保持 package.json 静态名,不影响激活。
    context.subscriptions.push(
      vscode.window.registerTreeDataProvider('kbengine.gitHistory', gitHistoryProvider)
    );
  }

  const resolveHistoryTarget = (uri?: vscode.Uri): vscode.Uri | null => {
    if (uri instanceof vscode.Uri) return uri;
    const active = vscode.window.activeTextEditor?.document.uri;
    return active ?? null;
  };

  const showFileHistoryCommand = vscode.commands.registerCommand(
    GIT_HISTORY_SHOW_COMMAND,
    (uri?: vscode.Uri) => runGitHistoryWhenEnabled(
      readGitHistoryEnabled(vscode.workspace.getConfiguration('kbengine')),
      async () => {
        const target = resolveHistoryTarget(uri);
        if (!target) {
          void vscode.window.showInformationMessage('无活动文件可查看历史。');
          return;
        }
        await gitHistoryProvider.showHistory(target.fsPath, true);
        void vscode.commands.executeCommand('kbengine.gitHistory.focus');
      }
    )
  );
  // IDE-GIT-010:选中范围历史侧边栏视图(kbengine.gitRangeHistory)与命令体接入。
  // 只在用户经编辑器选区右键/命令面板发起时运行;切换编辑器不重查不错套。
  const gitRangeHistoryProvider = new GitRangeHistoryTreeProvider(defaultRangeHistoryDeps());
  // IDE-GIT-011:卸载/关闭视图取消该视图全部在途历史查询(不残留子进程)。
  context.subscriptions.push({ dispose: () => gitRangeHistoryProvider.dispose() });
  if (typeof vscode.window.createTreeView === 'function') {
    const gitRangeHistoryTree = vscode.window.createTreeView('kbengine.gitRangeHistory', {
      treeDataProvider: gitRangeHistoryProvider,
      showCollapseAll: false,
    });
    context.subscriptions.push(gitRangeHistoryTree);
    // IDE-GIT-011:视图隐藏即取消该视图在途查询(不残留 Git 子进程;重开可用)。
    gitRangeHistoryTree.onDidChangeVisibility?.(event => {
      if (!event.visible) gitRangeHistoryProvider.cancelInFlight();
    });
    gitRangeHistoryTree.title = rangeHistoryViewTitle(gitRangeHistoryProvider.getState());
    context.subscriptions.push(
      gitRangeHistoryProvider.onDidChangeTreeData(() => {
        gitRangeHistoryTree.title = rangeHistoryViewTitle(gitRangeHistoryProvider.getState());
      })
    );
  } else {
    context.subscriptions.push(
      vscode.window.registerTreeDataProvider('kbengine.gitRangeHistory', gitRangeHistoryProvider)
    );
  }
  const showRangeHistoryCommand = vscode.commands.registerCommand(
    GIT_HISTORY_SHOW_RANGE_COMMAND,
    () => runGitHistoryWhenEnabled(
      readGitHistoryEnabled(vscode.workspace.getConfiguration('kbengine')),
      async () => {
        // 选中范围历史:取活动编辑器选区(0 基→1 基),映射到 HEAD 行段后查询时间线。
        const editor = vscode.window.activeTextEditor;
        const sel = editor?.selection;
        if (!editor || !sel || sel.isEmpty) {
          // 无选区:不查询,给出选择代码提示(右键入口已由 editorHasSelection 隐藏)。
          gitRangeHistoryProvider.showNoSelection();
          void vscode.commands.executeCommand('kbengine.gitRangeHistory.focus');
          return;
        }
        // 未保存内容不参与映射(审核发现):磁盘差异与编辑器缓冲可能不一致,
        // 映射到的 HEAD 行段是错的。如实拒绝并提示保存后重试。
        const dirtyReason = rangeHistoryDirtyGuard(editor.document.isDirty);
        if (dirtyReason !== null) {
          gitRangeHistoryProvider.showUnavailable(dirtyReason);
          void vscode.commands.executeCommand('kbengine.gitRangeHistory.focus');
          return;
        }
        const range = editorSelectionToRange(sel.start.line, sel.end.line);
        await gitRangeHistoryProvider.showSelectionHistory(
          editor.document.uri.fsPath,
          range,
          readGitHistoryEnabled(vscode.workspace.getConfiguration('kbengine'))
        );
        void vscode.commands.executeCommand('kbengine.gitRangeHistory.focus');
      }
    )
  );
  const gitHistoryNextPageCommand = vscode.commands.registerCommand(
    'kbengine.git.historyNextPage',
    () => {
      void gitHistoryProvider.loadNextPage();
    }
  );
  // IDE-GIT-006:虚拟文档内容提供者(只读,按仓库/提交/路径三键隔离取版本内容)。
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      GIT_HISTORY_VERSION_SCHEME,
      new GitHistoryVersionContentProvider(defaultVersionQueryDeps())
    )
  );
  // 点击提交记录:主编辑区打开该版本 vs 父版本只读 diff(参数=hash/文件/仓库)
  const gitOpenVersionDiffCommand = vscode.commands.registerCommand(
    'kbengine.git.openVersionDiff',
    (commit: string, filePath: string, repoRoot: string, parentFilePath?: string) => runGitHistoryWhenEnabled(
      readGitHistoryEnabled(vscode.workspace.getConfiguration('kbengine')),
      async () => {
        if (typeof commit !== 'string' || typeof filePath !== 'string' || typeof repoRoot !== 'string') {
          void vscode.window.showInformationMessage('打开版本差异:参数不完整(缺少提交/文件/仓库)。');
          return;
        }
        await openVersionDiff(filePath, repoRoot, commit, defaultVersionQueryDeps(), parentFilePath);
      }
    )
  );
  // 提交行右键:只读打开该版本内容(虚拟文档,不覆盖工作区文件)
  const gitOpenVersionContentCommand = vscode.commands.registerCommand(
    'kbengine.git.openVersionContent',
    (item: GitHistoryItem) => runGitHistoryWhenEnabled(
      readGitHistoryEnabled(vscode.workspace.getConfiguration('kbengine')),
      async () => {
        if (!item || item.kind !== 'commit') {
          void vscode.window.showInformationMessage('打开版本内容:上下文不是提交记录。');
          return;
        }
        await openVersionContent(item.filePath, item.repoRoot, item.entry.hash);
      }
    )
  );
  // IDE-GIT-010:点击范围历史条目——打开该版本 vs 父版本只读 diff,并在该版本
  // 内容中定位历史行段(虚拟文档只读不落盘;范围由 -L 追踪到的该版本位置)。
  const gitOpenRangeHistoryDiffCommand = vscode.commands.registerCommand(
    'kbengine.git.openRangeHistoryDiff',
    (item: RangeHistoryItem, filePath: string, repoRoot: string, parentFilePath: string) =>
      runGitHistoryWhenEnabled(
        readGitHistoryEnabled(vscode.workspace.getConfiguration('kbengine')),
        async () => {
          if (!item || item.kind !== 'entry') {
            void vscode.window.showInformationMessage('打开版本差异:上下文不是修改记录。');
            return;
          }
          await openVersionDiff(
            filePath,
            repoRoot,
            item.entry.hash,
            defaultVersionQueryDeps(),
            parentFilePath
          );
          const uri = makeVersionUri(repoRoot, item.entry.hash, filePath);
          const doc = await vscode.workspace.openTextDocument(uri);
          await vscode.window.showTextDocument(doc, {
            preview: false,
            selection: new vscode.Range(
              item.entry.rangeStart - 1,
              0,
              item.entry.rangeEnd - 1,
              0
            ),
          });
        }
      )
  );
  context.subscriptions.push(
    showFileHistoryCommand,
    showRangeHistoryCommand,
    gitHistoryNextPageCommand,
    gitOpenVersionDiffCommand,
    gitOpenVersionContentCommand,
    gitOpenRangeHistoryDiffCommand
  );

}


export function activateFinalConfigTreeViews(deps: FinalConfigTreeViewsDeps): void {
  const { context, finalConfigProvider } = deps;

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
    // kbengine*.xml 增删改同时影响数据库连接读值(批131):失效消费态、
    // 重取 core 解析(`$/kode/config/resolve`,KODE-CFG-009)再联动
    finalConfigWatcher.onDidChange(() => {
      resetDatabaseInterfaceConfigCache();
      void ensureConfigResolved().then(() => finalConfigProvider.refresh()).catch(() => {});
    });
    finalConfigWatcher.onDidCreate(() => {
      resetDatabaseInterfaceConfigCache();
      void ensureConfigResolved().then(() => finalConfigProvider.refresh()).catch(() => {});
    });
    finalConfigWatcher.onDidDelete(() => {
      resetDatabaseInterfaceConfigCache();
      void ensureConfigResolved().then(() => finalConfigProvider.refresh()).catch(() => {});
    });
    context.subscriptions.push(finalConfigWatcher);
  }

}


export function activateQuickActionTreeViews(deps: QuickActionTreeViewsDeps): QuickActionTreeViewsShared {
  const { context, httpRequestService, quickActionManagerRef, hotReloadVersionRefresh } = deps;

  // 快速执行动作(批126):动作清单由 .kbengine/debug.json 的 quickActions 驱动,
  // 独立树视图逐行执行;Servers 与编辑器标题栏保留清单入口。
  // 首装扫一层 .bat/.ps1 的提示在激活末跑一次(不 await,不挡激活)。
  // 批136:保留 runDefault 命令,供命令面板一键跑上次执行的动作。
  const quickActionManager = new QuickActionManager(context, {
    getSettingHttpEntries: () => parseHttpRequestEntries(vscode.workspace.getConfiguration('kbengine').get('httpRequests')),
    // AUD-054(R2-F27):entry/execute/onHttpResponse 三参透传——@http:debug/
    // settings 入口的响应观察器直达 httpRequestService,按真实 HTTP 事实落账
    runHttpEntry: (entry, execute, onHttpResponse) => httpRequestService.runEntry(entry, execute, onHttpResponse)
  });
  quickActionManagerRef.current = quickActionManager;
  const quickActionTreeProvider = new QuickActionTreeProvider({
    getActions: () => quickActionManager.getTreeData()
  });
  context.subscriptions.push(vscode.window.registerTreeDataProvider('kbengine.quickActions', quickActionTreeProvider));
  // HOT-VER:手动跑一次动作(右键/命令面板)后重采版本并重画徽标——监视开关
  // 关着也一样:版本簿独立于 watcher,手动触发路径与 watcher 同口径同台账。
  const runQuickActionByNameCommand = vscode.commands.registerCommand(
    'kbengine.quickActions.runByName',
    (name: string) =>
      Promise.resolve(quickActionManager.runByName(name)).finally(() => hotReloadVersionRefresh.refresh?.(true))
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
    () => Promise.resolve(quickActionManager.runDefault()).finally(() => hotReloadVersionRefresh.refresh?.(true))
  );
  context.subscriptions.push(runDefaultQuickActionCommand);

  return {
    quickActionManager
  };
}
