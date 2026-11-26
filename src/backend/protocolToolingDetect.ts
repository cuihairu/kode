//! PA-007 (todo.md Phase 5): protocol toolchain detection — parsing the
//! versions and install status of Wireshark/TShark/the KBEngine plugin/the
//! kode-kbengine CLI.
//!
//! This module is a pure function face: it only parses CLI output text, with
//! zero vscode/child_process dependencies, and can be unit-tested
//! independently; spawning and command wiring live on the wiring side (a
//! later PA-007 increment). The parsing rules are anchored to the measured
//! output of the local tshark 4.6.4 (see the tests fixtures); when upstream
//! output formats change, extend the tests first, then the parser — never
//! swallow errors silently.

/** One line of `tshark -G plugins`: `name<TAB>version<TAB>type<TAB>path`. */
export interface TsharkPluginEntry {
  name: string;
  version: string;
  type: string;
  path: string;
}

/** The two plugin directories relevant to this integration in `tshark -G folders`. */
export interface TsharkPluginFolders {
  personalPlugins: string | null;
  globalPlugins: string | null;
}

/** `tshark -v` first line `TShark (Wireshark) 4.6.4.` → `4.6.4` (the trailing period is not part of the version). */
export function parseTsharkVersion(firstLine: string): string | null {
  const match = /^TShark \(Wireshark\) (\d+\.\d+(?:\.\d+)?)/.exec(firstLine);
  return match ? match[1] : null;
}

/** `wireshark -v` first line `Wireshark 4.6.4 (...)` → `4.6.4`; an uninstalled GUI returns honest null. */
export function parseWiresharkVersion(firstLine: string): string | null {
  const match = /^Wireshark (\d+\.\d+(?:\.\d+)?)/.exec(firstLine);
  return match ? match[1] : null;
}

/**
 * Full parse of `tshark -G plugins`: strictly 4 TAB-separated columns;
 * lines with a different column count or blank fields are skipped honestly
 * (the detection report prefers missing over wrong); an all-empty input
 * returns an empty array.
 */
export function parseTsharkPlugins(stdout: string): TsharkPluginEntry[] {
  const entries: TsharkPluginEntry[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') {
      continue;
    }
    const fields = trimmed.split('\t');
    if (fields.length !== 4) {
      continue;
    }
    const [name, version, type, path] = fields;
    if (name === '' || version === '' || type === '' || path === '') {
      continue;
    }
    entries.push({ name, version, type, path });
  }
  return entries;
}

/** Finds the KBEngine dissector plugin (type=dissector and the file name contains kbengine). */
export function findKbengineDissector(
  entries: TsharkPluginEntry[]
): TsharkPluginEntry | null {
  return (
    entries.find(
      (entry) => entry.type === 'dissector' && entry.name.includes('kbengine')
    ) ?? null
  );
}

/**
 * Parse of `tshark -G folders`: each line is `label:padding<TAB>path` (the
 * label carries its own colon, followed by column-width padding); only the
 * two plugin-directory lines are taken, the rest (Lua/personal Lua etc.) are
 * ignored. Not installed / format drift → the matching null.
 */
export function parseTsharkFolders(stdout: string): TsharkPluginFolders {
  let personal: string | null = null;
  let global: string | null = null;
  for (const line of stdout.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab < 0) {
      continue;
    }
    const label = line.slice(0, tab).trimEnd().replace(/:$/, '');
    const value = line.slice(tab + 1).trim();
    if (label === 'Personal Plugins') {
      personal = value;
    } else if (label === 'Global Plugins') {
      global = value;
    }
  }
  return { personalPlugins: personal, globalPlugins: global };
}

/** `kode-kbengine --version` single-line output → semver (`0.2.0`); malformed output → null. */
export function parseCliVersion(stdout: string): string | null {
  const match = /^kode-kbengine (\d+\.\d+\.\d+)$/.exec(stdout.trim());
  return match ? match[1] : null;
}

/** `4.6.4` → `4.6` (the host version line, matching the `<maj.min>` subdirectory convention for plugin directories); `4.6` stays as is. */
export function wiresharkVersionLine(version: string): string | null {
  const match = /^(\d+\.\d+)(?:\.|$)/.exec(version);
  return match ? match[1] : null;
}

/**
 * Whether the plugin's on-disk directory version line matches the host's
 * (PA-006 field findings: plugin_want_major/minor must match the host, a
 * 4.6 plugin does not load into a 4.4 host; the `<maj.min>` directory is
 * the target version line).
 * A pluginPath without the `/plugins/<maj.min>/` shape (e.g. manually
 * placed in a personal directory) → null unknown; the report marks it
 * honestly as unknown, no guessing.
 */
export function pluginFolderMatchesHost(
  pluginPath: string,
  tsharkVersion: string
): boolean | null {
  const host = wiresharkVersionLine(tsharkVersion);
  if (host === null) {
    return null;
  }
  const match = /[/\\]plugins[/\\](\d+\.\d+)[/\\]/.exec(pluginPath);
  if (match === null) {
    return null;
  }
  return match[1] === host;
}
