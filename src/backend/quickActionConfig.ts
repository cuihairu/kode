/**
 * Pure layer for quick execute actions (design 1.8 data structures / 1.5 variable substitution /
 * 1.4 script word-list classification).
 *
 * Actions are defined by the top-level `quickActions` of `.kbengine/debug.json`, not stuffed
 * into the `debug` section (1.3 boundary: actions are not debug configurations). Three
 * execution backends: command (VS Code command), script (local script), http (local hot-reload
 * endpoint) -- whitelist style, no do-anything shell execution.
 *
 * Variables are resolved at execution time (not at scan/registration time); unknown variables
 * always throw, never silently replaced with an empty string (1.5).
 */

import type { BatchScriptCandidate } from './quickActionScanner';
import * as path from 'path';
import { substituteVariables, type VariableFolderRef } from './variableSubstitution';

export type QuickActionCategory = 'server' | 'export';
export type QuickActionSource = 'manual' | 'scan';

interface QuickActionShared {
  name: string;
  confirm: boolean;
  source: QuickActionSource;
  category?: QuickActionCategory;
}

export interface QuickActionCommand extends QuickActionShared {
  type: 'command';
  command: string;
  args: string[];
}

export interface QuickActionScript extends QuickActionShared {
  type: 'script';
  script: string;
  cwd?: string;
  background: boolean;
  venv?: { enabled: boolean; path?: string };
}

export interface QuickActionHttp extends QuickActionShared {
  type: 'http';
  url: string;
  method: string;
  body?: string;
}

/** Default list of directory names for automatic venv discovery (2026-10-30 user order: environment
 * directories are not hard-coded -- each team has its own .kbenv/.venv/venv habit): beyond an
 * explicit venv.path, probe each name on this list under the action directory and the config root;
 * the kbengine.python.venvDirectories setting can change the list. */
export const DEFAULT_VENV_DIRECTORY_NAMES: readonly string[] = ['.venv', 'venv', '.kbenv'];

/** Raw setting value -> list of venv directory names: non-array or all-invalid falls back to the
 * default; filters out empty strings, '.'/'..', and entries containing path separators (the list
 * only allows single-segment directory names, preventing assembled probe-point escapes). */
export function normalizeVenvDirectoryNames(raw: unknown): string[] {
  const fallback = [...DEFAULT_VENV_DIRECTORY_NAMES];
  if (!Array.isArray(raw)) {
    return fallback;
  }
  const names = raw
    .filter((name): name is string => typeof name === 'string')
    .map(name => name.trim())
    .filter(name => name.length > 0 && name !== '.' && name !== '..'
      && !name.includes('/') && !name.includes('\\'));
  return names.length > 0 ? names : fallback;
}

/** Configuration for the standalone "HTTP request" view; never mixed into the legacy quickActions backend list. */
export interface HttpRequestConfig {
  name?: string;
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

export type QuickAction = QuickActionCommand | QuickActionScript | QuickActionHttp;

/** The path variable shape: written into config as a literal string, swapped for the actual workspace root only at execution time */
export const WORKSPACE_FOLDER_VAR = '${workspaceFolder}';

/** Methods the http backend accepts (uppercased at parse time; same set as the debug.json schema enum) */
export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'HEAD', 'OPTIONS'];
/** The three execution backends (the parser only accepts these three; same set as the debug.json schema enum) */
export const QUICK_ACTION_TYPES = ['command', 'script', 'http'];
const SERVER_WORDS = ['start', 'stop', 'restart', 'boot', 'server'];
const EXPORT_WORDS = ['export', 'convert', '导表'];

export function baseNameOf(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1];
}

export function stripExtension(fileName: string): string {
  return fileName.replace(/\.[^/.]+$/, '');
}

/** Only non-empty strings are accepted (shared by name/script/command/url); bad entries are dropped one by one instead of failing the whole table */
function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function parseCommandArgs(value: unknown): string[] | null {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) && value.every(item => typeof item === 'string')
    ? (value as string[])
    : null;
}

function parseSharedFields(record: Record<string, unknown>, name: string): QuickActionShared | null {
  if (record.confirm !== undefined && typeof record.confirm !== 'boolean') {
    return null;
  }
  const confirm = record.confirm === undefined ? true : (record.confirm as boolean);
  if (record.source !== undefined && record.source !== 'manual' && record.source !== 'scan') {
    return null;
  }
  const source = record.source === undefined ? 'manual' : (record.source as QuickActionSource);
  if (record.category !== undefined && record.category !== 'server' && record.category !== 'export') {
    return null;
  }
  const category = record.category === undefined
    ? undefined
    : (record.category as QuickActionCategory);
  return { name, confirm, source, category };
}

interface ParsedQuickAction {
  action: QuickAction;
  /** Non-fatal warning (e.g. a non-boolean background executed in the foreground): the entry is kept as-is, the reminder must be sent */
  warning?: string;
}

/** Preview showing the user's original value in warnings (JSON first; falls back to String when stringify fails on BigInt/cycles etc.) */
function previewConfigValue(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function parseQuickAction(item: unknown): ParsedQuickAction | null {
  if (typeof item !== 'object' || item === null) {
    return null;
  }
  const record = item as Record<string, unknown>;
  const name = nonEmptyString(record.name);
  if (name === null) {
    return null;
  }
  const shared = parseSharedFields(record, name);
  if (shared === null) {
    return null;
  }
  const type = record.type;

  if (type === 'command') {
    const command = nonEmptyString(record.command);
    const args = parseCommandArgs(record.args);
    return command === null || args === null
      ? null
      : { action: { ...shared, type, command, args } };
  }
  if (type === 'script') {
    const script = nonEmptyString(record.script);
    if (script === null) {
      return null;
    }
    const rawVenv = record.venv;
    let venv: QuickActionScript['venv'];
    if (rawVenv !== undefined) {
      if (typeof rawVenv !== 'object' || rawVenv === null || Array.isArray(rawVenv)) return null;
      const venvRecord = rawVenv as Record<string, unknown>;
      if (typeof venvRecord.enabled !== 'boolean'
        || (venvRecord.path !== undefined && typeof venvRecord.path !== 'string')) return null;
      venv = {
        enabled: venvRecord.enabled,
        ...(typeof venvRecord.path === 'string' ? { path: venvRecord.path } : {})
      };
    }
    // background not a boolean (user order 2026-10-27, empirically characterized): no more silent
    // fallback -- JSON5-style writings like "background": "true" used to silently become foreground,
    // leaving "I wrote true and it still pops a terminal" untraceable. The entry is kept and executed
    // in the foreground, but a per-entry warning spells out the correct writing.
    let background = false;
    let warning: string | undefined;
    if (typeof record.background === 'boolean') {
      background = record.background;
    } else if (record.background !== undefined) {
      warning = `快速动作「${name}」的 background 不是布尔(收到 ${previewConfigValue(record.background)}),已按前台执行;请写 true 或 false(不带引号)`;
    }
    // cwd defaults when absent; when present but not a string, fall back to the default value (not dropped as a bad entry)
    const cwd = typeof record.cwd === 'string' ? (record.cwd as string) : WORKSPACE_FOLDER_VAR;
    const action: QuickAction = { ...shared, type, script, background, cwd, ...(venv ? { venv } : {}) };
    return warning === undefined ? { action } : { action, warning };
  }
  if (type === 'http') {
    const url = nonEmptyString(record.url);
    const method = typeof record.method === 'string' ? record.method.toUpperCase() : 'POST';
    const body = typeof record.body === 'string' ? (record.body as string) : undefined;
    return url === null || !HTTP_METHODS.includes(method)
      ? null
      : { action: { ...shared, type, url, method, body } };
  }
  return null;
}

export function parseQuickActionConfigs(raw: unknown): {
  actions: QuickAction[];
  invalidCount: number;
  /** Non-fatal warnings (entries kept, the writing has problems): the wiring layer broadcasts each one, never silently */
  warnings: string[];
} {
  if (!Array.isArray(raw)) {
    return { actions: [], invalidCount: 0, warnings: [] };
  }
  const actions: QuickAction[] = [];
  const warnings: string[] = [];
  let invalidCount = 0;
  for (const item of raw) {
    const parsed = parseQuickAction(item);
    if (parsed === null) {
      invalidCount += 1;
      continue;
    }
    actions.push(parsed.action);
    if (parsed.warning !== undefined) {
      warnings.push(parsed.warning);
    }
  }
  return { actions, invalidCount, warnings };
}

/** Parse the top-level httpRequests; missing method/url or wrong field types count each entry as invalid. */
export function parseHttpRequestConfigs(raw: unknown): { requests: HttpRequestConfig[]; invalidCount: number } {
  if (!Array.isArray(raw)) return { requests: [], invalidCount: 0 };
  const requests: HttpRequestConfig[] = [];
  let invalidCount = 0;
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) { invalidCount += 1; continue; }
    const record = item as Record<string, unknown>;
    const method = typeof record.method === 'string' ? record.method.trim().toUpperCase() : '';
    const url = nonEmptyString(record.url);
    const name = record.name === undefined ? undefined : nonEmptyString(record.name);
    const body = record.body === undefined ? undefined : typeof record.body === 'string' ? record.body : null;
    const rawHeaders = record.headers;
    let headers: Record<string, string> | undefined;
    let badHeaders = false;
    if (rawHeaders !== undefined) {
      if (typeof rawHeaders !== 'object' || rawHeaders === null || Array.isArray(rawHeaders)) badHeaders = true;
      else {
        headers = {};
        for (const [key, value] of Object.entries(rawHeaders)) {
          if (!key.trim() || typeof value !== 'string') { badHeaders = true; break; }
          headers[key] = value;
        }
      }
    }
    if (!/^[A-Z][A-Z0-9-]*$/.test(method) || !url || name === null || body === null || badHeaders) {
      invalidCount += 1;
      continue;
    }
    requests.push({ method, url, ...(name ? { name } : {}), ...(headers && Object.keys(headers).length ? { headers } : {}), ...(body !== undefined ? { body } : {}) });
  }
  return { requests, invalidCount };
}

/** Workspace roots available to variable resolution (mapped from vscode.workspace by quickActions) */
export type WorkspaceFolderRef = VariableFolderRef;

/**
 * Command-side variable substitution (delegated to src/variableSubstitution since batch 141;
 * a single source of truth for substitution logic): the official variable table is fully
 * covered and unresolved variables always throw -- silent empty-string substitution would run
 * the script into a fake "path is empty" success, worse than reporting an error (${config:} /
 * ${command:} style variables that need a real VS Code debug context are beyond this
 * extension's resolution ability and honestly error out the same way).
 */
export function resolveActionVariables(
  text: string,
  folders: readonly WorkspaceFolderRef[] = []
): string {
  const resolved = substituteVariables(text, { folders }, 'throw');
  // Workspace roots carry a leading '/', which meets path separators hard-coded in the text and
  // produces '//'; collapse to a single slash ('//' after ':' is a URL protocol separator, left alone)
  return resolved.replace(/([^:])\/{2,}/g, match => `${match[0]}/`);
}

/**
 * Script word-list classification (1.4): start/stop words take priority over export words;
 * hitting both classifies as start/stop (server). No hit returns null -- the first-install scan
 * only collects these two categories, no generalization.
 */
export function classifyBatchScript(scriptName: string): QuickActionCategory | null {
  const lower = scriptName.toLowerCase();
  if (SERVER_WORDS.some(word => lower.includes(word))) {
    return 'server';
  }
  if (EXPORT_WORDS.some(word => lower.includes(word))) {
    return 'export';
  }
  return null;
}

/**
 * Build scanned candidates into script actions writable to config: both the script path and cwd
 * are anchored to ${workspaceFolder}; start/stop scripts default to background (starting the
 * server does not wait for an exit code).
 */
export function buildScannedActions(
  candidates: readonly BatchScriptCandidate[],
  workspaceRoot: string
): QuickActionScript[] {
  const nameCounts = new Map<string, number>();
  for (const candidate of candidates) {
    const baseName = stripExtension(baseNameOf(candidate.path));
    nameCounts.set(baseName.toLowerCase(), (nameCounts.get(baseName.toLowerCase()) ?? 0) + 1);
  }
  return candidates.map(candidate => {
    const fileName = baseNameOf(candidate.path);
    const relativePath = path.relative(workspaceRoot, candidate.path);
    const canUseWorkspaceVariable = relativePath !== '' && !path.isAbsolute(relativePath);
    const relative = canUseWorkspaceVariable
      ? relativePath.replace(/\\/g, '/')
      : candidate.path;
    const baseName = stripExtension(fileName);
    const parentParts = path.dirname(candidate.path).split(/[\\/]/).filter(Boolean);
    const name = (nameCounts.get(baseName.toLowerCase()) ?? 0) > 1
      ? `${baseName} (${parentParts[parentParts.length - 1] ?? 'script'})`
      : baseName;
    const lowerName = name.toLowerCase();
    const scriptDirectory = path.dirname(candidate.path);
    const relativeDirectory = path.relative(workspaceRoot, scriptDirectory);
    const cwd = relativeDirectory === ''
      ? WORKSPACE_FOLDER_VAR
      : path.isAbsolute(relativeDirectory)
        ? scriptDirectory
        : `${WORKSPACE_FOLDER_VAR}/${relativeDirectory.replace(/\\/g, '/')}`;
    return {
      name,
      type: 'script',
      script: canUseWorkspaceVariable ? `${WORKSPACE_FOLDER_VAR}/${relative}` : candidate.path,
      cwd,
      background: lowerName.startsWith('start') || lowerName.startsWith('boot'),
      confirm: true,
      source: 'scan',
      // Scripts outside the word lists have no category: omit the key (the schema allows omitting it); neither write null nor invent a category
      ...(candidate.category === null ? {} : { category: candidate.category })
    };
  });
}
