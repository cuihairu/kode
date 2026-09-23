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

describe('LogParser level mapping and degraded inputs', () => {
  const standardLine = (level: string) =>
    LogParser.parseLoggerMessage(`[2026-03-26 18:21:11][${level}] msg`)!;

  it('maps every engine level token', () => {
    expect(standardLine('DEBUG').level).toBe(LogLevel.DEBUG);
    expect(standardLine('S_DBG').level).toBe(LogLevel.DEBUG);
    expect(standardLine('INFO').level).toBe(LogLevel.INFO);
    expect(standardLine('PRINT').level).toBe(LogLevel.INFO);
    expect(standardLine('S_INFO').level).toBe(LogLevel.INFO);
    expect(standardLine('S_NORM').level).toBe(LogLevel.INFO);
    expect(standardLine('WARNING').level).toBe(LogLevel.WARNING);
    expect(standardLine('WARN').level).toBe(LogLevel.WARNING);
    expect(standardLine('S_WARN').level).toBe(LogLevel.WARNING);
    expect(standardLine('ERROR').level).toBe(LogLevel.ERROR);
    expect(standardLine('S_ERR').level).toBe(LogLevel.ERROR);
    expect(standardLine('CRITICAL').level).toBe(LogLevel.CRITICAL);
    expect(standardLine('FATAL').level).toBe(LogLevel.CRITICAL);
    // 未知 token 回落 INFO(parseLogLevel 的 default 分支)
    expect(standardLine('WHATEVER').level).toBe(LogLevel.INFO);
  });

  it('ranks non-standard lines by keyword heuristics and extracts the component', () => {
    const heuristic = (text: string) => LogParser.parseLoggerMessage(text)!;

    expect(heuristic('download failed on cellapp3').level).toBe(LogLevel.ERROR);
    expect(heuristic('cellapp3 disk usage warning').level).toBe(LogLevel.WARNING);
    expect(heuristic('machine: fatal shutdown imminent').level).toBe(LogLevel.CRITICAL);
    expect(heuristic('logger debug trace of space 42').level).toBe(LogLevel.DEBUG);
    expect(heuristic('dbmgr01 processed a mailbox').level).toBe(LogLevel.INFO);

    // 组件提取与级别启发式独立工作
    expect(heuristic('download failed on cellapp3').component).toBe('cellapp');
    expect(heuristic('machine: fatal shutdown imminent').component).toBe('machine');
    expect(heuristic('no component token here').component).toBe('unknown');
  });

  it('returns null for malformed inputs instead of throwing', () => {
    // 类型外的运行时垃圾走 catch 分支,不抛出
    expect(LogParser.parseLoggerMessage(undefined as unknown as string)).toBeNull();
    // 截断的二进制 LOG_ITEM 越界读取同样降级为 null
    expect(LogParser.parseBinaryLogItem(Buffer.alloc(2))).toBeNull();
  });

  it('labels every level with name, icon and color including fallbacks', () => {
    for (const level of [
      LogLevel.DEBUG,
      LogLevel.INFO,
      LogLevel.WARNING,
      LogLevel.ERROR,
      LogLevel.CRITICAL
    ] as const) {
      expect(LogParser.getLevelName(level).length).toBeGreaterThan(0);
      expect(LogParser.getLevelIcon(level).length).toBeGreaterThan(0);
      expect(LogParser.getLevelColor(level)).toMatch(/^#/);
    }

    // 越界值:icon/color 的 switch 带 default 分支;getLevelName 没有,
    // 越界返回 undefined——三函数不一致是实现现状,如实锁定
    expect(LogParser.getLevelIcon(99 as LogLevel)).toBe('📝');
    expect(LogParser.getLevelColor(99 as LogLevel)).toBe('#000000');
    expect(LogParser.getLevelName(99 as LogLevel)).toBeUndefined();
  });
});
