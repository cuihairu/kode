/**
 * Redis keyspace model (KODE-REDIS-UI-001): classifies keys that really exist,
 * following the kbe source conventions.
 *
 * Conventions (aligned with kbe/src/lib/db_redis, KBE_TABLE_PERFIX="kbe"):
 * - `kbe_entitylog:<dbid>:<entityType>` -> the entity log hash, with fields
 *   entityID/ip/port/componentID/serverGroupID (kbe_table_redis.cpp:21/32).
 * - other `kbe_<...>` -> engine table namespace keys (entity persistence is a
 *   stub in the engine, so this only classifies honestly without fabricating
 *   table structure).
 * - anything else -> external/unknown keys (shown as-is, without guessing
 *   the semantics).
 *
 * Pure functions (no network, no vscode), driven directly by unit tests.
 */

/** Engine table prefix (KBE_TABLE_PERFIX, entity_table.h:37). */
export const REDIS_KBE_PREFIX = 'kbe';

/** Entity log hash fields (matching the HSET field order of kbe_table_redis.cpp). */
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

/** Classification of `kbe_entitylog:<dbid>:<entityType>`. */
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

/** Key list -> tree nodes (children under the connection node; pure functions, easy to unit test). */
export interface RedisKeyTreeNode {
  label: string;
  description: string;
  tooltip?: string;
  children?: RedisKeyTreeNode[];
}

/** Group and summarize by classification: one group for entitylog, one for table, one for unknown. */
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

/** Hash preview text (same style as mysql's formatTablePreview, aligning the field/value columns). */
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
