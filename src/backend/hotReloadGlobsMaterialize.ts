/**
 * Materializing default hot-reload globs (user order 2026-11-12: "globs
 * should materialize their default value into the config, for easy editing"):
 * writes the watch scope actually in effect under the derived convention into
 * kbengine.hotReload.globs, so the user has a visible target to edit instead
 * of configuring assetsRoot first and relying on silent plugin derivation.
 *
 * Shape red line (the reason this module exists): the derived convention's
 * `${workspaceFolder}/<relative>/<py recursive suffix>` shape must not be
 * written into the config as is. Explicit globs are handed verbatim by
 * setupHotReload to the file-watcher registration entry, and that entry does
 * not expand the `${workspaceFolder}` variable (the derived convention lands
 * only via deriveWatcherPattern's RelativePattern). Writing the variable
 * shape back into the config turns it into an explicit glob that matches
 * absolute paths literally, and the watch scope silently matches nothing.
 * So generation always emits the absolute-path shape
 * `${assetsRoot}/<py recursive suffix>` -- itself a legal GlobPattern; once
 * written back, watching depends neither on derivation nor on variable
 * expansion, and whichever directory the user edits is a direct string edit.
 *
 * Idempotence and guarded mouth:
 * - globs already written explicitly (including an empty array = explicitly
 *   watch nothing) -> left untouched, with a hint that it is already editable
 *   (user intent is never overwritten);
 * - unset -> only then is generation attempted; generation needs a resolved
 *   assetsRoot, and a missing root is reported honestly with no empty value
 *   written.
 *
 * Pure logic split from wiring: config read/write goes through an injected
 * surface (wiring supplies the real vscode implementation, tests supply
 * fakes); this module never touches vscode inside pure functions.
 */

export const HOT_RELOAD_MATERIALIZE_GLOBS_COMMAND = 'kbengine.hotReload.materializeGlobs';

/** Hot reload proper only handles .py (same convention as deriveHotReloadGlob's derived suffix) */
const HOT_RELOAD_GLOB_SUFFIX = '**/*.py';

/** Normalize a path for globs: forward slashes, trailing slashes stripped (Windows backslashes normalized too) */
const normalizePathForGlob = (value: string): string =>
  value.replace(/\\/g, '/').replace(/\/+$/, '');

/**
 * Generate the watch pattern to write into the config: assets-root absolute
 * path + the py recursive suffix. An empty assetsRoot -> empty string (the
 * caller reports the missing root honestly; a "scan everything" shape is
 * never written).
 */
export function materializeHotReloadGlob(assetsRoot: string): string {
  const root = normalizePathForGlob((assetsRoot ?? '').trim());
  if (!root) {
    return '';
  }
  return `${root}/${HOT_RELOAD_GLOB_SUFFIX}`;
}

/**
 * Config read/write port: reads the raw globs value (unset / wrong-typed =
 * undefined) and writes back an array of watch patterns. update returns a
 * Thenable rather than a Promise -- the declared surface of vscode's
 * Configuration.update is Thenable<void>, and this module does not require
 * callers to wrap it.
 */
export interface HotReloadGlobsConfig {
  readRaw(): unknown;
  update(patterns: string[]): Thenable<void>;
}

/** Already written explicitly (an array; an empty array also counts as explicitly "watch no patterns", same convention as §11.1) */
const explicitGlobsOf = (raw: unknown): string[] | undefined =>
  Array.isArray(raw) ? (raw.filter((item): item is string => typeof item === 'string') as string[]) : undefined;

export interface HotReloadGlobsMaterializeResult {
  /** The pattern that was generated and written back */
  readonly written?: string;
  /** Why nothing was written (already configured explicitly / missing assets root) */
  readonly skipped?: 'explicit' | 'no-assets-root';
}

export interface HotReloadGlobsMaterializeDeps {
  readonly config: HotReloadGlobsConfig;
  /** Resolve the assets root (an absolute path; unresolvable = empty string) */
  resolveAssetsRoot(): string;
}

/**
 * Materialize the default value: generate only when unset, never touch what
 * is written. A successful generation lets the config-change event drive the
 * watcher rebuild (setupHotReload's existing signature criterion), so no
 * extra wiring is needed.
 */
export async function materializeHotReloadGlobs(
  deps: HotReloadGlobsMaterializeDeps
): Promise<HotReloadGlobsMaterializeResult> {
  if (explicitGlobsOf(deps.config.readRaw()) !== undefined) {
    return { skipped: 'explicit' };
  }
  const glob = materializeHotReloadGlob(deps.resolveAssetsRoot());
  if (!glob) {
    return { skipped: 'no-assets-root' };
  }
  await deps.config.update([glob]);
  return { written: glob };
}