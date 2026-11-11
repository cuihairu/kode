import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { ProjectProfileStore } from '../src/projectProfiles';
import { ensureDefaultDeploymentProfile } from '../src/ensureDefaultProfile';

// 默认部署 profile(用户令 2026-11-10「创建默认的」收口):零 profile 时自动
// 创建并激活一条 default 档(种子=发现链 assetsRoot / 布局判定 engineRoot /
// 解释器解析,判不出的字段落空串/缺失如实记录);已有任何 profile 不代主
// (返回 null,交给既有选择/激活流)。assetsRoot 判空时布局判定短路不调——
// firstExistingPath 以空基底 join 出相对路径,会拿进程 cwd 误探。

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

const makeDeps = (overrides: {
  profiles?: number;
  workspaceRoot?: string | null;
  resolveAssetsRoot?: (workspaceRoot: string) => string;
  identifyLayout?: (assetsRoot: string) => { engineRoot?: string | null };
  resolveInterpreter?: (workspaceRoot?: string) => {
    interpreterPath: string | null;
    interpreterSource: string;
  };
  activate?: (profileId: string) => Promise<string | null>;
} = {}) => {
  const store = new ProjectProfileStore(new MemoryMemento());
  const preset = overrides.profiles ?? 0;
  const existing: Promise<unknown>[] = [];
  for (let i = 0; i < preset; i += 1) {
    existing.push(
      store.create({ displayName: `既有${i}`, assetsRoot: '/ws/assets', engineRoot: '/ws/engine' })
    );
  }
  const activated: string[] = [];
  return {
    store,
    activated,
    deps: {
      store,
      activateProfile: async (profileId: string) => {
        activated.push(profileId);
        return (overrides.activate ?? (async () => profileId))(profileId);
      },
      workspaceRoot: overrides.workspaceRoot !== undefined ? overrides.workspaceRoot : '/ws',
      ...(overrides.resolveAssetsRoot ? { resolveAssetsRoot: overrides.resolveAssetsRoot } : {}),
      ...(overrides.identifyLayout ? { identifyLayout: overrides.identifyLayout } : {}),
      ...(overrides.resolveInterpreter ? { resolveInterpreter: overrides.resolveInterpreter } : {})
    },
    ready: Promise.all(existing)
  };
};

describe('ensureDefaultDeploymentProfile(零 profile 默认档)', () => {
  it('零 profile + 种子齐全 → 创建 default 档并激活,字段来自发现链', async () => {
    const { deps, store, activated, ready } = makeDeps({
      resolveAssetsRoot: root => `${root}/assets`,
      identifyLayout: assetsRoot => ({ engineRoot: `${assetsRoot}/../kbe` }),
      resolveInterpreter: () => ({ interpreterPath: '/ws/.venv/bin/python', interpreterSource: 'venv' })
    });
    await ready;
    const created = await ensureDefaultDeploymentProfile(deps);
    expect(created).not.toBeNull();
    expect(created?.displayName).toBe('default');
    expect(created?.assetsRoot).toBe('/ws/assets');
    expect(created?.engineRoot).toBe('/ws/assets/../kbe');
    expect(created?.interpreterPath).toBe('/ws/.venv/bin/python');
    expect(created?.interpreterSource).toBe('venv');
    expect(activated).toEqual([created?.id]);
    // 落盘可读回(持久化身份,不是一次性对象)
    expect(store.list().map(entry => entry.id)).toEqual([created?.id]);
    expect(store.get(created?.id ?? '')?.displayName).toBe('default');
  });

  it('已有 profile → 返回 null 不代主,零创建零激活', async () => {
    const { deps, store, activated, ready } = makeDeps({ profiles: 1 });
    await ready;
    const before = store.list().length;
    const created = await ensureDefaultDeploymentProfile({
      ...deps,
      identifyLayout: () => {
        throw new Error('已有 profile 时不应触发任何种子解析');
      }
    });
    expect(created).toBeNull();
    expect(store.list().length).toBe(before);
    expect(activated).toEqual([]);
  });

  it('workspaceRoot null(无文件夹)→ 种子如实落空串,布局判定短路不调', async () => {
    const { deps, activated, ready } = makeDeps({
      workspaceRoot: null,
      resolveInterpreter: root => {
        expect(root).toBeUndefined();
        return { interpreterPath: null, interpreterSource: 'missing' };
      }
    });
    await ready;
    const created = await ensureDefaultDeploymentProfile({
      ...deps,
      identifyLayout: () => {
        throw new Error('空 assetsRoot 时不应调布局判定(防空基底 cwd 误探)');
      }
    });
    expect(created?.assetsRoot).toBe('');
    expect(created?.engineRoot).toBe('');
    expect(created?.interpreterPath).toBeNull();
    expect(created?.interpreterSource).toBe('missing');
    expect(activated).toEqual([created?.id]);
  });

  it('发现链判不出 assetsRoot → 布局判定短路,engineRoot 空串(不拿 cwd 误探)', async () => {
    const { deps, ready } = makeDeps({
      resolveAssetsRoot: () => ''
    });
    await ready;
    const created = await ensureDefaultDeploymentProfile({
      ...deps,
      identifyLayout: () => {
        throw new Error('空 assetsRoot 时不应调布局判定(防空基底 cwd 误探)');
      }
    });
    expect(created?.assetsRoot).toBe('');
    expect(created?.engineRoot).toBe('');
  });

  it('布局判不出引擎根(null)→ engineRoot 落空串,档案照建', async () => {
    const { deps, ready } = makeDeps({
      resolveAssetsRoot: root => `${root}/assets`,
      identifyLayout: () => ({ engineRoot: null })
    });
    await ready;
    const created = await ensureDefaultDeploymentProfile(deps);
    expect(created?.assetsRoot).toBe('/ws/assets');
    expect(created?.engineRoot).toBe('');
  });

  it('解释器缺失(null/missing)→ 如实记录,不伪造路径', async () => {
    const { deps, ready } = makeDeps({
      resolveInterpreter: () => ({ interpreterPath: null, interpreterSource: 'missing' })
    });
    await ready;
    const created = await ensureDefaultDeploymentProfile(deps);
    expect(created?.interpreterPath).toBeNull();
    expect(created?.interpreterSource).toBe('missing');
  });
});
