import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';

import { activate, deactivate } from '../src/extension';
import { commandRegistry, commands } from './fake-vscode/commandRegistry';
import { messages, window as fakeWindow, windowState } from './fake-vscode/windowState';
import { configurationOverrides, workspaceEvents } from './fake-vscode/workspaceState';
import {
  CORE_SHADOW_CHANNEL_NAME,
  SHOW_SHADOW_DIFF_LOG_COMMAND,
  discoverKodeServerBinary
} from '../src/kodeCoreGateWiring';
import { Uri, type ExtensionContext } from './fake-vscode/core';

// kode2 PR-012:双轨切流门装配测。铁律断言三件套:
// ① 默认 backend=rust(2026-11-08 用户令「直接切」)下无 shadow 输出通道
//    (rust 服务轨道非 shadow,不建差异日志通道);未配 serverPath 时服务
//    轨道回落 ts,同样无进程、无通道;
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
  it('默认 backend=rust(未配 serverPath):命令在位,无 shadow 通道,服务轨道回落 ts 安全', () => {
    const context = makeContext();
    activate(context);

    expect(commandRegistry.registeredCommandIds()).toContain(SHOW_SHADOW_DIFF_LOG_COMMAND);
    expect(shadowChannel()).toBeUndefined();

    disposeAll(context);
  });

  it('默认 rust 下执行 showShadowDiffLog:信息指路(backend=rust),不建通道', async () => {
    const context = makeContext();
    activate(context);

    await commands.executeCommand(SHOW_SHADOW_DIFF_LOG_COMMAND);
    expect(messages.info).toHaveLength(1);
    expect(messages.info[0]).toContain('backend=rust');
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

  it('rust 服务轨道:不建 shadow 通道(非 shadow),服务面不因装配建进程', () => {
    setCore({ 'core.backend': 'rust', 'core.serverPath': '/opt/kode/bin/kode-server' });
    const context = makeContext();
    activate(context);

    // rust 服务轨道不是 shadow:不建差异日志通道;装配不主动拉起进程。
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

  it('discoverKodeServerBinary:target/debug 优先,target/release 兜底,全落空空串', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-wiring-'));
    try {
      // 全落空
      expect(discoverKodeServerBinary(root)).toBe('');
      // 只有 release
      const releaseDir = path.join(root, 'target', 'release');
      fs.mkdirSync(releaseDir, { recursive: true });
      fs.writeFileSync(path.join(releaseDir, 'kode-server'), 'x');
      expect(discoverKodeServerBinary(root)).toBe(path.join(releaseDir, 'kode-server'));
      // debug 优先于 release
      const debugDir = path.join(root, 'target', 'debug');
      fs.mkdirSync(debugDir, { recursive: true });
      fs.writeFileSync(path.join(debugDir, 'kode-server'), 'x');
      expect(discoverKodeServerBinary(root)).toBe(path.join(debugDir, 'kode-server'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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
