import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import {
  ACTIVE_PROFILE_STATE_KEY,
  onDidChangeActiveProfile,
  readActiveProfileId,
  resolveActiveProfile,
  selectActiveProfile,
  setActiveProfile
} from '../src/activeProfile';
import { ProjectProfileStore } from '../src/projectProfiles';
import { window as stubWindow } from './helpers/vscodeStub';

// IDE-PRJ-010:活动 profile 选择入口。选择按稳定 ID 持久化(workspaceState
// 键),显示名只是可变字段——改名不丢选择;每次真实切换(新 ID ≠ 旧 ID)
// 恰发一次事件,重选同条不算切换;未知 ID 拒绝,陈旧选择(记录已删)如实
// null 不伪装有效。

class MemoryMemento implements vscode.Memento {
  private readonly map = new Map<string, unknown>();

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

  keys(): readonly string[] {
    return [...this.map.keys()];
  }

  setKeysForSync(_keys: readonly string[]): void {
    // 内存替身不参与云同步
  }
}

async function seedTwoProfiles(memento: MemoryMemento): Promise<{ aId: string; bId: string }> {
  const store = new ProjectProfileStore(memento);
  const a = await store.create({ displayName: 'A', assetsRoot: '/ws/a', engineRoot: '' });
  const b = await store.create({ displayName: 'B', assetsRoot: '/ws/b', engineRoot: '' });
  return { aId: a.id, bId: b.id };
}

describe('active profile selection (IDE-PRJ-010)', () => {
  it('persists the stable ID and fires exactly one switch event', async () => {
    const memento = new MemoryMemento();
    const { bId } = await seedTwoProfiles(memento);
    const events: string[] = [];
    const subscription = onDidChangeActiveProfile(id => events.push(id));
    try {
      const result = await setActiveProfile(memento, bId);
      expect(result).toBe(bId);
      expect(memento.get<string>(ACTIVE_PROFILE_STATE_KEY)).toBe(bId);
      expect(events).toEqual([bId]);
    } finally {
      subscription.dispose();
    }
  });

  it('keeps the selection when the display name changes', async () => {
    const memento = new MemoryMemento();
    const { bId } = await seedTwoProfiles(memento);
    await setActiveProfile(memento, bId);

    const store = new ProjectProfileStore(memento);
    await store.update(bId, { displayName: '改名后的 B' });

    expect(readActiveProfileId(memento)).toBe(bId);
    expect(resolveActiveProfile(memento)?.id).toBe(bId);
    expect(resolveActiveProfile(memento)?.displayName).toBe('改名后的 B');
  });

  it('re-selecting the same profile is not a switch: no event', async () => {
    const memento = new MemoryMemento();
    const { bId } = await seedTwoProfiles(memento);
    const events: string[] = [];
    const subscription = onDidChangeActiveProfile(id => events.push(id));
    try {
      await setActiveProfile(memento, bId);
      expect(events).toHaveLength(1);

      const again = await setActiveProfile(memento, bId);
      expect(again).toBe(bId);
      expect(events).toHaveLength(1);
    } finally {
      subscription.dispose();
    }
  });

  it('switching to another profile fires exactly one more event', async () => {
    const memento = new MemoryMemento();
    const { aId, bId } = await seedTwoProfiles(memento);
    const events: string[] = [];
    const subscription = onDidChangeActiveProfile(id => events.push(id));
    try {
      await setActiveProfile(memento, bId);
      await setActiveProfile(memento, aId);
      expect(events).toEqual([bId, aId]);
      expect(memento.get<string>(ACTIVE_PROFILE_STATE_KEY)).toBe(aId);
    } finally {
      subscription.dispose();
    }
  });

  it('refuses an unknown id: nothing persisted, nothing fired', async () => {
    const memento = new MemoryMemento();
    const { bId } = await seedTwoProfiles(memento);
    await setActiveProfile(memento, bId);
    const events: string[] = [];
    const subscription = onDidChangeActiveProfile(id => events.push(id));
    try {
      await expect(setActiveProfile(memento, 'not-a-real-id')).resolves.toBeNull();
      expect(memento.get<string>(ACTIVE_PROFILE_STATE_KEY)).toBe(bId);
      expect(events).toHaveLength(0);
    } finally {
      subscription.dispose();
    }
  });

  it('resolves a stale selection (profile removed) honestly to null', async () => {
    const memento = new MemoryMemento();
    const { bId } = await seedTwoProfiles(memento);
    await setActiveProfile(memento, bId);

    await new ProjectProfileStore(memento).remove(bId);

    expect(readActiveProfileId(memento)).toBe(bId);
    expect(resolveActiveProfile(memento)).toBeNull();
  });

  it('reads null without a memento (minimal assembly)', () => {
    expect(readActiveProfileId(undefined)).toBeNull();
    expect(resolveActiveProfile(undefined)).toBeNull();
  });
});

describe('active profile selection command (IDE-PRJ-010)', () => {
  const windowish = stubWindow as unknown as Record<string, unknown>;
  const originalPick = windowish.showQuickPick;
  const originalInfo = windowish.showInformationMessage;
  const info: string[] = [];

  const patchWindow = (pick: unknown, message: unknown): void => {
    windowish.showQuickPick = pick;
    windowish.showInformationMessage = message;
  };
  const restoreWindow = (): void => {
    windowish.showQuickPick = originalPick;
    windowish.showInformationMessage = originalInfo;
  };

  it('says so and skips the picker when there are no profiles', async () => {
    const memento = new MemoryMemento();
    let pickCalls = 0;
    patchWindow(
      async (): Promise<unknown> => {
        pickCalls += 1;
        return undefined;
      },
      async (message: string): Promise<unknown> => {
        info.push(message);
        return undefined;
      }
    );
    try {
      await selectActiveProfile({ workspaceState: memento });
    } finally {
      restoreWindow();
    }

    expect(pickCalls).toBe(0);
    expect(info.at(-1)).toContain('没有可选择');
  });

  it('persists the picked profile and reports it', async () => {
    const memento = new MemoryMemento();
    const { aId, bId } = await seedTwoProfiles(memento);
    patchWindow(
      async (items: unknown[] | Promise<unknown[]>): Promise<unknown> => {
        const resolved = (await items) as Array<{ label: string; description: string }>;
        // 列表按 profile 全量展开,显示名与稳定 ID 各就各位
        expect(resolved.map(item => item.description).sort()).toEqual([aId, bId].sort());
        return resolved.find(item => item.description === bId);
      },
      async (message: string): Promise<unknown> => {
        info.push(message);
        return undefined;
      }
    );
    try {
      await selectActiveProfile({ workspaceState: memento });
    } finally {
      restoreWindow();
    }

    expect(memento.get<string>(ACTIVE_PROFILE_STATE_KEY)).toBe(bId);
    expect(info.at(-1)).toContain('活动 profile');
    expect(info.at(-1)).toContain(bId);
  });

  it('dismisses the picker without persisting anything', async () => {
    const memento = new MemoryMemento();
    await seedTwoProfiles(memento);
    patchWindow(
      async (): Promise<unknown> => undefined,
      async (): Promise<unknown> => undefined
    );
    try {
      await selectActiveProfile({ workspaceState: memento });
    } finally {
      restoreWindow();
    }

    expect(memento.get<string>(ACTIVE_PROFILE_STATE_KEY)).toBeUndefined();
  });
});
