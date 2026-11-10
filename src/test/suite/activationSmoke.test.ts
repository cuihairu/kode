import * as assert from 'assert';
import { createRequire } from 'module';
import type * as vscode from 'vscode';
import {
  loadCompiledVscodeStub,
  loadModuleWithMocks,
  resetCompiledVscodeStub,
  type CompiledVscodeStub
} from './testUtils';

// 编译产物装配烟测(docs/redesign.md 阶段 4):加载 tsc 产物 out/extension.js,
// 注入 fake-vscode 编译副本后整体激活。vitest 层的 extension.test.ts 已在源码
// 级全面覆盖装配;本层的独立价值是验证打包形态(main: ./out/extension.js)
// 的模块图完整、tsc 产物可激活、命令真分发、dispose 链可用。保持最小断言。

type ExtensionModule = typeof import('../../extension');
const manifest = createRequire(__filename)('../../../package.json');

describe('compiled extension activation smoke', () => {
  const stub: CompiledVscodeStub = loadCompiledVscodeStub();
  let extension: ExtensionModule;
  let context: {
    subscriptions: Array<{ dispose(): void }>;
    extensionUri: unknown;
  };

  before(async () => {
    resetCompiledVscodeStub(stub);
    // 无工作区分支:不触发初始 def 扫描,烟测不依赖文件树
    stub.workspace.workspaceFolders = undefined;
    context = { subscriptions: [], extensionUri: stub.Uri.file(__dirname) };

    const { loadedModule } = loadModuleWithMocks<ExtensionModule>(__filename, '../../extension', {
      vscode: stub
    });
    extension = loadedModule;
    await extension.activate(context as unknown as vscode.ExtensionContext);
  });

  it('registers exactly the commands contributed by the manifest', () => {
    const declared = manifest.contributes.commands.map((item: { command: string }) => item.command);

    // 显式豁免一例:真机 NLS 探针 kbengine.l10nProbe(UX-REVIEW-010f)有意
    // 不进 contributes=不出命令面板,专供真机层 suite 经 executeCommand 取词;
    // 豁免项仍须真实注册,清单外注册面与声明面严格互等(与
    // tests/extension.test.ts 同一条款,本文件此前漏配该豁免致 mocha 门红)。
    const intentionalUndeclared = ['kbengine.l10nProbe'];
    const registered = [...stub.commandRegistry.registeredCommandIds()];
    for (const id of intentionalUndeclared) {
      assert.ok(registered.includes(id), `${id} should be registered (exempt but real)`);
    }
    assert.deepStrictEqual(
      registered.filter(id => !intentionalUndeclared.includes(id)).sort(),
      [...declared].sort()
    );
  });

  it('registers the tree views declared by the manifest', () => {
    const declaredViews = (Object.values(manifest.contributes.views) as Array<Array<{ id: string }>>)
      .flat()
      .map(item => item.id);

    // 视图先行占位(startupViewPlaceholders,75f766b1):activate 最前为全部侧栏
    // 视图注册空占位 provider,真 provider 在装配尾段后到接管(宿主同 id 注册
    // 是覆写语义)。故逐 id 出现 1 次(仅占位,无真 provider 的视图)或 2 次
    // (占位+真);注册面不得出现未声明 id,声明面不得缺注册。
    const registered = stub.treeRegistrations.map(item => item.viewId);
    assert.deepStrictEqual([...new Set(registered)].sort(), [...declaredViews].sort());
    for (const viewId of new Set(registered)) {
      const count = registered.filter(id => id === viewId).length;
      assert.ok(count >= 1 && count <= 2, `${viewId} 注册 ${count} 次,越界(1..2)`);
    }
  });

  it('creates the status bar items with the configured alignment', () => {
    // 六盏灯各归其位(2026-11-06 盘点五盏 + KB-GC-001 console 日志 tail 灯):
    // 100=服务器运行计数,99=telnet 探测,98=热更发送态,97=Python 解释器
    // (PY-ENV),96=热更通道快捷切换,95=console 日志 tail(console.ts,文本随
    // machined 发现状态变化,可视性时序相关故不断言)。每盏只建一次(装配期
    // 构造,刷新只改文本/显隐),故总数必须恒为 6——多建=装配抖动,少建=
    // 某条装配路被砍,两种都算回归。
    assert.strictEqual(stub.windowState.statusBars.length, 6);
    const priorities = stub.windowState.statusBars.map(bar => bar.priority).sort((a, b) => b - a);
    assert.deepStrictEqual(priorities, [100, 99, 98, 97, 96, 95]);
    // 全部右对齐,不与 VS Code 内建左槽抢位
    for (const bar of stub.windowState.statusBars) {
      assert.strictEqual(bar.alignment, stub.StatusBarAlignment.Right, `priority ${bar.priority} 应右对齐`);
    }

    const server = stub.windowState.statusBars.find(bar => bar.priority === 100);
    assert.ok(server);
    assert.strictEqual(server.visible, false);
    // telnet 探测状态灯(批111 用户令):配置未开启 telnet 时整族入口隐藏,
    // 状态灯不出现,setContext 落 false(命令面板入口经 when 子句同门控)
    const telnet = stub.windowState.statusBars.find(bar => bar.priority === 99);
    assert.ok(telnet);
    assert.strictEqual(telnet.visible, false);
    assert.strictEqual(
      stub.commandRegistry.contexts.get('kbengine.telnetConfigured'),
      false
    );
    // 热更新状态灯:常亮灯(watch-off 也显示),点击开「KBEngine 热更」日志通道
    const hotReload = stub.windowState.statusBars.find(bar => bar.priority === 98);
    assert.ok(hotReload);
    assert.strictEqual(hotReload.visible, true);
    // 解释器状态灯(PY-ENV 二期):激活期即解析并 show(),点击进解释器 QuickPick
    const interpreter = stub.windowState.statusBars.find(bar => bar.priority === 97);
    assert.ok(interpreter);
    assert.strictEqual(interpreter.visible, true);
    assert.strictEqual(interpreter.command, 'kbengine.python.selectInterpreter');
    // 热更通道快捷切换灯:常亮,点击三选切换通道(探活后落 profile)
    const channelSwitch = stub.windowState.statusBars.find(bar => bar.priority === 96);
    assert.ok(channelSwitch);
    assert.strictEqual(channelSwitch.visible, true);
    assert.strictEqual(channelSwitch.command, 'kbengine.hotReload.switchChannel');
  });

  it('dispatches a compiled command end to end', async () => {
    const executeCommand = stub.commands.executeCommand as (
      command: string,
      ...args: unknown[]
    ) => Promise<unknown>;

    await executeCommand('kbengine.logs.showViewer');

    assert.strictEqual(stub.panelRegistry.panels[0]?.viewType, 'kbengine.logViewer');
  });

  it('deactivates cleanly and the dispose chain tears registrations down', () => {
    assert.strictEqual(extension.deactivate(), undefined);

    for (const disposable of context.subscriptions) {
      disposable.dispose();
    }

    assert.deepStrictEqual(stub.commandRegistry.registeredCommandIds(), []);
    assert.ok(stub.windowState.statusBars.every(bar => bar.disposed));
  });
});
