import { describe, expect, it } from 'vitest';
import {
  buildEngineProfile,
  createDefaultHotReloadEligibilityRule,
  createDefaultHotReloadLifecycleSlots,
  createDefaultHotReloadPermissionPolicy,
  defaultHotReloadFingerprintProvider,
  HOT_RELOAD_PLUGIN_API_VERSION,
  HotReloadProviderRegistry,
  type FingerprintProvider,
  type HotReloadEligibilityRule,
  type HotReloadProvider,
  type HotReloadProviderFace
} from '../src/backend/hotReloadPluginApi';
import type { HotReloadModuleIdentity } from '../src/backend/hotReloadModuleIdentity';

// HR-PR-08(plugin-api):版本化热更插件 API 纯核测试。
// 接口形状版本化(apiVersion='1');默认指纹实现纯委托既有核;注册表
// 重复 id/版本不符如实拒;resolve 应答者胜无人应答 null 不回落。
// HR-EXT-001 生命周期槽(resolveModule/prepareRequest/interpretResponse/
// queryAppliedRevision 可选+缺槽回落);HR-EXT-002 指纹槽(compare/
// fetchEngineDigest 可选+缺省委托既有对拍核/not-wired);
// HR-EXT-003 资格判定规则(auto/manual/restart 保守序+fork 换 rule 接管)。

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

describe('HR-EXT-002 版本化指纹契约(compare/fetchEngineDigest 可选槽)', () => {
  // 类型级钉:不含 compare/fetchEngineDigest 的纯计算形态仍合规(FingerprintProvider
  // 两个 HR-EXT-002 槽均可选,不强制实现;tsc 校验此字面量可赋值即证明可选)。
  const minimalFingerprintProvider: FingerprintProvider = {
    providerId: 'kbengine.minimal-fingerprint',
    apiVersion: HOT_RELOAD_PLUGIN_API_VERSION,
    negotiateDigest: engineDigest => defaultHotReloadFingerprintProvider.negotiateDigest(engineDigest),
    fileHash: content => defaultHotReloadFingerprintProvider.fileHash(content),
    semanticFingerprint: text => defaultHotReloadFingerprintProvider.semanticFingerprint(text),
    profileLabel: engineDigest => defaultHotReloadFingerprintProvider.profileLabel(engineDigest)
  };

  it('缺省槽 compare 委托 compareFingerprints 三路对拍:文件/语义变化+已应用一致如实', () => {
    const verdict = defaultHotReloadFingerprintProvider.compare?.({
      lastLocalFileHash: 'aaa',
      currentFileHash: 'bbb',
      lastSemanticHash: 's1',
      currentSemanticHash: 's2',
      engineMd5: ENGINE_MD5,
      serverAppliedDigest: 'abc',
      localRecomputedMd5: 'abc'
    });
    expect(verdict?.fileChanged).toBe('changed');
    expect(verdict?.semanticChanged).toBe('changed');
    expect(verdict?.appliedConsistency).toBe('consistent');
  });

  it('缺省槽 compare:同值=unchanged;未协商引擎算法=applied unknown+点名原因(不跨类比)', () => {
    const verdict = defaultHotReloadFingerprintProvider.compare?.({
      lastLocalFileHash: 'aaa',
      currentFileHash: 'aaa',
      lastSemanticHash: 's1',
      currentSemanticHash: 's1'
    });
    expect(verdict?.fileChanged).toBe('unchanged');
    expect(verdict?.semanticChanged).toBe('unchanged');
    expect(verdict?.appliedConsistency).toBe('unknown');
    expect(verdict?.reasons.join(' ')).toContain('未协商');
  });

  it('缺省槽 fetchEngineDigest 纯核零 IO=如实 not-wired null(不编造引擎摘要)', async () => {
    expect(await defaultHotReloadFingerprintProvider.fetchEngineDigest?.({ workspaceId: 'ws-1' })).toBeNull();
  });

  it('可选槽缺省=默认实现仍提供两槽(合规形态),算法版本声明 apiVersion=1', () => {
    expect(typeof defaultHotReloadFingerprintProvider.compare).toBe('function');
    expect(typeof defaultHotReloadFingerprintProvider.fetchEngineDigest).toBe('function');
    expect(minimalFingerprintProvider.apiVersion).toBe('1');
    // 最小形态未实现两槽(可选):如实 undefined,不冒充空实现
    expect(minimalFingerprintProvider.compare).toBeUndefined();
    expect(minimalFingerprintProvider.fetchEngineDigest).toBeUndefined();
  });
});

describe('HR-EXT-003 资格判定规则(auto/manual/restart 保守序)', () => {
  const makeRule = () => createDefaultHotReloadEligibilityRule();
  const profile = () => buildEngineProfile({ engineVersion: '2.5.10' });
  const autoInput = (overrides: Record<string, unknown> = {}) => ({
    profile: profile(),
    root: '/ws/scripts',
    fileUri: '/ws/scripts/entities/fight/FightAI.py',
    context: { trigger: 'watcher-auto' as const },
    ...overrides
  });

  it('restart 最强:def 结构闸 reasons 非空=需重启(即使 auto 要素全齐)', () => {
    const rule = makeRule();
    expect(
      rule.decide(autoInput({ context: { trigger: 'watcher-auto', structuralReasons: ['字段类型变更'] } }))
    ).toBe('restart');
  });

  it('auto 须四要素齐备:.py+root+引擎版本已知+watcher-auto 触发', () => {
    const rule = makeRule();
    expect(rule.decide(autoInput())).toBe('auto');
  });

  it('任何一要素缺=保守 manual(不自动发未知根/未知引擎/非 py/人工链)', () => {
    const rule = makeRule();
    expect(rule.decide(autoInput({ root: null }))).toBe('manual');
    expect(rule.decide(autoInput({ profile: buildEngineProfile({}) }))).toBe('manual'); // engineVersion null
    expect(rule.decide(autoInput({ fileUri: '/ws/scripts/data.xml' }))).toBe('manual');
    expect(rule.decide(autoInput({ context: { trigger: 'command' } }))).toBe('manual');
    expect(rule.decide(autoInput({ context: { trigger: 'watcher-auto', userInitiated: true } }))).toBe('manual');
    expect(rule.decide({})).toBe('manual'); // 全缺
  });

  it('fork 可换 rule 实现整面接管分类;apiVersion 钉 1', () => {
    const forkRule: HotReloadEligibilityRule = {
      providerId: 'kbengine.fork-eligibility',
      apiVersion: HOT_RELOAD_PLUGIN_API_VERSION,
      decide: () => 'auto' // fork 全自动(示例;真实 fork 自定判定面)
    };
    expect(forkRule.decide({})).toBe('auto');
    expect(makeRule().apiVersion).toBe('1');
    expect(forkRule.apiVersion).toBe('1');
  });
});

describe('HR-EXT-004 权限声明(workspace/network/exec,最小权限缺省)', () => {
  const policy = createDefaultHotReloadPermissionPolicy();
  const undeclared = { providerId: 'fork.undeclared' };
  const faces: HotReloadProviderFace[] = ['send', 'fetch-digest', 'read-workspace', 'spawn-process'];

  it('未声明 permissions:对全部需声明面一律 granted=false 且缺失点名(不静默放行)', () => {
    expect(policy.check(undeclared, 'send').granted).toBe(false);
    expect(policy.check(undeclared, 'send').missing).toEqual(['network']);
    expect(policy.check(undeclared, 'read-workspace').missing).toEqual(['workspace']);
    expect(policy.check(undeclared, 'spawn-process').missing).toEqual(['exec']);
    // fetch-digest 两可:两个通道都缺时缺失取缺失最少的一组(此处单组等长,取首组)
    const digest = policy.check(undeclared, 'fetch-digest');
    expect(digest.granted).toBe(false);
    expect(digest.missing.length).toBeGreaterThan(0);
    expect(digest.reason).toContain('fork.undeclared');
  });

  it('声明即授权:各自声明 network/workspace/exec 后对应面 granted 且 missing 空', () => {
    expect(policy.check({ providerId: 'p', permissions: ['network'] }, 'send').granted).toBe(true);
    expect(policy.check({ providerId: 'p', permissions: ['network'] }, 'send').missing).toEqual([]);
    expect(policy.check({ providerId: 'p', permissions: ['workspace'] }, 'read-workspace').granted).toBe(true);
    expect(policy.check({ providerId: 'p', permissions: ['exec'] }, 'spawn-process').granted).toBe(true);
  });

  it('fetch-digest 两可:声明 workspace 或 network 任一即可;皆缺=拒', () => {
    const byWorkspace = policy.check({ providerId: 'p', permissions: ['workspace'] }, 'fetch-digest');
    expect(byWorkspace.granted).toBe(true);
    const byNetwork = policy.check({ providerId: 'p', permissions: ['network'] }, 'fetch-digest');
    expect(byNetwork.granted).toBe(true);
    const both = policy.check({ providerId: 'p', permissions: ['workspace', 'network'] }, 'fetch-digest');
    expect(both.granted).toBe(true);
    const neither = policy.check({ providerId: 'p', permissions: ['exec'] }, 'fetch-digest');
    expect(neither.granted).toBe(false);
  });

  it('跨面不挪用:声明 network 不够 read-workspace;声明 workspace 不够 spawn-process', () => {
    const networkOnly = { providerId: 'p', permissions: ['network'] as const };
    expect(policy.check(networkOnly, 'read-workspace').granted).toBe(false);
    expect(policy.check(networkOnly, 'spawn-process').granted).toBe(false);
    const workspaceOnly = { providerId: 'p', permissions: ['workspace'] as const };
    expect(policy.check(workspaceOnly, 'spawn-process').granted).toBe(false);
  });

  it('重复声明去重不误判;permissions 为空数组=等同未声明(最小权限)', () => {
    expect(policy.check({ providerId: 'p', permissions: ['network', 'network'] }, 'send').granted).toBe(true);
    expect(policy.check({ providerId: 'p', permissions: [] }, 'send').granted).toBe(false);
  });

  it('acceptableDeclarations 逐面回显;policyId/apiVersion 钉 1', () => {
    expect(policy.acceptableDeclarations('send')).toEqual([['network']]);
    expect(policy.acceptableDeclarations('fetch-digest')).toEqual([['workspace'], ['network']]);
    expect(policy.acceptableDeclarations('read-workspace')).toEqual([['workspace']]);
    expect(policy.acceptableDeclarations('spawn-process')).toEqual([['exec']]);
    expect(policy.policyId).toBe('kbengine.default-permission');
    expect(policy.apiVersion).toBe('1');
  });

  it('fork 可换 permission policy 整面接管判定;同形状不同判定', () => {
    const forkPolicy = {
      ...policy,
      policyId: 'fork.own-permission',
      check: (provider: Pick<HotReloadProvider, 'providerId' | 'permissions'>, face: HotReloadProviderFace) => ({
        granted: provider.providerId.startsWith('fork.'), // fork 自定判定面
        face,
        missing: provider.providerId.startsWith('fork.') ? [] : ['network']
      })
    };
    expect(forkPolicy.check({ providerId: 'fork.x' }, 'send').granted).toBe(true);
    expect(forkPolicy.check({ providerId: 'other.x' }, 'send').granted).toBe(false);
  });

  it('向后兼容:无 permissions 的纯发送 provider 形状仍合规,注册表解析序不受权限面影响', () => {
    const minimalSendProvider: HotReloadProvider = {
      providerId: 'fork.minimal',
      apiVersion: HOT_RELOAD_PLUGIN_API_VERSION,
      displayName: 'minimal',
      canSend: () => true,
      send: () => ({ ok: true })
    };
    const registry = new HotReloadProviderRegistry();
    expect(registry.registerSendProvider(minimalSendProvider)).toBeNull();
    // 权限未声明=策略面拒其敏感挂载;注册表解析序照常应答(两者解耦,不改既有解析语义)
    expect(registry.resolveSendProvider(buildEngineProfile({ engineVersion: '2.5.10' }))?.providerId).toBe('fork.minimal');
    expect(policy.check(minimalSendProvider, 'send').granted).toBe(false);
  });

  it('内置 HTTP provider 声明 workspace+network:send/read-workspace/fetch-digest 通过,spawn-process 拒(未声明 exec)', async () => {
    const { createHttpHotfixSendProvider } = await import('../src/backend/hotReloadProviderAssembly');
    const builtin = createHttpHotfixSendProvider({});
    expect(builtin.permissions).toEqual(['workspace', 'network']);
    expect(policy.check(builtin, 'send').granted).toBe(true);
    expect(policy.check(builtin, 'read-workspace').granted).toBe(true);
    expect(policy.check(builtin, 'fetch-digest').granted).toBe(true);
    expect(policy.check(builtin, 'spawn-process').granted).toBe(false);
    expect(policy.check(builtin, 'spawn-process').missing).toEqual(['exec']);
  });
});
