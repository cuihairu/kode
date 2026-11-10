// SRC-001 L0 抽象层(KODE-ARCH 纯移动,零行为变更):组合根的基础设施激活器。
// 职责(分析文档 docs/design/src-001-extension-abstraction-layers.md L0):
// 启动占位视图(KB-GC-001)、引擎 API 目录、只读虚拟文档 provider(kbe 桩/
// 数据库 schema/模拟)、日志开关(jumpLog/annotationLog/mro/dataDict)、
// kode core 双轨切流门、文档选择器与文档形态谓词。
// 形态:deps 显式注入,共享实例与销毁句柄一并返回,销毁所有权仍由组合根
// 统一登记(activation 顺序由组合根调用点保持——本层必须是 activate 最前)。
import * as vscode from 'vscode';
import { setAnnotationSourceLogEnabled, setAnnotationSourceLogSink } from '../backend/annotationSourceLog';
import { KBENGINE_DATABASE_SIMULATION_SCHEME, KBEngineDatabaseSimulationProvider } from '../databaseSimulator';
import { setPythonDataDictIndexEnabled, setPythonMroJumpEnabled } from '../languageProviders';
import { KBEngineDatabaseSchemaProvider } from '../databaseSchemaPresentation';
import { buildEngineApiCatalog } from '../backend/engineApiMetadata';
import { setupKodeCoreGate } from '../kodeCoreGateWiring';
import { setupKodeServiceStatusBar } from './kodeServiceStatus';
import { discoverNativeBinary } from '../backend/nativeBinary';
import { KBE_SCHEME, appendEngineApiMetadata, buildKbeStubDocument } from '../kbeModuleIndex';
import { setJumpLogEnabled } from '../navigationLog';
import { ensureConfigResolved } from '../serverConfigResolve';
import { registerStartupViewPlaceholders } from '../startupViewPlaceholders';
import { setupProtocolTooling } from '../protocolTooling';
import { setupProtocolSchemaSync } from '../protocolSchemaSync';
import { setupProtocolPcapActions } from '../protocolPcapActions';
import { setupDefMd5Check } from '../defMd5Check';

// IDE-REV-037:注解来源日志的输出通道(懒建,首条日志到达才创建)
let annotationSourceChannel: vscode.OutputChannel | undefined;

export interface InfrastructureDeps {
  context: vscode.ExtensionContext;
}

/** L0 产出的共享实例/选择器/谓词——后续抽象层经组合根注入消费 */
export interface InfrastructureShared {
  /** kode core 双轨切流门:热更旁路的 rust 投递口(§11.3)经它走现有 LSP stdio */
  kodeCoreGate: ReturnType<typeof setupKodeCoreGate>;
  databaseSchemaProvider: KBEngineDatabaseSchemaProvider;
  databaseSimulationProvider: KBEngineDatabaseSimulationProvider;
  defDocumentSelector: ReadonlyArray<vscode.DocumentFilter | string>;
  definitionNavigationSelector: ReadonlyArray<vscode.DocumentFilter | string>;
  pythonDocumentSelector: ReadonlyArray<vscode.DocumentFilter | string>;
  /** 引擎 API 目录异步装配,消费面在用点经此读活值(与拆分前闭包读法一致) */
  getEngineApiCatalog(): Awaited<ReturnType<typeof buildEngineApiCatalog>> | null;
  isDefDocument(document: vscode.TextDocument): boolean;
  isEntitiesXmlDocument(document: vscode.TextDocument): boolean;
  isPythonDocument(document: vscode.TextDocument): boolean;
  isProcessTopologyManifestDocument(document: vscode.TextDocument): boolean;
}

export function activateInfrastructure(
  deps: InfrastructureDeps
): InfrastructureShared & { disposables: vscode.Disposable[] } {
  const { context } = deps;
  const disposables: vscode.Disposable[] = [];
  // KODE-PERF 视图先行(KB-GC-001):activate 最前(任何重活之前)为全部侧栏
  // 视图注册空占位 provider——宿主立即完成视图装配,不再报「There is no data
  // provider registered」;真 provider 在各自装配位随后注册,宿主同 id 重复
  // 注册=后到者接管,视图随之切到真数据源。装配晚段抛错/被拖死时视图仍已
  // 注册(显示空列表而非错误面板),不再卡在无提供者状态。
  disposables.push(
    registerStartupViewPlaceholders({
      registerTreeDataProvider: (viewId, provider) =>
        vscode.window.registerTreeDataProvider(viewId, provider)
    })
  );
  console.log('KBEngine Language Extension is now active!');
  const engineApiEnabled = vscode.workspace.getConfiguration('kbengine')
    .get<boolean>('python.apiMetadata', true);
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  let engineApiCatalog: Awaited<ReturnType<typeof buildEngineApiCatalog>> | null = null;
  if (engineApiEnabled) {
    const catalogPromise = buildEngineApiCatalog(workspaceRoot).then(catalog => {
      engineApiCatalog = catalog;
      return catalog;
    }).catch(() => null);
    void catalogPromise;
  }
  disposables.push(
    vscode.workspace.registerTextDocumentContentProvider(KBE_SCHEME, {
      provideTextDocumentContent(): string {
        const stub = buildKbeStubDocument();
        return engineApiCatalog
          ? appendEngineApiMetadata(stub.content, engineApiCatalog.metadata)
          : stub.content;
      }
    })
  );
  // 跳转决策路径日志开关(默认关闭;Settings 搜 kbengine.jumpLog 随时切换)
  setJumpLogEnabled(vscode.workspace.getConfiguration('kbengine').get<boolean>('jumpLog', false));
  // 注解来源日志开关(IDE-REV-037,默认关闭;Settings 搜 kbengine.annotationLog
  // 随时切换)——hover 推导答话把所用来源(文档桶/磁盘快照)落 KBEngine
  // Annotations 通道,sink 在此接线(日志模块本身不 import vscode)。
  setAnnotationSourceLogEnabled(vscode.workspace.getConfiguration('kbengine').get<boolean>('annotationLog', false));
  setAnnotationSourceLogSink(line => {
    annotationSourceChannel ??= vscode.window.createOutputChannel('KBEngine Annotations');
    annotationSourceChannel.appendLine(line);
  });
  // 层2 python-mro(mixin 函数导航)开关(默认开;Settings 搜 kbengine.python.enableMroJump 随时切换)
  setPythonMroJumpEnabled(vscode.workspace.getConfiguration('kbengine.python').get<boolean>('enableMroJump', true));
  // GLOBDATA-001:数据字典键索引开关(默认开;kbengine.python.enableDataDictIndex)
  setPythonDataDictIndexEnabled(
    vscode.workspace.getConfiguration('kbengine.python').get<boolean>('enableDataDictIndex', true)
  );
  // kode2 PR-012:双轨切流门(kill-switch/shadow;kbengine.core.backend 默认 ts,
  // Rust 仅影子比对不服务,默认装配下用户可见行为与纯 TS 单轨一致)。
  // 持有门实例:热更旁路的 rust 投递口(§11.3)要经它的 notifyFileChanged
  // 走现有 LSP stdio。
  const kodeCoreGate = setupKodeCoreGate(context);
  // 2026-11-10 用户令「如何提示 lsp 和 mcp 的状态是否开启」:Kode 核心(LSP
  // 服务轨道)与 Kode MCP 状态栏两项。核心读门状态(mode/serverPath),MCP 只
  // 做二进制在位探测(扩展不托管 MCP,未集成见 tooltip)。
  setupKodeServiceStatusBar(context, {
    getGateState: () => kodeCoreGate.state,
    probeMcpBinary: () => discoverNativeBinary(context.extensionUri.fsPath, 'kode-mcp')
  });
  // PA-007 第一增量:协议工具链检测命令(Wireshark/TShark/插件/CLI 版本
  // 面报告);通道与命令句柄自进 context.subscriptions,激活零开销。
  setupProtocolTooling(context);
  // PA-007 第二增量:协议 Schema 建图命令 + 协议文件监听自动重建
  // (schemaAutoBuild 默认开;激活不主动起子进程,通道与句柄自入 subscriptions)。
  setupProtocolSchemaSync(context);
  // PA-007 第三增量:一键开 PCAP(Wireshark GUI)+ 跑 TShark(CLI capture
  // analyze);对话框取消零动作,通道与命令句柄自入 subscriptions。
  setupProtocolPcapActions(context);
  // AUDIT-003:引擎 def MD5 核查入口(工作区闭包 ↔ SDK 盖章对拍);激活零
  // 开销,通道惰性建,命令句柄自入 subscriptions。
  setupDefMd5Check(context);
  // KODE-CFG-009:门接线后即预取 core 配置解析(`$/kode/config/resolve`),
  // 同步消费面(dbInterface/合成树/别名开关)读消费缓存不阻塞宿主。
  void ensureConfigResolved().catch(() => {});
  const databaseSchemaProvider = new KBEngineDatabaseSchemaProvider();
  disposables.push(
    vscode.workspace.registerTextDocumentContentProvider('kbengine-db-schema', databaseSchemaProvider),
    // AUD-056:provider 自身生命周期随 context 拆——关闭订阅与 onDidChange
    // 发射器在 deactivate 时释放,不跨激活泄漏
    databaseSchemaProvider
  );
  // 数据库模拟(批122):schema 快照之上的行模拟虚拟文档,scheme 与
  // databaseSchema 的 kbengine-db-schema 并列
  const databaseSimulationProvider = new KBEngineDatabaseSimulationProvider();
  disposables.push(
    vscode.workspace.registerTextDocumentContentProvider(
      KBENGINE_DATABASE_SIMULATION_SCHEME,
      databaseSimulationProvider
    )
  );
  // kbe 模块符号桩文档(批108):go-to-definition 的只读跳转源
  disposables.push(
    vscode.workspace.registerTextDocumentContentProvider(KBE_SCHEME, {
      provideTextDocumentContent(): string {
        const stub = buildKbeStubDocument();
        return engineApiCatalog
          ? appendEngineApiMetadata(stub.content, engineApiCatalog.metadata)
          : stub.content;
      }
    })
  );
  const defDocumentSelector: ReadonlyArray<vscode.DocumentFilter | string> = [
    { language: 'kbengine-def', scheme: 'file' },
    { scheme: 'file', pattern: '**/*.def' },
    { language: 'kbengine-def', scheme: 'untitled' }
  ];
  const kbengineXmlSelector: ReadonlyArray<vscode.DocumentFilter | string> = [
    { language: 'xml', scheme: 'file', pattern: '**/types.xml' },
    { language: 'xml', scheme: 'file', pattern: '**/entities.xml' }
  ];
  const definitionNavigationSelector: ReadonlyArray<vscode.DocumentFilter | string> = [
    ...defDocumentSelector,
    ...kbengineXmlSelector
  ];
  const pythonDocumentSelector: ReadonlyArray<vscode.DocumentFilter | string> = [
    { language: 'python', scheme: 'file' }
  ];

  const isDefDocument = (document: vscode.TextDocument): boolean =>
    document.languageId === 'kbengine-def' || document.fileName.toLowerCase().endsWith('.def');
  // entities.xml 清单诊断(source-analysis 设计 D3):与 .def 共用同一
  // 诊断 collection 与文档事件生命周期
  const isEntitiesXmlDocument = (document: vscode.TextDocument): boolean =>
    document.fileName.endsWith('entities.xml');
  // Python 侧诊断(receiver 可能为 None + 段错配,用户令 2026-10-27):与
  // .def/entities.xml 共用诊断 collection 与文档事件生命周期
  const isPythonDocument = (document: vscode.TextDocument): boolean =>
    document.languageId === 'python';
  // C-17:进程拓扑清单文件(workspace 根 process_topology.xml)。清单变更触发
  // 全量重排(拓扑是全局输入,单文件变更影响全部实体归属)。
  const isProcessTopologyManifestDocument = (document: vscode.TextDocument): boolean =>
    document.fileName.endsWith('process_topology.xml');

  return {
    disposables,
    kodeCoreGate,
    databaseSchemaProvider,
    databaseSimulationProvider,
    defDocumentSelector,
    definitionNavigationSelector,
    pythonDocumentSelector,
    getEngineApiCatalog: () => engineApiCatalog,
    isDefDocument,
    isEntitiesXmlDocument,
    isPythonDocument,
    isProcessTopologyManifestDocument
  };
}
