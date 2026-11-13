import { describe, expect, it } from 'vitest';
import {
  createHotReloadProviderHost,
  createHttpHotfixSendProvider,
  KBENGINE_HTTP_HOTFIX_PROVIDER_ID
} from '../src/backend/hotReloadProviderAssembly';
import {
  buildEngineProfile,
  HOT_RELOAD_PLUGIN_API_VERSION,
  type HotReloadProvider
} from '../src/backend/hotReloadPluginApi';

// HR-PR-08 装配核钉:内置 fork 侧 HTTP hotfix provider(transport-faithful
// 委托 sendDefaultHotfix,零第二套发送语义)+宿主(注册序=应答序先到先应答/
// 重复 id 与 apiVersion 不符如实拒不静默收编/dispose 清册不半态)。

const makeProvider = (overrides: Partial<HotReloadProvider> = {}): HotReloadProvider => ({
  providerId: 'fork-test',
  apiVersion: HOT_RELOAD_PLUGIN_API_VERSION,
  displayName: 'Fork test provider',
  canSend: () => true,
  send: () => ({ ok: true }),
  ...overrides
});

describe('hotReloadProviderAssembly(HR-PR-08 接线批装配核)', () => {
  it('内置 HTTP hotfix provider:transport 未注入如实不接单', () => {
    const provider = createHttpHotfixSendProvider({});
    expect(provider.providerId).toBe(KBENGINE_HTTP_HOTFIX_PROVIDER_ID);
    expect(provider.apiVersion).toBe(HOT_RELOAD_PLUGIN_API_VERSION);
    expect(provider.canSend(buildEngineProfile({}))).toBe(false);
  });

  it('内置 HTTP hotfix provider:transport-faithful——请求形状与默认面同源,结果如实透传', async () => {
    const seen: Array<{ url: string; body: string }> = [];
    const provider = createHttpHotfixSendProvider({
      scriptRoot: '/ws/scripts',
      transport: async request => {
        seen.push({ url: request.url, body: request.body });
        return { ok: true, status: 200, durationMs: 1, body: 'ok' };
      }
    });
    expect(provider.canSend(buildEngineProfile({}))).toBe(true);
    const result = await provider.send({ targetId: '', files: ['/ws/scripts/goods/A.py'] });
    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toContain('module_name=goods.A');
    expect(seen[0].body).toContain('goods.A');
  });

  it('宿主:应答序=注入序先到先应答,无人应答如实 null', () => {
    const calls: string[] = [];
    const first = makeProvider({
      providerId: 'fork-first',
      canSend: () => true,
      send: () => {
        calls.push('fork-first');
        return { ok: true };
      }
    });
    const second = makeProvider({
      providerId: 'fork-second',
      canSend: () => true,
      send: () => {
        calls.push('fork-second');
        return { ok: true };
      }
    });
    const host = createHotReloadProviderHost({ providers: [first, second] });
    const resolved = host.registry.resolveSendProvider(buildEngineProfile({}));
    expect(resolved?.providerId).toBe('fork-first');
    void resolved?.send({ targetId: '', files: [] });
    expect(calls).toEqual(['fork-first']);
    // 无人应答=null,不回落默认实现(热更是写引擎内存动作)
    const none = createHotReloadProviderHost({
      providers: [makeProvider({ canSend: () => false })]
    });
    expect(none.registry.resolveSendProvider(buildEngineProfile({}))).toBeNull();
  });

  it('宿主:重复 id 如实拒(onRejection 上报,先注册者保留,不静默替换)', () => {
    const rejections: string[] = [];
    const host = createHotReloadProviderHost({
      providers: [
        makeProvider({ providerId: 'fork-x', send: () => ({ ok: true, detail: 'first' }) }),
        makeProvider({ providerId: 'fork-x', send: () => ({ ok: true, detail: 'second' }) })
      ],
      onRejection: rejection => void rejections.push(`${rejection.providerId}:${rejection.reason}`)
    });
    expect(rejections).toEqual(['fork-x:duplicate-id']);
    expect(host.registry.registeredSendProviderIds()).toEqual(['fork-x']);
  });

  it('宿主:apiVersion 不符如实拒,不收编', () => {
    const rejections: string[] = [];
    const host = createHotReloadProviderHost({
      providers: [makeProvider({ apiVersion: '2' as never })],
      onRejection: rejection => void rejections.push(rejection.reason)
    });
    expect(rejections).toEqual(['api-version-mismatch']);
    expect(host.registry.registeredSendProviderIds()).toEqual([]);
  });

  it('宿主 dispose:清册不半态——清后自省空、resolve null', () => {
    const host = createHotReloadProviderHost({ providers: [makeProvider()] });
    expect(host.registry.registeredSendProviderIds()).toEqual(['fork-test']);
    host.dispose();
    expect(host.registry.registeredSendProviderIds()).toEqual([]);
    expect(host.registry.resolveSendProvider(buildEngineProfile({}))).toBeNull();
  });
});
