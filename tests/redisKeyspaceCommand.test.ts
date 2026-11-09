import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  REDIS_SCAN_PAGE_LIMIT,
  enumerateRedisKeys,
  renderRedisKeyTreeText,
  runRedisKeyspacePreviewCommand
} from '../src/redisKeyspaceCommand';
import type { RedisSession } from '../src/backend/redisDrift';

vi.mock('../src/configDerive', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/configDerive')>();
  return { ...actual, getDerivedDatabaseProfile: vi.fn() };
});
vi.mock('../src/serverConfigMerge', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/serverConfigMerge')>();
  return { ...actual, resolveDatabaseInterfaceConfig: vi.fn() };
});

// 依赖 mock 后的模块(import 顺序须在 vi.mock 之后)
import { getDerivedDatabaseProfile } from '../src/configDerive';
import { resolveDatabaseInterfaceConfig } from '../src/serverConfigMerge';

const mockedProfile = vi.mocked(getDerivedDatabaseProfile);
const mockedResolve = vi.mocked(resolveDatabaseInterfaceConfig);

/** 假 redis 会话(命令面只依赖 scanKeys/hashGetAll/close)。 */
class FakeSession {
  keysByScan: Array<{ cursor: string; keys: string[] }>;
  hash: Record<string, string>;
  closed = false;

  constructor(options: { keysByScan?: Array<{ cursor: string; keys: string[] }>; hash?: Record<string, string> } = {}) {
    this.keysByScan = options.keysByScan ?? [{ cursor: '0', keys: ['kbe_entitylog:1:2'] }];
    this.hash = options.hash ?? { entityID: '7', ip: '127.0.0.1' };
  }

  async scanKeys(_cursor: string, _pattern: string): Promise<{ cursor: string; keys: string[] }> {
    return this.keysByScan.shift() ?? { cursor: '0', keys: [] };
  }

  async hashGetAll(_key: string): Promise<Record<string, string>> {
    return this.hash;
  }

  close(): void {
    this.closed = true;
  }
}

const asSession = (session: FakeSession): RedisSession => session as unknown as RedisSession;

const redisProfile = () => ({
  host: 'localhost',
  port: 6379,
  username: 'kbe',
  databaseName: '0',
  characterSet: 'utf8',
  encrypt: false,
  passwordAvailable: true,
  dbType: 'redis'
});

beforeEach(() => {
  vi.resetAllMocks();
  mockedProfile.mockReturnValue(redisProfile() as never);
  mockedResolve.mockReturnValue({ plainPassword: 'pw' } as never);
});

describe('enumerateRedisKeys', () => {
  it('SCAN 循环至游标 0,汇总全部键', async () => {
    const session = asSession(new FakeSession({
      keysByScan: [
        { cursor: '3', keys: ['a'] },
        { cursor: '0', keys: ['b'] }
      ]
    }));
    const result = await enumerateRedisKeys(session, 'kbe_*');
    expect(result).toEqual({ keys: ['a', 'b'], truncated: false });
  });

  it('达到页上限且未结束如实截断', async () => {
    const session = asSession(new FakeSession({
      keysByScan: Array.from({ length: REDIS_SCAN_PAGE_LIMIT }, () => ({ cursor: '9', keys: ['x'] }))
    }));
    const result = await enumerateRedisKeys(session, 'kbe_*');
    expect(result.truncated).toBe(true);
    expect(result.keys.length).toBe(REDIS_SCAN_PAGE_LIMIT);
  });
});

describe('renderRedisKeyTreeText', () => {
  it('空键空间如实说明(不模拟 mysql 结构)', () => {
    const text = renderRedisKeyTreeText([], false);
    expect(text).toContain('键空间为空');
    expect(text).toContain('不模拟 mysql 表结构');
  });

  it('有键按分类输出并标截断', () => {
    const text = renderRedisKeyTreeText(['kbe_entitylog:1:2', 'kbe_account:3'], true);
    expect(text).toContain('实体日志(kbe_entitylog)');
    expect(text).toContain('引擎表键(kbe_*)');
    expect(text).toContain('已截断');
  });
});

describe('runRedisKeyspacePreviewCommand', () => {
  it('redis 流:枚举键 → 选键 → HGETALL 预览 → 输出通道,关闭会话', async () => {
    const session = new FakeSession({ keysByScan: [{ cursor: '0', keys: ['kbe_entitylog:1:2'] }] });
    const lines: string[] = [];
    const result = await runRedisKeyspacePreviewCommand({
      openSession: async () => asSession(session),
      showQuickPick: async () => 'kbe_entitylog:1:2',
      createOutputChannel: () => ({ appendLine: line => lines.push(line), show: () => {} })
    });
    expect(result).toContain('预览完成');
    expect(result).toContain('kbe_entitylog:1:2');
    expect(lines.join('\n')).toContain('===== 键预览 kbe_entitylog:1:2');
    expect(session.closed).toBe(true);
  });

  it('空键空间返回空态文案(graceful,不抛)', async () => {
    const session = new FakeSession({ keysByScan: [{ cursor: '0', keys: [] }] });
    const result = await runRedisKeyspacePreviewCommand({
      openSession: async () => asSession(session)
    });
    expect(result).toContain('键空间为空');
  });

  it('非 redis 后端如实降级', async () => {
    mockedProfile.mockReturnValue({ ...redisProfile(), dbType: 'mysql' } as never);
    const result = await runRedisKeyspacePreviewCommand({
      openSession: async () => asSession(new FakeSession())
    });
    expect(result).toContain('当前后端不是 redis');
  });

  it('连接失败(openSession 抛)如实降级', async () => {
    const result = await runRedisKeyspacePreviewCommand({
      openSession: async () => {
        throw new Error('connection refused');
      }
    });
    expect(result).toContain('失败');
    expect(result).toContain('connection refused');
  });

  it('取消选择如实说明', async () => {
    const session = new FakeSession();
    const result = await runRedisKeyspacePreviewCommand({
      openSession: async () => asSession(session),
      showQuickPick: async () => undefined
    });
    expect(result).toContain('已取消');
  });
});
