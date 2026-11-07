/**
 * Redis 键空间只读预览命令(KODE-REDIS-UI-001 ②④):枚举 `kbe_*` 键 →
 * 选一个键 → HGETALL 哈希预览 → 输出通道展示,零编辑。
 *
 * 口径:仅当派生档案 dbType='redis' 时走本面;连接要素与引擎 dbInterface
 * 同源(密码仅经 resolveDatabaseInterfaceConfig 就地读取,绝不回显)。
 * 无 redis / 连接失败 / 键空间为空 → 如实降级消息(graceful 空态,不崩溃)。
 *
 * 测试面:openSession 与 showQuickPick 注入,单测不发真实网络包。
 */

import * as vscode from 'vscode';

import { getDerivedDatabaseProfile } from './configDerive';
import { resolveDatabaseInterfaceConfig } from './serverConfigMerge';
import { openRedisSession, type RedisConnectionConfig, type RedisSession } from './redisDrift';
import { buildRedisKeyTree, formatRedisHashPreview } from './redisKeySpace';

/** 只读输出通道名(与 mysql 预览同风格,展示面不可编辑)。 */
export const REDIS_KEYSPACE_CHANNEL_NAME = 'KBEngine Redis 键空间(只读)';

/** SCAN 单页上限;枚举页数上限(防失控大键空间,截断如实标记)。 */
export const REDIS_SCAN_PAGE_LIMIT = 1000;

export interface RedisKeyspaceOutput {
  appendLine(line: string): void;
  show(): void;
}

export interface RedisKeyspaceDeps {
  /** 会话打开(注入以测;缺省走真实 openRedisSession)。 */
  openSession?: (config: RedisConnectionConfig) => Promise<RedisSession>;
  /** 键选择(注入以测;缺省 vscode quickPick)。 */
  showQuickPick?: (items: string[], options: { placeHolder: string }) => Promise<string | undefined>;
  createOutputChannel?: (name: string) => RedisKeyspaceOutput;
}

const defaultCreateOutput = (name: string): RedisKeyspaceOutput => {
  const channel = vscode.window.createOutputChannel(name);
  return {
    appendLine: (line: string) => channel.appendLine(line),
    show: () => channel.show()
  };
};

/** 派生档案 → redis 连接配置(密码仅就地读取,不落展示)。 */
export function buildRedisConnectionConfig(): {
  config: RedisConnectionConfig;
  passwordUnavailable: boolean;
} | null {
  const profile = getDerivedDatabaseProfile();
  if (!profile || profile.dbType !== 'redis') {
    return null;
  }
  const plain = resolveDatabaseInterfaceConfig()?.plainPassword;
  const index = Number.parseInt(String(profile.databaseName || '0'), 10);
  return {
    config: {
      host: profile.host,
      port: profile.port,
      password: plain,
      dbIndex: Number.isFinite(index) ? index : 0
    },
    passwordUnavailable: !plain
  };
}

/**
 * 枚举全部 `kbe_*` 键(SCAN 循环,页上限截断如实标记)。
 * 失败抛;空键空间返回空数组(调用方决定空态文案)。
 */
export async function enumerateRedisKeys(
  session: RedisSession,
  pattern: string
): Promise<{ keys: string[]; truncated: boolean }> {
  const keys: string[] = [];
  let cursor = '0';
  let pages = 0;
  do {
    const page = await session.scanKeys(cursor, pattern);
    keys.push(...page.keys);
    cursor = page.cursor;
    pages += 1;
    if (pages >= REDIS_SCAN_PAGE_LIMIT && cursor !== '0') {
      return { keys, truncated: true };
    }
  } while (cursor !== '0');
  return { keys, truncated: false };
}

/** 键空间树文本(供输出通道;空键空间如实说明,不伪造表结构)。 */
export function renderRedisKeyTreeText(keys: string[], truncated: boolean): string {
  if (keys.length === 0) {
    return '(键空间为空:无 kbe_* 键——引擎未写入或后端无数据;只读枚举,不模拟 mysql 表结构)';
  }
  const nodes = buildRedisKeyTree(keys);
  const lines: string[] = [];
  const walk = (node: { label: string; description: string; children?: unknown[] }, depth: number): void => {
    lines.push(`${'  '.repeat(depth)}${node.label}  ${node.description}`);
    node.children?.forEach(child => walk(child as typeof node, depth + 1));
  };
  nodes.forEach(node => walk(node, 0));
  if (truncated) {
    lines.push(`(枚举达到 ${REDIS_SCAN_PAGE_LIMIT} 页上限,已截断——完整键空间可能更大)`);
  }
  return lines.join('\n');
}

/**
 * 命令主体:打开 redis 会话 → 枚举键 → 树选键 → HGETALL 预览 → 输出通道。
 * 返回面向用户的结论串(成功/降级原因);绝不抛出。
 */
export async function runRedisKeyspacePreviewCommand(deps: RedisKeyspaceDeps = {}): Promise<string> {
  const openSession = deps.openSession ?? openRedisSession;
  const showQuickPick = deps.showQuickPick ?? (async (items, options) => {
    const picked = await vscode.window.showQuickPick(items, options);
    return picked;
  });
  const createOutput = deps.createOutputChannel ?? defaultCreateOutput;

  const built = buildRedisConnectionConfig();
  if (!built) {
    return '当前后端不是 redis(仅 mysql/redis 双后端)——未预览';
  }
  if (built.passwordUnavailable) {
    return '密码不可读(引擎 RSA 密文或未配置)——未预览';
  }

  let session: RedisSession | null = null;
  try {
    session = await openSession(built.config);
    const { keys, truncated } = await enumerateRedisKeys(session, 'kbe_*');
    if (keys.length === 0) {
      return renderRedisKeyTreeText([], false);
    }
    const picked = await showQuickPick(
      keys.map(key => key),
      { placeHolder: '选择要预览的 redis 键(只读 HGETALL)' }
    );
    if (!picked) {
      return '已取消(未选择键)';
    }
    if (truncated) {
      return `键空间达到 ${REDIS_SCAN_PAGE_LIMIT} 页上限已截断,未完整枚举——请缩小预览面或走运维通道`;
    }
    const hash = await session.hashGetAll(picked);
    const output = createOutput(REDIS_KEYSPACE_CHANNEL_NAME);
    output.appendLine(formatRedisHashPreview(picked, hash));
    output.show();
    return `预览完成:${picked}(${Object.keys(hash).length} 字段,结果见输出通道,只读)`;
  } catch (error) {
    return `键空间预览失败:${error instanceof Error ? error.message : String(error)}(只读降级,不影响其他功能)`;
  } finally {
    session?.close();
  }
}
