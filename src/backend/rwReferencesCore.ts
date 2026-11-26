// RW-REFS-001: read/write/delete classification for reference sites (pure
// core; zero vscode, zero IO). Both command faces feed this module:
//   - key families: GlobalDataDictIndex / spaceData sites already carry a
//     write/read/delete kind (spaceData encodes it in `fn`), cellData sites
//     carry only an access shape, so they default to read;
//   - general symbols: DocumentHighlightKind.Read/Write/Text ranges are
//     aligned to reference locations by the caller and classified here.
//
// Assignment shapes are classified as both read and write (⇄): augmented
// assignment (`a += 1`) and subscript assignment (`a[i] = v` / `D["k"] = v`).
// Plain rebinding (`a = v`) is write only.
//
// Case sensitivity is a hard rule: file and symbol comparisons use exact
// `===` / `<` only. No toLowerCase/toUpperCase/localeCompare in this file
// (pinned by tests/rwReferences.test.ts).
//
// prove-red anchors (tests/rwReferences.test.ts):
//   R1: drop kind-based grouping → key-family grouping case fails.
//   R2: drop dual assignment classification → augmented case fails.
//   R3: drop range/symbol alignment → general-symbol case fails.

/** Access kind shared by both command faces. */
export type RwKind = 'write' | 'read' | 'delete';

/** A classified reference site, ready for QuickPick rendering. */
export interface RwSite {
  /** Absolute file path (or the URI path supplied by the vscode API). */
  file: string;
  /** 0-based line. */
  line: number;
  /** 0-based character column of the reference. */
  character: number;
  /** Trimmed, bounded code excerpt for the QuickPick row. */
  code: string;
  /** One or more kinds; read+write together means a ⇄ dual site. */
  kinds: RwKind[];
  /** Whether the row must be listed in both READ and WRITE. */
  dual: boolean;
}

/** Raw site shape accepted by the classifier (before code excerpt bounding). */
export interface RwSourceSite {
  file: string;
  line: number;
  character: number;
  code?: string;
  /** Explicit kind from the owning index; absent means read-until-proven. */
  kind?: RwKind;
  /** Exact symbol text at the site; used for case-sensitive alignment. */
  symbol?: string;
}

export interface RwGroups {
  write: RwSite[];
  read: RwSite[];
  delete: RwSite[];
}

export interface RwGroupCounts {
  write: number;
  read: number;
  delete: number;
  total: number;
}

export interface RwCancellationTokenLike {
  readonly isCancellationRequested: boolean;
}

export interface RwRangeLike {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

export interface RwReferenceLike {
  file: string;
  range: RwRangeLike;
}

export interface RwHighlightLike {
  file: string;
  range: RwRangeLike;
  kind: number;
}

/** Minimal DocumentHighlightKind values (the public vscode enum contract). */
export const RW_HIGHLIGHT_TEXT = 0;
export const RW_HIGHLIGHT_READ = 1;
export const RW_HIGHLIGHT_WRITE = 2;

/** Bounded detail length from the ticket (≤80 chars after trim). */
export const RW_CODE_LIMIT = 80;

/** Longest operator first so `**=` is not read as `*=`. */
const AUGMENTED_OPS = ['**=', '//=', '<<=', '>>=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '@='];
const ASSIGNMENT_PREFIXES = ['+', '-', '*', '/', '%', '&', '|', '^', '@'];
const IDENTIFIER_AT = /[A-Za-z_]\w*/g;

export function isCancelled(token?: RwCancellationTokenLike | null): boolean {
  return token?.isCancellationRequested === true;
}

/**
 * >50 files: process sequentially and yield to the host every 10 files so a
 * large reference query cannot freeze the UI. The caller performs the actual
 * `setImmediate` (kept out of the pure core).
 */
export function shouldYieldBetweenFiles(index: number, totalFiles: number): boolean {
  return totalFiles > 50 && index > 0 && index % 10 === 0;
}

/** Trim and bound a code line excerpt without normalizing its characters. */
export function boundRwCode(text: string | undefined): string {
  const trimmed = (text ?? '').trim();
  return trimmed.length <= RW_CODE_LIMIT ? trimmed : `${trimmed.slice(0, RW_CODE_LIMIT - 1)}…`;
}

interface AssignmentShape {
  write: boolean;
  /** Augmented assignment or subscript assignment: the site is also a read. */
  dual: boolean;
  /** Whether a `]` closing a subscript precedes the operator. */
  subscript: boolean;
}

/**
 * Find an assignment operator at top-level after `from`, skipping quoted
 * strings and bracketed key expressions. `==` / `!=` / `<=` / `>=` / `->`
 * and `:=` are not assignments; augmented operators are.
 */
function findAssignmentOperator(lineText: string, from: number): { index: number; augmented: boolean } | null {
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  for (let i = Math.max(0, from); i < lineText.length; i += 1) {
    const ch = lineText[i];
    if (quote !== null) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#' && depth === 0 && i > 0 && /\s/.test(lineText[i - 1])) {
      return null; // trailing comment cannot assign the access
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      if (depth > 0) {
        depth -= 1;
      }
      continue;
    }
    if (ch !== '=') {
      continue;
    }
    const prev = lineText[i - 1] ?? '';
    const next = lineText[i + 1] ?? '';
    if (next === '=' || prev === '=' || prev === '!' || prev === '<' || prev === '>' || prev === ':') {
      continue;
    }
    if (depth !== 0) {
      continue;
    }
    if (ASSIGNMENT_PREFIXES.includes(prev)) {
      const before = lineText.slice(Math.max(0, i - 2), i + 1);
      if (AUGMENTED_OPS.includes(before)) {
        return { index: i - 2, augmented: true };
      }
      if (AUGMENTED_OPS.includes(prev + '=')) {
        return { index: i - 1, augmented: true };
      }
      return null; // arithmetic value context, not an assignment
    }
    return { index: i, augmented: false };
  }
  return null;
}

/**
 * Column where the operator scan may start. Key-family sites point at the
 * first key character, just after the opening quote (cellData keyStart is
 * `span.lo + 1`); scanning from inside the literal would read the closing
 * quote as an opener and swallow the whole assignment. Step back onto the
 * quote so literal delimiters pair up correctly.
 */
function assignmentScanColumn(lineText: string, character: number): number {
  const start = Math.max(0, character);
  const before = lineText[start - 1];
  if (before === '"' || before === "'") {
    return start - 1;
  }
  return start;
}

/** Assignment shape of the access starting at `character` on its line. */
export function detectRwAssignmentShape(lineText: string, character: number): AssignmentShape {
  const operator = findAssignmentOperator(lineText, assignmentScanColumn(lineText, character));
  if (operator === null) {
    return { write: false, dual: false, subscript: false };
  }
  const before = lineText.slice(Math.max(0, character), operator.index);
  const subscript = before.includes(']');
  return { write: true, dual: operator.augmented || subscript, subscript };
}

function pushKind(kinds: RwKind[], kind: RwKind): void {
  if (!kinds.includes(kind)) {
    kinds.push(kind);
  }
}

/**
 * Classify a key-family site. Explicit index kinds are authoritative; cellData
 * sites (no write/read kind) start as reads. Assignment shapes add the missing
 * side and mark the site ⇄.
 */
export function classifyRwKeySite(site: RwSourceSite, lineText: string): RwSite {
  const kinds: RwKind[] = [];
  pushKind(kinds, site.kind ?? 'read');
  const shape = detectRwAssignmentShape(lineText, site.character);
  // Explicit index kinds are authoritative; only infer from text when there
  // is no kind (cellData) or when the assignment is dual (⇄ both sides).
  if (site.kind === undefined && shape.write) {
    pushKind(kinds, 'write');
  }
  if (shape.dual) {
    pushKind(kinds, 'read');
    pushKind(kinds, 'write');
  }
  return {
    file: site.file,
    line: site.line,
    character: site.character,
    code: boundRwCode(site.code ?? lineText),
    kinds,
    dual: kinds.includes('read') && kinds.includes('write')
  };
}

/**
 * Classify one aligned general-symbol site from its DocumentHighlightKind.
 * Text highlights (and missing highlights) fall back to the text heuristic.
 */
export function classifyRwTextSite(
  site: RwSourceSite,
  lineText: string,
  highlightKind: number | undefined
): RwSite {
  const shape = detectRwAssignmentShape(lineText, site.character);
  const kinds: RwKind[] = [];
  if (highlightKind === RW_HIGHLIGHT_WRITE || highlightKind === RW_HIGHLIGHT_READ) {
    pushKind(kinds, highlightKind === RW_HIGHLIGHT_WRITE ? 'write' : 'read');
  } else if (shape.write) {
    pushKind(kinds, 'write');
  } else {
    pushKind(kinds, 'read');
  }
  if (shape.dual) {
    pushKind(kinds, 'read');
    pushKind(kinds, 'write');
  }
  return {
    file: site.file,
    line: site.line,
    character: site.character,
    code: boundRwCode(site.code ?? lineText),
    kinds,
    dual: kinds.includes('read') && kinds.includes('write')
  };
}

/** Exact (case-sensitive) word at a character column; null outside words. */
export function rwSymbolAt(lineText: string, character: number): string | null {
  IDENTIFIER_AT.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = IDENTIFIER_AT.exec(lineText)) !== null) {
    if (character >= match.index && character < match.index + match[0].length) {
      return match[0];
    }
  }
  return null;
}

/** File:line ordering, with exact string comparison (no locale folding). */
export function compareRwSites(left: RwSite, right: RwSite): number {
  if (left.file < right.file) { return -1; }
  if (left.file > right.file) { return 1; }
  if (left.line !== right.line) { return left.line - right.line; }
  if (left.character !== right.character) { return left.character - right.character; }
  return 0;
}

function rangeContains(range: RwRangeLike, line: number, character: number): boolean {
  if (line < range.start.line || line > range.end.line) {
    return false;
  }
  if (line === range.start.line && character < range.start.character) {
    return false;
  }
  if (line === range.end.line && character > range.end.character) {
    return false;
  }
  return true;
}

function sameRange(left: RwRangeLike, right: RwRangeLike): boolean {
  return left.start.line === right.start.line
    && left.start.character === right.start.character
    && left.end.line === right.end.line
    && left.end.character === right.end.character;
}

/**
 * Align reference-provider locations with per-file document highlights by
 * line/character ranges, then classify with the highlight kind plus the text
 * heuristic. Symbol comparison is exact: `Hero` and `hero` never share a
 * face. Unaligned locations are dropped (no classification evidence).
 */
export function alignRwReferences(
  references: readonly RwReferenceLike[],
  highlights: readonly RwHighlightLike[],
  texts: ReadonlyMap<string, string>,
  expectedSymbol?: string
): RwSite[] {
  const sites: RwSite[] = [];
  for (const reference of references) {
    const line = reference.range.start.line;
    const character = reference.range.start.character;
    const text = texts.get(reference.file) ?? '';
    const lineText = (text.split(/\r?\n/)[line] ?? '');
    const word = rwSymbolAt(lineText, character);
    if (word === null) {
      continue;
    }
    if (expectedSymbol !== undefined && word !== expectedSymbol) {
      continue; // case-sensitive alignment: never fold to a shared symbol
    }
    const candidates = highlights.filter(highlight =>
      highlight.file === reference.file && rangeContains(highlight.range, line, character)
    );
    const highlight = candidates.find(candidate => sameRange(candidate.range, reference.range))
      ?? candidates[0];
    const site: RwSourceSite = {
      file: reference.file,
      line,
      character,
      code: lineText,
      symbol: word
    };
    sites.push(classifyRwTextSite(site, lineText, highlight?.kind));
  }
  return sites;
}

function siteKey(site: RwSite): string {
  return `${site.file}\u0000${site.line}\u0000${site.character}\u0000${site.kinds.join(',')}`;
}

/** Group sites in the ticket order WRITE → READ → DELETE, each file:line sorted. */
export function groupRwSites(sites: readonly RwSite[]): RwGroups {
  const groups: RwGroups = { write: [], read: [], delete: [] };
  const seen = new Map<keyof RwGroups, Set<string>>();
  for (const groupName of ['write', 'read', 'delete'] as const) {
    seen.set(groupName, new Set<string>());
  }
  for (const site of sites) {
    if (site.kinds.includes('write')) {
      addUnique(groups.write, site, seen.get('write')!);
    }
    if (site.kinds.includes('read')) {
      addUnique(groups.read, site, seen.get('read')!);
    }
    if (site.kinds.includes('delete')) {
      addUnique(groups.delete, site, seen.get('delete')!);
    }
  }
  groups.write.sort(compareRwSites);
  groups.read.sort(compareRwSites);
  groups.delete.sort(compareRwSites);
  return groups;
}

function addUnique(target: RwSite[], site: RwSite, seen: Set<string>): void {
  const key = siteKey(site);
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  target.push(site);
}

export function countRwGroups(groups: RwGroups): RwGroupCounts {
  const write = groups.write.length;
  const read = groups.read.length;
  const deleteCount = groups.delete.length;
  return { write, read, delete: deleteCount, total: write + read + deleteCount };
}
