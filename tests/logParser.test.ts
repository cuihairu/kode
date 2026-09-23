import { describe, expect, it } from 'vitest';
import { LogParser, LogLevel, LogType } from '../src/logParser';

describe('LogParser.parseLoggerMessage', () => {
  it('parses the KBEngine logger wire format', () => {
    const entry = LogParser.parseLoggerMessage(
      'INFO cellapp01 100 2000 30000 [2026-03-26 18:21:11 001] - Entity created'
    );

    expect(entry).not.toBeNull();
    expect(entry!.component).toBe('cellapp');
    expect(entry!.level).toBe(LogLevel.INFO);
    expect(entry!.type).toBe(LogType.LOG_TYPE_NORMAL);
    expect(entry!.message).toBe('Entity created');
    expect(entry!.timestamp.getFullYear()).toBe(2026);
    expect(entry!.timestamp.getMonth()).toBe(2); // March
    expect(entry!.timestamp.getMilliseconds()).toBe(1);
  });

  it('classifies script (S_ prefixed) levels as script log type', () => {
    const entry = LogParser.parseLoggerMessage(
      'S_ERR cellapp01 100 2000 30000 [2026-03-26 18:21:11 001] - script boom'
    );

    expect(entry!.level).toBe(LogLevel.ERROR);
    expect(entry!.type).toBe(LogType.LOG_TYPE_SCRIPT);
  });

  it('parses the bracketed standard format with and without a component', () => {
    const withComponent = LogParser.parseLoggerMessage(
      '[2026-03-26 18:21:11] [ERROR] [baseapp] boom'
    );
    expect(withComponent!.level).toBe(LogLevel.ERROR);
    expect(withComponent!.component).toBe('baseapp');
    expect(withComponent!.message).toBe('boom');

    const withoutComponent = LogParser.parseLoggerMessage(
      '[2026-03-26 18:21:11] [WARNING] careful'
    );
    expect(withoutComponent!.level).toBe(LogLevel.WARNING);
    expect(withoutComponent!.component).toBe('unknown');
  });

  it('falls back to heuristics for non-standard lines', () => {
    const entry = LogParser.parseLoggerMessage('cellapp: loadBalance failed');

    expect(entry).not.toBeNull();
    expect(entry!.component).toBe('cellapp');
    expect(entry!.level).toBe(LogLevel.ERROR);
    expect(entry!.message).toBe('cellapp: loadBalance failed');
  });

  it('never returns null for plain text', () => {
    expect(LogParser.parseLoggerMessage('hello world')).not.toBeNull();
  });
});

describe('LogParser.parseBinaryLogItem', () => {
  it('round-trips a binary LOG_ITEM buffer', () => {
    const message = Buffer.from('hello', 'utf8');
    const buffer = Buffer.alloc(4 + 1 + 1 + 1 + 8 + 4 + message.length);

    let offset = 0;
    buffer.writeUInt32LE(7, offset); offset += 4;          // id
    buffer.writeUInt8(LogType.LOG_TYPE_SCRIPT, offset); offset += 1;
    buffer.writeUInt8(6, offset); offset += 1;             // baseapp
    buffer.writeUInt8(LogLevel.WARNING, offset); offset += 1;
    buffer.writeDoubleLE(1711000000.5, offset); offset += 8;
    buffer.writeUInt32LE(message.length, offset); offset += 4;
    message.copy(buffer, offset);

    const entry = LogParser.parseBinaryLogItem(buffer);

    expect(entry).not.toBeNull();
    expect(entry!.component).toBe('baseapp');
    expect(entry!.level).toBe(LogLevel.WARNING);
    expect(entry!.type).toBe(LogType.LOG_TYPE_SCRIPT);
    expect(entry!.message).toBe('hello');
    expect(entry!.timestamp.getTime()).toBe(1711000000500);
  });

  it('maps unknown component ids to a fallback name', () => {
    const buffer = Buffer.alloc(19);
    buffer.writeUInt32LE(1, 0);
    buffer.writeUInt8(LogType.LOG_TYPE_NORMAL, 4);
    buffer.writeUInt8(99, 5);
    buffer.writeUInt8(LogLevel.INFO, 6);
    buffer.writeDoubleLE(1000, 7);
    buffer.writeUInt32LE(0, 15);

    const entry = LogParser.parseBinaryLogItem(buffer);

    expect(entry!.component).toBe('component_99');
  });
});

describe('LogParser batch and formatting', () => {
  it('splits batches on newlines and skips blanks', () => {
    const entries = LogParser.parseBatch(
      [
        'INFO cellapp01 100 2000 30000 [2026-03-26 18:21:11 001] - first',
        '',
        '[2026-03-26 18:21:12] [ERROR] [baseapp] second',
        '   '
      ].join('\n')
    );

    expect(entries).toHaveLength(2);
    expect(entries[0].message).toBe('first');
    expect(entries[1].message).toBe('second');
  });

  it('formats entries with padded level and component', () => {
    const formatted = LogParser.formatLogEntry({
      id: 1,
      timestamp: new Date(Date.UTC(2026, 2, 26, 10, 0, 0)),
      component: 'dbmgr',
      level: LogLevel.ERROR,
      type: LogType.LOG_TYPE_NORMAL,
      message: 'db down',
      raw: 'raw'
    });

    expect(formatted).toContain('ERROR');
    expect(formatted).toContain('dbmgr');
    expect(formatted).toContain('db down');
  });

  it('exposes level metadata', () => {
    expect(LogParser.getLevelName(LogLevel.CRITICAL)).toBe('CRITICAL');
    expect(LogParser.getLevelIcon(LogLevel.ERROR).length).toBeGreaterThan(0);
    expect(LogParser.getLevelColor(LogLevel.WARNING)).toMatch(/^#/);
  });
});
