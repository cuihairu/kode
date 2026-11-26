/**
 * batch A2 (2026-11-18 inspection ticket kode-ruff-format-statusbar.md):
 * pyproject.toml [tool.ruff] detection and bootstrapping. Ruff config discovery
 * = searching upward from the formatted file for the nearest pyproject.toml's
 * [tool.ruff] / ruff.toml; no config = the default line-length 88. This core
 * does three things at the **workspace root** (on by default, turn off via
 * `kbengine.ruff.ensureConfig`):
 * - the root already has ruff.toml/.ruff.toml, or pyproject.toml already has
 *   [tool.ruff] → untouched (red line: never modify existing [tool.ruff]
 *   content);
 * - no pyproject.toml → after confirmation generate a minimal file ([project]
 *   name placeholder only when it can be safely inferred + [tool.ruff]
 *   line-length=88 + generated-by note + common-values comment);
 * - pyproject.toml without the section → after confirmation **safely append**
 *   (original content preserved byte-for-byte; a guard scan before appending,
 *   anything doubtful = honestly skipped as unsafe, never writing potentially
 *   corrupted TOML).
 * Consent-based: the dialog carries a content preview; declining means no more
 * asking this session. Pure core, zero vscode dependencies; the UI/file faces
 * are all injected via deps (unit tests drive pure orchestration).
 */

import { l10nText } from '../nlsRuntime';

const CREATE_ACTION = l10nText('Create');
const SKIP_ACTION = l10nText('Not now');

/** The append block (a standalone constant: tests and the dialog preview share one real text, no second assembly). */
export const RUFF_APPEND_BLOCK = [
  '# Added by Kode (KBEngine extension). Feel free to edit. / 由 Kode 添加,可自由修改。',
  '[tool.ruff]',
  '# Common values: 79 / 100 / 120 (default 88).',
  '# A smaller line-length wraps long generated data into multiple lines earlier',
  '# (easier to read when debugging entity configs). / 改小=长数据更早拆多行。',
  'line-length = 88'
].join('\n');

/** Recognize [tool.ruff] table headers line by line (subtables included); comment-disguised and non-header lines are not accepted. */
export function hasToolRuffSection(text: string): boolean {
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || !line.startsWith('[')) {
      continue;
    }
    const close = line.indexOf(']');
    if (close <= 0) {
      continue;
    }
    const header = line.slice(1, close);
    const segments = header.split('.').map(s => s.trim().replace(/^["']|["']$/g, ''));
    if (segments[0] === 'tool' && segments[1] === 'ruff') {
      return true;
    }
  }
  return false;
}

/**
 * Whether an inline `ruff = ...` key already exists under the [tool] table —
 * appending a [tool.ruff] table would then form a duplicate TOML key and must
 * be refused.
 */
function hasInlineToolRuffKey(text: string): boolean {
  let inToolSection = false;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    if (line.startsWith('[')) {
      const close = line.indexOf(']');
      if (close > 0) {
        const header = line.slice(1, close).trim();
        inToolSection = header === 'tool' || header === '"tool"';
      }
      continue;
    }
    if (inToolSection && /^ruff\s*=/.test(line)) {
      return true;
    }
  }
  return false;
}

/**
 * A one-pass string-aware scan of the whole text, returning whether the end sits
 * at a "clean landing point":
 * - not inside an unterminated string (triple-quoted / escaped single or double
 *   quotes);
 * - bracket depth ([ ] { }) back to zero (not inside a multi-line array or
 *   inline table);
 * - '#' counts as a line comment only outside strings.
 * Anything doubtful → false (the caller honestly reports unsafe, never writing
 * potentially corrupted TOML).
 */
function endsAtCleanTomlBoundary(text: string): boolean {
  let quote: '"' | "'" | null = null;
  let triple = false;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (quote) {
      if (quote === '"' && ch === '\\') {
        i++; // an escape consumes the next character
        continue;
      }
      if (triple) {
        if (ch === quote && next === quote && text[i + 2] === quote) {
          quote = null;
          triple = false;
          i += 2;
        }
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      triple = ch === next && text[i + 2] === ch;
      if (triple) {
        i += 2;
      }
      continue;
    }
    if (ch === '#') {
      // line comment: skip to the line end
      while (i < text.length && text[i] !== '\n') {
        i++;
      }
      continue;
    }
    if (ch === '[' || ch === '{' || ch === '(') {
      depth++;
    } else if (ch === ']' || ch === '}' || ch === ')') {
      depth--;
      if (depth < 0) {
        return false;
      }
    }
  }
  return quote === null && depth === 0;
}

/**
 * Safely append the [tool.ruff] section: original content preserved
 * byte-for-byte, only the section appended at the end.
 * Returns null = unsafe / section already present (the caller honestly skips,
 * never partially writing).
 */
export function appendToolRuffSection(original: string): string | null {
  if (hasToolRuffSection(original) || hasInlineToolRuffKey(original)) {
    return null;
  }
  if (!endsAtCleanTomlBoundary(original)) {
    return null;
  }
  if (/\\\s*$/.test(original)) {
    return null; // a dangling line continuation
  }
  const glue = original.endsWith('\n') ? '' : '\n';
  return `${original}${glue}\n${RUFF_APPEND_BLOCK}\n`;
}

/** Safe root-name inference: lowercase letters/digits/hyphens/underscores/dots, not starting with an illegal character; failure = null (omit [project]). */
function sanitizeProjectName(rootPath: string): string | null {
  const base = rootPath.split(/[\\/]/).filter(Boolean).pop() ?? '';
  const sanitized = base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+/, '');
  return /^[a-z0-9]/.test(sanitized) && sanitized.length > 0 ? sanitized : null;
}

/** Generate a minimal pyproject.toml; with rootName=null omit [project] ([tool.ruff] alone is valid). */
export function buildCreateContent(rootName: string | null): string {
  const lines = [
    '# Generated by Kode (KBEngine extension). Feel free to edit. / 由 Kode 生成,可自由修改。',
    ''
  ];
  if (rootName !== null) {
    lines.push('[project]', `name = "${rootName}"`, '');
  }
  lines.push(RUFF_APPEND_BLOCK);
  return `${lines.join('\n')}\n`;
}

export type RuffConfigEnsureOutcome =
  | 'not-needed'
  | 'created'
  | 'appended'
  | 'declined'
  | 'declined-session'
  | 'setting-off'
  | 'no-root'
  | 'unsafe-append'
  | 'write-failed';

export interface RuffConfigEnsureDeps {
  /** `kbengine.ruff.ensureConfig`; false = no generation at all (zero detection, zero dialogs). */
  getSettingEnabled(): boolean;
  /** Workspace root absolute path; null = no root. */
  workspaceRoot(): string | null;
  /** File existence under the root. */
  rootFileExists(name: string): boolean;
  /** Read a root file's text; missing = null. */
  readFileText(name: string): string | null;
  /** Write a root file; returns success. */
  writeFileText(name: string, content: string): boolean;
  showInformationMessage(message: string, ...items: string[]): Thenable<string | undefined>;
}

/**
 * Session factory: once asked, remembered (declined → not asked again this
 * session; ready / already written → idempotent not-needed). Created once per
 * extension host and held by the wiring layer; tests create a fresh one each
 * time for clean state.
 */
export function createRuffConfigEnsureSession(): {
  ensure(deps: RuffConfigEnsureDeps): Promise<RuffConfigEnsureOutcome>;
} {
  let declined = false;
  let resolved = false;
  return {
    async ensure(deps): Promise<RuffConfigEnsureOutcome> {
      if (!deps.getSettingEnabled()) {
        return 'setting-off';
      }
      if (declined) {
        return 'declined-session';
      }
      if (resolved) {
        return 'not-needed';
      }
      const root = deps.workspaceRoot();
      if (!root) {
        return 'no-root';
      }
      // A ruff-specific config file exists → all of ruff's behavior already reads
      // it; no pyproject section needed.
      if (deps.rootFileExists('ruff.toml') || deps.rootFileExists('.ruff.toml')) {
        resolved = true;
        return 'not-needed';
      }
      const pyproject = deps.readFileText('pyproject.toml');
      if (pyproject !== null && hasToolRuffSection(pyproject)) {
        resolved = true;
        return 'not-needed';
      }
      let target: string;
      let content: string;
      let message: string;
      if (pyproject === null) {
        target = 'pyproject.toml';
        content = buildCreateContent(sanitizeProjectName(root));
        message = `${l10nText(
          'No ruff config in the workspace root. Create pyproject.toml with this block?'
        )}\n\n${content.trim()}`;
      } else {
        const appended = appendToolRuffSection(pyproject);
        if (appended === null) {
          // Doubtful → honestly skipped (with no ruff config the behavior is
          // unchanged at the default line length 88); no dialog, no write;
          // resolved is not set: the user can retry in the same session after
          // fixing the file.
          return 'unsafe-append';
        }
        target = 'pyproject.toml';
        content = appended;
        message = `${l10nText('pyproject.toml has no [tool.ruff] section. Append this block?')}\n\n${RUFF_APPEND_BLOCK}`;
      }
      const choice = await deps.showInformationMessage(message, CREATE_ACTION, SKIP_ACTION);
      if (choice !== CREATE_ACTION) {
        declined = true;
        return 'declined';
      }
      if (!deps.writeFileText(target, content)) {
        return 'write-failed';
      }
      resolved = true;
      return pyproject === null ? 'created' : 'appended';
    }
  };
}

/**
 * Host-shared session: the wiring layer (utilityCommands) injects the vscode
 * face deps once; multiple command/generator entries share the same session
 * (the "asked means remembered" semantics holds across entries within a
 * session). Unwired (activation order / test face) → 'unwired' returned
 * honestly, never posing as any detection result.
 */
let sharedWiring: { deps: RuffConfigEnsureDeps; session: ReturnType<typeof createRuffConfigEnsureSession> } | null =
  null;

export function wireSharedRuffConfigEnsure(deps: RuffConfigEnsureDeps): void {
  sharedWiring = { deps, session: createRuffConfigEnsureSession() };
}

export async function ensureRuffConfigShared(): Promise<RuffConfigEnsureOutcome | 'unwired'> {
  return sharedWiring ? sharedWiring.session.ensure(sharedWiring.deps) : 'unwired';
}
