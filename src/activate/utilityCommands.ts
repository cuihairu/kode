// SRC-001 L10:工具命令层(KODE-ARCH-002 纯移动)。区域含 .def 静态分析
// 建议、跨文件语义医生、符号引用图、片段生成、发现报告、扩展身份、双激活
// 警告、复现摘要、Python 服务状态、profile 健康检查、解释器状态栏与选择、
// ruff lint/安装(IDE-RUST-005 A 案 shell out)、发现报告提示等 10+ 独立命令。
// 装配顺序由组合根调用点保持;注册面直推 context.subscriptions(销毁所有权
// 不变);entityMappingManager(coreServices L1)/serverManager(serverControls
// L4)/indexScheduler(coreServices L1)经 deps 注入;区域无后向消费者,
// 不返回共享句柄。

import * as vscode from 'vscode';
import { CUSTOM_SNIPPETS_RELATIVE_PATH, mergeSnippetEntry, selectionToSnippetBody } from '../snippetGenerator';
import { DiscoveryKey, DiscoveryLayoutFacts, DiscoveryPromptDeps } from '../workspaceDiscovery';
import { MergeSnippetResult } from '../snippetGenerator';
import { RUFF_MAX_FILES, runInstallRuffCommand, runRuffLintCommand, RuffDiag } from '../ruffLint';
import { buildDefReferenceGraphFromFile, buildProjectDoctorReport, formatDefReferenceGraphPreview, formatProjectDoctorReport } from '../defReferenceGraph';
import { buildDiscoveryReport, renderDiscoveryReport, runWorkspaceDiscovery } from '../workspaceDiscovery';
import { classifyPythonService, collectPythonServiceFacts, renderPythonServiceMessage } from '../pythonLanguageServiceStatus';
import { createVenvFlow, interpreterStatusBarText, probePythonVersion, runVenvModuleProcess, selectInterpreter } from '../venvInterpreterPicker';
import { detectDualActivation, formatDualActivationWarning } from '../dualActivationConflict';
import { execFile } from 'child_process';
import { findFilesAcrossRoots } from '../scanRoots';
import { getActiveOperationCounts } from '../languageServiceMetrics';
import { getAnnotationBuildWorkload, getPendingDocumentUpdateCount, getReturnAnnotationCacheGauge } from '../pythonReturnTypeInference';
import { getDatabaseSchemaCacheGauge, getPendingTypeStorageColdBuildCount } from '../databaseSchema';
import { getDefinitionWorkspaceLayout } from '../definitionWorkspace';
import { getDiagnosticScheduler } from '../diagnosticScheduler';
import { getIndexScanRoots } from '../scanRoots';
import { getParsedDocumentCacheGauge } from '../defParser';
import { getPythonParserWorkerGauge } from '../pythonParserWorkerHost';
import { hostLabel, renderExtensionIdentityReport, sideLabel } from '../extensionIdentity';
import { joinWorkspacePath } from '../workspacePath';
import { locateInterpreterOnPath, resolveInterpreterWith, resolveProfileInterpreter } from '../profileInterpreter';
import { normalizeVenvDirectoryNames } from '../quickActionConfig';
import { readBuildCommit } from '../buildCommit';
import { renderReproductionSummary } from '../reproductionSummary';
import { resolveActiveProfile } from '../activeProfile';
import { resolveDatabaseInterfaceConfig } from '../serverConfigMerge';
import { scanVenvs, verifyVenvDirectory } from '../venvDiscovery';
import { showProfileHealthSummary } from '../profileHealth';
import { wireDefAnalysis } from '../defAnalysisWiring';
import { wireTrapLintDiagnostics } from '../trapDiagnosticsWiring';
import * as fs from 'fs';
import * as path from 'path';
import type { EntityMappingManager } from '../entityMapping';
import type { KBEngineServerManager } from '../serverManager';
import type { IndexScheduler } from '../indexScheduler';

export interface UtilityCommandsDeps {
  context: vscode.ExtensionContext;
  entityMappingManager: EntityMappingManager;
  serverManager: KBEngineServerManager;
  indexScheduler: IndexScheduler;
}

export function activateUtilityCommands(deps: UtilityCommandsDeps): void {
  const { context, entityMappingManager, serverManager, indexScheduler } = deps;
  // .def 静态分析建议(性能分析):扫描工作区全部 .def,报告写入输出面板
  // 并以诊断形式落到问题列表(装配本体在 ./defAnalysisWiring,KODE-ARCH-002 纯移动)
  const defAnalysis = wireDefAnalysis();
  context.subscriptions.push(defAnalysis.command);

  // Cross-file semantic doctor: reuses the same rename parser and engine
  // alignment as F2 so diagnostics and refactor decisions cannot diverge.
  const projectDoctorChannel = vscode.window.createOutputChannel('KBEngine Project Doctor');
  const projectDoctorCommand = vscode.commands.registerCommand(
    'kbengine.project.doctor',
    async () => {
      const targetUri = vscode.window.activeTextEditor?.document.uri;
      const candidateUri = targetUri?.fsPath.endsWith('.def')
        ? targetUri
        : (await findFilesAcrossRoots('**/*.def'))[0];
      if (!candidateUri) {
        vscode.window.showInformationMessage('未找到 .def 文件,无法运行 Project Doctor');
        return;
      }

      const graph = buildDefReferenceGraphFromFile(candidateUri.fsPath);
      if (!graph) {
        vscode.window.showWarningMessage('未找到 entity_defs 定义根,Project Doctor 仅支持标准定义布局');
        return;
      }

      const report = buildProjectDoctorReport(graph);
      projectDoctorChannel.clear();
      projectDoctorChannel.appendLine(formatProjectDoctorReport(report));
      projectDoctorChannel.show(true);
      if (report.errors.length > 0) {
        vscode.window.showWarningMessage(`Project Doctor 发现 ${report.errors.length} 项错误,详见输出面板`);
      } else if (report.warnings.length > 0) {
        vscode.window.showInformationMessage(`Project Doctor 完成:${report.warnings.length} 项警告`);
      } else {
        vscode.window.showInformationMessage('Project Doctor 完成:跨文件语义无错误');
      }
    }
  );
  context.subscriptions.push(projectDoctorCommand, projectDoctorChannel);

  const symbolReferencesChannel = vscode.window.createOutputChannel('KBEngine Symbol References');
  const symbolReferencesCommand = vscode.commands.registerCommand(
    'kbengine.symbolReferences.show',
    async () => {
      const targetUri = vscode.window.activeTextEditor?.document.uri;
      const candidateUri = targetUri?.fsPath.endsWith('.def')
        ? targetUri
        : (await findFilesAcrossRoots('**/*.def'))[0];
      if (!candidateUri) {
        vscode.window.showInformationMessage('未找到 .def 文件,无法生成符号引用图');
        return;
      }

      const graph = buildDefReferenceGraphFromFile(candidateUri.fsPath);
      if (!graph) {
        vscode.window.showWarningMessage('未找到 entity_defs 定义根,符号引用图仅支持标准定义布局');
        return;
      }

      const preview = formatDefReferenceGraphPreview(graph);
      symbolReferencesChannel.clear();
      symbolReferencesChannel.appendLine('Mermaid');
      symbolReferencesChannel.appendLine(preview.mermaid);
      symbolReferencesChannel.appendLine('\nText');
      symbolReferencesChannel.appendLine(preview.text);
      symbolReferencesChannel.show(true);
    }
  );
  context.subscriptions.push(symbolReferencesCommand, symbolReferencesChannel);
  context.subscriptions.push(defAnalysis.outputChannel, defAnalysis.diagnostics);

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
      const currentWorkspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!currentWorkspaceRoot) {
        vscode.window.showWarningMessage('未打开工作区,无法生成发现与定位诊断');
        return;
      }
      const issueCount = writeDiscoveryReport(currentWorkspaceRoot);
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

  // IDE-MET-001:活动扩展身份报告——区分「安装目录存在」(文件系统核验)与
  // 「当前窗口已激活」(isActive),列宿主位置(remote(name)/local)与
  // 扩展宿主侧(workspace/ui);渲染纯函数在 extensionIdentity.ts。
  const identityChannel = vscode.window.createOutputChannel('Kode 扩展身份');
  const identityCommand = vscode.commands.registerCommand('kbengine.extension.identity', () => {
    const entries = vscode.extensions.all
      .filter(extension => extension.id.toLowerCase().startsWith('cuihairu.'))
      .map(extension => ({
        id: extension.id,
        version: String(extension.packageJSON?.version ?? 'unknown'),
        extensionPath: extension.extensionPath ?? '',
        installExists: Boolean(extension.extensionPath) && fs.existsSync(extension.extensionPath),
        isActive: extension.isActive,
        extensionKind: String(extension.extensionKind ?? 'unknown')
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
    identityChannel.clear();
    identityChannel.appendLine(renderExtensionIdentityReport(entries, {
      remoteName: vscode.env.remoteName,
      appName: vscode.env.appName
    }, readBuildCommit(context.extensionPath)));
    identityChannel.show(true);
  });
  context.subscriptions.push(identityCommand, identityChannel);

  // IDE-REL-001 两个 Kode ID 共激活检测:激活时查一次当前宿主窗口的
  // Kode 系扩展(cuihairu. 名下 id 含 kode),只有「实际共激活」(两个
  // 都 isActive)才提示冲突;已安装未激活/被禁用(禁用不进
  // extensions.all,采集面天然见不到)不算冲突,零虚报零打扰。
  const kodeFamilyFacts = vscode.extensions.all
    .filter(extension => {
      const id = extension.id.toLowerCase();
      return id.startsWith('cuihairu.') && id.includes('kode');
    })
    .map(extension => ({ id: extension.id, isActive: extension.isActive }));
  const dualActivationWarning = formatDualActivationWarning(detectDualActivation(kodeFamilyFacts));
  if (dualActivationWarning !== null) {
    void vscode.window.showWarningMessage(dualActivationWarning);
  }

  // IDE-REL-007 复现配置摘要:诊断排障时「环境长什么样」一页导出——活动
  // 版本(cuihairu. 名下 id@version+构建提交)/根(workspace/索引扫描根/
  // 活动 profile 双根)/宿主角色(local|remote + 扩展宿主侧)/开关(自身
  // package.json 里全部 kbengine.* 布尔项,自动随贡献面增长)/队列数据
  // (诊断排队/在途、注解、索引任务、schema 冷构建+语言服务在册操作)。
  // 连接信息取引擎 dbmgr 数据库接口配置,username/password 渲染层即遮蔽,
  // 全文再过 maskConnectionSecrets 兜底;渲染纯函数在 reproductionSummary.ts。
  const reproSummaryChannel = vscode.window.createOutputChannel('Kode 复现配置摘要');
  const reproSummaryCommand = vscode.commands.registerCommand(
    'kbengine.diagnostics.exportReproSummary',
    () => {
      const configuration = vscode.workspace.getConfiguration('kbengine');
      const contributed = JSON.parse(
        fs.readFileSync(path.join(context.extensionPath, 'package.json'), 'utf8')
      ) as { contributes?: { configuration?: { properties?: Record<string, { type?: string }> } } };
      const switchKeys = Object.entries(contributed.contributes?.configuration?.properties ?? {})
        .filter(([, schema]) => schema.type === 'boolean')
        .map(([key]) => key)
        .sort();
      const activeProfile = resolveActiveProfile(context.workspaceState);
      const database = resolveDatabaseInterfaceConfig();
      reproSummaryChannel.clear();
      reproSummaryChannel.appendLine(renderReproductionSummary({
        host: {
          label: hostLabel({ remoteName: vscode.env.remoteName, appName: vscode.env.appName }),
          side: sideLabel(String(context.extension.extensionKind ?? 'unknown'))
        },
        extensions: vscode.extensions.all
          .filter(extension => extension.id.toLowerCase().startsWith('cuihairu.'))
          .map(extension => ({
            id: extension.id,
            version: String(extension.packageJSON?.version ?? 'unknown'),
            active: extension.isActive,
            side: sideLabel(String(extension.extensionKind ?? 'unknown'))
          }))
          .sort((left, right) => left.id.localeCompare(right.id)),
        buildCommit: readBuildCommit(context.extensionPath),
        workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath),
        scanRoots: getIndexScanRoots(),
        profile: activeProfile
          ? {
              name: activeProfile.displayName,
              assetsRoot: activeProfile.assetsRoot,
              engineRoot: activeProfile.engineRoot
            }
          : null,
        switches: switchKeys.map(key => ({ key, on: Boolean(configuration.get<boolean>(key)) })),
        queue: {
          diagnosticsQueued: getDiagnosticScheduler().pendingWorkload().queued,
          diagnosticsInFlight: getDiagnosticScheduler().pendingWorkload().inFlight,
          annotationUpdates: getPendingDocumentUpdateCount(),
          annotationBuilds: getAnnotationBuildWorkload(),
          worker: getPythonParserWorkerGauge(),
          caches: {
            parsedDocuments: getParsedDocumentCacheGauge(),
            databaseSchemas: getDatabaseSchemaCacheGauge(),
            annotationIndex: getReturnAnnotationCacheGauge()
          },
          indexTasksQueued: indexScheduler.getStatus().queued,
          schemaColdBuilds: getPendingTypeStorageColdBuildCount()
        },
        activeOperations: getActiveOperationCounts(),
        connections: database
          ? [{
              source: 'engine-dbmgr',
              host: database.host,
              port: database.port,
              username: database.username,
              databaseName: database.databaseName,
              encrypt: database.encrypt
            }]
          : []
      }));
      reproSummaryChannel.show(true);
    }
  );
  context.subscriptions.push(reproSummaryCommand, reproSummaryChannel);

  // Python 语言服务三态检查(IDE-PRJ-005):未安装/未启用/已激活,判定只看
  // 扩展事实(采集 collectPythonServiceFacts 与 profile 健康汇总同源);
  // extraPaths 写入只是配置面,附警示不参与可用判定
  const pythonServiceStatusCommand = vscode.commands.registerCommand('kbengine.python.serviceStatus', () => {
    const facts = collectPythonServiceFacts();
    vscode.window.showInformationMessage(
      renderPythonServiceMessage(classifyPythonService(facts), facts)
    );
  });
  context.subscriptions.push(pythonServiceStatusCommand);

  // profile 健康状态汇总(IDE-PRJ-009):缺引擎/缺解释器/缺语言服务/根歧义
  // 各带定位入口,活动 profile 经稳定 ID 解析(IDE-PRJ-010)
  const profileHealthCommand = vscode.commands.registerCommand(
    'kbengine.profile.health',
    () => showProfileHealthSummary(context)
  );
  context.subscriptions.push(profileHealthCommand);

  // 解释器状态栏与选择(PY-ENV 二期):状态栏项显示当前解释器(venv 名/
  // 版本/来源徽标 auto|configured|PATH|缺失),点击进 QuickPick——选中写入
  // kbengine.python.interpreterPath(workspace 级)即刻生效(解析链每次读
  // 实时配置);列表尾「创建新 venv…」走创建流(选放置 venv 的父目录,目标
  // 固定 .venv;基础解释器=设置→PATH 链,缺失如实拒绝;完成后对目标直接
  // 验真再选用)。
  const interpreterStatusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    97
  );
  interpreterStatusBarItem.command = 'kbengine.python.selectInterpreter';
  context.subscriptions.push(interpreterStatusBarItem);

  const venvPreferredNames = (): string[] =>
    normalizeVenvDirectoryNames(
      vscode.workspace.getConfiguration('kbengine').get('python.venvDirectories')
    );
  const refreshInterpreterStatusBar = async (): Promise<void> => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const resolution = resolveProfileInterpreter(root);
    interpreterStatusBarItem.text = interpreterStatusBarText(resolution);
    interpreterStatusBarItem.tooltip = resolution.interpreterPath
      ? resolution.interpreterPath
      : 'Python 解释器缺失(点击可选择或创建)';
    interpreterStatusBarItem.show();
    // 版本探测失败如实省略版本段,不影响徽标与路径显示
    if (resolution.interpreterPath) {
      const version = await probePythonVersion(resolution.interpreterPath);
      if (version) {
        interpreterStatusBarItem.text = interpreterStatusBarText(resolution, version);
      }
    }
  };

  const runCreateVenvFlow = (): Promise<'created' | null> =>
    createVenvFlow({
      workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      // 对话框只能选已存在目录:选放置 venv 的父目录(默认工作区根),
      // 目标固定为其中的 .venv(python -m venv 自己落目录)
      pickTargetParentDir: async defaultDir => {
        const picks = await vscode.window.showOpenDialog({
          canSelectFolders: true,
          canSelectMany: false,
          defaultUri: vscode.Uri.file(defaultDir),
          openLabel: '选择放置 venv 的目录'
        });
        return picks?.[0]?.fsPath ?? null;
      },
      // 基础解释器走 设置存在才采用 → PATH 链(不走工作区发现——那可能
      // 正是要被重建的环境);与缺失提示的补救入口一致
      baseInterpreter: () => {
        const configured = vscode.workspace
          .getConfiguration('kbengine')
          .get<string>('python.interpreterPath', '');
        return resolveInterpreterWith({
          interpreterSetting: configured,
          pathEnv: process.env.PATH,
          platform: process.platform
        }).interpreterPath;
      },
      targetDirectoryExistsNonEmpty: dir => {
        try {
          return fs.readdirSync(dir).length > 0;
        } catch {
          return false;
        }
      },
      // withProgress 返回 Thenable,await 归一成 Promise(依赖面签名)
      runVenvModule: async (base, target) =>
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `创建 venv: python -m venv ${target}` },
          () => runVenvModuleProcess(base, target)
        ),
      // 直接对目标验真(不依赖扫描范围,深层/工作区外目标照常选用)
      verifyTarget: dir => verifyVenvDirectory(dir, process.platform),
      writeInterpreterSetting: async value =>
        await vscode.workspace
          .getConfiguration('kbengine')
          .update('python.interpreterPath', value, vscode.ConfigurationTarget.Workspace),
      report: async message => {
        await vscode.window.showInformationMessage(message);
      }
    });

  const selectInterpreterCommand = vscode.commands.registerCommand(
    'kbengine.python.selectInterpreter',
    async () => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      await selectInterpreter({
        current: () => resolveProfileInterpreter(root),
        discovered: () => (root ? scanVenvs(root, { preferredNames: venvPreferredNames() }) : []),
        pathInterpreter: () => locateInterpreterOnPath(process.env.PATH, process.platform),
        showQuickPick: async items =>
          await vscode.window.showQuickPick(items, {
            placeHolder: '选择 Python 解释器(写入 kbengine.python.interpreterPath 即刻生效)'
          }),
        writeInterpreterSetting: async value =>
          await vscode.workspace
            .getConfiguration('kbengine')
            .update('python.interpreterPath', value, vscode.ConfigurationTarget.Workspace),
        report: async message => {
          await vscode.window.showInformationMessage(message);
        },
        createVenv: () => runCreateVenvFlow()
      });
      await refreshInterpreterStatusBar();
    }
  );

  const createVenvCommand = vscode.commands.registerCommand('kbengine.python.createVenv', async () => {
    await runCreateVenvFlow();
    await refreshInterpreterStatusBar();
  });

  const interpreterConfigListener = vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('kbengine.python.interpreterPath')) {
      void refreshInterpreterStatusBar();
    }
  });
  context.subscriptions.push(selectInterpreterCommand, createVenvCommand, interpreterConfigListener);
  void refreshInterpreterStatusBar();

  // .py lint via ruff(IDE-RUST-005,A 案 shell out):Rust 侧 `$/kode/ruff/lint`
  // 恒 --target-version py37 + --no-cache(不写工作区);缺 ruff 如实
  // available:false → 这里同意式 pip 安装(选定解释器),失败亮手动命令
  // (用户令 2026-11-06),绝不静默装。
  const ruffChannel = vscode.window.createOutputChannel('KBEngine Ruff');
  const ruffDiagnostics = vscode.languages.createDiagnosticCollection('kode-ruff');
  context.subscriptions.push(ruffChannel, ruffDiagnostics);

  // C-23 行为知识流水线(坑→lint/code action/hover):三规则(KBE-PY-015/
  // 016/017)独立诊断集合与 quick fix provider 自持装配(trapDiagnosticsWiring
  // 自带事件监听,不进主调度链);hover 行为注记在 languageProviders/hover.ts
  // self 属性悬停面接线。注册点放在全部既有诊断集合之后(集合创建序即
  // 注册表序,消费方按序取集合,不抢既有下标)
  wireTrapLintDiagnostics(context, entityMappingManager);
  const ruffLintDeps = {
    getWorkspacePythonFiles: async () =>
      (
        await vscode.workspace.findFiles('**/*.py', '**/node_modules/**', RUFF_MAX_FILES + 1)
      ).map(uri => uri.fsPath),
    getInterpreterPath: () => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      return resolveProfileInterpreter(root).interpreterPath || null;
    },
    runPipInstall: (interpreterPath: string) =>
      new Promise<{ ok: boolean; output: string }>(resolve => {
        execFile(interpreterPath, ['-m', 'pip', 'install', 'ruff'], (error, stdout, stderr) => {
          resolve({ ok: !error, output: `${stdout ?? ''}\n${stderr ?? ''}`.trim() });
        });
      }),
    showInformationMessage: (message: string, ...items: string[]) =>
      vscode.window.showInformationMessage(message, ...items),
    showErrorMessage: async (message: string) => {
      await vscode.window.showErrorMessage(message);
    },
    setDiagnostics: (entries: Array<{ file: string; diags: RuffDiag[] }>) => {
      ruffDiagnostics.clear();
      for (const { file, diags } of entries) {
        ruffDiagnostics.set(
          vscode.Uri.file(file),
          diags.map(
            d =>
              new vscode.Diagnostic(
                new vscode.Range(d.line - 1, d.col - 1, d.endLine - 1, d.endCol - 1),
                `${d.code ? `${d.code}: ` : ''}${d.message}`,
                d.severity === 'error'
                  ? vscode.DiagnosticSeverity.Error
                  : vscode.DiagnosticSeverity.Warning
              )
          )
        );
      }
    },
    channel: ruffChannel
  };
  const ruffLintCommand = vscode.commands.registerCommand('kbengine.python.ruffLint', async () => {
    const summary = await runRuffLintCommand(ruffLintDeps);
    ruffChannel.appendLine(`[ruff] ${summary}`);
    ruffChannel.show(true);
    await vscode.window.showInformationMessage(summary);
  });
  const installRuffCommand = vscode.commands.registerCommand(
    'kbengine.python.installRuff',
    async () => {
      const summary = await runInstallRuffCommand(ruffLintDeps);
      ruffChannel.appendLine(`[ruff] ${summary}`);
      await vscode.window.showInformationMessage(summary);
    }
  );
  context.subscriptions.push(ruffLintCommand, installRuffCommand);

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
      if (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath !== discoveryRoot) { return; }
      const issueCount = writeDiscoveryReport(discoveryRoot);
      if (issueCount > 0) {
        vscode.window.showWarningMessage(
          `发现与定位存在 ${issueCount} 项问题,详见「KBEngine 发现与定位」输出面板`
        );
      }
    });
  }
}
