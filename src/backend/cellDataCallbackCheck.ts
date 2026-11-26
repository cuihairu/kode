/**
 * cellData callback-entry access check (KSEM-CELL-12): reading self.cellData
 * inside onGetCell must throw.
 *
 * Engine evidence (base side, kbe/src/server/baseapp/entity.cpp, kbengine@3082ab5):
 * - onGetCell first runs destroyCellData() (:1024, PyObject_DelAttrString
 *   removes the attribute at :564) and only **afterwards** invokes the script
 *   callback (:1030-1032) -- any evaluation of self.cellData inside the
 *   callback raises AttributeError (no type-level cellData getter exists in
 *   the attribute table; it is a pure instance attribute with no fallback
 *   once deleted).
 * - cellData is only reinstalled in two places: at construction time (:252)
 *   and in onBackupCellData's isDirty branch (:1122); it is never reinstalled
 *   inside onGetCell -- "the engine deleted it" is a certain fact within this
 *   method body.
 * - The predicate only covers onGetCell as an **explicit callback entry**; no
 *   definite conclusion is drawn about how the call timing of
 *   onLoseCell/onRestore/arbitrary methods relates to cellData presence
 *   (verbatim from acceptance), and this surface stays silent on all of them.
 *
 * Evaluation/store classification (per line, paren-depth aware):
 * - `self.cellData = <dict>` is an attribute store, legal, does not throw --
 *   **not reported**, and later reads in this method body are equally not
 *   reported because the attribute has been rebuilt (two-state flow:
 *   absent/present; store -> present, del -> absent, read while absent ->
 *   reported);
 * - `self.cellData[k] = v`, `.get(...)`, iteration, alias binding, del -- all
 *   evaluate the attribute first, and are always reported in the absent state;
 * - comments and strings are removed by the mask ("self.cellData" inside a
 *   string is not an access).
 *
 * Scope: methods named onGetCell inside class bodies (module-level functions
 * of the same name are never invoked by the engine, so not reported). The
 * role gate lives in the assembly surface (base scripts); the pure logic has
 * no vscode / no key universe / no RPC, and is directly testable.
 */
import { parsePythonFile, pythonCodeLines } from './pythonParser';

/** Diagnostic code produced by this surface (kept in lockstep with lintRuleRegistry). */
export const CELL_DATA_CALLBACK_CODE = 'kbengine.cellDataLifecycle';

/** One callback-entry access finding (pure data; converted to vscode.Diagnostic on the extension side). */
export interface CellDataCallbackFinding {
  /** 0-based line. */
  line: number;
  /** Start of `self.cellData` (0-based character column within the line). */
  character: number;
  /** Length of `self.cellData` (hint range = the receiver expression itself). */
  length: number;
  message: string;
}

/** Diagnostic item (pure data; same shape as the CELL-08/10 item, so the assembly surface can be shared). */
export interface CellDataCallbackDiagnosticItem {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  message: string;
  severity: 'Warning';
  source: 'kbengine';
  code: string;
}

/** Toggle default (same contract as CELL-08/10: on by default). */
export const CELL_DATA_CALLBACK_DIAGNOSTICS_ENABLED_DEFAULT = true;

const ACCESS_RE = /\bself\.cellData\b/g;

/** onGetCell body (0-based, including the def line, excluding narrowing lines). Indent gate: stop at the first non-blank line whose indent is <= the def indent. */
function methodBodySpan(lines: string[], defLine: number): { start: number; end: number } {
  const defIndent = lines[defLine].match(/^\s*/)![0].length;
  let end = lines.length;
  for (let i = defLine + 1; i < lines.length; i += 1) {
    const raw = lines[i];
    if (raw.trim() === '') {
      continue;
    }
    if (raw.match(/^\s*/)![0].length <= defIndent) {
      end = i;
      break;
    }
  }
  return { start: defLine, end };
}

/**
 * Per-line store predicate: after `self.cellData`, is there a depth-0 plain
 * assignment `=` later on the same line. `[`/`(` appearing before the `=`
 * means the subscript/call already evaluated the attribute, not a store.
 * The `=` in `==`/`<=`/`>=`/`!=`/augmented (`+=` etc.)/walrus (`:=`) is not a
 * store.
 */
function isAttributeStore(maskedLine: string, tokenEnd: number): boolean {
  let depth = 0;
  let previous = '';
  for (let i = tokenEnd; i < maskedLine.length; i += 1) {
    const ch = maskedLine[i];
    if (ch === '[' || ch === '(' || ch === '{') {
      if (depth === 0 && ch === '[') {
        return false; // self.cellData[k] = v: the subscript evaluates the attribute first -> read
      }
      depth += 1;
    } else if (ch === ']' || ch === ')' || ch === '}') {
      depth = Math.max(0, depth - 1);
    } else if (ch === '=' && depth === 0) {
      if (maskedLine[i + 1] === '=') {
        continue; // ==
      }
      if (previous !== '' && '=+-*/%<>&|^:!'.includes(previous)) {
        continue; // == <= >= != += -= … :=
      }
      return true;
    }
    if (ch !== ' ' && ch !== '\t') {
      previous = ch;
    }
  }
  return false;
}

/** Whether the line holds `del self.cellData` (the nearest non-blank token before the token is the del keyword). */
function isDelStatement(maskedLine: string, tokenStart: number): boolean {
  return /\bdel\s+$/.test(maskedLine.slice(0, tokenStart));
}

/** cellData attribute state: absent = the engine deleted it (the onGetCell entry state); present = the script rebuilt it inside this method body. */
export type AttrState = 'absent' | 'present';

/** Set of onGetCell method spans (0-based def lines; module-level same-name functions are absent from classes.methods and thus naturally excluded). */
function onGetCellSpans(text: string): Array<{ line: number; character: number }> {
  const parsed = parsePythonFile(text, 'virtual.py');
  const spans: Array<{ line: number; character: number }> = [];
  for (const cls of parsed.classes) {
    const loc = cls.methods.get('onGetCell');
    if (loc) {
      spans.push(loc);
    }
  }
  return spans;
}

/**
 * Advance the two-state flow by one line: classify each `self.cellData`
 * access on the masked line as store/del/read and update the state; del/read
 * in the absent state are reported through onFinding (stores are not). Line
 * order is left to right.
 */
function advanceLine(
  masked: string,
  state: AttrState,
  lineNo: number,
  onFinding: ((finding: CellDataCallbackFinding) => void) | null
): AttrState {
  let next = state;
  ACCESS_RE.lastIndex = 0;
  let match = ACCESS_RE.exec(masked);
  while (match) {
    const tokenStart = match.index;
    const tokenEnd = tokenStart + match[0].length;
    if (isAttributeStore(masked, tokenEnd)) {
      next = 'present';
    } else if (isDelStatement(masked, tokenStart)) {
      // Engine evidence, quoted into the message: deletion happens before the
      // callback (cellapp/entity.cpp same-family conclusions are not mixed in;
      // this surface only talks about base-side onGetCell). del and read raise
      // the same AttributeError in the absent state.
      if (next === 'absent' && onFinding) {
        onFinding({
          line: lineNo,
          character: tokenStart,
          length: match[0].length,
          message: 'onGetCell 触发时 self.cellData 已被引擎删除(cell 建成即删属性,baseapp/entity.cpp:1024 在脚本回调 :1030 之前),此处 del 同样抛 AttributeError'
        });
      }
      next = 'absent';
    } else if (next === 'absent' && onFinding) {
      onFinding({
        line: lineNo,
        character: tokenStart,
        length: match[0].length,
        message: 'onGetCell 触发时 self.cellData 已被引擎删除(cell 建成即删属性,baseapp/entity.cpp:1024 在脚本回调 :1030 之前),此处读取必然抛 AttributeError;需要的数据请在请求 cell 前存入 base 自有属性'
      });
    }
    match = ACCESS_RE.exec(masked);
  }
  return next;
}

/** self.cellData access check inside onGetCell (pure function). */
export function cellDataCallbackFindings(text: string): CellDataCallbackFinding[] {
  const spans = onGetCellSpans(text);
  if (spans.length === 0) {
    return [];
  }

  const maskedLines = pythonCodeLines(text);
  const findings: CellDataCallbackFinding[] = [];
  for (const span of spans) {
    const body = methodBodySpan(maskedLines, span.line);
    let state: AttrState = 'absent';
    for (let lineNo = body.start; lineNo < body.end; lineNo += 1) {
      state = advanceLine(maskedLines[lineNo], state, lineNo, finding => {
        findings.push(finding);
      });
    }
  }
  return findings;
}

/** CELL-14: hover surface -- the onGetCell window containing the position and the two-state flow state just before entering that line. */
export interface CellDataProvenWindow {
  /** Whether the position falls inside some onGetCell method body. */
  inWindow: boolean;
  /** Within the window: the attribute state the line's **first access** will see (absent = engine deleted / present = rebuilt); null outside the window. */
  state: AttrState | null;
}

/**
 * Proven state at a position line (pure function): the state is the attribute
 * state after processing [method body start, queried line) (with multiple
 * accesses on the same line, hover gives the state the first access of the line
 * will see; outside the window, no proof).
 */
export function cellDataProvenStateAtLine(text: string, line: number): CellDataProvenWindow {
  const spans = onGetCellSpans(text);
  if (spans.length === 0) {
    return { inWindow: false, state: null };
  }
  const maskedLines = pythonCodeLines(text);
  for (const span of spans) {
    const body = methodBodySpan(maskedLines, span.line);
    if (line < body.start || line >= body.end) {
      continue;
    }
    let state: AttrState = 'absent';
    for (let lineNo = body.start; lineNo < line; lineNo += 1) {
      state = advanceLine(maskedLines[lineNo], state, lineNo, null);
    }
    return { inWindow: true, state };
  }
  return { inWindow: false, state: null };
}

/** Finding -> diagnostic item (range = the `self.cellData` expression itself). */
export function cellDataCallbackFindingToItem(
  finding: CellDataCallbackFinding
): CellDataCallbackDiagnosticItem {
  return {
    range: {
      start: { line: finding.line, character: finding.character },
      end: { line: finding.line, character: finding.character + finding.length }
    },
    message: finding.message,
    severity: 'Warning',
    source: 'kbengine',
    code: CELL_DATA_CALLBACK_CODE
  };
}
