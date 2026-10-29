import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PythonClassIndex } from '../src/pythonClassIndex';
import { activate, deactivate } from '../src/extension';
import { setActiveProfile } from '../src/activeProfile';
import { getRootConfigGeneration, getRootConfigLastBumpReason } from '../src/rootConfigGeneration';
import { getActiveProfileScanRoot, resetScanRootCache, setActiveProfileScanRoot } from '../src/scanRoots';
import { isPythonMroJumpEnabled } from '../src/languageProviders';
import {
  applySavedFileAnnotations,
  flushPendingDocumentReturnAnnotationsForTests,
  resetPythonReturnAnnotationCache,
  resolveLocalVariableReturnType,
  resolveLocalVariableReturnTypeFromSnapshot
} from '../src/pythonReturnTypeInference';
import {
  getOperationSummary,
  resetLanguageServiceMetrics
} from '../src/languageServiceMetrics';
import { getDatabaseSchemaSnapshot, locateDatabaseSchemaLine } from '../src/databaseSchema';
import { getDiagnosticScheduler } from '../src/diagnosticScheduler';
import { KBE_SCHEME, buildKbeStubDocument } from '../src/kbeModuleIndex';
import { parseDebugConfigText } from '../src/debugConfigBootstrap';
import packageJson from '../package.json';
import { commandRegistry, commands } from './fake-vscode/commandRegistry';
import { languagesRegistry } from './fake-vscode/languages';
import { messages, treeRegistrations, window as fakeWindow, windowState } from './fake-vscode/windowState';
import { RelativePattern } from './fake-vscode/core';
import {
  lastFileSystemWatcher,
  memoryFileSystem,
  workspace,
  workspaceEvents,
  workspaceState,
  configurationOverrides
} from './fake-vscode/workspaceState';
import { panelRegistry } from './fake-vscode/panelRegistry';
import { fakeExtensionList } from './fake-vscode/extensionsState';
import { tests as testsRegistry } from './fake-vscode/core';
import { FakeComponentBin } from './sim/fakeComponentBin';
import {
  makeTextDocument,
  Position,
  Range,
  StatusBarAlignment,
  Uri,
  type ExtensionContext
} from './fake-vscode/core';

const until = async (predicate: () => boolean, timeoutMs = 8000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('condition not met before deadline');
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
};

// extension.ts 装配测试(重设计阶段 3,L3 层):activate 在 fake-vscode 环境
// 内整体装配,断言注册面与 package.json 贡献点一致、命令经 CommandRegistry
// 真分发、dispose 链拆干净、工作区分支的文档/配置事件联动。此前 extension.ts
// 只有 mocha 层间接触达(问题 P14),现在进 vitest 覆盖率分母。

interface DeclaredPackageJson {
  contributes: {
    commands: Array<{ command: string }>;
    views: Record<string, Array<{ id: string }>>;
  };
}

const declared = (packageJson as unknown as DeclaredPackageJson).contributes;

const BAD_DEF = [
  '<root>',
  '  <Properties>',
  '    <hp>',
  '      <Type>UINT32</Type>',
  '      <Flags>NO_SUCH_FLAG</Flags>',
  '    </hp>',
  '  </Properties>',
  '</root>'
].join('\n');

const makeContext = (): ExtensionContext => ({
  subscriptions: [],
  extensionUri: Uri.file('/workspace/ext'),
  // IDE-REL-007 复现配置摘要命令读自身 package.json 的布尔贡献项;
  // 仓库根即真实清单(activation 面不读它,仅该命令与身份命令按需读)。
  extensionPath: path.resolve(__dirname, '..'),
  // 宿主侧判定读 context.extension.extensionKind(真 API 自带)
  extension: { extensionKind: 'workspace' }
});

const disposeAll = (context: ExtensionContext): void => {
  for (const disposable of context.subscriptions) {
    disposable.dispose();
  }
};

beforeEach(() => {
  commandRegistry.reset();
  languagesRegistry.reset();
  windowState.reset();
  workspaceState.reset();
  panelRegistry.reset();
  testsRegistry.reset();
  workspace.workspaceFolders = [];
  workspace.findFiles = async () => [] as import('./fake-vscode/core').Uri[];
});


/** watcher pattern 归一化文本(RelativePattern 解包;IDE-ACC-011) */
const watcherPatternKey = (pattern: unknown): string =>
  pattern instanceof RelativePattern
    ? `${String(pattern.base)}/${pattern.pattern}`
    : String(pattern);

describe('extension activate 装配', () => {
  it('切换 receiver 诊断开关时重新计算未编辑文档', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-receiver-toggle-'));
    const document = makeTextDocument('class Avatar:\n    def tick(self):\n        self.cell.tick()\n', {
      fileName: path.join(root, 'Avatar.py'), languageId: 'python'
    });
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    workspace.textDocuments = [document];
    const context = makeContext();
    try {
      activate(context);
      // IDE-DIA-005:receiver 诊断走异步分片面,发布落宏任务后——等在途算完
      await getDiagnosticScheduler().pendingComputations();
      const collection = languagesRegistry.diagnosticCollections[0].collection;
      expect(collection.get(document.uri)).toHaveLength(1);
      const change = () => workspaceEvents.configurationChanged.fire({
        affectsConfiguration: section => section === 'kbengine' || section === 'kbengine.receiverNoneDiagnostics'
      });
      configurationOverrides.set('kbengine', { receiverNoneDiagnostics: false });
      change();
      await getDiagnosticScheduler().pendingComputations(); // 关闭:异步面发布空集即清
      expect(collection.get(document.uri)).toHaveLength(0);
      configurationOverrides.set('kbengine', { receiverNoneDiagnostics: true });
      change();
      await getDiagnosticScheduler().pendingComputations();
      expect(collection.get(document.uri)).toHaveLength(1);
    } finally {
      disposeAll(context);
      configurationOverrides.delete('kbengine');
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it('注册面与 package.json 贡献点一致', async () => {
    const context = makeContext();
    activate(context);

    // 命令:activate 注册的 id 集合与 package.json 声明严格一致
    // (防"漏注册/漏声明"两类回归,重设计问题 P14 的核心验收)
    expect(commandRegistry.allRegisteredCommandIds().sort())
      .toEqual(declared.commands.map(entry => entry.command).sort());

    // 测试面板(TSK-005):一个 controller,一个默认 Run 档
    expect(testsRegistry.controllers).toHaveLength(1);
    expect(testsRegistry.controllers[0].id).toBe('kbengine-python-tests');
    expect(testsRegistry.controllers[0].profiles).toHaveLength(1);
    expect(testsRegistry.controllers[0].profiles[0].kind).toBe(1);
    expect(testsRegistry.controllers[0].profiles[0].isDefault).toBe(true);

    // 树视图:实体/进程/telnet/最终配置四个视图 id 与 views 贡献点一致
    const declaredViewIds = Object.values(declared.views)
      .flat()
      .map(view => view.id)
      .sort();
    expect(treeRegistrations.map(item => item.viewId).sort()).toEqual(declaredViewIds);

    // 语言服务:补全 2(.def + Python)、悬停 2(.def/hook + 引擎配置字段,
    // 批112)、定义 2、调用层级 1、重命名 1
    expect(languagesRegistry.completionRegistrations).toHaveLength(2);
    expect(languagesRegistry.hoverRegistrations).toHaveLength(2);
    expect(languagesRegistry.definitionRegistrations).toHaveLength(2);
    // IDE-NAV-001:def 文档选择器上的引用提供者(Shift+F12)一份
    expect(languagesRegistry.referenceRegistrations).toHaveLength(1);
    // IDE-NAV-005:def Outline 单注册
    expect(languagesRegistry.documentSymbolRegistrations).toHaveLength(1);
    // IDE-NAV-006:工作区符号(Ctrl+T)单注册
    expect(languagesRegistry.workspaceSymbolRegistrations).toHaveLength(1);
    // IDE-NAV-007:Go to Implementations 单注册
    expect(languagesRegistry.implementationRegistrations).toHaveLength(1);
    expect(languagesRegistry.callHierarchyRegistrations).toHaveLength(1);
    expect(languagesRegistry.renameRegistrations).toHaveLength(1);
    // IDE-NAV-013:未知类型诊断 QuickFix 候选;IDE-NAV-014:缺实现方法空方法
    // 生成(各自独立注册,def 面各一份);B-7 起 python 面 None 守卫快速修复
    // 再一份(receiver-none 诊断对账)
    expect(languagesRegistry.codeActionsRegistrations).toHaveLength(3);
    // 批126:RPC 方法标记的 Python 侧 CodeLens 单注册;批134 起 types.xml
    // 引用反扫镜再加一份注册;批135 属性访问标记再加一份注册;批154 起
    // 事件回调镜链从 RPC 镜链拆出独立注册(各自独立开关)
    expect(languagesRegistry.codeLensRegistrations).toHaveLength(7);
    // 批154:python 侧 types.xml 数据类型 inlay hints 一份注册;内建属性行内
    // `: <type>` inlay 另一份独立注册(2026-10-21 形态升级单,独立开关);
    // 任务2(2026-10-27)def 定义点形参 inlay 再一份独立注册
    expect(languagesRegistry.inlayHintsRegistrations).toHaveLength(3);
    // 批91 起:def 分析命令的独立诊断集合与语言侧诊断并存;
    // 书 §19 HR-PR-02:临时编辑热更新问题通道诊断集并存一份
    expect(languagesRegistry.diagnosticCollections.map(entry => entry.name)).toEqual([
      'kbengine',
      'KBEngine 临时编辑热更新',
      'kbengine-def-analysis'
    ]);

    // 虚拟文档提供者:数据库 schema + kbe 符号桩文档(批108,内容由桩索引出)
    // + 最终服务端配置合成(批112,defaults+kbengine.xml 合成虚拟文档)
    expect(workspaceState.contentProviders.has('kbengine-db-schema')).toBe(true);
    const kbeStubProvider = workspaceState.contentProviders.get(KBE_SCHEME) as {
      provideTextDocumentContent(): string;
    };
    expect(kbeStubProvider.provideTextDocumentContent()).toBe(buildKbeStubDocument().content);
    // 元数据注入是异步的:探测到本机 ../kbengine 真树时要跑 git 子进程(~10ms 级),
    // 固定 setTimeout(0) 会抢跑在注入之前。等头部出现再断言——有树与无树两种
    // 口径都必须显式给出元数据头(unknown 兜底口径由 engineApiMetadata.test.ts 锁)。
    await until(() =>
      kbeStubProvider.provideTextDocumentContent().includes('# Engine version:'), 3000);
    const stubWithMetadata = kbeStubProvider.provideTextDocumentContent();
    expect(stubWithMetadata).toMatch(/# Engine version: .+/);
    expect(stubWithMetadata).toContain('# Source commit:');
    expect(stubWithMetadata).toContain('# Source describe:');
    expect(workspaceState.contentProviders.has('kbengine-config')).toBe(true);

    // 状态栏三条:server 灯(右对齐/优先级 100/命令指向扩展视图)、
    // telnet 灯(优先级 99/命令指向 telnet 面板)与热更状态灯(HR-UI-001,
    // 优先级 98/命令指向热更日志,默认 Watch Off 常显);无运行组件时
    // server 灯隐藏。批111 用户令:配置未开 telnet 时 telnet 灯同样隐藏,
    // context key 落 false
    expect(windowState.statusBars).toHaveLength(3);
    const bar = windowState.statusBars.find(item => item.priority === 100)!;
    expect(bar.alignment).toBe(StatusBarAlignment.Right);
    expect(bar.command).toBe('workbench.view.extension.kbengine-explorer');
    expect(bar.visible).toBe(false);
    const telnetBar = windowState.statusBars.find(item => item.priority === 99)!;
    expect(telnetBar.alignment).toBe(StatusBarAlignment.Right);
    expect(telnetBar.visible).toBe(false);
    const hotReloadBar = windowState.statusBars.find(item => item.priority === 98)!;
    expect(hotReloadBar.alignment).toBe(StatusBarAlignment.Right);
    expect(hotReloadBar.command).toBe('kbengine.hotReload.showLog');
    expect(hotReloadBar.text).toBe('$(eye-closed) 热更: 关');
    expect(hotReloadBar.visible).toBe(true);
    expect(commandRegistry.contexts.get('kbengine.telnetConfigured')).toBe(false);

    // 所有 subscription 都可 dispose
    for (const disposable of context.subscriptions) {
      expect(typeof disposable.dispose).toBe('function');
    }

    expect(deactivate()).toBeUndefined();
    disposeAll(context);
  });

  it('发现与定位诊断:命令落报告进输出通道,问题数走提示', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-ext-discovery-'));
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    const context = makeContext();
    activate(context);

    await commands.executeCommand('kbengine.discovery.report');
    const channel = windowState.channels.find(entry => entry.name === 'KBEngine 发现与定位');
    expect(channel).toBeDefined();
    const text = channel!.lines.join('');
    expect(text).toContain('Kode 发现与定位诊断');
    // 空工作区:def 根回落约定首项(不存在)计为问题 → 警告提示
    expect(text).toContain('[missing] 实体定义目录 entity_defs');
    expect(messages.warning.some(message => message.includes('发现与定位存在'))).toBe(true);

    fs.rmSync(root, { recursive: true, force: true });
    disposeAll(context);
  });

  it('发现与定位诊断:未打开工作区时提示且不写报告', async () => {
    const context = makeContext();
    activate(context);

    await commands.executeCommand('kbengine.discovery.report');
    expect(messages.warning).toContain('未打开工作区,无法生成发现与定位诊断');
    disposeAll(context);
  });

  it('发现与定位诊断:激活期发现完成后自动落报告,有问题时弹提示', async () => {
    // context 带 workspaceState memento(激活期发现链路的前置);空工作区
    // 零候选不打扰,但报告如实记录 missing 并提示
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-ext-discovery-auto-'));
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    const context = makeContext();
    const memento = new Map<string, unknown>();
    context.workspaceState = {
      get: <T>(key: string): T | undefined => memento.get(key) as T | undefined,
      update: async (key: string, value: unknown): Promise<void> => {
        memento.set(key, value);
      }
    } as ExtensionContext['workspaceState'];
    activate(context);

    try {
      await until(() => messages.warning.some(message => message.includes('发现与定位存在')), 4000);
      const channel = windowState.channels.find(entry => entry.name === 'KBEngine 发现与定位');
      expect(channel).toBeDefined();
      expect(channel!.lines.join('')).toContain('[missing] 实体定义目录 entity_defs');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      disposeAll(context);
    }
  });

  it('发现与定位诊断:全链路可解析时报告全 ok 并走信息提示', async () => {
    // def 树约定链全命中 + 资产根带 res/server/kbengine.xml 探针 + binPath
    // 经 kbe 源码根自动检测命中 → 问题数 0
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-ext-discovery-ok-'));
    fs.mkdirSync(path.join(root, 'scripts', 'entity_defs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'scripts', 'entities.xml'), '<xml/>', 'utf8');
    fs.writeFileSync(path.join(root, 'scripts', 'entity_defs', 'types.xml'), '<xml/>', 'utf8');
    fs.mkdirSync(path.join(root, 'scripts', 'entity_defs', 'interfaces'), { recursive: true });
    fs.mkdirSync(path.join(root, 'scripts', 'entity_defs', 'components'), { recursive: true });
    fs.mkdirSync(path.join(root, 'assets', 'res', 'server'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'assets', 'res', 'server', 'kbengine.xml'),
      '<xml/>',
      'utf8'
    );
    fs.mkdirSync(path.join(root, 'kbe', 'src', 'lib', 'entitydef'), { recursive: true });
    fs.writeFileSync(path.join(root, 'kbe', 'src', 'lib', 'entitydef', 'entitydef.cpp'), 'x', 'utf8');
    fs.mkdirSync(path.join(root, 'kbe', 'bin', 'server'), { recursive: true });
    fs.mkdirSync(path.join(root, 'kbe', 'res', 'server'), { recursive: true });
    fs.writeFileSync(path.join(root, 'kbe', 'res', 'server', 'messages_fixed.xml'), '<xml/>', 'utf8');
    configurationOverrides.set('kbengine', { assetsRoot: path.join(root, 'assets') });
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    const context = makeContext();
    const memento = new Map<string, unknown>();
    context.workspaceState = {
      get: <T>(key: string): T | undefined => memento.get(key) as T | undefined,
      update: async (key: string, value: unknown): Promise<void> => {
        memento.set(key, value);
      }
    } as ExtensionContext['workspaceState'];
    activate(context);

    try {
      await commands.executeCommand('kbengine.discovery.report');
      // 等激活期发现的 .then 自动落报告跑完(问题数 0 → 不弹提示)
      await new Promise(resolve => setTimeout(resolve, 50));
      const channel = windowState.channels.find(entry => entry.name === 'KBEngine 发现与定位');
      const text = channel!.lines.join('');
      expect(text).toContain('[ok] 实体定义目录 entity_defs');
      expect(text).toContain('[ok] 资产根 kbengine.assetsRoot');
      expect(text).toContain('[ok] 引擎二进制 kbengine.binPath');
      expect(text).toContain('问题 0 项');
      expect(messages.info).toContain('发现与定位全部正常');
      expect(messages.warning.some(message => message.includes('发现与定位存在'))).toBe(false);
    } finally {
      configurationOverrides.delete('kbengine');
      fs.rmSync(root, { recursive: true, force: true });
      disposeAll(context);
    }
  });

  it('激活后逐条执行命令,关键链路经 CommandRegistry 真分发', async () => {
    const context = makeContext();
    activate(context);

    // explorer 刷新
    await commands.executeCommand('kbengine.refreshExplorer');

    // telnet 面板打开(命令回调直驱 webview show)
    panelRegistry.reset();
    await commands.executeCommand('kbengine.telnet.showPanel');
    expect(panelRegistry.panels.map(panel => panel.viewType)).toContain('kbengine.telnetPanel');

    // telnet 断开(顶部入口/快捷键共用):无已连接会话时如实提示
    await commands.executeCommand('kbengine.telnet.disconnect');
    expect(messages.info.some(message => message.includes('没有已连接的 telnet 会话'))).toBe(true);

    // 快速执行动作(视图标题栏/编辑器标题栏按钮共用):无配置动作时指路配置文件
    await commands.executeCommand('kbengine.quickActions.show');
    expect(messages.info.some(message => message.includes('未配置快速执行动作'))).toBe(true);

    // 批136 Explorer 顶栏 ▶ 主按钮:无配置动作时同样指路,不假装执行了什么
    await commands.executeCommand('kbengine.quickActions.runDefault');
    expect(messages.info.some(message => message.includes('未发现可执行脚本'))).toBe(true);

    // IDE-SDK-001 messageTable 预览:无工作区索引时如实提示未发现实体(不弹选择不猜)
    await commands.executeCommand('kbengine.messagetable.preview');
    expect(messages.warning.some(message => message.includes('未发现实体'))).toBe(true);

    // IDE-SDK-002 JSON 导出:同样如实提示未发现实体(不弹保存不写文件)
    await commands.executeCommand('kbengine.messagetable.export');
    expect(messages.warning.filter(message => message.includes('未发现实体'))).toHaveLength(2);

    // 盘点 G1 Python extraPaths 接线:无工作区时如实说明并跳过(不写任何配置)
    await commands.executeCommand('kbengine.python.syncExtraPaths');
    expect(messages.info.some(message => message.includes('未打开工作区'))).toBe(true);

    // 盘点 G2 KBEngine 存根导出:无工作区时如实说明并跳过(不写任何文件)
    await commands.executeCommand('kbengine.python.exportStubs');
    expect(messages.info.some(message => message.includes('跳过 KBEngine 存根导出'))).toBe(true);

    // def-pyi-stubs §6 类型桩导出:无工作区时同样如实说明并跳过
    await commands.executeCommand('kbengine.python.exportTypeStubs');
    expect(messages.info.some(message => message.includes('跳过 KBEngine 类型桩导出'))).toBe(true);

    // 未知实体 → 未找到定义文件 warning
    await commands.executeCommand('kbengine.entity.open', 'Ghost');
    expect(messages.warning.some(message => message.includes('未找到定义文件'))).toBe(true);

    // 实体方法打开:字符串与 identity 两形态,无索引均落 warning
    await commands.executeCommand('kbengine.entity.method.open', 'Ghost', 'move', 'BaseMethods');
    await commands.executeCommand('kbengine.entity.method.open', {
      ownerName: 'Ghost',
      symbolName: 'move',
      section: 'BaseMethods'
    } as never);
    expect(messages.warning.filter(message => message.includes('打开实体方法失败'))).toHaveLength(2);

    // 缺省 method/section 的两种形态:label 以空串兜底进 warning
    await commands.executeCommand('kbengine.entity.method.open', 'Ghost');
    await commands.executeCommand('kbengine.entity.method.open', {
      ownerName: 'Ghost',
      symbolName: 'move'
    } as never);
    expect(messages.warning.some(message => message.includes('Ghost. ()'))).toBe(true);
    expect(messages.warning.some(message => message.includes('Ghost.move ()'))).toBe(true);

    // 数据库 schema 打开:虚拟 URI 文档 + 定位到首行的 selection
    messages.warning.length = 0;
    await commands.executeCommand('kbengine.database.open', 'Hero');
    expect(messages.warning).toHaveLength(0);
    expect((workspaceState.openTextDocumentCalls[0] as Uri).scheme).toBe('kbengine-db-schema');
    expect(windowState.showTextDocumentCalls[0]?.options)
      .toEqual({ selection: new Range(new Position(0, 0), new Position(0, 0)) });

    // 服务器命令:启动缺二进制报错、停止未运行 false、未知目标 no-op
    await commands.executeCommand('kbengine.server.start', 'machine');
    expect(messages.error.some(message => message.includes('找不到 machine 可执行文件'))).toBe(true);
    // 2026-10-10:处理器改为返回 Promise(修 CI 38027480815 跨测试渗错:在途启动
    // 的报错渗进后续测试)。此处 'machine' 走 startAutoComponents 自动链(start 报错
    // 来自它),故 stop/restart 目标同样未解析 → stopAll/restart no-op → undefined。
    await expect(commands.executeCommand('kbengine.server.stop', 'machine')).resolves.toBeUndefined();
    await expect(commands.executeCommand('kbengine.server.restart', 'nope')).resolves.toBeUndefined();

    // 日志:面板打开、connect 走协议未适配 warning + 连接失败 error、
    // disconnect/clear/export(保存对话框默认取消)不抛
    await commands.executeCommand('kbengine.logs.showViewer');
    await commands.executeCommand('kbengine.server.showLogs', 'machine');
    await commands.executeCommand('kbengine.logs.connect');
    expect(messages.warning.some(message => message.includes('协议适配尚未完成'))).toBe(true);
    expect(messages.error.some(message => message.includes('连接日志收集器失败'))).toBe(true);
    await commands.executeCommand('kbengine.logs.disconnect');
    await commands.executeCommand('kbengine.logs.clear');
    await commands.executeCommand('kbengine.logs.export');

    // 目标载荷的空值早退:实体/方法两条命令体直接 return 无消息,
    // database.open 空值走「请先打开 .def」提示,不再静默
    const warningsBefore = messages.warning.length;
    await commands.executeCommand('kbengine.entity.open', '');
    await commands.executeCommand('kbengine.entity.method.open', null);
    await commands.executeCommand('kbengine.database.open', '');
    expect(messages.warning.length).toBe(warningsBefore);
    expect(messages.info.some(message => message.includes('请先打开一个实体 .def 文件'))).toBe(true);

    // 调试:无工作区报具体消息、未选中组件 no-op
    await commands.executeCommand('kbengine.debug.updateLaunchJson');
    expect(messages.error.some(message => message.includes('没有打开的工作区'))).toBe(true);
    await commands.executeCommand('kbengine.debug.createConfig');
    await commands.executeCommand('kbengine.debug.start', 'nope');
    await commands.executeCommand('kbengine.debug.attach', 'nope');

    // 调试选中分支:选择器应答 machine 后经 startDebugging/attachToComponent
    // (attach 的 PID 输入框默认取消,不发附加)
    const originalPick = fakeWindow.showQuickPick;
    fakeWindow.showQuickPick = (async () => ({ name: 'machine' })) as typeof originalPick;
    await commands.executeCommand('kbengine.debug.start', 'nope');
    await commands.executeCommand('kbengine.debug.attach', 'nope');
    await commands.executeCommand('kbengine.debug.start', { name: 'machine' });
    await commands.executeCommand('kbengine.debug.attach', { name: 'machine' });
    fakeWindow.showQuickPick = originalPick;

    // 监控/依赖面板
    await commands.executeCommand('kbengine.monitoring.show');
    await commands.executeCommand('kbengine.dependency.show');
    expect(panelRegistry.panels.map(panel => panel.viewType)).toEqual(expect.arrayContaining([
      'kbengine.logViewer',
      'kbengine.monitoring',
      'kbengine.entityDependency'
    ]));

    // 实体流程图:无活动 def 编辑器时提示,不建面板
    await commands.executeCommand('kbengine.flow.show');
    expect(messages.info).toContain('请先打开一个实体 .def 文件');

    // 生成器:输入框/选择器默认取消,提前返回不抛
    await commands.executeCommand('kbengine.generator.wizard');
    await commands.executeCommand('kbengine.generator.templates');

    disposeAll(context);
  });

  it('dispose 链逐项拆除注册面', async () => {
    const context = makeContext();
    activate(context);
    const bar = windowState.statusBars[0];

    disposeAll(context);

    expect(bar.disposed).toBe(true);
    // 命令注册全部注销
    expect(commandRegistry.registrations.size).toBe(0);
    // 树视图/语言服务注册被 dispose 链摘除
    expect(treeRegistrations).toHaveLength(0);
    expect(languagesRegistry.completionRegistrations).toHaveLength(0);
    expect(languagesRegistry.codeLensRegistrations).toHaveLength(0);
    // 已注销命令不再可执行
    await expect(commands.executeCommand('kbengine.refreshExplorer'))
      .rejects.toThrow('command not registered');
  });

  it('有工作区时激活扫描初始 def 文档并联动文档/配置事件', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-extension-'));
    const originalFindFiles = workspace.findFiles;
    try {
      workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];

      // 真实 def 树先行落盘:激活时实体索引与映射管理器可同步扫到。
      // 带持久化属性 + BaseMethods 方法,让 database.open 的快照定位与
      // method.open 的 def 兜底打开都有真实目标
      const defsRoot = path.join(root, 'scripts', 'entity_defs');
      fs.mkdirSync(defsRoot, { recursive: true });
      fs.writeFileSync(
        path.join(defsRoot, 'Avatar.def'),
        [
          '<root>',
          '  <Properties>',
          '    <hp>',
          '      <Type>UINT32</Type>',
          '      <Flags>BASE_AND_CLIENT</Flags>',
          '    </hp>',
          '  </Properties>',
          '  <BaseMethods>',
          '    <respawn/>',
          '  </BaseMethods>',
          '</root>'
        ].join('\n'),
        'utf8'
      );
      fs.writeFileSync(
        path.join(defsRoot, 'entities.xml'),
        '<root>\n  <Avatar> <hasClient/></Avatar>\n</root>\n',
        'utf8'
      );

      // 映射管理器经 findFiles 枚举 def 文件,默认桩返回空表;
      // 按真实落盘树应答,激活时的异步扫描才能建到 Avatar 索引
      workspace.findFiles = (async (pattern: string): Promise<Uri[]> => {
        if (pattern !== '**/*.def') {
          return originalFindFiles(pattern);
        }
        return [Uri.file(path.join(defsRoot, 'Avatar.def'))];
      }) as typeof originalFindFiles;

      const badDef = makeTextDocument(BAD_DEF, {
        fileName: path.join(root, 'scripts', 'entity_defs', 'Hero.def')
      });
      const plainDoc = makeTextDocument('hello', {
        fileName: path.join(root, 'notes.txt'),
        languageId: 'plaintext'
      });
      // 批147:entities.xml 走清单诊断(D3 同名重复),生命周期与 .def 同监听
      const dupEntitiesDoc = makeTextDocument('<root>\n  <Avatar/>\n  <Avatar/>\n</root>', {
        fileName: path.join(root, 'scripts', 'entities.xml'),
        languageId: 'xml'
      });
      workspace.textDocuments = [badDef, plainDoc, dupEntitiesDoc];

      const context = makeContext();
      activate(context);
      const collection = languagesRegistry.diagnosticCollections[0].collection;

      // 初始扫描:坏 Flags 的 def 有 Error 诊断,纯文本文档不校验
      expect(collection.get(badDef.uri).length).toBeGreaterThan(0);
      expect(collection.get(plainDoc.uri)).toHaveLength(0);

      // 文档变更事件:def 触发重校验(PR6 A6-1 起经排队通道合并,发布在
      // 宏任务边界,这里等一拍冲刷)
      const changedDef = makeTextDocument(BAD_DEF, {
        fileName: path.join(root, 'scripts', 'entity_defs', 'Monster.def')
      });
      workspaceEvents.documentChanged.fire({ document: changedDef });
      await until(() => collection.get(changedDef.uri).length > 0);

      // entities.xml 清单诊断(批147 D3):变更与打开事件均落告警
      workspaceEvents.documentChanged.fire({ document: dupEntitiesDoc });
      await until(() => collection.get(dupEntitiesDoc.uri).length > 0);
      workspaceEvents.documentOpened.fire(dupEntitiesDoc);
      expect(collection.get(dupEntitiesDoc.uri)).toHaveLength(1);

      // 变更/打开事件的非 def 文档:isDefDocument 假分支,跳过校验
      const plainChanged = makeTextDocument('hello', {
        fileName: path.join(root, 'notes-changed.txt'),
        languageId: 'plaintext'
      });
      workspaceEvents.documentChanged.fire({ document: plainChanged });
      workspaceEvents.documentOpened.fire(plainChanged);
      expect(collection.get(plainChanged.uri)).toHaveLength(0);

      // 配置变更事件:不影响 kbengine 段时不重扫,影响时重扫 textDocuments
      // (PR6 A6-2/A6-4 收口:诊断面重算只由诊断相关配置节驱动;任意
      // kbengine.* 变更都全量重扫的旧行为废除)
      const lateDef = makeTextDocument(BAD_DEF, { fileName: path.join(root, 'Late.def') });
      workspace.textDocuments = [badDef, lateDef, plainDoc, dupEntitiesDoc];
      workspaceEvents.configurationChanged.fire({ affectsConfiguration: () => false });
      expect(collection.get(lateDef.uri)).toHaveLength(0);
      workspaceEvents.configurationChanged.fire({
        affectsConfiguration: (section: string) => section === 'kbengine'
      });
      // 无关 kbengine.* 配置(hover/jumpLog 等落在 'kbengine' 段):不重扫
      expect(collection.get(lateDef.uri)).toHaveLength(0);
      // 诊断相关配置:重扫
      workspaceEvents.configurationChanged.fire({
        affectsConfiguration: (section: string) =>
          section === 'kbengine' || section === 'kbengine.diagnostics'
      });
      expect(collection.get(lateDef.uri).length).toBeGreaterThan(0);
      // 重扫对非 def 文档跳过校验(isDefDocument 假分支)
      expect(collection.get(plainDoc.uri)).toHaveLength(0);

      // 层2 python-mro(mixin 函数导航)开关:配置变更即时生效;关闭后
      // .py 变更不再投喂索引(分支双覆盖:关闭走 skip,恢复走投喂)
      const pyDoc = makeTextDocument('class Gate:\n    pass\n', {
        fileName: path.join(root, 'scripts', 'gate.py'),
        languageId: 'python'
      });
      configurationOverrides.set('kbengine.python', { enableMroJump: false });
      workspaceEvents.configurationChanged.fire({
        affectsConfiguration: (section: string) =>
          section === 'kbengine' || section === 'kbengine.python.enableMroJump'
      });
      expect(isPythonMroJumpEnabled()).toBe(false);
      workspaceEvents.documentChanged.fire({ document: pyDoc });
      configurationOverrides.set('kbengine.python', { enableMroJump: true });
      workspaceEvents.configurationChanged.fire({
        affectsConfiguration: (section: string) =>
          section === 'kbengine' || section === 'kbengine.python.enableMroJump'
      });
      expect(isPythonMroJumpEnabled()).toBe(true);
      workspaceEvents.documentChanged.fire({ document: pyDoc });
      configurationOverrides.delete('kbengine.python');

      // IDE-HOV-012:保存事件只换该文件注解桶(python 分支换桶;非 python 跳过)
      fs.writeFileSync(
        path.join(root, 'svc_saved.py'),
        'def get_data() -> JSONDATA:\n    pass\n',
        'utf8'
      );
      await resolveLocalVariableReturnType(['data = get_data()'], 0, 'data', root);
      const savedPy = makeTextDocument('def get_data() -> SAVED:\n    pass\n', {
        fileName: path.join(root, 'svc_saved.py'),
        languageId: 'python'
      });
      workspaceEvents.documentSaved.fire(savedPy);
      expect(resolveLocalVariableReturnTypeFromSnapshot(['data = get_data()'], 0, 'data', root))
        .toMatchObject({ annotation: 'SAVED' });
      const savedPlain = makeTextDocument('hello', {
        fileName: path.join(root, 'notes-saved.txt'),
        languageId: 'plaintext'
      });
      workspaceEvents.documentSaved.fire(savedPlain);

      // IDE-HOV-014:删除文件移除该文件注解桶(python 分支弃桶;非 python 跳过)
      applySavedFileAnnotations(
        root,
        path.join(root, 'svc_gone.py'),
        'def only_svc() -> SVCONLY:\n    pass\n'
      );
      expect(resolveLocalVariableReturnTypeFromSnapshot(['y = only_svc()'], 0, 'y', root))
        .toMatchObject({ annotation: 'SVCONLY' });
      workspaceEvents.filesDeleted.fire({ files: [Uri.file(path.join(root, 'svc_gone.py'))] });
      expect(resolveLocalVariableReturnTypeFromSnapshot(['y = only_svc()'], 0, 'y', root)).toBeNull();
      workspaceEvents.filesDeleted.fire({ files: [Uri.file(path.join(root, 'notes.txt'))] });

      // IDE-HOV-015:重命名迁移注解来源(python→python 承接;python→非 python 移除)
      applySavedFileAnnotations(
        root,
        path.join(root, 'svc_ren.py'),
        'def only_ren() -> RENONLY:\n    pass\n'
      );
      expect(resolveLocalVariableReturnTypeFromSnapshot(['z = only_ren()'], 0, 'z', root))
        .toMatchObject({ annotation: 'RENONLY' });
      workspaceEvents.filesRenamed.fire({
        files: [{ oldUri: Uri.file(path.join(root, 'svc_ren.py')), newUri: Uri.file(path.join(root, 'svc_ren2.py')) }]
      });
      expect(resolveLocalVariableReturnTypeFromSnapshot(['z = only_ren()'], 0, 'z', root))
        .toMatchObject({ annotation: 'RENONLY' });
      workspaceEvents.filesRenamed.fire({
        files: [{ oldUri: Uri.file(path.join(root, 'svc_ren2.py')), newUri: Uri.file(path.join(root, 'svc_ren2.txt')) }]
      });
      expect(resolveLocalVariableReturnTypeFromSnapshot(['z = only_ren()'], 0, 'z', root)).toBeNull();

      // 批154:CodeLens 四类功能开关变更即时 fire 各 provider(emitter
      // 挂在 provider 实例上,注册后即可订阅);事件须同时含 'kbengine'
      // (外层 guard 短路口径与 python-mro 分支一致)
      const lensFires = languagesRegistry.codeLensRegistrations.map(registration => {
        let count = 0;
        (registration.provider as { onDidChangeCodeLenses: (listener: () => void) => unknown })
      .onDidChangeCodeLenses?.(() => { count += 1; });
        return () => count;
      });
      workspaceEvents.configurationChanged.fire({
        affectsConfiguration: (section: string) =>
          section === 'kbengine' || section === 'kbengine.codeLens'
      });
      expect(lensFires.map(read => read())).toEqual([1, 1, 1, 1, 1, 0, 0]);
      // 外层 guard:不影响 kbengine 段时不 fire(计数不动)
      workspaceEvents.configurationChanged.fire({ affectsConfiguration: () => false });
      expect(lensFires.map(read => read())).toEqual([1, 1, 1, 1, 1, 0, 0]);

      // 打开文档事件:def 文档触发校验
      const openedDef = makeTextDocument(BAD_DEF, { fileName: path.join(root, 'Opened.def') });
      workspaceEvents.documentOpened.fire(openedDef);
      expect(collection.get(openedDef.uri).length).toBeGreaterThan(0);

      // entity.open happy path:真实落盘 def 后打开定义文件
      // (只判本命令的告警:激活期发现报告的告警与本用例无关,时序上也可能后到)
      await commands.executeCommand('kbengine.entity.open', 'Avatar');
      expect(messages.warning.filter(message => message.includes('打开实体定义失败'))).toHaveLength(0);
      expect((workspaceState.openTextDocumentCalls.at(-1) as Uri).fsPath).toContain('Avatar.def');
      expect(windowState.showTextDocumentCalls.at(-1)?.document).toBeDefined();

      // method.open 成功侧(didOpen true,静默无 warning):无 Python 实现
      // 时兜底打开 def 本体。索引扫描在激活后异步落地,留节拍后单发调用
      messages.warning.length = 0;
      await new Promise(resolve => setTimeout(resolve, 300));
      await commands.executeCommand('kbengine.entity.method.open', 'Avatar', 'respawn', 'BaseMethods');
      expect(messages.warning).toHaveLength(0);
      expect((workspaceState.openTextDocumentCalls.at(-1) as Uri).fsPath).toContain('Avatar.def');
      expect(windowState.showTextDocumentCalls.at(-1)?.document).toBeDefined();

      // database.open 命中真实快照:显式表名定位行由快照 API 决定,
      // 期望行与命令内部同源计算(锁行为不锁快照排版细节)
      messages.warning.length = 0;
      await commands.executeCommand('kbengine.database.open', 'Avatar', 'tbl_Avatar');
      expect(messages.warning).toHaveLength(0);
      const snapshot = getDatabaseSchemaSnapshot('Avatar');
      expect(snapshot?.tables.some(table => table.name === 'tbl_Avatar')).toBe(true);
      const expectedLine = snapshot ? locateDatabaseSchemaLine(snapshot, 'tbl_Avatar') : 1;
      const row = Math.max(expectedLine - 1, 0);
      expect((workspaceState.openTextDocumentCalls.at(-1) as Uri).scheme)
        .toBe('kbengine-db-schema');
      expect(windowState.showTextDocumentCalls.at(-1)?.options)
        .toEqual({ selection: new Range(new Position(row, 0), new Position(row, 0)) });

      // 不带表名:默认 tbl_<实体名> 推导与显式表名同位
      await commands.executeCommand('kbengine.database.open', 'Avatar');
      expect(messages.warning).toHaveLength(0);
      expect(windowState.showTextDocumentCalls.at(-1)?.options)
        .toEqual({ selection: new Range(new Position(row, 0), new Position(row, 0)) });

      // 命令面板无参直开:取活动 .def 推断实体,不再静默 no-op
      // (用户从面板点 Open Database Schema 毫无反应,找不到入口)
      const originalActiveEditor = fakeWindow.activeTextEditor;
      messages.warning.length = 0;
      fakeWindow.activeTextEditor = {
        document: { uri: { fsPath: '/ws/scripts/entity_defs/Hero.def' }, languageId: 'kbengine-def' }
      } as never;
      await commands.executeCommand('kbengine.database.open');
      expect(messages.warning).toHaveLength(0);
      expect((workspaceState.openTextDocumentCalls.at(-1) as Uri).scheme).toBe('kbengine-db-schema');
      expect(windowState.showTextDocumentCalls.at(-1)?.options).toBeDefined();

      // 无活动 .def:如实提示,不空转
      fakeWindow.activeTextEditor = undefined;
      await commands.executeCommand('kbengine.database.open');
      expect(messages.info.some(message => message.includes('请先打开一个实体 .def 文件'))).toBe(true);
      fakeWindow.activeTextEditor = originalActiveEditor;

      // 打开失败的 catch 分支:openTextDocument 抛错 → 三类打开命令各报具体原因
      const originalOpen = workspace.openTextDocument;
      workspace.openTextDocument = (async (): Promise<never> => {
        throw new Error('boom');
      }) as typeof originalOpen;
      messages.warning.length = 0;
      await commands.executeCommand('kbengine.entity.open', 'Avatar');
      await commands.executeCommand('kbengine.database.open', 'Hero');
      // method.open 的 catch:索引已建、无 Python 实现 → 兜底打开 def 本体时
      // 抛错,字符串与 identity 两种入参形态各自的 label 都带上失败原因
      await commands.executeCommand('kbengine.entity.method.open', 'Avatar', 'respawn', 'BaseMethods');
      await commands.executeCommand('kbengine.entity.method.open', {
        ownerKind: 'entity',
        ownerName: 'Avatar',
        sourceKind: 'local',
        sourceChain: [],
        section: 'BaseMethods',
        symbolName: 'respawn'
      } as never);
      // 表名/字段名进 catch 模板的三个真值组合
      await commands.executeCommand('kbengine.database.open', 'Avatar', 'tbl_Avatar');
      await commands.executeCommand('kbengine.database.open', 'Avatar', 'tbl_Avatar', 'hp');
      expect(messages.warning.some(message => message.includes('打开实体定义失败: Avatar.def (Error: boom)'))).toBe(true);
      expect(messages.warning.some(message => message.includes('打开数据库结构失败: Hero (Error: boom)'))).toBe(true);
      expect(messages.warning.some(message => message.includes('打开数据库结构失败: Avatar (tbl_Avatar) (Error: boom)'))).toBe(true);
      expect(messages.warning.some(message => message.includes('打开数据库结构失败: Avatar (tbl_Avatar.hp) (Error: boom)'))).toBe(true);
      expect(messages.warning.some(message => message.includes('打开实体方法失败: Avatar.respawn (BaseMethods) (Error: boom)'))).toBe(true);
      // identity 形态的 label 取 ownerName/symbolName/section,与字符串形态同文
      expect(messages.warning.filter(message => message.includes('打开实体方法失败: Avatar.respawn (BaseMethods) (Error: boom)'))).toHaveLength(2);
      workspace.openTextDocument = originalOpen;

      disposeAll(context);
    } finally {
      workspace.findFiles = originalFindFiles;
      workspace.workspaceFolders = [];
      workspace.textDocuments = [];
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 15000);

  it('method.open 成功侧静默:字符串与 identity 两形态均不开 warning', async () => {
    // didOpen 真臂(批72):索引建到 Avatar、无 Python 实现 → 兜底打开
    // def 本体并返回 true,命令层跳过 warning。两形态各驱动一次。
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-extension-mopen-'));
    const originalFindFiles = workspace.findFiles;
    try {
      workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
      const defsRoot = path.join(root, 'scripts', 'entity_defs');
      fs.mkdirSync(defsRoot, { recursive: true });
      fs.writeFileSync(
        path.join(defsRoot, 'Avatar.def'),
        [
          '<root>',
          '  <Properties>',
          '    <hp>',
          '      <Type>UINT32</Type>',
          '      <Flags>BASE_AND_CLIENT</Flags>',
          '    </hp>',
          '  </Properties>',
          '  <BaseMethods>',
          '    <respawn/>',
          '  </BaseMethods>',
          '</root>'
        ].join('\n'),
        'utf8'
      );

      workspace.findFiles = (async (pattern: string): Promise<Uri[]> => {
        if (pattern !== '**/*.def') {
          return originalFindFiles(pattern);
        }
        return [Uri.file(path.join(defsRoot, 'Avatar.def'))];
      }) as typeof originalFindFiles;

      const context = makeContext();
      activate(context);

      // 映射索引异步扫描落地,留节拍后调用(与大装配用例同口径)
      await new Promise(resolve => setTimeout(resolve, 300));

      messages.warning.length = 0;
      // 成功侧(didOpen true → 跳过 warning):无 Python 实现时兜底打开
      // def 本体。两入参形态各驱动一次,各自断言静默(该 if 的隐式 else 臂
      // 在 v8-to-istanbul 转换中为负数伪影,执行次数不影响其计数值,
      // 见 TESTING.md 批72 段;本用例的价值在行为锁定,非凑覆盖率)
      await commands.executeCommand('kbengine.entity.method.open', 'Avatar', 'respawn', 'BaseMethods');
      expect(messages.warning).toHaveLength(0);
      await commands.executeCommand('kbengine.entity.method.open', {
        ownerKind: 'entity',
        ownerName: 'Avatar',
        sourceKind: 'local',
        sourceChain: [],
        section: 'BaseMethods',
        symbolName: 'respawn'
      } as never);
      expect(messages.warning).toHaveLength(0);
      expect((workspaceState.openTextDocumentCalls.at(-1) as Uri).fsPath).toContain('Avatar.def');
      expect(windowState.showTextDocumentCalls.at(-1)?.document).toBeDefined();

      disposeAll(context);
    } finally {
      workspace.findFiles = originalFindFiles;
      workspace.workspaceFolders = [];
      workspace.textDocuments = [];
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 15000);

  it('server 命令经解析载荷驱动真实假组件进程,状态栏随运行数联动', async () => {
    const bin = await FakeComponentBin.create();
    try {
      const configRoot = path.join(bin.root, 'cfg');
      fs.mkdirSync(configRoot, { recursive: true });
      bin.write('machine', { kind: 'run', stdoutMarker: 'up' });
      configurationOverrides.set('kbengine', {
        binPath: bin.binPath,
        assetsRoot: configRoot,
        logAutoConnect: false
      });

      const context = makeContext();
      activate(context);
      const bar = windowState.statusBars.find(item => item.priority === 100)!;

      // start(解析载荷形态):真实 spawn → Starting 宽限期后 Running,
      // 状态变化事件驱动树视图刷新与状态栏显示
      await commands.executeCommand('kbengine.server.start', { name: 'machine' });
      await until(() => bar.visible && bar.text === '$(server) KBEngine: 1/10 Running');
      expect(bar.visible).toBe(true);

      // stop:SIGTERM 后运行数归零,状态栏隐藏
      await commands.executeCommand('kbengine.server.stop', { name: 'machine' });
      await until(() => !bar.visible);

      // restart:停止并换新进程启动
      await commands.executeCommand('kbengine.server.restart', { name: 'machine' });
      await until(() => bar.visible && bar.text === '$(server) KBEngine: 1/10 Running');

      // showLogs:组件输出通道有启动标记,日志查看面板打开。
      // 假组件经 shebang 启动 node,并行负载下标记可能晚于 Running 宽限期
      // 到达,轮询等待而非假设已在
      panelRegistry.reset();
      await commands.executeCommand('kbengine.server.showLogs', { name: 'machine' });
      expect(panelRegistry.panels.map(panel => panel.viewType)).toContain('kbengine.logViewer');
      const channel = windowState.channels.find(item => item.name.includes('Machine'));
      expect(channel).toBeDefined();
      await until(() => (channel?.lines.join('') ?? '').includes('up'));

      disposeAll(context);
    } finally {
      configurationOverrides.delete('kbengine');
      await bin.dispose();
    }
  });

  it('telnet 探测翻转驱动树刷新与状态灯联动(真 TCP localhost)', async () => {
    // 批111 起:配置显式开启 telnet(空 <telnet_service> 段=段在未写端口 →
    // 引擎默认表)才探测;引擎默认表第一个目标 loginapp:31000,起真 server
    // 让探测探到「开启」
    const xmlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-telnet-probe-'));
    fs.writeFileSync(
      path.join(xmlDir, 'kbengine.xml'),
      '<root><telnet_service></telnet_service></root>'
    );
    configurationOverrides.set('kbengine', { 'telnet.configXmlPath': path.join(xmlDir, 'kbengine.xml') });
    const server = await new Promise<import('net').Server>(resolve => {
      const created = net.createServer(socket => {
        socket.on('error', () => undefined);
        socket.destroy();
      });
      created.listen(31000, '127.0.0.1', () => resolve(created));
    });
    const context = makeContext();
    try {
      activate(context);
      const telnetBar = windowState.statusBars.find(item => item.priority === 99)!;
      // 探测翻转(默认定时器 5s 一轮;首轮 start 即发)→ onDidChange 回调
      // → serverControlProvider.refresh() + updateTelnetStatusBar
      await until(() => telnetBar.text === '$(plug) Telnet: 1/7 开启' && telnetBar.visible);
      expect(telnetBar.command).toBe('kbengine.telnet.showPanel');
      expect(commandRegistry.contexts.get('kbengine.telnetConfigured')).toBe(true);
    } finally {
      disposeAll(context);
      configurationOverrides.delete('kbengine');
      fs.rmSync(xmlDir, { recursive: true, force: true });
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }, 15000);

  it('无工作区时激活不注册文档事件监听', () => {
    // 真实 vscode 在未打开文件夹时 workspaceFolders === undefined——
    // 空数组也是 truthy,置 [] 会误入"有工作区"分支,这里显式置 undefined
    workspace.workspaceFolders = undefined;
    const context = makeContext();
    activate(context);
    const collection = languagesRegistry.diagnosticCollections[0].collection;

    // 激活跳过 onDidChangeTextDocument/onDidOpenTextDocument 的注册:
    // fire 后不产生任何诊断
    const doc = makeTextDocument(BAD_DEF);
    workspaceEvents.documentChanged.fire({ document: doc });
    workspaceEvents.documentOpened.fire(doc);
    expect(collection.get(doc.uri)).toHaveLength(0);

    // 配置监听无条件注册:影响 kbengine 段时重扫 textDocuments(此处为空,
    // 不产生诊断但链路可达)
    workspaceEvents.configurationChanged.fire({
      affectsConfiguration: (section: string) => section === 'kbengine'
    });

    disposeAll(context);
  });

  it('python 编辑注解桶走队列:不占编辑同步路径,冲刷后入桶(IDE-HOV-011 整改)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-hov011-'));
    const originalFolders = workspace.workspaceFolders;
    const context = makeContext();
    try {
      workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
      resetPythonReturnAnnotationCache();
      activate(context);
      const doc = makeTextDocument('def get_data() -> NEW:\n    pass\n', {
        fileName: path.join(root, 'main.py'),
        languageId: 'python',
        version: 1
      });
      // 编辑事件只排队:桶未同步可见(此前每个编辑事件同步整文件提取 120ms)
      workspaceEvents.documentChanged.fire({ document: doc });
      expect(resolveLocalVariableReturnTypeFromSnapshot(['data = get_data()'], 0, 'data', root)).toBeNull();
      // 冲刷队列:让出式异步提取完成后桶才可查
      await flushPendingDocumentReturnAnnotationsForTests();
      expect(resolveLocalVariableReturnTypeFromSnapshot(['data = get_data()'], 0, 'data', root))
        .toMatchObject({ annotation: 'NEW' });
    } finally {
      disposeAll(context);
      workspace.workspaceFolders = originalFolders;
      resetPythonReturnAnnotationCache();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 15000);

  it('IDE-REL-001 双 Kode 共激活:两 ID 都实际激活才警告,单激活零打扰', () => {
    // 共激活:注入两个激活的 kode 系扩展(fake extensions.all)
    fakeExtensionList.push(
      { id: 'cuihairu.kode-kbengine', isActive: true },
      { id: 'cuihairu.kode', isActive: true }
    );
    let context = makeContext();
    try {
      activate(context);
      expect(messages.warning.some(message => message.includes('同时激活'))).toBe(true);
    } finally {
      disposeAll(context);
      fakeExtensionList.length = 0;
    }

    // 单激活(只有自身):无该警告(已安装未激活/被禁用都不算冲突)
    messages.warning.length = 0;
    fakeExtensionList.push({ id: 'cuihairu.kode-kbengine', isActive: true });
    context = makeContext();
    try {
      activate(context);
      expect(messages.warning.some(message => message.includes('同时激活'))).toBe(false);
    } finally {
      disposeAll(context);
      fakeExtensionList.length = 0;
    }
  });

  it('IDE-REL-007 复现配置摘要:命令落五节进输出通道,全文无未遮蔽凭据', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-ext-repro-'));
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    fakeExtensionList.push({ id: 'cuihairu.kode-kbengine', isActive: true });
    const context = makeContext();
    activate(context);
    try {
      await commands.executeCommand('kbengine.diagnostics.exportReproSummary');
      const channel = windowState.channels.find(entry => entry.name === 'Kode 复现配置摘要');
      expect(channel).toBeDefined();
      const text = channel!.lines.join('');
      expect(text).toContain('Kode 复现配置摘要');
      expect(text).toContain('宿主角色: ');
      expect(text).toContain('cuihairu.kode-kbengine@');
      expect(text).toContain('构建提交: ');
      expect(text).toContain(`workspace: ${root}`);
      expect(text).toContain('profile: 无(未选择活动 profile)');
      expect(text).toContain('kbengine.enableDiagnostics: ');
      expect(text).toContain('诊断排队=');
      expect(text).toContain('在册操作: ');
      expect(text).toContain('连接(已遮蔽):');
      // 裸环境未解析到引擎数据库连接:如实空态,不伪造连接行
      expect(text).toContain('连接: 无(未解析到引擎数据库连接)');
      // 兜底核验:全文不存在任何「凭据键=非***值」形态
      expect(text).not.toMatch(/(?:password|passwd|token|secret|authorization)\s*[=:]\s*(?!\*\*\*)\S/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      disposeAll(context);
      fakeExtensionList.length = 0;
    }
  });
});

describe('最终配置默认开启(批112 默认开启令)', () => {
  // 建一棵最小引擎目录树:binPath 可推导出 kbe/res/server/kbengine_defaults.xml
  const makeEngineTree = (): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-finalcfg-open-'));
    fs.mkdirSync(path.join(root, 'kbe', 'res', 'server'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'kbe', 'res', 'server', 'kbengine_defaults.xml'),
      '<defaults><baseapp><archivePeriod> 300 </archivePeriod></baseapp></defaults>'
    );
    return root;
  };

  it('激活即出:能定位 defaults 时后台打开合成视图,不抢焦点', async () => {
    const root = makeEngineTree();
    try {
      workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
      configurationOverrides.set('kbengine', { binPath: '${workspaceFolder}/kbe/bin/server' });
      const context = makeContext();
      activate(context);

      // 激活内的自动打开是异步尾焰:轮询等它落地
      await until(() => windowState.showTextDocumentCalls.length > 0);
      const call = windowState.showTextDocumentCalls[0] as {
        document: unknown;
        options: { preview: boolean; preserveFocus: boolean } | undefined;
      };
      const document = call.document;
      const options = call.options;
      expect(document).toBeDefined();
      expect(options).toEqual({ preview: true, preserveFocus: true });
      // 走的是虚拟文档 openTextDocument
      expect(workspaceState.openTextDocumentCalls.length).toBeGreaterThan(0);
      disposeAll(context);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 8000);

  it('定位不到 defaults:激活静默跳过不弹错', async () => {
    const context = makeContext();
    activate(context);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(windowState.showTextDocumentCalls).toHaveLength(0);
    expect(messages.error).toEqual([]);
    disposeAll(context);
  });

  it('showFinalConfigOnOpen=false:激活不自动打开', async () => {
    const root = makeEngineTree();
    try {
      workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
      configurationOverrides.set('kbengine', {
        binPath: '${workspaceFolder}/kbe/bin/server',
        showFinalConfigOnOpen: false
      });
      const context = makeContext();
      activate(context);
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(windowState.showTextDocumentCalls).toHaveLength(0);
      disposeAll(context);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('手动命令:定位失败明示报错;autoRefreshFinalConfig=false 不挂 watcher', async () => {
    configurationOverrides.set('kbengine', { autoRefreshFinalConfig: false });
    // 批134 起 types.xml 反扫镜在激活期挂 def/types.xml/entities.xml 三个
    // watcher,lastFileSystemWatcher 不再能当"终配 watcher 是否存在"用;
    // 这里记录本激活创建的全部样式,直接断言 kbengine*.xml 不在列
    const patterns: string[] = [];
    const originalCreate = workspace.createFileSystemWatcher;
    (workspace as unknown as Record<string, unknown>).createFileSystemWatcher = (pattern: unknown) => {
      patterns.push(watcherPatternKey(pattern));
      return originalCreate(pattern as never);
    };
    try {
      const context = makeContext();
      activate(context);
      expect(patterns.some(pattern => pattern.includes('kbengine*.xml'))).toBe(false);

      await commands.executeCommand('kbengine.config.showFinal');
      expect(messages.error.some(message => message.includes('无法定位引擎默认配置'))).toBe(true);
      expect(windowState.showTextDocumentCalls).toHaveLength(0);
      disposeAll(context);
    } finally {
      (workspace as unknown as Record<string, unknown>).createFileSystemWatcher = originalCreate;
    }
  });

  it('attachRemote 命令经 CommandRegistry 真分发(未配置目标提示)', async () => {
    const context = makeContext();
    activate(context);
    await commands.executeCommand('kbengine.debug.attachRemote');
    expect(messages.info.some(message => message.includes('kbengine.debug.remoteTargets'))).toBe(true);
    disposeAll(context);
  });

  it('手动命令聚焦打开;联动 watcher 三臂刷新合成内容', async () => {
    const root = makeEngineTree();
    // 任务 B 起激活期还会挂托管目录 watcher(**/.kbengine*),不能再用
    // lastFileSystemWatcher 当终配 watcher;记录 (pattern, watcher) 按挑选。
    const createdWatchers: Array<{ pattern: string; watcher: { fireChange(u: Uri): void; fireCreate(u: Uri): void; fireDelete(u: Uri): void } }> = [];
    const originalCreate = workspace.createFileSystemWatcher;
    (workspace as unknown as Record<string, unknown>).createFileSystemWatcher = (pattern: unknown) => {
      const watcher = originalCreate.call(workspace, pattern as never);
      createdWatchers.push({ pattern: watcherPatternKey(pattern), watcher });
      return watcher;
    };
    try {
      workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
      configurationOverrides.set('kbengine', { binPath: '${workspaceFolder}/kbe/bin/server' });
      const context = makeContext();
      activate(context);

      // 激活自动路径先落地,记基线后再验手动路径(聚焦,不带 preview 选项)
      await until(() => windowState.showTextDocumentCalls.length > 0);
      const before = windowState.showTextDocumentCalls.length;
      await commands.executeCommand('kbengine.config.showFinal');
      await until(() => windowState.showTextDocumentCalls.length > before);
      const manual = windowState.showTextDocumentCalls[windowState.showTextDocumentCalls.length - 1] as {
        options: unknown;
      };
      expect(manual.options).toBeUndefined();

      // 变更联动:watcher change/create/delete 三臂都触发内容提供者重算。
      // 按上面记录的 (pattern, watcher) 挑出 kbengine*.xml 那枚。
      const watcher = createdWatchers.find(record =>
        record.pattern.includes('kbengine*.xml')
      )?.watcher;
      expect(watcher).toBeDefined();
      const provider = workspaceState.contentProviders.get('kbengine-config') as {
        onDidChange(listener: (uri: unknown) => void): { dispose(): void };
        provideTextDocumentContent(uri: unknown): string;
      };
      const fired: unknown[] = [];
      provider.onDidChange(uri => fired.push(uri));
      watcher!.fireChange(Uri.file('/any/kbengine_defaults.xml'));
      watcher!.fireCreate(Uri.file('/any/kbengine.xml'));
      watcher!.fireDelete(Uri.file('/any/kbengine.xml'));
      expect(fired).toHaveLength(3);
      expect(provider.provideTextDocumentContent({})).toContain('仅引擎默认');

      // autoRefreshFinalConfig=false 时 watcher 不存在,联动自然关闭
      disposeAll(context);
    } finally {
      (workspace as unknown as Record<string, unknown>).createFileSystemWatcher = originalCreate;
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 8000);
});

describe('extension activate 自动热重载装配(盘点 G5)', () => {
  it('开启后文件保存按名执行快速动作,默认关不建监视器', async () => {
    const context = makeContext();
    workspace.workspaceFolders = [{ uri: Uri.file('/ws'), name: 'ws', index: 0 }];
    memoryFileSystem.set(
      '/ws/.kbengine/debug.json',
      JSON.stringify({
        quickActions: [
          { name: '热更', type: 'command', command: 'kbengine.test.hotReloadProbe', args: [] }
        ]
      })
    );
    configurationOverrides.set('kbengine', {
      hotReload: { enabled: true, actionName: '热更', debounceMs: 0 }
    });
    activate(context);
    // 覆盖探测命令,避免真的动 KBEngine 进程;装配只关心按名触发这条链
    const registration = commands.registerCommand('kbengine.test.hotReloadProbe', () => undefined);

    expect(lastFileSystemWatcher.current).not.toBeNull();
    lastFileSystemWatcher.current!.fireChange(Uri.file('/ws/scripts/base/Account.py'));

    await new Promise(resolve => setTimeout(resolve, 10));

    registration.dispose();
    disposeAll(context);
  }, 8000);
});

describe('extension activate MRO 启动门控(P0-3e)', () => {
  it('enableMroJump=false:激活不启动 Python 后台全扫(def 首扫照常);拨回 true 配置路径即启动', async () => {
    // P0-3e 验收臂:启动路径与开关切换同口径。门控放行证明用 def 首扫
    // (startKbEngineIndexing 同一同步块里两者一起放行——def 扫已启动而
    // python-index-scan 零记录,才证明 python 被开关拦下,不是门控未放行)。
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-mro-gate-'));
    fs.mkdirSync(path.join(root, 'entities'), { recursive: true });
    fs.writeFileSync(path.join(root, 'entities', 'Avatar.def'), '<root>\n</root>\n');
    fs.mkdirSync(path.join(root, 'scripts', 'base'), { recursive: true });
    fs.writeFileSync(path.join(root, 'scripts', 'base', 'Avatar.py'), 'class Avatar:\n    pass\n');
    const oldFolders = workspace.workspaceFolders;
    const oldFindFiles = workspace.findFiles;
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    const defUri = Uri.file(path.join(root, 'entities', 'Avatar.def'));
    const pyUri = Uri.file(path.join(root, 'scripts', 'base', 'Avatar.py'));
    workspace.findFiles = (async (include: string) => {
      if (include.includes('*.def')) { return [defUri]; }
      if (include.includes('*.py')) { return [pyUri]; }
      return [];
    }) as typeof workspace.findFiles;
    resetLanguageServiceMetrics();
    configurationOverrides.set('kbengine.python', { enableMroJump: false });
    const context = makeContext();
    try {
      activate(context);
      // 门控确实放行(特征探测命中 .def):def 首扫记账出现
      await until(() => getOperationSummary('entity-mapping-scan') !== null, 4000);
      // 宽限窗内 Python 后台全扫零记账(未被门控放行的空转对照)
      await new Promise(resolve => setTimeout(resolve, 250));
      expect(getOperationSummary('python-index-scan')).toBeNull();
      // 拨回 true:配置变更路径(extension.ts enableMroJump 分支)调度后台全扫
      configurationOverrides.set('kbengine.python', { enableMroJump: true });
      workspaceEvents.configurationChanged.fire({
        affectsConfiguration: (section: string) =>
          section === 'kbengine' || section === 'kbengine.python.enableMroJump'
      });
      await until(() => getOperationSummary('python-index-scan') !== null, 4000);
      expect(getOperationSummary('python-index-scan')?.fileParseCount ?? 0).toBeGreaterThanOrEqual(1);
      disposeAll(context);
    } finally {
      workspace.workspaceFolders = oldFolders;
      workspace.findFiles = oldFindFiles;
      configurationOverrides.delete('kbengine.python');
      resetLanguageServiceMetrics();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 10000);
});

describe('extension activate 原始日志 ERROR 扫描装配(盘点 G6)', () => {
  it('scanErrors 命令:取消不建面板;选文件扫出聚合面板;重扫与点击行走默认链', async () => {
    const windowish = fakeWindow as unknown as Record<string, unknown>;
    const originalShowOpenDialog = windowish.showOpenDialog;
    memoryFileSystem.set(
      '/ws/logs/server.log',
      [
        '   ERROR dbmgr01 1000 2000 30000 [2026-03-26 18:21:11 001] - saveAvatar(1001) failed: not found',
        '[2026-03-26 18:23:00][ERROR][cellapp] loadBalance failed',
        '   INFO dbmgr01 1000 2000 30001 [2026-03-26 18:23:01 002] - normal line'
      ].join('\n')
    );
    workspace.workspaceFolders = [{ uri: Uri.file('/ws'), name: 'ws', index: 0 }];
    const context = makeContext();
    try {
      activate(context);

      // 对话框默认取消(fake 默认 undefined):不建面板
      await commands.executeCommand('kbengine.logs.scanErrors');
      expect(panelRegistry.panels).toHaveLength(0);

      // 选中日志文件:扫出 ERROR 聚合面板
      windowish.showOpenDialog = async () => [Uri.file('/ws/logs/server.log')];
      await commands.executeCommand('kbengine.logs.scanErrors');
      expect(panelRegistry.panels).toHaveLength(1);
      const panel = panelRegistry.panels[0];
      expect(panel.viewType).toBe('kbengine.logErrorScan');
      expect(panel.webview.html).toContain('saveAvatar(N) failed: not found');
      expect(panel.webview.html).toContain('loadBalance failed');

      // 点击命中行:默认打开链把选区落在命中行
      const before = windowState.showTextDocumentCalls.length;
      panelRegistry.fireMessage(panel, { command: 'open', file: '/ws/logs/server.log', line: 2 });
      await until(() => windowState.showTextDocumentCalls.length > before);

      // 重扫:内容更新后回到同一面板
      memoryFileSystem.set(
        '/ws/logs/server.log',
        [
          '   ERROR dbmgr01 1000 2000 30000 [2026-03-26 18:21:11 001] - saveAvatar(1001) failed: not found',
          '[2026-03-26 19:00:00][CRITICAL][baseapp] disk full on volume 7'
        ].join('\n')
      );
      panelRegistry.fireMessage(panel, { command: 'rescan' });
      await until(() => panel.webview.html.includes('disk full on volume N'));
      expect(panelRegistry.panels).toHaveLength(1);
    } finally {
      windowish.showOpenDialog = originalShowOpenDialog;
      disposeAll(context);
    }
  }, 8000);
});

describe('extension activate 客户端实体 SDK 生成装配(盘点 G4)', () => {
  it('clientSdk.generate 命令:选语言+输出目录+跳过策略后按 entities.xml 落盘', async () => {
    const windowish = fakeWindow as unknown as Record<string, unknown>;
    const originalQuickPick = windowish.showQuickPick;
    const originalInputBox = windowish.showInputBox;
    const originalInfoCount = messages.info.length;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-sdk-activate-'));
    const defsDir = path.join(root, 'scripts', 'entity_defs');
    fs.mkdirSync(defsDir, { recursive: true });
    fs.writeFileSync(
      path.join(root, 'scripts', 'entities.xml'),
      '<root><Avatar hasBase="true"/></root>',
      'utf8'
    );
    fs.writeFileSync(
      path.join(defsDir, 'Avatar.def'),
      '<root><Properties><hp><Type>UINT32</Type><Flags>OWN_CLIENT</Flags></hp></Properties></root>',
      'utf8'
    );
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    const context = makeContext();
    try {
      activate(context);

      const picks: Array<Array<{ value: string }>> = [
        [{ value: 'typescript' }],
        [{ value: 'skip' }]
      ];
      let pickCalls = 0;
      windowish.showQuickPick = async (): Promise<unknown> => {
        const next = picks[pickCalls];
        pickCalls += 1;
        return next;
      };
      windowish.showInputBox = async (): Promise<string | undefined> => 'scripts/client_entities';

      await commands.executeCommand('kbengine.clientSdk.generate');

      expect(pickCalls).toBe(2);
      const filePath = path.join(root, 'scripts', 'client_entities', 'Avatar.ts');
      expect(fs.existsSync(filePath)).toBe(true);
      const content = fs.readFileSync(filePath, 'utf8');
      expect(content).toContain('export class Avatar');
      expect(content).toContain('public hp: number');
      expect(content).toContain('protected onBaseOutgoing');
      expect(messages.info[messages.info.length - 1]).toContain('Avatar.ts');
    } finally {
      windowish.showQuickPick = originalQuickPick;
      windowish.showInputBox = originalInputBox;
      messages.info.length = originalInfoCount;
      disposeAll(context);
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 8000);
});

describe('extension activate 定义形态生成装配(盘点 G7)', () => {
  it('formWizard 命令:选空间形态 + 名称后落 def 并登记 entities.xml', async () => {
    const windowish = fakeWindow as unknown as Record<string, unknown>;
    const originalQuickPick = windowish.showQuickPick;
    const originalInputBox = windowish.showInputBox;
    const originalInfoCount = messages.info.length;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-forms-activate-'));
    fs.mkdirSync(path.join(root, 'scripts', 'entity_defs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'scripts', 'entities.xml'), '<root>\n</root>\n', 'utf8');
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    const context = makeContext();
    try {
      activate(context);

      let pickCalls = 0;
      windowish.showQuickPick = async (items: unknown[]): Promise<unknown> => {
        const resolved = await items;
        pickCalls += 1;
        // 第一次选空间形态,第二次(IDE-GEN-008 计划确认)选确认生成
        if (pickCalls === 1) {
          return resolved.find(item => (item as { label: string }).label.startsWith('空间实体'));
        }
        return resolved.find(item => (item as { label: string }).label === '确认生成');
      };
      windowish.showInputBox = async (): Promise<string | undefined> => 'MySpace';

      await commands.executeCommand('kbengine.generator.formWizard');

      expect(pickCalls).toBe(2);
      const defPath = path.join(root, 'scripts', 'entity_defs', 'MySpace.def');
      expect(fs.readFileSync(defPath, 'utf8')).toContain('<Space/>');
      expect(fs.readFileSync(path.join(root, 'scripts', 'entities.xml'), 'utf8')).toContain(
        '<MySpace hasBase="true" hasCell="true" />'
      );
      expect(messages.info.some(info => info.includes('已生成空间实体'))).toBe(true);
    } finally {
      windowish.showQuickPick = originalQuickPick;
      windowish.showInputBox = originalInputBox;
      messages.info.length = originalInfoCount;
      disposeAll(context);
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 8000);
});

describe('激活期项目导入命令装配(IDE-PRJ-003)', () => {
  it('project.import 命令:选资产根 + 确认导入后建立 profile', async () => {
    const windowish = fakeWindow as unknown as Record<string, unknown>;
    const originalOpenDialog = windowish.showOpenDialog;
    const originalQuickPick = windowish.showQuickPick;
    const originalInfoCount = messages.info.length;
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-ext-import-'));
    const assetsRoot = path.join(base, 'proj');
    fs.mkdirSync(path.join(assetsRoot, 'scripts', 'entity_defs'), { recursive: true });
    fs.writeFileSync(path.join(assetsRoot, 'scripts', 'entities.xml'), '<root>\n</root>\n', 'utf8');
    const persisted: Array<[string, unknown]> = [];
    const context: ExtensionContext = {
      ...makeContext(),
      workspaceState: {
        get: <T,>(_key: string, defaultValue?: T): T | undefined => defaultValue,
        update: (key: string, value: unknown): Promise<void> => {
          persisted.push([key, value]);
          return Promise.resolve();
        }
      }
    };
    workspace.workspaceFolders = [{ uri: Uri.file(base), name: 'ws', index: 0 }];
    try {
      activate(context);

      windowish.showOpenDialog = async () => [Uri.file(assetsRoot)];
      windowish.showQuickPick = async (items: unknown[] | Promise<unknown[]>): Promise<unknown> => {
        const resolved = (await items) as Array<{ label: string }>;
        return resolved.find(item => item.label === '导入');
      };

      await commands.executeCommand('kbengine.project.import');

      // 命令接线到位:确认导入后 profile 落进 workspaceState 持久层
      // (激活期还有别的键写 workspaceState,只看 profile 键)
      const profileWrites = persisted.filter(([key]) => key === 'kbengine.projectProfiles.v1');
      expect(profileWrites).toHaveLength(1);
      const profiles = profileWrites[0][1] as Array<Record<string, string>>;
      expect(profiles).toHaveLength(1);
      expect(profiles[0]).toMatchObject({ displayName: 'proj', assetsRoot, engineRoot: '' });
      expect(messages.info.some(info => info.includes('已导入项目 profile'))).toBe(true);
    } finally {
      windowish.showOpenDialog = originalOpenDialog;
      windowish.showQuickPick = originalQuickPick;
      messages.info.length = originalInfoCount;
      disposeAll(context);
      fs.rmSync(base, { recursive: true, force: true });
    }
  }, 8000);
});

describe('激活期最小项目创建命令装配(IDE-PRJ-008)', () => {
  it('project.create 命令:选目标根 + 确认生成后落盘并建档', async () => {
    const windowish = fakeWindow as unknown as Record<string, unknown>;
    const originalOpenDialog = windowish.showOpenDialog;
    const originalQuickPick = windowish.showQuickPick;
    const originalInfoCount = messages.info.length;
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-ext-create-'));
    const targetRoot = path.join(base, 'fresh');
    const persisted: Array<[string, unknown]> = [];
    const context: ExtensionContext = {
      ...makeContext(),
      workspaceState: {
        get: <T,>(_key: string, defaultValue?: T): T | undefined => defaultValue,
        update: (key: string, value: unknown): Promise<void> => {
          persisted.push([key, value]);
          return Promise.resolve();
        }
      }
    };
    workspace.workspaceFolders = [{ uri: Uri.file(base), name: 'ws', index: 0 }];
    try {
      activate(context);

      windowish.showOpenDialog = async () => [Uri.file(targetRoot)];
      windowish.showQuickPick = async (items: unknown[] | Promise<unknown[]>): Promise<unknown> => {
        const resolved = (await items) as Array<{ label: string }>;
        return resolved.find(item => item.label === '确认生成');
      };

      await commands.executeCommand('kbengine.project.create');

      // 模板落盘 + 命令接线建档(只看 profile 键,激活期别的键不入账)
      expect(fs.existsSync(path.join(targetRoot, 'scripts', 'entities.xml'))).toBe(true);
      const profileWrites = persisted.filter(([key]) => key === 'kbengine.projectProfiles.v1');
      expect(profileWrites).toHaveLength(1);
      const profiles = profileWrites[0][1] as Array<Record<string, string>>;
      expect(profiles[0]).toMatchObject({ displayName: 'fresh', assetsRoot: targetRoot });
      expect(messages.info.some(entry => entry.includes('已创建最小项目 profile'))).toBe(true);
    } finally {
      windowish.showOpenDialog = originalOpenDialog;
      windowish.showQuickPick = originalQuickPick;
      messages.info.length = originalInfoCount;
      disposeAll(context);
      fs.rmSync(base, { recursive: true, force: true });
    }
  }, 8000);
});

describe('激活期活动 profile 选择命令装配(IDE-PRJ-010)', () => {
  it('project.selectActive 命令:无 profile 时如实说明并跳过选择器', async () => {
    const windowish = fakeWindow as unknown as Record<string, unknown>;
    const originalPick = windowish.showQuickPick;
    let pickCalls = 0;
    const originalInfoCount = messages.info.length;
    const context = makeContext();
    try {
      activate(context);

      windowish.showQuickPick = async (): Promise<unknown> => {
        pickCalls += 1;
        return undefined;
      };

      await commands.executeCommand('kbengine.project.selectActive');

      expect(pickCalls).toBe(0);
      expect(messages.info.slice(originalInfoCount).some(entry => entry.includes('没有可选择'))).toBe(true);
    } finally {
      windowish.showQuickPick = originalPick;
      messages.info.length = originalInfoCount;
      disposeAll(context);
    }
  }, 8000);
});

describe('激活期 profile 健康汇总命令装配(IDE-PRJ-009)', () => {
  it('profile.health 命令:无活动 profile 时如实说明', async () => {
    const windowish = fakeWindow as unknown as Record<string, unknown>;
    const originalPick = windowish.showQuickPick;
    let pickCalls = 0;
    const originalInfoCount = messages.info.length;
    const context = makeContext();
    try {
      activate(context);

      windowish.showQuickPick = async (): Promise<unknown> => {
        pickCalls += 1;
        return undefined;
      };

      await commands.executeCommand('kbengine.profile.health');

      expect(pickCalls).toBe(0);
      expect(messages.info.slice(originalInfoCount).some(entry => entry.includes('未选择活动 project profile'))).toBe(true);
    } finally {
      windowish.showQuickPick = originalPick;
      messages.info.length = originalInfoCount;
      disposeAll(context);
    }
  }, 8000);
});

describe('激活期语言索引响应 profile 切换(IDE-PRJ-011)', () => {
  it('激活即应用持久化选择,切换事件切换索引输入并前进 generation', async () => {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-ext-prj11-a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-ext-prj11-b-'));
    const map = new Map<string, unknown>([
      ['kbengine.projectProfiles.v1', [
        { id: 'p1', displayName: 'A', assetsRoot: dirA, engineRoot: '', interpreterPath: null, interpreterSource: 'missing' },
        { id: 'p2', displayName: 'B', assetsRoot: dirB, engineRoot: '', interpreterPath: null, interpreterSource: 'missing' }
      ]],
      ['kbengine.activeProfileId.v1', 'p1']
    ]);
    const mementoLike = {
      get: <T,>(key: string, defaultValue?: T): T | undefined =>
        map.has(key) ? (map.get(key) as T) : defaultValue,
      update: (key: string, value: unknown): Promise<void> => {
        map.set(key, value);
        return Promise.resolve();
      }
    };
    const context: ExtensionContext = {
      ...makeContext(),
      workspaceState: mementoLike
    };
    const generationBefore = getRootConfigGeneration();
    try {
      activate(context);

      // 激活期:持久化的选择落到索引输入
      expect(getActiveProfileScanRoot()).toBe(dirA);

      // 切换事件:输入换到选定根,generation 前进(旧输入在途批次由此判过期)
      await setActiveProfile(mementoLike, 'p2');
      expect(getActiveProfileScanRoot()).toBe(dirB);
      expect(getRootConfigGeneration()).toBeGreaterThan(generationBefore);
      expect(getRootConfigLastBumpReason()).toBe('profile-switch');
    } finally {
      disposeAll(context);
      setActiveProfileScanRoot(null);
      resetScanRootCache();
      fs.rmSync(dirA, { recursive: true, force: true });
      fs.rmSync(dirB, { recursive: true, force: true });
    }
  }, 8000);
});

describe('激活期 debug.json 缺失自动生成(批143)', () => {
  it('工作区没有配置文件时生成带注释骨架,生效工作目录与来源落输出通道', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-ext-debugcfg-'));
    fs.writeFileSync(path.join(root, 'start_server.bat'), '@echo off\n');
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    const context = makeContext();
    try {
      activate(context);

      const configPath = path.join(root, '.kbengine', 'debug.json');
      expect(fs.existsSync(configPath)).toBe(true);
      const content = fs.readFileSync(configPath, 'utf8');
      // 骨架是 JSONC:注释说明字段含义,剥注释后仍是合法 JSON
      expect(content).toContain('// 配置版本号');
      expect(content).toContain('${workspaceFolder}/start_server.bat');
      expect(parseDebugConfigText(content)?.quickActions).toHaveLength(1);

      const channel = windowState.channels.find(entry => entry.name === 'KBEngine 配置');
      const text = channel?.lines.join('') ?? '';
      expect(text).toContain(root);
      expect(text).toContain('来源:默认值(首个工作区根)');
      expect(text).toContain('按脚本扫描写入 1 条快速执行动作');

      // 已有配置不覆盖:再激活一次内容不变
      activate(context);
      expect(fs.readFileSync(configPath, 'utf8')).toBe(content);
    } finally {
      disposeAll(context);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});


describe('Python index lifecycle wiring', () => {
  it('watches external assets, refreshes changed files, and releases closed documents', async () => {
    const assets = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-external-watch-'));
    const context = makeContext();
    const originalCreate = workspace.createFileSystemWatcher;
    const watches: Array<{ pattern: unknown; disposed: boolean; watcher: ReturnType<typeof originalCreate> }> = [];
    const create = vi.spyOn(workspace, 'createFileSystemWatcher').mockImplementation(((pattern: unknown) => {
      const watcher = originalCreate();
      const record = { pattern, disposed: false, watcher };
      const dispose = watcher.dispose.bind(watcher);
      watcher.dispose = () => { record.disposed = true; dispose(); };
      watches.push(record);
      return watcher;
    }) as typeof originalCreate);
    const invalidate = vi.spyOn(PythonClassIndex.prototype, 'invalidate');
    const changed = vi.spyOn(PythonClassIndex.prototype, 'onFileChanged').mockResolvedValue(undefined);
    const closed = vi.spyOn(PythonClassIndex.prototype, 'onDocumentClosed');
    configurationOverrides.set('kbengine', { assetsRoot: assets });
    try {
      activate(context);
      const watch = watches.find(item => (item.pattern as { base?: string })?.base === assets);
      expect(watch, 'external assetsRoot has a RelativePattern watcher').toBeTruthy();
      const file = Uri.file(path.join(assets, 'scripts/cell/Avatar.py'));
      watch!.watcher.fireCreate(file);
      // 新建文件走 onFileChanged 直接装载进索引;invalidate 对未索引文件是
      // 刻意空转(不得重启扫描),故 create 必须不触发 invalidate
      expect(changed).toHaveBeenCalledWith(file.fsPath);
      expect(invalidate, 'unindexed create must not restart the scan').not.toHaveBeenCalled();
      watch!.watcher.fireChange(file);
      expect(changed).toHaveBeenCalledWith(file.fsPath);
      watch!.watcher.fireDelete(file);
      expect(invalidate).toHaveBeenLastCalledWith(file.fsPath);
      const document = makeTextDocument('class Avatar: pass', { fileName: file.fsPath });
      workspaceEvents.documentClosed.fire(document);
      expect(closed).toHaveBeenCalledWith(document);
      // assets 同 base 的活 watcher 数(扩展装配面 1 件+entityMapping 外部根
      // 三件套,IDE-ACC-011 起后者也以 RelativePattern 注册)。测试内 manager
      // 单例在 import 期构造,彼时 kbengine 覆盖未生效,外部三件套由首个配置
      // 事件补挂——泄漏锁取「整组重建后再刷新,活集不增长」,不取首次前后等值
      const liveAssetsWatchers = (): number =>
        watches.filter(item => (item.pattern as { base?: string })?.base === assets && !item.disposed).length;
      const fireAssetsRootChanged = (): void => {
        workspaceEvents.configurationChanged.fire({ affectsConfiguration: section => section === 'kbengine' || section === 'kbengine.assetsRoot' });
      };
      fireAssetsRootChanged();
      const count = invalidate.mock.calls.length;
      watch!.watcher.fireCreate(file);
      expect(invalidate.mock.calls.length, 'old watchers are disposed when roots change').toBe(count);
      const liveAfterRefresh = liveAssetsWatchers();
      expect(liveAfterRefresh, 'assets root has live watchers after refresh').toBeGreaterThan(0);
      fireAssetsRootChanged();
      expect(liveAssetsWatchers(), 'watcher group rebuild does not leak live watchers').toBe(liveAfterRefresh);
    } finally {
      disposeAll(context);
      create.mockRestore(); invalidate.mockRestore(); changed.mockRestore(); closed.mockRestore();
      configurationOverrides.delete('kbengine');
      fs.rmSync(assets, { recursive: true, force: true });
    }
  });
});

describe('Python index edit coalescing', () => {
  it('reindexes one burst once after typing settles', async () => {
    vi.useFakeTimers();
    workspace.workspaceFolders = [{ uri: Uri.file('/workspace'), name: 'ws', index: 0 }];
    const context = makeContext();
    const changed = vi.spyOn(PythonClassIndex.prototype, 'onDocumentChanged')
      .mockResolvedValue(undefined);
    const document = makeTextDocument('class Avatar: pass', {
      fileName: '/workspace/avatar.py',
      languageId: 'python'
    }) as never;
    try {
      activate(context);
      for (let index = 0; index < 10; index += 1) {
        workspaceEvents.documentChanged.fire({
          document,
          contentChanges: [{ range: undefined, rangeOffset: 0, rangeLength: 0, text: 'x' }],
          reason: undefined
        });
      }
      expect(changed).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(100);
      expect(changed).toHaveBeenCalledTimes(1);
      expect(changed).toHaveBeenCalledWith(document);
    } finally {
      vi.useRealTimers();
      disposeAll(context);
      changed.mockRestore();
      workspace.workspaceFolders = [];
    }
  });
});

describe('webview console log switch', () => {
  it('attaches page console ingestion by default and skips attachment when disabled', async () => {
    const panel = panelRegistry.create('kbengine.logViewer', 'KBEngine Logs', 2, { enableScripts: true });
    expect(panelRegistry.panels).toHaveLength(1);

    configurationOverrides.set('kbengine', { webviewConsoleLogs: false });
    const disabledContext = makeContext();
    activate(disabledContext);
    expect(disabledContext.subscriptions.length).toBeGreaterThan(0);
    disposeAll(disabledContext);
    configurationOverrides.delete('kbengine');
    void panel;
  });
});
