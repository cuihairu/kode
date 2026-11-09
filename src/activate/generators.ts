// SRC-001 L7:生成器/项目层(KODE-ARCH-002 纯移动)。区域含 Python 生态
// 接线(桩导出/extraPaths 同步)、debug.json 引导与托管目录 watcher、代码
// 生成器与项目向导、客户端 SDK 生成、profile 切换落索引输入。装配顺序由
// 组合根调用点保持;注册面直推 context.subscriptions(销毁所有权不变);
// entityMappingManager/quickActionManager(coreServices 与 views L5 句柄)、
// pythonClassIndex/watchPythonIndex(L2 languageServices 句柄)经 deps
// 注入;isPythonMroJumpEnabled 为纯模块导入直引。区域除 codeGenerator
// (deactivate 收口 dispose)外无后向消费者,仅返回 codeGenerator。

import * as vscode from 'vscode';
import { DEBUG_CONFIG_CHANNEL_NAME, ensureDebugConfig, fileSystemBootstrapDeps } from '../debugConfigBootstrap';
import { GeneratedSourceCodeLensProvider } from '../generatedSourceLenses';
import { KBEngineCodeGenerator } from '../codeGenerator';
import { STUB_SOURCE_MODE_SETTING, exportKbeStubs, fileSystemStubExportDeps, readManagedDirSetting, resolveManagedDirName } from '../pythonStubExport';
import { activateInferPipeline } from '../inferPipeline';
import { bindSdkGenerationToProfile } from '../sdk-gen/sdkGenerationProfile';
import { buildEntityTypeStubLineMap, buildEntityTypeStubPlan, exportEntityTypeStubs } from '../entityTypeStubs';
import { bumpRootConfigGeneration } from '../rootConfigGeneration';
import { createDemoGameProject, createMinimalProject } from '../projectCreate';
import { disableJsoncAssociation, syncJsoncAssociation } from '../jsoncAssociation';
import { exportPythonTypeStubs } from '../pythonTypeStubs';
import { fileSystemScriptRootDeps, syncPythonExtraPaths } from '../pythonExtraPaths';
import { getCustomTypeInfos } from '../definitionWorkspace';
import { getDefinitionWorkspaceLayout, getRegisteredEntities, readWorkspaceTextFile } from '../definitionWorkspace';
import { getExternalScanRoots, resetScanRootCache, resolveAssetsRootForWorkspace, setActiveProfileScanRoot } from '../scanRoots';
import { getIndexScanRoots } from '../scanRoots';
import { importExistingProject } from '../projectImport';
import { isPythonMroJumpEnabled } from '../languageProviders';
import { makeSdkEngineTrace } from '../sdk-gen/sdkGenerationTrace';
import { offerDemoGameScaffoldFromVscode } from '../demoGameScaffoldPrompt';
import { onDidChangeActiveProfile, resolveActiveProfile, selectActiveProfile } from '../activeProfile';
import { readEngineApiMetadata } from '../backend/engineApiMetadata';
import { resolveDemoGameTemplateRoot } from '../demoGameTemplate';
import { runClientSdkGenerateCommand } from '../sdk-gen/clientSdkGenerator';
import { runGeneratorFormWizard } from '../generatorForms';
import type { EntityMappingManager } from '../entityMapping';
import type { QuickActionManager } from '../quickActions';
import type { PythonClassIndex } from '../backend/pythonClassIndex';

export interface GeneratorsDeps {
  context: vscode.ExtensionContext;
  entityMappingManager: EntityMappingManager;
  quickActionManager: QuickActionManager;
  pythonClassIndex: PythonClassIndex;
  pythonDocumentSelector: ReadonlyArray<vscode.DocumentFilter | string>;
  watchPythonIndex: () => void;
}

export interface GeneratorsShared {
  codeGenerator: KBEngineCodeGenerator;
}

export function activateGenerators(deps: GeneratorsDeps): GeneratorsShared {
  const { context, entityMappingManager, quickActionManager, pythonClassIndex, pythonDocumentSelector, watchPythonIndex } = deps;
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
  // debug.json 的 jsonc 关联(用户令 2026-10-27 ②):激活期静默接线一次,
  // 命令面板只留关闭入口(回收托管键 + 翻开关;重新启用=设回 true 重载)
  const jsoncAssociationOffCommand = vscode.commands.registerCommand(
    'kbengine.jsoncAssociation.off',
    () => disableJsoncAssociation(context)
  );
  context.subscriptions.push(jsoncAssociationOffCommand);
  const exportKbeStubsCommand = vscode.commands.registerCommand(
    'kbengine.python.exportStubs',
    async () => {
      await exportKbeStubs();
      await syncPythonExtraPaths(context);
    }
  );
  context.subscriptions.push(exportKbeStubsCommand);
  // types.xml 自定义类型桩(docs/design/def-pyi-stubs.md §6):kbe_types.pyi 分件与
  // KBEngine.pyi 同开关同目录,命令导出后同样链一次同步让新目录即刻生效
  const exportPythonTypeStubsCommand = vscode.commands.registerCommand(
    'kbengine.python.exportTypeStubs',
    async () => {
      await exportPythonTypeStubs();
      await syncPythonExtraPaths(context);
    }
  );
  context.subscriptions.push(exportPythonTypeStubsCommand);
  const generatedEntitySourceLensProviderImpl = new GeneratedSourceCodeLensProvider(
    'entity_types.pyi',
    [],
    buildEntityTypeStubPlan(
      entityMappingManager.getAllMappings(),
      getCustomTypeInfos(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '')
    ).entries,
    null,
    // KR-AUD-78:同 python 侧——渲染期记录的真实行映射
    buildEntityTypeStubLineMap(
      buildEntityTypeStubPlan(
        entityMappingManager.getAllMappings(),
        getCustomTypeInfos(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '')
      ).entries
    )
  );
  const generatedEntitySourceLensProvider = vscode.languages.registerCodeLensProvider(
    pythonDocumentSelector,
    generatedEntitySourceLensProviderImpl
  );
  context.subscriptions.push(generatedEntitySourceLensProvider);
  // KODE-CFG-017:pyrefly 推断管道接线——.kbengine 隔离(搜索/watcher/gitignore)
  // + .kbengine/inferred 副本同步 + 脚本变更 watcher + kbengine.infer.run 命令
  activateInferPipeline(context);
  void (async () => {
    await exportKbeStubs(fileSystemStubExportDeps, { silent: true });
    await exportPythonTypeStubs(fileSystemStubExportDeps, { silent: true });
    await exportEntityTypeStubs(entityMappingManager);
    await syncPythonExtraPaths(context, fileSystemScriptRootDeps, { silent: true });
    await syncJsoncAssociation(context, { silent: true });
  })();
  // 批143(用户单 kode-debug-json.md):`.kbengine/debug.json` 缺失即生成带注释
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
        .filter((root): root is string => root.length > 0),
      managedDirName: resolveManagedDirName(readManagedDirSetting()).name
    }
  );
  // 托管目录自动重建(任务 B,用户令 2026-10-21):.kbengine(kbengine.managedDir
  // 可配)目录被删后不需重载窗口,下一次相关事件即重建全链——KBEngine.pyi /
  // kbe_types.pyi / entity_types.pyi / debug.json 全部内容比对零写或缺失即生成,
  // 重复触发无副作用。watcher 盯托管目录自身与其内部,删除目录也能收到事件。
  const bootstrapOptions = () => ({
    workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map(folder => ({
      name: folder.name,
      fsPath: folder.uri.fsPath
    })),
    scanRoots: (vscode.workspace.workspaceFolders ?? []).slice(0, 1)
      .map(folder => resolveAssetsRootForWorkspace(folder.uri.fsPath))
      .filter((root): root is string => root.length > 0),
    managedDirName: resolveManagedDirName(readManagedDirSetting()).name
  });
  const regenerateManagedDirAssets = (): void => {
    void exportKbeStubs(fileSystemStubExportDeps, { silent: true });
    void exportPythonTypeStubs(fileSystemStubExportDeps, { silent: true });
    void exportEntityTypeStubs(entityMappingManager);
    ensureDebugConfig(
      { ...fileSystemBootstrapDeps, log: (line: string): void => debugConfigChannel.appendLine(line) },
      bootstrapOptions()
    );
  };
  const createManagedDirWatcher = (): vscode.FileSystemWatcher => {
    const name = resolveManagedDirName(readManagedDirSetting()).name;
    // `**/<dir>`(目录本体被删)+ `**/<dir>/**`(内部文件增删改)两个 pattern 都盯
    const watchers = [`**/${name}`, `**/${name}/**`].map(pattern =>
      vscode.workspace.createFileSystemWatcher(pattern)
    );
    for (const watcher of watchers) {
      watcher.onDidChange(regenerateManagedDirAssets);
      watcher.onDidCreate(regenerateManagedDirAssets);
      watcher.onDidDelete(regenerateManagedDirAssets);
      context.subscriptions.push(watcher);
    }
    return { dispose: (): void => watchers.forEach(watcher => watcher.dispose()) } as vscode.FileSystemWatcher;
  };
  let managedDirWatcher = createManagedDirWatcher();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(event => {
      if (!event.affectsConfiguration('kbengine.managedDir')) {
        return;
      }
      managedDirWatcher.dispose();
      managedDirWatcher = createManagedDirWatcher();
      regenerateManagedDirAssets();
    })
  );
  // 存根内容面开关变更即时重导(用户令 2026-10-21:配置开关变更即时生效):
  // 关掉引擎 typings 全量/实体方法面后,下次激活前先把已生成的 .pyi 收回
  // 到关掉后的内容(总闸 kbengine.python.stubExport 关时导出函数自门,零写)
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(event => {
      if (
        event.affectsConfiguration('kbengine.python.stubEngineTypings') ||
        event.affectsConfiguration('kbengine.python.entityStubMethods') ||
        // IDE-STUB-001:档位切换即时重导——real-source 切回 generated 后,
        // 已拼接的真实引擎代码在内容比对刷新下被收回精选目录内容
        event.affectsConfiguration(`kbengine.${STUB_SOURCE_MODE_SETTING}`)
      ) {
        regenerateManagedDirAssets();
      }
    })
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

  // GEN-DEF-2 新建实体向导:资源管理器 entity_defs 目录右键或命令面板
  // 「New KBEngine Entity」,3 步生成可直接加载的实体(def+按段 py+登记)
  const newEntityWizardCommand = vscode.commands.registerCommand(
    'kbengine.entity.new',
    (folderUri?: vscode.Uri) => codeGenerator.runNewEntityWizard(folderUri?.fsPath)
  );
  context.subscriptions.push(newEntityWizardCommand);

  const showTemplatesCommand = vscode.commands.registerCommand(
    'kbengine.generator.templates',
    () => codeGenerator.showTemplates()
  );
  context.subscriptions.push(showTemplatesCommand);

  // 定义形态生成(盘点 G7):代理/空间/组件/固定字典四种形态的向导,实体向导之外
  // 的定义面(此前只能手写)。已代决按「先出骨架 + 引擎装载口径附带改写」落地
  const showGeneratorFormWizardCommand = vscode.commands.registerCommand(
    'kbengine.generator.formWizard',
    () => runGeneratorFormWizard({ workspaceState: context.workspaceState })
  );
  context.subscriptions.push(showGeneratorFormWizardCommand);

  // 现有 KBEngine 项目导入(IDE-PRJ-003):选资产根→按约定链识别
  // entities/defs/scripts/engine 四面→预览确认→建立项目 profile(稳定身份存储)
  const importProjectCommand = vscode.commands.registerCommand(
    'kbengine.project.import',
    () => importExistingProject(context)
  );
  context.subscriptions.push(importProjectCommand);

  // 最小项目创建(IDE-PRJ-008):模板清单落盘建空项目,冲突拒绝/预览确认/
  // 失败回收全程走生成器保护,成功后与导入同链建档
  const createProjectCommand = vscode.commands.registerCommand(
    'kbengine.project.create',
    () => createMinimalProject(context)
  );
  context.subscriptions.push(createProjectCommand);

  // demo 游戏项目创建(DEMO-GAME-006):templates/demo-game(夹具游戏子集,
  // Training/Elite 导航测试资产裁掉)磁盘装载,与最小项目同一保护面;
  // 空工程提示面(demoGameScaffoldPrompt)与命令面板都落在这条命令上
  const createDemoGameProjectCommand = vscode.commands.registerCommand(
    'kbengine.project.createDemoGame',
    () =>
      createDemoGameProject(context, {
        templateRoot: resolveDemoGameTemplateRoot(context.extensionPath)
      })
  );
  context.subscriptions.push(createDemoGameProjectCommand);

  // 空工程主动提示(DEMO-GAME-006):打开空目录时提议从 demo 游戏模板
  // 创建第一个项目;条件从严(单文件夹+无非点入口),失败静默不扰动激活。
  // 需 onStartupFinished 激活(workspaceContains 表达不了"空")
  offerDemoGameScaffoldFromVscode();

  // 活动 profile 选择(IDE-PRJ-010):稳定 ID 持久化,真实切换恰发一次事件
  const selectActiveProfileCommand = vscode.commands.registerCommand(
    'kbengine.project.selectActive',
    () => selectActiveProfile(context)
  );
  context.subscriptions.push(selectActiveProfileCommand);

  // 语言索引响应 profile 切换(IDE-PRJ-011):活动 profile 的资产根成为索引
  // 输入(优先于 assetsRoot 设置/自动发现,见 scanRoots);切换时旧外部根先
  // 定向摘除(SNP-009 口径),generation 前进使旧输入的在途扫描批次经代闸
  // 不再写入当前快照(entityMapping.performScanEntityMappings),Python 索引
  // 面整组重建
  const applyActiveProfileToIndexInput = (): void => {
    const profile = resolveActiveProfile(context.workspaceState);
    for (const oldRoot of getExternalScanRoots()) {
      entityMappingManager.removeRoot(oldRoot);
    }
    bumpRootConfigGeneration('profile-switch');
    setActiveProfileScanRoot(profile && profile.assetsRoot ? profile.assetsRoot : null);
    resetScanRootCache();
    pythonClassIndex.invalidate();
    watchPythonIndex();
    entityMappingManager.refreshExternalRootWatchers();
    if (isPythonMroJumpEnabled()) { pythonClassIndex.scheduleBackgroundScan(); }
  };
  context.subscriptions.push(onDidChangeActiveProfile(() => { applyActiveProfileToIndexInput(); }));
  // 激活期:持久化的选择先落到索引输入(此后首扫按选定根起步;此刻零索引
  // 面,不需要切换路径的摘除/失效序列,也不 bump)
  const startupProfile = resolveActiveProfile(context.workspaceState);
  setActiveProfileScanRoot(startupProfile && startupProfile.assetsRoot ? startupProfile.assetsRoot : null);

  // 客户端实体 SDK 生成(盘点 G4):按 entities.xml 登记实体生成客户端语言骨架,
  // 语言清单在命令内选(已代决首批 TS + C#)。IDE-SDK-003 生成绑定活动
  // profile:注册序与类型数据取所选 profile 资产根(getRegisteredEntities/
  // getCustomTypeInfos 同一解析面),其他扫描根的同名实体经绑定模块拒收
  // 点名(不静默覆盖);无活动 profile 回落工作区首根(旧口径)。
  const clientSdkGenerateCommand = vscode.commands.registerCommand(
    'kbengine.clientSdk.generate',
    async () => {
      const profile = resolveActiveProfile(context.workspaceState);
      const profileRoot = profile?.assetsRoot || undefined;
      // IDE-SDK-004 引擎溯源:探测面=readEngineApiMetadata(版本宏+git),
      // 引擎根有 profile 记录时优先用,探测不到模块内写 unknown。
      const generationRoot = profileRoot
        ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
        ?? '';
      const engineMetadata = await readEngineApiMetadata(
        generationRoot,
        profile ? { engineRoot: profile.engineRoot || undefined } : {}
      );
      const engineTrace = makeSdkEngineTrace(engineMetadata);
      if (!profileRoot) {
        return runClientSdkGenerateCommand(undefined, undefined, engineTrace);
      }
      const binding = bindSdkGenerationToProfile(profileRoot, {
        listRegistrations: root => getRegisteredEntities(root),
        readTypesXml: root => {
          const layout = getDefinitionWorkspaceLayout(root);
          return layout.typesXmlPath ? readWorkspaceTextFile(layout.typesXmlPath) : null;
        },
        listOtherRootEntityNames: root => {
          const names = new Set<string>();
          for (const otherRoot of getIndexScanRoots()) {
            if (otherRoot === root) {
              continue;
            }
            for (const info of getRegisteredEntities(otherRoot)) {
              names.add(info.name);
            }
          }
          return [...names];
        }
      });
      return runClientSdkGenerateCommand(profileRoot, binding.skippedSameNameFromOtherRoots, engineTrace);
    }
  );
  context.subscriptions.push(clientSdkGenerateCommand);
  return { codeGenerator };
}
