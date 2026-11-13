/**
 * 热更插件 API 纯核(HR-PR-08,书 §19.4 plugin-api):
 * - HotReloadProvider/FingerprintProvider/EngineProfile 三面的**版本化**
 *   扩展接口:apiVersion='1' 钉接口形状,后续不兼容变更递增大版本,
 *   消费方可按版本拒绝旧实现(而不是静默误读);
 * - FingerprintProvider 默认实现=defaultHotReloadFingerprintProvider,
 *   纯委托既有已证核(hashDefContent/semanticFingerprintReport/
 *   negotiateEngineDigest),不自创哈希、不替引擎猜算法(HR-HASH-005/006
 *   纪律原样继承);fork/版本差异=换 provider 实现,默认实现只认默认引擎;
 * - HotReloadProvider 面:transport-faithful 发送(canSend 探测+send 透传
 *   发送结果),发送编排本身仍归 tempEdit/executor 既有面,本核只定义
 *   插槽形状与注册表解析;
 * - 注册表:按 id 注册(重复 id 如实拒),resolve 按 profile 依次问
 *   canHandle,第一个应答者胜;无人应答=null(如实无 provider,不猜
 *   不回落默认——热更是写引擎内存的动作,回落=拿默认实现冒充用户环境);
 * - EngineProfile 版本化:{apiVersion, engineVersion(探测产物或 null),
 *   fingerprint: FingerprintProfile}——engineVersion null=未知如实,
 *   不编造(engineVersionDetect 同口径)。
 * 纯逻辑零 vscode;真实扩展宿主装配(注册时机/生命周期)随接线批。
 */

import { hashDefContent, negotiateEngineDigest, type DefContentHash, type DefDigestHandshake } from './hotReloadDefHash';
import { semanticFingerprintReport, type SemanticFingerprintReport } from './hotReloadDefStructure';
import { resolveFingerprintProfile, type FingerprintProfile } from './hotReloadFingerprintCompare';

/** 插件 API 版本:接口形状变更(不兼容)时递增 */
export const HOT_RELOAD_PLUGIN_API_VERSION = '1';

/** HR-HASH-006 指纹插槽(版本化;默认实现委托既有核) */
export interface FingerprintProvider {
  readonly providerId: string;
  readonly apiVersion: typeof HOT_RELOAD_PLUGIN_API_VERSION;
  /** 引擎 Digest 协商(透传 negotiateEngineDigest 语义;实现可按 fork 换算法面) */
  negotiateDigest(engineDigest?: string): DefDigestHandshake;
  /** 客户端 fileHash(sha256 原始字节;实现禁自创哈希) */
  fileHash(content: string): DefContentHash;
  /** 语义指纹报告(版本+作用域如实标注) */
  semanticFingerprint(text: string): SemanticFingerprintReport;
  /** profile 标签(协商出算法=算法名,否则 not available) */
  profileLabel(engineDigest?: string): FingerprintProfile;
}

/** 默认指纹实现:纯委托 hashDefContent/semanticFingerprintReport/negotiateEngineDigest */
export const defaultHotReloadFingerprintProvider: FingerprintProvider = {
  providerId: 'kbengine.default-fingerprint',
  apiVersion: HOT_RELOAD_PLUGIN_API_VERSION,
  negotiateDigest: engineDigest => negotiateEngineDigest(engineDigest),
  fileHash: content => hashDefContent(content),
  semanticFingerprint: text => semanticFingerprintReport(text),
  profileLabel: engineDigest => resolveFingerprintProfile(engineDigest)
};

/** 发送结果(transport-faithful:实现透传自身通道的 ok/detail,本核不解释) */
export interface HotReloadProviderSendResult {
  readonly ok: boolean;
  readonly detail?: string;
}

/** 发送请求(目标+文件集合;编排由实现自定,形状版本化) */
export interface HotReloadProviderSendRequest {
  readonly targetId: string;
  readonly files: readonly string[];
}

/** HR-PR-08 热更发送插槽(实现=具体通道;默认无实现,如实 null) */
export interface HotReloadProvider {
  readonly providerId: string;
  readonly apiVersion: typeof HOT_RELOAD_PLUGIN_API_VERSION;
  readonly displayName: string;
  /** 该实现能否处理此 engine profile(fork/版本差异在此分派) */
  canSend(profile: EngineProfile): boolean;
  send(request: HotReloadProviderSendRequest): Promise<HotReloadProviderSendResult> | HotReloadProviderSendResult;
}

/** 引擎档案(版本化):探测版本+指纹档案;版本未知=null 如实 */
export interface EngineProfile {
  readonly apiVersion: typeof HOT_RELOAD_PLUGIN_API_VERSION;
  /** 探测产物(engineVersionDetect);null=未知如实,不编造 */
  readonly engineVersion: string | null;
  readonly fingerprint: FingerprintProfile;
}

/** 组装引擎档案(纯:探测值+协商输入都由调用方给,本核不 IO) */
export function buildEngineProfile(input: {
  engineVersion?: string | null;
  engineDigest?: string;
}): EngineProfile {
  return {
    apiVersion: HOT_RELOAD_PLUGIN_API_VERSION,
    engineVersion: input.engineVersion ?? null,
    fingerprint: resolveFingerprintProfile(input.engineDigest)
  };
}

/** 注册表拒绝原因(如实可审) */
export type HotReloadRegistryRejectReason = 'duplicate-id' | 'api-version-mismatch';

export interface HotReloadRegistryRejection {
  readonly providerId: string;
  readonly reason: HotReloadRegistryRejectReason;
}

/**
 * Provider 注册表:重复 id 与 apiVersion 不符的注册如实拒(返回拒绝原因,
 * 不静默替换、不静默收编);resolve 按 profile 依次问 canSend,应答者胜,
 * 无人应答=null(不回落默认——热更是写引擎内存的动作)。
 */
export class HotReloadProviderRegistry {
  private readonly sendProviders = new Map<string, HotReloadProvider>();

  registerSendProvider(provider: HotReloadProvider): HotReloadRegistryRejection | null {
    if (provider.apiVersion !== HOT_RELOAD_PLUGIN_API_VERSION) {
      return { providerId: provider.providerId, reason: 'api-version-mismatch' };
    }
    if (this.sendProviders.has(provider.providerId)) {
      return { providerId: provider.providerId, reason: 'duplicate-id' };
    }
    this.sendProviders.set(provider.providerId, provider);
    return null;
  }

  /** 解析发送 provider:第一个 canSend 应答者胜;无人应答/null profile=null */
  resolveSendProvider(profile: EngineProfile | null): HotReloadProvider | null {
    if (!profile || profile.apiVersion !== HOT_RELOAD_PLUGIN_API_VERSION) {
      return null;
    }
    for (const provider of this.sendProviders.values()) {
      if (provider.canSend(profile)) {
        return provider;
      }
    }
    return null;
  }

  /** 自省:已注册 id 序(测试/装配面核查) */
  registeredSendProviderIds(): string[] {
    return [...this.sendProviders.keys()];
  }
}
