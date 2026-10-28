import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { ProjectProfileStore } from '../src/projectProfiles';

// IDE-PRJ-001:项目 profile 的稳定身份。一个 profile = assets 根 + engine 根
// 组合 + 显示名;同一工作区可存多套组合,各自持有独立的持久稳定 ID,显示名
// 只是可变字段(改名/同名互不吞并);持久化走 workspaceState——重启(新 store
// 实例、同一 memento)后 ID 仍能读回。极简装配上下文(无 workspaceState)
// 退化为会话内记忆。

class MemoryMemento implements vscode.Memento {
  private readonly map = new Map<string, unknown>();

  keys(): readonly string[] {
    return [...this.map.keys()];
  }

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    return this.map.has(key) ? (this.map.get(key) as T) : defaultValue;
  }

  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) {
      this.map.delete(key);
    } else {
      this.map.set(key, value);
    }
    return Promise.resolve();
  }

  setKeysForSync(_keys: readonly string[]): void {
    // 内存替身不参与云同步
  }
}

const comboA = { displayName: '主线', assetsRoot: '/ws/assets-main', engineRoot: '/ws/engine-main' };
const comboB = { displayName: '测试服', assetsRoot: '/ws/assets-test', engineRoot: '/ws/engine-test' };

describe('project profile stable identity (IDE-PRJ-001)', () => {
  it('keeps two assets/engine combos as separate profiles', async () => {
    const store = new ProjectProfileStore(new MemoryMemento());
    const main = await store.create(comboA);
    const test = await store.create(comboB);

    const all = store.list();
    expect(all).toHaveLength(2);
    expect(main.id).not.toBe(test.id);
    expect(store.get(main.id)).toMatchObject({ id: main.id, ...comboA });
    expect(store.get(test.id)).toMatchObject({ id: test.id, ...comboB });

    // 返回的是防御性拷贝:改它不腐蚀存量
    all[0].displayName = '篡改';
    expect(store.list()[0].displayName).toBe(comboA.displayName);
  });

  it('does not key profiles by display name (rename and same-name coexist)', async () => {
    const store = new ProjectProfileStore(new MemoryMemento());
    const main = await store.create(comboA);
    const test = await store.create(comboB);

    // 把 B 改成与 A 同名:两条都还在,身份(ID)与根路径不动
    const renamed = await store.update(test.id, { displayName: comboA.displayName });
    expect(renamed?.id).toBe(test.id);
    const all = store.list();
    expect(all).toHaveLength(2);
    expect(all.map(item => item.id).sort()).toEqual([main.id, test.id].sort());
    expect(store.get(test.id)).toMatchObject({ id: test.id, displayName: comboA.displayName, assetsRoot: comboB.assetsRoot });
    expect(store.get(main.id)).toMatchObject({ id: main.id, ...comboA });
  });

  it('reads identities back after a restart (new store, same persisted state)', async () => {
    const memento = new MemoryMemento();
    const first = new ProjectProfileStore(memento);
    const a = await first.create(comboA);
    const b = await first.create(comboB);

    const reopened = new ProjectProfileStore(memento);
    expect(reopened.get(a.id)).toMatchObject({ id: a.id, ...comboA });
    expect(reopened.get(b.id)).toMatchObject({ id: b.id, ...comboB });
    expect(reopened.list()).toHaveLength(2);
  });

  it('update keeps the id while changing fields; remove deletes only the target', async () => {
    const store = new ProjectProfileStore(new MemoryMemento());
    const a = await store.create(comboA);
    const b = await store.create(comboB);

    const moved = await store.update(a.id, { assetsRoot: '/ws/assets-moved' });
    expect(moved?.id).toBe(a.id);
    expect(store.get(a.id)).toMatchObject({ id: a.id, assetsRoot: '/ws/assets-moved', engineRoot: comboA.engineRoot });
    expect(store.list()).toHaveLength(2);

    // 不存在的 id:更新返回 null,不新增
    expect(await store.update('missing', { displayName: '幽灵' })).toBeNull();

    expect(await store.remove(a.id)).toBe(true);
    expect(store.get(a.id)).toBeNull();
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]).toMatchObject({ id: b.id, ...comboB });
    expect(await store.remove(a.id)).toBe(false);
  });

  it('works session-only when no workspaceState is available (minimal assembly)', async () => {
    const store = new ProjectProfileStore();
    const a = await store.create(comboA);

    expect(store.get(a.id)).toMatchObject({ id: a.id, ...comboA });
    expect(store.list()).toHaveLength(1);
  });

  it('ignores corrupt persisted payloads instead of crashing', async () => {
    const memento = new MemoryMemento();
    await memento.update('kbengine.projectProfiles.v1', [
      'junk',
      { noId: true },
      { id: 'p1', displayName: '幸存', assetsRoot: '/ws/a', engineRoot: '/ws/e' }
    ]);

    const store = new ProjectProfileStore(memento);
    expect(store.list()).toHaveLength(1);
    expect(store.get('p1')).toMatchObject({ id: 'p1', displayName: '幸存' });
  });
});

describe('per-profile root persistence (IDE-PRJ-002)', () => {
  it('re-saves roots on one profile without bleeding into the other, across restarts', async () => {
    const memento = new MemoryMemento();
    const first = new ProjectProfileStore(memento);
    const a = await first.create(comboA);
    const b = await first.create(comboB);

    // 重启(新 store 同 memento)后按 profile 重存 A 的两个根
    const reopened = new ProjectProfileStore(memento);
    const resaved = await reopened.saveRoots(a.id, { assetsRoot: '/ws/assets-moved', engineRoot: '/ws/engine-moved' });
    expect(resaved).toMatchObject({ id: a.id, assetsRoot: '/ws/assets-moved', engineRoot: '/ws/engine-moved' });

    // 再一次重启:两条各自独立——A 是新根,B 原根原样,互不串写
    const second = new ProjectProfileStore(memento);
    expect(second.get(a.id)).toMatchObject({ id: a.id, assetsRoot: '/ws/assets-moved', engineRoot: '/ws/engine-moved', displayName: comboA.displayName });
    expect(second.get(b.id)).toMatchObject({ id: b.id, ...comboB });
  });

  it('saves a single root field, keeping the other untouched', async () => {
    const store = new ProjectProfileStore(new MemoryMemento());
    const a = await store.create(comboA);

    // 只换 engine 根:assets 根与显示名不动
    expect(await store.saveRoots(a.id, { engineRoot: '/ws/engine-alt' })).toMatchObject({
      id: a.id,
      displayName: comboA.displayName,
      assetsRoot: comboA.assetsRoot,
      engineRoot: '/ws/engine-alt'
    });
  });

  it('returns null for unknown ids (no silent create)', async () => {
    const store = new ProjectProfileStore(new MemoryMemento());
    expect(await store.saveRoots('missing', { assetsRoot: '/ws/x' })).toBeNull();
    expect(store.list()).toHaveLength(0);
  });
});
