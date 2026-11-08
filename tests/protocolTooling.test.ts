//! PA-007 第一增量:协议工具链检测采集/渲染/装配面。
//! fixture 与解析面测试同源(本机 tshark 4.6.4 实测输出)。

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';

import { commandRegistry, commands } from './fake-vscode/commandRegistry';
import { Uri, type ExtensionContext } from './fake-vscode/core';
import { windowState } from './fake-vscode/windowState';
import { configurationOverrides, workspaceEvents } from './fake-vscode/workspaceState';
import {
  PROTOCOL_CHANNEL_NAME,
  SHOW_PROTOCOL_STATUS_COMMAND,
  collectProtocolToolingStatus,
  defaultRunBinary,
  discoverKodeCliBinary,
  renderProtocolToolingStatus,
  setupProtocolTooling,
  type ProtocolToolingStatus,
  type RunBinary,
} from '../src/protocolTooling';

// ---------------------------------------------------------------- fixtures

const TSHARK_V = 'TShark (Wireshark) 4.6.4.\n';
const WIRESHARK_V = 'Wireshark 4.6.4 (Git v4.6.4)\n';

const FOLDERS_OUT = [
  'Personal Plugins:   \t/home/u/.local/lib/wireshark/plugins/4.6',
  'Global Plugins:     \t/usr/lib/x86_64-linux-gnu/wireshark/plugins/4.6',
  'Personal Lua Plugins:\t/home/u/.local/lib/wireshark/plugins',
  '',
].join('\n');

const pluginsOut = (kbengineLine: string | null): string => {
  const base = [
    'amrnb.so\t0.1.0\tcodec\t/usr/lib/x86_64-linux-gnu/wireshark/plugins/4.6/codecs/amrnb.so',
  ];
  const rows = kbengineLine === null ? base : [...base, kbengineLine];
  return `${rows.join('\n')}\n`;
};

const KBENGINE_OK =
  'libwireshark_kbengine.so\t0.1.0\tdissector\t/usr/lib/x86_64-linux-gnu/wireshark/plugins/4.6/epan/libwireshark_kbengine.so';
const KBENGINE_MISMATCH =
  'libwireshark_kbengine.so\t0.1.0\tdissector\t/opt/wireshark/plugins/4.4/epan/libwireshark_kbengine.so';

/** 按 (file, args) 分发的假 run:未命中的调用一律 ENOENT 收敛。 */
function fakeRun(
  table: Record<string, string>
): RunBinary {
  return async (file, args) => {
    const key = `${file} ${args.join(' ')}`;
    const out = table[key];
    if (out === undefined) {
      return { code: -1, stdout: '' };
    }
    return { code: 0, stdout: out };
  };
}

const happyTable = (): Record<string, string> => ({
  'tshark -v': TSHARK_V,
  'tshark -G folders': FOLDERS_OUT,
  'tshark -G plugins': pluginsOut(KBENGINE_OK),
  'wireshark -v': WIRESHARK_V,
  '/opt/kode/kode-kbengine --version': 'kode-kbengine 0.2.0\n'
});

const makeDeps = (
  table: Record<string, string>,
  overrides: Partial<{ cliPath: string; extensionRoot: string }> = {}
) => ({
  run: fakeRun(table),
  tsharkPath: 'tshark',
  wiresharkPath: 'wireshark',
  cliPath: overrides.cliPath ?? '',
  extensionRoot: overrides.extensionRoot ?? '/workspace/ext',
});

// ------------------------------------------------------------ discoverCli

describe('PA-007:discoverKodeCliBinary', () => {
  it('returns empty when no target artifact exists', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-pa007-'));
    try {
      expect(discoverKodeCliBinary(root, 'kode-kbengine')).toBe('');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('prefers debug over release, like the core gate discovery', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-pa007-'));
    const executable = process.platform === 'win32' ? 'kode-kbengine.exe' : 'kode-kbengine';
    try {
      fs.mkdirSync(path.join(root, 'target', 'debug'), { recursive: true });
      fs.mkdirSync(path.join(root, 'target', 'release'), { recursive: true });
      fs.writeFileSync(path.join(root, 'target', 'debug', executable), '');
      fs.writeFileSync(path.join(root, 'target', 'release', executable), '');
      expect(discoverKodeCliBinary(root, 'kode-kbengine')).toContain(
        path.join('target', 'debug')
      );
      fs.rmSync(path.join(root, 'target', 'debug', executable));
      expect(discoverKodeCliBinary(root, 'kode-kbengine')).toContain(
        path.join('target', 'release')
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ----------------------------------------------------------------- collect

describe('PA-007:collectProtocolToolingStatus', () => {
  it('assembles the full happy path from real-shaped outputs', async () => {
    const status = await collectProtocolToolingStatus(
      makeDeps(happyTable(), { cliPath: '/opt/kode/kode-kbengine' })
    );
    expect(status.tsharkVersion).toBe('4.6.4');
    expect(status.wiresharkVersion).toBe('4.6.4');
    expect(status.personalPlugins).toBe('/home/u/.local/lib/wireshark/plugins/4.6');
    expect(status.globalPlugins).toBe(
      '/usr/lib/x86_64-linux-gnu/wireshark/plugins/4.6'
    );
    expect(status.plugin?.name).toBe('libwireshark_kbengine.so');
    expect(status.pluginHostMatch).toBe(true);
    expect(status.cliPath).toBe('/opt/kode/kode-kbengine');
    expect(status.cliVersion).toBe('0.2.0');
  });

  it('keeps nulls honest when the GUI and plugin are absent', async () => {
    const table = happyTable();
    delete table['wireshark -v'];
    table['tshark -G plugins'] = pluginsOut(null);
    const status = await collectProtocolToolingStatus(
      makeDeps(table, { cliPath: '/opt/kode/kode-kbengine' })
    );
    expect(status.wiresharkVersion).toBeNull();
    expect(status.plugin).toBeNull();
    expect(status.pluginHostMatch).toBeNull();
  });

  it('flags a plugin/host version-line mismatch', async () => {
    const table = happyTable();
    table['tshark -G plugins'] = pluginsOut(KBENGINE_MISMATCH);
    const status = await collectProtocolToolingStatus(
      makeDeps(table, { cliPath: '/opt/kode/kode-kbengine' })
    );
    expect(status.plugin).not.toBeNull();
    expect(status.pluginHostMatch).toBe(false);
  });

  it('reports an undiscovered CLI as empty path without spawning', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-pa007-'));
    try {
      const status = await collectProtocolToolingStatus(
        makeDeps(happyTable(), { extensionRoot: root })
      );
      expect(status.cliPath).toBe('');
      expect(status.cliVersion).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps cliVersion null when the configured CLI fails to run', async () => {
    const status = await collectProtocolToolingStatus(
      makeDeps(happyTable(), { cliPath: '/nowhere/kode-kbengine' })
    );
    expect(status.cliPath).toBe('/nowhere/kode-kbengine');
    expect(status.cliVersion).toBeNull();
  });
});

// ----------------------------------------------------------------- render

describe('PA-007:renderProtocolToolingStatus', () => {
  const happyStatus = async (): Promise<ProtocolToolingStatus> =>
    collectProtocolToolingStatus(
      makeDeps(happyTable(), { cliPath: '/opt/kode/kode-kbengine' })
    );

  it('renders every detected row', async () => {
    const text = renderProtocolToolingStatus(await happyStatus());
    expect(text).toContain('KBEngine 协议工具链检测');
    expect(text).toContain('tshark: 4.6.4');
    expect(text).toContain('Wireshark GUI: 4.6.4');
    expect(text).toContain('KBEngine Wireshark 插件: libwireshark_kbengine.so 0.1.0');
    expect(text).toContain('匹配(插件落盘目录版本线 = 宿主版本线)');
    expect(text).toContain('kode-kbengine CLI: 0.2.0');
    expect(text).toContain('capture analyze');
  });

  it('renders honest absence faces without the plugin', async () => {
    const table = happyTable();
    delete table['wireshark -v'];
    table['tshark -G plugins'] = pluginsOut(null);
    const status = await collectProtocolToolingStatus(
      makeDeps(table, { cliPath: '/opt/kode/kode-kbengine' })
    );
    const text = renderProtocolToolingStatus(status);
    expect(text).toContain('Wireshark GUI: 未检出');
    expect(text).toContain('KBEngine Wireshark 插件: 未安装');
    expect(text).not.toContain('宿主版本线核对');
  });

  it('renders the mismatch face for a foreign version line', async () => {
    const table = happyTable();
    table['tshark -G plugins'] = pluginsOut(KBENGINE_MISMATCH);
    const status = await collectProtocolToolingStatus(
      makeDeps(table, { cliPath: '/opt/kode/kode-kbengine' })
    );
    expect(renderProtocolToolingStatus(status)).toContain('不匹配(插件与宿主 Wireshark 版本线不同,宿主不会加载)');
  });

  it('renders the CLI-undiscovered face', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-pa007-'));
    try {
      const status = await collectProtocolToolingStatus(
        makeDeps(happyTable(), { extensionRoot: root })
      );
      const text = renderProtocolToolingStatus(status);
      expect(text).toContain('kode-kbengine CLI: 未发现');
      expect(text).toContain('kbengine.protocol.cliPath');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------------------------ wiring

const makeContext = (): ExtensionContext => ({
  subscriptions: [],
  extensionUri: Uri.file('/workspace/ext')
});

describe('PA-007:setupProtocolTooling 装配', () => {
  beforeEach(() => {
    commandRegistry.reset();
    windowState.reset();
    configurationOverrides.clear();
    workspaceEvents.configurationChanged.dispose();
  });

  it('registers the command; firing it collects and renders into the channel', async () => {
    // 注入必然 ENOENT 的 tshark/wireshark:装配测试只锁命令/通道/渲染完成
    // 面,内容由 collect/render 单测锁(环境无关,CI 无 tshark 同样绿)。
    const current = (configurationOverrides.get('kbengine') as Record<string, unknown>) ?? {};
    configurationOverrides.set('kbengine', {
      ...current,
      'protocol.tsharkPath': '/nowhere/tshark',
      'protocol.wiresharkPath': '/nowhere/wireshark'
    });
    const context = makeContext();
    setupProtocolTooling(context);

    expect(commandRegistry.registeredCommandIds()).toContain(
      SHOW_PROTOCOL_STATUS_COMMAND
    );

    await commands.executeCommand(SHOW_PROTOCOL_STATUS_COMMAND);

    const channel = windowState.channels.find((c) => c.name === PROTOCOL_CHANNEL_NAME);
    expect(channel).toBeDefined();
    expect(channel?.disposed).toBe(false);
    expect(channel?.lines.join('\n')).toContain('KBEngine 协议工具链检测');
    expect(channel?.lines.join('\n')).toContain('tshark: 未检出');

    for (const disposable of context.subscriptions) {
      disposable.dispose();
    }
    expect(
      windowState.channels.find((c) => c.name === PROTOCOL_CHANNEL_NAME)?.disposed
    ).toBe(true);
  });
});

describe('PA-007:defaultRunBinary 收敛口径', () => {
  it('maps a missing binary to code -1 with empty output', async () => {
    const outcome = await defaultRunBinary('/nowhere/no-such-binary', ['-v']);
    expect(outcome.code).toBe(-1);
    expect(outcome.stdout).toBe('');
  });

  it('passes through a real binary exit code and stdout', async () => {
    const outcome = await defaultRunBinary('/bin/echo', ['hello-pa007']);
    expect(outcome.code).toBe(0);
    expect(outcome.stdout.trim()).toBe('hello-pa007');
  });
});
