/**
 * Hot reload plugin API pure core (HR-PR-08, book §19.4 plugin-api):
 * - Versioned extension interfaces for the three faces HotReloadProvider/
 *   FingerprintProvider/EngineProfile: apiVersion='1' pins the interface
 *   shape; later incompatible changes bump the major version, so consumers
 *   can reject old implementations by version (instead of silently
 *   misreading them);
 * - FingerprintProvider default implementation=defaultHotReloadFingerprintProvider,
 *   a pure delegation to the existing proven core (hashDefContent/
 *   semanticFingerprintReport/negotiateEngineDigest); it invents no hashing
 *   and never guesses the engine's algorithm for it (HR-HASH-005/006
 *   discipline inherited verbatim); fork/version drift=swap the provider
 *   implementation, the default implementation only knows the default
 *   engine; HR-EXT-002 adds two more **optional** slots: compare (delegates
 *   the compareFingerprints three-way compare, invents no verdict) +
 *   fetchEngineDigest (pure core zero IO, defaults to honestly not-wired
 *   =null; real fetching and the tier/verified/compatible confidence
 *   verdicts live in the wiring layer at RUST-404 defMd5Check, this face
 *   does not re-declare confidence) -- backward compatible,
 *   apiVersion is not bumped;
 * - HotReloadProvider face: transport-faithful sending (canSend probe +
 *   send passes the send result through); the send orchestration itself
 *   still belongs to the existing tempEdit/executor faces, this core only
 *   defines the slot shapes and registry resolution; HR-EXT-001 adds four
 *   more **optional** lifecycle slots
 *   (resolveModule/prepareRequest/interpretResponse/queryAppliedRevision):
 *   default slots compose the existing core (resolution core/request shape/
 *   seven-category classification core, queryAppliedRevision unwired =
 *   honestly null), implementation-provided slots win -- backward
 *   compatible, apiVersion is not bumped
 *   (same discipline as the HR-HTTP-002 incremental fields);
 * - Registry: registered by id (duplicate ids honestly rejected), resolve
 *   asks canHandle in order per profile, the first responder wins; nobody
 *   answers=null (honestly no provider, no guessing and no fallback to a
 *   default -- hot reload writes engine memory, fallback=the default
 *   implementation impersonating the user's environment);
 * - EngineProfile versioned: {apiVersion, engineVersion (probe artifact or
 *   null), fingerprint: FingerprintProfile} -- engineVersion null=unknown
 *   stated honestly, never fabricated (engineVersionDetect same convention);
 * - HR-EXT-003 eligibility rules (HotReloadEligibilityRule): decide
 *   auto/manual/restart from engine profile/root/file type/context; the
 *   default rule only makes the conservative composition decision
 *   (restart consumes the existing def gate verdict without recomputing
 *   structure; auto requires all four elements, any one missing means
 *   manual), fork=swap the rule implementation to take over the whole
 *   classification face;
 * - HR-EXT-004 permission declarations (HotReloadProviderPermission): a
 *   third-party provider must declare the capabilities it needs (workspace
 *   file access/network/exec process) before it can attach to the matching
 *   capability faces -- default policy=least privilege; a provider without
 *   declared permissions gets granted=false on every gated face (honest
 *   rejection, never silently allowed through: third parties must not
 *   intercept save events/go online/spawn processes undeclared). This core
 *   only defines the declaration shape and decision policy; the real
 *   rejection point is the host wiring mount phase (the policy is invoked
 *   by the host, the resolve* resolution order keeps the no-permission
 *   assumption), complementary and non-overlapping with the HR-HTTP-001
 *   endpoint policy (RUST-420, which only governs request destination);
 * - HR-EXT-005 isolated worker contribution face (HotReloadWorkerAdapter):
 *   Python plugins contribute eligibility/response adapters through an
 *   isolated worker; budgeted dispatch (dispatchWorkerWithBudget:
 *   timeout=timed-out instead of unbounded waiting, slots released per
 *   budget) + bounded backpressure (in-flight cap, full=rejected instead
 *   of queued) -- the hot path never blocks unboundedly; the conservative
 *   product of an eligibility timeout=manual (same convention as the
 *   HR-EXT-003 conservative order). Real worker thread wiring is injected
 *   into dispatch by the wiring batch; this core only defines protocol and
 *   budget.
 * Pure logic, zero vscode; real extension host wiring (registration timing/
 * lifecycle) comes with the wiring batch.
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

/** Plugin API version: bump when the interface shape changes incompatibly */
export const HOT_RELOAD_PLUGIN_API_VERSION = '1';

/** HR-EXT-002 engine digest fetch input (workspace/root identity; the implementation fetches via its own channel) */
export interface FingerprintEngineDigestInput {
  readonly workspaceId?: string;
  readonly rootId?: string;
}

/** HR-HASH-006 fingerprint slots (versioned; the default implementation delegates to the existing core) */
export interface FingerprintProvider {
  readonly providerId: string;
  readonly apiVersion: typeof HOT_RELOAD_PLUGIN_API_VERSION;
    /** Engine digest negotiation (passes through negotiateEngineDigest semantics; implementations may swap the algorithm face per fork) */
  negotiateDigest(engineDigest?: string): DefDigestHandshake;
    /** Client fileHash (sha256 raw bytes; implementations must not invent their own hashing) */
  fileHash(content: string): DefContentHash;
    /** Semantic fingerprint report (version + scope stated honestly) */
  semanticFingerprint(text: string): SemanticFingerprintReport;
    /** profile label (negotiated algorithm=the algorithm name, otherwise not available) */
  profileLabel(engineDigest?: string): FingerprintProfile;
    /**
   * HR-EXT-002 three-way compare (delegates the compareFingerprints semantics;
   * implementations may swap the verdict face per fork).
   * Optional=the default slot falls back to the existing compareFingerprints
   * core, inventing no compare logic.
   */
  readonly compare?: (input: FingerprintTriCompareInput) => FingerprintTriVerdict;
    /**
   * HR-EXT-002 engine digest fetch (declares the slot shape; implementation =
   * fetch the real engine digest via its own channel).
   * Pure core zero IO: defaults to honestly not-wired=null (no fabricated
   * engine digest); real fetching happens in the wiring layer
   * (RUST-404 defMd5Check, which also yields the tier/verified/compatible
   * confidence verdicts); this slot only declares the "fetch digest"
   * boundary and does not re-declare confidence.
   */
  readonly fetchEngineDigest?: (input?: FingerprintEngineDigestInput) => Promise<string | null>;
}

/** Default fingerprint implementation: pure delegation to hashDefContent/semanticFingerprintReport/negotiateEngineDigest */
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
 * Send result (transport-faithful: the implementation passes through ok/detail
 * from its own channel; this core does not interpret them).
 * HR-HTTP-002 increments are optional fields: the HTTP channel implementation
 * passes through per-file structured outcomes; other channels (if any) simply
 * omit them when they do not produce any -- apiVersion is not bumped
 * (backward compatible).
 */
export interface HotReloadProviderSendResult {
  readonly ok: boolean;
  readonly detail?: string;
  /** HR-HTTP-002: per-file structured outcome (category + correlation id; omitted=the implementation produces none) */
  readonly outcomes?: readonly HttpRequestOutcome[];
  /** HR-HTTP-002: request correlation id receipt (result <-> request association; absent=none) */
  readonly correlationId?: string;
  /** HR-HTTP-002: request revision receipt (result <-> revision association, the HR-HTTP-013 CAS foundation) */
  readonly revision?: string;
}

/**
 * Send request (target + file set; orchestration is up to the implementation,
 * the shape is versioned).
 * HR-HTTP-002 increments=optional fields (module identity/revision/
 * correlation id); the default behavior stays verbatim identical to
 * pre-increment: implementations derive the module name themselves and
 * generate a correlation id per execution.
 */
export interface HotReloadProviderSendRequest {
  readonly targetId: string;
  readonly files: readonly string[];
  /** HR-HTTP-002: per-file module identity (parallel to files; omitted/empty=the implementation derives it per file) */
  readonly moduleIdentities?: readonly string[];
  /** HR-HTTP-002: request revision (for result association; whether the wire carries it is up to the channel implementation) */
  readonly revision?: string;
  /** HR-HTTP-002: request correlation id (omitted=the implementation generates one per execution) */
  readonly correlationId?: string;
}

/**
 * HR-EXT-001 lifecycle resolve input: module identity resolution
 * (file -> module name).
 * scriptRoots/allowRootLevelStem omitted=the defaults used when the wiring
 * layer built the default slot; given explicitly=this call overrides (per-call
 * override, not sticky across calls).
 */
export interface HotReloadProviderResolveInput {
  readonly fileUri: string;
  readonly workspaceId?: string;
  readonly rootId?: string;
  /** Overrides the wiring layer's default root candidates; omitted=use the wiring layer defaults */
  readonly scriptRoots?: readonly string[];
  /** HR-MOD-006 explicit priority (lower index=highest priority, same order as scriptRoots);
   * when more than one root hits, only the uniquely lowest-rank candidate wins;
   * omitted=the existing no-guessing rejection. */
  readonly rootPriority?: readonly string[];
  /** Overrides the wiring layer's default single-level fallback; omitted=use the wiring layer default */
  readonly allowRootLevelStem?: boolean;
  /** User-explicit module name override (passes through the existing HR-MOD-007 semantics) */
  readonly userOverrideModule?: string;
}

/** Resolve result (reuses the existing resolution core's product shape, with honest no-root/ambiguity diagnostics) */
export type HotReloadProviderResolveResult = HotReloadModuleResolution;

/** HR-EXT-001 lifecycle prepare input: target + resolved identity + revision/correlation id (optional) */
export interface HotReloadProviderPrepareInput {
  readonly targetId: string;
  readonly identity: HotReloadModuleIdentity;
  readonly revision?: string;
  readonly correlationId?: string;
}

/** HR-EXT-001 lifecycle interpret input: the send result passed through as-is */
export interface HotReloadProviderInterpretInput {
  readonly ok: boolean;
  readonly detail?: string;
}

/** HR-EXT-001 interpretation product: ok passed through; failure=seven-category reason classification + label + hint */
export interface HotReloadProviderInterpretation {
  readonly ok: boolean;
  readonly reason?: HotReloadErrorReason;
  readonly label?: string;
  readonly hint?: string;
}

/** HR-EXT-001 applied-revision query input */
export interface HotReloadProviderRevisionQuery {
  readonly targetId: string;
  readonly identity: HotReloadModuleIdentity;
}

/** HR-EXT-001 applied-revision product: the source stated honestly (engine receipt/ledger/receipt face) */
export interface HotReloadProviderAppliedRevision {
  readonly revision: string;
  readonly source: 'engine' | 'ledger' | 'receipt';
}

/**
 * HR-PR-08 hot reload send slot (implementation=a concrete channel; no
 * default implementation, honestly null).
 * HR-EXT-001: beyond the send face (canSend/send), adds four **optional**
 * lifecycle slots (resolveModule/prepareRequest/interpretResponse/
 * queryAppliedRevision); optional=default slots fall back
 * (createDefaultHotReloadLifecycleSlots composes the existing core),
 * backward compatible: pre-increment implementations (only canSend/send) keep
 * their shape unchanged, apiVersion is not bumped.
 */
export interface HotReloadProvider {
  readonly providerId: string;
  readonly apiVersion: typeof HOT_RELOAD_PLUGIN_API_VERSION;
  readonly displayName: string;
  /** Whether this implementation can handle the engine profile (fork/version drift is dispatched here) */
  canSend(profile: EngineProfile): boolean;
  send(request: HotReloadProviderSendRequest): Promise<HotReloadProviderSendResult> | HotReloadProviderSendResult;
  /** HR-EXT-001: file -> module identity (implementations may swap the resolution face; omitted=delegates to the existing resolution core) */
  readonly resolveModule?: (input: HotReloadProviderResolveInput) => HotReloadProviderResolveResult;
  /** HR-EXT-001: target + identity -> request (implementations may swap request assembly; omitted=passes through the existing send request shape) */
  readonly prepareRequest?: (input: HotReloadProviderPrepareInput) => HotReloadProviderSendRequest;
  /** HR-EXT-001: send result -> classified interpretation (implementations may swap the error classification face; omitted=delegates to the existing seven-category classification core) */
  readonly interpretResponse?: (input: HotReloadProviderInterpretInput) => HotReloadProviderInterpretation;
  /** HR-EXT-001: applied-revision query (implementations may hook engine receipts; omitted=null, honestly unwired) */
  readonly queryAppliedRevision?: (input: HotReloadProviderRevisionQuery) => HotReloadProviderAppliedRevision | null;
  /**
   * HR-EXT-004: the capabilities this provider declares (workspace/network/exec).
   * Optional=least-privilege declaration face: omitted/undeclared=declares no
   * capability, and the host's default permission policy rejects it on every
   * gated face (never silently allowed through). Declaring=the evidence the
   * host uses at mount time; it does not change this core's resolve*
   * resolution order (permission decisions are made by the host explicitly
   * invoking the policy).
   */
  readonly permissions?: readonly HotReloadProviderPermission[];
}

/** HR-EXT-001 full lifecycle slot set (default slot shape=composes the existing core) */
export type HotReloadLifecycleSlots = Required<
  Pick<HotReloadProvider, 'resolveModule' | 'prepareRequest' | 'interpretResponse' | 'queryAppliedRevision'>
>;

/**
 * HR-EXT-001 default lifecycle slots: composes the existing core (resolution
 * core/send request shape/seven-category classification core), inventing no
 * resolution and no error classification of its own. queryAppliedRevision=
 * honestly null (unwired, not fabricated).
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
        ...(resolveInput.rootPriority !== undefined ? { rootPriority: resolveInput.rootPriority } : {}),
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

/** HR-EXT-001 resolved lifecycle: provider + its slots (missing slots already fell back, not a half-state) */
export interface HotReloadResolvedLifecycle {
  readonly provider: HotReloadProvider;
  readonly slots: HotReloadLifecycleSlots;
}

/** Engine profile (versioned): probed version + fingerprint profile; unknown version=null, stated honestly */
export interface EngineProfile {
  readonly apiVersion: typeof HOT_RELOAD_PLUGIN_API_VERSION;
  /** Probe artifact (engineVersionDetect); null=unknown stated honestly, never fabricated */
  readonly engineVersion: string | null;
  readonly fingerprint: FingerprintProfile;
}

/** Assemble the engine profile (pure: probe values + negotiation input are both caller-supplied, this core does no IO) */
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

/** HR-EXT-003 eligibility decision: auto=can send automatically; manual=human confirmation; restart=restart required */
export type HotReloadEligibilityDecision = 'auto' | 'manual' | 'restart';

/** HR-EXT-003 decision context: trigger source + def structure verdict + whether it is a user-explicit action */
export interface HotReloadEligibilityContext {
  /** Trigger source (watcher-auto=automatic face; command/temp-edit/retry=human chain) */
  readonly trigger?: 'watcher-auto' | 'command' | 'temp-edit' | 'retry';
  /**
   * Reasons of the def structural gate verdict (RUST-397
   * createDefStructuralGate.check product; non-empty=structural change that
   * needs a restart); the rule does not recompute the structural verdict,
   * it only consumes the gate's conclusion.
   */
  readonly structuralReasons?: readonly string[];
  /** User-explicit action (command/temp edit)=human chain, never auto */
  readonly userInitiated?: boolean;
}

/** HR-EXT-003 eligibility input (four elements: engine profile, root, file type, context) */
export interface HotReloadEligibilityInput {
  /** Engine profile (versioned); null/unknown version=conservative manual, never auto-send to an unknown engine */
  readonly profile?: EngineProfile | null;
  /** Script asset root; empty/omitted=module resolution unavailable, conservative manual */
  readonly root?: string | null;
  /** File URI (file-type criterion: .py=hot-reloadable; anything else=conservative manual) */
  readonly fileUri?: string;
  readonly context?: HotReloadEligibilityContext;
}

/**
 * HR-EXT-003 eligibility rule (versioned extension face): decide
 * auto/manual/restart from engine profile, root, file type, and context.
 * Fork/third-party engines=swap the rule implementation to take over the
 * whole classification face; the default implementation only makes the
 * conservative composition decision, inventing no structural analysis
 * (restart consumes the existing def gate verdict).
 */
export interface HotReloadEligibilityRule {
  readonly providerId: string;
  readonly apiVersion: typeof HOT_RELOAD_PLUGIN_API_VERSION;
  decide(input: HotReloadEligibilityInput): HotReloadEligibilityDecision;
}

/**
 * HR-EXT-003 default eligibility rule (conservative order):
 * ① restart is strongest: structural gate reasons non-empty (the existing
 *    def gate verdict, not recomputed);
 * ② auto requires all four elements: .py file + configured root + known
 *    engine version + watcher-auto trigger and not a user-explicit action --
 *    any one missing=manual, never auto-send to an unknown engine/unknown
 *    root/non-py;
 * ③ everything else=manual (human confirmation, safe default).
 */
export function createDefaultHotReloadEligibilityRule(): HotReloadEligibilityRule {
  return {
    providerId: 'kbengine.default-eligibility',
    apiVersion: HOT_RELOAD_PLUGIN_API_VERSION,
    decide: input => {
      const context = input.context;
      // ① def structure change (gate verdict)=restart, takes priority over everything
      if (context?.structuralReasons !== undefined && context.structuralReasons.length > 0) {
        return 'restart';
      }
      // ② auto only when all four elements are present; any missing=conservative manual
      const isPython = /\.py$/i.test(input.fileUri ?? '');
      const rootKnown = (input.root ?? '').length > 0;
      const engineKnown = input.profile !== null && input.profile !== undefined && input.profile.engineVersion !== null;
      const autoTrigger = context?.trigger === 'watcher-auto' && context?.userInitiated !== true;
      if (isPython && rootKnown && engineKnown && autoTrigger) {
        return 'auto';
      }
      // ③ safe default
      return 'manual';
    }
  };
}

/**
 * HR-EXT-004 third-party provider capability declarations (versioned):
 * workspace=workspace file access, network=network (sending/engine queries),
 * exec=process (including isolated workers/RPython plugins).
 * Third parties must explicitly declare the capabilities they need; the host
 * decides mountability per the default least-privilege policy.
 */
export type HotReloadProviderPermission = 'workspace' | 'network' | 'exec';

/**
 * HR-EXT-004 capability faces that require a declaration (unlisted faces=
 * pure-logic faces, no permission required):
 * send=hot reload sending (network); fetch-digest=engine digest fetch (file
 * read or engine query); read-workspace=workspace file access;
 * spawn-process=spawning processes/workers.
 */
export type HotReloadProviderFace = 'send' | 'fetch-digest' | 'read-workspace' | 'spawn-process';

/** HR-EXT-004 permission verdict product: when granted=false, names the missing items and the reason (auditable, not silent) */
export interface HotReloadPermissionVerdict {
  readonly granted: boolean;
  readonly face: HotReloadProviderFace;
  readonly missing: readonly HotReloadProviderPermission[];
  readonly reason?: string;
}

/**
 * HR-EXT-004 permission policy (versioned extension face): decides, from the
 * provider's declarations, whether it may attach to a capability face.
 * acceptableDeclarations returns any "satisfiable declaration set" of that
 * face (a declaration set ⊆ provider.permissions qualifies; multiple groups
 * = several channels all fine, fork may swap the policy to take over the
 * whole face). check looks for the optimal (fewest missing) declaration set
 * for the provider; granted=that set has no missing entries.
 */
export interface HotReloadPermissionPolicy {
  readonly policyId: string;
  readonly apiVersion: typeof HOT_RELOAD_PLUGIN_API_VERSION;
  acceptableDeclarations(face: HotReloadProviderFace): readonly (readonly HotReloadProviderPermission[])[];
  check(provider: Pick<HotReloadProvider, 'providerId' | 'permissions'>, face: HotReloadProviderFace): HotReloadPermissionVerdict;
}

/**
 * HR-EXT-004 default permission policy (least privilege):
 * - send=must declare network (destination is separately gated by the
 *   HR-HTTP-001 endpoint policy; this face only governs capability);
 * - fetch-digest=declaring either workspace or network suffices (digest
 *   fetching can go through a file read or through an engine query,
 *   implementations pick their own channel; declaring both is harmless);
 * - read-workspace=must declare workspace;
 * - spawn-process=must declare exec.
 * Undeclared permissions (default/empty)=granted=false on every one of the
 * above faces with the missing items named -- never silently allowed through:
 * third parties must not intercept save events/go online/spawn processes
 * without declaring.
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
 * HR-EXT-005 contribution face: the kinds of adapter a Python plugin may
 * contribute through an isolated worker.
 * eligibility=eligibility decision (the worker-side implementation of
 * HR-EXT-003); response=send result interpretation (the worker-side
 * implementation of HR-EXT-001 interpretResponse). Isolated=the
 * implementation runs on a separate thread/process, not on the extension
 * host main thread; this core only defines the protocol and budget, real
 * worker wiring is injected into dispatch by the wiring batch.
 */
export type HotReloadWorkerContributionKind = 'eligibility' | 'response';

/**
 * HR-EXT-005 worker task (versioned message protocol): kind + the matching
 * input.
 * eligibility input=HotReloadEligibilityInput; response input=
 * HotReloadProviderInterpretInput.
 */
export interface HotReloadWorkerTask {
  readonly kind: HotReloadWorkerContributionKind;
  readonly input: HotReloadEligibilityInput | HotReloadProviderInterpretInput;
  /** Task correlation id (used to associate the result back with the task; omitted=none) */
  readonly correlationId?: string;
}

/**
 * HR-EXT-005 worker result (versioned): ok=true carries value (the decision/
 * interpretation product matching kind), ok=false carries error (the honest
 * error from the worker side).
 */
export type HotReloadWorkerResult =
  | { readonly ok: true; readonly value: HotReloadEligibilityDecision | HotReloadProviderInterpretation }
  | { readonly ok: false; readonly error?: string };

/**
 * HR-EXT-005 dispatch outcome (budgeted three states, honestly stated):
 * resolved=result obtained within the budget; timed-out=no reply within the
 * budget (the worker may still be slow, its result is discarded, the slot is
 * released per the budget); rejected=no adapter/backpressure/dispatch refused.
 */
export type HotReloadWorkerOutcome =
  | { readonly state: 'resolved'; readonly result: HotReloadWorkerResult }
  | { readonly state: 'timed-out' }
  | { readonly state: 'rejected'; readonly error: string };

/**
 * HR-EXT-005 versioned worker adapter contribution face (fork/Python plugins =
 * implementation + registration): declares the kind it contributes (it only
 * accepts kinds it self-declared; a task of an undeclared kind=no-adapter
 * semantics), declares its own budget (defaults to the host defaultBudgetMs),
 * dispatch=sends the task to the isolated worker.
 */
export interface HotReloadWorkerAdapter {
  readonly adapterId: string;
  readonly apiVersion: typeof HOT_RELOAD_PLUGIN_API_VERSION;
  readonly contributes: readonly HotReloadWorkerContributionKind[];
  /** Declares its own budget (milliseconds); defaults to the host defaultBudgetMs; timeout=timed-out, never waits unboundedly */
  readonly declaredTimeoutMs?: number;
  dispatch(task: HotReloadWorkerTask): Promise<HotReloadWorkerResult>;
}

/**
 * HR-EXT-005 budgeted dispatch (the core non-blocking primitive): the hot path
 * never waits on a worker beyond budgetMs. Timeout=timed-out (the caller
 * falls back conservatively, not blocking the pipeline -- this is exactly
 * where "unbounded blocking on the hot path is not allowed" lands);
 * dispatch refusal=rejected, honestly; obtained within budget=resolved.
 * The underlying dispatch may still reply late after the timeout, its result
 * is discarded, but the caller has already continued per the budget (no
 * leaked waiting).
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
        if (settled) return; // already timed out: the result is discarded
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
 * HR-EXT-005 conservative product of an eligibility timeout: when the worker
 * does not decide within budget, the hot path falls back to manual (no auto
 * send -- same convention as the HR-EXT-003 conservative order; a slow worker
 * never grants an unearned auto).
 */
export const WORKER_TIMEOUT_ELIGIBILITY_FALLBACK: HotReloadEligibilityDecision = 'manual';

/** HR-EXT-005 worker host input: adapter set + default budget + backpressure cap */
export interface HotReloadWorkerHostInput {
  readonly adapters?: readonly HotReloadWorkerAdapter[];
  /** Default budget (used when an adapter does not declare declaredTimeoutMs); defaults to 2000ms */
  readonly defaultBudgetMs?: number;
  /** Hard in-flight cap (backpressure): when full, new tasks are rejected=worker backpressure, never queued unboundedly */
  readonly maxInFlight?: number;
}

/** HR-EXT-005 worker host: picks an adapter by kind, dispatches with a budget, backpressure is bounded */
export interface HotReloadWorkerHost {
  dispatch(task: HotReloadWorkerTask): Promise<HotReloadWorkerOutcome>;
  /** Introspection: the current number of in-flight tasks (for tests / wiring-layer checks) */
  readonly inFlightCount: () => number;
  /** Lifecycle: refuse further dispatch (the wiring layer hooks dispose; rebuilding means a fresh host) */
  dispose(): void;
}

/**
 * HR-EXT-005 worker host: adapters win by first sighting per kind (its
 * contributes includes that kind); no adapter=rejected no-adapter (stated
 * honestly, never a silent fallback -- the worker face is only usable once
 * something contributes; no contribution=conservatively use the host's
 * existing faces); in-flight at the cap=rejected backpressure (bounded
 * queueing, never an unbounded pile-up on the hot path); dispatch=budgeted
 * (the adapter's declared budget or the host default).
 * After dispose is set, new dispatches are all rejected disposed.
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

/** Registry rejection reasons (stated honestly, auditable) */
export type HotReloadRegistryRejectReason = 'duplicate-id' | 'api-version-mismatch';

export interface HotReloadRegistryRejection {
  readonly providerId: string;
  readonly reason: HotReloadRegistryRejectReason;
}

/** Runtime provider crash (HR-QA-014 RUST-426): the honest reporting face for canSend throwing */
export interface HotReloadProviderError {
  readonly providerId: string;
  readonly error: unknown;
}

/**
 * Provider registry: registrations with a duplicate id or a mismatching
 * apiVersion are rejected honestly (returning the rejection reason, never
 * silently replacing or silently absorbing them); resolve asks canSend in
 * order per profile, the responder wins, nobody answers=null (no fallback to
 * a default -- hot reload writes engine memory).
 * Crash isolation (RUST-426): a provider whose canSend throws is reported
 * honestly (onProviderError) and skipped, continuing to ask the next one --
 * a single plugin crash never propagates to the caller (the core/main thread
 * is not interrupted), nor is it silently swallowed (the reporting face must
 * be wired; the wiring layer decides audit/status handling).
 */
export class HotReloadProviderRegistry {
  private readonly sendProviders = new Map<string, HotReloadProvider>();
  private readonly onProviderError?: (error: HotReloadProviderError) => void;

  constructor(input: { onProviderError?: (error: HotReloadProviderError) => void } = {}) {
    this.onProviderError = input.onProviderError;
  }

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

  /** Resolve the send provider: the first canSend responder wins; nobody answers/null profile=null */
  resolveSendProvider(profile: EngineProfile | null): HotReloadProvider | null {
    if (!profile || profile.apiVersion !== HOT_RELOAD_PLUGIN_API_VERSION) {
      return null;
    }
    for (const provider of this.sendProviders.values()) {
      let responds = false;
      try {
        responds = provider.canSend(profile);
      } catch (error) {
        // RUST-426 crash isolation: one plugin's canSend throwing = skip +
        // report honestly, never propagating to the caller (the core/main
        // thread is not interrupted by a single plugin crash), then keep
        // asking the next responder.
        this.onProviderError?.({ providerId: provider.providerId, error });
        continue;
      }
      if (responds) {
        return provider;
      }
    }
    return null;
  }

  /**
   * HR-EXT-001 resolve the lifecycle: pick the send provider per profile, then
   * merge its four lifecycle slots with the default slots (implementation
   * slots win, missing slots fall back to the default composed core).
   * Nobody answers/null profile=honestly null (no default fallback, same
   * convention as resolveSendProvider).
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

  /** Introspection: the registration id order (for tests / wiring-layer checks) */
  registeredSendProviderIds(): string[] {
    return [...this.sendProviders.keys()];
  }

  /** Lifecycle: clear all registrations (the host dispose face; re-registering means rebuilding, never a half-state) */
  clear(): void {
    this.sendProviders.clear();
  }
}
