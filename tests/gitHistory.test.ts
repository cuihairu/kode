import { describe, expect, it, vi } from 'vitest';
import {
  GIT_HISTORY_CONTEXT_KEY,
  GIT_HISTORY_ENABLED_KEY,
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
    // 读取走段内相对键(getConfiguration('kbengine') 作用域口径)。
    expect(reader.get).toHaveBeenCalledWith(GIT_HISTORY_ENABLED_KEY, true);
  });

  it('显式关闭:false 被照读', () => {
    const reader = makeReader({ [GIT_HISTORY_ENABLED_KEY]: false });
    expect(readGitHistoryEnabled(reader)).toBe(false);
  });

  it('显式开启:true 被照读', () => {
    const reader = makeReader({ [GIT_HISTORY_ENABLED_KEY]: true });
    expect(readGitHistoryEnabled(reader)).toBe(true);
  });

  it('非布尔值不误判为开启(缺省走默认分支)', () => {
    const reader = makeReader({ [GIT_HISTORY_ENABLED_KEY]: 'yes' });
    expect(readGitHistoryEnabled(reader)).toBe(false);
  });

  it('完整键经 kbengine 段作用域不重复前缀(装配口径:禁用真生效)', () => {
    // 复现真实装配:getConfiguration('kbengine') 返回段作用域读取器,完整设置键
    // 'kbengine.gitHistory.enabled' 由段作用域按相对键 'gitHistory.enabled' 提供。
    // 旧码误读相对键 'kbengine.gitHistory.enabled'(段内再拼前缀)致恒默认 true,
    // 该回归用例锁定:段作用域读禁用值必须为 false。
    const scopedReader = makeReader({ [GIT_HISTORY_ENABLED_KEY]: false });
    expect(readGitHistoryEnabled(scopedReader)).toBe(false);
    expect(GIT_HISTORY_ENABLED_SETTING).toBe('kbengine.gitHistory.enabled');
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
