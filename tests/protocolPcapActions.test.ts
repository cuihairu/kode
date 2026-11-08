//! PA-007 第三增量:一键开 PCAP(Wireshark GUI)与跑 TShark(CLI capture
//! analyze)的命令编排面。对话框注入(取消/选中两态)、run 假体(参数契约/
//! 失败归因)、通知面与通道面全部锁定;不真起进程。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Uri, type ExtensionContext } from './fake-vscode/core';
import { commandRegistry, commands } from './fake-vscode/commandRegistry';
import { messages, windowState } from './fake-vscode/windowState';
import {
  ANALYZE_PCAP_COMMAND,
  OPEN_PCAP_COMMAND,
  runAnalyzePcap,
  runOpenPcap,
  setupProtocolPcapActions,
  type PickPcap
} from '../src/protocolPcapActions';
import { PROTOCOL_CHANNEL_NAME, type ProtocolToolingDeps, type RunBinary } from '../src/protocolTooling';

// ---------------------------------------------------------------- fixtures

const CLI = '/opt/kode/kode-kbengine';

const makeDeps = (overrides: Partial<ProtocolToolingDeps> = {}): ProtocolToolingDeps => ({
  run: async () => ({ code: 0, stdout: '', stderr: '' }),
  tsharkPath: 'tshark',
  wiresharkPath: 'wireshark',
  cliPath: CLI,
  extensionRoot: '/workspace/ext',
  ...overrides
});

const makeContext = (): ExtensionContext => ({
  subscriptions: [],
  extensionUri: Uri.file('/workspace/ext'),
  globalStorageUri: Uri.file('/tmp/gs')
});

/** 单选注入:fsPath 或 undefined(取消)。 */
const pick = (fsPath?: string): PickPcap =>
  fsPath === undefined ? async () => undefined : async () => [{ fsPath }];

const logCapture = (): { lines: string[]; log: (line: string) => void } => {
  const lines: string[] = [];
  return { lines, log: (line: string): void => void lines.push(line) };
};

const recordRun = (outcomes: Array<{ code: number; stdout?: string; stderr?: string }>): {
  run: RunBinary;
  calls: Array<{ file: string; args: string[] }>
} => {
  const calls: Array<{ file: string; args: string[] }> = [];
  const run: RunBinary = async (file, args) => {
    calls.push({ file, args });
    const next = outcomes[calls.length - 1];
    return next === undefined
      ? { code: 0, stdout: '', stderr: '' }
      : { code: next.code, stdout: next.stdout ?? '', stderr: next.stderr ?? '' };
  };
  return { run, calls };
};

beforeEach(() => {
  commandRegistry.reset();
  windowState.reset();
});

// open 面失败警告走 fire-and-forget promise;每个用例尾部排干微任务。
afterEach(async () => {
  await Promise.resolve();
});

// ------------------------------------------------------------- openPcap

describe('PA-007-3:runOpenPcap(一键开 PCAP)', () => {
  it('dialog cancel does nothing (no process, no notification)', async () => {
    const { run, calls } = recordRun([]);
    const { log, lines } = logCapture();
    await runOpenPcap(makeDeps(), pick(undefined), run, log);
    expect(calls).toEqual([]);
    expect(lines).toEqual([]);
    expect(messages.warning).toEqual([]);
  });

  it('launches the configured Wireshark GUI with the picked file', async () => {
    const { run, calls } = recordRun([{ code: 0 }]);
    const deps = makeDeps({ wiresharkPath: '/usr/bin/wireshark' });
    const { log, lines } = logCapture();
    await runOpenPcap(deps, pick('/tmp/flow.pcap'), run, log);
    expect(calls).toEqual([{ file: '/usr/bin/wireshark', args: ['/tmp/flow.pcap'] }]);
    expect(lines[0]).toContain('launching /usr/bin/wireshark /tmp/flow.pcap');
    // GUI 可见即成功反馈:不刷通知
    expect(messages.warning).toEqual([]);
    expect(messages.error).toEqual([]);
  });

  it('warns honestly when Wireshark is undiscovered (ENOENT)', async () => {
    const { run } = recordRun([{ code: -1 }]);
    const { log, lines } = logCapture();
    await runOpenPcap(makeDeps(), pick('/tmp/flow.pcap'), run, log);
    expect(messages.warning.some((text) => text.includes('Wireshark 未检出'))).toBe(true);
    expect(messages.warning.some((text) => text.includes('kbengine.protocol.wiresharkPath'))).toBe(true);
    expect(lines.some((line) => line.includes('open failed'))).toBe(true);
  });

  it('warns with stderr attribution on non-zero GUI exit', async () => {
    const { run } = recordRun([{ code: 3, stderr: 'gtk init failed\n' }]);
    const { log } = logCapture();
    await runOpenPcap(makeDeps(), pick('/tmp/flow.pcap'), run, log);
    expect(messages.warning.some((text) => text.includes('code 3'))).toBe(true);
    expect(messages.warning.some((text) => text.includes('gtk init failed'))).toBe(true);
    expect(log).toBeDefined();
  });
});

// ----------------------------------------------------------- analyzePcap

describe('PA-007-3:runAnalyzePcap(跑 TShark)', () => {
  it('dialog cancel does nothing', async () => {
    const { run, calls } = recordRun([]);
    const { log, lines } = logCapture();
    await runAnalyzePcap(makeDeps(), pick(undefined), run, log);
    expect(calls).toEqual([]);
    expect(lines).toEqual([]);
  });

  it('warns honestly when the CLI is undiscovered', async () => {
    const bare = makeDeps({ cliPath: '', extensionRoot: '/bare/ext' });
    const { run } = recordRun([]);
    const { log, lines } = logCapture();
    await runAnalyzePcap(bare, pick('/tmp/flow.pcap'), run, log);
    expect(messages.warning.some((text) => text.includes('CLI 未检出'))).toBe(true);
    expect(lines.some((line) => line.includes('analyze unavailable'))).toBe(true);
  });

  it('passes the CLI contract args and reports success without noise', async () => {
    const { run, calls } = recordRun([{ code: 0, stdout: 'records: 4\nanomalies: 2\n' }]);
    const { log, lines } = logCapture();
    await runAnalyzePcap(makeDeps(), pick('/tmp/flow.pcap'), run, log);
    expect(calls).toEqual([
      {
        file: CLI,
        args: ['capture', 'analyze', '--pcap', '/tmp/flow.pcap', '--tshark', 'tshark']
      }
    ]);
    // 报告原文逐字落通道,不摘要不美化
    expect(lines.join('\n')).toContain('records: 4');
    expect(lines.join('\n')).toContain('anomalies: 2');
    expect(messages.error).toEqual([]);
    expect(messages.warning).toEqual([]);
  });

  it('attributes failures to stderr and notifies with the CLI error text', async () => {
    const { run } = recordRun([{ code: 1, stderr: 'no kbengine traffic\n' }]);
    const { log, lines } = logCapture();
    await runAnalyzePcap(makeDeps(), pick('/tmp/flow.pcap'), run, log);
    expect(messages.error.some((text) => text.includes('code 1'))).toBe(true);
    expect(messages.error.some((text) => text.includes('no kbengine traffic'))).toBe(true);
    expect(lines.some((line) => line.includes('analyze failed'))).toBe(true);
  });

  it('wiring registers both commands; analyze surfaces the honest CLI reason', async () => {
    const context = makeContext();
    setupProtocolPcapActions(context, { pickFiles: pick('/tmp/flow.pcap') });
    try {
      expect(commandRegistry.registeredCommandIds()).toContain(OPEN_PCAP_COMMAND);
      expect(commandRegistry.registeredCommandIds()).toContain(ANALYZE_PCAP_COMMAND);
      // 真实 deps(cliPath 默认空 + 假 extensionRoot 无候选)→ CLI 未检出警告,
      // 不真起进程
      await commands.executeCommand(ANALYZE_PCAP_COMMAND);
      expect(messages.warning.some((text) => text.includes('CLI 未检出'))).toBe(true);
      const channel = windowState.channels.find((item) => item.name === PROTOCOL_CHANNEL_NAME);
      expect(channel?.lines.join('\n')).toContain('analyze unavailable');
    } finally {
      for (const disposable of context.subscriptions) {
        disposable.dispose();
      }
    }
  });
});
