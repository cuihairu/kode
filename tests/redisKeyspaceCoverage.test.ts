// redisKeyspaceCommand.ts 覆盖收口(测试扇出 2026-11-08):缺省输出通道、
// 缺省 quickPick、密码不可读降级、截断态未完整枚举如实报文、连接配置派生
// (databaseName 非数字 → dbIndex 0)。命令面注入 openSession,不发真实网络包。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  REDIS_KEYSPACE_CHANNEL_NAME,
  REDIS_SCAN_PAGE_LIMIT,
  buildRedisConnectionConfig,
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
import { windowState } from './fake-vscode/windowState';

const mockedProfile = vi.mocked(getDerivedDatabaseProfile);
const mockedResolve = vi.mocked(resolveDatabaseInterfaceConfig);

/** 假 redis 会话(命令面只依赖 scanKeys/hashGetAll/close)。 */
class FakeSession {
  scanReply: { cursor: string; keys: string[] };
  hash: Record<string, string>;
  capturedPattern: string | null = null;
  closed = false;

  constructor(options: { scanReply?: { cursor: string; keys: string[] }; hash?: Record<string, string> } = {}) {
    this.scanReply = options.scanReply ?? { cursor: '0', keys: ['kbe_entitylog:1:2'] };
    this.hash = options.hash ?? { entityID: '7', ip: '127.0.0.1' };
  }

  async scanKeys(_cursor: string, pattern: string): Promise<{ cursor: string; keys: string[] }> {
    this.capturedPattern = pattern;
    return this.scanReply;
  }

  async hashGetAll(_key: string): Promise<Record<string, string>> {
    return this.hash;
  }

  close(): void {
    this.closed = true;
  }
}

const asSession = (session: FakeSession): RedisSession => session as unknown as RedisSession;

const redisProfile = (databaseName = '0') => ({
  host: 'localhost',
  port: 6379,
  username: 'kbe',
  databaseName,
  characterSet: 'utf8',
  encrypt: false,
  passwordAvailable: true,
  dbType: 'redis'
});

beforeEach(() => {
  vi.resetAllMocks();
  windowState.reset();
  mockedProfile.mockReturnValue(redisProfile() as never);
  mockedResolve.mockReturnValue({ plainPassword: 'pw' } as never);
});

describe('buildRedisConnectionConfig 派生(覆盖收口)', () => {
  it('databaseName 非数字 → dbIndex 0;数字 → 原值;空串 → 0', () => {
    mockedProfile.mockReturnValue(redisProfile('abc') as never);
    expect(buildRedisConnectionConfig()?.config.dbIndex).toBe(0);

    mockedProfile.mockReturnValue(redisProfile('2') as never);
    expect(buildRedisConnectionConfig()?.config.dbIndex).toBe(2);

    mockedProfile.mockReturnValue(redisProfile('') as never);
    expect(buildRedisConnectionConfig()?.config.dbIndex).toBe(0);
  });

  it('host/port/password 透传;passwordUnavailable 随明文有无', () => {
    const built = buildRedisConnectionConfig();
    expect(built).toMatchObject({
      config: { host: 'localhost', port: 6379, password: 'pw', dbIndex: 0 },
      passwordUnavailable: false
    });
    mockedResolve.mockReturnValue({} as never);
    expect(buildRedisConnectionConfig()?.passwordUnavailable).toBe(true);
  });

  it('非 redis 后端 → null(未预览前提)', () => {
    mockedProfile.mockReturnValue({ ...redisProfile(), dbType: 'mysql' } as never);
    expect(buildRedisConnectionConfig()).toBeNull();
  });
});

describe('runRedisKeyspacePreviewCommand 缺省面(覆盖收口)', () => {
  it('未注入 createOutputChannel → 缺省走 vscode 输出通道(记录在案)', async () => {
    const session = new FakeSession();
    const result = await runRedisKeyspacePreviewCommand({
      openSession: async () => asSession(session),
      showQuickPick: async () => 'kbe_entitylog:1:2'
    });
    expect(result).toContain('预览完成');
    const channel = windowState.channels[windowState.channels.length - 1];
    expect(channel).toBeDefined();
    expect(channel.name).toBe(REDIS_KEYSPACE_CHANNEL_NAME);
    expect(channel.lines.join('\n')).toContain('===== 键预览 kbe_entitylog:1:2');
    expect(channel.lines.join('\n')).toContain('entityID');
    expect(session.closed).toBe(true);
  });

  it('未注入 showQuickPick → 缺省 vscode quickPick(替身取消)→ 已取消', async () => {
    const session = new FakeSession();
    const result = await runRedisKeyspacePreviewCommand({
      openSession: async () => asSession(session)
    });
    expect(result).toContain('已取消');
    expect(session.closed).toBe(true);
  });

  it('明文密码不可读 → 未预览如实降级(不打开会话)', async () => {
    mockedResolve.mockReturnValue({} as never);
    let opened = 0;
    const result = await runRedisKeyspacePreviewCommand({
      openSession: async () => {
        opened += 1;
        return asSession(new FakeSession());
      }
    });
    expect(result).toContain('密码不可读');
    expect(result).toContain('未预览');
    expect(opened).toBe(0);
  });

  it('截断态选键 → 未完整枚举,如实拒绝预览(不误导)', async () => {
    const session = new FakeSession({
      scanReply: { cursor: '9', keys: ['kbe_x:1'] }
    });
    const result = await runRedisKeyspacePreviewCommand({
      openSession: async () => asSession(session),
      showQuickPick: async () => 'kbe_x:1'
    });
    expect(result).toContain(`${REDIS_SCAN_PAGE_LIMIT} 页上限`);
    expect(result).toContain('未完整枚举');
    // 未到预览面:无输出通道建立
    expect(session.closed).toBe(true);
  });
});
