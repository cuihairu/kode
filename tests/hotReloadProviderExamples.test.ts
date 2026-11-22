import { describe, expect, it } from 'vitest';
import {
  createMockHttpHotfixProvider,
  createStubHotReloadProvider,
  EXAMPLE_STUB_PROVIDER_ID,
  examplePermissionVerdicts
} from '../src/backend/hotReloadProviderExamples';
import {
  buildEngineProfile,
  createDefaultHotReloadPermissionPolicy,
  HOT_RELOAD_PLUGIN_API_VERSION
} from '../src/backend/hotReloadPluginApi';
import { createHotReloadProviderHost } from '../src/backend/hotReloadProviderAssembly';
import type { HttpRequestEntry } from '../src/backend/httpRequests';

// HR-EXT-007(RUST-411)SDK 示例面:stub(零 IO 记录型)+ mock HTTP(同契约
// transport 脚本化)两例的集成测试与权限用例。示例即代码即测试对象——
// 复用既有 face(createTemplateHotfixSendProvider/缺省权限策略/宿主注册表),
// 不建平行抽象。

const customEntry: HttpRequestEntry = {
  name: '自定义引擎',
  url: 'http://engine.internal:9990/reload?mod=${module}',
  method: 'PUT',
  headers: { Authorization: 'Bearer tok-${moduleBasename}' },
  body: 'path=${module}',
  enabled: true,
  keybinding: ''
};

describe('HR-EXT-007 SDK 示例:stub provider(零 IO 记录型)', () => {
  it('stub:零声明零 IO——send 原样回 ok 且逐字记账原始请求', async () => {
    const stub = createStubHotReloadProvider();
    expect(stub.providerId).toBe(EXAMPLE_STUB_PROVIDER_ID);
    expect(stub.apiVersion).toBe(HOT_RELOAD_PLUGIN_API_VERSION);
    expect(stub.permissions).toBeUndefined(); // 零声明=最小权限
    const request = {
      targetId: 'cellapp#1',
      files: ['/ws/base/Account.py'],
      moduleIdentities: ['custom.Account'],
      revision: 'r1',
      correlationId: 'c1'
    };
    const result = await stub.send(request);
    expect(result).toEqual({ ok: true, detail: '' });
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]).toEqual(request);
  });

  it('stub:canSend 恒 true——它是「能应答」占位,不做 profile 分派', () => {
    const stub = createStubHotReloadProvider();
    expect(stub.canSend(buildEngineProfile({}))).toBe(true);
    expect(stub.canSend(buildEngineProfile({ engineVersion: '9.9' }))).toBe(true);
  });

  it('stub:经宿主注册表解析并按注册序应答,请求原样到达 send', async () => {
    const stub = createStubHotReloadProvider();
    const host = createHotReloadProviderHost({ providers: [stub] });
    const resolved = host.registry.resolveSendProvider(buildEngineProfile({}));
    expect(resolved?.providerId).toBe(EXAMPLE_STUB_PROVIDER_ID);
    await resolved?.send({ targetId: '', files: ['/ws/x.py'] });
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].files).toEqual(['/ws/x.py']);
  });
});

describe('HR-EXT-007 SDK 示例:mock HTTP provider(同契约,transport 脚本化)', () => {
  it('mock:默认内置模板——send 全路径经 sendDefaultHotfix→mock transport 展开 8090/hotfix', async () => {
    const mock = createMockHttpHotfixProvider({ sendDeps: { scriptRoot: '/ws/scripts' } });
    expect(mock.canSend(buildEngineProfile({}))).toBe(true);
    const result = await mock.send({ targetId: '', files: ['/ws/scripts/goods/A.py'] });
    expect(result.ok).toBe(true);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].url).toContain('http://127.0.0.1:8090/hotfix?module_name=goods.A');
  });

  it('mock:用户模板整条进请求(url/method/headers/body 非内置形态),与内置同契约', async () => {
    const mock = createMockHttpHotfixProvider({
      entry: customEntry,
      sendDeps: { scriptRoot: '/ws/scripts' }
    });
    await mock.send({ targetId: '', files: ['/ws/scripts/goods/A.py'] });
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].url).toBe('http://engine.internal:9990/reload?mod=goods.A');
    expect(mock.calls[0].method).toBe('PUT');
    expect(mock.calls[0].headers.Authorization).toBe('Bearer tok-A');
    expect(mock.calls[0].body).toBe('path=goods.A');
  });

  it('mock:脚本化失败/非 2xx 如实透传进 ok=false 且 detail 点名', async () => {
    const refused = createMockHttpHotfixProvider({
      responses: [{ ok: false, status: 0, durationMs: 1, body: '', error: 'ECONNREFUSED' }],
      sendDeps: { scriptRoot: '/ws/scripts' }
    });
    const r1 = await refused.send({ targetId: '', files: ['/ws/scripts/goods/A.py'] });
    expect(r1.ok).toBe(false);
    expect(r1.detail).toContain('ECONNREFUSED');

    const server500 = createMockHttpHotfixProvider({
      responses: [{ ok: true, status: 500, durationMs: 1, body: 'err' }],
      sendDeps: { scriptRoot: '/ws/scripts' }
    });
    const r2 = await server500.send({ targetId: '', files: ['/ws/scripts/goods/A.py'] });
    expect(r2.ok).toBe(false);
    expect(r2.detail).toContain('HTTP 500');
  });

  it('mock:经宿主注册表全路径集成——resolve→send 产出结构化 outcome', async () => {
    const mock = createMockHttpHotfixProvider({ sendDeps: { scriptRoot: '/ws/scripts' } });
    const host = createHotReloadProviderHost({ providers: [mock] });
    const resolved = host.registry.resolveSendProvider(buildEngineProfile({}));
    const result = await resolved?.send({
      targetId: 'x',
      files: ['/ws/scripts/goods/A.py'],
      correlationId: 'q1'
    });
    expect(result?.ok).toBe(true);
    expect(result?.outcomes).toHaveLength(1);
    expect(result?.outcomes?.[0].kind).toBe('ok');
    expect(result?.outcomes?.[0].correlationId).toBe('q1');
    expect(mock.calls).toHaveLength(1);
  });
});

describe('HR-EXT-007 权限用例(缺省策略下两例并置,解析与权限分层)', () => {
  it('权限:stub 零声明→send/spawn 一律拒且点名缺失;mock 声明→send 授', () => {
    const policy = createDefaultHotReloadPermissionPolicy();
    const verdicts = examplePermissionVerdicts(policy, createStubHotReloadProvider(), createMockHttpHotfixProvider({}));
    expect(verdicts.stubSend.granted).toBe(false);
    expect(verdicts.stubSend.missing).toEqual(['network']);
    expect(verdicts.stubSend.reason).toContain(EXAMPLE_STUB_PROVIDER_ID);
    expect(verdicts.stubSpawn.granted).toBe(false);
    expect(verdicts.stubSpawn.missing).toEqual(['exec']);
    expect(verdicts.mockSend.granted).toBe(true);
    expect(verdicts.mockSend.missing).toEqual([]);
    expect(verdicts.mockSpawn.granted).toBe(false); // mock 无 exec
    expect(verdicts.mockSpawn.missing).toEqual(['exec']);
  });

  it('权限:解析与权限分层——stub 能被注册表解析,挂载许可另由策略显式判', async () => {
    const policy = createDefaultHotReloadPermissionPolicy();
    const stub = createStubHotReloadProvider();
    const host = createHotReloadProviderHost({ providers: [stub] });
    const resolved = host.registry.resolveSendProvider(buildEngineProfile({}));
    // 解析序照旧(registry 不含权限假设)
    expect(resolved?.providerId).toBe(EXAMPLE_STUB_PROVIDER_ID);
    await resolved?.send({ targetId: '', files: ['/ws/x.py'] });
    expect(stub.calls).toHaveLength(1);
    // 权限判定是宿主挂载期另一道显式闸,registry 自身不拦
    expect(policy.check(stub, 'send').granted).toBe(false);
  });

  it('权限:mock 与内置同契约声明(workspace+network),不特权豁免', () => {
    const mock = createMockHttpHotfixProvider({});
    expect(mock.permissions).toEqual(['workspace', 'network']);
  });
});
