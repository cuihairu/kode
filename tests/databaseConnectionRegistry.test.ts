import { describe, expect, it } from 'vitest';
import {
  DatabaseConnectionRegistry,
  DatabaseQueryResultCache,
  type DatabaseConnectionConfigSnapshot
} from '../src/backend/databaseConnectionRegistry';

// IDE-DB-001 按 profile 选择只读数据库连接:连接配置与查询结果缓存都
// 以 profileId 为主键隔离——切换项目后新 profile 读自己的配置,绝不
// 沿用另一 profile 的连接配置(未选择过=如实 null 不回退邻居);结果
// 缓存同 SQL 各 profile 各存各的,清缓存/过期都只影响目标 profile;连
// 接配置经注入 load/save 持久化(重启按 profile 独立读回),结果缓存
// 是会话级(不落盘,避免陈旧结果冒充新查询)。

const CFG_A: DatabaseConnectionConfigSnapshot = { host: '127.0.0.1', port: 3306, user: 'kbe', database: 'kbe_a' };
const CFG_B: DatabaseConnectionConfigSnapshot = { host: '192.168.1.10', port: 3307, user: 'kbe', database: 'kbe_b' };

const RESULT_A = { columns: [{ name: 'id', type: 'int' }], rows: [{ id: 1 }] };
const RESULT_B = { columns: [{ name: 'id', type: 'int' }], rows: [{ id: 2 }] };

describe('DatabaseConnectionRegistry(连接配置按 profile 隔离)', () => {
  it('两个 profile 各自选择各自读回,互不覆盖', () => {
    const registry = new DatabaseConnectionRegistry({ now: () => 1 });
    registry.select('profile-a', () => CFG_A);
    registry.select('profile-b', () => CFG_B);

    expect(registry.getActive('profile-a')).toEqual(CFG_A);
    expect(registry.getActive('profile-b')).toEqual(CFG_B);
  });

  it('切换项目不迁移:旧 profile 配置留在原名下', () => {
    const registry = new DatabaseConnectionRegistry({ now: () => 1 });
    registry.select('profile-a', () => CFG_A);
    registry.select('profile-b', () => CFG_B);

    expect(registry.getActive('profile-a')).toEqual(CFG_A);
    expect(registry.getActive('profile-b')).not.toEqual(CFG_A);
  });

  it('未选择过的 profile → 如实 null,绝不回退邻居配置', () => {
    const registry = new DatabaseConnectionRegistry({ now: () => 1 });
    registry.select('profile-a', () => CFG_A);

    expect(registry.getActive('profile-b')).toBeNull();
  });

  it('选择面解析失败(null)→ 该 profile 如实 null,邻居不动', () => {
    const registry = new DatabaseConnectionRegistry({ now: () => 1 });
    registry.select('profile-a', () => CFG_A);
    registry.select('profile-b', () => null);

    expect(registry.getActive('profile-b')).toBeNull();
    expect(registry.getActive('profile-a')).toEqual(CFG_A);
  });

  it('重新选择同 profile → 覆盖为最新(引擎配置变更生效)', () => {
    const registry = new DatabaseConnectionRegistry({ now: () => 1 });
    registry.select('profile-a', () => CFG_A);
    const updated = { ...CFG_A, host: '10.0.0.2' };
    registry.select('profile-a', () => updated);

    expect(registry.getActive('profile-a')).toEqual(updated);
  });

  it('配置持久化:save 落盘,重启(新 registry 同 load)按 profile 独立读回', () => {
    let stored: unknown;
    const deps = {
      now: () => 1,
      load: () => stored,
      save: (data: unknown) => { stored = data; }
    };
    const first = new DatabaseConnectionRegistry(deps);
    first.select('profile-a', () => CFG_A);
    first.select('profile-b', () => CFG_B);

    const reopened = new DatabaseConnectionRegistry(deps);
    expect(reopened.getActive('profile-a')).toEqual(CFG_A);
    expect(reopened.getActive('profile-b')).toEqual(CFG_B);
  });

  it('损坏载荷(非对象)不炸:全部如实未选择', () => {
    const registry = new DatabaseConnectionRegistry({ now: () => 1, load: () => 'garbage' });
    expect(registry.getActive('profile-a')).toBeNull();
  });
});

describe('DatabaseQueryResultCache(结果缓存按 profile 隔离)', () => {
  const SQL = 'SHOW TABLES';

  it('同 SQL 各 profile 各存各的:切项目查不到邻居缓存', () => {
    const cache = new DatabaseQueryResultCache({ now: () => 1000 });
    cache.set('profile-a', SQL, RESULT_A, { identity: 'conn-a' });
    cache.set('profile-b', SQL, RESULT_B, { identity: 'conn-a' });

    expect(cache.get('profile-a', SQL, 'conn-a')).toEqual(RESULT_A);
    expect(cache.get('profile-b', SQL, 'conn-a')).toEqual(RESULT_B);
    const fresh = new DatabaseQueryResultCache({ now: () => 1000 });
    expect(fresh.get('profile-c', SQL, 'conn-a')).toBeUndefined();
  });

  it('IDE-AUD-008:同 profile 不同连接身份各存各的,身份变化不命中旧结果', () => {
    const cache = new DatabaseQueryResultCache({ now: () => 1000 });
    cache.set('profile-a', SQL, RESULT_A, { identity: 'conn-a' });

    // 换了连接(host/port/user/db 任一变化=另一身份)→ 同 SQL 不吃旧身份的缓存
    expect(cache.get('profile-a', SQL, 'conn-b')).toBeUndefined();
    // 旧身份自己的桶还在(切换回去时 TTL 内仍可命中,直到失效面清理)
    expect(cache.get('profile-a', SQL, 'conn-a')).toEqual(RESULT_A);
  });

  it('TTL 窗口内命中,过期不再命中(陈旧结果不冒充)', () => {
    let now = 1000;
    const cache = new DatabaseQueryResultCache({ now: () => now });
    cache.set('profile-a', SQL, RESULT_A, { identity: 'conn-a', ttlMs: 5000 });

    now = 4000;
    expect(cache.get('profile-a', SQL, 'conn-a')).toEqual(RESULT_A);
    now = 7000;
    expect(cache.get('profile-a', SQL, 'conn-a')).toBeUndefined();
  });

  it('clearProfile 只清目标 profile,邻居缓存原样', () => {
    const cache = new DatabaseQueryResultCache({ now: () => 1000 });
    cache.set('profile-a', SQL, RESULT_A, { identity: 'conn-a' });
    cache.set('profile-b', SQL, RESULT_B, { identity: 'conn-b' });

    cache.clearProfile('profile-a');

    expect(cache.get('profile-a', SQL, 'conn-a')).toBeUndefined();
    expect(cache.get('profile-b', SQL, 'conn-b')).toEqual(RESULT_B);
  });

  it('IDE-AUD-008:clearProfile 推进代际,晚到旧代写回被拒不重新污染', () => {
    const cache = new DatabaseQueryResultCache({ now: () => 1000 });
    // 旧代查询发起时捕获的代际
    const staleGeneration = cache.generationOf('profile-a');

    cache.clearProfile('profile-a'); // 失效面:代际推进+清桶

    expect(cache.generationOf('profile-a')).toBe(staleGeneration + 1);
    // 旧连接的查询此刻才回来:带旧代际写回 → 被拒
    expect(cache.set('profile-a', SQL, RESULT_A, { identity: 'conn-a', generation: staleGeneration }))
      .toBe(false);
    expect(cache.get('profile-a', SQL, 'conn-a')).toBeUndefined();
    // 新代写回照常
    expect(cache.set('profile-a', SQL, RESULT_A, { identity: 'conn-a' })).toBe(true);
    expect(cache.get('profile-a', SQL, 'conn-a')).toEqual(RESULT_A);
  });

  it('缓存是会话级:registry 持久化载荷不含查询结果', () => {
    let stored: unknown;
    const deps = {
      now: () => 1,
      load: () => stored,
      save: (data: unknown) => { stored = data; }
    };
    const registry = new DatabaseConnectionRegistry(deps);
    registry.select('profile-a', () => CFG_A);
    const cache = new DatabaseQueryResultCache(deps);
    cache.set('profile-a', SQL, RESULT_A, { identity: 'conn-a' });

    expect(JSON.stringify(stored)).not.toContain('rows');
    expect(new DatabaseQueryResultCache({ now: () => 1, load: () => stored }).get('profile-a', SQL, 'conn-a')).toBeUndefined();
  });
});
