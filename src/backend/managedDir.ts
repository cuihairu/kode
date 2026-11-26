/**
 * kode managed directory (user order 2026-10-21, task B): one `.kbengine` directory collects
 * every managed asset kode generates -- debug.json, stubs/KBEngine.pyi, the kbe_types.pyi
 * split pieces, and entity_types.pyi all live together. The directory name is configurable
 * (new key `kbengine.managedDir`, whose default value is `.kbengine`); existing scattered
 * settings are not retired (old-key compatibility):
 * - `kbengine.python.stubDir` / the environment variable `KBENGINE_STUB_DIR` still follow the
 *   existing three-level resolution (setting > environment variable > default convention) and
 *   take precedence over "managed directory/stubs" -- once specified they are scanned and the
 *   user's assets are not overwritten, semantics unchanged;
 * - `kbengine.managedDir` only decides where kode's self-managed directory lands, and under
 *   the default convention every generated artifact (including debug.json) moves along with it;
 *   the new key collects this at a single point.
 * Pure logic layer, no vscode imports; the wiring layer's read port is
 * pythonStubExport(readManagedDirSetting).
 * Automatic rebuild is the default: after the directory is deleted the window does not need
 * reloading, and the next relevant event (managed-dir watcher / types.xml watcher / activation)
 * rebuilds the whole chain -- each export chain already compares content and writes nothing on
 * a match, so repeat triggering is side-effect free (wired in the managed-dir watcher in
 * extension.ts).
 */

/** Setting key (the section name under getConfiguration('kbengine'); the full key is kbengine.managedDir) */
export const MANAGED_DIR_SETTING_KEY = 'managedDir';
/** Full setting key (for display) */
export const MANAGED_DIR_SETTING_FULL = `kbengine.${MANAGED_DIR_SETTING_KEY}`;
/** The default value is `.kbengine` (user order: the default convention) */
export const MANAGED_DIR_DEFAULT = '.kbengine';
/** Debug config file name inside the managed directory */
export const MANAGED_DIR_DEBUG_CONFIG_FILE = 'debug.json';

export interface ResolvedManagedDirName {
  /** Effective directory name (relative to the workspace root; relative form) */
  name: string;
  /** true = not configured, falls back to the default .kbengine */
  fromDefault: boolean;
}

/**
 * Directory-name resolution: empty/non-string -> the default `.kbengine`; a configured value
 * has leading/trailing whitespace and trailing slashes stripped (relative form, the same
 * accounting as the relative value of the stub directory's three-level resolution; absolute
 * paths are not within this key's semantics).
 */
export function resolveManagedDirName(setting?: unknown): ResolvedManagedDirName {
  const raw = typeof setting === 'string' ? setting.trim().replace(/\/+$/, '') : '';
  return raw.length > 0
    ? { name: raw, fromDefault: false }
    : { name: MANAGED_DIR_DEFAULT, fromDefault: true };
}
