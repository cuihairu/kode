/**
 * Process-ownership pure core (PROC-TAG-001 chartered 2026-11-13; its face changed in
 * PROC-BREADCRUMB-001 on 2026-11-18): "show which process the current file belongs to; Flags and
 * BaseMethods and CellMethods and the like can be used to tell; other processes also have the
 * corresponding file, and the other processes' tags need to be shown too, clickable to switch
 * files quickly". The presentation face moved from the file-top CodeLens to the breadcrumb's
 * synthetic root node (user order: the header lens required scrolling to the top to be seen,
 * which was impractical).
 *
 * The determination chain (by priority; when it cannot be determined, the lens does not appear --
 * an honest accounting, no guessing):
 * 1. Directory role: a scripts/<role>/ directory name -> the process (base->baseapp,
 *    cell->cellapp, client->client, bots->bots). The shared directory levels between scripts and
 *    the file name (interfaces/interface/common) are skipped before the role is recognized; if,
 *    after skipping, the file name is reached directly without seeing a role directory, it cannot
 *    be determined.
 * 2. def-section corroboration: when the directory cannot decide, if the method sections the
 *    implementation file's def declares happen to fall in a single process family
 *    (BaseMethods->baseapp / CellMethods->cellapp / ClientMethods->client), they corroborate the
 *    ownership; coexisting families (a two-process entity) or no sections = ambiguous / no
 *    evidence, honestly null.
 * 3. Neither can decide -> the lens does not appear.
 *
 * Cross-link: the current file's scripts/<role>/ anchor is expanded to same-named files in the
 * other role directories (cell/Hero.py <-> base/Hero.py <-> bots/Hero.py); sub-path levels under
 * the role directory (the shared layer scripts/<role>/interfaces/) are preserved -- the mirror
 * counterpart wins, the role root's same-named file is the fallback. The ones that exist are
 * listed as sibling segments. Zero vscode, zero IO: file existence is injected by the
 * caller; this core only derives paths.
 */

/** Process names (the stable vocabulary for lens display and cross-link ordering) */
export type ProcessName = 'baseapp' | 'cellapp' | 'client' | 'bots';

/** Role directories under scripts/ -> the process (the directory's physical name is the role;
 * client and bots are two separate process shapes, so the cross-link pairs physical directories
 * and does not merge client<->bots) */
const ROLE_DIR_TO_PROCESS: Readonly<Record<string, ProcessName>> = {
  base: 'baseapp',
  cell: 'cellapp',
  client: 'client',
  bots: 'bots'
};

/** Shared directory levels between role directories: skipped during role determination (reaching
 * the file name directly after skipping = cannot be determined) */
const SHARED_DIR_NAMES: ReadonlySet<string> = new Set(['interfaces', 'interface', 'common']);

/**
 * First priority of the determination chain: the directory role. The path is split by both /
 * and \ separators (engineering tests show both platforms feed in); take the deepest scripts
 * segment, skip the shared directory levels after it, and the first role-directory segment is
 * the ownership; no scripts segment or an indeterminate role -> null (no lens, no guessing).
 */
export function resolveScriptRole(fsPath: string): ProcessName | null {
  const segments = fsPath.split(/[\\/]/);
  const scriptsIndex = segments.lastIndexOf('scripts');
  if (scriptsIndex < 0) {
    return null;
  }
  // The tail segment is the file name, so only directory segments are scanned
  for (let i = scriptsIndex + 1; i < segments.length - 1; i++) {
    const segment = segments[i];
    if (SHARED_DIR_NAMES.has(segment)) {
      continue;
    }
    return ROLE_DIR_TO_PROCESS[segment] ?? null;
  }
  return null;
}

/**
 * Second priority of the determination chain: corroboration from def method sections. Only when
 * the section set falls in exactly one process family does it corroborate; coexisting families
 * or an empty set = ambiguous / no evidence, honestly null. The bots process implements the
 * client-side entity scripts (the BotsApp framework), so def sections cannot distinguish client
 * from bots and corroborate only down to client -- bots ownership can only come from the
 * directory, which is the honest boundary of this evidence.
 */
export function processFromDefSections(sections: ReadonlySet<string>): ProcessName | null {
  const families = new Set<ProcessName>();
  if (sections.has('BaseMethods')) {
    families.add('baseapp');
  }
  if (sections.has('CellMethods')) {
    families.add('cellapp');
  }
  if (sections.has('ClientMethods')) {
    families.add('client');
  }
  return families.size === 1 ? [...families][0] : null;
}

/** Same-named counterpart files in other processes (the cross-link tag) */
export interface ProcessSiblingFile {
  readonly process: ProcessName;
  readonly path: string;
}

/** The process-ownership spec: the current process + the other processes' same-named files (the
 * sole input shape for lens rendering) */
export interface ProcessOwnershipSpec {
  readonly current: ProcessName;
  readonly siblings: readonly ProcessSiblingFile[];
}

/**
 * Assemble the ownership spec: the directory-role determination + the same-named cross-link
 * expansion (same-named files in the other role directories, whose existence the injected
 * fileExists decides; this core does zero IO). The directory cannot decide -> null (no lens).
 * The directory decides but every cross-link is missing -> an empty siblings array (only the
 * current process's lens is shown).
 */
export function buildProcessOwnershipSpec(
  fsPath: string,
  fileExists: (path: string) => boolean
): ProcessOwnershipSpec | null {
  const current = resolveScriptRole(fsPath);
  if (!current) {
    return null;
  }
  const segments = fsPath.split(/[\\/]/);
  const scriptsIndex = segments.lastIndexOf('scripts');
  const name = segments[segments.length - 1];
  const prefix = segments.slice(0, scriptsIndex + 1);
  // The role directory is the first non-shared segment after scripts (the same scan as
  // resolveScriptRole; the resolved current guarantees it exists). Sub-path levels after it
  // (the shared layer scripts/<role>/interfaces/) are preserved by the cross-link expansion:
  // scripts/base/interfaces/Hero.py mirrors to scripts/cell/interfaces/Hero.py, not to the
  // role root -- dropping the sub-path made shared-layer files never find their same-named
  // counterpart (2026-11-26 user report; the top-level scripts/interfaces/ is the Interfaces
  // app, not the shared layer, and stays role-less).
  let roleIndex = scriptsIndex + 1;
  while (SHARED_DIR_NAMES.has(segments[roleIndex])) {
    roleIndex += 1;
  }
  const under = segments.slice(roleIndex + 1, segments.length - 1);
  const seen = new Set<string>();
  const siblings: ProcessSiblingFile[] = [];
  for (const [dir, process] of Object.entries(ROLE_DIR_TO_PROCESS)) {
    if (process === current) {
      continue;
    }
    // One sibling per role: the mirrored sub-path first, the role root's same-named file as
    // the fallback (base/interfaces/X.py also pairs with cell/X.py when the mirror is absent)
    const candidates = [...new Set([
      [...prefix, dir, ...under, name].join('/'),
      [...prefix, dir, name].join('/')
    ])];
    const hit = candidates.find(candidate => !seen.has(candidate) && fileExists(candidate));
    if (!hit) {
      continue;
    }
    seen.add(hit);
    siblings.push({ process, path: hit });
  }
  return { current, siblings };
}

/**
 * The switch-key side flip (2026-11-27 user order: pressing the key of the side you are already
 * on must still switch): when the requested side equals the current side, flip to the other of
 * the base/cell pair; any other current side (client/bots) and any cross-side request keep the
 * request verbatim. Pure decision, no IO.
 */
export function switchTargetProcess(
  current: ProcessName,
  requested: 'cellapp' | 'baseapp'
): 'cellapp' | 'baseapp' {
  if (current === requested) {
    return requested === 'cellapp' ? 'baseapp' : 'cellapp';
  }
  return requested;
}

// --- The breadcrumb process switcher (PROC-BREADCRUMB-001, user order 2026-11-18) ---
// The header process CodeLens was removed (requiring a scroll to the top = impractical; the
// breadcrumb is permanently visible); the determination chain and this file's pure core are reused
// in full, and the synthetic root node is produced by the DocumentSymbolProvider (Outline and the
// breadcrumb share a single source point). Cross-file jumps have no command face on
// DocumentSymbol: the child lands on this file's anchor (an honest degradation), and detail
// carries the sibling path plus an openCell/openBase switch hint.

/** def method sections -> process segments (the def-face data source, the same vocabulary as the determination chain) */
const DEF_SECTION_TO_PROCESS: Readonly<Record<string, ProcessName>> = {
  BaseMethods: 'baseapp',
  CellMethods: 'cellapp',
  ClientMethods: 'client'
};

/** Process segments -> the scripts/ role directory name (for deriving the sibling .py) */
const PROCESS_TO_ROLE_DIR: Readonly<Record<ProcessName, string>> = {
  baseapp: 'base',
  cellapp: 'cell',
  client: 'client',
  bots: 'bots'
};

/** Breadcrumb child-node spec: the process segment + this file's anchor (an honest degraded jump) + the sibling path (may be absent) */
export interface ProcessBreadcrumbChildSpec {
  readonly process: ProcessName;
  /** This file's anchor section name (the def face = a def section; the python face = null, no anchor) */
  readonly section: string | null;
  /** The anchor range (0-based line numbers, inclusive of the start, exclusive of the end); no anchor = null */
  readonly anchor: { startLine: number; endLine: number } | null;
  /** The sibling implementation file path; null when it cannot be derived or does not exist (detail honestly omits it) */
  readonly siblingPath: string | null;
}

/** The breadcrumb synthetic root node spec (the provider half's sole input shape) */
export interface ProcessBreadcrumbSpec {
  /** `entityName · seg1·seg2…` (the ▸ marks the anchored section; a single section gets no marker) */
  readonly name: string;
  readonly entityName: string;
  /** The full list of process segments (the anchored section first) */
  readonly processes: readonly ProcessName[];
  readonly children: readonly ProcessBreadcrumbChildSpec[];
}

/** The synthetic name: the anchored section (first) carries the ▸; a single section gets no marker (the pin-1 accounting) */
function breadcrumbName(entityName: string, processes: readonly ProcessName[]): string {
  const segments =
    processes.length > 1
      ? processes.map((process, index) => (index === 0 ? `${process}▸` : process))
      : [...processes];
  return `${entityName} · ${segments.join('·')}`;
}

/**
 * The def face's synthetic root (the .def first cut): the full process segment list = the
 * current def's declared method sections mapped over, in document order (the anchored section =
 * the first section in document order -- a def has no directory role, so "the current section" has
 * no determination face; the first section is taken as the anchor and placed first, with the ▸ only
 * when there are multiple sections); children = the remaining sections, the anchor = this file's
 * corresponding def section, the sibling path = scripts/<role>/<entityName>.py (carried only if it
 * exists). No method sections = null, no node inserted.
 */
export function buildDefProcessBreadcrumb(
  defFsPath: string,
  sections: ReadonlyArray<{ section: string; startLine: number; endLine: number }>,
  fileExists: (path: string) => boolean
): ProcessBreadcrumbSpec | null {
  const seen = new Set<ProcessName>();
  const processes: ProcessName[] = [];
  const sectionByProcess = new Map<ProcessName, { section: string; startLine: number; endLine: number }>();
  for (const entry of sections) {
    const process = DEF_SECTION_TO_PROCESS[entry.section];
    if (!process || seen.has(process)) {
      continue;
    }
    seen.add(process);
    processes.push(process);
    sectionByProcess.set(process, entry);
  }
  if (processes.length === 0) {
    return null;
  }
  const segments = defFsPath.split(/[\\/]/);
  const scriptsIndex = segments.lastIndexOf('scripts');
  const fileBase = segments[segments.length - 1];
  const entityName = fileBase.replace(/\.def$/i, '');
  const siblingOf = (process: ProcessName): string | null => {
    if (scriptsIndex < 0) {
      return null;
    }
    const candidate = [...segments.slice(0, scriptsIndex + 1), PROCESS_TO_ROLE_DIR[process], `${entityName}.py`].join('/');
    return fileExists(candidate) ? candidate : null;
  };
  const children: ProcessBreadcrumbChildSpec[] = [];
  for (const process of processes.slice(1)) {
    const block = sectionByProcess.get(process)!;
    children.push({
      process,
      section: block.section,
      anchor: { startLine: block.startLine, endLine: block.endLine },
      siblingPath: siblingOf(process)
    });
  }
  return {
    name: breadcrumbName(entityName, processes),
    entityName,
    processes,
    children
  };
}

/**
 * The python face's synthetic root (the second cut): a node appears only when the directory role
 * hits (indeterminate = null, zero interference with Pylance); the full process segment list =
 * the current + the cross-link's existing ones, with the current segment (the genuine directory
 * determination) carrying the ▸ and placed first.
 * children = the cross-link segments, with no anchor in this file (anchor=null), and the sibling
 * path = the cross-link file.
 */
export function buildPythonProcessBreadcrumb(
  fsPath: string,
  fileExists: (path: string) => boolean
): ProcessBreadcrumbSpec | null {
  const spec = buildProcessOwnershipSpec(fsPath, fileExists);
  if (!spec) {
    return null;
  }
  const segments = fsPath.split(/[\\/]/);
  const entityName = segments[segments.length - 1].replace(/\.py$/i, '');
  const processes: ProcessName[] = [spec.current, ...spec.siblings.map(sibling => sibling.process)];
  return {
    name: breadcrumbName(entityName, processes),
    entityName,
    processes,
    children: spec.siblings.map(sibling => ({
      process: sibling.process,
      section: null,
      anchor: null,
      siblingPath: sibling.path
    }))
  };
}
