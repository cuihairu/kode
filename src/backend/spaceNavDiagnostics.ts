/**
 * SP-4: space/navigation semantic diagnostics (pure text face, engine-source
 * evidence, low-false-positive contract).
 *
 * Three conservative checks:
 * 1) setSpaceData/delSpaceData using the reserved key "_mapping"
 *    — the engine rejects it on both the set/del paths: spacememory.cpp:740
 *    (set), :862 (del), "key{_mapping} is protected!"; _mapping is the engine's
 *    internal geometry-mapping storage key
 *    (setGeometryPath→setSpaceData("_mapping", path), spacememory.cpp:547).
 * 2) the file has navigate/navigatePathPoints calls but no canNavigate anywhere
 *    — with geometry/nav data not loaded, navigate fails silently
 *    (entity.cpp:2583-2589, not found navhandle → paths empty → navigate
 *    returns 0 and builds no controller). canNavigate() is the engine's exposed
 *    readiness probe (entity.cpp:2563-2576, pNavHandle==NULL means False);
 *    calling navigate while never verifying the precondition → Warning.
 *    Reported only when the file has no canNavigate occurrence at all, avoiding
 *    noise in files that do have guards.
 * 3) addSpaceGeometryMapping's params dict keys must be int literals
 *    — after the engine's PyDict_Next, PyLong_Check(key) failing raises the
 *    "args(params) error!" AssertionError (spacememory.cpp:194); a string-level
 *    key ({"0": "..."}) explodes at runtime. Only the dict's **top-level**
 *    literal keys are checked (the engine does not validate string keys of
 *    nested dicts); variable/expression evaluation results are never guessed.
 *
 * Pure functions, no vscode dependency; the extension side converts to
 * vscode.Diagnostic and hangs off DiagnosticScheduler (the same lifecycle as
 * receiverNone/startupScript).
 * Switch: kbengine.spaceNavDiagnostics (on by default).
 */

import { l10nText } from '../nlsRuntime';

export const SPACE_NAV_DIAGNOSTIC_CODE = 'kbengine.spaceNav';
export const SPACE_NAV_DIAGNOSTICS_ENABLED_DEFAULT = true;

export interface SpaceNavFinding {
  /** Line (0-based) */
  line: number;
  /** Column (0-based, at the hit token's start) */
  start: number;
  /** Column (0-based, exclusive, at the token's end) */
  end: number;
  message: string;
  code: string;
}

const MAPPING_KEY_RE =
  /\b(?:setSpaceData|delSpaceData)\s*\(\s*[^,)]+,\s*("|')_mapping\1/g;
// Only self.navigate / self.navigatePathPoints count (the engine's entity-method
// call convention); calls on any object (avatar.navigate etc.) are not treated as
// engine methods, avoiding unrelated warnings.
const NAV_CALL_RE = /\bself\s*\.\s*(navigate|navigatePathPoints)\s*\(/g;
const CAN_NAVIGATE_RE = /\bcanNavigate\b/g;

/**
 * The **top-level** quoted keys in a dict body (nested dict/list keys are not
 * collected): returns [body offset, raw token]. The engine's PyDict_Next only
 * sees top-level keys (spacememory.cpp:194 checks top level only), so a nested
 * {"a": 1}'s string key is not a params key. Scans character by character:
 * strings are skipped whole (escapes included), and a key position counts only
 * when, after the closing quote, whitespace is followed by `:` at depth 0.
 */
function topLevelQuotedKeys(body: string): Array<[number, string]> {
  const out: Array<[number, string]> = [];
  let depth = 0;
  let i = 0;
  const n = body.length;
  while (i < n) {
    const ch = body[i];
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (body[j] === '\\') {
          j += 2;
          continue;
        }
        if (body[j] === ch) {
          break;
        }
        j += 1;
      }
      if (j >= n) {
        return out; // unclosed: stop conservatively
      }
      const token = body.slice(i, j + 1);
      let k = j + 1;
      while (k < n && /\s/.test(body[k])) {
        k += 1;
      }
      if (depth === 0 && k < n && body[k] === ':') {
        out.push([i, token]);
      }
      i = j + 1;
      continue;
    }
    if (ch === '{' || ch === '[') {
      depth += 1;
    } else if (ch === '}' || ch === ']') {
      depth -= 1;
    }
    i += 1;
  }
  return out;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') {
      starts.push(i + 1);
    }
  }
  return starts;
}

function offsetToLine(starts: readonly number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo;
}

/** Whole-text offset → in-line column (0-based): subtract the line's start offset. */
function offsetToCol(starts: readonly number[], offset: number): number {
  return offset - starts[offsetToLine(starts, offset)];
}

/**
 * Pure-text lexical mask: true = the position is in code (not a comment/string).
 * Filters space-nav matches — navigate/canNavigate occurrences in comments/
 * strings do not participate in the semantic decision, avoiding unrelated
 * warnings. A character-at-a-time state machine: line comments #, single/double
 * quoted strings (triple quotes included).
 */
function codeMask(text: string): boolean[] {
  const mask = new Array<boolean>(text.length).fill(true);
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '#') {
      // line comment: to the line end (newline not included)
      while (i < n && text[i] !== '\n') {
        mask[i] = false;
        i += 1;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      const q = ch;
      const triple = text[i + 1] === q && text[i + 2] === q;
      mask[i] = false;
      i += 1;
      if (triple) {
        mask[i] = false;
        i += 1;
        mask[i] = false;
        i += 1;
      }
      while (i < n) {
        mask[i] = false;
        if (text[i] === '\\') {
          i += 1;
          if (i < n) {
            mask[i] = false;
            i += 1;
          }
          continue;
        }
        if (triple) {
          if (text[i] === q && text[i + 1] === q && text[i + 2] === q) {
            mask[i] = false;
            mask[i + 1] = false;
            mask[i + 2] = false;
            i += 3;
            break;
          }
        } else if (text[i] === q) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    i += 1;
  }
  return mask;
}

/**
 * Find the dict literal interval at the params position of an
 * addSpaceGeometryMapping call. Strategy: a bracket-depth scan from the call's
 * opening paren, skipping strings; a `{` at depth==1 is the params dict (the
 * engine signature's 5th parameter; returns null when there is no dict).
 * Returns [dictOpen, dictClose] character indexes (brackets included).
 */
function findParamsDictSpan(text: string, callOpen: number): [number, number] | null {
  let depth = 0;
  let inString: string | null = null;
  let dictOpen = -1;
  for (let i = callOpen; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') {
        i += 1;
      } else if (ch === inString) {
        inString = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      if (ch === '{' && depth === 1 && dictOpen < 0) {
        dictOpen = i;
      }
      depth += 1;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) {
        // the call closes; an unclosed dict is invalid
        if (dictOpen >= 0) {
          return null;
        }
        return null;
      }
      if (ch === '}' && dictOpen >= 0 && depth === 1) {
        return [dictOpen, i];
      }
    }
  }
  return null;
}

export function computeSpaceNavFindings(text: string): SpaceNavFinding[] {
  if (!text) {
    return [];
  }
  const findings: SpaceNavFinding[] = [];
  const starts = lineStarts(text);
  const mask = codeMask(text);
  const inCode = (offset: number): boolean => offset >= 0 && offset < mask.length && mask[offset];

  // -- 1) the _mapping reserved key --
  MAPPING_KEY_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MAPPING_KEY_RE.exec(text)) !== null) {
    if (!inCode(match.index)) continue; // the call is inside a comment/string → no report
    const keyToken = match[0];
    // The hit position lands on "_mapping"
    const keyOffset = match.index + keyToken.lastIndexOf(match[1] + '_mapping' + match[1]);
    const keyLen = '_mapping'.length + 2;
    findings.push({
      line: offsetToLine(starts, keyOffset),
      start: offsetToCol(starts, keyOffset),
      end: offsetToCol(starts, keyOffset) + keyLen,
      message: renderMappingKeyMessage(),
      code: SPACE_NAV_DIAGNOSTIC_CODE
    });
  }

  // -- 2) self.navigate / self.navigatePathPoints without a canNavigate precondition --
  let hasCanNavigate = false;
  CAN_NAVIGATE_RE.lastIndex = 0;
  let guardMatch: RegExpExecArray | null;
  while ((guardMatch = CAN_NAVIGATE_RE.exec(text)) !== null) {
    if (inCode(guardMatch.index)) {
      hasCanNavigate = true;
      break;
    }
  }
  if (!hasCanNavigate) {
    NAV_CALL_RE.lastIndex = 0;
    while ((match = NAV_CALL_RE.exec(text)) !== null) {
      const offset = match.index;
      if (!inCode(offset)) continue; // calls in comments/strings are not reported
      // The method name's start (after self.), used to locate the column.
      const methodOffset = offset + match[0].indexOf(match[1]);
      // Audit finding: `\s*` can cross lines (self\n.navigate) — the line must be
      // the method name's line, from the same source as the column; taking the
      // self line would put the range on the wrong line with a column past the
      // line end.
      const line = offsetToLine(starts, methodOffset);
      findings.push({
        line,
        start: offsetToCol(starts, methodOffset),
        end: offsetToCol(starts, methodOffset) + match[1].length,
        message: renderNavigateNoGuardMessage(),
        code: SPACE_NAV_DIAGNOSTIC_CODE
      });
    }
  }

  // -- 3) params dict quoted keys (not int literals) --
  const mappingCallRe = /\baddSpaceGeometryMapping\s*\(/g;
  while ((match = mappingCallRe.exec(text)) !== null) {
    if (!inCode(match.index)) continue; // 调用在注释/字符串里 → 不报
    const callOpen = match.index + match[0].length - 1;
    const span = findParamsDictSpan(text, callOpen);
    if (!span) {
      continue;
    }
    const [dictOpen, dictClose] = span;
    const dictBody = text.slice(dictOpen + 1, dictClose);
    // Audit finding: the engine validates only the params' **top-level** keys
    // (PyDict_Next receives exactly the top-level keys, spacememory.cpp:194);
    // string keys of nested dicts are not validated — the old implementation
    // regex-scanned the whole dict body, so the nested key "a" in `{0: {"a": 1}}`
    // was misreported. Depth awareness collects top-level key positions only.
    for (const [bodyOffset, token] of topLevelQuotedKeys(dictBody)) {
      const keyOffset = dictOpen + 1 + bodyOffset;
      const keyLen = token.length;
      const line = offsetToLine(starts, keyOffset);
      findings.push({
        line,
        start: offsetToCol(starts, keyOffset),
        end: offsetToCol(starts, keyOffset) + keyLen,
        message: renderParamsStringKeyMessage(token),
        code: SPACE_NAV_DIAGNOSTIC_CODE
      });
    }
  }

  findings.sort((a, b) => a.line - b.line || a.start - b.start);
  return findings;
}

// ---- Rust face (AUDIT-005 B2 lane batch 3: spaceNav adoption) ------------------
// `$/kode/lint/analyzeSpaceNav` goes through gate.runInRust (the command face,
// the same contract as analyzeTraps): Rust returns only the structural face
// (code/line/character/length + kind/optional key); message rendering stays in
// this module (l10n single source). Unavailable / failed / malformed voids the
// whole face back to the TS sync path — partial adoption forbidden.

/** One structural-face item from Rust (the `$/kode/lint/analyzeSpaceNav` response) */
export interface SpaceNavRustItem {
  code: string;
  line: number;
  character: number;
  length: number;
  /** The three-message discriminator: mappingKey | navigateNoGuard | paramsStringKey */
  kind: string;
  /** The paramsStringKey l10n parameter (the key token) */
  key?: string;
}

/** The mappingKey message (an engine reserved key; _mapping is rejected by both the set/del paths) */
export function renderMappingKeyMessage(): string {
  return l10nText(
    'The key "_mapping" is an engine reserved key (rejected by both set and del, runtime AssertionError "key{_mapping} is protected!"). Space geometry is managed by addSpaceGeometryMapping; use another key. (spacememory.cpp:740/862)'
  );
}

/** The navigateNoGuard message (navigate called while canNavigate is never verified as a precondition) */
export function renderNavigateNoGuardMessage(): string {
  return l10nText(
    'navigate/navigatePathPoints called but canNavigate never appears: pathfinding fails silently when nav data is not loaded (paths empty, no move controller). Guard with if self.canNavigate() first. (entity.cpp:2583 not found navhandle; canNavigate entity.cpp:2563)'
  );
}

/** The paramsStringKey message (the engine requires int keys) */
export function renderParamsStringKeyMessage(key: string): string {
  return l10nText(
    'params-level key {key} is a string literal; the engine requires int keys (PyLong_Check failure raises AssertionError "args(params) error!"). Write {0: "xx.navmesh"}. (spacememory.cpp:194)',
    { key }
  );
}

/**
 * One structural-face item → the diagnostic face (message rendering); a missing
 * l10n parameter / unknown kind = malformed, returns null.
 * code/line/character/length type checks + the kind discriminator (the same
 * message source as the TS sync path).
 */
function renderRustSpaceNavItem(item: SpaceNavRustItem): SpaceNavFinding | null {
  if (
    typeof item?.code !== 'string'
    || typeof item.line !== 'number'
    || typeof item.character !== 'number'
    || typeof item.length !== 'number'
    || typeof item.kind !== 'string'
  ) {
    return null;
  }
  if (item.code !== SPACE_NAV_DIAGNOSTIC_CODE) {
    return null;
  }
  let message: string;
  switch (item.kind) {
    case 'mappingKey':
      message = renderMappingKeyMessage();
      break;
    case 'navigateNoGuard':
      message = renderNavigateNoGuardMessage();
      break;
    case 'paramsStringKey':
      if (typeof item.key !== 'string') {
        return null;
      }
      message = renderParamsStringKeyMessage(item.key);
      break;
    default:
      return null;
  }
  return {
    line: item.line,
    start: item.character,
    end: item.character + item.length,
    message,
    code: SPACE_NAV_DIAGNOSTIC_CODE
  };
}

/**
 * A structural-face array → a diagnostic-face array (message rendering); any
 * malformed item returns null (the whole face voided, the caller falls back to
 * TS — partial adoption forbidden). Shared by the parity tests.
 */
export function renderRustSpaceNavItems(items: readonly unknown[]): SpaceNavFinding[] | null {
  const rendered: SpaceNavFinding[] = [];
  for (const item of items) {
    const renderedItem = renderRustSpaceNavItem(item as SpaceNavRustItem);
    if (!renderedItem) {
      return null;
    }
    rendered.push(renderedItem);
  }
  return rendered;
}
