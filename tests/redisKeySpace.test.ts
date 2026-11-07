import { describe, expect, it } from 'vitest';
import {
  REDIS_ENTITYLOG_FIELDS,
  REDIS_KBE_PREFIX,
  buildRedisKeyTree,
  classifyRedisKey,
  formatRedisHashPreview
} from '../src/redisKeySpace';

describe('classifyRedisKey', () => {
  it('kbe_entitylog:<dbid>:<type> 归为实体日志', () => {
    expect(classifyRedisKey('kbe_entitylog:42:3')).toEqual({
      kind: 'entitylog',
      key: 'kbe_entitylog:42:3',
      dbid: '42',
      entityType: '3'
    });
  });

  it('kbe_ 前缀其余归为引擎表键', () => {
    expect(classifyRedisKey('kbe_account:7')).toEqual({
      kind: 'table',
      key: 'kbe_account:7',
      table: 'account:7'
    });
  });

  it('非 kbe 前缀归为未知', () => {
    expect(classifyRedisKey('session:abc')).toEqual({ kind: 'unknown', key: 'session:abc' });
  });

  it('字段表与引擎 kbe_table_redis.cpp 对齐', () => {
    expect(REDIS_ENTITYLOG_FIELDS).toEqual(['entityID', 'ip', 'port', 'componentID', 'serverGroupID']);
    expect(REDIS_KBE_PREFIX).toBe('kbe');
  });
});

describe('buildRedisKeyTree', () => {
  it('按种类分组', () => {
    const nodes = buildRedisKeyTree(['kbe_entitylog:1:2', 'kbe_account:3', 'session:x']);
    expect(nodes.map(node => node.label)).toEqual(['实体日志(kbe_entitylog)', '引擎表键(kbe_*)', '其他键']);
    const entitylog = nodes[0];
    expect(entitylog.children?.[0].label).toBe('kbe_entitylog:1:2');
    expect(entitylog.children?.[0].description).toContain('dbid=1');
  });

  it('空键清单返回空', () => {
    expect(buildRedisKeyTree([])).toEqual([]);
  });
});

describe('formatRedisHashPreview', () => {
  it('含字段对齐输出', () => {
    const text = formatRedisHashPreview('kbe_entitylog:1:2', { entityID: '7', ip: '127.0.0.1' });
    expect(text).toContain('===== 键预览 kbe_entitylog:1:2(2 字段) =====');
    expect(text).toContain('entityID');
    expect(text).toContain('127.0.0.1');
    expect(text).toContain('只读预览');
  });

  it('空哈希如实说明', () => {
    const text = formatRedisHashPreview('kbe_account:3', {});
    expect(text).toContain('0 字段');
    expect(text).toContain('空哈希');
  });
});
