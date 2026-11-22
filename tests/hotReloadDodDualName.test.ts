// RUST-440（旧 HR-DOD-001）双名发送面收口（用户 2026-11-23 裁定「限定双名发送面收口」）。
//
// 场景=书 §19.1 的 FightAI 示例:`scripts/entities/fight/FightAI.py` 在脚本根
// `scripts` 下的三级路径。双名称口径(src/backend/hotReloadModuleIdentity.ts:31-34):
//   fullModule  = UI 展示名 = entities.fight.FightAI
//   requestModule = 实际发送名 = fight.FightAI
// 本门钉 DOD-001 的两半:①自动模式(sendViaProviders 键开,发送 provider 生命周期
// 槽 resolveModule→prepareRequest 逐文件解析)线上**只**携带 requestModule——
// 短名进 HTTP module_name,展示名不上线路;②UI 面(历史树标题/tooltip)用同一
// 解析核的 fullModule 呈现展示名,发送名以 requestModule 行并列。
//
// 诚实边界(裁定所定,不越界):本车道只收口「双名发送面」=sendViaProviders 键开
// 路径。零配置默认热更(键关)的 `${module}` 保持既有 legacy __init__.py 包边界
// 语义(HR-AUDIT-004/RUST-322 兼容裁定)——未配脚本根时生命周期解析不到根,
// provider 请求形状与增量前逐字一致(不带 moduleIdentities,逐文件自推),
// 双名收口不漂移零配置行为。解析不出的文件(无根/歧义/非 py/__init__)该文件走
// 既有推导面(moduleIdentities 空串=视同未给,HR-HTTP-002),不因收口而丢文件。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';

import {
  hotReloadSectionReader,
  readHotReloadSettings,
  setupHotReload,
  type HotReloadTimerDeps
} from '../src/hotReload';
import {
  HOT_RELOAD_PLUGIN_API_VERSION,
  type HotReloadProvider,
  type HotReloadProviderSendRequest
} from '../src/backend/hotReloadPluginApi';
import { resolveModuleDualName } from '../src/backend/hotReloadTempEdit';
import {
  buildHistoryEntryLabel,
  buildHistoryEntryTooltipLines,
  type HotReloadHistoryEntry
} from '../src/backend/hotReloadHistoryCore';
import { allFileSystemWatchers, configurationOverrides } from './helpers/vscodeStub';

// 书 §19.1 示例:DOD-001 场景用的路径与两个名字
const SCRIPT_ROOT = '/ws/scripts';
const FIGHT_AI = `${SCRIPT_ROOT}/entities/fight/FightAI.py`;
const FULL_MODULE = 'entities.fight.FightAI'; // UI 展示名
const REQUEST_MODULE = 'fight.FightAI'; // 实际发送名

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

describe('RUST-440 DOD-001:双名发送面收口(FightAI 场景)', () => {
  let workspaceFoldersBackup: typeof vscode.workspace.workspaceFolders;
  const contexts: vscode.ExtensionContext[] = [];
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
    contexts.length = 0;
    vscode.workspace.workspaceFolders = workspaceFoldersBackup;
    configurationOverrides.clear();
    allFileSystemWatchers.length = 0;
  });

  const boot = (options: {
    sendViaProviders?: boolean;
    /** 线上 URL 捕获(内置 provider 的 transport;默认热更面同口) */
    transportUrls?: string[];
    /** fork 侧注入实现(在前应答) */
    providers?: readonly HotReloadProvider[];
    /** 双名称解析脚本根(注入 defaultHotfix.resolveScriptRoot);缺省=未配 */
    hotfixScriptRoot?: string;
    /** 包边界探针命中目录(legacy ${module} 推导面) */
    hotfixPackageDirs?: Set<string>;
  } = {}): { clock: ReturnType<typeof makeTimers>; fireChange: (fsPath: string) => void } => {
    configurationOverrides.set('kbengine', {
      hotReload: {
        enabled: true,
        globs: ['**/*.py'],
        actionName: '',
        debounceMs: 100,
        syntaxGate: true,
        ...(options.sendViaProviders === undefined ? {} : { sendViaProviders: options.sendViaProviders })
      }
    });
    statusCalls.length = 0;
    const clock = makeTimers();
    const context = ({ subscriptions: [] }) as unknown as vscode.ExtensionContext;
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
        readSnapshot: async () => ({ hash: 'hash-fight', content: 'class FightAI:\n    pass\n' }),
        syntaxCheck: async () => ({ ok: true })
      },
      // 生产装配恒有 defaultHotfix(activate/hotReload.ts:532)——脚本根经它的
      // resolveScriptRoot 进发送面,缺它双名解析取不到根。未给 transport=
      // 内置 provider canSend 如实不应答,应答者仍是被测实现。
      defaultHotfix: {
        ...(options.transportUrls
          ? {
              transport: request => {
                options.transportUrls?.push(request.url);
                return Promise.resolve({ ok: true, status: 200, durationMs: 1, body: 'ok' });
              }
            }
          : {}),
        ...(options.hotfixScriptRoot ? { resolveScriptRoot: () => options.hotfixScriptRoot } : {}),
        ...(options.hotfixPackageDirs
          ? { isPackageDir: (dir: string) => (options.hotfixPackageDirs as Set<string>).has(dir) }
          : {}),
        // 生产同口径:读 hotReload 段容忍面
        resolveAllowRootLevelStem: () => readHotReloadSettings(hotReloadSectionReader()).allowRootLevelStem
      },
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

  it('自动模式经生命周期槽上线短名:provider 请求逐文件 moduleIdentities=fight.FightAI(发送名)', async () => {
    const requests: HotReloadProviderSendRequest[] = [];
    const { clock, fireChange } = boot({
      sendViaProviders: true,
      hotfixScriptRoot: SCRIPT_ROOT,
      providers: [
        makeProvider({
          send: request => {
            requests.push(request);
            return { ok: true };
          }
        })
      ]
    });
    fireChange(FIGHT_AI);
    expect(clock.tick()).toBe(2);
    await flush();
    expect(clock.tick()).toBe(1);
    await flush();
    expect(requests).toHaveLength(1);
    expect(requests[0].files).toEqual([FIGHT_AI]);
    // 双名发送面:实际发送名=短名,UI 展示名不上线路
    expect(requests[0].moduleIdentities).toEqual([REQUEST_MODULE]);
  });

  it('端到端经内置 provider:HTTP module_name 只携短名,展示名不上线路', async () => {
    const urls: string[] = [];
    const { clock, fireChange } = boot({
      sendViaProviders: true,
      transportUrls: urls,
      hotfixScriptRoot: SCRIPT_ROOT,
      // entities/ 与 entities/fight/ 各带 __init__.py:legacy ${module} 推导面会
      // 给出全名 entities.fight.FightAI——正是「展示名误当发送名」的旧形状,
      // 双名收口后线路不得再出现它
      hotfixPackageDirs: new Set([`${SCRIPT_ROOT}/entities`, `${SCRIPT_ROOT}/entities/fight`])
    });
    fireChange(FIGHT_AI);
    expect(clock.tick()).toBe(2);
    await flush();
    expect(clock.tick()).toBe(1);
    await flush();
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain(`module_name=${REQUEST_MODULE}`);
    expect(urls[0]).not.toContain(`module_name=${FULL_MODULE}`);
  });

  it('UI 面用同一解析核的展示名:历史标题=entities.fight.FightAI,发送名以 requestModule 行并列', () => {
    // 生产同一解析面(activate/hotReload.ts:101 resolveHotReloadModuleNames):
    // 脚本根可解→双名;不可解→undefined 如实不写(不回落 stem 冒充包结构)
    const dualName = resolveModuleDualName(FIGHT_AI, SCRIPT_ROOT);
    expect(dualName).not.toHaveProperty('unsupported');
    const { fullModule, requestModule } = dualName as { fullModule: string; requestModule: string };
    expect({ fullModule, requestModule }).toEqual({ fullModule: FULL_MODULE, requestModule: REQUEST_MODULE });

    const entry: HotReloadHistoryEntry = {
      requestId: 'req-fight',
      fullModule,
      requestModule,
      fileUri: FIGHT_AI,
      targetId: '',
      time: 1_000,
      status: 'sent-unverified'
    };
    // 树节点标题=展示名(DOD-001 后半:UI 展示 entities.fight.FightAI)
    expect(buildHistoryEntryLabel(entry)).toBe(FULL_MODULE);
    // tooltip 双名并列:发送名单独一行,展示名作 module 行
    const lines = buildHistoryEntryTooltipLines(entry);
    expect(lines).toContain(`requestModule: ${REQUEST_MODULE}`);
    expect(lines).toContain(`module: ${FULL_MODULE}`);
    expect(lines.some(line => line === `requestModule: ${FULL_MODULE}`)).toBe(false);
  });

  it('零配置零漂移:未配脚本根=生命周期解析不到根,provider 请求形状与增量前一致', async () => {
    const requests: HotReloadProviderSendRequest[] = [];
    const { clock, fireChange } = boot({
      sendViaProviders: true,
      // 不注入 hotfixScriptRoot:零配置(未配 kbengine.hotReload.tempEdit.scriptRoot)
      providers: [
        makeProvider({
          send: request => {
            requests.push(request);
            return { ok: true };
          }
        })
      ]
    });
    fireChange(FIGHT_AI);
    expect(clock.tick()).toBe(2);
    await flush();
    expect(clock.tick()).toBe(1);
    await flush();
    expect(requests).toHaveLength(1);
    // 文件不丢,形状不漂移:双名收口未激活时与增量前逐字一致(逐文件自推)
    expect(requests[0].files).toEqual([FIGHT_AI]);
    expect('moduleIdentities' in requests[0]).toBe(false);
  });
});