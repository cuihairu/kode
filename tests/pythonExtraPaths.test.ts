import { beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import {
  PYTHON_EXTRA_PATHS_MANAGED_KEY,
  PYTHON_EXTRA_PATHS_SETTING,
  normalizeExtraPath,
  planPythonExtraPaths,
  pythonScriptRootCandidates,
  syncPythonExtraPaths
} from '../src/pythonExtraPaths';
import {
  configurationOverrides,
  messages,
  Uri,
  windowState,
  workspace as stubWorkspace,
  workspaceState
} from './helpers/vscodeStub';

// 功能差距盘点 G1(docs/reference-feature-gap.md):把 scripts 根写进
// python.analysis.extraPaths,让 Python 扩展(Pylance)解析 import KBEngine。
// 纯计划段(normalize/candidates/plan)注入 exists/listSubdirs 不碰真 fs;
// 同步段走替身 workspace.updateWorkspaceConfiguration 记账。

const memento = new Map<string, unknown>();

const makeContext = (): vscode.ExtensionContext =>
  ({
    subscriptions: [],
    workspaceState: {
      get: <T>(key: string): T | undefined => memento.get(key) as T | undefined,
      update: async (key: string, value: unknown): Promise<void> => {
        memento.set(key, value);
      }
    }
  }) as unknown as vscode.ExtensionContext;

describe('normalizeExtraPath(extraPaths 条目规范化)', () => {
  it('只剥尾部分隔符并丢弃空串', () => {
    expect(normalizeExtraPath('/ws/scripts/')).toBe('/ws/scripts');
    expect(normalizeExtraPath('/ws/assets\\scripts\\')).toBe('/ws/assets\\scripts');
    expect(normalizeExtraPath('')).toBe('');
  });

  it('Windows 盘符根的尾分隔符保留一层', () => {
    expect(normalizeExtraPath('C:\\')).toBe('C:');
    expect(normalizeExtraPath('C:\\scripts\\\\')).toBe('C:\\scripts');
  });
});

describe('pythonScriptRootCandidates(scripts 根发现)', () => {
  const exists = (paths: string[]) => (candidate: string): boolean => paths.includes(candidate);

  it('与 entityMapping 同口径的三条工作区前缀,只在存在时入选', () => {
    const roots = pythonScriptRootCandidates('/ws', {
      exists: exists(['/ws/scripts']),
      listSubdirs: () => []
    });

    expect(roots).toEqual(['/ws/scripts']);
  });

  it('一级 *_assets 目录(批129 约定)的 scripts 也入选', () => {
    const roots = pythonScriptRootCandidates('/repo', {
      exists: exists(['/repo/server_assets/scripts', '/repo/flyff_assets/scripts']),
      listSubdirs: () => ['flyff_assets', 'node_modules', 'src']
    });

    expect(roots).toEqual(['/repo/server_assets/scripts', '/repo/flyff_assets/scripts']);
  });
});

describe('planPythonExtraPaths(只管理自己那一段)', () => {
  const deps = { exists: (): boolean => true, listSubdirs: (): string[] => [] };

  it('首次同步:发现的根全部追加在用户手填段之后', () => {
    const plan = planPythonExtraPaths({
      workspaceRoot: '/ws',
      currentPaths: ['/user/lib'],
      previouslyManaged: [],
      deps
    });

    expect(plan.managedPaths).toEqual(['/ws/scripts', '/ws/assets/scripts', '/ws/server_assets/scripts']);
    expect(plan.nextPaths).toEqual([
      '/user/lib',
      '/ws/scripts',
      '/ws/assets/scripts',
      '/ws/server_assets/scripts'
    ]);
    expect(plan.changed).toBe(true);
  });

  it('再同步:发现结果不变时不重复写(changed=false)', () => {
    const first = planPythonExtraPaths({ workspaceRoot: '/ws', currentPaths: [], previouslyManaged: [], deps });
    const second = planPythonExtraPaths({
      workspaceRoot: '/ws',
      currentPaths: first.nextPaths,
      previouslyManaged: first.managedPaths,
      deps
    });

    expect(second.changed).toBe(false);
    expect(second.nextPaths).toEqual(first.nextPaths);
  });

  it('用户手填的路径永不被动,上次管理的失效根被替换', () => {
    const plan = planPythonExtraPaths({
      workspaceRoot: '/ws',
      currentPaths: ['/user/lib', '/old/gone/scripts'],
      previouslyManaged: ['/old/gone/scripts'],
      deps
    });

    expect(plan.nextPaths).toContain('/user/lib');
    expect(plan.nextPaths).not.toContain('/old/gone/scripts');
    expect(plan.managedPaths).toEqual(['/ws/scripts', '/ws/assets/scripts', '/ws/server_assets/scripts']);
  });

  it('尾分隔符差异不影响相等判断,空串条目被丢弃', () => {
    const plan = planPythonExtraPaths({
      workspaceRoot: '/ws',
      currentPaths: ['/ws/scripts/', '/ws/assets/scripts/', '/ws/server_assets/scripts/', ''],
      previouslyManaged: ['/ws/scripts', '/ws/assets/scripts', '/ws/server_assets/scripts'],
      deps: { exists: (): boolean => true, listSubdirs: (): string[] => [] }
    });

    expect(plan.changed).toBe(false);
    expect(plan.nextPaths).toEqual(['/ws/scripts', '/ws/assets/scripts', '/ws/server_assets/scripts']);
  });

  it('根全不存在时管理段为空,只剩用户段', () => {
    const plan = planPythonExtraPaths({
      workspaceRoot: '/ws',
      currentPaths: ['/user/lib'],
      previouslyManaged: [],
      deps: { exists: (): boolean => false, listSubdirs: () => ['not_assets'] }
    });

    expect(plan.managedPaths).toEqual([]);
    expect(plan.nextPaths).toEqual(['/user/lib']);
    expect(plan.changed).toBe(false);
  });

  it('extraManaged(G2 存根目录)追加在发现根之后,用户段仍最前', () => {
    const plan = planPythonExtraPaths({
      workspaceRoot: '/ws',
      currentPaths: ['/user/lib'],
      previouslyManaged: [],
      extraManaged: ['/ws/.kbengine/stubs'],
      deps
    });

    expect(plan.managedPaths).toEqual([
      '/ws/scripts',
      '/ws/assets/scripts',
      '/ws/server_assets/scripts',
      '/ws/.kbengine/stubs'
    ]);
    expect(plan.nextPaths).toEqual([
      '/user/lib',
      '/ws/scripts',
      '/ws/assets/scripts',
      '/ws/server_assets/scripts',
      '/ws/.kbengine/stubs'
    ]);
    expect(plan.changed).toBe(true);
  });

  it('极简装配输入:previouslyManaged 缺省按空管理段处理', () => {
    const plan = planPythonExtraPaths({
      workspaceRoot: '/ws',
      currentPaths: [],
      previouslyManaged: undefined as unknown as readonly string[],
      deps
    });

    expect(plan.managedPaths).toEqual(['/ws/scripts', '/ws/assets/scripts', '/ws/server_assets/scripts']);
    expect(plan.changed).toBe(true);
  });

  it('用户手填与发现重复的路径只保留一份', () => {
    const plan = planPythonExtraPaths({
      workspaceRoot: '/ws',
      currentPaths: ['/ws/scripts'],
      previouslyManaged: [],
      deps
    });

    expect(plan.nextPaths).toEqual(['/ws/scripts', '/ws/assets/scripts', '/ws/server_assets/scripts']);
  });
});

describe('syncPythonExtraPaths(装配层)', () => {
  beforeEach(() => {
    messages.info.length = 0;
    messages.warning.length = 0;
    messages.error.length = 0;
    windowState.reset();
    workspaceState.reset();
    memento.clear();
  });

  it('设置关闭时说明并返回,不写任何配置', async () => {
    configurationOverrides.set('kbengine', { 'python.extraPathsSync': false });
    stubWorkspace.workspaceFolders = [{ uri: Uri.file('/ws'), name: 'ws', index: 0 }];

    await syncPythonExtraPaths(makeContext(), {
      exists: (): boolean => true,
      listSubdirs: (): string[] => []
    });

    expect(messages.info[0]).toContain('已关闭');
    expect(workspaceState.workspaceConfigurationUpdates).toHaveLength(0);
    stubWorkspace.workspaceFolders = [];
  });

  it('未打开工作区时如实说明', async () => {
    stubWorkspace.workspaceFolders = [];

    await syncPythonExtraPaths(makeContext(), {
      exists: (): boolean => true,
      listSubdirs: (): string[] => []
    });

    expect(messages.info[0]).toContain('未打开工作区');
  });

  it('写 WorkspaceFolder 级配置并记忆管理段,第二次同步零写入', async () => {
    stubWorkspace.workspaceFolders = [{ uri: Uri.file('/ws'), name: 'ws', index: 0 }];
    const deps = { exists: (): boolean => true, listSubdirs: (): string[] => [] };
    const context = makeContext();

    await syncPythonExtraPaths(context, deps);

    expect(workspaceState.workspaceConfigurationUpdates).toHaveLength(1);
    expect(workspaceState.workspaceConfigurationUpdates[0]).toEqual({
      key: PYTHON_EXTRA_PATHS_SETTING,
      value: [
        '/ws/scripts',
        '/ws/assets/scripts',
        '/ws/server_assets/scripts',
        '/ws/.kbengine/stubs'
      ],
      scope: vscode.ConfigurationTarget.WorkspaceFolder,
      folder: stubWorkspace.workspaceFolders[0]
    });
    const managedKey = `${PYTHON_EXTRA_PATHS_MANAGED_KEY}:/ws`;
    expect(memento.get(managedKey)).toEqual([
      '/ws/scripts',
      '/ws/assets/scripts',
      '/ws/server_assets/scripts',
      '/ws/.kbengine/stubs'
    ]);
    expect(messages.info[0]).toContain('ws');

    configurationOverrides.set('python', {
      'analysis.extraPaths': [
        '/ws/scripts',
        '/ws/assets/scripts',
        '/ws/server_assets/scripts',
        '/ws/.kbengine/stubs'
      ]
    });
    workspaceState.workspaceConfigurationUpdates.length = 0;
    await syncPythonExtraPaths(context, deps);
    expect(workspaceState.workspaceConfigurationUpdates).toHaveLength(0);
    stubWorkspace.workspaceFolders = [];
  });

  it('extraPaths 配置值不是数组时按空处理,不炸', async () => {
    configurationOverrides.set('python', { 'analysis.extraPaths': 'oops' });
    stubWorkspace.workspaceFolders = [{ uri: Uri.file('/ws'), name: 'ws', index: 0 }];

    await syncPythonExtraPaths(makeContext(), {
      exists: (): boolean => true,
      listSubdirs: (): string[] => []
    });

    expect(workspaceState.workspaceConfigurationUpdates[0].value).toEqual([
      '/ws/scripts',
      '/ws/assets/scripts',
      '/ws/server_assets/scripts',
      '/ws/.kbengine/stubs'
    ]);
    stubWorkspace.workspaceFolders = [];
  });

  it('极简装配上下文(无 workspaceState)照常写配置,只是不记忆', async () => {
    stubWorkspace.workspaceFolders = [{ uri: Uri.file('/ws'), name: 'ws', index: 0 }];

    await syncPythonExtraPaths({ subscriptions: [] } as unknown as vscode.ExtensionContext, {
      exists: (): boolean => true,
      listSubdirs: (): string[] => []
    });

    expect(workspaceState.workspaceConfigurationUpdates).toHaveLength(1);
    expect(memento.size).toBe(0);
    stubWorkspace.workspaceFolders = [];
  });

  it('静默模式:激活期自动同步,关闭/未开工作区零提示', async () => {
    configurationOverrides.set('kbengine', { 'python.extraPathsSync': false });
    stubWorkspace.workspaceFolders = [];

    await syncPythonExtraPaths(makeContext(), {
      exists: (): boolean => true,
      listSubdirs: (): string[] => []
    }, { silent: true });
    expect(messages.info).toHaveLength(0);

    configurationOverrides.delete('kbengine');
    await syncPythonExtraPaths(makeContext(), {
      exists: (): boolean => true,
      listSubdirs: (): string[] => []
    }, { silent: true });
    expect(messages.info).toHaveLength(0);
  });

  it('静默模式全程零提示,成功写入也不弹(激活期约定)', async () => {
    stubWorkspace.workspaceFolders = [{ uri: Uri.file('/ws'), name: 'ws', index: 0 }];

    await syncPythonExtraPaths(makeContext(), {
      exists: (): boolean => true,
      listSubdirs: (): string[] => []
    }, { silent: true });

    expect(workspaceState.workspaceConfigurationUpdates).toHaveLength(1);
    expect(messages.info).toHaveLength(0);
    stubWorkspace.workspaceFolders = [];
  });

  it('装配层默认依赖:工作区根读不到时按无嵌套资产根处理,不炸不写', async () => {
    stubWorkspace.workspaceFolders = [
      { uri: Uri.file('/nonexistent-kbengine-probe-root'), name: 'probe', index: 0 }
    ];

    // 不注入 deps,走 fileSystemScriptRootDeps 真实 fs:目录不存在,
    // readdirSync 抛错进 catch,existsSync 亦假 → 无可发现根
    await syncPythonExtraPaths(makeContext());

    expect(workspaceState.workspaceConfigurationUpdates).toHaveLength(0);
    expect(messages.info).toHaveLength(0);
    stubWorkspace.workspaceFolders = [];
  });

  it('G2 存根文件在盘且设置开时,存根目录并入 managed 段写入', async () => {
    stubWorkspace.workspaceFolders = [{ uri: Uri.file('/ws'), name: 'ws', index: 0 }];
    const stubFile = '/ws/.kbengine/stubs/KBEngine.pyi';
    const deps = {
      exists: (candidate: string): boolean =>
        ['/ws/scripts', '/ws/assets/scripts', '/ws/server_assets/scripts', stubFile].includes(candidate),
      listSubdirs: (): string[] => []
    };

    await syncPythonExtraPaths(makeContext(), deps);

    const update = workspaceState.workspaceConfigurationUpdates[0];
    expect(update.value).toEqual([
      '/ws/scripts',
      '/ws/assets/scripts',
      '/ws/server_assets/scripts',
      '/ws/.kbengine/stubs'
    ]);
    stubWorkspace.workspaceFolders = [];
  });

  it('kbe_types.py 单独在盘(类型桩 §6)也并入同一个存根目录,不重复', async () => {
    stubWorkspace.workspaceFolders = [{ uri: Uri.file('/ws'), name: 'ws', index: 0 }];
    const typeStubFile = '/ws/.kbengine/stubs/kbe_types.py';
    const deps = {
      exists: (candidate: string): boolean =>
        ['/ws/scripts', '/ws/assets/scripts', '/ws/server_assets/scripts', typeStubFile].includes(candidate),
      listSubdirs: (): string[] => []
    };

    await syncPythonExtraPaths(makeContext(), deps);

    const update = workspaceState.workspaceConfigurationUpdates[0];
    expect(update.value).toEqual([
      '/ws/scripts',
      '/ws/assets/scripts',
      '/ws/server_assets/scripts',
      '/ws/.kbengine/stubs'
    ]);
    stubWorkspace.workspaceFolders = [];
  });

  it('G2 存根导出关闭时,存根文件在盘也不并入', async () => {
    configurationOverrides.set('kbengine', { 'python.stubExport': false });
    stubWorkspace.workspaceFolders = [{ uri: Uri.file('/ws'), name: 'ws', index: 0 }];
    const stubFile = '/ws/.kbengine/stubs/KBEngine.pyi';
    const deps = {
      exists: (candidate: string): boolean =>
        ['/ws/scripts', '/ws/assets/scripts', '/ws/server_assets/scripts', stubFile].includes(candidate),
      listSubdirs: (): string[] => []
    };

    await syncPythonExtraPaths(makeContext(), deps);

    const update = workspaceState.workspaceConfigurationUpdates[0];
    expect(update.value).toEqual(['/ws/scripts', '/ws/assets/scripts', '/ws/server_assets/scripts']);
    stubWorkspace.workspaceFolders = [];
  });

  it('G2 存根文件不在盘时(尚未导出),不写不存在的目录', async () => {
    stubWorkspace.workspaceFolders = [{ uri: Uri.file('/ws'), name: 'ws', index: 0 }];
    const deps = {
      exists: (candidate: string): boolean =>
        ['/ws/scripts', '/ws/assets/scripts', '/ws/server_assets/scripts'].includes(candidate),
      listSubdirs: (): string[] => []
    };

    await syncPythonExtraPaths(makeContext(), deps);

    const update = workspaceState.workspaceConfigurationUpdates[0];
    expect(update.value).toEqual(['/ws/scripts', '/ws/assets/scripts', '/ws/server_assets/scripts']);
    stubWorkspace.workspaceFolders = [];
  });

  it('无任何可发现根时不写配置也不打扰用户', async () => {
    stubWorkspace.workspaceFolders = [{ uri: Uri.file('/ws'), name: 'ws', index: 0 }];

    await syncPythonExtraPaths(makeContext(), {
      exists: (): boolean => false,
      listSubdirs: (): string[] => []
    });

    expect(workspaceState.workspaceConfigurationUpdates).toHaveLength(0);
    expect(messages.info).toHaveLength(0);
    stubWorkspace.workspaceFolders = [];
  });
});
