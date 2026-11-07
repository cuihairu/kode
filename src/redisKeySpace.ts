/**
 * Redis 键空间模型(KODE-REDIS-UI-001):按 kbe 源码口径分类真实存在的键。
 *
 * 口径(与 kbe/src/lib/db_redis 对齐,KBE_TABLE_PERFIX="kbe"):
 * - `kbe_entitylog:<dbid>:<entityType>` → 实体日志哈希,字段
 *   entityID/ip/port/componentID/serverGroupID(kbe_table_redis.cpp:21/32)。
 * - `kbe_<...>` 其余 → 引擎表命名空间键(实体持久化在引擎为 stub,此处
 *   只如实归类,不伪造表结构)。
 * - 其他 → 外部/未知键(如实显示,不猜测语义)。
 *
 * 纯函数(无网络无 vscode),单测直驱。
 */

/** 引擎表前缀(KBE_TABLE_PERFIX,entity_table.h:37)。 */
export const REDIS_KBE_PREFIX = 'kbe';

/** 实体日志哈希字段(与 kbe_table_redis.cpp HSET 字段序一致)。 */
export const REDIS_ENTITYLOG_FIELDS: readonly string[] = [
  'entityID',
  'ip',
  'port',
  'componentID',
  'serverGroupID'
];

export type RedisKeyInfo =
  | { kind: 'entitylog'; key: string; dbid: string; entityType: string }
  | { kind: 'table'; key: string; table: string }
  | { kind: 'unknown'; key: string };

/** `kbe_entitylog:<dbid>:<entityType>` 分类。 */
export function classifyRedisKey(key: string): RedisKeyInfo {
  const entitylogPrefix = `${REDIS_KBE_PREFIX}_entitylog:`;
  if (key.startsWith(entitylogPrefix)) {
    const rest = key.slice(entitylogPrefix.length);
    const colon = rest.indexOf(':');
    if (colon !== -1) {
      return {
        kind: 'entitylog',
        key,
        dbid: rest.slice(0, colon),
        entityType: rest.slice(colon + 1)
      };
    }
    return { kind: 'entitylog', key, dbid: rest, entityType: '' };
  }
  if (key.startsWith(`${REDIS_KBE_PREFIX}_`)) {
    return { kind: 'table', key, table: key.slice(REDIS_KBE_PREFIX.length + 1) };
  }
  return { kind: 'unknown', key };
}

/** 键清单 → 树节点(连接节点下的子节点;纯函数,便于单测)。 */
export interface RedisKeyTreeNode {
  label: string;
  description: string;
  tooltip?: string;
  children?: RedisKeyTreeNode[];
}

/** 按分类分组汇总:entitylog 一组,table 一组,unknown 一组。 */
export function buildRedisKeyTree(keys: string[]): RedisKeyTreeNode[] {
  const groups: Record<RedisKeyInfo['kind'], RedisKeyTreeNode[]> = {
    entitylog: [],
    table: [],
    unknown: []
  };
  for (const key of keys) {
    const info = classifyRedisKey(key);
    if (info.kind === 'entitylog') {
      groups.entitylog.push({
        label: info.key,
        description: `dbid=${info.dbid}, entityType=${info.entityType || '?'}`,
        tooltip: '引擎实体日志哈希(kbe_entitylog:<dbid>:<entityType>)'
      });
    } else if (info.kind === 'table') {
      groups.table.push({
        label: info.key,
        description: info.table,
        tooltip: '引擎表命名空间键(kbe_<...>;实体持久化在引擎为 stub,只如实归类)'
      });
    } else {
      groups.unknown.push({
        label: info.key,
        description: '未知键(非 kbe 前缀,如实显示)'
      });
    }
  }

  const out: RedisKeyTreeNode[] = [];
  const push = (kind: RedisKeyInfo['kind'], label: string, nodes: RedisKeyTreeNode[]): void => {
    if (nodes.length === 0) {
      return;
    }
    out.push({ label, description: String(nodes.length), children: nodes });
  };
  push('entitylog', '实体日志(kbe_entitylog)', groups.entitylog);
  push('table', '引擎表键(kbe_*)', groups.table);
  push('unknown', '其他键', groups.unknown);
  return out;
}

/** 哈希预览文本(与 mysql formatTablePreview 同风格,列字段/值对齐)。 */
export function formatRedisHashPreview(key: string, hash: Record<string, string>): string {
  const fields = Object.keys(hash);
  const header = `===== 键预览 ${key}(${fields.length} 字段) =====`;
  if (fields.length === 0) {
    return [header, '(空哈希或无字段;只读预览)'].join('\n');
  }
  const width = Math.max(...fields.map(f => f.length), '字段'.length) + 1;
  const renderField = (name: string, value: string): string =>
    `${name.padEnd(width)}${value}`;
  const lines = [header, renderField('字段', '值')];
  for (const field of fields) {
    lines.push(renderField(field, hash[field] ?? ''));
  }
  lines.push('(只读预览,修改请走引擎 db_redis 通道)');
  return lines.join('\n');
}
