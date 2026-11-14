import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PythonClassIndex } from '../src/backend/pythonClassIndex';
import { activate, deactivate } from '../src/extension';
import { setActiveProfile } from '../src/activeProfile';
import { getRootConfigGeneration, getRootConfigLastBumpReason } from '../src/rootConfigGeneration';
import { getActiveProfileScanRoot, resetScanRootCache, setActiveProfileScanRoot } from '../src/scanRoots';
import { isPythonMroJumpEnabled } from '../src/languageProviders';
import {
  applySavedFileAnnotations,
  flushPendingDocumentReturnAnnotationsForTests,
  getDocumentReturnAnnotationBucketForTests,
  resetPythonReturnAnnotationCache,
  resolveLocalVariableReturnType,
  resolveLocalVariableReturnTypeFromSnapshot
} from '../src/backend/pythonReturnTypeInference';
import {
  getOperationSummary,
  resetLanguageServiceMetrics
} from '../src/languageServiceMetrics';
import { getDatabaseSchemaSnapshot, locateDatabaseSchemaLine } from '../src/databaseSchema';
import { createDatabaseSchemaUri, parseDatabaseSchemaRoot } from '../src/databaseSchemaPresentation';
import { getDiagnosticScheduler } from '../src/backend/diagnosticScheduler';
import { KBE_SCHEME, buildKbeStubDocument } from '../src/kbeModuleIndex';
import { parseDebugConfigText } from '../src/backend/debugConfigBootstrap';
import { setKodeCoreShadowGate, getKodeCoreShadowGate } from '../src/backend/kodeCoreShadowFaces';
import { ensureConfigResolved, resetConfigResolveForTests } from '../src/serverConfigResolve';
import { ENGINE_DEFAULT_TELNET_PORTS, makeContractGate } from './helpers/configCoreContract';
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

import { until, makeContext, disposeAll, watcherPatternKey, declared, BAD_DEF, resetExtensionTestState } from './extensionTestShared';

beforeEach(resetExtensionTestState);

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
  it('切换自管属性 None 诊断开关时重新计算未编辑文档', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-attr-toggle-'));
    const document = makeTextDocument(
      'class Avatar:\n    def __init__(self):\n        self.TalentTree = None\n    def tick(self):\n        self.TalentTree.get(0)\n',
      { fileName: path.join(root, 'Avatar.py'), languageId: 'python' }
    );
    workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
    workspace.textDocuments = [document];
    const context = makeContext();
    try {
      activate(context);
      await getDiagnosticScheduler().pendingComputations();
      const collection = languagesRegistry.diagnosticCollections[0].collection;
      // LANG-NAR-1:__init__ 仅 = None 且未守卫 → 报 1 条自管属性 None
      expect(collection.get(document.uri)).toHaveLength(1);
      const change = () => workspaceEvents.configurationChanged.fire({
        affectsConfiguration: section => section === 'kbengine' || section === 'kbengine.attributeNoneDiagnostics'
      });
      configurationOverrides.set('kbengine', { attributeNoneDiagnostics: false });
      change();
      await getDiagnosticScheduler().pendingComputations(); // 关闭:发布空集即清
      expect(collection.get(document.uri)).toHaveLength(0);
      configurationOverrides.set('kbengine', { attributeNoneDiagnostics: true });
      change();
      await getDiagnosticScheduler().pendingComputations();
      expect(collection.get(document.uri)).toHaveLength(1);
    } finally {
      disposeAll(context);
      configurationOverrides.delete('kbengine');
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it('注册面与 package.json 贡献点一致', async () => { // timeout below(win32 状态灯稳态等待)
    const context = makeContext();
    activate(context);

    // 命令:activate 注册的 id 集合与 package.json 声明严格一致
    // (防"漏注册/漏声明"两类回归,重设计问题 P14 的核心验收)。
    // 显式豁免一例:真机 NLS 探针 kbengine.l10nProbe(UX-REVIEW-010f)有意
    // 不进 contributes=不出命令面板,专供真机层 suite 经 executeCommand 取词
    // 验证;豁免清单外的注册面与声明面仍严格互等。
    const intentionalUndeclared = ['kbengine.l10nProbe'];
    const allRegistered = commandRegistry.allRegisteredCommandIds();
    for (const id of intentionalUndeclared) {
      expect(allRegistered, `${id} 应已注册(豁免项仍须真实注册)`).toContain(id);
    }
    expect(
      allRegistered.filter(id => !intentionalUndeclared.includes(id)).sort()
    ).toEqual(declared.commands.map(entry => entry.command).sort());

    // 测试面板(TSK-005):一个 controller,一个默认 Run 档
    expect(testsRegistry.controllers).toHaveLength(1);
    expect(testsRegistry.controllers[0].id).toBe('kbengine-python-tests');
    expect(testsRegistry.controllers[0].profiles).toHaveLength(1);
    expect(testsRegistry.controllers[0].profiles[0].kind).toBe(1);
    expect(testsRegistry.controllers[0].profiles[0].isDefault).toBe(true);

    // 树视图(KODE-PERF 视图先行 + KB-GC-001 期二口径):activate 首行为全部
    // 声明 id 注册空占位 provider,真 provider 在各自装配位随后接管=同 id
    // 双注册是既定语义(宿主同 id 后到者接管)。锁两面:前 N 笔(占位批)与
    // 后 N 笔(真接管批)都与 views 贡献点严格一致。
    const declaredViewIds = Object.values(declared.views)
      .flat()
      .map(view => view.id)
      .sort();
    const registeredViewIds = treeRegistrations.map(item => item.viewId);
    expect(registeredViewIds.slice(0, declaredViewIds.length).sort()).toEqual(declaredViewIds);
    expect(registeredViewIds.slice(declaredViewIds.length).sort()).toEqual(declaredViewIds);

    // 语言服务:补全 4(.def + Python + 启动脚本,KBEXP-1 + 配置 XML,KSEM-CFG-04)、
    // 悬停 3(.def/hook + 引擎配置字段,批112 + 启动脚本,KBEXP-1)、定义 2、
    // 调用层级 1、重命名 1
    expect(languagesRegistry.completionRegistrations).toHaveLength(4);
    expect(languagesRegistry.hoverRegistrations).toHaveLength(3);
    expect(languagesRegistry.definitionRegistrations).toHaveLength(2);
    // 引用提供者(Shift+F12)三份:IDE-NAV-001 def 文档选择器一份、
    // GLOBDATA-001 python 数据字典键选择器一份(同一实例双 selector 注册)、
    // IDE-NAV-017 types.xml 符号选择器一份
    expect(languagesRegistry.referenceRegistrations).toHaveLength(3);
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
    // 再一份(receiver-none 诊断对账);C-19 起 def 面 parity 一键生成再一份
    // (def-method-missing-in-python 诊断对账);C-23 起 FIXED_DICT 整体重赋
    // quick fix 再一份(trapDiagnosticsWiring 自持注册)
    expect(languagesRegistry.codeActionsRegistrations).toHaveLength(5);
    // 批126:RPC 方法标记的 Python 侧 CodeLens 单注册;批134 起 types.xml
    // 引用反扫镜再加一份注册;批135 属性访问标记再加一份注册;批154 起
    // 事件回调镜链从 RPC 镜链拆出独立注册(各自独立开关);IDE-HOT-100 起
    // 文件热更状态点 CodeLens 再加一份注册(状态机派生视图,见其专测);
    // PROC-TAG-001 起文件顶部进程归属镜再加一份注册
    expect(languagesRegistry.codeLensRegistrations).toHaveLength(9);
    // 批154:python 侧 types.xml 数据类型 inlay hints 一份注册;内建属性行内
    // `: <type>` inlay 另一份独立注册(2026-10-21 形态升级单,独立开关);
    // 任务2(2026-10-27)def 定义点形参 inlay 再一份独立注册;
    // C-22 def 属性只读视图 inlay(注释锚形态)再一份独立注册;
    // KODE-CFG-017-R(139f7035)推断镜像类型 inlay 再一份独立注册
    // (定义点行差分,kbengine.infer.enabled 镜像总闸);2026-11-10 cellData
    // 复制属性提示再一份(淡色小字,永不下划线,propertyShadow 开关);
    // 批 ③ Proxy 内部属性提示(内部属性 · Proxy + 项目副本 Proxy.pyi 导航)
    // 再一份独立注册(proxyInternalAttrHints 开关)
    expect(languagesRegistry.inlayHintsRegistrations).toHaveLength(7);
    // 批91 起:def 分析命令的独立诊断集合与语言侧诊断并存;
    // 书 §19 HR-PR-02:临时编辑热更新问题通道诊断集并存一份;
    // C-19 起 def↔Python 方法一致性独立诊断集再一份(不并 kbengine 主集);
    // C-17 起进程拓扑独立诊断集再一份(kbengine-process-topology);
    // GEN-DEF-1e 起 user_type 三契约缺方法独立诊断集再一份(kbengine-user-type-contract);
    // GEN-DEF-1e ④ 方向违规诊断集再一份(kbengine-property-direction);
    // IDE-LINT-007 只读写入诊断集再一份(kbengine-readonly-write);
    // IDE-LINT-009 角色错用诊断集再一份(kbengine-role-misuse);
    // IDE-LINT-010 销毁后访问诊断集再一份(kbengine-post-destroy);
    // KSEM-CELL-08 cellData 已知字段写入类型诊断集再一份(kbengine-celldata-write);
    // KSEM-STRUCT-04 FD 构造点诊断集再一份(kbengine-fixeddict-construct,注册点
    // 紧随 kbengine-celldata-write——集合创建序即注册表序,消费方按序取集合);
    // KSEM-STRUCT-05 标量赋值诊断集再一份(kbengine-scalar-assign,注册点紧随
    // kbengine-fixeddict-construct——集合创建序即注册表序);
    // KSEM-CELL-10 cellData 错键诊断集再一份(kbengine-celldata-wrongkey);
    // C-23 行为知识三规则独立诊断集再一份(kbengine-trap-lints,注册点在
    // 全部既有集合之后——集合创建序即注册表序,消费方按序取集合)
    expect(languagesRegistry.diagnosticCollections.map(entry => entry.name)).toEqual([
      'kbengine',
      'kbengine-def-method-consistency',
      'kbengine-user-type-contract',
      'kbengine-property-direction',
      'kbengine-readonly-write',
      'kbengine-role-misuse',
      'kbengine-post-destroy',
      'kbengine-celldata-write',
      'kbengine-fixeddict-construct',
      'kbengine-scalar-assign',
      'kbengine-celldata-wrongkey',
      'kbengine-celldata-callback',
      'kbengine-process-topology',
      'KBEngine 临时编辑热更新',
      'kbengine-def-analysis',
      'kode-ruff',
      'kbengine-trap-lints'
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

    // 状态栏八条:server 灯(右对齐/优先级 100/命令指向扩展视图)、
    // telnet 灯(优先级 99/命令指向 telnet 面板)、热更状态灯(HR-UI-001,
    // 优先级 98/命令指向热更日志,默认 Watch Off 常显)、解释器灯(PY-ENV
    // 二期,优先级 97/命令指向解释器选择,常显)、热更通道灯(快捷切换本批,
    // 优先级 96/命令指向三选切换,无激活 profile 时显示未配置)、
    // KB-GC-001 日志 tail 灯(优先级 95/命令指向 tail 切换,连接态文本)、
    // Kode 核心灯(2026-11-10,优先级 94/命令指向影子对拍日志,显示 LSP
    // 服务轨道)与 Kode MCP 灯(优先级 93,二进制在位探测,无命令——事实
    // 在 tooltip);无运行组件时 server 灯隐藏。批111 用户令:配置未开
    // telnet 时 telnet 灯同样隐藏,context key 落 false
    expect(windowState.statusBars).toHaveLength(8);
    const tailBar = windowState.statusBars.find(item => item.priority === 95)!;
    expect(tailBar.alignment).toBe(StatusBarAlignment.Right);
    // tail 状态灯显示连接态文本(connecting/connected/backoff);2026-11-10
    // 用户问「kbe 日志如何打开」——点击灯直接开日志输出通道(不再无命令)。
    expect(tailBar.command).toBe('kbengine.consoleLogTail.show');
    const bar = windowState.statusBars.find(item => item.priority === 100)!;
    expect(bar.alignment).toBe(StatusBarAlignment.Right);
    expect(bar.command).toBe('workbench.view.extension.kbengine-explorer');
    expect(bar.visible).toBe(false);
    const telnetBar = windowState.statusBars.find(item => item.priority === 99)!;
    expect(telnetBar.alignment).toBe(StatusBarAlignment.Right);
    expect(telnetBar.visible).toBe(false);
    const hotReloadBar = windowState.statusBars.find(item => item.priority === 98)!;
    expect(hotReloadBar.alignment).toBe(StatusBarAlignment.Right);
    // 用户令 2026-11-06:状态栏点击 = 一键关(kbengine.hotReload.toggle)
    expect(hotReloadBar.command).toBe('kbengine.hotReload.toggle');
    // 状态灯是异步激活写入面(watch 计划在激活尾部重算,win32 落点更晚):
    // 等文本到稳定态(连续两拍不变)再断言已知稳态面之一,不抢跑在中间态
    const settleHotReloadFace = async (): Promise<string> => {
      let current = hotReloadBar.text;
      for (let tick = 0; tick < 30; tick += 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
        if (hotReloadBar.text === current) {
          return current;
        }
        current = hotReloadBar.text;
      }
      return current;
    };
    expect(['$(eye-closed) 热更: 关', '$(eye) 热更: 就绪', '$(warning) 热更: 就绪(未监视)'])
      .toContain(await settleHotReloadFace());
    expect(hotReloadBar.visible).toBe(true);
    const interpreterBar = windowState.statusBars.find(item => item.priority === 97)!;
    expect(interpreterBar.alignment).toBe(StatusBarAlignment.Right);
    expect(interpreterBar.command).toBe('kbengine.python.selectInterpreter');
    expect(interpreterBar.visible).toBe(true);
    // 热更通道灯(快捷切换):显示当前通道,点击进三选 QuickPick;零配置
    // (无激活 profile)如实显示未配置,不虚构通道
    const channelBar = windowState.statusBars.find(item => item.priority === 96)!;
    expect(channelBar.alignment).toBe(StatusBarAlignment.Right);
    expect(channelBar.command).toBe('kbengine.hotReload.switchChannel');
    expect(channelBar.text).toContain('默认(http)');
    expect(channelBar.visible).toBe(true);
    // Kode 核心灯(2026-11-10 用户令「如何提示 lsp 和 mcp 的状态是否开启」):
    // 显示 LSP 服务轨道,点击开影子对拍日志;Kode MCP 灯做二进制在位探测,
    // 无命令(事实在 tooltip)。两灯都在右侧且常显。
    const kodeCoreBar = windowState.statusBars.find(item => item.priority === 94)!;
    expect(kodeCoreBar.alignment).toBe(StatusBarAlignment.Right);
    expect(kodeCoreBar.command).toBe('kbengine.core.showShadowDiffLog');
    expect(kodeCoreBar.visible).toBe(true);
    const kodeMcpBar = windowState.statusBars.find(item => item.priority === 93)!;
    expect(kodeMcpBar.alignment).toBe(StatusBarAlignment.Right);
    expect(kodeMcpBar.visible).toBe(true);
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
    const channel = windowState.channels.find(entry => entry.name === 'KBEngine Discovery Report');
    expect(channel).toBeDefined();
    const text = channel!.lines.join('');
    expect(text).toContain('Kode 发现与定位诊断');
    // 空工作区:def 根回落约定首项(不存在)计为问题 → 警告提示
    expect(text).toContain('[missing] 实体定义目录 entity_defs');
    expect(messages.warning.some(message => message.includes('discovery issues found'))).toBe(true);

    fs.rmSync(root, { recursive: true, force: true });
    disposeAll(context);
  // WIN-3:win32 诊断命令链路(发现扫描+报告)慢,平台化超时
  }, 15000);

  it('发现与定位诊断:未打开工作区时提示且不写报告', async () => {
    const context = makeContext();
    activate(context);

    await commands.executeCommand('kbengine.discovery.report');
    expect(messages.warning).toContain('No workspace open; cannot generate the discovery report');
    disposeAll(context);
  });

  it('发现与定位诊断使用调用时的工作区，关闭后不沿用旧目录', async () => {
    const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-discovery-old-'));
    const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-discovery-new-'));
    const context = makeContext();
    try {
      workspace.workspaceFolders = [{ uri: Uri.file(rootA), name: 'old', index: 0 }];
      activate(context);
      workspace.workspaceFolders = [{ uri: Uri.file(rootB), name: 'new', index: 0 }];
      await commands.executeCommand('kbengine.discovery.report');
      const channel = windowState.channels.find(entry => entry.name === 'KBEngine Discovery Report');
      expect(channel!.lines.join('')).toContain(`工作区: ${rootB}`);
      workspace.workspaceFolders = [];
      await commands.executeCommand('kbengine.discovery.report');
      expect(messages.warning).toContain('No workspace open; cannot generate the discovery report');
    } finally {
      disposeAll(context);
      fs.rmSync(rootA, { recursive: true, force: true });
      fs.rmSync(rootB, { recursive: true, force: true });
    }
  }, 15000);

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
      await until(() => messages.warning.some(message => message.includes('discovery issues found')), 4000);
      const channel = windowState.channels.find(entry => entry.name === 'KBEngine Discovery Report');
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
      const channel = windowState.channels.find(entry => entry.name === 'KBEngine Discovery Report');
      const text = channel!.lines.join('');
      expect(text).toContain('[ok] 实体定义目录 entity_defs');
      expect(text).toContain('[ok] 资产根 kbengine.assetsRoot');
      expect(text).toContain('[ok] 引擎二进制 kbengine.binPath');
      expect(text).toContain('问题 0 项');
      expect(messages.info).toContain('Discovery report: all clear');
      expect(messages.warning.some(message => message.includes('discovery issues found'))).toBe(false);
    } finally {
      configurationOverrides.delete('kbengine');
      fs.rmSync(root, { recursive: true, force: true });
      disposeAll(context);
    }
  // WIN-3:win32 状态灯稳态等待最长 3s,平台化超时
  }, 15000);

  it('最终配置默认图形界面(2026-11-12 用户令):showFinal 开可视化面板,finalConfigView=text 回文本', async () => {
    const context = makeContext();
    activate(context);
    try {
      await commands.executeCommand('kbengine.config.showFinal');
      await until(() => panelRegistry.panels.some(panel => panel.viewType === 'kbengine.configVisualizer'));

      configurationOverrides.set('kbengine', { finalConfigView: 'text' });
      await commands.executeCommand('kbengine.config.showFinal');
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(panelRegistry.panels.filter(panel => panel.viewType === 'kbengine.configVisualizer')).toHaveLength(1);
      expect(messages.error.length).toBeGreaterThan(0);

      await commands.executeCommand('kbengine.config.showFinalText');
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(panelRegistry.panels.filter(panel => panel.viewType === 'kbengine.configVisualizer')).toHaveLength(1);
    } finally {
      configurationOverrides.delete('kbengine');
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
    // (UX-REVIEW-010 本地化后消息走 l10n 源串,测试桩下恒英文)
    await commands.executeCommand('kbengine.quickActions.show');
    expect(messages.info.some(message => message.includes('No quick actions configured'))).toBe(true);

    // 批136 Explorer 顶栏 ▶ 主按钮:无配置动作时同样指路,不假装执行了什么
    await commands.executeCommand('kbengine.quickActions.runDefault');
    expect(messages.info.some(message => message.includes('No runnable actions found'))).toBe(true);

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
    expect(messages.info.some(message => message.includes('跳过 KBEngine 桩包复制'))).toBe(true);

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
    expect(messages.error.some(message => message.includes('Failed to connect the log collector'))).toBe(true);
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
      // 批 D:查询断言走 import 绑定路径(接收者正确)
      fs.writeFileSync(
        path.join(root, 'svc_saved.py'),
        'def get_data() -> JSONDATA:\n    pass\n',
        'utf8'
      );
      await resolveLocalVariableReturnType(
        ['from svc_saved import get_data', 'data = get_data()'], 1, 'data', root
      );
      const savedPy = makeTextDocument('def get_data() -> SAVED:\n    pass\n', {
        fileName: path.join(root, 'svc_saved.py'),
        languageId: 'python'
      });
      workspaceEvents.documentSaved.fire(savedPy);
      expect(resolveLocalVariableReturnTypeFromSnapshot(
        ['from svc_saved import get_data', 'data = get_data()'], 1, 'data', root
      )).toMatchObject({ annotation: 'SAVED' });
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
      const goneLines = ['from svc_gone import only_svc', 'y = only_svc()'];
      expect(resolveLocalVariableReturnTypeFromSnapshot(goneLines, 1, 'y', root))
        .toMatchObject({ annotation: 'SVCONLY' });
      workspaceEvents.filesDeleted.fire({ files: [Uri.file(path.join(root, 'svc_gone.py'))] });
      expect(resolveLocalVariableReturnTypeFromSnapshot(goneLines, 1, 'y', root)).toBeNull();
      workspaceEvents.filesDeleted.fire({ files: [Uri.file(path.join(root, 'notes.txt'))] });

      // IDE-HOV-015:重命名迁移注解来源(python→python 承接;python→非 python 移除)
      applySavedFileAnnotations(
        root,
        path.join(root, 'svc_ren.py'),
        'def only_ren() -> RENONLY:\n    pass\n'
      );
      expect(resolveLocalVariableReturnTypeFromSnapshot(
        ['from svc_ren import only_ren', 'z = only_ren()'], 1, 'z', root
      )).toMatchObject({ annotation: 'RENONLY' });
      workspaceEvents.filesRenamed.fire({
        files: [{ oldUri: Uri.file(path.join(root, 'svc_ren.py')), newUri: Uri.file(path.join(root, 'svc_ren2.py')) }]
      });
      expect(resolveLocalVariableReturnTypeFromSnapshot(
        ['from svc_ren2 import only_ren', 'z = only_ren()'], 1, 'z', root
      )).toMatchObject({ annotation: 'RENONLY' });
      workspaceEvents.filesRenamed.fire({
        files: [{ oldUri: Uri.file(path.join(root, 'svc_ren2.py')), newUri: Uri.file(path.join(root, 'svc_ren2.txt')) }]
      });
      expect(resolveLocalVariableReturnTypeFromSnapshot(
        ['from svc_ren2 import only_ren', 'z = only_ren()'], 1, 'z', root
      )).toBeNull();

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
      // 索引 5=PROC-TAG-001 文件顶部进程归属镜(kbengine 段变更刷新,与其
      // 它配置敏感 provider 同口径);索引 7=IDE-HOT-100 文件热更状态点(同
      // 口径);索引 6/8=generatedSource/generatedEntitySource 不订阅配置
      // 变更,计数不动
      expect(lensFires.map(read => read())).toEqual([1, 1, 1, 1, 1, 1, 0, 1, 0]);
      // 外层 guard:不影响 kbengine 段时不 fire(计数不动)
      workspaceEvents.configurationChanged.fire({ affectsConfiguration: () => false });
      expect(lensFires.map(read => read())).toEqual([1, 1, 1, 1, 1, 1, 0, 1, 0]);

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
        // AUD-055:面板直开从活动文档解析根(getWorkspaceRootForDocument 读
        // fileName),桩补齐 fileName 与真实 TextDocument 面一致
        document: {
          uri: { fsPath: '/ws/scripts/entity_defs/Hero.def' },
          fileName: '/ws/scripts/entity_defs/Hero.def',
          languageId: 'kbengine-def'
        }
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

  it('IDE-AUD-055 database.open 第4参显式根贯穿到 openTextDocument 的 URI', async () => {
    // 验收:真实命令到 provider 接线——视图/CodeLens 传入的根身份必须落到
    // openTextDocument 的虚拟 URI(query root),provider 才按该根解析快照。
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-extension-root-'));
    const originalFindFiles = workspace.findFiles;
    try {
      workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
      const defsRoot = path.join(root, 'scripts', 'entity_defs');
      fs.mkdirSync(defsRoot, { recursive: true });
      fs.writeFileSync(
        path.join(defsRoot, 'Hero.def'),
        [
          '<root>',
          '  <Properties>',
          '    <hp>',
          '      <Type>UINT32</Type>',
          '      <Flags>BASE</Flags>',
          '      <Persistent>true</Persistent>',
          '    </hp>',
          '  </Properties>',
          '</root>'
        ].join('\n'),
        'utf8'
      );
      fs.writeFileSync(
        path.join(defsRoot, 'entities.xml'),
        '<root>\n  <Hero hasBase="true"/>\n</root>\n',
        'utf8'
      );
      workspace.findFiles = (async (pattern: string): Promise<Uri[]> => {
        if (pattern !== '**/*.def') {
          return originalFindFiles(pattern);
        }
        return [Uri.file(path.join(defsRoot, 'Hero.def'))];
      }) as typeof originalFindFiles;
      workspace.textDocuments = [];

      const context = makeContext();
      activate(context);
      const openedBefore = workspaceState.openTextDocumentCalls.length;

      await commands.executeCommand('kbengine.database.open', 'Hero', undefined, undefined, root);

      const openUri = workspaceState.openTextDocumentCalls.at(-1) as Uri;
      expect(parseDatabaseSchemaRoot(openUri)).toBe(root);
      expect(openUri.toString()).toBe(createDatabaseSchemaUri('Hero', root).toString());

      // 兜底快照按该根解析:能定位到 tbl_Hero(命令不因根串根而报错)
      expect(messages.warning).toHaveLength(0);
      expect(workspaceState.openTextDocumentCalls.length).toBe(openedBefore + 1);
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
  // WIN-3:win32 .cmd→node 真子进程链路慢,平台化超时
  }, 20000);

  it('auto-start 命令走统一依赖图: machine 失败时 logger/dbmgr 不再启动 (R2-F13)', async () => {
    const bin = await FakeComponentBin.create();
    try {
      const configRoot = path.join(bin.root, 'cfg');
      fs.mkdirSync(configRoot, { recursive: true });
      // machine 可执行文件缺失(= 启动失败,startComponent 返回 false);
      // logger/dbmgr 有可执行文件但依赖 machine,不得被启动
      bin.write('logger', { kind: 'run', stdoutMarker: 'logger-up' });
      bin.write('dbmgr', { kind: 'run', stdoutMarker: 'dbmgr-up' });
      configurationOverrides.set('kbengine', {
        binPath: bin.binPath,
        assetsRoot: configRoot,
        autoStart: ['machine', 'logger', 'dbmgr'],
        logAutoConnect: false
      });

      const context = makeContext();
      activate(context);
      const bar = windowState.statusBars.find(item => item.priority === 100)!;

      // 无目标 = 自动/组启动,走统一依赖图(不再逐个盲目启动)
      await commands.executeCommand('kbengine.server.start');
      await new Promise(resolve => setTimeout(resolve, 300));

      // 0 运行:状态栏隐藏;logger/dbmgr 从未启动(无启动标记)
      expect(bar.visible).toBe(false);
      const loggerChannel = windowState.channels.find(item => item.name.includes('Logger'));
      expect(loggerChannel?.lines.join('') ?? '').not.toContain('logger-up');
      const dbmgrChannel = windowState.channels.find(item => item.name.includes('DBMgr'));
      expect(dbmgrChannel?.lines.join('') ?? '').not.toContain('dbmgr-up');

      // 清场(若旧码已把 logger/dbmgr 拉起来,stop 兜底回收)
      await commands.executeCommand('kbengine.server.stop');
      disposeAll(context);
    } finally {
      configurationOverrides.delete('kbengine');
      await bin.dispose();
    }
  });

  it('retry 命令无失败目标时如实说明 (AUD-038)', async () => {
    const context = makeContext();
    activate(context);

    // 全新装配无任何失败登记:命令应说明无可重试目标且不弹 QuickPick
    const result = await commands.executeCommand('kbengine.server.retry');
    expect(result).toBeUndefined();
    expect(messages.info.some(message => message.includes('没有可重试的失败目标'))).toBe(true);

    disposeAll(context);
  });

  it('retry 命令从失败目标选择重试,已就绪目标不重启 (AUD-038)', async () => {
    const bin = await FakeComponentBin.create();
    try {
      const configRoot = path.join(bin.root, 'cfg');
      fs.mkdirSync(configRoot, { recursive: true });
      bin.write('dbmgr', { kind: 'run' });
      configurationOverrides.set('kbengine', {
        binPath: bin.binPath,
        assetsRoot: configRoot,
        autoStart: ['machine', 'dbmgr'],
        logAutoConnect: false
      });

      const context = makeContext();
      activate(context);
      const bar = windowState.statusBars.find(item => item.priority === 100)!;

      // 无目标自动启动:machine 可执行文件缺失 → spawn-failed,dbmgr 被门住
      await commands.executeCommand('kbengine.server.start');
      await new Promise(resolve => setTimeout(resolve, 300));
      expect(bar.visible).toBe(false);

      // 补上 machine 可执行文件;无目标 retry → QuickPick 列失败目标(带原因)
      bin.write('machine', { kind: 'run', stdoutMarker: 'machine-up' });
      const originalPick = fakeWindow.showQuickPick;
      const pickArgs: unknown[] = [];
      fakeWindow.showQuickPick = (async (items: unknown[]) => {
        pickArgs.push(items);
        return (items as Array<{ outcome: unknown }>)[0];
      }) as typeof originalPick;
      try {
        await commands.executeCommand('kbengine.server.retry');
      } finally {
        fakeWindow.showQuickPick = originalPick;
      }

      // 失败原因如实显示在清单里(machine 启动失败/dbmgr 依赖未就绪)
      const listed = pickArgs[0] as Array<{ label: string; description: string }>;
      expect(listed.some(item => item.label === 'machine' && item.description.includes('启动失败'))).toBe(true);
      expect(listed.some(item => item.label === 'dbmgr' && item.description.includes('依赖未就绪'))).toBe(true);

      // 选中 machine 重试 → 启动成功,状态栏 1/10 Running
      await until(() => bar.visible && bar.text === '$(server) KBEngine: 1/10 Running');
      expect(messages.info.some(message => message.includes('machine 已启动'))).toBe(true);

      // 对已就绪 machine 直接 retry:如实报 already-running,不重启
      await commands.executeCommand('kbengine.server.retry', { name: 'machine' });
      expect(messages.info.some(message => message.includes('machine 已在运行,未重启'))).toBe(true);
      await until(() => bar.text === '$(server) KBEngine: 1/10 Running');

      await commands.executeCommand('kbengine.server.stop');
      disposeAll(context);
    } finally {
      configurationOverrides.delete('kbengine');
      await bin.dispose();
    }
  // WIN-3:win32 .cmd→node 真子进程链路慢,平台化超时
  }, 20000);

  it('telnet 探测翻转驱动树刷新与状态灯联动(真 TCP localhost)', async ctx => {
    // 批111 起:配置显式开启 telnet(空 <telnet_service> 段=段在未写端口 →
    // 引擎默认表)才探测;引擎默认表第一个目标 loginapp:31000,起真 server
    // 让探测探到「开启」
    const xmlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-telnet-probe-'));
    fs.writeFileSync(
      path.join(xmlDir, 'kbengine.xml'),
      '<root><telnet_service></telnet_service></root>'
    );
    configurationOverrides.set('kbengine', { 'telnet.configXmlPath': path.join(xmlDir, 'kbengine.xml') });
    // 环境守卫:测试需绑定 127.0.0.1:31000(引擎默认 loginapp telnet 口)。
    // 本机已被占用(如别的工程 demo 引擎在跑)时前提不成立,跳过不误报。
    const bindProbe = net.createServer();
    const bindConflict = await new Promise<boolean>(resolve => {
      bindProbe.once('error', (error: NodeJS.ErrnoException) => resolve(error.code === 'EADDRINUSE'));
      bindProbe.listen(31000, '127.0.0.1', () => {
        bindProbe.close(() => resolve(false));
      });
    });
    if (bindConflict) {
      fs.rmSync(xmlDir, { recursive: true, force: true });
      ctx.skip();
    }
    // 环境守卫(扩):断言写死「1/7 开启」——前提是七口里只有测试自起的
    // 31000 可达。其余 6 个引擎默认 telnet 口若本机有真进程在听(如同机
    // 跑着真引擎 cellapp:50000),探测会数出 N/7,前提不成立,按上面 bind
    // 冲突同款口径跳过不误报。1s 封顶防防火墙静默丢包挂住。
    const occupiedElsewhere = await new Promise<boolean>(resolve => {
      const others = ENGINE_DEFAULT_TELNET_PORTS.filter(entry => entry.port !== 31000);
      let pending = others.length;
      let occupied = false;
      const cap = setTimeout(() => resolve(occupied), 1000);
      cap.unref();
      for (const entry of others) {
        const socket = net.connect({ host: '127.0.0.1', port: entry.port });
        const done = (hit: boolean): void => {
          if (pending <= 0) {
            return;
          }
          socket.destroy();
          occupied = occupied || hit;
          pending -= 1;
          if (pending === 0) {
            clearTimeout(cap);
            resolve(occupied);
          }
        };
        socket.once('connect', () => done(true));
        socket.once('error', () => done(false));
      }
    });
    if (occupiedElsewhere) {
      fs.rmSync(xmlDir, { recursive: true, force: true });
      ctx.skip();
    }
    const server = await new Promise<import('net').Server>(resolve => {
      const created = net.createServer(socket => {
        socket.on('error', () => undefined);
        socket.destroy();
      });
      created.listen(31000, '127.0.0.1', () => resolve(created));
    });
    const context = makeContext();
    activate(context);
    // KODE-CFG-009:目标配置读值半经 core 解析(`$/kode/config/resolve`)——
    // 契约门替身在 activate 后装(activate 装配覆写门),并按探测同款
    // overrides(customXmlPath)预取消费态:探测每轮只同步读缓存,不预取则
    // 要多等一轮(10s)才见目标。测毕还原。
    const previousGate = getKodeCoreShadowGate();
    setKodeCoreShadowGate(makeContractGate([]));
    resetConfigResolveForTests();
    await ensureConfigResolved({ customXmlPath: path.join(xmlDir, 'kbengine.xml') });
    try {
      const telnetBar = windowState.statusBars.find(item => item.priority === 99)!;
      // 探测翻转(默认定时器 5s 一轮;首轮 start 即发)→ onDidChange 回调
      // → serverControlProvider.refresh() + updateTelnetStatusBar
      await until(() => telnetBar.text === '$(plug) Telnet: 1/7 开启' && telnetBar.visible);
      expect(telnetBar.command).toBe('kbengine.telnet.showPanel');
      expect(commandRegistry.contexts.get('kbengine.telnetConfigured')).toBe(true);
    } finally {
      setKodeCoreShadowGate(previousGate);
      resetConfigResolveForTests();
      disposeAll(context);
      configurationOverrides.delete('kbengine');
      fs.rmSync(xmlDir, { recursive: true, force: true });
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }, 30000);

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
      // 编辑事件只排队:桶未同步可见(此前每个编辑事件同步整文件提取 120ms;
      // 批 D 后断言走桶访问器,查询不再消费桶)
      workspaceEvents.documentChanged.fire({ document: doc });
      expect(getDocumentReturnAnnotationBucketForTests(root, Uri.file(path.join(root, 'main.py')).toString()))
        .toBeUndefined();
      // 冲刷队列:让出式异步提取完成后桶才落地
      await flushPendingDocumentReturnAnnotationsForTests();
      expect(getDocumentReturnAnnotationBucketForTests(root, Uri.file(path.join(root, 'main.py')).toString())?.annotations.get('get_data'))
        .toBe('NEW');
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
      const channel = windowState.channels.find(entry => entry.name === 'Kode Reproduction Summary');
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
