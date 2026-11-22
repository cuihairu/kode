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
 *   不编造(engineVersionDetect 同口径);
 * - HR-EXT-003 资格判定规则(HotReloadEligibilityRule):按 engine profile/
 *   root/文件类型/上下文判 auto/manual/restart;缺省规则只做保守组合判定
 *   (restart 消费既有 def 闸结论,不重算结构;auto 须四要素齐备,缺一
 *   manual),fork=换 rule 实现整面接管分类;
 * - HR-EXT-004 权限声明(HotReloadProviderPermission):第三方 provider 必须
 *   声明所需能力(workspace 文件访问/network 联网/exec 进程)才能挂到对应
 *   能力面——缺省策略=最小权限,未声明 permissions 的 provider 对所有需声明
 *   面一律 granted=false(如实拒,不静默放行:第三方不得未声明即截获保存
 *   事件/联网/起进程)。本核只定义声明形状与判定策略;真实拒绝点在宿主装配
 *   挂载期(策略由宿主调用,resolve* 解析序保持无权限假设),与 HR-HTTP-001
 *   端点策略(RUST-420,只管请求目的地)互补不重复;
 * - HR-EXT-005 隔离 Worker 贡献面(HotReloadWorkerAdapter):Python 插件经
 *   隔离 Worker 贡献 eligibility/response adapter;预算化派发
 *   (dispatchWorkerWithBudget:超时=timed-out 不无界等,槽位按预算释放)+
 *   背压有界(在途上限,满则 rejected 不排队)——hot path 绝不无界阻塞;
 *   资格超时保守产物=manual(与 HR-EXT-003 保守序同口径)。真实 worker 线程
 *   装配由接线批注入 dispatch,本核只定义协议与预算。
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
  /**
   * HR-EXT-004:该 provider 声明所需能力(workspace/network/exec)。
   * 可选=最小权限声明面:缺省/未声明=未声明任何能力,宿主按缺省权限策略
   * 对其需声明面一律拒(不静默放行)。声明=宿主挂载期判定依据,不改变
   * 本核 resolve* 解析序(权限判定由宿主显式调用策略)。
   */
  readonly permissions?: readonly HotReloadProviderPermission[];
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

/** HR-EXT-003 资格判定结论:auto=可自动发送;manual=人工确认;restart=需重启 */
export type HotReloadEligibilityDecision = 'auto' | 'manual' | 'restart';

/** HR-EXT-003 判定上下文:触发源+def 结构判定+是否用户显式动作 */
export interface HotReloadEligibilityContext {
  /** 触发源(watcher-auto=自动面;command/temp-edit/retry=人工链) */
  readonly trigger?: 'watcher-auto' | 'command' | 'temp-edit' | 'retry';
  /**
   * def 结构闸 verdict 的 reasons(RUST-397 createDefStructuralGate.check 产物,
   * 非空=结构性变更需重启);规则不重算结构判定,只消费闸的结论。
   */
  readonly structuralReasons?: readonly string[];
  /** 用户显式动作(命令/临时编辑)=人工链,不判 auto */
  readonly userInitiated?: boolean;
}

/** HR-EXT-003 资格判定输入(四要素:engine profile、root、文件类型、上下文) */
export interface HotReloadEligibilityInput {
  /** 引擎档案(版本化);null/未知版本=保守 manual,不自动发未知引擎 */
  readonly profile?: EngineProfile | null;
  /** 脚本资源根;空/缺=模块解析不可用,保守 manual */
  readonly root?: string | null;
  /** 文件 URI(文件类型判据:.py=可热更;其余保守 manual) */
  readonly fileUri?: string;
  readonly context?: HotReloadEligibilityContext;
}

/**
 * HR-EXT-003 资格判定规则(版本化扩展面):按 engine profile、root、文件类型、
 * 上下文判定 auto/manual/restart。fork/第三方引擎=换 rule 实现整面接管分类;
 * 默认实现只做保守组合判定,不自创结构分析(restart 消费既有 def 闸结论)。
 */
export interface HotReloadEligibilityRule {
  readonly providerId: string;
  readonly apiVersion: typeof HOT_RELOAD_PLUGIN_API_VERSION;
  decide(input: HotReloadEligibilityInput): HotReloadEligibilityDecision;
}

/**
 * HR-EXT-003 缺省资格判定规则(保守序):
 * ① restart 最强:结构闸 reasons 非空(既有 def 闸结论,不重算);
 * ② auto 须四要素齐备:.py 文件+root 已配+引擎版本已知+触发源 watcher-auto
 *    且非用户显式动作——任何一缺=manual,绝不自动发未知引擎/未知根/非 py;
 * ③ 其余=manual(人工确认,安全缺省)。
 */
export function createDefaultHotReloadEligibilityRule(): HotReloadEligibilityRule {
  return {
    providerId: 'kbengine.default-eligibility',
    apiVersion: HOT_RELOAD_PLUGIN_API_VERSION,
    decide: input => {
      const context = input.context;
      // ① def 结构变(闸结论)=restart,优先于一切
      if (context?.structuralReasons !== undefined && context.structuralReasons.length > 0) {
        return 'restart';
      }
      // ② 四要素齐备才 auto;缺一保守 manual
      const isPython = /\.py$/i.test(input.fileUri ?? '');
      const rootKnown = (input.root ?? '').length > 0;
      const engineKnown = input.profile !== null && input.profile !== undefined && input.profile.engineVersion !== null;
      const autoTrigger = context?.trigger === 'watcher-auto' && context?.userInitiated !== true;
      if (isPython && rootKnown && engineKnown && autoTrigger) {
        return 'auto';
      }
      // ③ 安全缺省
      return 'manual';
    }
  };
}

/**
 * HR-EXT-004 第三方 provider 能力声明(版本化):workspace=工作区文件访问,
 * network=联网(发送/引擎查询),exec=进程(含隔离 Worker/RPython 插件)。
 * 第三方必须显式声明所需能力,宿主按缺省最小权限策略判定能否挂载。
 */
export type HotReloadProviderPermission = 'workspace' | 'network' | 'exec';

/**
 * HR-EXT-004 需声明的能力面(未列面=纯逻辑面,无权限要求):
 * send=发送热更(联网);fetch-digest=引擎摘要获取(读文件或查引擎);
 * read-workspace=工作区文件访问;spawn-process=起进程/Worker。
 */
export type HotReloadProviderFace = 'send' | 'fetch-digest' | 'read-workspace' | 'spawn-process';

/** HR-EXT-004 权限判定产物:granted=false 时点名缺失项与原因(可审不静默) */
export interface HotReloadPermissionVerdict {
  readonly granted: boolean;
  readonly face: HotReloadProviderFace;
  readonly missing: readonly HotReloadProviderPermission[];
  readonly reason?: string;
}

/**
 * HR-EXT-004 权限策略(版本化扩展面):按 provider 声明判定能否挂到能力面。
 * acceptableDeclarations 返回该面任一「可满足声明集」(声明集⊆provider.permissions
 * 即合格,多组=多通道皆可,fork 可换策略整面接管)。check 对 provider 求最优
 * (缺失最少)声明集,granted=其缺失为空。
 */
export interface HotReloadPermissionPolicy {
  readonly policyId: string;
  readonly apiVersion: typeof HOT_RELOAD_PLUGIN_API_VERSION;
  acceptableDeclarations(face: HotReloadProviderFace): readonly (readonly HotReloadProviderPermission[])[];
  check(provider: Pick<HotReloadProvider, 'providerId' | 'permissions'>, face: HotReloadProviderFace): HotReloadPermissionVerdict;
}

/**
 * HR-EXT-004 缺省权限策略(最小权限):
 * - send=必声明 network(目的地另受 HR-HTTP-001 端点策略闸,本面只管能力);
 * - fetch-digest=workspace 或 network 任一声明即可(取摘要走文件读或走引擎
 *   查询,两条通道实现按自身选择,都声明也无妨);
 * - read-workspace=必声明 workspace;
 * - spawn-process=必声明 exec。
 * 未声明 permissions(缺省/空)=对上述任何面都 granted=false 且缺失点名,
 * 绝不静默放行——第三方不得未声明即截获保存事件/联网/起进程。
 */
export function createDefaultHotReloadPermissionPolicy(): HotReloadPermissionPolicy {
  const table: Record<HotReloadProviderFace, readonly (readonly HotReloadProviderPermission[])[]> = {
    send: [['network']],
    'fetch-digest': [['workspace'], ['network']],
    'read-workspace': [['workspace']],
    'spawn-process': [['exec']]
  };
  return {
    policyId: 'kbengine.default-permission',
    apiVersion: HOT_RELOAD_PLUGIN_API_VERSION,
    acceptableDeclarations: face => table[face],
    check: (provider, face) => {
      const declared = [...new Set(provider.permissions ?? [])];
      const alternatives = table[face];
      let best: readonly HotReloadProviderPermission[] = alternatives[0] ?? [];
      let bestMissing = best.filter(p => !declared.includes(p));
      for (const candidate of alternatives.slice(1)) {
        const missing = candidate.filter(p => !declared.includes(p));
        if (missing.length < bestMissing.length) {
          best = candidate;
          bestMissing = missing;
        }
      }
      if (bestMissing.length === 0) {
        return { granted: true, face, missing: [] };
      }
      return {
        granted: false,
        face,
        missing: bestMissing,
        reason: `provider ${provider.providerId} 未声明 ${bestMissing.join('/')} 权限,不得挂到 ${face} 面`
      };
    }
  };
}

/**
 * HR-EXT-005 贡献面:Python 插件经隔离 Worker 可贡献的 adapter 种类。
 * eligibility=资格判定(HR-EXT-003 的 worker 侧实现);response=发送结果解释
 * (HR-EXT-001 interpretResponse 的 worker 侧实现)。隔离=实现跑在独立线程/
 * 进程,不占 extension host 主线程;本核只定义协议与预算,真实 worker 装配
 * 由接线批注入 dispatch。
 */
export type HotReloadWorkerContributionKind = 'eligibility' | 'response';

/**
 * HR-EXT-005 Worker 任务(版本化消息协议):kind + 对应输入。
 * eligibility 输入=HotReloadEligibilityInput;response 输入=HotReloadProviderInterpretInput。
 */
export interface HotReloadWorkerTask {
  readonly kind: HotReloadWorkerContributionKind;
  readonly input: HotReloadEligibilityInput | HotReloadProviderInterpretInput;
  /** 任务关联 id(结果↔任务回执用;缺省=无) */
  readonly correlationId?: string;
}

/**
 * HR-EXT-005 Worker 结果(版本化):ok=true 带 value(kind 对应的判定/解释产物),
 * ok=false 带 error(worker 侧如实错误)。
 */
export type HotReloadWorkerResult =
  | { readonly ok: true; readonly value: HotReloadEligibilityDecision | HotReloadProviderInterpretation }
  | { readonly ok: false; readonly error?: string };

/**
 * HR-EXT-005 派发结局(预算化三态如实):resolved=预算内拿到结果;
 * timed-out=预算内未回(worker 可能仍慢,结果被丢弃,槽位按预算释放);
 * rejected=无适配器/背压/派发拒绝。
 */
export type HotReloadWorkerOutcome =
  | { readonly state: 'resolved'; readonly result: HotReloadWorkerResult }
  | { readonly state: 'timed-out' }
  | { readonly state: 'rejected'; readonly error: string };

/**
 * HR-EXT-005 版本化 Worker adapter 贡献面(fork/Python 插件=实现+注册):
 * 声明自己贡献的 kind(只接自声明 kind,未声明的任务=no-adapter 语义),
 * 声明自身预算(缺省=宿主 defaultBudgetMs),dispatch=送任务到隔离 worker。
 */
export interface HotReloadWorkerAdapter {
  readonly adapterId: string;
  readonly apiVersion: typeof HOT_RELOAD_PLUGIN_API_VERSION;
  readonly contributes: readonly HotReloadWorkerContributionKind[];
  /** 声明自身预算(毫秒);缺省=宿主 defaultBudgetMs;超时=timed-out 不无界等 */
  readonly declaredTimeoutMs?: number;
  dispatch(task: HotReloadWorkerTask): Promise<HotReloadWorkerResult>;
}

/**
 * HR-EXT-005 预算化派发(核心非阻塞原语):hot path 绝不等 worker 超过
 * budgetMs。超时=timed-out(调用方回落保守,不阻塞管线——这正是
 * 「不允许在热路径无界阻塞」的落点);dispatch 拒绝=rejected 如实;
 * 预算内拿到=resolved。底层 dispatch 超时后仍可能迟回,其结果被丢弃,
 * 但调用方已按预算继续(不泄漏等待)。
 */
export async function dispatchWorkerWithBudget(
  adapter: Pick<HotReloadWorkerAdapter, 'adapterId' | 'dispatch'>,
  task: HotReloadWorkerTask,
  budgetMs: number
): Promise<HotReloadWorkerOutcome> {
  return await new Promise<HotReloadWorkerOutcome>(resolve => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      resolve({ state: 'timed-out' });
    }, budgetMs);
    void adapter.dispatch(task).then(
      result => {
        if (settled) return; // 已超时:结果被丢弃
        clearTimeout(timer);
        resolve({ state: 'resolved', result });
      },
      error => {
        if (settled) return;
        clearTimeout(timer);
        resolve({ state: 'rejected', error: String((error as Error)?.message ?? error) });
      }
    );
  });
}

/**
 * HR-EXT-005 资格判定超时保守产物:worker 未在预算内判定时,hot path 回落
 * manual(不自动发——与 HR-EXT-003 保守序同口径,绝不因 worker 慢而越权 auto)。
 */
export const WORKER_TIMEOUT_ELIGIBILITY_FALLBACK: HotReloadEligibilityDecision = 'manual';

/** HR-EXT-005 Worker 宿主输入:adapter 集+缺省预算+背压上限 */
export interface HotReloadWorkerHostInput {
  readonly adapters?: readonly HotReloadWorkerAdapter[];
  /** 缺省预算(adapter 未声明 declaredTimeoutMs 时用);缺省 2000ms */
  readonly defaultBudgetMs?: number;
  /** 在途硬上限(背压):满则新任务 rejected=worker backpressure,不无界排队 */
  readonly maxInFlight?: number;
}

/** HR-EXT-005 Worker 宿主:按 kind 选 adapter,预算化派发,背压有界 */
export interface HotReloadWorkerHost {
  dispatch(task: HotReloadWorkerTask): Promise<HotReloadWorkerOutcome>;
  /** 自省:当前在途任务数(测试/装配面核查) */
  readonly inFlightCount: () => number;
  /** 生命周期:拒绝后续派发(装配面挂 dispose;重建即新宿主) */
  dispose(): void;
}

/**
 * HR-EXT-005 Worker 宿主:适配器按 kind 首见胜(contributes 含该 kind);
 * 无适配器=rejected no-adapter(如实,不静默回落——worker 面有贡献才可用,
 * 未贡献=保守走宿主既有面);在途达上限=rejected backpressure(有界排队,
 * 绝不在 hot path 无界堆积);派发=预算化(adapter 声明预算或宿主缺省)。
 * dispose 置位后新派发一律 rejected disposed。
 */
export function createHotReloadWorkerHost(input: HotReloadWorkerHostInput = {}): HotReloadWorkerHost {
  const adapters = [...(input.adapters ?? [])];
  const defaultBudgetMs = input.defaultBudgetMs ?? 2000;
  const maxInFlight = input.maxInFlight ?? 8;
  let active = 0;
  let disposed = false;
  const dispatch = async (task: HotReloadWorkerTask): Promise<HotReloadWorkerOutcome> => {
    if (disposed) {
      return { state: 'rejected', error: 'worker host disposed' };
    }
    const adapter = adapters.find(a => a.contributes.includes(task.kind));
    if (!adapter) {
      return { state: 'rejected', error: `no adapter contributes ${task.kind}` };
    }
    if (active >= maxInFlight) {
      return { state: 'rejected', error: 'worker backpressure' };
    }
    active += 1;
    try {
      return await dispatchWorkerWithBudget(adapter, task, adapter.declaredTimeoutMs ?? defaultBudgetMs);
    } finally {
      active -= 1;
    }
  };
  return {
    dispatch,
    inFlightCount: () => active,
    dispose: () => {
      disposed = true;
    }
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
