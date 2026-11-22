import { describe, expect, it } from 'vitest';
import {
  createHotReloadProviderHost,
  createHttpHotfixSendProvider,
  createTemplateHotfixSendProvider,
  KBENGINE_HTTP_HOTFIX_PROVIDER_ID
} from '../src/backend/hotReloadProviderAssembly';
import { type HttpRequestEntry } from '../src/backend/httpRequests';
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

  it('HR-HTTP-002:请求上的模块身份/版本/关联 id 透传,outcomes 结构化回传', async () => {
    const seen: Array<{ url: string; body: string }> = [];
    const provider = createHttpHotfixSendProvider({
      transport: async request => {
        seen.push({ url: request.url, body: request.body });
        return { ok: true, status: 200, durationMs: 1, body: 'ok' };
      }
    });
    const result = await provider.send({
      targetId: 'cellapp#1',
      files: ['/ws/scripts/base/Account.py', '/ws/scripts/base/Bot.py'],
      moduleIdentities: ['custom.Account', 'custom.Bot'],
      revision: 'rev-9',
      correlationId: 'req-1'
    });
    // 模块身份照调用方给定,不按文件推导
    expect(seen[0].url).toContain('module_name=custom.Account');
    expect(seen[1].url).toContain('module_name=custom.Bot');
    // 请求关联 id/版本回执,结构化 outcome 逐文件(平行)
    expect(result.ok).toBe(true);
    expect(result.correlationId).toBe('req-1');
    expect(result.revision).toBe('rev-9');
    expect(result.outcomes).toHaveLength(2);
    expect(result.outcomes?.[0].correlationId).toBe('req-1#1');
    expect(result.outcomes?.[1].correlationId).toBe('req-1#2');
    expect(result.outcomes?.[0].kind).toBe('ok');
  });

  it('HR-HTTP-002:增量前形状照常可发(缺省字段=行为与增量前一致)', async () => {
    const provider = createHttpHotfixSendProvider({
      transport: async () => ({ ok: true, status: 200, durationMs: 1, body: '' })
    });
    const result = await provider.send({ targetId: 'x', files: ['/ws/scripts/base/Account.py'] });
    expect(result.ok).toBe(true);
    expect(result.correlationId).toBeUndefined();
    expect(result.revision).toBeUndefined();
    expect(result.outcomes).toHaveLength(1);
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

describe('HR-EXT-006 模板=runtime adapter 实现(用户可替换,不绑死内置)', () => {
  const customEntry: HttpRequestEntry = {
    name: '自定义引擎',
    url: 'http://engine.internal:9990/reload?mod=${module}',
    method: 'PUT',
    headers: { Authorization: 'Bearer tok-${moduleBasename}' },
    body: 'path=${module}',
    enabled: true,
    keybinding: ''
  };
  const okTransport = async () => ({ ok: true, status: 200, durationMs: 1, body: 'ok' });

  it('用户模板 adapter:整条模板进请求(url/method/headers/body),非内置形态', async () => {
    const seen: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> = [];
    const provider = createTemplateHotfixSendProvider(customEntry, {
      scriptRoot: '/ws/scripts',
      transport: async request => {
        seen.push({ url: request.url, method: request.method, headers: request.headers, body: request.body });
        return { ok: true, status: 200, durationMs: 1, body: 'ok' };
      }
    });
    const result = await provider.send({ targetId: '', files: ['/ws/scripts/goods/A.py'] });
    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('http://engine.internal:9990/reload?mod=goods.A');
    expect(seen[0].method).toBe('PUT');
    expect(seen[0].headers.Authorization).toBe('Bearer tok-A');
    expect(seen[0].body).toBe('path=goods.A');
  });

  it('缺省=内置:不传模板的 sendDefaultHotfix 路径与增量前一致(8090/hotfix 形态)', async () => {
    const seen: Array<{ url: string }> = [];
    const provider = createHttpHotfixSendProvider({
      scriptRoot: '/ws/scripts',
      transport: async request => {
        seen.push({ url: request.url });
        return { ok: true, status: 200, durationMs: 1, body: 'ok' };
      }
    });
    await provider.send({ targetId: '', files: ['/ws/scripts/goods/A.py'] });
    expect(seen[0].url).toContain('http://127.0.0.1:8090/hotfix?module_name=goods.A');
  });

  it('模板 adapter 声明 workspace+network(同内置口径,无特权豁免);id 按模板名生成', () => {
    const provider = createTemplateHotfixSendProvider(customEntry, {});
    expect(provider.permissions).toEqual(['workspace', 'network']);
    expect(provider.providerId).toBe('kbengine.template-hotfix:自定义引擎');
    expect(provider.apiVersion).toBe(HOT_RELOAD_PLUGIN_API_VERSION);
    expect(provider.canSend(buildEngineProfile({}))).toBe(false); // 无 transport 如实不接单
  });

  it('用户模板可替换内置:注册序=应答序,先注册的用户模板先应答', () => {
    const userAdapter = createTemplateHotfixSendProvider(customEntry, { transport: okTransport });
    const builtin = createHttpHotfixSendProvider({ transport: okTransport });
    const host = createHotReloadProviderHost({ providers: [userAdapter, builtin] });
    const resolved = host.registry.resolveSendProvider(buildEngineProfile({ engineVersion: '2.5.10' }));
    expect(resolved?.providerId).toBe('kbengine.template-hotfix:自定义引擎');
    // 只注册内置=内置应答(缺省行为不变)
    const builtinOnly = createHotReloadProviderHost({ providers: [builtin] });
    expect(
      builtinOnly.registry.resolveSendProvider(buildEngineProfile({ engineVersion: '2.5.10' }))?.providerId
    ).toBe(KBENGINE_HTTP_HOTFIX_PROVIDER_ID);
  });
});
