import { readFileSync } from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { setupHotReload, type HotReloadTimerDeps } from '../src/hotReload';
import type { DiskWatchDiagnostic, DiskWatcherFactory } from '../src/backend/hotReloadDiskWatch';
import {
  allFileSystemWatchers,
  configurationOverrides,
  lastFileSystemWatcher,
  workspaceEvents
} from './helpers/vscodeStub';

// HR-PR-05 磁盘侧接线(装配面):注入 watcher 工厂才建磁盘监视面——按已声明
// 根建 watcher(HR-WATCH-004)、change/create 以 'disk-change' 进同一两级触发
// 链(HR-WATCH-04 合并窗出批;与 save 重叠在流水线纯核归并不双发)、delete
// 不进管线记诊断、热更域范围闸与既有 watcher 面同界(显式收窄 globs 不被磁
// 盘面放大)、配置关/根变即随 apply 重建拆(HR-WATCH-005)、释放全清。不注入
// =原装配行为不变。基线窗(HR-WATCH-015)语义归纯核(建后即 arm 在同步块内,
// 装配面无可滑入空档,不另钉)。

const makeTimers = (): { timers: HotReloadTimerDeps; tick: () => number } => {
  const handles = new Map<unknown, () => void>();
  let nextHandle = 0;
  return {
    tick: () => {
      const callbacks = [...handles.values()];
      handles.clear();
      for (const callback of callbacks) {
        callback();
      }
      return callbacks.length;
    },
    timers: {
      set: (callback): unknown => {
        const handle = nextHandle++;
        handles.set(handle, callback);
        return handle;
      },
      clear: (handle): void => {
        handles.delete(handle);
      }
    }
  };
};

const flush = async (): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
};

describe('setupHotReload 磁盘侧接线(HR-PR-05)', () => {
  let workspaceFoldersBackup: typeof vscode.workspace.workspaceFolders;
  let contexts: vscode.ExtensionContext[] = [];

  beforeEach(() => {
    configurationOverrides.clear();
    lastFileSystemWatcher.current = null;
    allFileSystemWatchers.length = 0;
    workspaceFoldersBackup = vscode.workspace.workspaceFolders;
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: '/ws' } as never, name: 'ws', index: 0 }];
  });

  afterEach(() => {
    // 释放本用例建的装配:配置监听器不清理会在后续用例各自重建(共享替身的账)
    for (const context of contexts) {
      try {
        context.subscriptions[0]?.dispose();
      } catch {
        // 释放失败不掩盖用例本身的断言
      }
    }
    contexts = [];
    vscode.workspace.workspaceFolders = workspaceFoldersBackup;
    configurationOverrides.clear();
    lastFileSystemWatcher.current = null;
    allFileSystemWatchers.length = 0;
  });

  const makeContext = (): vscode.ExtensionContext =>
    ({ subscriptions: [] }) as unknown as vscode.ExtensionContext;

  const diskWatcherFactory: DiskWatcherFactory = pattern => {
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    return {
      pattern,
      onDidChange: cb => {
        watcher.onDidChange(uri => cb(uri.fsPath));
      },
      onDidCreate: cb => {
        watcher.onDidCreate(uri => cb(uri.fsPath));
      },
      onDidDelete: cb => {
        watcher.onDidDelete(uri => cb(uri.fsPath));
      },
      dispose: () => watcher.dispose()
    };
  };

  const boot = (options: { globs?: string[]; withDisk?: boolean } = {}): {
    clock: ReturnType<typeof makeTimers>;
    context: vscode.ExtensionContext;
    diagnostics: DiskWatchDiagnostic[];
    runCalls: string[];
  } => {
    configurationOverrides.set('kbengine', {
      hotReload: {
        enabled: true,
        globs: options.globs ?? ['**/*.py'],
        actionName: '热更',
        debounceMs: 100
      }
    });
    const clock = makeTimers();
    const context = makeContext();
    contexts.push(context);
    const diagnostics: DiskWatchDiagnostic[] = [];
    const runCalls: string[] = [];
    setupHotReload(context, name => void runCalls.push(name), {
      timers: clock.timers,
      ...(options.withDisk === false
        ? {}
        : {
            diskWatch: {
              createWatcher: diskWatcherFactory,
              onDiagnostic: diagnostic => void diagnostics.push(diagnostic)
            }
          })
    });
    return { clock, context, diagnostics, runCalls };
  };

  it('不注入 diskWatch:不建磁盘面,既有 watcher 面照旧', () => {
    boot({ withDisk: false });
    expect(allFileSystemWatchers.map(watcher => watcher.pattern)).toEqual(['**/*.py']);
  });

  it('注入即建:按根派生递归模式,磁盘 change 进链触发动作一批(HR-WATCH-004/003)', async () => {
    const { clock, diagnostics, runCalls } = boot();
    // 显式面先建(**/*.py),磁盘面后建(根派生递归 .py)
    expect(allFileSystemWatchers.map(watcher => watcher.pattern)).toEqual([
      '**/*.py',
      '/ws/**/*.py'
    ]);
    expect(diagnostics.map(diagnostic => diagnostic.type)).toEqual(['watch-created']);
    expect(diagnostics[0]?.detail).toBe('/ws/**/*.py');

    lastFileSystemWatcher.current!.fireChange({ fsPath: '/ws/scripts/Avatar.py' } as never);
    // HR-PR-04 两级形态:进料级去抖+合并窗同拍各一枚
    expect(clock.tick()).toBe(2);
    await flush();
    expect(runCalls).toEqual(['热更']);
    // 域内事件不产生 filtered 诊断
    expect(diagnostics).toHaveLength(1);
  });

  it('磁盘+save 重叠:同文件单批不双发(HR-WATCH-003 live)', async () => {
    const { clock, runCalls } = boot();
    const saveWatcher = allFileSystemWatchers[0];
    const diskWatcher = allFileSystemWatchers[1];

    diskWatcher.fireChange({ fsPath: '/ws/scripts/Avatar.py' } as never);
    saveWatcher.fireChange({ fsPath: '/ws/scripts/Avatar.py' } as never);
    // 两个源汇入同一 pending:进料级归并+合并窗各一枚,单批出
    expect(clock.tick()).toBe(2);
    await flush();
    expect(runCalls).toEqual(['热更']);
  });

  it('delete 不进管线:不触发动作,记 delete-ignored 诊断', async () => {
    const { clock, diagnostics, runCalls } = boot();
    lastFileSystemWatcher.current!.fireDelete({ fsPath: '/ws/scripts/Gone.py' } as never);
    expect(clock.tick()).toBe(0);
    await flush();
    expect(runCalls).toEqual([]);
    expect(diagnostics.map(diagnostic => diagnostic.type)).toEqual([
      'watch-created',
      'delete-ignored'
    ]);
    expect(diagnostics[1]?.detail).toBe('/ws/scripts/Gone.py');
  });

  it('域外如实不进:显式收窄 globs 时磁盘面不放大热更范围', async () => {
    const { clock, diagnostics, runCalls } = boot({ globs: ['scripts/entity/**/*.py'] });
    lastFileSystemWatcher.current!.fireChange({ fsPath: '/ws/other/X.py' } as never);
    expect(clock.tick()).toBe(0);
    expect(runCalls).toEqual([]);

    lastFileSystemWatcher.current!.fireChange({ fsPath: '/ws/scripts/entity/Hero.py' } as never);
    expect(clock.tick()).toBe(2);
    await flush();
    expect(runCalls).toEqual(['热更']);
    // 域外文件被范围闸如实拦下,不产生 filtered 诊断(闸在纯核过滤之后)
    expect(diagnostics.map(diagnostic => diagnostic.type)).toEqual(['watch-created']);
  });

  it('配置关:apply 重建拆磁盘面(旧 watcher 失效,不建新面)(HR-WATCH-005)', async () => {
    const { clock, runCalls } = boot();
    lastFileSystemWatcher.current!.fireChange({ fsPath: '/ws/scripts/A.py' } as never);
    expect(clock.tick()).toBe(2);
    await flush();
    expect(runCalls).toEqual(['热更']);
    const diskWatcher = allFileSystemWatchers[1];

    configurationOverrides.set('kbengine', {
      hotReload: { enabled: false, globs: ['**/*.py'], actionName: '热更', debounceMs: 100 }
    });
    workspaceEvents.configurationChanged.fire({
      affectsConfiguration: (section: string) => section === 'kbengine'
    });
    // 旧 watcher 随控制器 dispose 失效(stub dispose 清监听),关面不建新 watcher
    expect(allFileSystemWatchers).toHaveLength(2);
    diskWatcher.fireChange({ fsPath: '/ws/scripts/A.py' } as never);
    expect(clock.tick()).toBe(0);
    await flush();
    expect(runCalls).toEqual(['热更']);
  });

  it('释放全清:context dispose 后磁盘事件不再进链(HR-WATCH-005)', async () => {
    const { clock, context, runCalls } = boot();
    const diskWatcher = allFileSystemWatchers[1];
    context.subscriptions[0]?.dispose();
    diskWatcher.fireChange({ fsPath: '/ws/scripts/A.py' } as never);
    expect(clock.tick()).toBe(0);
    await flush();
    expect(runCalls).toEqual([]);
  });

  it('源锁:装配层真适配接了磁盘面(vscode.createFileSystemWatcher 薄适配)', () => {
    const source = readFileSync(path.join(__dirname, '..', 'src', 'activate', 'hotReload.ts'), 'utf8');
    expect(source).toContain('const hotReloadDiskWatcherFactory: DiskWatcherFactory');
    expect(source).toContain('vscode.workspace.createFileSystemWatcher(pattern)');
    expect(source).toContain('diskWatch: {');
    expect(source).toContain('createWatcher: hotReloadDiskWatcherFactory');
  });
});
