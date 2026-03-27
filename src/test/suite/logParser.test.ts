import * as assert from 'assert';
import { LogLevel, LogParser, LogType } from '../../logParser';

describe('LogParser', () => {
  it('parses KBEngine logger lines', () => {
    const entry = LogParser.parseLoggerMessage(
      'INFO dbmgr01 1000 12345 67890 [2026-03-26 18:21:11 001] - boot complete'
    );

    assert.ok(entry);
    assert.strictEqual(entry?.component, 'dbmgr');
    assert.strictEqual(entry?.level, LogLevel.INFO);
    assert.strictEqual(entry?.type, LogType.LOG_TYPE_NORMAL);
    assert.strictEqual(entry?.message, 'boot complete');
  });

  it('parses script log lines as script type', () => {
    const entry = LogParser.parseLoggerMessage(
      'S_ERR baseapp01 1000 12345 67890 [2026-03-26 18:21:11 120] - script failed'
    );

    assert.ok(entry);
    assert.strictEqual(entry?.component, 'baseapp');
    assert.strictEqual(entry?.level, LogLevel.ERROR);
    assert.strictEqual(entry?.type, LogType.LOG_TYPE_SCRIPT);
  });
});
