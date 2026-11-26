// SRC-001 L10:工具命令层(KODE-ARCH-002 纯移动)。区域含 .def 静态分析
// 建议、跨文件语义医生、符号引用图、片段生成、发现报告、扩展身份、双激活
// 警告、复现摘要、Python 服务状态、profile 健康检查、解释器状态栏与选择、
// ruff lint/安装(IDE-RUST-005 A 案 shell out)、发现报告提示等 10+ 独立命令。
// 装配顺序由组合根调用点保持;注册面直推 context.subscriptions(销毁所有权
// 不变);entityMappingManager(coreServices L1)/serverManager(serverControls
// L4)/indexScheduler(coreServices L1)经 deps 注入;区域无后向消费者,
// 不返回共享句柄。

import * as vscode from 'vscode';
import { l10nText } from '../nlsRuntime';
import { CUSTOM_SNIPPETS_RELATIVE_PATH, mergeSnippetEntry, selectionToSnippetBody } from '../backend/snippetGenerator';
import { DiscoveryKey, DiscoveryLayoutFacts, DiscoveryPromptDeps } from '../workspaceDiscovery';
import { MergeSnippetResult } from '../backend/snippetGenerator';
import { RUFF_MAX_FILES, runInstallRuffCommand, runRuffLintCommand, ruffExePathForInterpreter, RuffDiag } from '../backend/ruffLint';
import { ensureRuffFormatterRegistered, runRuffFormat, runRuffFormatCommand } from '../backend/ruffFormat';
import { ensureRuffConfigShared, wireSharedRuffConfigEnsure } from '../backend/ruffConfigEnsure';
import { buildDefReferenceGraphFromFile, buildProjectDoctorReport, formatDefReferenceGraphPreview, formatProjectDoctorReport } from '../backend/defReferenceGraph';
import { KBEngineDefFormatProvider } from '../languageProviders/defFormatProvider';
import { buildDiscoveryReport, renderDiscoveryReport, runWorkspaceDiscovery } from '../workspaceDiscovery';
import { classifyPythonService, collectPythonServiceFacts, renderPythonServiceMessage } from '../pythonLanguageServiceStatus';
import {
  createVenvFlow,
  interpreterStatusBarText,
  probePythonVersion,
  PYTHON_INTERPRETER_EXTENSION_ID,
  runVenvModuleProcess,
  selectInterpreter,
  shouldShowInterpreterStatusBar
} from '../backend/venvInterpreterPicker';
import { detectDualActivation, formatDualActivationWarning } from '../backend/dualActivationConflict';
import { readEngineApiMetadata } from '../backend/engineApiMetadata';
import { buildEngineProfileReport, renderEngineProfileReport } from '../backend/engineProfile';
import { getEngineVersion } from '../engineVersion';
import { findEngineRoot } from '../backend/engineCompatibility';
import {
  describeEngineApiConstraint,
  resolveEngineCppDefinition,
  resolveEnginePythonDefinition
} from '../backend/engineSourceBinding';
import { pythonProcessFromPath } from '../backend/pythonProcess';
import {
  buildKbeStubDocument,
  buildKbeStubUriString,
  getKbeAliases,
  getKbeSymbol,
  resolveKbeAccessAtPosition
} from '../kbeModuleIndex';
import { KBENGINE_SOURCE_REVEAL_COMMAND } from '../sourceRevealCommand';
import {
  auditEntitiesRegistration,
  collectAuditStats,
  renderEntitiesRegistrationAudit
} from '../backend/entitiesRegistrationAudit';
import { execFile } from 'child_process';
import type { ChildProcess } from 'child_process';
import { findFilesAcrossRoots, findFilesForKbengineSurfaces } from '../scanRoots';
import { getActiveOperationCounts } from '../languageServiceMetrics';
import { getAnnotationBuildWorkload, getPendingDocumentUpdateCount, getReturnAnnotationCacheGauge, resetPythonReturnAnnotationCache } from '../backend/pythonReturnTypeInference';
import { clearDatabaseSchemaCache, getDatabaseSchemaCacheGauge, getPendingTypeStorageColdBuildCount } from '../databaseSchema';
import { getDefinitionWorkspaceLayout } from '../definitionWorkspace';
import { getDiagnosticScheduler } from '../backend/diagnosticScheduler';
import { getIndexScanRoots } from '../scanRoots';
import { clearParsedDocumentCache, getParsedDocumentCacheGauge } from '../backend/defParser';
import { getPythonParserWorkerGauge } from '../backend/pythonParserWorkerHost';
import { hostLabel, renderExtensionIdentityReport, sideLabel } from '../backend/extensionIdentity';
import { joinWorkspacePath } from '../backend/workspacePath';
import { renderCacheClearConfirmation, renderCacheClearedReport } from '../backend/cacheMaintenance';
import { LanguageServiceStatusController } from '../backend/languageServiceStatus';
import {
  locateInterpreterOnPath,
  resolveInterpreterWith,
  resolveProfileInterpreter,
  resolveProfileInterpreterAsync
} from '../profileInterpreter';
import { normalizeVenvDirectoryNames } from '../backend/quickActionConfig';
import { readBuildCommit } from '../backend/buildCommit';
import { renderReproductionSummary } from '../backend/reproductionSummary';
import { onDidChangeActiveProfile, resolveActiveProfile } from '../activeProfile';
import { StartEntryController } from '../startEntry';
import { resolveDatabaseInterfaceConfig } from '../serverConfigMerge';
import { discoverVenvsCached, verifyVenvDirectory } from '../backend/venvDiscovery';
import { showProfileHealthSummary } from '../profileHealth';
import { wireDefAnalysis } from '../defAnalysisWiring';
import { wireTrapLintDiagnostics } from '../trapDiagnosticsWiring';
import { wireEntityReferenceCacheDiagnostics } from '../entityReferenceWiring';
import { wireConfigValueDiagnostics } from '../configValueDiagnosticsWiring';
import * as fs from 'fs';
import * as path from 'path';
import type { EntityMappingManager } from '../entityMapping';
import type { KBEngineServerManager } from '../serverManager';
import type { IndexScheduler } from '../backend/indexScheduler';

export interface UtilityCommandsDeps {
  context: vscode.ExtensionContext;
  entityMappingManager: EntityMappingManager;
  serverManager: KBEngineServerManager;
  indexScheduler: IndexScheduler;
  /** .def 格式化 provider 的选择器(KODE-SYN-006;与 .def 其余语言服务同一 selector)。 */
  defDocumentSelector: ReadonlyArray<vscode.DocumentFilter | string>;
  /** INDEX-DISCIPLINE-001:索引输入纪律观测面(合并器待合并数+语法门拦计数);
   * 可选注入,缺省时状态栏 tooltip 不加该行(面不冒充)。 */
  indexDisciplineStats?: () => { coalescerPending: number; syntaxGateSkipped: number } | null;
}

export function activateUtilityCommands(deps: UtilityCommandsDeps): void {
  const { context, entityMappingManager, serverManager, indexScheduler, defDocumentSelector } = deps;
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
        vscode.window.showInformationMessage(l10nText('No .def files found; Project Doctor needs a .def file to run'));
        return;
      }

      const graph = await buildDefReferenceGraphFromFile(candidateUri.fsPath);
      if (!graph) {
        vscode.window.showWarningMessage(l10nText('entity_defs root not found; Project Doctor only supports the standard definition layout'));
        return;
      }

      const report = buildProjectDoctorReport(graph);
      projectDoctorChannel.clear();
      projectDoctorChannel.appendLine(formatProjectDoctorReport(report));
      projectDoctorChannel.show(true);
      if (report.errors.length > 0) {
        vscode.window.showWarningMessage(l10nText('Project Doctor found {count} errors; see the output panel', { count: report.errors.length }));
      } else if (report.warnings.length > 0) {
        vscode.window.showInformationMessage(l10nText('Project Doctor finished: {count} warnings', { count: report.warnings.length }));
      } else {
        vscode.window.showInformationMessage(l10nText('Project Doctor finished: no cross-file semantic errors'));
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
        vscode.window.showInformationMessage(l10nText('No .def files found; cannot build the symbol reference graph'));
        return;
      }

      const graph = await buildDefReferenceGraphFromFile(candidateUri.fsPath);
      if (!graph) {
        vscode.window.showWarningMessage(l10nText('entity_defs root not found; the symbol reference graph only supports the standard definition layout'));
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
        vscode.window.showInformationMessage(l10nText('Select some text in the editor first to generate a snippet'));
        return;
      }

      const snippetName = await vscode.window.showInputBox({
        prompt: l10nText('Enter the snippet name'),
        placeHolder: 'MyDefTemplate',
        validateInput: (value) => (!value || value.trim() === '' ? l10nText('Snippet name cannot be empty') : null)
      });
      if (!snippetName) {
        return;
      }

      const prefix = await vscode.window.showInputBox({
        prompt: l10nText('Enter the trigger prefix'),
        placeHolder: `kbe-${snippetName.toLowerCase()}`,
        value: `kbe-${snippetName.toLowerCase()}`,
        validateInput: (value) => (!value || value.trim() === '' ? l10nText('Trigger prefix cannot be empty') : null)
      });
      if (!prefix) {
        return;
      }

      // 描述可选:取消(Esc)按仓库既有口径视为继续,记空串不写该字段
      const description = await vscode.window.showInputBox({
        prompt: l10nText('Enter a snippet description (optional)'),
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
        vscode.window.showInformationMessage(l10nText('Selection has no usable text; no snippet generated'));
        return;
      }

      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        vscode.window.showErrorMessage(l10nText('No workspace open; cannot save custom snippets'));
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
          l10nText('Cannot read the custom snippets file: {path} ({reason})', { path: snippetsFilePath, reason: (error as Error).message })
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
          l10nText('The custom snippets file is not valid object JSON; tidy it up by hand first, then retry: {path}', { path: snippetsFilePath })
        );
        return;
      }

      try {
        fs.mkdirSync(path.dirname(snippetsFilePath), { recursive: true });
        fs.writeFileSync(snippetsFilePath, merged.content, 'utf8');
      } catch (error) {
        vscode.window.showErrorMessage(
          l10nText('Cannot write the custom snippets file: {path} ({reason})', { path: snippetsFilePath, reason: (error as Error).message })
        );
        return;
      }

      if (merged.overwritten) {
        vscode.window.showWarningMessage(
          l10nText('Overwrote the existing snippet {name}: {path}', { name: snippetName, path: snippetsFilePath })
        );
      } else {
        vscode.window.showInformationMessage(
          l10nText('Generated custom snippet {name} (prefix {prefix}): {path}', { name: snippetName, prefix, path: snippetsFilePath })
        );
      }
    }
  );
  context.subscriptions.push(generateSnippetCommand);

  // 批125 自动发现:激活期盘点工作区锚点(entities.xml/entity_defs/types.xml/
  // kbe 源码根),多候选弹一次 quick pick 并记忆(workspaceState 回放,后续
  // 会话不再询问);单候选/零命中零打扰。显式配置永远优先于发现结果。
  // workspaceState 缺失(测试替身/嵌入场景)时静默跳过,不做磁盘级记忆。

  // 批127 发现与定位诊断:定位失败不再静默——报告摊开每个键的显式配置/
  // 约定链/深扫描/记忆选择与最终取用,写入输出通道供复制回传。
  const DISCOVERY_REPORT_CHANNEL_NAME = 'KBEngine Discovery Report';
  const discoveryReportChannel = vscode.window.createOutputChannel(DISCOVERY_REPORT_CHANNEL_NAME);
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
      binPath: serverManager.getBinPath()
      // entityDefsPath/entitiesXmlPath 显式配置行已删(2026-11-23 用户令:
      // 固定目录由 assetsRoot 计算);报告三面 explicit 槽恒空串
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
        vscode.window.showWarningMessage(l10nText('No workspace open; cannot generate the discovery report'));
        return;
      }
      const issueCount = writeDiscoveryReport(currentWorkspaceRoot);
      discoveryReportChannel.show(true);
      if (issueCount > 0) {
        vscode.window.showWarningMessage(
          l10nText('{count} discovery issues found; see the "{channel}" output panel', { count: issueCount, channel: DISCOVERY_REPORT_CHANNEL_NAME })
        );
      } else {
        vscode.window.showInformationMessage(l10nText('Discovery report: all clear'));
      }
    }
  );
  context.subscriptions.push(discoveryReportCommand, discoveryReportChannel);

  // IDE-MET-001:活动扩展身份报告——区分「安装目录存在」(文件系统核验)与
  // 「当前窗口已激活」(isActive),列宿主位置(remote(name)/local)与
  // 扩展宿主侧(workspace/ui);渲染纯函数在 extensionIdentity.ts。
  const identityChannel = vscode.window.createOutputChannel('Kode Extension Identity');
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

  // RUST-173 Engine profile:官方版本/分类(fork·custom)/版本宏探测/git
  // commit+describe/KB-VER-002 特性分层聚合一屏汇报;unknown 面如实写
  // 「未探测到/未知」,绝不占位编造(纯模型 engineProfile.ts,可钉)。
  const engineProfileChannel = vscode.window.createOutputChannel('Kode Engine Profile');
  const engineProfileCommand = vscode.commands.registerCommand('kbengine.engine.profile', async () => {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const metadata = await readEngineApiMetadata(workspaceRoot);
    const report = buildEngineProfileReport({ settingVersion: getEngineVersion(), metadata });
    engineProfileChannel.clear();
    engineProfileChannel.appendLine(renderEngineProfileReport(report, vscode.env.language));
    engineProfileChannel.show(true);
  });
  context.subscriptions.push(engineProfileCommand, engineProfileChannel);

  // RUST-174 API metadata 与真实 engine source 绑定:把策展 KBE 符号导航到
  // 真实引擎检出上的定义(Python=引擎 typings 声明行,锚点运行时复验;
  // C++=cppClassName 在 kbe/src/lib 头文件里有界扫描)。目标由纯核解析
  // (engineSourceBinding):锚点漂移只给文件不声称行,引擎检出缺席时直接
  // 开内置桩并如实说明,绝不伪造位置。version constraints 标注随面板呈现。
  interface EngineSourcePickItem extends vscode.QuickPickItem {
    target?: { file: string; line: number | null };
    stub?: boolean;
  }
  const engineSourceCommand = vscode.commands.registerCommand(
    'kbengine.api.engineSource',
    async (symbolArg?: string) => {
      const editor = vscode.window.activeTextEditor;
      let symbolName = typeof symbolArg === 'string' && symbolArg.trim() ? symbolArg.trim() : undefined;
      if (!symbolName && editor) {
        const aliases = getKbeAliases(editor.document.getText());
        const active = editor.selection.active;
        const access = resolveKbeAccessAtPosition(
          editor.document.lineAt(active.line).text,
          active.character,
          aliases
        );
        symbolName = access?.symbol;
      }
      const stubProcess = editor ? pythonProcessFromPath(editor.document.fileName) : null;
      const entry = symbolName ? getKbeSymbol(symbolName, stubProcess) : null;
      if (!entry) {
        void vscode.window.showWarningMessage(
          l10nText('No KBEngine module symbol here; run from a KBEngine access or pass a symbol name')
        );
        return;
      }
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
      const engineRoot = workspaceRoot ? findEngineRoot(workspaceRoot) : null;
      const fsDeps = {
        existsSync: (candidate: string) => fs.existsSync(candidate),
        readFileSync: (candidate: string) => fs.readFileSync(candidate, 'utf8')
      };
      const pythonTarget = resolveEnginePythonDefinition(entry, engineRoot, fsDeps);
      const cppTarget = resolveEngineCppDefinition(entry, engineRoot, {
        ...fsDeps,
        readdirSync: (candidate: string) => fs.readdirSync(candidate, { withFileTypes: true })
      });
      const constraint = describeEngineApiConstraint(entry, getEngineVersion(), vscode.env.language);

      const items: EngineSourcePickItem[] = [];
      if (pythonTarget.kind === 'engine-typings') {
        // Vector2/3/4 的策展锚点直接落在引擎 C++ 头文件(非 .pyi),标签如实分型
        items.push({
          label: entry.sourceFile.endsWith('.pyi')
            ? l10nText('Engine Python definition (typings)')
            : l10nText('Engine source anchor (header)'),
          description: `${pythonTarget.file}:${pythonTarget.line}`,
          target: { file: pythonTarget.file, line: pythonTarget.line }
        });
      } else if (pythonTarget.kind === 'engine-typings-drifted') {
        items.push({
          label: l10nText('Engine typings file (anchor drifted; line not claimed)'),
          description: pythonTarget.file,
          target: { file: pythonTarget.file, line: null }
        });
      }
      if (cppTarget.kind === 'engine-cpp') {
        items.push({
          label: l10nText('Engine C++ declaration'),
          description: `${cppTarget.file}:${cppTarget.line}`,
          target: { file: cppTarget.file, line: cppTarget.line }
        });
      }
      const stubUriString = buildKbeStubUriString(stubProcess);
      const placeholderParts = [
        l10nText('Engine source for {name} (layer: {layer})', { name: entry.name, layer: constraint.layer })
      ];
      if (constraint.annotation) {
        placeholderParts.push(constraint.annotation);
      }
      if (items.length === 0) {
        // 引擎检出缺席/目标全未命中:内置桩兜底,缺席面如实说明,不静默装引擎
        void vscode.window.showInformationMessage(
          l10nText('No engine checkout detected; opening the built-in stub document')
        );
        const stubLine = buildKbeStubDocument(stubProcess).symbolLines[entry.name] ?? 0;
        await vscode.commands.executeCommand(KBENGINE_SOURCE_REVEAL_COMMAND, vscode.Uri.parse(stubUriString), {
          selection: new vscode.Range(stubLine, 0, stubLine, 0)
        });
        return;
      }
      items.push({ label: l10nText('Built-in stub document'), description: stubUriString, stub: true });
      const picked = (await vscode.window.showQuickPick(items, { placeHolder: placeholderParts.join(' — ') })) as
        | EngineSourcePickItem
        | undefined;
      if (!picked) {
        return;
      }
      if (picked.stub) {
        const stubLine = buildKbeStubDocument(stubProcess).symbolLines[entry.name] ?? 0;
        await vscode.commands.executeCommand(KBENGINE_SOURCE_REVEAL_COMMAND, vscode.Uri.parse(stubUriString), {
          selection: new vscode.Range(stubLine, 0, stubLine, 0)
        });
        return;
      }
      if (picked.target) {
        await vscode.commands.executeCommand(
          KBENGINE_SOURCE_REVEAL_COMMAND,
          vscode.Uri.file(picked.target.file),
          picked.target.line !== null
            ? { selection: new vscode.Range(picked.target.line - 1, 0, picked.target.line - 1, 0) }
            : undefined
        );
      }
    }
  );
  context.subscriptions.push(engineSourceCommand);

  // RUST-175 entities.xml 注册完整性审计:清单↔.def 配对与 base/cell 面
  // 脚本在盘(引擎真源锚见 entitiesRegistrationAudit.ts 头注)。报告面,
  // 只记事实不发诊断——方法一致性走 C-19 既有诊断,重复条目走 KBE-DEF-009。
  const entityRegistrationChannel = vscode.window.createOutputChannel('Kode Entity Registration');
  const entityRegistrationCommand = vscode.commands.registerCommand(
    'kbengine.entities.checkRegistration',
    () => {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
      if (!workspaceRoot) {
        void vscode.window.showWarningMessage(
          l10nText('Entity registration check needs an open workspace folder')
        );
        return;
      }
      const layout = getDefinitionWorkspaceLayout(workspaceRoot);
      const zh = vscode.env.language?.startsWith('zh');
      if (!layout.entitiesXmlPath || !fs.existsSync(layout.entitiesXmlPath)) {
        entityRegistrationChannel.clear();
        entityRegistrationChannel.appendLine(
          zh
            ? '未见 entities.xml(纯脚本定义资产可无此文件,引擎允许缺省:entitydef.cpp:2261-2263)'
            : 'entities.xml not found (pure-script assets may omit it; the engine allows absence: entitydef.cpp:2261-2263)'
        );
        entityRegistrationChannel.show(true);
        return;
      }
      const entitiesXmlText = fs.readFileSync(layout.entitiesXmlPath, 'utf8');
      const defNames = layout.entityDefsRoot && fs.existsSync(layout.entityDefsRoot)
        ? fs.readdirSync(layout.entityDefsRoot)
          .filter(name => name.endsWith('.def'))
          .map(name => name.slice(0, -4))
        : [];
      // 脚本在盘口径与引擎 matchRes 同构:<Name>.py 与 <Name>.pyc 都算在盘
      const faceScriptNames = (face: 'base' | 'cell'): Set<string> => {
        const names = new Set<string>();
        const directory = layout.entityScriptsRoot
          ? path.join(layout.entityScriptsRoot, face)
          : null;
        if (!directory || !fs.existsSync(directory)) {
          return names;
        }
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          if (!entry.isFile()) {
            continue;
          }
          if (entry.name.endsWith('.py')) {
            names.add(entry.name.slice(0, -3));
          } else if (entry.name.endsWith('.pyc')) {
            names.add(entry.name.slice(0, -4));
          }
        }
        return names;
      };
      const input = {
        entitiesXmlText,
        defNames,
        baseScriptNames: faceScriptNames('base'),
        cellScriptNames: faceScriptNames('cell')
      };
      const findings = auditEntitiesRegistration(input);
      entityRegistrationChannel.clear();
      entityRegistrationChannel.appendLine(
        renderEntitiesRegistrationAudit(findings, collectAuditStats(input), vscode.env.language)
      );
      entityRegistrationChannel.show(true);
    }
  );
  context.subscriptions.push(entityRegistrationCommand, entityRegistrationChannel);

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
  const reproSummaryChannel = vscode.window.createOutputChannel('Kode Reproduction Summary');
  const reproSummaryCommand = vscode.commands.registerCommand(
    'kbengine.diagnostics.exportReproSummary',
    () => {
      const configuration = vscode.workspace.getConfiguration('kbengine');
      const contributed = JSON.parse(
        fs.readFileSync(path.join(context.extensionPath, 'package.json'), 'utf8')
      ) as {
        contributes?: {
          configuration?:
            | { properties?: Record<string, { type?: string }> }
            | Array<{ properties?: Record<string, { type?: string }> }>;
        };
      };
      // RUST-228 起 configuration 是分组块数组,聚合后枚举布尔开关(自动随贡献面增长)
      const configurationBlocks = contributed.contributes?.configuration;
      const contributedProperties = Object.assign(
        {},
        ...(Array.isArray(configurationBlocks)
          ? configurationBlocks
          : configurationBlocks
            ? [configurationBlocks]
            : []
      ).map(block => block.properties ?? {})) as Record<string, { type?: string }>;
      const switchKeys = Object.entries(contributedProperties)
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

  // 缓存维护(RUST-221,旧 UI-004):三条内存缓存(解析文档/数据库 schema/
  // 返回注解索引)一键清空——modal 确认列范围与影响(内存缓存重建,不动磁盘
  // 与工作区文件,无数据丢失;重启窗口不是第一步),清后摘要逐条报差值,
  // 缓存本已空时如实说明。范围/影响文案纯核渲染(cacheMaintenance)。
  const clearCachesCommand = vscode.commands.registerCommand(
    'kbengine.diagnostics.clearCaches',
    async () => {
      const gauges = [
        { label: '解析文档缓存', entries: getParsedDocumentCacheGauge().entries },
        { label: '数据库 schema 缓存', entries: getDatabaseSchemaCacheGauge().entries },
        { label: '返回注解索引', entries: getReturnAnnotationCacheGauge().entries }
      ];
      const confirmLabel = l10nText('Clear caches');
      const choice = await vscode.window.showWarningMessage(
        renderCacheClearConfirmation(gauges),
        { modal: true },
        confirmLabel
      );
      if (choice !== confirmLabel) {
        return;
      }
      const before = gauges.map(gauge => gauge.entries);
      clearParsedDocumentCache();
      clearDatabaseSchemaCache();
      resetPythonReturnAnnotationCache();
      const after = [
        getParsedDocumentCacheGauge().entries,
        getDatabaseSchemaCacheGauge().entries,
        getReturnAnnotationCacheGauge().entries
      ];
      await vscode.window.showInformationMessage(renderCacheClearedReport(
        gauges.map((gauge, i) => ({ label: gauge.label, before: before[i], after: after[i] }))
      ));
    }
  );
  context.subscriptions.push(clearCachesCommand);

  // profile 健康状态汇总(IDE-PRJ-009):缺引擎/缺解释器/缺语言服务/根歧义/
  // 索引停滞各带定位入口,活动 profile 经稳定 ID 解析(IDE-PRJ-010);
  // 索引状态与调度面同源(indexScheduler.getStatus,RUST-187)
  const profileHealthCommand = vscode.commands.registerCommand(
    'kbengine.profile.health',
    () =>
      showProfileHealthSummary(context, {
        indexStatus: () => indexScheduler.getStatus()
      })
  );
  context.subscriptions.push(profileHealthCommand);

  // 语言服务状态栏(RUST-219,旧 UI-002):Core/索引生命周期+engine profile+
  // 资源根+索引进度,单状态栏项。判定与 profile 健康汇总同源(索引计数=
  // indexScheduler.getStatus,RUST-187 同源探针;profile=resolveActiveProfile,
  // IDE-PRJ-010)。优先级 92 空档(server 100/telnet 99/热更 98/解释器 97/
  // 热更通道 96/日志 tail 95/核心 94/MCP 93)。触发=激活+活动 profile 切换+
  // kbengine.* 配置变化+保存文件(索引入队驱动)+根变化;忙碌期由控制器
  // 保活轮询(落定即停),不做逐键刷新。partial(部分索引)无数据面,
  // 纯核不冒充该态(如实三计数)。
  const languageServiceStatusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    92
  );
  const languageServiceStatus = new LanguageServiceStatusController({
    createItem: () => languageServiceStatusBarItem,
    collectInputs: () => {
      const profile = resolveActiveProfile(context.workspaceState);
      const status = indexScheduler.getStatus();
      return {
        profileName: profile?.displayName ?? null,
        resourceRoot: profile ? path.basename(profile.assetsRoot) : null,
        // SchedulerStatus.running 是活动任务对象(非计数),归一成 0/1;
        // 失败/排队沿用原计数(判定与 profile 健康汇总同口径)
        index: {
          failed: status.failed,
          queued: status.queued,
          running: status.running ? 1 : 0
        },
        // 索引建立时间行(批 B):调度器轮次时间戳同源透传,纯核只格式化
        lastBuildStartedAt: status.lastBuildStartedAt,
        lastBuildCompletedAt: status.lastBuildCompletedAt,
        // INDEX-DISCIPLINE-001:输入纪律观测行(合并器待合并+语法门拦截)
        indexDiscipline: deps.indexDisciplineStats ? deps.indexDisciplineStats() : null
      };
    },
    timers: {
      setInterval: (handler, ms) => setInterval(handler, ms),
      clearInterval: handle => clearInterval(handle as ReturnType<typeof setInterval>)
    }
  });
  context.subscriptions.push(languageServiceStatus);
  context.subscriptions.push(
    onDidChangeActiveProfile(() => languageServiceStatus.refresh()),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('kbengine')) {
        languageServiceStatus.refresh();
      }
    }),
    vscode.workspace.onDidSaveTextDocument(() => languageServiceStatus.refresh()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => languageServiceStatus.refresh())
  );

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
    // venv/Pylance 去重(2026-11-10 用户令;2026-11-17 收紧为安装即让位):
    // ms-python.python 自己在状态栏显示解释器选择器,已安装即隐藏本项——
    // 按 isActive 判会漏掉懒激活窗口(它未激活时我们先出镜,它激活后双份;
    // onDidChange 不发激活事件,补判无门);选择/创建 venv 仍经命令面板,
    // 不丢功能。
    const pythonExtInstalled =
      vscode.extensions.getExtension(PYTHON_INTERPRETER_EXTENSION_ID) !== undefined;
    if (!shouldShowInterpreterStatusBar(pythonExtInstalled)) {
      interpreterStatusBarItem.hide();
      return;
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    // KODE-RESP-010:解析走异步链——venv 扫描不卡扩展宿主主线程;与选择器/
    // profile 解析共享同一份在途发现与缓存(缓存热值即时返回,刷新不重扫)。
    const resolution = await resolveProfileInterpreterAsync(root);
    interpreterStatusBarItem.text = interpreterStatusBarText(resolution);
    interpreterStatusBarItem.tooltip = resolution.interpreterPath
      ? resolution.interpreterPath
      : l10nText('Python interpreter missing (click to select or create one)');
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
          openLabel: l10nText('Select the parent directory for the venv')
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
      // withProgress 返回 Thenable,await 归一成 Promise(依赖面签名);
      // RUST-222 补取消:令牌接子进程柄,取消=kill(半成品 venv 由验真面如实拒)
      runVenvModule: async (base, target) =>
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: l10nText('Creating venv: python -m venv {target}', { target }), cancellable: true },
          (_progress, token) =>
            new Promise<{ exitCode: number | null; stderr: string }>(resolve => {
              let child: ChildProcess | null = null;
              token.onCancellationRequested(() => child?.kill());
              runVenvModuleProcess(base, target, spawned => {
                child = spawned;
              }).then(resolve, resolve);
            })
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
        // KODE-RESP-010:current/discovered 接缓存异步发现——同键(根+约定名
        // 清单)与状态栏刷新共享一次在途扫描;缓存热值即时返回,QuickPick 先
        // 出已有候选;冷启动也只是一段带预算/让步的异步扫描,不卡命令线程。
        current: () => resolveProfileInterpreterAsync(root),
        discovered: () =>
          root ? discoverVenvsCached(root, { preferredNames: venvPreferredNames() }) : [],
        pathInterpreter: () => locateInterpreterOnPath(process.env.PATH, process.platform),
        showQuickPick: async items =>
          await vscode.window.showQuickPick(items, {
            placeHolder: l10nText('Select a Python interpreter (writes kbengine.python.interpreterPath, takes effect immediately)')
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
  // venv/Pylance 去重:Python 扩展安装/卸载/启用/禁用(onDidChange 的发火域,
  // 不含激活)都会改变安装事实,重评估隐藏/恢复本项;判据=安装态,激活窗口
  // 不产生双份。
  const interpreterExtListener = vscode.extensions.onDidChange(() => {
    void refreshInterpreterStatusBar();
  });
  context.subscriptions.push(
    selectInterpreterCommand,
    createVenvCommand,
    interpreterConfigListener,
    interpreterExtListener
  );
  void refreshInterpreterStatusBar();

  // .py lint via ruff(IDE-RUST-005,A 案 shell out):Rust 侧 `$/kode/ruff/lint`
  // 恒 --target-version py37 + --no-cache(不写工作区);缺 ruff 如实
  // available:false → 这里同意式 pip 安装(选定解释器),失败亮手动命令
  // (用户令 2026-11-06),绝不静默装。
  const ruffChannel = vscode.window.createOutputChannel('KBEngine Ruff');
  const ruffDiagnostics = vscode.languages.createDiagnosticCollection('kode-ruff');
  context.subscriptions.push(ruffChannel, ruffDiagnostics);

  // 批 A2(巡检单 kode-ruff-format-statusbar.md):工作区根 pyproject.toml
  // [tool.ruff] 引导——lint/format 首次执行前检测一次(会话内幂等:拒绝过
  // 不再问,已就绪不再检)。默认开启,`kbengine.ruff.ensureConfig` 可关;
  // 红线=绝不动已有 [tool.ruff];存疑追加面如实 unsafe 跳过。
  const ruffConfigEnsureDeps = {
    getSettingEnabled: () =>
      vscode.workspace.getConfiguration('kbengine.ruff').get<boolean>('ensureConfig', true),
    workspaceRoot: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null,
    rootFileExists: (name: string) => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      return root !== undefined && fs.existsSync(path.join(root, name));
    },
    readFileText: (name: string) => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (root === undefined) {
        return null;
      }
      try {
        return fs.readFileSync(path.join(root, name), 'utf8');
      } catch {
        return null;
      }
    },
    writeFileText: (name: string, content: string) => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (root === undefined) {
        return false;
      }
      try {
        fs.writeFileSync(path.join(root, name), content, 'utf8');
        return true;
      } catch {
        return false;
      }
    },
    showInformationMessage: (message: string, ...items: string[]) =>
      vscode.window.showInformationMessage(message, ...items)
  };
  // 共享接线:命令入口(lint/format)与生成器入口(codeGenerator)共用同一
  // 会话(跨入口「问过就记住」);生成器激活序在前,其生成期调用时已接线。
  wireSharedRuffConfigEnsure(ruffConfigEnsureDeps);
  const ensureRuffConfigOnce = () => ensureRuffConfigShared();

  // C-23 行为知识流水线(坑→lint/code action/hover):三规则(KBE-PY-015/
  // 016/017)独立诊断集合与 quick fix provider 自持装配(trapDiagnosticsWiring
  // 自带事件监听,不进主调度链);hover 行为注记在 languageProviders/hover.ts
  // self 属性悬停面接线。注册点放在全部既有诊断集合之后(集合创建序即
  // 注册表序,消费方按序取集合,不抢既有下标)
  wireTrapLintDiagnostics(context, entityMappingManager);
  // KODE-IDXREL-001 / KBE-PY-031 实体引用缓存诊断:独立集合,自持事件监听
  // (不进 trap Rust 聚合——应答面只认三条 code);注册点在 trap 之后
  wireEntityReferenceCacheDiagnostics(context, entityMappingManager);
  // KSEM-CFG-05 配置值校验诊断(独立集合 kbengine-config-value,自持监听,
  // 证据分级类型 Error/枚举 Warning/未知键 Information;注册点在全部既有
  // 诊断集合之后——集合创建序即注册表序,消费方按序取集合)
  wireConfigValueDiagnostics(context);
  const ruffLintDeps = {
    getWorkspacePythonFiles: async () => {
      // 2026-11-23 收窄令推广:KBEngine 扫描根存在时只收 scripts 下的 py;
      // 无根(真非 KBEngine python 工程)维持 workspace 全量,ruff 通用面不变。
      // P2 收口(2026-11-24):统一走 findFilesForKbengineSurfaces——锚点根
      // 先行与误配零文件 gate 收编进共享入口;本地三元在误配时会跌回
      // workspace 裸 glob 全盘扫,掩盖配置错误。legacyMaxResults 只作用于
      // 旧裸 glob 腿(RUFF_MAX_FILES+1 既有语义),收窄腿截断由 slice 维持。
      return (await findFilesForKbengineSurfaces('**/*.py', '**/node_modules/**', {
        legacyMaxResults: RUFF_MAX_FILES + 1
      }))
        .slice(0, RUFF_MAX_FILES + 1)
        .map(uri => uri.fsPath);
    },
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
    await ensureRuffConfigOnce();
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

  // 批 A(2026-11-18 巡检单 kode-ruff-format-statusbar.md):ruff format 一键
  // 格式化 + Provider 自动注册(不抢默认)。桥=backend/ruffFormat.ts
  // (`$/kode/ruff/format`),编排核零 vscode,此处只装配。ruff 定位与
  // ruffLint 同源:选定解释器 bin 下优先(ruffExePathForInterpreter),
  // PATH 回落在 Rust 侧。探测/格式化/Provider 同走 getRuffPath,防探测
  // 命中而格式化落空的半可用态。
  const ruffFormatDeps = {
    getActivePythonFile: () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'python' || editor.document.isClosed) {
        return null;
      }
      return { fileName: editor.document.fileName, content: editor.document.getText() };
    },
    applyFormattedText: (text: string) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }
      void editor.edit(builder => {
        const full = new vscode.Range(
          editor.document.positionAt(0),
          editor.document.positionAt(editor.document.getText().length)
        );
        builder.replace(full, text);
      });
    },
    getInterpreterPath: ruffLintDeps.getInterpreterPath,
    getRuffPath: () => {
      const interpreter = ruffLintDeps.getInterpreterPath();
      return interpreter ? ruffExePathForInterpreter(interpreter) : undefined;
    },
    runPipInstall: ruffLintDeps.runPipInstall,
    showInformationMessage: (message: string, ...items: string[]) =>
      vscode.window.showInformationMessage(message, ...items),
    showErrorMessage: async (message: string) => {
      await vscode.window.showErrorMessage(message);
    },
    channel: ruffChannel
  };
  const ruffFormatCommand = vscode.commands.registerCommand('kbengine.python.ruffFormat', async () => {
    await ensureRuffConfigOnce();
    await runRuffFormatCommand(ruffFormatDeps);
  });
  context.subscriptions.push(ruffFormatCommand);

  // 激活期探测注册(不阻塞激活):有 ruff → document/range 两 provider;
  // editor.defaultFormatter 未设才一次性提示「设为默认」,点才写,绝不自动改。
  void ensureRuffFormatterRegistered({
    probeRuffAvailable: async () => {
      const call = await runRuffFormat(
        'x = 1\n',
        '/__kode_ruff_format_probe__.py',
        ruffFormatDeps.getRuffPath()
      );
      return call.status === 'ok' && call.result.available;
    },
    registerDocumentFormattingEditProvider: (selector, provider) => {
      context.subscriptions.push(
        vscode.languages.registerDocumentFormattingEditProvider(
          selector as vscode.DocumentSelector,
          provider as vscode.DocumentFormattingEditProvider
        )
      );
    },
    registerDocumentRangeFormattingEditProvider: (selector, provider) => {
      context.subscriptions.push(
        vscode.languages.registerDocumentRangeFormattingEditProvider(
          selector as vscode.DocumentSelector,
          provider as vscode.DocumentRangeFormattingEditProvider
        )
      );
    },
    getDefaultFormatter: () =>
      vscode.workspace.getConfiguration('editor').get<string | undefined>('defaultFormatter'),
    setDefaultFormatter: () => {
      void vscode.workspace
        .getConfiguration('editor')
        .update('defaultFormatter', 'cuihairu.kode-kbengine', vscode.ConfigurationTarget.Global);
    },
    getRuffPath: ruffFormatDeps.getRuffPath,
    showInformationMessage: (message: string, ...items: string[]) =>
      vscode.window.showInformationMessage(message, ...items)
  }).catch(() => undefined);

  // KODE-SYN-006:.def 原生格式化(整文档 + 选区两面,核在 Rust 精确 span
  // 面)。无条件注册两面 provider,不抢 editor.defaultFormatter;
  // Rust 不可用时 provider 如实返回空编辑,不猜不半改。
  const defFormatProvider = new KBEngineDefFormatProvider();
  context.subscriptions.push(
    vscode.languages.registerDocumentFormattingEditProvider(
      defDocumentSelector,
      defFormatProvider
    ),
    vscode.languages.registerDocumentRangeFormattingEditProvider(
      defDocumentSelector,
      defFormatProvider
    )
  );

  // 激活期发现完成后自动落一份报告;有问题时提示用户到输出面板看/复制回传。
  // UX-REVIEW-002b/002c:同一流程喂给侧栏「开始」入口的可观察状态(识别中/
  // 未找到/失败/就绪,陈旧根结果一律弃置),识别失败不再是无声的
  // unhandled rejection——原代码 void promise 无 catch,失败路径全黑。
  const makeDiscoveryDeps = (root: string): DiscoveryPromptDeps | null => {
    const workspaceState = context.workspaceState;
    if (!workspaceState) {
      return null; // 测试替身/嵌入场景:静默跳过,不做磁盘级记忆(既有口径)
    }
    const discoveryStateKey = `kbengine.discovery.${root}`;
    return {
      showQuickPick: (items, title) =>
        vscode.window.showQuickPick(items, { placeHolder: title, ignoreFocusOut: true }),
      recall: () =>
        workspaceState.get<Partial<Record<DiscoveryKey, string>>>(discoveryStateKey),
      remember: (_root, choices) =>
        void workspaceState.update(discoveryStateKey, choices)
    };
  };
  const startEntryController = new StartEntryController({
    getWorkspaceRoot: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null,
    runDiscovery: async root => {
      const discoveryDeps = makeDiscoveryDeps(root);
      if (!discoveryDeps) {
        return; // 无 workspaceState:跳过询问流程,状态按扫描缓存直接推导
      }
      await runWorkspaceDiscovery(discoveryDeps, root);
    },
    onDiscoverySettled: (root, kind) => {
      // 既有口径恢复:旧代码在 context.workspaceState 缺失时整段发现面
      // (询问+报告+警告)都不跑——这里同样跳过,否则无 workspaceState 的
      // 宿主会多出发现警告(extension 测试替身即此形态)。
      if (!makeDiscoveryDeps(root)) {
        return;
      }
      // failed 不落报告——扫描本身刚抛错,再扫一遍只会二抛,详情在「开始」
      // 视图,修复后走「重新识别」。
      if (kind === 'failed') {
        return;
      }
      // 识别落地后自动落报告,有问题提示(根守卫保留,002a-1)
      if (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath !== root) { return; }
      const issueCount = writeDiscoveryReport(root);
      if (issueCount > 0) {
        vscode.window.showWarningMessage(
          l10nText('{count} discovery issues found; see the "{channel}" output panel', { count: issueCount, channel: DISCOVERY_REPORT_CHANNEL_NAME })
        );
      }
    },
    onDidChangeWorkspaceFolders: vscode.workspace.onDidChangeWorkspaceFolders,
    registerTreeDataProvider: provider =>
      vscode.window.registerTreeDataProvider('kbengine.start', provider),
    subscriptions: context.subscriptions
  });
  const retryDiscoveryCommand = vscode.commands.registerCommand(
    'kbengine.start.retryDiscovery',
    async () => {
      await startEntryController.retry();
    }
  );
  context.subscriptions.push(retryDiscoveryCommand);

  // 真机 NLS 探针(UX-REVIEW-010f / KODE-I18N 真机验收门):返回当前扩展
  // 上下文下一条运行时文案的取词结果。不在 contributes 声明=不出命令面板,
  // 仅供真机层 suite 经 executeCommand 验证「命令回调在被测扩展上下文里跑,
  // l10nText=产品同一条取词路径」(--bundlefallback 缺 key 回退走查面)。
  const l10nProbeCommand = vscode.commands.registerCommand(
    'kbengine.l10nProbe',
    (message: string, args?: Record<string, string | number | boolean>) => l10nText(message, args)
  );
  context.subscriptions.push(l10nProbeCommand);
  startEntryController.begin();
}
