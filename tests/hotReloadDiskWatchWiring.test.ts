import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { setupHotReload, type HotReloadTimerDeps } from '../src/hotReload';
import type { DiskWatchDiagnostic, DiskWatcherFactory } from '../src/backend/hotReloadDiskWatch';
import { resetScanRootCache, setActiveProfileScanRoot } from '../src/scanRoots';
import {
  allFileSystemWatchers,
  configurationOverrides,
  lastFileSystemWatcher,
  workspaceEvents
} from './helpers/vscodeStub';
import { RelativePattern } from './fake-vscode/core';

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

/** RelativePattern 注册形态 → 可断言文本(base 是路径或 Uri 都吃) */
const patternText = (pattern: unknown): string => {
  if (pattern instanceof RelativePattern) {
    const base = pattern.base as { fsPath?: string } | string;
    const basePath = typeof base === 'string' ? base : (base.fsPath ?? String(base));
    return `${basePath}/${pattern.pattern}`;
  }
  return String(pattern);
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
    // RUST-329 增量:目标切换用例设置的活动 profile 扫描根与发现记忆须复位
    setActiveProfileScanRoot(null);
    resetScanRootCache();
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

  const boot = (
    options: {
      globs?: string[];
      withDisk?: boolean;
      triggerMode?: string;
      scriptRoots?: string[];
      scriptRoot?: string;
      /** RUST-329 增量:不写 globs(globsSpec=unset → source=derived) */
      unsetGlobs?: boolean;
      /** RUST-329 增量:捕获目标切换订阅口(活动 profile 事件) */
      onTargetChanged?: (handler: () => void) => { dispose(): void };
    } = {}
  ): {
    clock: ReturnType<typeof makeTimers>;
    context: vscode.ExtensionContext;
    diagnostics: DiskWatchDiagnostic[];
    runCalls: string[];
  } => {
    configurationOverrides.set('kbengine', {
      hotReload: {
        enabled: true,
        // RUST-329 增量:不写 globs = 未配置派生面(assetsRoot 派生,不回落全工作区扫)
        ...(options.unsetGlobs ? {} : { globs: options.globs ?? ['**/*.py'] }),
        actionName: '热更',
        debounceMs: 100,
        // 本文件专测磁盘面:一律显式选中 onDiskChange(缺省 onSave 不建,另行钉)
        triggerMode: options.triggerMode ?? 'onDiskChange'
      }
    });
    const clock = makeTimers();
    const context = makeContext();
    contexts.push(context);
    const diagnostics: DiskWatchDiagnostic[] = [];
    const runCalls: string[] = [];
    setupHotReload(context, name => void runCalls.push(name), {
      timers: clock.timers,
      ...(options.onTargetChanged ? { onTargetChanged: options.onTargetChanged } : {}),
      ...(options.scriptRoots !== undefined || options.scriptRoot !== undefined
        ? {
            defaultHotfix: {
              ...(options.scriptRoots !== undefined
                ? { resolveScriptRoots: () => options.scriptRoots! }
                : {}),
              ...(options.scriptRoot !== undefined
                ? { resolveScriptRoot: () => options.scriptRoot! }
                : {})
            }
          }
        : {}),
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

  it('缺省模式 onSave:注入也不建磁盘面(HR-WATCH-001 默认推荐保存面)', () => {
    boot({ triggerMode: 'onSave' });
    expect(allFileSystemWatchers.map(watcher => watcher.pattern)).toEqual(['**/*.py']);
  });

  it('切到 onDiskChange:配置变更即建面;切回 onSave 即拆(HR-WATCH-001/005)', async () => {
    const first = boot({ triggerMode: 'onSave' });
    expect(allFileSystemWatchers).toHaveLength(1);

    configurationOverrides.set('kbengine', {
      hotReload: {
        enabled: true,
        globs: ['**/*.py'],
        actionName: '热更',
        debounceMs: 100,
        triggerMode: 'onDiskChange'
      }
    });
    workspaceEvents.configurationChanged.fire({
      affectsConfiguration: (section: string) => section === 'kbengine'
    });
    // 旧 save watcher 随 apply 重建被 dispose 再建:栈顶两枚=新 save 面+磁盘面
    expect(allFileSystemWatchers[allFileSystemWatchers.length - 1].pattern).toBe('/ws/**/*.py');
    expect(allFileSystemWatchers[allFileSystemWatchers.length - 2].pattern).toBe('**/*.py');
    lastFileSystemWatcher.current!.fireChange({ fsPath: '/ws/scripts/A.py' } as never);
    expect(first.clock.tick()).toBe(2);
    await flush();
    expect(first.runCalls).toEqual(['热更']);

    configurationOverrides.set('kbengine', {
      hotReload: {
        enabled: true,
        globs: ['**/*.py'],
        actionName: '热更',
        debounceMs: 100,
        triggerMode: 'onSave'
      }
    });
    workspaceEvents.configurationChanged.fire({
      affectsConfiguration: (section: string) => section === 'kbengine'
    });
    // 切回 onSave:磁盘面不再重建,栈顶=新 save 面(**/*.py)
    expect(allFileSystemWatchers[allFileSystemWatchers.length - 1].pattern).toBe('**/*.py');
  });

  it('未保存的编辑不触发(HR-WATCH-002):缓冲变更不进链,写盘 watcher 事件才进', async () => {
    const { clock, runCalls } = boot();
    workspaceEvents.documentChanged.fire({ document: { uri: { fsPath: '/ws/scripts/A.py' } } } as never);
    expect(clock.tick()).toBe(0);
    await flush();
    expect(runCalls).toEqual([]);
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

  it('远程 URI(HR-WATCH-018):vscode-remote 工作区按 fsPath 派生根与进链,不因 scheme 误滤', async () => {
    // 远程 SSH 工作区:根与文件 URI 均 vscode-remote://,装配只取 fsPath 驱动,
    // scheme 不是屏障(否则远程编辑会被误滤成域外)。
    vscode.workspace.workspaceFolders = [
      { uri: { fsPath: '/home/dev/ws', scheme: 'vscode-remote' } as never, name: 'remote', index: 0 }
    ];
    const { clock, runCalls } = boot();
    // 远程根按同法派生递归 glob(与本地根同形)
    expect(allFileSystemWatchers.map(watcher => watcher.pattern)).toEqual([
      '**/*.py',
      '/home/dev/ws/**/*.py'
    ]);
    lastFileSystemWatcher.current!.fireChange({
      fsPath: '/home/dev/ws/scripts/base/Avatar.py',
      scheme: 'vscode-remote',
      authority: 'ssh-remote+host'
    } as never);
    expect(clock.tick()).toBe(2);
    await flush();
    expect(runCalls).toEqual(['热更']);
  });

  it('target 维根绑定(HR-WATCH-005):配了脚本根即按 target 根监听,不再监听全工作区', async () => {
    const { clock, diagnostics, runCalls } = boot({ scriptRoots: ['/ws/scripts'] });
    // 磁盘面收窄到 target 脚本根(不是 /ws/**/*.py);显式 glob 面不变
    expect(allFileSystemWatchers.map(watcher => watcher.pattern)).toEqual([
      '**/*.py',
      '/ws/scripts/**/*.py'
    ]);
    expect(diagnostics[0]?.detail).toBe('/ws/scripts/**/*.py');
    // target 根下事件照常进链
    lastFileSystemWatcher.current!.fireChange({ fsPath: '/ws/scripts/Avatar.py' } as never);
    expect(clock.tick()).toBe(2);
    await flush();
    expect(runCalls).toEqual(['热更']);
    // 收窄=工作区根不再有磁盘 watcher 面(域外事件无从产生)
    expect(allFileSystemWatchers.some(watcher => watcher.pattern === '/ws/**/*.py')).toBe(false);
  });

  it('target 维根绑定单根形态(HR-MOD-006 同域):scriptRoot 便捷形态同样收窄', () => {
    boot({ scriptRoot: '/ws/scripts' });
    expect(allFileSystemWatchers.map(watcher => watcher.pattern)).toEqual([
      '**/*.py',
      '/ws/scripts/**/*.py'
    ]);
  });

  it('target 维根绑定回退(HR-WATCH-005):未配脚本根(空表)回落工作区根,既有行为逐字不变', async () => {
    const { clock, runCalls } = boot({ scriptRoots: [] });
    expect(allFileSystemWatchers.map(watcher => watcher.pattern)).toEqual([
      '**/*.py',
      '/ws/**/*.py'
    ]);
    lastFileSystemWatcher.current!.fireChange({ fsPath: '/ws/scripts/Avatar.py' } as never);
    expect(clock.tick()).toBe(2);
    await flush();
    expect(runCalls).toEqual(['热更']);
  });

  it('RUST-329 增量:范围闸基座恒为工作区根,收窄只收 watch 面(显式带路径段 glob 不漏匹配)', async () => {
    // 配了脚本根收窄到 /ws/scripts 时,显式 globs='scripts/entity/**/*.py' 仍是
    // 工作区相对契约(save 面 attachWatcher 同一语义)——若范围闸基座随收窄变
    // scriptRoots,根内文件相对路径已无 scripts/ 前缀会漏匹配,磁盘面与 save
    // 面同文件不同判;基座保工作区根则两面对同一文件同判。
    const { clock, diagnostics, runCalls } = boot({
      globs: ['scripts/entity/**/*.py'],
      scriptRoot: '/ws/scripts'
    });
    // watch 面已按 target 根收窄(不再监听全工作区)
    expect(allFileSystemWatchers.map(watcher => watcher.pattern)).toEqual([
      'scripts/entity/**/*.py',
      '/ws/scripts/**/*.py'
    ]);
    // 脚本根内且 glob 命中(按工作区根相对路径)→ 进链触发动作
    allFileSystemWatchers[1]!.fireChange({ fsPath: '/ws/scripts/entity/Hero.py' } as never);
    expect(clock.tick()).toBe(2);
    await flush();
    expect(runCalls).toEqual(['热更']);
    // 脚本根内但 glob 未命中(工作区相对路径无 scripts/entity/ 前缀)→ 范围闸拦下
    allFileSystemWatchers[1]!.fireChange({ fsPath: '/ws/scripts/other/Gone.py' } as never);
    expect(clock.tick()).toBe(0);
    await flush();
    expect(runCalls).toEqual(['热更']);
    expect(diagnostics.map(diagnostic => diagnostic.type)).toEqual(['watch-created']);
  });

  it('RUST-329 增量:目标切换按签名判据重建,换根即拆旧建新、同根不重建', async () => {
    // 部署目标(活动 profile)切换不派发配置/文件夹事件,由订阅口接——
    // 签名含 assetsRoot(随活动 profile 解析),换根=签名变=拆旧建新。
    const root = mkdtempSync(path.join(os.tmpdir(), 'kode3-target-switch-'));
    const assetsA = path.join(root, 'assets-a');
    const assetsB = path.join(root, 'assets-b');
    mkdirSync(assetsA, { recursive: true });
    mkdirSync(assetsB, { recursive: true });
    try {
      vscode.workspace.workspaceFolders = [{ uri: { fsPath: root } as never, name: 'ws', index: 0 }];
      setActiveProfileScanRoot(assetsA);
      const handlers: Array<() => void> = [];
      let subscriptionDisposes = 0;
      const { clock, context, runCalls } = boot({
        unsetGlobs: true,
        onTargetChanged: handler => {
          handlers.push(handler);
          return { dispose: (): void => { subscriptionDisposes += 1; } };
        }
      });
      // 派生面:save=目标资产根全扩展(RelativePattern),磁盘=工作区根(未配脚本根)
      expect(patternText(allFileSystemWatchers[0]!.pattern)).toBe(
        `${root.replace(/\\/g, '/')}/assets-a/**/*`
      );
      expect(allFileSystemWatchers[1]!.pattern).toBe(`${root.replace(/\\/g, '/')}/**/*.py`);

      // 同根目标切换:签名不变不重建
      handlers[0]!();
      setActiveProfileScanRoot(assetsA);
      await flush();
      expect(allFileSystemWatchers).toHaveLength(2);

      // 换根目标切换:签名变=拆旧建新(微任务延后一拍,读到的已是新目标根)
      handlers[0]!();
      setActiveProfileScanRoot(assetsB); // 模拟同次派发里后注册的索引输入订阅
      await flush();
      expect(allFileSystemWatchers).toHaveLength(4);
      expect(patternText(allFileSystemWatchers[2]!.pattern)).toBe(
        `${root.replace(/\\/g, '/')}/assets-b/**/*`
      );
      // 旧根 watcher 失效:事件不进链
      allFileSystemWatchers[0]!.fireChange({ fsPath: path.join(assetsA, 'A.py') } as never);
      expect(clock.tick()).toBe(0);
      await flush();
      expect(runCalls).toEqual([]);
      // 新根 watcher 进链
      allFileSystemWatchers[2]!.fireChange({ fsPath: path.join(assetsB, 'A.py') } as never);
      expect(clock.tick()).toBe(2);
      await flush();
      expect(runCalls).toEqual(['热更']);
      // 订阅口由 setupHotReload 复合 dispose 释放(不另挂 context.subscriptions)
      context.subscriptions[0]?.dispose();
      expect(subscriptionDisposes).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

  it('工作区根变更:foldersChanged 即按新根重建磁盘面(RUST-385 HR-UI-012)', async () => {
    const { clock, runCalls } = boot();
    const oldDiskWatcher = allFileSystemWatchers[1];
    expect(allFileSystemWatchers).toHaveLength(2);

    // 多根会话加/删文件夹:不派发 kbengine 配置事件,只派发 foldersChanged
    vscode.workspace.workspaceFolders = [
      { uri: { fsPath: '/ws2' } as never, name: 'ws2', index: 0 }
    ];
    workspaceEvents.foldersChanged.fire({
      added: [{ uri: { fsPath: '/ws2' } }],
      removed: [{ uri: { fsPath: '/ws' } }]
    });
    await flush();

    // 旧根 watcher 随重建 dispose 失效;apply 重建=热更面+磁盘面各一,
    // 磁盘面按当次工作区根派生模式
    expect(allFileSystemWatchers.map(watcher => watcher.pattern)).toEqual([
      '**/*.py',
      '/ws/**/*.py',
      '**/*.py',
      '/ws2/**/*.py'
    ]);
    oldDiskWatcher.fireChange({ fsPath: '/ws2/scripts/A.py' } as never);
    expect(clock.tick()).toBe(0);
    await flush();
    expect(runCalls).toEqual([]);
    allFileSystemWatchers[3]!.fireChange({ fsPath: '/ws2/scripts/A.py' } as never);
    expect(clock.tick()).toBe(2);
    await flush();
    expect(runCalls).toEqual(['热更']);
  });

  it('foldersChanged 无根变化:签名不变不重建(RUST-385 HR-UI-012)', async () => {
    boot();
    workspaceEvents.foldersChanged.fire({ added: [], removed: [] });
    await flush();
    expect(allFileSystemWatchers).toHaveLength(2);
  });

  it('源锁:装配层真适配接了磁盘面(vscode.createFileSystemWatcher 薄适配)', () => {
    const source = readFileSync(path.join(__dirname, '..', 'src', 'activate', 'hotReload.ts'), 'utf8');
    expect(source).toContain('const hotReloadDiskWatcherFactory: DiskWatcherFactory');
    expect(source).toContain('vscode.workspace.createFileSystemWatcher(pattern)');
    expect(source).toContain('diskWatch: {');
    expect(source).toContain('createWatcher: hotReloadDiskWatcherFactory');
  });

  it('源锁:目标切换接线(activate 注入 profile 事件,setup 持有释放)(RUST-329)', () => {
    const activate = readFileSync(
      path.join(__dirname, '..', 'src', 'activate', 'hotReload.ts'),
      'utf8'
    );
    // 真事件源=活动 profile 切换(targetId=profile.id);返回值交 setupHotReload
    // 复合 dispose(不另挂 context.subscriptions,避免双释)
    expect(activate).toContain('onTargetChanged: handler => onDidChangeActiveProfile(() => handler())');
    const core = readFileSync(path.join(__dirname, '..', 'src', 'hotReload.ts'), 'utf8');
    expect(core).toContain('targetSubscription?.dispose()');
    expect(core).toContain('queueMicrotask(() => {');
  });
});
