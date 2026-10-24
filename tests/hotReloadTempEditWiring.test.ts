import { beforeEach, describe, expect, it } from 'vitest';
import { activate, deactivate } from '../src/extension';
import { commandRegistry, commands } from './fake-vscode/commandRegistry';
import { languagesRegistry } from './fake-vscode/languages';
import { messages, window as fakeWindow, windowState } from './fake-vscode/windowState';
import { configurationOverrides, workspace } from './fake-vscode/workspaceState';
import { Uri, type ExtensionContext } from './fake-vscode/core';

// 临时编辑热重载 quick action(书 §19 HR-PR-02)装配:
// 命令注册在位、开关默认关先拦、开启后无编辑器指路。执行链由
// hotReloadTempEdit.test.ts 的假腿端到端覆盖,这里不碰真文件。

const makeContext = (): ExtensionContext => ({
  subscriptions: [],
  extensionUri: Uri.file('/workspace/ext')
});

const setTempEdit = (tempEdit: Record<string, unknown>): void => {
  const current = configurationOverrides.get('kbengine') as Record<string, unknown> | undefined;
  const hotReload = (current?.hotReload as Record<string, unknown> | undefined) ?? {};
  configurationOverrides.set('kbengine', { ...current, hotReload: { ...hotReload, tempEdit } });
};

beforeEach(() => {
  commandRegistry.reset();
  windowState.reset();
  configurationOverrides.clear();
  workspace.workspaceFolders = [];
  (fakeWindow as unknown as Record<string, unknown>).activeTextEditor = undefined;
});

describe('kbengine.hotReload.tempEdit.run 装配', () => {
  it('命令注册在位,诊断集与输出通道就绪', () => {
    const context = makeContext();
    activate(context);

    expect(commandRegistry.registeredCommandIds()).toContain('kbengine.hotReload.tempEdit.run');
    expect(languagesRegistry.diagnosticCollections.map(item => item.name)).toContain(
      'KBEngine 临时编辑热更新'
    );

    deactivate();
    for (const disposable of context.subscriptions) {
      disposable.dispose();
    }
    expect(commandRegistry.registeredCommandIds()).not.toContain('kbengine.hotReload.tempEdit.run');
  });

  it('开关默认关:命令直接拦截,不读文件不发请求', async () => {
    const context = makeContext();
    activate(context);

    await commands.executeCommand('kbengine.hotReload.tempEdit.run');
    expect(messages.warning).toHaveLength(1);
    expect(messages.warning[0]).toContain('已停用');

    deactivate();
    for (const disposable of context.subscriptions) {
      disposable.dispose();
    }
  });

  it('开启但无活动编辑器:信息指路,不进入执行链', async () => {
    setTempEdit({ enabled: true, actionName: '热更新' });
    const context = makeContext();
    activate(context);

    await commands.executeCommand('kbengine.hotReload.tempEdit.run');
    expect(messages.info).toHaveLength(1);
    expect(messages.info[0]).toContain('活动编辑器');

    deactivate();
    for (const disposable of context.subscriptions) {
      disposable.dispose();
    }
  });
});
