/**
 * 热更插件 API 纯核(HR-PR-08,书 §19.4 plugin-api):
 * - HotReloadProvider/FingerprintProvider/EngineProfile 三面的**版本化**
 *   扩展接口:apiVersion='1' 钉接口形状,后续不兼容变更递增大版本,
 *   消费方可按版本拒绝旧实现(而不是静默误读);
 * - FingerprintProvider 默认实现=defaultHotReloadFingerprintProvider,
 *   纯委托既有已证核(hashDefContent/semanticFingerprintReport/
 *   negotiateEngineDigest),不自创哈希、不替引擎猜算法(HR-HASH-005/006
 *   纪律原样继承);fork/版本差异=换 provider 实现,默认实现只认默认引擎;
 *   HR-EXT-002 再加两个**可选**槽:compare(委托 compareFingerprints 三路
 *   对拍,不自创判定)+fetchEngineDigest(纯核零 IO,缺省如实 not-wired
 *   =null;真实获取与 tier/verified/compatible 可信度结论在装配面
 *   RUST-404 defMd5Check,本面不重复声明可信度)——向后兼容,
 *   apiVersion 不递增;
 * - HotReloadProvider 面:transport-faithful 发送(canSend 探测+send 透传
 *   发送结果),发送编排本身仍归 tempEdit/executor 既有面,本核只定义
 *   插槽形状与注册表解析;HR-EXT-001 再加四个**可选**生命周期插槽
 *   (resolveModule/prepareRequest/interpretResponse/queryAppliedRevision):
 *   缺省槽组合既有核(解析核/请求形状/七类分类核,queryAppliedRevision
 *   未接线=如实 null),实现自带槽优先——向后兼容,apiVersion 不递增
 *   (与 HR-HTTP-002 增量字段同纪律);
 * - 注册表:按 id 注册(重复 id 如实拒),resolve 按 profile 依次问
 *   canHandle,第一个应答者胜;无人应答=null(如实无 provider,不猜
 *   不回落默认——热更是写引擎内存的动作,回落=拿默认实现冒充用户环境);
 * - EngineProfile 版本化:{apiVersion, engineVersion(探测产物或 null),
 *   fingerprint: FingerprintProfile}——engineVersion null=未知如实,
 *   不编造(engineVersionDetect 同口径)。
 * 纯逻辑零 vscode;真实扩展宿主装配(注册时机/生命周期)随接线批。
 */

import { hashDefContent, negotiateEngineDigest, type DefContentHash, type DefDigestHandshake } from './hotReloadDefHash';
import type { HttpRequestOutcome } from './httpRequestExecutor';
import { semanticFingerprintReport, type SemanticFingerprintReport } from './hotReloadDefStructure';
import {
  compareFingerprints,
  resolveFingerprintProfile,
  type FingerprintProfile,
  type FingerprintTriCompareInput,
  type FingerprintTriVerdict
} from './hotReloadFingerprintCompare';
import {
  resolveHotReloadModuleIdentity,
  type HotReloadModuleIdentity,
  type HotReloadModuleResolution
} from './hotReloadModuleIdentity';
import { classifyHotReloadErrorReason, type HotReloadErrorReason } from './hotReloadErrorReason';

/** 插件 API 版本:接口形状变更(不兼容)时递增 */
export const HOT_RELOAD_PLUGIN_API_VERSION = '1';

/** HR-EXT-002 引擎 Digest 获取输入(工作区/根身份;实现按自身通道取) */
export interface FingerprintEngineDigestInput {
  readonly workspaceId?: string;
  readonly rootId?: string;
}

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
  /**
   * HR-EXT-002 三路对拍(委托 compareFingerprints 语义;实现可按 fork 换判定面)。
   * 可选=缺省槽回落既有 compareFingerprints 核,不自创对拍逻辑。
   */
  readonly compare?: (input: FingerprintTriCompareInput) => FingerprintTriVerdict;
  /**
   * HR-EXT-002 引擎 Digest 获取(声明插槽形状;实现=按自身通道取真实引擎摘要)。
   * 纯核零 IO:缺省如实 not-wired=null(不编造引擎摘要);真实获取在装配面
   * (RUST-404 defMd5Check,那里同时给出 tier/verified/compatible 可信度结论),
   * 本槽只声明「取摘要」边界,不重复声明可信度。
   */
  readonly fetchEngineDigest?: (input?: FingerprintEngineDigestInput) => Promise<string | null>;
}

/** 默认指纹实现:纯委托 hashDefContent/semanticFingerprintReport/negotiateEngineDigest */
export const defaultHotReloadFingerprintProvider: FingerprintProvider = {
  providerId: 'kbengine.default-fingerprint',
  apiVersion: HOT_RELOAD_PLUGIN_API_VERSION,
  negotiateDigest: engineDigest => negotiateEngineDigest(engineDigest),
  fileHash: content => hashDefContent(content),
  semanticFingerprint: text => semanticFingerprintReport(text),
  profileLabel: engineDigest => resolveFingerprintProfile(engineDigest),
  compare: input => compareFingerprints(input),
  fetchEngineDigest: async () => null
};

/**
 * 发送结果(transport-faithful:实现透传自身通道的 ok/detail,本核不解释)。
 * HR-HTTP-002 增量为可选字段:HTTP 通道实现透传逐文件结构化 outcome,
 * 其他通道(如有)不产即缺省——apiVersion 不递增(向后兼容)。
 */
export interface HotReloadProviderSendResult {
  readonly ok: boolean;
  readonly detail?: string;
  /** HR-HTTP-002:逐文件结构化 outcome(分类+关联 id;缺省=实现不产) */
  readonly outcomes?: readonly HttpRequestOutcome[];
  /** HR-HTTP-002:请求关联 id 回执(结果↔请求关联;未给=无) */
  readonly correlationId?: string;
  /** HR-HTTP-002:请求版本回执(结果↔版本关联,HR-HTTP-013 CAS 底座) */
  readonly revision?: string;
}

/**
 * 发送请求(目标+文件集合;编排由实现自定,形状版本化)。
 * HR-HTTP-002 增量=可选字段(module identity/revision/correlation id),
 * 缺省行为与增量前逐字一致:实现自推模块名、逐次执行自生关联 id。
 */
export interface HotReloadProviderSendRequest {
  readonly targetId: string;
  readonly files: readonly string[];
  /** HR-HTTP-002:逐文件模块身份(与 files 平行;缺省/空=实现按文件推导) */
  readonly moduleIdentities?: readonly string[];
  /** HR-HTTP-002:请求版本(结果关联用;线路是否携带由通道实现自定) */
  readonly revision?: string;
  /** HR-HTTP-002:请求关联 id(缺省=实现逐次执行自生成) */
  readonly correlationId?: string;
}

/**
 * HR-EXT-001 生命周期解析输入:模块身份解析(文件→模块名)。
 * scriptRoots/allowRootLevelStem 缺省=用装配面构造缺省槽时的默认,
 * 显式给=本调用覆盖(逐调用覆盖,不跨调用粘滞)。
 */
export interface HotReloadProviderResolveInput {
  readonly fileUri: string;
  readonly workspaceId?: string;
  readonly rootId?: string;
  /** 覆盖装配面默认根候选;缺省=用装配面默认 */
  readonly scriptRoots?: readonly string[];
  /** 覆盖装配面默认 single-level fallback;缺省=用装配面默认 */
  readonly allowRootLevelStem?: boolean;
  /** 用户显式模块名覆盖(透传既有 HR-MOD-007 语义) */
  readonly userOverrideModule?: string;
}

/** 解析结果(复用既有解析核产物形状,如实 no-root/歧义诊断) */
export type HotReloadProviderResolveResult = HotReloadModuleResolution;

/** HR-EXT-001 生命周期准备输入:目标+已解析身份+版本/关联 id(可选) */
export interface HotReloadProviderPrepareInput {
  readonly targetId: string;
  readonly identity: HotReloadModuleIdentity;
  readonly revision?: string;
  readonly correlationId?: string;
}

/** HR-EXT-001 生命周期解释输入:发送结果原样透传 */
export interface HotReloadProviderInterpretInput {
  readonly ok: boolean;
  readonly detail?: string;
}

/** HR-EXT-001 解释产物:ok 透传;失败=七类原因分类+标签+提示 */
export interface HotReloadProviderInterpretation {
  readonly ok: boolean;
  readonly reason?: HotReloadErrorReason;
  readonly label?: string;
  readonly hint?: string;
}

/** HR-EXT-001 已应用版本查询输入 */
export interface HotReloadProviderRevisionQuery {
  readonly targetId: string;
  readonly identity: HotReloadModuleIdentity;
}

/** HR-EXT-001 已应用版本产物:来源如实标注(引擎回执/台账/回执面) */
export interface HotReloadProviderAppliedRevision {
  readonly revision: string;
  readonly source: 'engine' | 'ledger' | 'receipt';
}

/**
 * HR-PR-08 热更发送插槽(实现=具体通道;默认无实现,如实 null)。
 * HR-EXT-001:发送面(canSend/send)之外加四个**可选**生命周期插槽
 * (resolveModule/prepareRequest/interpretResponse/queryAppliedRevision),
 * 可选=缺省槽回落(createDefaultHotReloadLifecycleSlots 组合既有核),
 * 向后兼容:增量前实现(只有 canSend/send)形状不变,apiVersion 不递增。
 */
export interface HotReloadProvider {
  readonly providerId: string;
  readonly apiVersion: typeof HOT_RELOAD_PLUGIN_API_VERSION;
  readonly displayName: string;
  /** 该实现能否处理此 engine profile(fork/版本差异在此分派) */
  canSend(profile: EngineProfile): boolean;
  send(request: HotReloadProviderSendRequest): Promise<HotReloadProviderSendResult> | HotReloadProviderSendResult;
  /** HR-EXT-001:文件→模块身份(实现可换解析面;缺省=委托既有解析核) */
  readonly resolveModule?: (input: HotReloadProviderResolveInput) => HotReloadProviderResolveResult;
  /** HR-EXT-001:目标+身份→请求(实现可换请求组装;缺省=透传既有发送请求形状) */
  readonly prepareRequest?: (input: HotReloadProviderPrepareInput) => HotReloadProviderSendRequest;
  /** HR-EXT-001:发送结果→分类解释(实现可换错误分类面;缺省=委托既有七类分类核) */
  readonly interpretResponse?: (input: HotReloadProviderInterpretInput) => HotReloadProviderInterpretation;
  /** HR-EXT-001:已应用版本查询(实现可接引擎回执;缺省=null 如实未接线) */
  readonly queryAppliedRevision?: (input: HotReloadProviderRevisionQuery) => HotReloadProviderAppliedRevision | null;
}

/** HR-EXT-001 生命周期插槽全集(缺省槽形状=组合既有核) */
export type HotReloadLifecycleSlots = Required<
  Pick<HotReloadProvider, 'resolveModule' | 'prepareRequest' | 'interpretResponse' | 'queryAppliedRevision'>
>;

/**
 * HR-EXT-001 缺省生命周期插槽:组合既有核(解析核/发送请求形状/七类分类核),
 * 不自创解析、不自创错误分类。queryAppliedRevision=如实 null(未接线,不编造)。
 */
export function createDefaultHotReloadLifecycleSlots(input?: {
  scriptRoots?: readonly string[];
  allowRootLevelStem?: boolean;
}): HotReloadLifecycleSlots {
  const defaultRoots = input?.scriptRoots;
  const defaultAllowRoot = input?.allowRootLevelStem;
  return {
    resolveModule: resolveInput => {
      const effectiveRoots = resolveInput.scriptRoots ?? defaultRoots;
      const effectiveAllowRoot = resolveInput.allowRootLevelStem ?? defaultAllowRoot;
      return resolveHotReloadModuleIdentity({
        fileUri: resolveInput.fileUri,
        workspaceId: resolveInput.workspaceId,
        rootId: resolveInput.rootId,
        ...(effectiveRoots !== undefined ? { scriptRoots: effectiveRoots } : {}),
        ...(effectiveAllowRoot !== undefined ? { allowRootLevelStem: effectiveAllowRoot } : {}),
        ...(resolveInput.userOverrideModule !== undefined
          ? { userOverrideModule: resolveInput.userOverrideModule }
          : {})
      });
    },
    prepareRequest: prepareInput => ({
      targetId: prepareInput.targetId,
      files: [prepareInput.identity.fileUri],
      moduleIdentities: [prepareInput.identity.requestModule],
      ...(prepareInput.revision !== undefined ? { revision: prepareInput.revision } : {}),
      ...(prepareInput.correlationId !== undefined ? { correlationId: prepareInput.correlationId } : {})
    }),
    interpretResponse: interpretInput => {
      if (interpretInput.ok) {
        return { ok: true };
      }
      const info = classifyHotReloadErrorReason(interpretInput.detail ?? '');
      return { ok: false, reason: info.category, label: info.label, hint: info.hint };
    },
    queryAppliedRevision: () => null
  };
}

/** HR-EXT-001 已解析生命周期:provider + 其插槽(槽缺省已回落,非半态) */
export interface HotReloadResolvedLifecycle {
  readonly provider: HotReloadProvider;
  readonly slots: HotReloadLifecycleSlots;
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

  /**
   * HR-EXT-001 解析生命周期:按 profile 选发送 provider,再把它自带的四个生命周期
   * 插槽与缺省槽合成(实现自带槽优先,缺槽回落缺省组合核)。
   * 无人应答/null profile=如实 null(不回落默认,同 resolveSendProvider 口径)。
   */
  resolveLifecycle(profile: EngineProfile | null): HotReloadResolvedLifecycle | null {
    const provider = this.resolveSendProvider(profile);
    if (!provider) {
      return null;
    }
    const defaults = createDefaultHotReloadLifecycleSlots();
    return {
      provider,
      slots: {
        resolveModule: provider.resolveModule ?? defaults.resolveModule,
        prepareRequest: provider.prepareRequest ?? defaults.prepareRequest,
        interpretResponse: provider.interpretResponse ?? defaults.interpretResponse,
        queryAppliedRevision: provider.queryAppliedRevision ?? defaults.queryAppliedRevision
      }
    };
  }

  /** 自省:已注册 id 序(测试/装配面核查) */
  registeredSendProviderIds(): string[] {
    return [...this.sendProviders.keys()];
  }

  /** 生命周期:清空全部注册(宿主 dispose 面;重注册即重建,不半态) */
  clear(): void {
    this.sendProviders.clear();
  }
}
