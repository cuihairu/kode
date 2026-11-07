import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import packageJson from '../package.json';
import { activate } from '../src/extension';
import { PythonClassIndex } from '../src/pythonClassIndex';
import {
  KBENGINE_SIDEBAR_VIEW_IDS,
  registerStartupViewPlaceholders
} from '../src/startupViewPlaceholders';
import { commandRegistry } from './fake-vscode/commandRegistry';
import { treeRegistrations, windowState } from './fake-vscode/windowState';
import { workspace, workspaceEvents, workspaceState } from './fake-vscode/workspaceState';
import { Uri, type ExtensionContext } from './fake-vscode/core';

interface DeclaredPackageJson {
  contributes: {
    views: Record<string, Array<{ id: string }>>;
  };
}

const declaredViewIds: string[] = Object.values(
  (packageJson as unknown as DeclaredPackageJson).contributes.views
)
  .flat()
  .map(view => view.id)
  .sort();

const makeContext = (): ExtensionContext => ({
  subscriptions: [],
  extensionUri: Uri.file('/workspace/ext'),
  extensionPath: path.resolve(__dirname, '..'),
  extension: { extensionKind: 'workspace' }
});

const disposeAll = (context: ExtensionContext): void => {
  for (const disposable of context.subscriptions) {
    disposable.dispose();
  }
};

beforeEach(() => {
  commandRegistry.reset();
  windowState.reset();
  workspaceState.reset();
  workspace.workspaceFolders = [];
  workspace.findFiles = async () => [] as ReturnType<typeof Uri.file>[];
});

afterEach(() => {
  vi.restoreAllMocks();
});

// KODE-PERF 激活排查(用户现场:KBEngine Explorer 全部视图空,宿主提示
// 「There is no data provider registered that can provide view data」)——
// 该提示 = 视图 id 对应的数据提供者尚未注册(activate 同步体晚段才注册,
// 中途任何一步抛错/被重活拖死,视图就停在无提供者状态)。本面锁定:
// ① 占位注册面覆盖 package.json 声明的全部侧栏视图 id;
// ② 激活中途失败时十个视图也已先行注册(占位兜底,真 provider 随后接管);
// ③ 正常激活下每个视图恰两笔注册(占位 + 真 provider)。

describe('KODE-PERF 视图先行:侧栏视图占位注册', () => {
  it('占位注册面覆盖 package.json 声明的全部侧栏视图 id', () => {
    const registered: string[] = [];
    const registration = registerStartupViewPlaceholders({
      registerTreeDataProvider: (viewId, _provider) => {
        registered.push(viewId);
        return { dispose: () => undefined };
      }
    });
    registration.dispose();
    expect([...registered].sort()).toEqual(declaredViewIds);
    expect(registered).toHaveLength(KBENGINE_SIDEBAR_VIEW_IDS.length);
  });

  it('占位 provider 在真 provider 接管前 getChildren 返回空数组', () => {
    let placeholder: unknown;
    const registration = registerStartupViewPlaceholders({
      registerTreeDataProvider: (viewId, provider) => {
        if (viewId === 'kbengine.entityExplorer') { placeholder = provider; }
        return { dispose: () => undefined };
      }
    });
    const provider = placeholder as { getChildren(): unknown[] };
    expect(provider.getChildren()).toEqual([]);
    registration.dispose();
  });

  it('激活中途失败(watcher 创建抛错)时十个侧栏视图仍已注册(修前红)', () => {
    const context = makeContext();
    vi.spyOn(workspace, 'createFileSystemWatcher').mockImplementation(() => {
      throw new Error('injected watcher failure');
    });
    let activateError: unknown = null;
    try {
      activate(context);
    } catch (error) {
      activateError = error;
    }
    // 激活同步体确实在中途抛了错(故障注入成立)
    expect((activateError as Error | null)?.message).toBe('injected watcher failure');
    // 但视图占位注册已先行落位——宿主不再报「There is no data provider registered」
    expect([...new Set(treeRegistrations.map(item => item.viewId))].sort())
      .toEqual(declaredViewIds);
    disposeAll(context);
  });

  it('激活完成后每个视图 id 恰有两笔注册(占位先行 + 真 provider 接管)', () => {
    const context = makeContext();
    try {
      activate(context);
      const countByView = new Map<string, number>();
      for (const entry of treeRegistrations) {
        countByView.set(entry.viewId, (countByView.get(entry.viewId) ?? 0) + 1);
      }
      for (const viewId of declaredViewIds) {
        expect(countByView.get(viewId), `${viewId} 占位+接管两笔`).toBe(2);
      }
    } finally {
      disposeAll(context);
    }
  });
});

describe('KODE-PERF 重复扫描抑制:watcher 同签名重建跳过 + 排除目录事件过滤', () => {
  it('无实质变化的工作区事件不再拆除重建整组 watcher(修前红)', () => {
    const context = makeContext();
    const originalCreate = workspace.createFileSystemWatcher;
    let createCalls = 0;
    vi.spyOn(workspace, 'createFileSystemWatcher').mockImplementation(((pattern: unknown) => {
      createCalls += 1;
      return originalCreate.call(workspace, pattern as never);
    }) as typeof originalCreate);
    try {
      workspace.workspaceFolders = [{ uri: Uri.file('/ws'), name: 'ws', index: 0 }];
      activate(context);
      const afterActivate = createCalls;
      expect(afterActivate).toBeGreaterThan(0);
      // 空变化事件(removed/added 皆空)→ 根集签名不变 → 不重建
      workspaceEvents.foldersChanged.fire({ added: [], removed: [] });
      expect(createCalls).toBe(afterActivate);
    } finally {
      disposeAll(context);
    }
  });

  it('排除目录(node_modules)下的文件事件不再流入 Python 索引消费面(修前红)', () => {
    const context = makeContext();
    const originalCreate = workspace.createFileSystemWatcher;
    const watchers: Array<{ fireCreate: (uri: ReturnType<typeof Uri.file>) => void }> = [];
    vi.spyOn(workspace, 'createFileSystemWatcher').mockImplementation(((pattern: unknown) => {
      const watcher = originalCreate.call(workspace, pattern as never);
      watchers.push(watcher as never);
      return watcher;
    }) as typeof originalCreate);
    try {
      workspace.workspaceFolders = [{ uri: Uri.file('/ws'), name: 'ws', index: 0 }];
      activate(context);
      const workspaceWatcher = watchers[0];
      expect(workspaceWatcher).toBeTruthy();
      const onFileChanged = vi.spyOn(PythonClassIndex.prototype, 'onFileChanged')
        .mockResolvedValue(undefined);
      workspaceWatcher.fireCreate(Uri.file('/ws/node_modules/pkg/lib.py'));
      expect(onFileChanged, '排除目录事件在 watcher 出口被丢弃').not.toHaveBeenCalled();
      // 非排除路径照常通过(过滤面不误伤业务脚本)
      workspaceWatcher.fireCreate(Uri.file('/ws/scripts/cell/Avatar.py'));
      expect(onFileChanged).toHaveBeenCalledWith('/ws/scripts/cell/Avatar.py');
    } finally {
      disposeAll(context);
      vi.restoreAllMocks();
    }
  });
});
