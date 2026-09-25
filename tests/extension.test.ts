import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import { activate, deactivate } from '../src/extension';
import packageJson from '../package.json';
import { commandRegistry, commands } from './fake-vscode/commandRegistry';
import { languagesRegistry } from './fake-vscode/languages';
import { messages, treeRegistrations, window as fakeWindow, windowState } from './fake-vscode/windowState';
import {
  workspace,
  workspaceEvents,
  workspaceState,
  configurationOverrides
} from './fake-vscode/workspaceState';
import { panelRegistry } from './fake-vscode/panelRegistry';
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
  extensionUri: Uri.file('/workspace/ext')
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
  workspace.workspaceFolders = [];
});

describe('extension activate 装配', () => {
  it('注册面与 package.json 贡献点一致', () => {
    const context = makeContext();
    activate(context);

    // 命令:activate 注册的 id 集合与 package.json 声明严格一致
    // (防"漏注册/漏声明"两类回归,重设计问题 P14 的核心验收)
    expect(commandRegistry.allRegisteredCommandIds().sort())
      .toEqual(declared.commands.map(entry => entry.command).sort());

    // 树视图:两个视图 id 与 views 贡献点一致
    const declaredViewIds = Object.values(declared.views)
      .flat()
      .map(view => view.id)
      .sort();
    expect(treeRegistrations.map(item => item.viewId).sort()).toEqual(declaredViewIds);

    // 语言服务:补全 2(.def + Python)、悬停 1、定义 2、调用层级 1
    expect(languagesRegistry.completionRegistrations).toHaveLength(2);
    expect(languagesRegistry.hoverRegistrations).toHaveLength(1);
    expect(languagesRegistry.definitionRegistrations).toHaveLength(2);
    expect(languagesRegistry.callHierarchyRegistrations).toHaveLength(1);
    expect(languagesRegistry.diagnosticCollections.map(entry => entry.name)).toEqual(['kbengine']);

    // 虚拟文档提供者:数据库 schema
    expect(workspaceState.contentProviders.has('kbengine-db-schema')).toBe(true);

    // 状态栏:右对齐/优先级 100/命令指向扩展视图,无运行组件时隐藏
    expect(windowState.statusBars).toHaveLength(1);
    const bar = windowState.statusBars[0];
    expect(bar.alignment).toBe(StatusBarAlignment.Right);
    expect(bar.priority).toBe(100);
    expect(bar.command).toBe('workbench.view.extension.kbengine-explorer');
    expect(bar.visible).toBe(false);

    // 所有 subscription 都可 dispose
    for (const disposable of context.subscriptions) {
      expect(typeof disposable.dispose).toBe('function');
    }

    expect(deactivate()).toBeUndefined();
    disposeAll(context);
  });

  it('激活后逐条执行命令,关键链路经 CommandRegistry 真分发', async () => {
    const context = makeContext();
    activate(context);

    // explorer 刷新
    await commands.executeCommand('kbengine.refreshExplorer');

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
    // stop 处理器以 void 丢弃 Promise(不等待结果),命令面返回 undefined
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

    // 目标载荷的三处空值早退(命令体直接 return,无消息)
    const warningsBefore = messages.warning.length;
    await commands.executeCommand('kbengine.entity.open', '');
    await commands.executeCommand('kbengine.entity.method.open', null);
    await commands.executeCommand('kbengine.database.open', '');
    expect(messages.warning.length).toBe(warningsBefore);

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
    // 已注销命令不再可执行
    await expect(commands.executeCommand('kbengine.refreshExplorer'))
      .rejects.toThrow('command not registered');
  });

  it('有工作区时激活扫描初始 def 文档并联动文档/配置事件', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-extension-'));
    try {
      workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];

      const badDef = makeTextDocument(BAD_DEF, {
        fileName: path.join(root, 'scripts', 'entity_defs', 'Hero.def')
      });
      const plainDoc = makeTextDocument('hello', {
        fileName: path.join(root, 'notes.txt'),
        languageId: 'plaintext'
      });
      workspace.textDocuments = [badDef, plainDoc];

      const context = makeContext();
      activate(context);
      const collection = languagesRegistry.diagnosticCollections[0].collection;

      // 初始扫描:坏 Flags 的 def 有 Error 诊断,纯文本文档不校验
      expect(collection.get(badDef.uri).length).toBeGreaterThan(0);
      expect(collection.get(plainDoc.uri)).toHaveLength(0);

      // 文档变更事件:def 触发重校验
      const changedDef = makeTextDocument(BAD_DEF, {
        fileName: path.join(root, 'scripts', 'entity_defs', 'Monster.def')
      });
      workspaceEvents.documentChanged.fire({ document: changedDef });
      expect(collection.get(changedDef.uri).length).toBeGreaterThan(0);

      // 配置变更事件:不影响 kbengine 段时不重扫,影响时重扫 textDocuments
      const lateDef = makeTextDocument(BAD_DEF, { fileName: path.join(root, 'Late.def') });
      workspace.textDocuments = [badDef, lateDef];
      workspaceEvents.configurationChanged.fire({ affectsConfiguration: () => false });
      expect(collection.get(lateDef.uri)).toHaveLength(0);
      workspaceEvents.configurationChanged.fire({
        affectsConfiguration: (section: string) => section === 'kbengine'
      });
      expect(collection.get(lateDef.uri).length).toBeGreaterThan(0);

      // 打开文档事件:def 文档触发校验
      const openedDef = makeTextDocument(BAD_DEF, { fileName: path.join(root, 'Opened.def') });
      workspaceEvents.documentOpened.fire(openedDef);
      expect(collection.get(openedDef.uri).length).toBeGreaterThan(0);

      // entity.open happy path:真实落盘 def 后打开定义文件
      const defsRoot = path.join(root, 'scripts', 'entity_defs');
      fs.mkdirSync(defsRoot, { recursive: true });
      fs.writeFileSync(path.join(defsRoot, 'Avatar.def'), '<root/>\n', 'utf8');
      fs.writeFileSync(
        path.join(defsRoot, 'entities.xml'),
        '<root>\n  <Avatar> <hasClient/></Avatar>\n</root>\n',
        'utf8'
      );
      await commands.executeCommand('kbengine.entity.open', 'Avatar');
      expect(messages.warning).toHaveLength(0);
      expect((workspaceState.openTextDocumentCalls.at(-1) as Uri).fsPath).toContain('Avatar.def');
      expect(windowState.showTextDocumentCalls.at(-1)?.document).toBeDefined();

      // 打开失败的 catch 分支:openTextDocument 抛错 → 两类打开命令各报具体原因
      const originalOpen = workspace.openTextDocument;
      workspace.openTextDocument = (async (): Promise<never> => {
        throw new Error('boom');
      }) as typeof originalOpen;
      messages.warning.length = 0;
      await commands.executeCommand('kbengine.entity.open', 'Avatar');
      await commands.executeCommand('kbengine.database.open', 'Hero');
      expect(messages.warning.some(message => message.includes('打开实体定义失败: Avatar.def (Error: boom)'))).toBe(true);
      expect(messages.warning.some(message => message.includes('打开数据库结构失败: Hero (Error: boom)'))).toBe(true);
      workspace.openTextDocument = originalOpen;

      disposeAll(context);
    } finally {
      workspace.workspaceFolders = [];
      workspace.textDocuments = [];
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('server 命令经解析载荷驱动真实假组件进程,状态栏随运行数联动', async () => {
    const bin = await FakeComponentBin.create();
    try {
      const configRoot = path.join(bin.root, 'cfg');
      fs.mkdirSync(configRoot, { recursive: true });
      bin.write('machine', { kind: 'run', stdoutMarker: 'up' });
      configurationOverrides.set('kbengine', {
        binPath: bin.binPath,
        configPath: configRoot,
        logAutoConnect: false
      });

      const context = makeContext();
      activate(context);
      const bar = windowState.statusBars[0];

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
});
