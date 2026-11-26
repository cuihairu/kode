/**
 * Hot reload module identity pure face (HR-PR-02, book
 * docs/kode2/KODE_2_COMPLETE_TODO.md §19.3):
 * - HR-MOD-001 the `HotReloadModuleIdentity` nine-field DTO (workspaceId/
 *   rootId/fileUri/fullModule/requestModule/fileStem/parentName/language/
 *   sourceVersion);
 * - HR-MOD-002 pure resolver: inputs are the URI, explicit resource roots
 *   (single or multi-root candidates), workspace identity, user override,
 *   the single-level fallback switch; output is a Result + structured
 *   diagnostics; zero IO, zero vscode imports — every input is given
 *   explicitly by the caller, this face never implicitly reads disk/config;
 * - HR-MOD-005 the single source of string semantics =
 *   hotReloadTempEdit.resolveModuleDualName (role directory stripping/`.py`
 *   suffix/`__init__`/traversal rejection are all reused; this face only
 *   does root candidate selection, URI lexical normalization, diagnostic
 *   code mapping and override, and never writes a second module-name
 *   derivation);
 * - HR-MOD-009 URI lexical normalization: file:// decoding, backslashes,
 *   UNC (WSL `//wsl$`, `//wsl.localhost`, Remote SSH mount shapes), repeated
 *   slashes, `.`/`..` lexical resolution, drive-letter upper-casing, case
 *   preservation. Symlink resolution and fs-level case semantics need
 *   realpath/platform detection, belong to IO-specific work, and the pure
 *   face does not do them (same boundary as crates/kode-vfs VFS-001).
 */

import {
  resolveModuleDualName,
  type ModuleDualNameUnsupportedReason
} from './hotReloadTempEdit';

/** HR-MOD-001: hot reload module identity nine-field DTO. Record uniqueness = targetId (channel side) + rootId + fileUri */
export interface HotReloadModuleIdentity {
  /** Workspace identity (multi-root workspace attribution); empty string when not given, no guessing */
  readonly workspaceId: string;
  /** Script resource root identity (which candidate root was hit); empty string when not given */
  readonly rootId: string;
  /** Normalized local-shape path (the canonicalizeScriptFilePath product of HR-MOD-009) */
  readonly fileUri: string;
  /** Full module name (the UI display name, book §19.1): entities.fight.FightAI */
  readonly fullModule: string;
  /** Request module name (the name actually sent, book §19.1): fight.FightAI */
  readonly requestModule: string;
  /** File name without the trailing .py: FightAI */
  readonly fileStem: string;
  /** Immediate parent directory name: fight; empty string for a root-level single-level fallback */
  readonly parentName: string;
  /** Only python is currently supported (non-.py is rejected right in the resolver) */
  readonly language: 'python';
  /** Document version (passed through by the caller, prevents an older version's result overwriting a newer one) */
  readonly sourceVersion?: number;
}

/** Structured diagnostic codes (one-to-one mapping with core's ModuleDualNameUnsupportedReason, plus three identity-face codes) */
export type HotReloadModuleDiagnosticCode =
  | 'no-root'
  | 'out-of-root'
  | 'ambiguous-root'
  | 'invalid-override'
  | 'invalid-stem'
  | 'not-python'
  | 'traversal'
  | 'empty-stem'
  | 'init-file'
  | 'root-level';

export interface HotReloadModuleDiagnostic {
  readonly code: HotReloadModuleDiagnosticCode;
  readonly message: string;
}

export type HotReloadModuleResolution =
  | { readonly ok: true; readonly identity: HotReloadModuleIdentity }
  | { readonly ok: false; readonly diagnostics: readonly HotReloadModuleDiagnostic[] };

export interface HotReloadModuleIdentityInput {
  /** file:// URI or local path (backslashes/forward slashes both fine, lexically normalized) */
  readonly fileUri: string;
  /** Workspace identity; defaults to empty string (honestly absent, no guessing) */
  readonly workspaceId?: string;
  /** Resource root identity label; defaults to empty string */
  readonly rootId?: string;
  /** Single-root convenience shape (same shape as the existing scriptRoot setting); merged into the same candidate set as scriptRoots */
  readonly scriptRoot?: string;
  /** Multi-root candidate set (HR-MOD-006: refuse when the root is not uniquely determined, no guessing) */
  readonly scriptRoots?: readonly string[];
  /** HR-MOD-006 explicit priority (smaller index = higher priority): only
   * effective when multi-root hits > 1, and only a unique minimum-rank
   * candidate wins (user-specified ordering = configuration, not guessing);
   * absent/empty = the existing refuse-without-guessing; roots not in the
   * list rank +∞ and are never promoted by priority. */
  readonly rootPriority?: readonly string[];
  /** User-specified module name: a legal one replaces fullModule/requestModule, an illegal one is refused (never a silent fallback) */
  readonly userOverrideModule?: string;
  /** HR-MOD-008 explicit single-level fallback; defaults to off = a root-level single-segment script is unresolved */
  readonly allowRootLevelStem?: boolean;
  /** Document version pass-through */
  readonly sourceVersion?: number;
}

const toPosix = (value: string): string => value.replace(/\\/g, '/');

/**
 * Lexical normalization (HR-MOD-009, pure strings, zero IO):
 * strips the scheme off a file:// URI (file://server/share keeps the `//`
 * UNC shape) + guarded percent decoding (a failed decode is kept as-is, no
 * throw); backslashes become forward slashes; repeated slashes collapse
 * (a leading `//` UNC is preserved); `.` segments are dropped and `..`
 * segments resolve lexically upward (`..` at an absolute path's root lands
 * at the root; with no base for a relative path `..` is kept and left for
 * the upper layer's traversal rejection); Windows drive letters are
 * upper-cased; all other casing is preserved (HR-MOD-003).
 */
export function canonicalizeScriptFilePath(input: string): string {
  let value = input.trim();
  if (value.length === 0) {
    return '';
  }
  if (value.toLowerCase().startsWith('file://')) {
    const rest = value.slice('file://'.length);
    // file:///c:/x → /c:/x; file://server/share → //server/share (UNC)
    value = rest.startsWith('/') ? rest : `//${rest}`;
  }
  value = toPosix(value);
  // percent decoding applies only to the path body, the UNC `//` prefix is
  // untouched; a bad escape is kept as-is, no throw
  try {
    value = decodeURIComponent(value);
  } catch {
    // Invalid percent sequence (e.g. a bare %): keep as-is, judged later as
    // a literal path
  }
  const unc = value.startsWith('//');
  const body = unc ? value.slice(2) : value;
  const collapsed = body.replace(/\/{2,}/g, '/');
  const segments = collapsed.split('/');
  const stack: string[] = [];
  const absolute = collapsed.startsWith('/');
  for (const segment of segments) {
    if (segment.length === 0 || segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (stack.length > 0) {
        stack.pop();
      } else if (!absolute) {
        stack.push(segment); // relative path with no base, `..` kept for the upper layer to reject
      }
      continue;
    }
    stack.push(segment);
  }
  let result = (absolute ? '/' : '') + stack.join('/');
  if (unc) {
    result = `//${result.startsWith('/') ? result.slice(1) : result}`;
  }
  // Windows drive letters upper-cased: /c:/x → /C:/x; c:/x → C:/x
  // (drive letter only, other casing untouched)
  result = result.replace(/^\/([a-z]):/, (_m, drive: string) => `/${drive.toUpperCase()}:`);
  result = result.replace(/^([a-z]):/, (_m, drive: string) => `${drive.toUpperCase()}:`);
  return result.replace(/\/+$/, '');
}

/** For diagnostic mapping: core unsupported reason → identity-face diagnostic code */
const REASON_TO_CODE: Record<ModuleDualNameUnsupportedReason, HotReloadModuleDiagnosticCode> = {
  'no-root': 'no-root',
  'not-python': 'not-python',
  'out-of-root': 'out-of-root',
  traversal: 'traversal',
  'empty-stem': 'empty-stem',
  'init-file': 'init-file',
  'root-level': 'root-level'
};

/** user override validation: non-empty, no whitespace, no dot-segment boundary problems; returns null when illegal (the caller refuses, never a silent fallback) */
const validateOverrideModule = (value: string): string | null => {
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    /\s/.test(trimmed) ||
    trimmed.startsWith('.') ||
    trimmed.endsWith('.') ||
    trimmed.split('.').some(segment => segment.length === 0)
  ) {
    return null;
  }
  return trimmed;
};

/** Stem robustness (HR-MOD-015 URL encoding/Unicode face): whitespace and dots never enter a module name; Unicode letters are legal (PEP 3130) */
const stemIsRepresentable = (stem: string): boolean => !/[\s.]/.test(stem);

/** Root candidate selection product: the unique root / three refusal states (no guessing, all candidates listed) */
export type ScriptRootSelection =
  | { readonly kind: 'root'; readonly root: string }
  | { readonly kind: 'no-root' }
  | { readonly kind: 'out-of-root' }
  | { readonly kind: 'ambiguous-root'; readonly candidates: readonly string[] };

/**
 * Root candidate selection (HR-MOD-002/006 pure core, zero IO): roots must
 * already be normalized + order-preserving deduped. With >1 multi-root hit
 * and an explicit priority given, only a unique finite minimum-rank
 * candidate wins (smaller index = higher priority, user-specified ordering
 * = configuration not guessing); no priority / none ranked / a tie are all
 * refused with the full candidate list (the existing no-guessing
 * convention). Roots not in the list rank +∞ and are never promoted by
 * priority. A single-root hit always wins (regardless of any priority
 * configuration).
 */
export function selectScriptRoot(
  canonical: string,
  roots: readonly string[],
  priority?: readonly string[]
): ScriptRootSelection {
  if (roots.length === 0) {
    return { kind: 'no-root' };
  }
  const candidates = roots.filter(root => canonical !== root && canonical.startsWith(`${root}/`));
  if (candidates.length === 0) {
    return { kind: 'out-of-root' };
  }
  if (candidates.length === 1) {
    return { kind: 'root', root: candidates[0] };
  }
  // >1 hit: explicit priority adjudication (only a unique minimum rank wins;
  // otherwise the existing refusal)
  const ranked = priority
    ? [...new Set(priority.map(canonicalizeScriptFilePath).filter(root => root.length > 0))]
    : [];
  if (ranked.length > 0) {
    const rankOf = (root: string): number => {
      const index = ranked.indexOf(root);
      return index < 0 ? Number.POSITIVE_INFINITY : index;
    };
    let minRank = Number.POSITIVE_INFINITY;
    let winner: string | null = null;
    let tied = false;
    for (const candidate of candidates) {
      const rank = rankOf(candidate);
      if (rank < minRank) {
        minRank = rank;
        winner = candidate;
        tied = false;
      } else if (rank === minRank) {
        tied = true;
      }
    }
    if (minRank !== Number.POSITIVE_INFINITY && !tied && winner !== null) {
      return { kind: 'root', root: winner };
    }
  }
  return { kind: 'ambiguous-root', candidates };
}

/**
 * Pure resolver (HR-MOD-002): root candidate selection → delegate to
 * resolveModuleDualName → diagnostic mapping/override/DTO assembly.
 * Multi-root ambiguity (>1 candidate containing this file) is always
 * refused with every hit root listed, never guessing a unique root
 * (HR-MOD-006); the ambiguity refusal also blocks cross-root same-name
 * fight.FightAI mis-mapping at the source (the resolver side of
 * HR-MOD-010).
 */
export function resolveHotReloadModuleIdentity(
  input: HotReloadModuleIdentityInput
): HotReloadModuleResolution {
  const canonical = canonicalizeScriptFilePath(input.fileUri);
  if (canonical.length === 0) {
    return {
      ok: false,
      diagnostics: [{ code: 'not-python', message: 'fileUri 为空,拒绝解析' }]
    };
  }
  // RUST-424 duplicate-root matrix: the same normalized root appearing more
  // than once (scriptRoots duplicates, or scriptRoot sharing a root with
  // scriptRoots) counts as one candidate — a duplicate configuration is the
  // user's same root, != the HR-MOD-006 multi-root ambiguity, and hits must
  // be judged after dedup (otherwise one root would fabricate its own
  // ambiguous). Order-preserving dedup.
  const roots = [
    ...(input.scriptRoots ?? []).map(canonicalizeScriptFilePath),
    ...(input.scriptRoot !== undefined ? [canonicalizeScriptFilePath(input.scriptRoot)] : [])
  ]
    .filter(root => root.length > 0)
    .filter((root, index, self) => self.indexOf(root) === index);
  const selection = selectScriptRoot(canonical, roots, input.rootPriority);
  if (selection.kind === 'no-root') {
    return {
      ok: false,
      diagnostics: [
        { code: 'no-root', message: '未配置脚本资源根(kbengine.hotReload.tempEdit.scriptRoot)' }
      ]
    };
  }
  if (selection.kind === 'out-of-root') {
    return {
      ok: false,
      diagnostics: [
        { code: 'out-of-root', message: `文件不在任何脚本资源根内: ${canonical} ∉ [${roots.join(', ')}]` }
      ]
    };
  }
  if (selection.kind === 'ambiguous-root') {
    return {
      ok: false,
      diagnostics: [
        {
          code: 'ambiguous-root',
          message: `文件命中多个脚本资源根,未唯一确定前拒绝解析(HR-MOD-006 不猜): ${canonical} ∈ [${selection.candidates.join(', ')}]`
        }
      ]
    };
  }
  const root = selection.root;
  const dual = resolveModuleDualName(canonical, root, { allowRootLevelStem: input.allowRootLevelStem });
  if ('unsupported' in dual) {
    const code = REASON_TO_CODE[dual.reason];
    return {
      ok: false,
      diagnostics: [
        {
          code,
          message:
            dual.reason === 'root-level'
              ? `${dual.unsupported};或显式开启 allowRootLevelStem(HR-MOD-008)`
              : dual.unsupported
        }
      ]
    };
  }
  if (!stemIsRepresentable(dual.fileStem)) {
    return {
      ok: false,
      diagnostics: [
        {
          code: 'invalid-stem',
          message: `文件短名含空白或点,不可能成为合法模块名: ${dual.fileStem}`
        }
      ]
    };
  }
  let fullModule = dual.fullModule;
  let requestModule = dual.requestModule;
  if (input.userOverrideModule !== undefined) {
    const override = validateOverrideModule(input.userOverrideModule);
    if (override === null) {
      return {
        ok: false,
        diagnostics: [
          { code: 'invalid-override', message: `user override 非法(空/含空白/点段为空): ${input.userOverrideModule}` }
        ]
      };
    }
    fullModule = override;
    requestModule = override;
  }
  return {
    ok: true,
    identity: {
      workspaceId: input.workspaceId ?? '',
      rootId: input.rootId ?? '',
      fileUri: canonical,
      fullModule,
      requestModule,
      fileStem: dual.fileStem,
      parentName: dual.parentName,
      language: 'python',
      sourceVersion: input.sourceVersion
    }
  };
}
