import { beforeEach, describe, expect, it } from 'vitest';

import { activate, deactivate } from '../src/extension';
import { commandRegistry, commands } from './fake-vscode/commandRegistry';
import { messages, window as fakeWindow, windowState } from './fake-vscode/windowState';
import { configurationOverrides, workspaceEvents } from './fake-vscode/workspaceState';
import { CORE_SHADOW_CHANNEL_NAME, SHOW_SHADOW_DIFF_LOG_COMMAND } from '../src/kodeCoreGateWiring';
import { Uri, type ExtensionContext } from './fake-vscode/core';

// kode2 PR-012:双轨切流门装配测。铁律断言三件套:
// ① 默认 backend=ts 下零用户可见变化(无输出通道、无进程);
// ② shadow 开启才出现差异日志通道;
// ③ kill-switch 切回 ts 即撤通道(kill-switch 演练的装配面判据)。
// 进程级 shadow 链路在 kodeCoreGate.test.ts 的假 stdio server 覆盖。

const makeContext = (): ExtensionContext => ({
  subscriptions: [],
  extensionUri: Uri.file('/workspace/ext')
});

const setCore = (core: Record<string, unknown>): void => {
  const current = configurationOverrides.get('kbengine') as Record<string, unknown> | undefined;
  configurationOverrides.set('kbengine', { ...current, ...core });
};

const disposeAll = (context: ExtensionContext): void => {
  deactivate();
  for (const disposable of context.subscriptions) {
    disposable.dispose();
  }
};

beforeEach(() => {
  commandRegistry.reset();
  windowState.reset();
  configurationOverrides.clear();
  workspaceEvents.configurationChanged.dispose();
});

const shadowChannel = () =>
  windowState.channels.find(channel => channel.name === CORE_SHADOW_CHANNEL_NAME);

describe('kbengine.core 双轨切流门装配', () => {
  it('默认 backend=ts:命令在位,无 shadow 输出通道,无任何配置覆写也安全', () => {
    const context = makeContext();
    activate(context);

    expect(commandRegistry.registeredCommandIds()).toContain(SHOW_SHADOW_DIFF_LOG_COMMAND);
    expect(shadowChannel()).toBeUndefined();

    disposeAll(context);
  });

  it('默认 ts 下执行 showShadowDiffLog:信息指路,不建通道', async () => {
    const context = makeContext();
    activate(context);

    await commands.executeCommand(SHOW_SHADOW_DIFF_LOG_COMMAND);
    expect(messages.info).toHaveLength(1);
    expect(messages.info[0]).toContain('backend=ts');
    expect(shadowChannel()).toBeUndefined();

    disposeAll(context);
  });

  it('backend=shadow + serverPath:通道就绪;配置变更切回 ts 即撤通道(kill-switch)', () => {
    setCore({ 'core.backend': 'shadow', 'core.serverPath': '/opt/kode/bin/kode-server' });
    const context = makeContext();
    activate(context);

    const channel = shadowChannel();
    expect(channel).toBeDefined();
    expect(channel?.disposed).toBe(false);

    // kill-switch 演练:一键回 ts
    setCore({ 'core.backend': 'ts' });
    workspaceEvents.configurationChanged.fire({
      affectsConfiguration: (section: string) => section === 'kbengine.core.backend'
    });
    expect(shadowChannel()?.disposed).toBe(true);

    disposeAll(context);
  });

  it('rust 保留值:生效轨道仍是 ts,不建通道(notice 留在门状态里)', () => {
    setCore({ 'core.backend': 'rust', 'core.serverPath': '/opt/kode/bin/kode-server' });
    const context = makeContext();
    activate(context);

    expect(shadowChannel()).toBeUndefined();

    disposeAll(context);
  });

  it('无关配置变更不触碰门(通道保持)', () => {
    setCore({ 'core.backend': 'shadow', 'core.serverPath': '/opt/kode/bin/kode-server' });
    const context = makeContext();
    activate(context);

    workspaceEvents.configurationChanged.fire({
      affectsConfiguration: (section: string) => section === 'kbengine.jumpLog'
    });
    expect(shadowChannel()?.disposed).toBe(false);

    disposeAll(context);
  });
});
