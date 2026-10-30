import { describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import {
  PROFILE_HEALTH_ISSUE_LABELS,
  collectProfileHealth,
  showProfileHealthSummary
} from '../src/profileHealth';
import { ACTIVE_PROFILE_STATE_KEY, resolveActiveProfile, setActiveProfile } from '../src/activeProfile';
import type { ProjectProfile } from '../src/projectProfiles';
import { ProjectProfileStore } from '../src/projectProfiles';
import { commands, window as stubWindow } from './helpers/vscodeStub';

// IDE-PRJ-009:profile 健康状态汇总到工作台。缺引擎/缺解释器/缺语言服务/
// 根歧义四类问题各自带具体定位入口(命令或设置键),活动 profile 经 PRJ-010
// 的稳定 ID 解析;无活动 profile 如实说明;问题面 QuickPick 逐条列出,选中
// 即跳定位入口,Esc 只看不跳。

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

const healthyProfile: ProjectProfile = {
  id: 'id-1',
  displayName: 'proj',
  assetsRoot: '/ws/proj',
  engineRoot: '/ws/kbe',
  interpreterPath: '/opt/py/python3',
  interpreterSource: 'path'
};

const activeServiceFacts = {
  registered: true,
  isActive: true,
  installDirExists: true,
  extraPathsWritten: true
};

describe('profile health collection (IDE-PRJ-009)', () => {
  const deps = {
    exists: (candidate: string): boolean =>
      ['/ws/proj', '/ws/kbe', '/opt/py/python3'].includes(candidate)
  };

  it('reports all four issue kinds with their concrete entries', () => {
    const issues = collectProfileHealth(
      {
        id: 'id-2',
        displayName: 'broken',
        assetsRoot: '/gone/proj',
        engineRoot: '',
        interpreterPath: null,
        interpreterSource: 'missing'
      },
      { registered: false, isActive: false, installDirExists: false, extraPathsWritten: false },
      { exists: (): boolean => false }
    );

    expect(issues.map(issue => issue.kind)).toEqual([
      'roots-ambiguous',
      'engine-missing',
      'interpreter-missing',
      'service-unavailable'
    ]);
    const byKind = Object.fromEntries(issues.map(issue => [issue.kind, issue]));
    expect(byKind['roots-ambiguous'].entry).toMatchObject({
      kind: 'command',
      target: 'kbengine.project.import'
    });
    expect(byKind['engine-missing'].entry).toMatchObject({
      kind: 'command',
      target: 'kbengine.project.import'
    });
    expect(byKind['interpreter-missing'].entry).toMatchObject({
      kind: 'setting',
      target: 'kbengine.python.interpreterPath'
    });
    expect(byKind['service-unavailable'].entry).toMatchObject({
      kind: 'command',
      target: 'kbengine.python.serviceStatus'
    });
    expect(PROFILE_HEALTH_ISSUE_LABELS['engine-missing']).toBe('缺引擎');
    expect(PROFILE_HEALTH_ISSUE_LABELS['roots-ambiguous']).toBe('根歧义');
  });

  it('records interpreter/engine that exist but are gone from disk as issues', () => {
    const issues = collectProfileHealth(
      { ...healthyProfile, interpreterPath: '/gone/python3' },
      activeServiceFacts,
      deps
    );
    expect(issues.map(issue => issue.kind)).toEqual(['interpreter-missing']);
    expect(issues[0].message).toContain('/gone/python3');
  });

  it('a fully healthy profile yields no issues', () => {
    expect(collectProfileHealth(healthyProfile, activeServiceFacts, deps)).toEqual([]);
  });

  it('an active-but-registered language service is still unavailable (not-installed vs not-enabled alike)', () => {
    const issues = collectProfileHealth(
      healthyProfile,
      { registered: true, isActive: false, installDirExists: true, extraPathsWritten: true },
      deps
    );
    expect(issues.map(issue => issue.kind)).toEqual(['service-unavailable']);
  });
});

describe('profile health summary command (IDE-PRJ-009)', () => {
  const windowish = stubWindow as unknown as Record<string, unknown>;
  const originalPick = windowish.showQuickPick;
  const originalInfo = windowish.showInformationMessage;
  const originalWarning = windowish.showWarningMessage;
  const info: string[] = [];
  const warnings: string[] = [];

  const patchWindow = (): void => {
    windowish.showQuickPick = originalPick;
    windowish.showInformationMessage = async (message: string): Promise<unknown> => {
      info.push(message);
      return undefined;
    };
    windowish.showWarningMessage = async (message: string): Promise<unknown> => {
      warnings.push(message);
      return undefined;
    };
  };
  const restoreWindow = (): void => {
    windowish.showQuickPick = originalPick;
    windowish.showInformationMessage = originalInfo;
    windowish.showWarningMessage = originalWarning;
  };

  const healthyDeps = {
    exists: (candidate: string): boolean =>
      ['/ws/proj', '/ws/kbe', '/opt/py/python3'].includes(candidate),
    resolveServiceFacts: () => activeServiceFacts,
    navigate: async (): Promise<void> => undefined
  };

  it('says so when there is no active profile', async () => {
    patchWindow();
    let pickCalls = 0;
    windowish.showQuickPick = async (): Promise<unknown> => {
      pickCalls += 1;
      return undefined;
    };
    try {
      await showProfileHealthSummary({ workspaceState: new MemoryMemento() }, healthyDeps);
    } finally {
      restoreWindow();
    }

    expect(pickCalls).toBe(0);
    expect(info.at(-1)).toContain('未选择活动 project profile');
  });

  it('reports a healthy active profile without warnings', async () => {
    const memento = new MemoryMemento();
    const store = new ProjectProfileStore(memento);
    const profile = await store.create({
      displayName: 'proj',
      assetsRoot: '/ws/proj',
      engineRoot: '/ws/kbe',
      interpreterPath: '/opt/py/python3',
      interpreterSource: 'path'
    });
    await setActiveProfile(memento, profile.id);
    patchWindow();
    try {
      await showProfileHealthSummary({ workspaceState: memento }, healthyDeps);
    } finally {
      restoreWindow();
    }

    expect(info.at(-1)).toContain('健康');
    expect(warnings).toHaveLength(0);
  });

  it('lists each issue with its entry and navigates on pick', async () => {
    const memento = new MemoryMemento();
    const store = new ProjectProfileStore(memento);
    const profile = await store.create({
      displayName: 'broken',
      assetsRoot: '/gone/proj',
      engineRoot: ''
    });
    await setActiveProfile(memento, profile.id);
    expect(resolveActiveProfile(memento)?.id).toBe(profile.id);
    expect(memento.get<string>(ACTIVE_PROFILE_STATE_KEY)).toBe(profile.id);

    patchWindow();
    const navigated: string[] = [];
    let rowDetails: string[] = [];
    windowish.showQuickPick = async (items: unknown[] | Promise<unknown[]>): Promise<unknown> => {
      const resolved = (await items) as Array<{ label: string; description: string; detail: string }>;
      rowDetails = resolved.map(row => row.detail);
      return resolved.find(row => row.label === '缺解释器');
    };
    try {
      await showProfileHealthSummary({ workspaceState: memento }, {
        exists: (): boolean => false,
        resolveServiceFacts: () => activeServiceFacts,
        navigate: async entry => {
          navigated.push(entry.target);
        }
      });
    } finally {
      restoreWindow();
    }

    expect(warnings.at(-1)).toContain('健康问题');
    // 每类问题一行,行内带定位入口说明
    expect(rowDetails.some(detail => detail.includes('kbengine.project.import'))).toBe(true);
    expect(rowDetails.some(detail => detail.includes('kbengine.python.interpreterPath'))).toBe(true);
    expect(navigated).toEqual(['kbengine.python.interpreterPath']);
  });

  it('Esc at the issue list navigates nowhere', async () => {
    const memento = new MemoryMemento();
    const store = new ProjectProfileStore(memento);
    const profile = await store.create({ displayName: 'broken', assetsRoot: '/gone', engineRoot: '' });
    await setActiveProfile(memento, profile.id);
    patchWindow();
    const navigated: string[] = [];
    windowish.showQuickPick = async (): Promise<unknown> => undefined;
    try {
      await showProfileHealthSummary({ workspaceState: memento }, {
        exists: (): boolean => false,
        resolveServiceFacts: () => activeServiceFacts,
        navigate: async entry => {
          navigated.push(entry.target);
        }
      });
    } finally {
      restoreWindow();
    }

    expect(navigated).toHaveLength(0);
  });

  it('engine 根不在盘上如实记 engine-missing(覆盖率 83)', () => {
    // engineRoot 有值但 exists=false:走「不在盘上」臂,不再走「未记录」臂
    const issues = collectProfileHealth(
      { ...healthyProfile, engineRoot: '/gone/kbe' },
      activeServiceFacts,
      { exists: (): boolean => false }
    );
    const engine = issues.find(issue => issue.kind === 'engine-missing');
    expect(engine?.message).toContain('引擎根不在盘上');
    expect(engine?.message).toContain('/gone/kbe');
  });

  it('未注入 navigate 时默认跳转:命令入口直跳命令(覆盖率 179-180)', async () => {
    const memento = new MemoryMemento();
    const store = new ProjectProfileStore(memento);
    const profile = await store.create({
      displayName: 'no-engine',
      assetsRoot: '/ws/proj',
      engineRoot: '/gone/kbe'
    });
    await setActiveProfile(memento, profile.id);
    patchWindow();
    windowish.showQuickPick = async (items: unknown[] | Promise<unknown[]>): Promise<unknown> => {
      const resolved = (await items) as Array<{ label: string; issue: { kind: string } }>;
      return resolved.find(row => row.issue.kind === 'engine-missing');
    };
    const exec = vi.spyOn(commands, 'executeCommand').mockResolvedValue(undefined);
    try {
      await showProfileHealthSummary({ workspaceState: memento }, {
        exists: (): boolean => false,
        resolveServiceFacts: () => activeServiceFacts
      });
      // engine-missing 的入口是命令 kbengine.project.import(断言须在
      // mockRestore 前:restore 会清空调用记录)
      expect(exec).toHaveBeenCalledWith('kbengine.project.import');
    } finally {
      exec.mockRestore();
      restoreWindow();
    }
  });

  it('未注入 navigate 时默认跳转:设置入口跳 openSettings(覆盖率 182)', async () => {
    const memento = new MemoryMemento();
    const store = new ProjectProfileStore(memento);
    const profile = await store.create({
      displayName: 'no-interp',
      assetsRoot: '/ws/proj',
      engineRoot: '/ws/kbe',
      interpreterPath: ''
    });
    await setActiveProfile(memento, profile.id);
    patchWindow();
    windowish.showQuickPick = async (items: unknown[] | Promise<unknown[]>): Promise<unknown> => {
      const resolved = (await items) as Array<{ label: string; issue: { kind: string } }>;
      return resolved.find(row => row.issue.kind === 'interpreter-missing');
    };
    const exec = vi.spyOn(commands, 'executeCommand').mockResolvedValue(undefined);
    try {
      await showProfileHealthSummary({ workspaceState: memento }, {
        exists: (candidate: string): boolean => candidate !== '/opt/py/python3',
        resolveServiceFacts: () => activeServiceFacts
      });
      // interpreter-missing 的入口是设置键:跳 workbench.action.openSettings
      // (断言须在 mockRestore 前:restore 会清空调用记录)
      expect(exec).toHaveBeenCalledWith(
        'workbench.action.openSettings',
        'kbengine.python.interpreterPath'
      );
    } finally {
      exec.mockRestore();
      restoreWindow();
    }
  });
});
