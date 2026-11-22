import { describe, expect, it } from 'vitest';
import {
  buildEngineProfile,
  HOT_RELOAD_PLUGIN_API_VERSION,
  HotReloadProviderRegistry,
  type HotReloadProvider,
  type HotReloadProviderError
} from '../src/backend/hotReloadPluginApi';
import { createHotReloadProviderHost } from '../src/backend/hotReloadProviderAssembly';

// RUST-426(HR-QA-014):热更新插件 0/5/20 个分别做 load test,插件崩溃不影响
// 核心与主线程。
//   * 0/5/20 数量面:解析正确性(第一个 canSend 应答者胜/注册序保持/无人应
//     答 null/dispose 清全册)在 0/5/20 档全部成立;
//   * 成本模型(load scaling):resolve 的 canSend 调用数=首应答者位置(首答
//     应早=不全量扫,20 全不应答=逐个问完),无 O(n²)/无「答早也扫全」回退
//     ——插件数线性加在「首应答前的问询」,非整册重扫;
//   * 崩溃隔离(canSend):任一位(首/中/末)canSend 抛错的插件被如实上报
//     (onProviderError)并跳过,解析继续问下一个应答者,绝不向调用方传播
//     (核心/主线程不被打断);全员崩溃=如实 null+逐条上报;
//   * 崩溃隔离(send):发送编排 Promise 工厂模式(同步抛错也落拒绝分支)在
//     插件 send 抛错时不向核心传播(与 hotReload.ts runViaProvider 同形);
//   * 装配面接线:createHotReloadProviderHost 把 onProviderError 透传进注册表。
// 注:每次 resolve 只调一次(canSend 有副作用=计数/上报,双调会把上报翻倍)。

const profile = buildEngineProfile({});

const makeProvider = (id: string): HotReloadProvider => ({
  providerId: id,
  apiVersion: HOT_RELOAD_PLUGIN_API_VERSION,
  displayName: `provider-${id}`,
  canSend: () => true,
  send: () => ({ ok: true })
});

type ProbeProvider = HotReloadProvider & { count: { value: number } };

/** 可数 canSend 调用 + 可编程应答/崩溃的夹具(count 挂在返回值上供断言) */
const makeProbe = (
  id: string,
  opts: { responds?: boolean; crash?: Error } = {}
): ProbeProvider => {
  const responds = opts.responds ?? true;
  const probe: ProbeProvider = {
    providerId: id,
    apiVersion: HOT_RELOAD_PLUGIN_API_VERSION,
    displayName: `probe-${id}`,
    count: { value: 0 },
    canSend: () => {
      probe.count.value += 1;
      if (opts.crash) {
        throw opts.crash;
      }
      return responds;
    },
    send: () => ({ ok: true })
  };
  return probe;
};

/** 单次解析(canSend 有副作用,双调会把计数/上报翻倍):不抛+取回结果 */
const resolveOnce = (registry: HotReloadProviderRegistry): HotReloadProvider | null => {
  let resolved: HotReloadProvider | null = null;
  expect(() => {
    resolved = registry.resolveSendProvider(profile);
  }).not.toThrow();
  return resolved;
};

describe('RUST-426 插件 0/5/20 load test:数量面解析正确性', () => {
  it('0 插件:resolve 如实 null(不回落默认)', () => {
    const registry = new HotReloadProviderRegistry();
    expect(registry.registeredSendProviderIds()).toEqual([]);
    expect(resolveOnce(registry)).toBeNull();
  });

  it('5 插件:第一个 canSend 应答者胜,注册序保持,成本=首应答位置', () => {
    const registry = new HotReloadProviderRegistry();
    const a = makeProbe('a', { responds: false });
    const b = makeProbe('b', { responds: false });
    const c = makeProbe('c', { responds: true });
    const d = makeProbe('d', { responds: true });
    const e = makeProbe('e');
    for (const p of [a, b, c, d, e]) {
      registry.registerSendProvider(p);
    }
    expect(registry.registeredSendProviderIds()).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(resolveOnce(registry)?.providerId).toBe('c');
    // 首应答前逐个问(c 是第 3 个),应答后不再多问——成本=首应答位置
    expect(a.count.value).toBe(1);
    expect(b.count.value).toBe(1);
    expect(c.count.value).toBe(1);
    expect(d.count.value).toBe(0);
    expect(e.count.value).toBe(0);
  });

  it('20 插件:全部不应答=逐个问完如实 null(线性成本,每家恰好 1 次)', () => {
    const registry = new HotReloadProviderRegistry();
    const probes: ProbeProvider[] = [];
    for (let i = 0; i < 20; i += 1) {
      const p = makeProbe(`p${i}`, { responds: false });
      probes.push(p);
      registry.registerSendProvider(p);
    }
    expect(registry.registeredSendProviderIds()).toHaveLength(20);
    expect(resolveOnce(registry)).toBeNull();
    for (const p of probes) {
      expect(p.count.value).toBe(1);
    }
  });

  it('20 插件:第 3 位应答者胜,其后 17 家未被问(成本=位置非全册)', () => {
    const registry = new HotReloadProviderRegistry();
    const probes: ProbeProvider[] = [];
    for (let i = 0; i < 20; i += 1) {
      const p = makeProbe(`p${i}`, { responds: i === 2 });
      probes.push(p);
      registry.registerSendProvider(p);
    }
    expect(resolveOnce(registry)?.providerId).toBe('p2');
    for (let i = 0; i < 3; i += 1) {
      expect(probes[i].count.value).toBe(1);
    }
    for (let i = 3; i < 20; i += 1) {
      expect(probes[i].count.value).toBe(0);
    }
  });

  it('dispose(clear)清全册:20 插件清后 0,重注册即重建不半态', () => {
    const host = createHotReloadProviderHost({
      providers: Array.from({ length: 20 }, (_, i) => makeProvider(`p${i}`))
    });
    expect(host.registry.registeredSendProviderIds()).toHaveLength(20);
    host.dispose();
    expect(host.registry.registeredSendProviderIds()).toEqual([]);
    expect(resolveOnce(host.registry)).toBeNull();
  });
});

describe('RUST-426 插件崩溃隔离:canSend 抛错不向核心传播', () => {
  it('首位插件崩溃:跳过+上报+继续问下一个应答者,不抛', () => {
    const reported: HotReloadProviderError[] = [];
    const registry = new HotReloadProviderRegistry({ onProviderError: e => reported.push(e) });
    const boom = makeProbe('boom', { crash: new Error('boom-canSend') });
    const good = makeProbe('good', { responds: true });
    registry.registerSendProvider(boom);
    registry.registerSendProvider(good);
    expect(resolveOnce(registry)?.providerId).toBe('good');
    expect(reported).toHaveLength(1);
    expect(reported[0].providerId).toBe('boom');
    expect((reported[0].error as Error).message).toBe('boom-canSend');
    expect(boom.count.value).toBe(1);
  });

  it('崩溃插件在首应答者之后:未被问(成本=位置语义),无上报', () => {
    const reported: HotReloadProviderError[] = [];
    const registry = new HotReloadProviderRegistry({ onProviderError: e => reported.push(e) });
    const good0 = makeProbe('good0');
    const boom1 = makeProbe('boom1', { crash: new Error('boom-mid') });
    const boom2 = makeProbe('boom2', { crash: new Error('boom-last') });
    registry.registerSendProvider(good0);
    registry.registerSendProvider(boom1);
    registry.registerSendProvider(boom2);
    expect(resolveOnce(registry)?.providerId).toBe('good0');
    expect(reported).toEqual([]);
    expect(boom1.count.value).toBe(0);
    expect(boom2.count.value).toBe(0);
  });

  it('崩溃插件在应答位之前:上报+跳过+后继应答者胜(多崩溃逐条上报)', () => {
    const reported: HotReloadProviderError[] = [];
    const registry = new HotReloadProviderRegistry({ onProviderError: e => reported.push(e) });
    registry.registerSendProvider(makeProbe('boom0', { crash: new Error('boom-first') }));
    registry.registerSendProvider(makeProbe('good1', { responds: false }));
    registry.registerSendProvider(makeProbe('boom2', { crash: new Error('boom-second') }));
    registry.registerSendProvider(makeProbe('good3', { responds: true }));
    expect(resolveOnce(registry)?.providerId).toBe('good3');
    expect(reported).toHaveLength(2);
    expect(reported.map(r => r.providerId)).toEqual(['boom0', 'boom2']);
    expect(reported.map(r => (r.error as Error).message)).toEqual(['boom-first', 'boom-second']);
  });

  it('全员崩溃=逐条上报+如实 null,不抛(不静默吞)', () => {
    const reported: HotReloadProviderError[] = [];
    const registry = new HotReloadProviderRegistry({ onProviderError: e => reported.push(e) });
    registry.registerSendProvider(makeProbe('boom0', { crash: new Error('x') }));
    registry.registerSendProvider(makeProbe('boom1', { crash: new Error('y') }));
    expect(resolveOnce(registry)).toBeNull();
    expect(reported).toHaveLength(2);
    expect(reported.map(r => r.providerId)).toEqual(['boom0', 'boom1']);
  });

  it('未接 onProviderError 的注册表:崩溃仍隔离(跳过不抛),仅无上报面', () => {
    const registry = new HotReloadProviderRegistry();
    registry.registerSendProvider(makeProbe('boom0', { crash: new Error('x') }));
    registry.registerSendProvider(makeProbe('good1', { responds: true }));
    expect(resolveOnce(registry)?.providerId).toBe('good1');
  });
});

describe('RUST-426 插件崩溃隔离:send 抛错不向核心传播(编排 Promise 工厂)', () => {
  it('同步抛错的 send 落拒绝分支(与 runViaProvider 同形),核心继续', async () => {
    const registry = new HotReloadProviderRegistry();
    registry.registerSendProvider({
      providerId: 'boom-send',
      apiVersion: HOT_RELOAD_PLUGIN_API_VERSION,
      displayName: 'boom-send',
      canSend: () => true,
      send: () => {
        throw new Error('boom-send');
      }
    });
    const provider = resolveOnce(registry);
    expect(provider?.providerId).toBe('boom-send');
    // 编排模式:Promise 工厂起调把同步抛错也落拒绝分支(不向调用方传播)
    let outcome: 'ok' | 'error' | 'none' = 'none';
    await Promise.resolve()
      .then(() => provider!.send({ targetId: '', files: [] }))
      .then(
        () => {
          outcome = 'ok';
        },
        () => {
          outcome = 'error';
        }
      );
    expect(outcome).toBe('error');
  });
});

describe('RUST-426 装配面接线:createHotReloadProviderHost 透传 onProviderError', () => {
  it('宿主把崩溃上报面接进注册表:插件崩溃经宿主上报', () => {
    const reported: HotReloadProviderError[] = [];
    const host = createHotReloadProviderHost({
      providers: [makeProbe('boom', { crash: new Error('host-crash') })],
      onProviderError: e => reported.push(e)
    });
    expect(resolveOnce(host.registry)).toBeNull();
    expect(reported).toHaveLength(1);
    expect(reported[0].providerId).toBe('boom');
    expect((reported[0].error as Error).message).toBe('host-crash');
  });
});
