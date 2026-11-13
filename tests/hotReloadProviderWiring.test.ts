import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { hotReloadSectionReader, readHotReloadSettings, setupHotReload, type HotReloadTimerDeps } from '../src/hotReload';
import {
  HOT_RELOAD_PLUGIN_API_VERSION,
  type HotReloadProvider
} from '../src/backend/hotReloadPluginApi';
import { allFileSystemWatchers, configurationOverrides } from './helpers/vscodeStub';

// HR-PR-08 装配接线钉:发送 provider 宿主进真装配——注册时机=装配时、
// 生命周期随复合 dispose 清册、fork 侧实现经 options.hotReloadProviders
// 注入(应答序先到先应答)、内置 HTTP hotfix 实现随 defaultHotfix 面注册;
// 键开(sendViaProviders)无动作名发送先问注册表,无人应答回落默认热更面;
// 键关=面不进链,行为与既有完全一致。重复 id/apiVersion 不符的注册如实拒
// 并上日志。指纹撤回(HR-WATCH-008)在 provider 失败面同样生效。

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

describe('setupHotReload 发送 provider 宿主接线(HR-PR-08)', () => {
  let workspaceFoldersBackup: typeof vscode.workspace.workspaceFolders;
  let contexts: vscode.ExtensionContext[] = [];
  const statusCalls: string[] = [];

  beforeEach(() => {
    configurationOverrides.clear();
    allFileSystemWatchers.length = 0;
    workspaceFoldersBackup = vscode.workspace.workspaceFolders;
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: '/ws' } as never, name: 'ws', index: 0 }];
  });

  afterEach(() => {
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
    allFileSystemWatchers.length = 0;
  });

  const makeContext = (): vscode.ExtensionContext =>
    ({ subscriptions: [] }) as unknown as vscode.ExtensionContext;

  const boot = (options: {
    sendViaProviders?: boolean;
    transportUrls?: string[];
    providers?: readonly HotReloadProvider[];
    allowRootLevelStem?: boolean;
    /** 双名称解析脚本根(注入 defaultHotfix.resolveScriptRoot;缺省不注入=回落包扫描) */
    hotfixScriptRoot?: string;
    /** 包边界探针命中目录(注入 defaultHotfix.isPackageDir) */
    hotfixPackageDirs?: Set<string>;
  } = {}): { clock: ReturnType<typeof makeTimers>; fireChange: (fsPath: string) => void } => {
    configurationOverrides.set('kbengine', {
      hotReload: {
        enabled: true,
        globs: ['**/*.py'],
        actionName: '',
        debounceMs: 100,
        syntaxGate: true,
        ...(options.sendViaProviders === undefined ? {} : { sendViaProviders: options.sendViaProviders }),
        ...(options.allowRootLevelStem === undefined ? {} : { allowRootLevelStem: options.allowRootLevelStem })
      }
    });
    statusCalls.length = 0;
    const clock = makeTimers();
    const context = makeContext();
    contexts.push(context);
    setupHotReload(context, () => undefined, {
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
      pipelineFaces: {
        readSnapshot: async () => ({ hash: 'hash-a', content: 'a = 1' }),
        syntaxCheck: async () => ({ ok: true })
      },
      ...(options.transportUrls
        ? {
            defaultHotfix: {
              transport: request => {
                options.transportUrls?.push(request.url);
                return Promise.resolve({ ok: true, status: 200, durationMs: 1, body: 'ok' });
              },
              ...(options.hotfixScriptRoot ? { resolveScriptRoot: () => options.hotfixScriptRoot } : {}),
              ...(options.hotfixPackageDirs
                ? { isPackageDir: (dir: string) => (options.hotfixPackageDirs as Set<string>).has(dir) }
                : {}),
              // 生产同口径:读 hotReload 段容忍面(HR-MOD-008 配置开→flag 流进发送)
              resolveAllowRootLevelStem: () =>
                readHotReloadSettings(hotReloadSectionReader()).allowRootLevelStem
            }
          }
        : {}),
      ...(options.providers ? { hotReloadProviders: options.providers } : {})
    });
    const saveWatcher = allFileSystemWatchers[allFileSystemWatchers.length - 1];
    return {
      clock,
      fireChange: (fsPath: string) => saveWatcher.fireChange({ fsPath } as never)
    };
  };

  const makeProvider = (overrides: Partial<HotReloadProvider> = {}): HotReloadProvider => ({
    providerId: 'fork-test',
    apiVersion: HOT_RELOAD_PLUGIN_API_VERSION,
    displayName: 'Fork test provider',
    canSend: () => true,
    send: () => ({ ok: true }),
    ...overrides
  });

  it('键开+注入实现:provider 接单(文件如实),默认热更 transport 不被调', async () => {
    const urls: string[] = [];
    const sends: string[][] = [];
    const { clock, fireChange } = boot({
      sendViaProviders: true,
      transportUrls: urls,
      providers: [
        makeProvider({
          send: request => {
            sends.push([...request.files]);
            return { ok: true, detail: 'fork channel ok' };
          }
        })
      ]
    });
    fireChange('/ws/scripts/A.py');
    expect(clock.tick()).toBe(2);
    await flush();
    expect(clock.tick()).toBe(1);
    await flush();
    expect(sends).toEqual([['/ws/scripts/A.py']]);
    expect(urls).toHaveLength(0); // 默认热更面未被调
    expect(statusCalls.some(line => line.includes('provider:fork-test'))).toBe(true);
  });

  it('键开+实现失败:指纹撤回(HR-WATCH-008 协同),同内容再定稿再次接单', async () => {
    const sends: string[][] = [];
    const { clock, fireChange } = boot({
      sendViaProviders: true,
      providers: [
        makeProvider({
          send: request => {
            sends.push([...request.files]);
            return { ok: false, detail: 'fork channel down' };
          }
        })
      ]
    });
    fireChange('/ws/scripts/A.py');
    expect(clock.tick()).toBe(2);
    await flush();
    expect(clock.tick()).toBe(1);
    await flush();
    expect(sends).toHaveLength(1);
    expect(statusCalls.some(line => line.includes('fork channel down'))).toBe(true);
    fireChange('/ws/scripts/A.py'); // 同内容(同 hash)再定稿:失败已撤指纹
    expect(clock.tick()).toBe(2);
    await flush();
    expect(clock.tick()).toBe(1);
    await flush();
    expect(sends).toHaveLength(2); // 不因一次失败永久跳过
  });

  it('键开+实现抛异常:状态如实 failed,审计失败行落地', async () => {
    const { clock, fireChange } = boot({
      sendViaProviders: true,
      providers: [
        makeProvider({
          send: () => {
            throw new Error('fork channel exploded');
          }
        })
      ]
    });
    fireChange('/ws/scripts/A.py');
    expect(clock.tick()).toBe(2);
    await flush();
    expect(clock.tick()).toBe(1);
    await flush();
    expect(statusCalls.some(line => line.includes('fork channel exploded'))).toBe(true);
    expect(statusCalls.some(line => line.includes('失败'))).toBe(true);
  });

  it('键关(默认)+注入实现:面不进链,默认热更 transport 照常被调', async () => {
    const urls: string[] = [];
    const sends: string[][] = [];
    const { clock, fireChange } = boot({
      transportUrls: urls,
      providers: [
        makeProvider({
          send: request => {
            sends.push([...request.files]);
            return { ok: true };
          }
        })
      ]
    });
    fireChange('/ws/scripts/A.py');
    expect(clock.tick()).toBe(2);
    await flush();
    expect(clock.tick()).toBe(1);
    await flush();
    expect(sends).toHaveLength(0); // provider 未被问
    expect(urls).toHaveLength(1); // 默认热更面照常
    expect(statusCalls.some(line => line.includes('provider:'))).toBe(false);
  });

  it('HR-MOD-008 接线:allowRootLevelStem 配置开=根直下文件裸短名;缺省=默认拒走包边界扫描', async () => {
    const bootCase = async (allowRootLevelStem: boolean | undefined): Promise<string[]> => {
      const urls: string[] = [];
      const { clock, fireChange } = boot({
        transportUrls: urls,
        hotfixScriptRoot: '/ws/scripts',
        // scripts 目录带 __init__.py:包边界扫描会收 scripts 段——正是默认
        // 拒回落形态与本键裸短名形态的可观测分界
        hotfixPackageDirs: new Set(['/ws/scripts']),
        ...(allowRootLevelStem === undefined ? {} : { allowRootLevelStem })
      });
      fireChange('/ws/scripts/Lone.py');
      expect(clock.tick()).toBe(2);
      await flush();
      expect(clock.tick()).toBe(1);
      await flush();
      return urls;
    };
    // 缺省(未配):root-level 拒 → 包边界扫描收 scripts 段(收得下却重载不到)
    const defaultUrls = await bootCase(undefined);
    expect(defaultUrls.some(url => url.includes('module_name=scripts.Lone'))).toBe(true);
    // 配置开:双名称面直接裸短名(=进程根直下文件 sys.modules 形态)
    const enabledUrls = await bootCase(true);
    expect(enabledUrls.some(url => url.includes('module_name=Lone'))).toBe(true);
  });

  it('键开+注入实现不应答:内置实现按注册序接单(fork 专属优先,内置兜底序)', async () => {
    const urls: string[] = [];
    const forkSends: string[][] = [];
    const { clock, fireChange } = boot({
      sendViaProviders: true,
      transportUrls: urls,
      providers: [
        makeProvider({
          canSend: () => false,
          send: request => {
            forkSends.push([...request.files]);
            return { ok: true };
          }
        })
      ]
    });
    fireChange('/ws/scripts/A.py');
    expect(clock.tick()).toBe(2);
    await flush();
    expect(clock.tick()).toBe(1);
    await flush();
    expect(forkSends).toHaveLength(0); // 注入实现不应答,未被强派
    expect(urls).toHaveLength(1); // 内置实现接单,委托默认 transport
    expect(statusCalls.some(line => line.includes('provider:kbengine.http-hotfix'))).toBe(true);
  });

  it('键开+内置实现(defaultHotfix 面):fork 侧具体实现接上注册表并接单', async () => {
    const urls: string[] = [];
    const { clock, fireChange } = boot({ sendViaProviders: true, transportUrls: urls });
    fireChange('/ws/scripts/A.py');
    expect(clock.tick()).toBe(2);
    await flush();
    expect(clock.tick()).toBe(1);
    await flush();
    expect(urls).toHaveLength(1); // 经内置 provider 委托默认 transport
    expect(urls[0]).toContain('module_name=A'); // transport-faithful 同源请求
    expect(statusCalls.some(line => line.includes('provider:kbengine.http-hotfix'))).toBe(true);
  });

  it('重复 id 注入:注册如实拒上日志,先注册者应答', async () => {
    const sends: string[][] = [];
    const { clock, fireChange } = boot({
      sendViaProviders: true,
      providers: [
        makeProvider({
          providerId: 'fork-x',
          send: request => {
            sends.push(['first', ...request.files]);
            return { ok: true };
          }
        }),
        makeProvider({
          providerId: 'fork-x',
          send: request => {
            sends.push(['second', ...request.files]);
            return { ok: true };
          }
        })
      ]
    });
    expect(statusCalls.some(line => line.includes('注册被拒') && line.includes('duplicate-id'))).toBe(true);
    fireChange('/ws/scripts/A.py');
    expect(clock.tick()).toBe(2);
    await flush();
    expect(clock.tick()).toBe(1);
    await flush();
    expect(sends).toEqual([['first', '/ws/scripts/A.py']]); // 先注册者胜
  });

  it('apiVersion 不符注入:注册如实拒上日志,注入实现不被收编不被问', async () => {
    const urls: string[] = [];
    const badSends: string[][] = [];
    const { clock, fireChange } = boot({
      sendViaProviders: true,
      transportUrls: urls,
      providers: [
        makeProvider({
          apiVersion: '2' as never,
          send: request => {
            badSends.push([...request.files]);
            return { ok: true };
          }
        })
      ]
    });
    expect(statusCalls.some(line => line.includes('注册被拒') && line.includes('api-version-mismatch'))).toBe(true);
    fireChange('/ws/scripts/A.py');
    expect(clock.tick()).toBe(2);
    await flush();
    expect(clock.tick()).toBe(1);
    await flush();
    expect(badSends).toHaveLength(0); // 未收编,绝不被派单
    expect(urls).toHaveLength(1); // 内置实现照常应答
    expect(statusCalls.some(line => line.includes('provider:fork-test'))).toBe(false);
  });
});
