import { describe, expect, it } from 'vitest';
import {
  buildEngineProfile,
  createDefaultHotReloadLifecycleSlots,
  defaultHotReloadFingerprintProvider,
  HOT_RELOAD_PLUGIN_API_VERSION,
  HotReloadProviderRegistry,
  type HotReloadProvider
} from '../src/backend/hotReloadPluginApi';
import type { HotReloadModuleIdentity } from '../src/backend/hotReloadModuleIdentity';

// HR-PR-08(plugin-api):版本化热更插件 API 纯核测试。
// 接口形状版本化(apiVersion='1');默认指纹实现纯委托既有核;注册表
// 重复 id/版本不符如实拒;resolve 应答者胜无人应答 null 不回落。

const ENGINE_MD5 = 'd41d8cd98f00b204e9800998ecf8427e'; // 32 位摘要形(协商判定=长度 32)

describe('版本标记', () => {
  it('apiVersion 恒 "1";默认 provider 声明同版本', () => {
    expect(HOT_RELOAD_PLUGIN_API_VERSION).toBe('1');
    expect(defaultHotReloadFingerprintProvider.apiVersion).toBe('1');
  });
});

describe('defaultHotReloadFingerprintProvider(纯委托既有核)', () => {
  it('fileHash 委托 hashDefContent 语义:sha256+字节数', () => {
    const result = defaultHotReloadFingerprintProvider.fileHash('x=1');
    expect(result.algorithm).toBe('sha256');
    expect(result.byteLength).toBe(3);
    expect(result.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('semanticFingerprint 委托结构指纹:版本+仅本文件语义标注', () => {
    const doc = ['<root>', '  <Properties>', '    <hp><Type> UINT32 </Type></hp>', '  </Properties>', '</root>'].join('\n');
    const report = defaultHotReloadFingerprintProvider.semanticFingerprint(doc);
    expect(report.specVersion).toBe('def-structural-fp/1');
    expect(report.scope).toBe('file-only-semantic');
    expect(report.hash).not.toBeNull();
  });

  it('negotiateDigest/profileLabel 透传:32 位摘要=md5,缺省=not available', () => {
    const negotiated = defaultHotReloadFingerprintProvider.negotiateDigest(ENGINE_MD5);
    expect(negotiated.algorithm).toBe('md5');
    expect(negotiated.negotiated).toBe(true);
    expect(defaultHotReloadFingerprintProvider.profileLabel(ENGINE_MD5).label).toBe('md5');
    expect(defaultHotReloadFingerprintProvider.profileLabel().label).toBe('not available');
    expect(defaultHotReloadFingerprintProvider.negotiateDigest().negotiated).toBe(false);
  });
});

describe('buildEngineProfile(版本化档案)', () => {
  it('探测版本+协商结果组装;版本未知=null 如实不编造', () => {
    const profile = buildEngineProfile({ engineVersion: '2.5.10', engineDigest: ENGINE_MD5 });
    expect(profile.apiVersion).toBe('1');
    expect(profile.engineVersion).toBe('2.5.10');
    expect(profile.fingerprint.label).toBe('md5');

    const unknown = buildEngineProfile({});
    expect(unknown.engineVersion).toBeNull();
    expect(unknown.fingerprint.label).toBe('not available');
  });
});

describe('HotReloadProviderRegistry', () => {
  const makeProvider = (id: string, apiVersion = HOT_RELOAD_PLUGIN_API_VERSION): HotReloadProvider => ({
    providerId: id,
    apiVersion,
    displayName: `provider-${id}`,
    canSend: profile => profile.engineVersion !== null,
    send: () => ({ ok: true })
  });

  it('注册成功;重复 id 如实拒且原实现不被替换', () => {
    const registry = new HotReloadProviderRegistry();
    expect(registry.registerSendProvider(makeProvider('p1'))).toBeNull();
    expect(registry.registeredSendProviderIds()).toEqual(['p1']);

    const rejection = registry.registerSendProvider(makeProvider('p1'));
    expect(rejection).toEqual({ providerId: 'p1', reason: 'duplicate-id' });
    expect(registry.registeredSendProviderIds()).toEqual(['p1']);
  });

  it('apiVersion 不符如实拒,不入注册表', () => {
    const registry = new HotReloadProviderRegistry();
    const rejection = registry.registerSendProvider(makeProvider('old', '0'));
    expect(rejection).toEqual({ providerId: 'old', reason: 'api-version-mismatch' });
    expect(registry.registeredSendProviderIds()).toHaveLength(0);
  });

  it('resolve:第一个 canSend 应答者胜;无人应答=null(不回落默认)', () => {
    const registry = new HotReloadProviderRegistry();
    registry.registerSendProvider({
      ...makeProvider('a'),
      canSend: () => false
    });
    registry.registerSendProvider(makeProvider('b'));

    const profile = buildEngineProfile({ engineVersion: '2.5.10' });
    const resolved = registry.resolveSendProvider(profile);
    expect(resolved?.providerId).toBe('b');

    // 无人应答(全 canSend=false 或注册表空):null,不静默回落
    const emptyRegistry = new HotReloadProviderRegistry();
    expect(emptyRegistry.resolveSendProvider(profile)).toBeNull();
    const noneHandle = new HotReloadProviderRegistry();
    noneHandle.registerSendProvider({ ...makeProvider('a'), canSend: () => false });
    expect(noneHandle.resolveSendProvider(profile)).toBeNull();
  });

  it('null profile 或 apiVersion 不符的 profile:resolve 如实 null', () => {
    const registry = new HotReloadProviderRegistry();
    registry.registerSendProvider(makeProvider('p1'));
    expect(registry.resolveSendProvider(null)).toBeNull();
    expect(registry.resolveSendProvider({ ...buildEngineProfile({}), apiVersion: '0' })).toBeNull();
  });
});

describe('HR-EXT-001 版本化生命周期契约(resolveModule/prepareRequest/interpretResponse/queryAppliedRevision)', () => {
  const ROOT = '/ws/scripts';
  const makeIdentity = (overrides: Partial<HotReloadModuleIdentity> = {}): HotReloadModuleIdentity => ({
    workspaceId: 'ws-1',
    rootId: 'scripts-root',
    fileUri: `${ROOT}/entities/fight/FightAI.py`,
    fullModule: 'entities.fight.FightAI',
    requestModule: 'fight.FightAI',
    fileStem: 'FightAI',
    parentName: 'fight',
    language: 'python',
    ...overrides
  });
  const makeSendProvider = (id: string): HotReloadProvider => ({
    providerId: id,
    apiVersion: HOT_RELOAD_PLUGIN_API_VERSION,
    displayName: `provider-${id}`,
    canSend: profile => profile.engineVersion !== null,
    send: () => ({ ok: true })
  });

  it('缺省槽 resolveModule 委托既有解析核:唯一根命中返回身份(双名)', () => {
    const slots = createDefaultHotReloadLifecycleSlots({ scriptRoots: [ROOT] });
    const result = slots.resolveModule({
      fileUri: `${ROOT}/entities/fight/FightAI.py`,
      workspaceId: 'ws-1',
      rootId: 'scripts-root'
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity.fullModule).toBe('entities.fight.FightAI');
      expect(result.identity.requestModule).toBe('fight.FightAI');
    }
  });

  it('缺省槽 resolveModule:无根候选诚实 no-root(不猜不回落)', () => {
    const slots = createDefaultHotReloadLifecycleSlots();
    const result = slots.resolveModule({ fileUri: `${ROOT}/entities/fight/FightAI.py` });
    expect(result.ok).toBe(false);
  });

  it('缺省槽 prepareRequest 形状:target/文件/模块身份/版本/关联 id(逐项透传)', () => {
    const slots = createDefaultHotReloadLifecycleSlots();
    const req = slots.prepareRequest({
      targetId: 'cellapp-1',
      identity: makeIdentity(),
      revision: 'rev-7',
      correlationId: 'corr-9'
    });
    expect(req).toEqual({
      targetId: 'cellapp-1',
      files: [`${ROOT}/entities/fight/FightAI.py`],
      moduleIdentities: ['fight.FightAI'],
      revision: 'rev-7',
      correlationId: 'corr-9'
    });
    // 缺省 revision/correlationId=如实不带(不冒充空)
    const bare = slots.prepareRequest({ targetId: 'cellapp-1', identity: makeIdentity() });
    expect(bare.revision).toBeUndefined();
    expect(bare.correlationId).toBeUndefined();
  });

  it('缺省槽 interpretResponse 委托七类分类:HTTP 500=apply-failed;未知 detail=unknown;ok 透传', () => {
    const slots = createDefaultHotReloadLifecycleSlots();
    const failed = slots.interpretResponse({ ok: false, detail: 'HTTP 状态 500:非 2xx 不算送达' });
    expect(failed.ok).toBe(false);
    expect(failed.reason).toBe('apply-failed');
    expect(failed.label).toBe('应用失败');
    const unknown = slots.interpretResponse({ ok: false, detail: '自定义失败文本' });
    expect(unknown.reason).toBe('unknown');
    expect(slots.interpretResponse({ ok: true }).ok).toBe(true);
  });

  it('缺省槽 queryAppliedRevision 未接线=如实 null(不编造运行时版本)', () => {
    const slots = createDefaultHotReloadLifecycleSlots();
    expect(
      slots.queryAppliedRevision({ targetId: 'cellapp-1', identity: makeIdentity() })
    ).toBeNull();
  });

  it('registry.resolveLifecycle:provider 自定义槽优先,缺槽回落缺省', () => {
    const registry = new HotReloadProviderRegistry();
    registry.registerSendProvider({
      ...makeSendProvider('custom'),
      resolveModule: () => ({ ok: true, identity: makeIdentity({ fullModule: 'custom.Override' }) })
    });
    const profile = buildEngineProfile({ engineVersion: '2.5.10' });
    const resolved = registry.resolveLifecycle(profile);
    expect(resolved?.provider.providerId).toBe('custom');
    // provider 实现了 resolveModule → 用 provider 的(自定义覆盖,非缺省)
    const customResolve = resolved?.slots.resolveModule({ fileUri: '/any.py' });
    expect(customResolve && customResolve.ok && customResolve.identity.fullModule).toBe('custom.Override');
    // provider 未实现 interpretResponse → 回落缺省(委托既有分类核)
    expect(
      resolved?.slots.interpretResponse({ ok: false, detail: 'HTTP 状态 500:非 2xx 不算送达' }).reason
    ).toBe('apply-failed');
    // provider 未实现 queryAppliedRevision → 回落缺省 null
    expect(
      resolved?.slots.queryAppliedRevision({ targetId: 't', identity: makeIdentity() })
    ).toBeNull();
  });

  it('registry.resolveLifecycle:纯发送 provider 缺槽全回落缺省;无人应答/null profile=如实 null', () => {
    const registry = new HotReloadProviderRegistry();
    registry.registerSendProvider(makeSendProvider('plain'));
    const profile = buildEngineProfile({ engineVersion: '2.5.10' });
    const resolved = registry.resolveLifecycle(profile);
    expect(resolved?.provider.providerId).toBe('plain');
    expect(
      resolved?.slots.resolveModule({ fileUri: `${ROOT}/entities/fight/FightAI.py`, scriptRoots: [ROOT] }).ok
    ).toBe(true);
    expect(registry.resolveLifecycle(null)).toBeNull();

    const noneHandle = new HotReloadProviderRegistry();
    noneHandle.registerSendProvider({ ...makeSendProvider('a'), canSend: () => false });
    expect(noneHandle.resolveLifecycle(profile)).toBeNull();
  });
});
