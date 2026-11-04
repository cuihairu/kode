import { describe, expect, it, vi } from 'vitest';
import {
  GIT_HISTORY_CONTEXT_KEY,
  GIT_HISTORY_ENABLED_SETTING,
  GIT_HISTORY_SHOW_COMMAND,
  GIT_HISTORY_SHOW_RANGE_COMMAND,
  readGitHistoryEnabled,
  runGitHistoryWhenEnabled,
} from '../src/gitHistory';

/** 构造一个可记录调用的配置读取替身。 */
function makeReader(settings: Record<string, unknown>) {
  return {
    get: vi.fn(<T>(key: string, defaultValue: T): T => {
      const v = settings[key];
      return (v === undefined ? defaultValue : v) as T;
    }),
  };
}

describe('IDE-GIT-001 历史功能开关', () => {
  it('默认开启:未配置时返回 true', () => {
    const reader = makeReader({});
    expect(readGitHistoryEnabled(reader)).toBe(true);
    expect(reader.get).toHaveBeenCalledWith(GIT_HISTORY_ENABLED_SETTING, true);
  });

  it('显式关闭:false 被照读', () => {
    const reader = makeReader({ [GIT_HISTORY_ENABLED_SETTING]: false });
    expect(readGitHistoryEnabled(reader)).toBe(false);
  });

  it('显式开启:true 被照读', () => {
    const reader = makeReader({ [GIT_HISTORY_ENABLED_SETTING]: true });
    expect(readGitHistoryEnabled(reader)).toBe(true);
  });

  it('非布尔值不误判为开启(缺省走默认分支)', () => {
    const reader = makeReader({ [GIT_HISTORY_ENABLED_SETTING]: 'yes' });
    expect(readGitHistoryEnabled(reader)).toBe(false);
  });
});

describe('IDE-GIT-001 命令门', () => {
  it('开启时执行 body', () => {
    const body = vi.fn();
    runGitHistoryWhenEnabled(true, body);
    expect(body).toHaveBeenCalledTimes(1);
  });

  it('关闭时直接调用命令也不执行 body(不运行 Git)', () => {
    const body = vi.fn();
    runGitHistoryWhenEnabled(false, body);
    expect(body).not.toHaveBeenCalled();
  });
});

describe('IDE-GIT-001 命令与上下文标识', () => {
  it('命令 ID 与上下文键稳定', () => {
    expect(GIT_HISTORY_SHOW_COMMAND).toBe('kbengine.git.showHistory');
    expect(GIT_HISTORY_SHOW_RANGE_COMMAND).toBe('kbengine.git.showRangeHistory');
    expect(GIT_HISTORY_CONTEXT_KEY).toBe('kode.gitHistoryEnabled');
  });
});
