import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { beforeEach, describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';

import { resolveActiveProfile, setActiveProfile } from '../src/activeProfile';
import { setupHotReload, type HotReloadTimerDeps } from '../src/hotReload';
import { HotReloadTargetStateStore } from '../src/backend/hotReloadTargetState';
import { resolveReloadTransport, type ReloadTransport } from '../src/backend/hotReloadTransport';
import { ProjectProfileStore } from '../src/projectProfiles';
import { channels, configurationOverrides, lastFileSystemWatcher } from './helpers/vscodeStub';

// KODE-HOT-001 验收:ReloadTransport 真接入 fire 路径——走生产同款 profile 链:
// ProjectProfileStore(workspaceState memento 持久化,读回经
// normalizeReloadChannelConfig 校验)→ setActiveProfile → resolveActiveProfile
// → resolveReloadTransport(extension.ts 真装配的同一解出口,见源锁测试)→
// setupHotReload fire 路径真实发送(HTTP 执行器/控制台连接为测试替身),
// 回执流直喂台账,闭环:配置选择/参数校验/回执/状态记录。
// (通道接线与桩通道回执映射由 hotReloadChannelWiring 覆盖;此处补「真实传输
// 实现走通 fire 路径 + 生产 profile 选择链」的端到端验收面。)

const digestOf = (content: string): string =>
  createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');

const makeTimers = (): { timers: HotReloadTimerDeps; tick: () => void } => {
  const handles = new Map<unknown, () => void>();
  return {
    tick: () => {
      const callbacks = [...handles.values()];
      handles.clear();
      for (const callback of callbacks) {
        callback();
      }
    },
    timers: {
      set: (callback): unknown => {
        const handle = handles.size;
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

/** workspaceState 的内存替身(与 tests/activeProfile.test.ts 同形) */
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

describe('fire 路径 × 真实传输实现 × 生产 profile 链端到端闭环(KODE-HOT-001)', () => {
  beforeEach(() => {
    configurationOverrides.clear();
    lastFileSystemWatcher.current = null;
    channels.length = 0;
  });

  const makeContext = (): vscode.ExtensionContext =>
    ({ subscriptions: [] }) as unknown as vscode.ExtensionContext;

  /**
   * 生产同款通道解出口(extension.ts resolveHotReloadChannelTransport 同构):
   * 活动 profile(workspaceState 持久化读回)配了 hotReload 段才解出通道,
   * 未配/段畸形返回 null。transportDeps 只替换 HTTP 执行器/控制台连接,
   * profile 选择、持久化读回与 normalize 校验全部走真实实现。
   */
  const fireViaActiveProfile = async (options: {
    hotReload: Record<string, unknown> | undefined;
    transportDeps: Parameters<typeof resolveReloadTransport>[1];
    readFileContent?: (file: string) => Promise<string | null>;
  }): Promise<{ store: HotReloadTargetStateStore; runCalls: string[]; targetId: string }> => {
    const clock = makeTimers();
    const store = new HotReloadTargetStateStore({ now: () => 7 });
    const runCalls: string[] = [];
    const memento = new MemoryMemento();
    const profileStore = new ProjectProfileStore(memento);
    const profile = await profileStore.create({
      displayName: 'engine-1',
      assetsRoot: '/ws',
      engineRoot: '/engine',
      ...(options.hotReload !== undefined ? { hotReload: options.hotReload } : {})
    } as never);
    await setActiveProfile(memento, profile.id);
    configurationOverrides.set('kbengine', {
      hotReload: { enabled: true, globs: ['**/*.py'], actionName: '热更', debounceMs: 100 }
    });
    // 生产装配的解出口(extension.ts resolveHotReloadChannelTransport 同构,
    // 源锁测试钉住真装配):profile 读回 → resolveReloadTransport 校验/建
    // 通道,targetId=profile.id(稳定身份,台账键用)
    const resolveChannelTransport = (): { transport: ReloadTransport; targetId: string } | null => {
      const activeProfile = resolveActiveProfile(memento);
      if (!activeProfile?.hotReload) {
        return null;
      }
      const transport = resolveReloadTransport(activeProfile.hotReload, options.transportDeps);
      return transport ? { transport, targetId: activeProfile.id } : null;
    };
    setupHotReload(makeContext(), name => void runCalls.push(name), {
      timers: clock.timers,
      resolveChannelTransport,
      targetState: {
        store,
        resolveTargetId: () => 't1',
        resolveRootId: () => '/ws',
        ...(options.readFileContent ? { readFileContent: options.readFileContent } : {})
      }
    });
    lastFileSystemWatcher.current!.fireChange({ fsPath: '/ws/avatar.py' } as never);
    clock.tick();
    await flush();
    return { store, runCalls, targetId: profile.id };
  };

  it('HTTP 通道真发:profile 持久化读回→通道解出→占位替换进请求→applied 双证核验落台账', async () => {
    const requests: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> = [];
    const content = 'print("hello engine")';
    const { store, runCalls, targetId } = await fireViaActiveProfile({
      hotReload: {
        channel: 'http',
        http: {
          name: 'engine-reload',
          url: 'http://10.0.0.8:32000/${targetId}/reload',
          method: 'POST',
          headers: { 'X-Kb-Target': '${targetId}' },
          body: '{"files":${files}}',
          enabled: true,
          keybinding: ''
        }
      },
      transportDeps: {
        http: {
          run: async request => {
            requests.push({ ...request });
            return {
              status: 200,
              body: JSON.stringify({ status: 'applied', file: '/ws/avatar.py', digest: digestOf(content) })
            };
          }
        }
      },
      readFileContent: async () => content
    });
    // 真发:一次 HTTP 请求,不走 runAction 回落
    expect(requests).toHaveLength(1);
    expect(runCalls).toEqual([]);
    // 占位替换:${targetId}=活动 profile 的稳定 ID 进 url/headers,${files} 进
    // body;JSON 对象体自动附带 targetId 与 sender_digests(冻结基准随报文下发)
    expect(requests[0].url).toBe(`http://10.0.0.8:32000/${targetId}/reload`);
    expect(requests[0].method).toBe('POST');
    expect(requests[0].headers['X-Kb-Target']).toBe(targetId);
    const body = JSON.parse(requests[0].body) as {
      files: string[];
      targetId: string;
      sender_digests: Record<string, string>;
    };
    expect(body.files).toEqual(['/ws/avatar.py']);
    expect(body.targetId).toBe(targetId);
    expect(body.sender_digests['/ws/avatar.py']).toBe(digestOf(content));
    // 回执/状态记录闭环:applied 回执 digest 与冻结基准一致 → 升格 applied
    const record = store.get({ rootId: '/ws', targetId }, '/ws/avatar.py');
    expect(record?.outcome).toBe('applied');
    expect(record?.sentDigest).toBe(digestOf(content));
    expect(record?.channel).toBe('http');
    expect(record?.source).toBe('watcher-auto');
  });

  it('kbengine-official 通道真发:控制台命令已发送,回执全 sent 绝不 claim applied', async () => {
    const commands: string[] = [];
    let disconnected = false;
    const { store, runCalls, targetId } = await fireViaActiveProfile({
      hotReload: {
        channel: 'kbengine-official',
        official: { host: '10.0.0.8', port: 31000, fullReload: true }
      },
      transportDeps: {
        official: {
          connect: () => ({
            connect: () => undefined,
            disconnect: () => {
              disconnected = true;
            },
            isReady: () => true,
            sendCommand: command => {
              commands.push(command);
              return true;
            },
            onData: () => undefined,
            onClose: () => undefined
          }),
          waitForReady: async () => true,
          awaitEchoMs: 0
        }
      },
      readFileContent: async () => 'print("x")'
    });
    // 真发:控制台连接建立、命令下发、连接释放
    expect(commands).toEqual(['KBEngine.reloadScript(True)']);
    expect(disconnected).toBe(true);
    expect(runCalls).toEqual([]);
    // 官方通道无回执协议:台账如实 sent-unverified,绝不 applied
    const record = store.get({ rootId: '/ws', targetId }, '/ws/avatar.py');
    expect(record?.outcome).toBe('sent-unverified');
    expect(record?.channel).toBe('kbengine-official');
    expect(record?.detail).toContain('KBEngine.reloadScript(True)');
  });

  it('参数校验闭环:profile 持久化读回时畸形 hotReload 段被判未配 → 回落 actionName', async () => {
    const { store, runCalls } = await fireViaActiveProfile({
      // channel=http 但缺 http 参数段:normalizeReloadChannelConfig 在持久化
      // 读回(projectProfiles.readProfiles)时如实判未配
      hotReload: { channel: 'http' },
      transportDeps: {}
    });
    expect(runCalls).toEqual(['热更']);
    const record = store.get({ rootId: '/ws', targetId: 't1' }, '/ws/avatar.py');
    expect(record?.outcome).toBe('sent-unverified');
    expect(record?.channel).toBe('actionName:热更');
  });

  it('源锁:装配层真装配经 resolveActiveProfile+resolveReloadTransport 解出通道,fire 与重试共用', () => {
    // SRC-001 L6:装配位自 extension.ts 迁 src/activate/hotReload.ts(纯移动),源锁跟随装配层。
    const source = readFileSync('src/extension.ts', 'utf8') + readFileSync('src/activate/hotReload.ts', 'utf8');
    expect(source).toContain('const transport = resolveReloadTransport(activeProfile.hotReload);');
    // 用户令 2026-11-10:无 profile/无 hotReload 段不再回落 actionName,走默认
    // http 通道(createDefaultHotReloadChannel 内置模板,targetId='default')
    expect(source).toContain('createDefaultHotReloadChannel()');
    expect(source).toContain("targetId: DEFAULT_CHANNEL_TARGET_ID");
    // fire 路径与失败目标重试共用同一解出口(setupHotReload 与 retry deps 各一处)
    expect(source.match(/resolveChannelTransport: resolveHotReloadChannelTransport/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
