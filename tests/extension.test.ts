import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import { activate, deactivate } from '../src/extension';
import { getDatabaseSchemaSnapshot, locateDatabaseSchemaLine } from '../src/databaseSchema';
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

    // 语言服务:补全 2(.def + Python)、悬停 1、定义 2、调用层级 1、重命名 1
    expect(languagesRegistry.completionRegistrations).toHaveLength(2);
    expect(languagesRegistry.hoverRegistrations).toHaveLength(1);
    expect(languagesRegistry.definitionRegistrations).toHaveLength(2);
    expect(languagesRegistry.callHierarchyRegistrations).toHaveLength(1);
    expect(languagesRegistry.renameRegistrations).toHaveLength(1);
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

      // 变更/打开事件的非 def 文档:isDefDocument 假分支,跳过校验
      const plainChanged = makeTextDocument('hello', {
        fileName: path.join(root, 'notes-changed.txt'),
        languageId: 'plaintext'
      });
      workspaceEvents.documentChanged.fire({ document: plainChanged });
      workspaceEvents.documentOpened.fire(plainChanged);
      expect(collection.get(plainChanged.uri)).toHaveLength(0);

      // 配置变更事件:不影响 kbengine 段时不重扫,影响时重扫 textDocuments
      const lateDef = makeTextDocument(BAD_DEF, { fileName: path.join(root, 'Late.def') });
      workspace.textDocuments = [badDef, lateDef, plainDoc];
      workspaceEvents.configurationChanged.fire({ affectsConfiguration: () => false });
      expect(collection.get(lateDef.uri)).toHaveLength(0);
      workspaceEvents.configurationChanged.fire({
        affectsConfiguration: (section: string) => section === 'kbengine'
      });
      expect(collection.get(lateDef.uri).length).toBeGreaterThan(0);
      // 重扫对非 def 文档跳过校验(isDefDocument 假分支)
      expect(collection.get(plainDoc.uri)).toHaveLength(0);

      // 打开文档事件:def 文档触发校验
      const openedDef = makeTextDocument(BAD_DEF, { fileName: path.join(root, 'Opened.def') });
      workspaceEvents.documentOpened.fire(openedDef);
      expect(collection.get(openedDef.uri).length).toBeGreaterThan(0);

      // entity.open happy path:真实落盘 def 后打开定义文件
      await commands.executeCommand('kbengine.entity.open', 'Avatar');
      expect(messages.warning).toHaveLength(0);
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
