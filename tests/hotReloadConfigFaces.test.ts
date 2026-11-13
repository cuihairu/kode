import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { setupHotReload, type HotReloadTimerDeps } from '../src/hotReload';
import type { FileSnapshot, SyntaxCheck } from '../src/backend/hotReloadSavePipeline';
import { allFileSystemWatchers, commandRegistry, configurationOverrides, messages } from './helpers/vscodeStub';

// HR-PR-04 配置面子批 B:流水线注入面四键的装配钉——稳定窗(HR-WATCH-007,
// 键>0 才注入快照读,0=现有时序不变)、语法闸(HR-WATCH-012,开关开才注入,
// 拦下不发送)、波次冲口(HR-WATCH-013,>0 同窗定稿归集成批)、批量预览阈
// (HR-WATCH-016,超阈滞留预览+放行命令显式放行;滞留面上日志可见)。
// 真实现(workspace.fs 读/解释器 compile)经 pipelineFaces 替身顶替,只钉
// 「键开→面进、键关→面不进、命令→当前实例」的装配语义,判定语义归纯核。
// 两级时序(装配注释同步):键关路径定稿在 tick 拍内同步完成(合并窗同拍
// 即 fire);稳定窗/语法闸路径定稿在 await 后落,合并窗空转一次,由 onEmit
// 的 pending() 补排兜回,下一拍 fire——这正是合并窗补排存在的边缘路径。

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

describe('setupHotReload 流水线注入面配置(HR-PR-04 配置子批)', () => {
  let workspaceFoldersBackup: typeof vscode.workspace.workspaceFolders;
  let contexts: vscode.ExtensionContext[] = [];
  const statusCalls: string[] = [];

  beforeEach(() => {
    configurationOverrides.clear();
    commandRegistry.reset();
    messages.info.length = 0;
    allFileSystemWatchers.length = 0;
    workspaceFoldersBackup = vscode.workspace.workspaceFolders;
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: '/ws' } as never, name: 'ws', index: 0 }];
  });

  afterEach(() => {
    // 全 subscriptions 逆序释放(含本批注册的放行命令),不留跨用例闭包
    for (const context of contexts) {
      for (const subscription of [...context.subscriptions].reverse()) {
        try {
          subscription.dispose();
        } catch {
          // 释放失败不掩盖用例本身的断言
        }
      }
    }
    contexts = [];
    vscode.workspace.workspaceFolders = workspaceFoldersBackup;
    configurationOverrides.clear();
    commandRegistry.reset();
    messages.info.length = 0;
    allFileSystemWatchers.length = 0;
  });

  const makeContext = (): vscode.ExtensionContext =>
    ({ subscriptions: [] }) as unknown as vscode.ExtensionContext;

  const boot = (options: {
    stabilityWindowMs?: number;
    syntaxGate?: boolean;
    batchFlushMs?: number;
    batchPreviewThreshold?: number;
    readSnapshot?: (file: string) => Promise<FileSnapshot | null>;
    syntaxCheck?: SyntaxCheck;
  } = {}): {
    clock: ReturnType<typeof makeTimers>;
    runCalls: string[];
    fireChange: (fsPath: string) => void;
  } => {
    configurationOverrides.set('kbengine', {
      hotReload: {
        enabled: true,
        globs: ['**/*.py'],
        actionName: '热更',
        debounceMs: 100,
        ...(options.stabilityWindowMs !== undefined
          ? { stabilityWindowMs: options.stabilityWindowMs }
          : {}),
        ...(options.syntaxGate !== undefined ? { syntaxGate: options.syntaxGate } : {}),
        ...(options.batchFlushMs !== undefined ? { batchFlushMs: options.batchFlushMs } : {}),
        ...(options.batchPreviewThreshold !== undefined
          ? { batchPreviewThreshold: options.batchPreviewThreshold }
          : {})
      }
    });
    statusCalls.length = 0;
    const clock = makeTimers();
    const context = makeContext();
    contexts.push(context);
    const runCalls: string[] = [];
    setupHotReload(context, name => void runCalls.push(name), {
      timers: clock.timers,
      status: {
        log: (text: string) => void statusCalls.push(text),
        setWatchOff: () => undefined,
        setReady: () => undefined,
        setSending: () => undefined,
        setSentUnverified: () => undefined,
        setFailed: () => undefined,
        setSkippedNoAction: () => undefined,
        setRestartRequired: () => undefined,
        dispose: () => undefined
      } as never,
      ...(options.readSnapshot || options.syntaxCheck
        ? {
            pipelineFaces: {
              ...(options.readSnapshot ? { readSnapshot: options.readSnapshot } : {}),
              ...(options.syntaxCheck ? { syntaxCheck: options.syntaxCheck } : {})
            }
          }
        : {})
    });
    const saveWatcher = allFileSystemWatchers[allFileSystemWatchers.length - 1];
    return {
      clock,
      runCalls,
      fireChange: (fsPath: string) => saveWatcher.fireChange({ fsPath } as never)
    };
  };

  it('稳定窗键关(缺省):不建快照读面,定稿在拍内同步完成即发(HR-WATCH-007=0)', async () => {
    let probes = 0;
    const { clock, runCalls, fireChange } = boot({
      readSnapshot: async () => {
        probes += 1;
        return { hash: 'same', content: 'x = 1' };
      }
    });
    expect(probes).toBe(0); // 键缺省=窗 0:替身即使想进也不进(装配不注入)
    fireChange('/ws/scripts/A.py');
    expect(clock.tick()).toBe(2); // 进料级+合并窗同拍;定稿同步走完,合并窗即发
    await flush();
    expect(runCalls).toEqual(['热更']);
    expect(probes).toBe(0); // 全程未触快照读
  });

  it('稳定窗键开(HR-WATCH-007):两拍一致才发,拍序=去抖→探测→稳定窗→回填合并', async () => {
    let probes = 0;
    const { clock, runCalls, fireChange } = boot({
      stabilityWindowMs: 200,
      readSnapshot: async () => {
        probes += 1;
        return { hash: 'same', content: 'x = 1' };
      }
    });
    fireChange('/ws/scripts/A.py');
    expect(clock.tick()).toBe(2); // 进料挂起在快照读;合并窗空转(定稿未落)
    await flush(); // 第一拍读完成 → 排稳定窗 sleep
    expect(clock.tick()).toBe(1);
    await flush(); // 第二拍读完成 → 两拍一致 → 定稿 → onEmit 补排合并窗
    expect(clock.tick()).toBe(1);
    await flush();
    expect(runCalls).toEqual(['热更']);
    expect(probes).toBe(2); // 两拍快照
  });

  it('语法闸键开拦截(HR-WATCH-012):不通过不发送,合并窗如实空转', async () => {
    let probes = 0;
    const { clock, runCalls, fireChange } = boot({
      syntaxGate: true,
      // 闸键开=读面随启(内容面):替身缺位会走真实现读真磁盘,如实拦不下假文件
      readSnapshot: async () => {
        probes += 1;
        return { hash: 'h1', content: 'def broken(' };
      },
      syntaxCheck: () => ({ ok: false, errors: ['SyntaxError: bad'] })
    });
    fireChange('/ws/scripts/A.py');
    expect(clock.tick()).toBe(2);
    await flush(); // 单拍读落 → 判定 ok=false → 拦下,不进波次不排合并
    expect(clock.tick()).toBe(0); // 无任何后续计时器(滞留批/合并窗都不存在)
    expect(runCalls).toEqual([]);
    expect(probes).toBe(1); // 窗 0:单拍直取内容(无稳定窗第二拍)
  });

  it('语法闸键开放行:同步判定通过后经回填合并窗发送', async () => {
    const { clock, runCalls, fireChange } = boot({
      syntaxGate: true,
      readSnapshot: async () => ({ hash: 'h1', content: 'x = 1' }),
      syntaxCheck: () => ({ ok: true })
    });
    fireChange('/ws/scripts/A.py');
    expect(clock.tick()).toBe(2);
    await flush(); // 单拍读落 → ok=true → 定稿 → 回填合并窗
    expect(clock.tick()).toBe(1);
    await flush();
    expect(runCalls).toEqual(['热更']);
  });

  it('语法闸键关:不注入检查器,内容照发(如实不拦)', async () => {
    const checkerCalls: string[] = [];
    const { clock, runCalls, fireChange } = boot({
      syntaxCheck: content => {
        checkerCalls.push(content);
        return { ok: false };
      }
    });
    fireChange('/ws/scripts/A.py');
    expect(clock.tick()).toBe(2);
    await flush();
    expect(checkerCalls).toEqual([]); // 键关:替身即使想拦也不进
    expect(runCalls).toEqual(['热更']);
  });

  it('波次冲口键开(HR-WATCH-013):同窗两文件定稿归集单批单发', async () => {
    const { clock, runCalls, fireChange } = boot({ batchFlushMs: 300 });
    fireChange('/ws/scripts/A.py');
    fireChange('/ws/scripts/B.py');
    expect(clock.tick()).toBe(3); // 两枚进料计时器+一枚合并窗(去抖后一)
    await flush(); // 定稿落波次缓冲(冲口 300 未到,不出窗)
    expect(runCalls).toEqual([]);
    expect(clock.tick()).toBe(1); // 波次冲口 → 合批出窗 → 回填合并窗
    await flush();
    expect(clock.tick()).toBe(1); // 合并窗整批 fire
    await flush();
    expect(runCalls).toEqual(['热更']); // 单批单发
  });

  it('预览阈+放行命令(HR-WATCH-016):超阈滞留上日志,命令显式放行到当前实例', async () => {
    const { clock, runCalls, fireChange } = boot({ batchFlushMs: 300, batchPreviewThreshold: 1 });
    fireChange('/ws/scripts/A.py');
    fireChange('/ws/scripts/B.py');
    expect(clock.tick()).toBe(3);
    await flush();
    expect(clock.tick()).toBe(1); // 波次出窗 → 2 > 1 → 滞留预览
    await flush();
    expect(runCalls).toEqual([]); // 未放行不发
    expect(statusCalls.some(line => line.includes('预览滞留'))).toBe(true); // 滞留可见性

    await vscode.commands.executeCommand('kbengine.hotReload.releasePreview');
    expect(messages.info).toEqual(['已放行热更预览批次(2 文件)']);
    expect(clock.tick()).toBe(1); // 放行批进合并池 → fire
    await flush();
    expect(runCalls).toEqual(['热更']); // 整批一次
  });

  it('放行命令无滞留:如实报空,不假装放行', async () => {
    const { clock, runCalls } = boot();
    await vscode.commands.executeCommand('kbengine.hotReload.releasePreview');
    expect(messages.info).toEqual(['没有滞留的热更预览批次']);
    expect(clock.tick()).toBe(0);
    await flush();
    expect(runCalls).toEqual([]);
  });

  it('稳定窗真实现面:替身缺位走 workspace.fs 读,文件缺失如实删失不发送', async () => {
    const { clock, runCalls, fireChange } = boot({ stabilityWindowMs: 100 });
    fireChange('/ws/scripts/Gone.py'); // 假体 fs 读真磁盘路径:不存在 → null
    expect(clock.tick()).toBe(2);
    await flush(); // 读失败 → 核按删失丢弃(filtered)
    expect(clock.tick()).toBe(0);
    await flush();
    expect(runCalls).toEqual([]);
  });
});
