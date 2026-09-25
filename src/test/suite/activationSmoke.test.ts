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

    assert.deepStrictEqual(
      [...stub.commandRegistry.registeredCommandIds()].sort(),
      [...declared].sort()
    );
  });

  it('registers the tree views declared by the manifest', () => {
    const declaredViews = (Object.values(manifest.contributes.views) as Array<Array<{ id: string }>>)
      .flat()
      .map(item => item.id);

    assert.deepStrictEqual(
      stub.treeRegistrations.map(item => item.viewId).sort(),
      [...declaredViews].sort()
    );
  });

  it('creates the status bar item hidden with the configured alignment', () => {
    assert.strictEqual(stub.windowState.statusBars.length, 1);
    const bar = stub.windowState.statusBars[0];
    assert.strictEqual(bar.alignment, stub.StatusBarAlignment.Right);
    assert.strictEqual(bar.priority, 100);
    assert.strictEqual(bar.visible, false);
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
