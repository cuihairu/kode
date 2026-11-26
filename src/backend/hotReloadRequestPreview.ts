/**
 * HR-MOD-013 legacy-config compatible migration and request preview pure
 * logic (zero vscode):
 * - **Request preview**: what the active file "would send" under each HTTP
 *   shortcut request entry and under the zero-config default hot reload face
 *   -- constructed only, never sent; disabled entries are honestly listed too
 *   (with a reason), never silently dropped;
 * - **Legacy-config compatible migration**: scans the raw saved
 *   kbengine.httpRequests entries for `${module}` (legacy semantics, on
 *   record in audit HR-AUDIT-004 = deliberately untouched default semantics)
 *   and offers a suggestion face of "migrate to `${fullModule}`" (dual-name
 *   face, HR-MOD-012); the suggestion is only offered when scriptRoot is
 *   configured (with it unset, ${fullModule} expands to the empty string, so
 *   migrating would break the link -- honestly no suggestion); rewriting only
 *   touches the confirmed entry's template strings, all other entries are
 *   kept verbatim -- "never silently tamper with saved URL templates" is a
 *   hard boundary: writes happen only via explicit user confirmation
 *   (wiring layer quick pick + second confirm); the pure core itself writes
 *   zero configuration.
 */

import {
  buildDefaultHotfixRequest,
  resolveDefaultHotfixModule
} from './hotReloadDefaultHotfix';
import {
  buildHttpRequest,
  buildOfficialVariableContext,
  buildTemplateVars,
  resolvePythonModulePath,
  type HttpRequestEntry,
  type PackageDirProbe
} from './httpRequests';
import { resolveModuleDualName } from './hotReloadTempEdit';

export interface RequestPreviewInput {
  /** Active file (empty string = no active editor; only the explanation row is produced, no file guessed) */
  readonly file: string;
  /** Parsed setting entries (including disabled ones; disabled entries are listed honestly) */
  readonly entries: readonly HttpRequestEntry[];
  /** Script root for dual-name resolution (same source as HR-MOD-012) */
  readonly scriptRoot: string;
  /** ${module} package boundary probe */
  readonly isPackageDir?: PackageDirProbe;
  /** HR-MOD-008 root-level single-segment fallback (same convention as the default hot reload face) */
  readonly allowRootLevelStem?: boolean;
  readonly cursorLineZeroBased?: number;
  readonly selection?: string;
  readonly workspaceRoots?: readonly string[];
}

/** One request preview row (pure presentation; zero involvement of the send face) */
export interface RequestPreviewRow {
  readonly name: string;
  /** Source label (settings/built-in example/zero-config default hot reload face) */
  readonly source: string;
  /** Non-empty = this entry does not participate in running, plus the reason (e.g. disabled); the preview still shows the template shape */
  readonly skippedReason?: string;
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  /** Three names side by side: the two dual-name values (honestly empty when unresolvable) + the legacy ${module} semantic value */
  readonly moduleNames: {
    readonly fullModule: string;
    readonly requestModule: string;
    readonly legacyModule: string;
  };
}

/** Preview row construction: one row per entry (disabled rows carry a reason) + one row for the zero-config default hot reload face */
export function buildRequestPreviewRows(input: RequestPreviewInput): RequestPreviewRow[] {
  const rows: RequestPreviewRow[] = [];
  if (input.file.length === 0) {
    return rows;
  }
  const vars = buildTemplateVars(
    {
      filePath: input.file,
      scriptRoot: input.scriptRoot.length > 0 ? input.scriptRoot : undefined,
      cursorLineZeroBased: input.cursorLineZeroBased,
      selection: input.selection,
      workspaceRoots: input.workspaceRoots,
      // RUST-441/HR-DOD-002: the preview face's config entries share the same allowRootLevelStem
      // convention as the default hot reload face (before closure, config entries missed this parameter
      // for ${reloadModule}/${fullModule}; with the root-level key on, the two preview rows disagreed --
      // config entry empty string, default face bare short name)
      allowRootLevelStem: input.allowRootLevelStem
    },
    input.isPackageDir
  );
  const official = buildOfficialVariableContext({
    filePath: input.file,
    workspaceRoots: input.workspaceRoots
  });
  const moduleNames = () => ({
    fullModule: vars.fullModule,
    requestModule: vars.reloadModule,
    legacyModule: vars.module
  });
  for (const entry of input.entries) {
    const built = buildHttpRequest(entry, vars, official);
    rows.push({
      name: entry.name,
      source: 'kbengine.httpRequests 设置',
      ...(entry.enabled ? {} : { skippedReason: '条目停用(enabled=false),不参与运行' }),
      method: built.method,
      url: built.url,
      headers: built.headers,
      body: built.body,
      moduleNames: moduleNames()
    });
  }
  // Zero-config default hot reload face (user order 2026-11-06): saving sends immediately when no action name is configured; the preview shares the same face and source
  const defaultRequest = buildDefaultHotfixRequest(input.file, {
    scriptRoot: input.scriptRoot,
    isPackageDir: input.isPackageDir,
    allowRootLevelStem: input.allowRootLevelStem
  });
  rows.push({
    name: '零配置默认热更面',
    source: '未配动作名时保存 .py 自动发送(HR-MOD-008 开关影响本面模块名)',
    method: defaultRequest.method,
    url: defaultRequest.url,
    headers: defaultRequest.headers,
    body: defaultRequest.body,
    moduleNames: {
      fullModule: dualNamesOf(input).fullModule,
      requestModule: dualNamesOf(input).requestModule,
      legacyModule: resolvePythonModulePath(input.file, input.isPackageDir)
    }
  });
  return rows;
}

/** Dual-name resolution (default hot reload face convention: scriptRoot + HR-MOD-008 switch; honestly empty string when unresolvable) */
const dualNamesOf = (
  input: Pick<RequestPreviewInput, 'file' | 'scriptRoot' | 'allowRootLevelStem'>
): { fullModule: string; requestModule: string } => {
  if (input.scriptRoot.length === 0) {
    return { fullModule: '', requestModule: '' };
  }
  const dual = resolveModuleDualName(input.file, input.scriptRoot, {
    ...(input.allowRootLevelStem === true ? { allowRootLevelStem: true } : {})
  });
  return 'unsupported' in dual ? { fullModule: '', requestModule: '' } : {
    fullModule: dual.fullModule,
    requestModule: dual.requestModule
  };
};

/** Single-file default hot reload module name preview (HR-MOD-008 switch convention, verbatim same source as the send face) */
export const previewDefaultHotfixModule = (
  file: string,
  deps: { scriptRoot?: string; isPackageDir?: PackageDirProbe; allowRootLevelStem?: boolean } = {}
): string => resolveDefaultHotfixModule(file, deps);

/** Legacy template placeholder (legacy ${module}; audit HR-AUDIT-004 deliberately kept the default semantics) */
export const LEGACY_MODULE_PLACEHOLDER = '${module}';
/** Migration target placeholder (HR-MOD-012 dual-name face fullModule) */
export const TARGET_MODULE_PLACEHOLDER = '${fullModule}';

/** Distribution of ${module} placeholders within one raw entry (url/body/headers values) */
export interface RawLegacyUsage {
  readonly index: number;
  /** Entry name (missing/non-string honestly falls back to the unnamed-entry marker) */
  readonly name: string;
  readonly fields: ReadonlyArray<{ field: 'url' | 'body' | 'header'; key?: string; count: number }>;
  readonly total: number;
}

export interface LegacyMigrationAnalysis {
  readonly usages: readonly RawLegacyUsage[];
  /** Whether a suggestion can be offered: scriptRoot is configured (only then does ${fullModule} have a value) */
  readonly canSuggest: boolean;
  /** Honest reason when no suggestion can be offered (shown directly in the UI) */
  readonly suggestReason: string;
}

/**
 * Scans the **raw** saved kbengine.httpRequests entries (no parse
 * normalization -- on write-back the other entries are kept verbatim, without
 * introducing the parser's default-value completion). Non-array/non-object
 * entries are skipped honestly.
 */
export function analyzeRawLegacyModuleEntries(raw: unknown): LegacyMigrationAnalysis {
  const usages: RawLegacyUsage[] = [];
  if (!Array.isArray(raw)) {
    return {
      usages,
      canSuggest: false,
      suggestReason: 'kbengine.httpRequests 未配置或不是数组,无可迁移条目'
    };
  }
  raw.forEach((item, index) => {
    if (typeof item !== 'object' || item === null) {
      return;
    }
    const entry = item as Record<string, unknown>;
    const fields: Array<RawLegacyUsage['fields'][number]> = [];
    const url = entry.url;
    if (typeof url === 'string' && url.includes(LEGACY_MODULE_PLACEHOLDER)) {
      fields.push({ field: 'url', count: countOccurrences(url) });
    }
    const body = entry.body;
    if (typeof body === 'string' && body.includes(LEGACY_MODULE_PLACEHOLDER)) {
      fields.push({ field: 'body', count: countOccurrences(body) });
    }
    const headers = entry.headers;
    if (typeof headers === 'object' && headers !== null) {
      for (const [key, value] of Object.entries(headers)) {
        if (typeof value === 'string' && value.includes(LEGACY_MODULE_PLACEHOLDER)) {
          fields.push({ field: 'header', key, count: countOccurrences(value) });
        }
      }
    }
    if (fields.length > 0) {
      usages.push({
        index,
        name: typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : '(未命名)',
        fields,
        total: fields.reduce((sum, field) => sum + field.count, 0)
      });
    }
  });
  return { usages, canSuggest: true, suggestReason: '' };
}

const countOccurrences = (text: string): number => text.split(LEGACY_MODULE_PLACEHOLDER).length - 1;

/**
 * Rewrites one raw entry: every `${module}` in the url/body/headers values is
 * replaced with `${fullModule}`; all other fields are kept verbatim
 * (references unchanged, no default values filled in). An entry without the
 * placeholder is returned as-is (changedFields empty).
 */
export function rewriteRawEntryLegacyModule(
  entry: Record<string, unknown>
): { next: Record<string, unknown>; changedFields: string[] } {
  const changedFields: string[] = [];
  const next: Record<string, unknown> = { ...entry };
  const rewrite = (field: 'url' | 'body'): void => {
    const value = next[field];
    if (typeof value === 'string' && value.includes(LEGACY_MODULE_PLACEHOLDER)) {
      next[field] = value.split(LEGACY_MODULE_PLACEHOLDER).join(TARGET_MODULE_PLACEHOLDER);
      changedFields.push(field);
    }
  };
  rewrite('url');
  rewrite('body');
  const headers = next.headers;
  if (typeof headers === 'object' && headers !== null) {
    const nextHeaders: Record<string, unknown> = { ...(headers as Record<string, unknown>) };
    let headerChanged = false;
    for (const [key, value] of Object.entries(nextHeaders)) {
      if (typeof value === 'string' && value.includes(LEGACY_MODULE_PLACEHOLDER)) {
        nextHeaders[key] = value.split(LEGACY_MODULE_PLACEHOLDER).join(TARGET_MODULE_PLACEHOLDER);
        headerChanged = true;
      }
    }
    if (headerChanged) {
      next.headers = nextHeaders;
      changedFields.push('headers');
    }
  }
  return { next, changedFields };
}

/**
 * Puts the rewritten entry back into the original array at the given index
 * (all other elements are kept verbatim, **same references**); out-of-range
 * or negative indices honestly return the original array. Writes happen only
 * after wiring-layer user confirmation; this function is pure.
 */
export function spliceMigratedEntry(
  raw: readonly unknown[],
  index: number,
  next: Record<string, unknown>
): unknown[] {
  if (!Number.isInteger(index) || index < 0 || index >= raw.length) {
    return [...raw];
  }
  const next_ = [...raw];
  next_[index] = next;
  return next_;
}
