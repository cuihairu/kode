/**
 * RUST-426(HR-QA-014)插件 load test + 崩溃隔离:
 * - 0/5/20 个插件(provider)分别注册→注册数如实、应答序先到先应答、清册不半态;
 * - 解析成本有界(应答即短路不问后续;全不应答恰 N 次,无隐藏重试/无重复询问)
 *   ——结构性负载界,非墙钟竞速(时序断言是本仓已知负载抖动族,不设紧预算);
 * - 插件崩溃不影响核心与主线程:canSend 抛异常的插件只隔离自己(如实上报后
 *   跳过,继续问后续),send 抛异常/拒绝经核心如实落 failed 不污染注册表,
 *   崩溃插件注册关系不受损、dispose 照常清册、宿主可重建。
 */

import { describe, expect, it } from 'vitest';
import {
  buildEngineProfile,
  HOT_RELOAD_PLUGIN_API_VERSION,
  HotReloadProviderRegistry,
  type HotReloadProvider,
  type HotReloadProviderCrash
} from '../src/backend/hotReloadPluginApi';
import { createHotReloadProviderHost } from '../src/backend/hotReloadProviderAssembly';

const PROFILE = buildEngineProfile({});

const makeProvider = (
  id: string,
  answers: boolean,
  overrides: Partial<HotReloadProvider> = {}
): HotReloadProvider => ({
  providerId: id,
  apiVersion: HOT_RELOAD_PLUGIN_API_VERSION,
  displayName: id,
  canSend: () => answers,
  send: () => ({ ok: true }),
  ...overrides
});

describe('RUST-426 插件 load test(0/5/20 个)', () => {
  it('0/5/20 插件注册:注册数如实、应答序先到先应答、dispose 清册不半态', () => {
    for (const count of [0, 5, 20]) {
      // 第 2 个(下标 1)应答,其余不应答——验证先到先应答且不因规模漂移
      const providers = Array.from({ length: count }, (_, i) => makeProvider(`p${i}`, i === 1));
      const host = createHotReloadProviderHost({ providers });
      expect(host.registry.registeredSendProviderIds()).toHaveLength(count);
      if (count === 0) {
        expect(host.registry.resolveSendProvider(PROFILE)).toBeNull();
      } else {
        expect(host.registry.resolveSendProvider(PROFILE)?.providerId).toBe('p1');
      }
      // 清册:dispose 后自省空、解析 null(不半态,不残留崩溃/应答者)
      host.dispose();
      expect(host.registry.registeredSendProviderIds()).toHaveLength(0);
      expect(host.registry.resolveSendProvider(PROFILE)).toBeNull();
    }
  });

  it('load:解析成本有界——应答即短路不问后续;全不应答恰走 N 次(线性无隐藏重试)', () => {
    const registry = new HotReloadProviderRegistry();
    const asked: string[] = [];
    registry.registerSendProvider(
      makeProvider('a', true, {
        canSend: () => {
          asked.push('a');
          return true;
        }
      })
    );
    registry.registerSendProvider(
      makeProvider('b', true, {
        canSend: () => {
          asked.push('b');
          return true;
        }
      })
    );
    expect(registry.resolveSendProvider(PROFILE)?.providerId).toBe('a');
    // 短路:第一个应答者胜,后续不再被问(20 插件规模不会重复询问)
    expect(asked).toEqual(['a']);
    // 全不应答:恰 N 次线性(每个注册插件恰被问一次,无 O(N²)/隐藏重试)
    const registry2 = new HotReloadProviderRegistry();
    const asked2: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      registry2.registerSendProvider(
        makeProvider(`p${i}`, false, {
          canSend: () => {
            asked2.push(`p${i}`);
            return false;
          }
        })
      );
    }
    expect(registry2.resolveSendProvider(PROFILE)).toBeNull();
    expect(asked2).toHaveLength(20);
    expect(new Set(asked2).size).toBe(20);
  });

  it('load:20 插件规模扫描无病理增长(宽松墙钟反回归,非竞速门)', () => {
    const started = performance.now();
    for (let round = 0; round < 50; round += 1) {
      const host = createHotReloadProviderHost({
        providers: Array.from({ length: 20 }, (_, i) => makeProvider(`p${i}`, i === round % 20))
      });
      expect(host.registry.resolveSendProvider(PROFILE)).not.toBeNull();
      host.dispose();
    }
    // 50 轮 × 20 注册/解析 + 50 次 dispose 全部在宽松预算内(纯内存 map 迭代,
    // 微秒级;预算只为抓病理级退路/死循环,不设紧界防负载抖动族误伤)
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('RUST-426 插件崩溃不影响核心与主线程', () => {
  it('canSend 抛异常:只隔离该插件并如实上报,后续插件照常应答,不打断解析', () => {
    const crashes: HotReloadProviderCrash[] = [];
    const host = createHotReloadProviderHost({
      providers: [
        makeProvider('bad', true, {
          canSend: () => {
            throw new Error('plugin exploded');
          }
        }),
        makeProvider('good', true)
      ],
      onProviderCrash: crash => void crashes.push(crash)
    });
    const resolved = host.registry.resolveSendProvider(PROFILE);
    // 崩溃插件被隔离跳过,好插件照常应答——核心不受影响
    expect(resolved?.providerId).toBe('good');
    // 崩溃如实上报(不静默吞),阶段与原因可审
    expect(crashes).toHaveLength(1);
    expect(crashes[0]).toMatchObject({ providerId: 'bad', stage: 'canSend' });
    // 崩溃插件的注册关系不受损,清册仍能一次清空
    expect(host.registry.registeredSendProviderIds()).toHaveLength(2);
    host.dispose();
    expect(host.registry.registeredSendProviderIds()).toHaveLength(0);
  });

  it('无上报面注入时隔离照常生效(缺省不炸,好插件仍应答)', () => {
    const host = createHotReloadProviderHost({
      providers: [
        makeProvider('bad', true, {
          canSend: () => {
            throw new Error('boom');
          }
        }),
        makeProvider('good', true)
      ]
    });
    expect(host.registry.resolveSendProvider(PROFILE)?.providerId).toBe('good');
  });

  it('多个崩溃插件:逐个隔离跳过,最末好插件仍应答,崩溃全数如实上报', () => {
    const crashes: HotReloadProviderCrash[] = [];
    const host = createHotReloadProviderHost({
      providers: [
        makeProvider('bad1', true, {
          canSend: () => {
            throw new Error('boom1');
          }
        }),
        makeProvider('bad2', true, {
          canSend: () => {
            throw new Error('boom2');
          }
        }),
        makeProvider('good', true)
      ],
      onProviderCrash: crash => void crashes.push(crash)
    });
    expect(host.registry.resolveSendProvider(PROFILE)?.providerId).toBe('good');
    expect(crashes.map(c => c.providerId)).toEqual(['bad1', 'bad2']);
  });

  it('send 抛异常/拒绝:经核心如实落失败,注册表不受污染,后续解析照常', async () => {
    const host = createHotReloadProviderHost({
      providers: [
        makeProvider('thrower', true, {
          send: () => {
            throw new Error('send exploded');
          }
        }),
        makeProvider('rejecter', true, {
          send: () => Promise.reject(new Error('send rejected'))
        })
      ]
    });
    // 同步抛:如实拒绝(不静默成功,不产生未处理拒绝)
    const thrower = host.registry.resolveSendProvider(PROFILE);
    expect(thrower?.providerId).toBe('thrower');
    await expect(Promise.resolve().then(() => thrower!.send({ targetId: 't', files: [] }))).rejects.toThrow(
      'send exploded'
    );
    // 异步拒绝:同口径如实拒绝
    const rejecterHost = createHotReloadProviderHost({
      providers: [
        makeProvider('rejecter', true, {
          send: () => Promise.reject(new Error('send rejected'))
        })
      ]
    });
    const rejecter = rejecterHost.registry.resolveSendProvider(PROFILE);
    expect(rejecter?.providerId).toBe('rejecter');
    await expect(Promise.resolve(rejecter!.send({ targetId: 't', files: [] }))).rejects.toThrow('send rejected');
    // 核心未受污染:清册完好、dispose 照常
    expect(host.registry.registeredSendProviderIds()).toHaveLength(2);
    host.dispose();
    expect(host.registry.registeredSendProviderIds()).toHaveLength(0);
    rejecterHost.dispose();
    expect(rejecterHost.registry.registeredSendProviderIds()).toHaveLength(0);
  });

  it('崩溃插件不半态:宿主可重建,新宿主解析照常', () => {
    const host = createHotReloadProviderHost({
      providers: [
        makeProvider('bad', true, {
          canSend: () => {
            throw new Error('x');
          }
        })
      ]
    });
    host.dispose();
    const rebuilt = createHotReloadProviderHost({ providers: [makeProvider('ok', true)] });
    expect(rebuilt.registry.resolveSendProvider(PROFILE)?.providerId).toBe('ok');
  });
});
