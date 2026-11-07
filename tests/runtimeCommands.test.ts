import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { activate, deactivate } from '../src/extension';
import { commandRegistry, commands } from './fake-vscode/commandRegistry';
import { messages, windowState } from './fake-vscode/windowState';
import { Uri, type ExtensionContext } from './fake-vscode/core';

beforeEach(() => {
  commandRegistry.reset();
  windowState.channels.length = 0;
  messages.info.length = 0;
  messages.warning.length = 0;
  messages.error.length = 0;
});

afterEach(() => {
  // extension activate registers cleanup disposables; each test creates one.
});

describe('runtime command surface', () => {
  it('warns when no runtime components are discovered', async ctx => {
    // 环境守卫:本机有真 KBEngine machine daemon(UDP 20086 应答,如 demo 引擎
    // 在跑)时 discovery 必然找到组件,「无组件如实提示」前提不成立——跳过,
    // 不在本机引擎在场时误报红
    const { discoverLocalComponents } = await import('../src/kbengineProtocol');
    const live = await discoverLocalComponents({ timeoutMs: 400 }).catch(() => []);
    if (live.length > 0) {
      ctx.skip();
    }
    const context: ExtensionContext = { subscriptions: [], extensionUri: Uri.file('/tmp') };
    activate(context);
    await new Promise(resolve => setTimeout(resolve, 100));

    await commands.executeCommand('kbengine.profile.start', 'baseapp', 'pyprofile');
    expect(messages.warning.at(-1)).toBe('未发现可查询的 KBEngine 组件');

    await commands.executeCommand('kbengine.spaces.query');
    expect(messages.warning.at(-1)).toBe('未发现可查询的 KBEngine 组件');

    for (const disposable of context.subscriptions) disposable.dispose();
    expect(deactivate()).toBeUndefined();
  });
});
