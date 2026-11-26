/**
 * Pure logic of HTTP quick requests (batch 105; batch 152 added the official
 * variable family and a realistic-shape example; batch 153 restored ${file} to
 * its official semantics and renamed the file name placeholder to ${filename} —
 * name matches reality, per user order):
 * - parsing and validation of the kbengine.httpRequests setting entries (a bad
 *   entry is honestly skipped, never guessed);
 * - extraction and literal substitution of the template variables
 *   ${module}/${moduleBasename}/${filename}/${line}/${sel} (${module} = the
 *   module path scanned out by __init__.py package boundaries: when entities/
 *   and fight/ each carry an __init__.py, entities/fight/FightAI.py →
 *   entities.fight.FightAI; role directories such as base/cell without an
 *   __init__.py do not count as module segments, so the module name is just the
 *   file name minus .py; ${moduleBasename} = the last segment only;
 *   ${filename} = the file name (it was called ${file} before batch 152,
 *   renamed because the name did not match reality);
 *   ${line} = the cursor line (1-based); ${sel} = the selected text.
 *   Variables are substituted literally, with no URL encoding);
 * - from batch 152 the official variable family (the VS Code official variable
 *   table, via the single source of truth in variableSubstitution) can be
 *   interpolated in the same pass — ${file}/${fileBasename}/
 *   ${fileBasenameNoExtension}/${fileDirname}/${fileExtname}/${relativeFile}/
 *   ${relativeFileDirname}/${workspaceFolder}/${workspaceFolderBasename}/
 *   ${env:NAME} etc.; from batch 153 ${file} follows the official convention =
 *   the absolute path and is no longer occupied by a custom meaning;
 *   placeholders the official table does not recognize are kept as they are.
 * - One built-in example (disabled by default, real service shape), kept in sync
 *   with the package.json default values by a test lock.
 */

import { resolveVariableExpression, type VariableContext } from './variableSubstitution';
import { PYTHON_PROCESS_ROLE_DIRS, resolveModuleDualName } from './hotReloadTempEdit';

export interface HttpRequestEntry {
  /** Display name (the quick pick entry and the log prefix) */
  name: string;
  /** URL template, may carry ${module}/${moduleBasename}/${filename}/${line}/${sel} placeholders */
  url: string;
  /** HTTP method, defaults to GET (upper-cased uniformly) */
  method: string;
  /** Request headers (the values go through template substitution too) */
  headers: Record<string, string>;
  /** Request body (only sent with the request when non-empty; goes through template substitution too) */
  body: string;
  /** Enable/disable switch, enabled by default */
  enabled: boolean;
  /**
   * HR-HTTP-006 (RUST-348) maximum response body (bytes): the received response
   * is truncated at this limit and the excess honestly discarded (the log
   * preview is separately capped and marked at RESPONSE_PREVIEW_LIMIT);
   * defaults to the existing cap window (RESPONSE_PREVIEW_LIMIT×4). The user
   * configuration face: configurable per entry; absent/non-positive-integer
   * falls back to the default.
   */
  maxResponseBytes?: number;
  /**
   * Keybinding display string (shown in the quick pick detail column). VS Code
   * has no API for registering keybindings at runtime, so the actual shortcut is
   * bound via "Keyboard Shortcuts" for kbengine.httpRequest.run with an
   * args.name; this field is for display and search only.
   */
  keybinding: string;
}

/**
 * Built-in example (disabled by default): the default hot reload service shape
 * settled by user order 2026-11-06 —
 * `POST http://127.0.0.1:8090/hotfix?module_name=${module}`, with the body also
 * carrying `module_name=${module}` (${module} = the module path scanned out by
 * __init__.py package boundaries).
 * Carrying one copy in the query and another in the body keeps compatibility
 * with different server implementations (some read the query, some the body);
 * repeating the same value is harmless. Kept in sync with the package.json
 * defaults by a test lock; the zero-config auto hot reload
 * (src/hotReloadDefaultHotfix.ts) takes this same template from the same
 * source, and the endpoint and parameter names are defined in this one place only.
 */
export const BUILTIN_HTTP_REQUEST_EXAMPLE: Readonly<HttpRequestEntry> = Object.freeze({
  name: '热更新(示例)',
  url: 'http://127.0.0.1:8090/hotfix?module_name=${module}',
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: 'module_name=${module}',
  enabled: false,
  keybinding: ''
});

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Parse the setting's raw value: a non-array returns an empty list; an entry
 * missing name/url or with the wrong type is skipped whole, while the other
 * fields each fall back to their default (method upper-cased, headers keeping
 * only string values).
 */
export function parseHttpRequestEntries(raw: unknown): HttpRequestEntry[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const entries: HttpRequestEntry[] = [];
  for (const item of raw) {
    if (!isPlainObject(item)) {
      continue;
    }
    const name = item.name;
    const url = item.url;
    if (typeof name !== 'string' || name.trim().length === 0) {
      continue;
    }
    if (typeof url !== 'string' || url.trim().length === 0) {
      continue;
    }
    const headers: Record<string, string> = {};
    if (isPlainObject(item.headers)) {
      for (const [key, value] of Object.entries(item.headers)) {
        if (typeof value === 'string') {
          headers[key] = value;
        }
      }
    }
    const method = typeof item.method === 'string' && item.method.trim().length > 0
      ? item.method.trim().toUpperCase()
      : 'GET';
    entries.push({
      name,
      url,
      method,
      headers,
      body: typeof item.body === 'string' ? item.body : '',
      enabled: typeof item.enabled === 'boolean' ? item.enabled : true,
      // HR-HTTP-006: only positive integers are accepted; anything else (negative/zero/fractional/non-number/string) honestly falls back to the default
      ...(typeof item.maxResponseBytes === 'number' &&
      Number.isSafeInteger(item.maxResponseBytes) &&
      item.maxResponseBytes > 0
        ? { maxResponseBytes: item.maxResponseBytes }
        : {}),
      keybinding: typeof item.keybinding === 'string' ? item.keybinding : ''
    });
  }
  return entries;
}

const toPosix = (value: string): string => value.replace(/\\/g, '/');

const stripPyExtension = (value: string): string => value.replace(/\.py$/i, '');

/**
 * Probe for whether a directory is a Python package (contains __init__.py); the
 * wiring layer injects the real fs decision and tests inject scripted fakes, so
 * the pure logic layer never touches the disk.
 */
export type PackageDirProbe = (dirPath: string) => boolean;

/**
 * The Python module path of the current file (recast in batch 153, per user
 * order "a directory only counts as a module once __init__.py is found"): scans
 * up from the file's directory for the package boundary — only a directory
 * containing __init__.py is a package segment, and the first directory without
 * __init__.py is the boundary. KBEngine scripts mostly live under the base/cell
 * role directories, which have no __init__.py and therefore are not module
 * segments, leaving the module name as just the file name (the "no module, so
 * the bare file name" shape); if the assets carry a real package structure
 * (entities/ and fight/ each with an __init__.py) it yields
 * entities.fight.FightAI.
 * Without an injected probe it is treated as "no package boundary" (module = the
 * file name minus .py). An empty path returns an empty string.
 */
export function resolvePythonModulePath(
  filePath: string,
  isPackageDir?: PackageDirProbe
): string {
  if (filePath.length === 0) {
    return '';
  }
  const parts = toPosix(filePath).split('/');
  const stem = stripPyExtension(parts[parts.length - 1]);
  // Step up level by level from the file's directory: only a package segment is collected, and the first non-package directory cuts it off (starting at i=1 skips the empty leading segment of an absolute path; a win32 drive segment 'C:' likewise cannot be a package)
  const segments: string[] = [];
  for (let i = parts.length - 2; i >= 1; i--) {
    if (!isPackageDir || !isPackageDir(parts.slice(0, i + 1).join('/'))) {
      break;
    }
    // Process role directories (scripts/{base,cell,client,bots}) are the engine's process load roots, not
    // Python module segments — the engine's sys.modules holds no such prefixes (baseapp loads
    // scripts/base as its process directory). Even a directory carrying __init__.py breaks the chain here: a
    // module_name prefixed with base./cell. is unrecognized by the server, so the request is accepted
    // yet no module is ever reloaded.
    if (PYTHON_PROCESS_ROLE_DIRS.has(parts[i].toLowerCase())) {
      break;
    }
    segments.unshift(parts[i]);
  }
  return [...segments, stem].join('.');
}

/** Carrier of the template variables; line takes a 0-based cursor line as input and is converted to a 1-based natural line number on export */
export interface TemplateEditorContext {
  filePath?: string;
  cursorLineZeroBased?: number;
  selection?: string;
  workspaceRoots?: readonly string[];
  /** Script asset root (the starting point of the HR-MOD-012 dual-name face's ${reloadModule}/${fullModule}; absent = unknown, both values honestly empty strings) */
  scriptRoot?: string;
  /**
   * HR-MOD-008 single-level fallback under the root (RUST-441/HR-DOD-002
   * consistency across the three trigger faces): the dual-name resolution and
   * the automatic face (onSave/onDiskChange share the same fire path) take the
   * same parameter — for a `Foo.py` right under the root, the key on falls back
   * to the bare stem, the key off / absent = unresolved. The false default is
   * word for word identical to existing behaviour (adding this field changes no
   * existing resolution result).
   */
  allowRootLevelStem?: boolean;
  /** Channel/target label (HR-MOD-012 ${targetId}); the quick request face usually has no target, defaulting to an empty string */
  targetId?: string;
}

export interface TemplateVars {
  module: string;
  /** The last-segment-only module name (batch 152, per user order "just one level of module is enough"): FightAI */
  moduleBasename: string;
  /** File name (renamed from file to filename in batch 153, so the name matches reality): FightAI.py */
  filename: string;
  line: string;
  sel: string;
  /** Dual-name request module (HR-MOD-012): fight.FightAI; resolved only when scriptRoot is configured, empty string when the setting is missing (not mixed with the legacy ${module} semantics) */
  reloadModule: string;
  /** Dual-name full module (HR-MOD-012): entities.fight.FightAI; likewise an empty string when the setting is missing */
  fullModule: string;
  /** ${fileName} (the HR-MOD-012 spelling alias) = filename: FightAI.py */
  fileName: string;
  /** Path relative to the first workspace root containing this file; empty string when no root matches */
  relativePath: string;
  /** The matched workspace root (trailing slashes trimmed); empty string when none matches */
  workspaceRoot: string;
  /** Target label; empty string when not given */
  targetId: string;
}

/**
 * Extract template variables from the editor context; with no editor every
 * value is an empty string (honestly, never guessed); the package probe passes
 * through (batch 153).
 * The ${module} compatibility mapping decision (HR-MOD-012, see HR-AUDIT-004
 * for the audit): the legacy __init__.py package-boundary scan semantics stay
 * unchanged (zero regression for existing templates); the dual-name model goes
 * through the new placeholders ${reloadModule}/${fullModule}, resolved via
 * resolveModuleDualName only when scriptRoot is explicitly configured (the same
 * string core as HR-MOD-005), and both are an empty string on resolution
 * failure or missing configuration — an empty string interpolated into the
 * template is a visible failure, which is preferable to mixing two semantics
 * into a single name.
 */
export function buildTemplateVars(
  context: TemplateEditorContext,
  isPackageDir?: PackageDirProbe
): TemplateVars {
  const filePath = context.filePath ?? '';
  const parts = toPosix(filePath).split('/');
  const base = parts[parts.length - 1];
  const line = context.cursorLineZeroBased === undefined || context.cursorLineZeroBased === null
    ? ''
    : String(context.cursorLineZeroBased + 1);
  const module = resolvePythonModulePath(filePath, isPackageDir);
  const dot = module.lastIndexOf('.');
  const scriptRoot = context.scriptRoot ?? '';
  const dual = scriptRoot.length > 0
    ? resolveModuleDualName(filePath, scriptRoot, {
        ...(context.allowRootLevelStem === true ? { allowRootLevelStem: true } : {})
      })
    : undefined;
  const dualOk = dual !== undefined && !('unsupported' in dual);
  const posixPath = toPosix(filePath);
  const workspaceRoot = (context.workspaceRoots ?? [])
    .map(root => toPosix(root).replace(/\/+$/, ''))
    .find(root => root.length > 0 && (posixPath === root || posixPath.startsWith(`${root}/`)))
    ?? '';
  const relativePath = workspaceRoot.length > 0 && posixPath.length > workspaceRoot.length
    ? posixPath.slice(workspaceRoot.length + 1)
    : '';
  return {
    module,
    moduleBasename: dot === -1 ? module : module.slice(dot + 1),
    filename: base,
    line,
    sel: context.selection ?? '',
    reloadModule: dualOk ? dual.requestModule : '',
    fullModule: dualOk ? dual.fullModule : '',
    fileName: base,
    relativePath,
    workspaceRoot,
    targetId: context.targetId ?? ''
  };
}

/** Literally substitutes the known placeholders (the file name placeholder has been called ${filename} since batch 153; HR-MOD-012 added the dual-name/path/targetId family); unknown placeholders are kept as they are; substituted values are not URL encoded */
export function applyTemplate(text: string, vars: TemplateVars): string {
  return text
    .replace(/\$\{module\}/g, () => vars.module)
    .replace(/\$\{moduleBasename\}/g, () => vars.moduleBasename)
    .replace(/\$\{filename\}/g, () => vars.filename)
    .replace(/\$\{fileName\}/g, () => vars.fileName)
    .replace(/\$\{line\}/g, () => vars.line)
    .replace(/\$\{sel\}/g, () => vars.sel)
    .replace(/\$\{reloadModule\}/g, () => vars.reloadModule)
    .replace(/\$\{fullModule\}/g, () => vars.fullModule)
    .replace(/\$\{relativePath\}/g, () => vars.relativePath)
    .replace(/\$\{workspaceRoot\}/g, () => vars.workspaceRoot)
    .replace(/\$\{targetId\}/g, () => vars.targetId);
}

/**
 * Editor context → official variable family context (batch 152): workspace
 * roots are named by basename (matching VS Code's folder.name in the single-root
 * shape), and env is not injected, going through process.env instead.
 */
export function buildOfficialVariableContext(
  context: TemplateEditorContext
): VariableContext {
  const basename = (value: string): string => {
    // split always returns at least one element, so the last segment can be taken directly without an empty-list fallback
    const parts = toPosix(value.replace(/\/+$/, '')).split('/');
    return parts[parts.length - 1];
  };
  return {
    folders: (context.workspaceRoots ?? []).map(root => ({
      fsPath: root,
      name: basename(root)
    })),
    filePath: context.filePath
  };
}

/**
 * Single-pass merged substitution (batch 152; ${file} moved out of the custom
 * table in batch 153): the custom placeholders (module/moduleBasename/
 * filename/line/sel) take priority, then the official variable family (the
 * single source of truth in variableSubstitution, where ${file} follows the
 * official convention = the absolute path), and placeholders neither recognizes
 * are kept as they are.
 */
export function applyTemplateWithContext(
  text: string,
  vars: TemplateVars,
  official: VariableContext
): string {
  return text.replace(/\$\{([^${}]*)\}/g, (raw, expression: string) => {
    if (expression === 'module' || expression === 'moduleBasename' || expression === 'filename'
      || expression === 'fileName' || expression === 'line' || expression === 'sel'
      || expression === 'reloadModule' || expression === 'fullModule' || expression === 'relativePath'
      || expression === 'workspaceRoot' || expression === 'targetId') {
      return applyTemplate(raw, vars);
    }
    const value = resolveVariableExpression(expression, official);
    return value === undefined ? raw : value;
  });
}

export interface BuiltHttpRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

/** The executable request after the URL/request body/request header values are uniformly template-substituted; with an official variable context present, it interpolates in the same pass (batch 152) */
export function buildHttpRequest(
  entry: HttpRequestEntry,
  vars: TemplateVars,
  official?: VariableContext
): BuiltHttpRequest {
  const substitute = (text: string): string =>
    official ? applyTemplateWithContext(text, vars, official) : applyTemplate(text, vars);
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(entry.headers)) {
    headers[key] = substitute(value);
  }
  return {
    url: substitute(entry.url),
    method: entry.method,
    headers,
    body: substitute(entry.body)
  };
}
