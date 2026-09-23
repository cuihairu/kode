import type * as vscode from 'vscode';
import { describe, expect, it } from 'vitest';
import { CollectorStatus, KBEngineLogCollector } from '../src/logCollector';
import { LogEntry, LogLevel, LogType } from '../src/logParser';

// KBEngineLogCollector 的状态机、环形缓冲与日志查询纯逻辑。
// connect() 按实现现状直接拒绝(logger watcher 协议未适配),不发起 socket;
// sendHeartbeat/sendDeregister 的 socket 路径不在纯逻辑测试域。

const makeCollector = (over: Partial<{ maxBufferSize: number }> = {}) =>
  new KBEngineLogCollector(
    {
      host: '127.0.0.1',
      port: 30000,
      autoReconnect: false,
      reconnectInterval: 1000,
      maxBufferSize: over.maxBufferSize ?? 100
    },
    {} as unknown as vscode.ExtensionContext
  );

const entry = (over: Partial<LogEntry> = {}): LogEntry => ({
  id: 1,
  timestamp: new Date(Date.UTC(2026, 8, 23, 12, 0, 0)),
  component: 'cellapp',
  level: LogLevel.INFO,
  type: LogType.LOG_TYPE_NORMAL,
  message: 'entity created',
  raw: 'raw line',
  ...over
});

describe('KBEngineLogCollector initial state', () => {
  it('starts disconnected with empty buffers and status texts', () => {
    const collector = makeCollector();

    expect(collector.getStatus()).toBe(CollectorStatus.Disconnected);
    expect(collector.getLogEntries()).toEqual([]);
    expect(collector.getLogCount()).toBe(0);
    expect(collector.searchLogs('anything')).toEqual([]);
    expect(collector.getUnavailableReason()).toContain('尚未连接');
    expect(collector.getUnavailableReason()).toContain(KBEngineLogCollector.PROTOCOL_WARNING);
    expect(collector.getStatusSummary()).toContain('未连接 127.0.0.1:30000');
  });

  it('disconnect and dispose stay safe when never connected', () => {
    const collector = makeCollector();

    expect(() => collector.disconnect()).not.toThrow();
    expect(collector.getStatus()).toBe(CollectorStatus.Disconnected);
    expect(() => collector.dispose()).not.toThrow();
    // dispose 幂等
    expect(() => collector.dispose()).not.toThrow();
  });
});

describe('KBEngineLogCollector.connect refuses by design', () => {
  it('rejects with the protocol warning and records the error status', async () => {
    const collector = makeCollector();

    await expect(collector.connect()).rejects.toThrow(/协议适配/);

    expect(collector.getStatus()).toBe(CollectorStatus.Error);
    expect(collector.getUnavailableReason()).toContain('30000');
    expect(collector.getUnavailableReason()).toContain(KBEngineLogCollector.PROTOCOL_WARNING);
    // Error 状态下 status summary 落到 unavailable reason
    expect(collector.getStatusSummary()).toBe(collector.getUnavailableReason());
  });

  it('fires status changes while refusing', async () => {
    const collector = makeCollector();
    const seen: CollectorStatus[] = [];
    collector.onDidChangeStatus(status => seen.push(status));

    await expect(collector.connect()).rejects.toThrow();

    expect(seen).toEqual([CollectorStatus.Error]);
  });
});

describe('KBEngineLogCollector buffer and queries', () => {
  const collector = makeCollector();
  const internals = collector as unknown as {
    pushLogEntry: (entry: LogEntry) => void;
  };

  internals.pushLogEntry(entry({ id: 1, component: 'cellapp', level: LogLevel.INFO, message: 'created Hero#1' }));
  internals.pushLogEntry(entry({ id: 2, component: 'baseapp', level: LogLevel.ERROR, message: 'save failed' }));
  internals.pushLogEntry(entry({ id: 3, component: 'cellapp', level: LogLevel.WARNING, message: 'disk usage warning' }));
  internals.pushLogEntry(entry({ id: 4, component: 'dbmgr', level: LogLevel.INFO, message: 'backup done' }));

  it('keeps insertion order and count', () => {
    expect(collector.getLogCount()).toBe(4);
    expect(collector.getLogEntries().map(e => e.id)).toEqual([1, 2, 3, 4]);
  });

  it('filters by level and component', () => {
    expect(collector.getLogsByLevel(LogLevel.INFO).map(e => e.id)).toEqual([1, 4]);
    expect(collector.getLogsByLevel(LogLevel.ERROR).map(e => e.id)).toEqual([2]);
    expect(collector.getLogsByComponent('cellapp').map(e => e.id)).toEqual([1, 3]);
    expect(collector.getLogsByComponent('baseapp')).toHaveLength(1);
  });

  it('searches case-insensitively and by regex, degrading invalid regex to empty', () => {
    expect(collector.searchLogs('FAILED').map(e => e.id)).toEqual([2]);
    expect(collector.searchLogs('warn')).toEqual([3].map(() => collector.getLogEntries()[2]));
    expect(collector.searchLogs('fail', true).map(e => e.id)).toEqual([2]);
    expect(collector.searchLogs('created|backup', true).map(e => e.id)).toEqual([1, 4]);
    // 非法正则:catch 分支返回空列表而非抛出
    expect(collector.searchLogs('[invalid', true)).toEqual([]);
  });

  it('clears the buffer', () => {
    expect(collector.getLogCount()).toBeGreaterThan(0);
    collector.clearLogs();
    expect(collector.getLogCount()).toBe(0);
    expect(collector.getLogEntries()).toEqual([]);
  });
});

describe('KBEngineLogCollector ring buffer trimming', () => {
  it('trims oldest entries beyond maxBufferSize', () => {
    const collector = makeCollector({ maxBufferSize: 3 });
    const internals = collector as unknown as {
      pushLogEntry: (entry: LogEntry) => void;
    };

    for (let index = 1; index <= 5; index += 1) {
      internals.pushLogEntry(entry({ id: index }));
    }

    expect(collector.getLogCount()).toBe(3);
    expect(collector.getLogEntries().map(e => e.id)).toEqual([3, 4, 5]);
  });

  it('fires onLogEntry for every accepted entry', () => {
    const collector = makeCollector();
    const received: number[] = [];
    collector.onLogEntry(e => received.push(e.id));

    const internals = collector as unknown as {
      pushLogEntry: (entry: LogEntry) => void;
    };
    internals.pushLogEntry(entry({ id: 7 }));
    internals.pushLogEntry(entry({ id: 8 }));

    expect(received).toEqual([7, 8]);
  });
});
