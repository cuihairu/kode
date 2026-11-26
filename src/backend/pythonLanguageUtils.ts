export interface PythonSelfAccess {
  rootSymbol: string;
  currentSymbol: string;
  fullPath: string;
}

export interface PythonSelfCompletionContext {
  rootSymbol: string | null;
  parentPath: string;
  fullPath: string;
  partialSymbol: string;
}

export function getPythonSelfAccessAtPosition(
  lineText: string,
  character: number
): PythonSelfAccess | null {
  const regex = /\bself\.(\w+(?:\.\w+)*)/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(lineText)) !== null) {
    const fullMatch = match[0];
    const accessPath = match[1];
    // fullMatch always equals 'self.' + accessPath (a reverse finding from batch 86 M7:
    // indexOf hits a like-shaped substring inside 'self', and the 'e' of 'self.e' makes
    // pathStart run out of bounds), so the path start comes from suffix arithmetic
    const pathStart = match.index + fullMatch.length - accessPath.length;
    const segments = accessPath.split('.');

    let segmentOffset = pathStart;
    for (const segment of segments) {
      const segmentStart = segmentOffset;
      const segmentEnd = segmentStart + segment.length;

      if (character >= segmentStart && character <= segmentEnd) {
        return {
          rootSymbol: segments[0],
          currentSymbol: segment,
          fullPath: accessPath
        };
      }

      segmentOffset = segmentEnd + 1;
    }
  }

  return null;
}

/** def method section (same shape as defParser's DefMethodSection; here only the receiver-section mapping is done) */
export type PythonReceiverSection = 'BaseMethods' | 'CellMethods' | 'ClientMethods';

export interface PythonReceiverCall {
  /** Document line (0-based; always 0 under the single-line accounting) */
  line: number;
  /** Starting column of the method name within the line (0-based) */
  character: number;
  /** Receiver section: the section name for self.cell / self.base / self.client */
  receiver: 'cell' | 'base' | 'client';
  /** def method section corresponding to the receiver section (the basis for the section gate) */
  section: PythonReceiverSection;
  /** Name of the method being called */
  methodName: string;
  /**
   * Caller face (converted from the script directory domain; the basis for the
   * per-face semantic gate). Unconverted (the caller gave no path domain) ->
   * undefined: the semantic gate follows the old accounting (receiver -> section)
   * and does not rule on legality.
   */
  callerFace?: PythonCallerFace;
}

/** Receiver section -> def method section (user order 2026-10-21: cell->CellMethods etc., one-to-one) */
export const PYTHON_RECEIVER_SECTIONS: Record<
  PythonReceiverCall['receiver'],
  PythonReceiverSection
> = {
  cell: 'CellMethods',
  base: 'BaseMethods',
  client: 'ClientMethods'
};

/** def method section -> receiver section (the reference-collection face IDE-NAV-003: CellMethods->cell etc., a reverse-lookup table) */
export const PYTHON_RECEIVER_BY_SECTION: Record<
  PythonReceiverSection,
  PythonReceiverCall['receiver']
> = {
  CellMethods: 'cell',
  BaseMethods: 'base',
  ClientMethods: 'client'
};

/**
 * Caller face (script directory domain: scripts/base|cell|client|bots; the same
 * name and domain as entityMapping's pythonScriptDomain -- no dependency is pulled in
 * here, the caller converts the value).
 */
export type PythonCallerFace = 'base' | 'cell' | 'client';

/**
 * Per-face semantic table (closing out deep audit-3, the engine's nine-face attribute
 * table; single-source semantics shared with Rust refs.rs bind_self_role): for each
 * caller face, the legal dispatch target section of self.<receiver>; a face lacking
 * this role attribute -> null. Engine evidence (each SCRIPT_GET_DECLARE construction
 * site checked by hand): baseapp has .cell/.client (baseapp/entity.cpp:750/:800),
 * cellapp has .base/.client (cellapp/entity.cpp:391/:573, and .client is
 * CLIENT_VIA_BASE, whose target section is still ClientMethods), and client has
 * .base/.cell (client_lib/entity.cpp:104/:115); a face never has this attribute for
 * itself (base.base/cell.cell/client.client, since it already is that face; on the
 * client face the like-named .clientapp is an application object, not a role reference).
 * The old unconditional section mapping would take an AttributeError reference and
 * treat it as a legal dispatch to reconcile against def sections -- contradicting
 * bind_self_role (nine-face table: an illegal face·attr combination -> None), so the
 * diagnostics gate must pass this table first.
 */
export const PYTHON_RECEIVER_FACES: Record<
  PythonCallerFace,
  Record<PythonReceiverCall['receiver'], PythonReceiverSection | null>
> = {
  base: { cell: 'CellMethods', base: null, client: 'ClientMethods' },
  cell: { cell: null, base: 'BaseMethods', client: 'ClientMethods' },
  client: { cell: 'CellMethods', base: 'BaseMethods', client: null }
};

/**
 * Per-face semantic gate: resolve the receiver's target section on that caller face
 * (the basis for the section gate). A known caller face -> the nine-face table rules
 * (a face lacking this attribute -> null; the reference is an AttributeError and the
 * def-section reconciliation does not apply); an unknown caller face -> keep the old
 * accounting (receiver -> section; the target-section mapping holds whenever the
 * reference is legal, and ruling on legality is unrelated to the target section on an
 * unknown face).
 */
export function pythonReceiverSectionFor(
  callerFace: PythonCallerFace | null | undefined,
  receiver: PythonReceiverCall['receiver']
): PythonReceiverSection | null {
  if (callerFace) {
    return PYTHON_RECEIVER_FACES[callerFace][receiver];
  }
  return PYTHON_RECEIVER_SECTIONS[receiver];
}

/** Only the self.<role>.<name> shape is recognised; local receivers such as entity.cell.X are not (user order) */
const PYTHON_RECEIVER_CALL_PATTERN =
  /\bself\.(cell|base|client)\.([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * Resolve the receiver call at the cursor: for the F12/Hover face. The cursor must sit
 * on the method-name token (the third segment of self.cell./self.base./self.client.);
 * on the receiver section or elsewhere -> null.
 * callerFace is optional (the per-face semantic-gate basis, see pythonReceiverSectionFor).
 */
export function getPythonReceiverCallAtPosition(
  lineText: string,
  character: number,
  callerFace?: PythonCallerFace
): PythonReceiverCall | null {
  const regex = new RegExp(PYTHON_RECEIVER_CALL_PATTERN.source, 'g');
  let match: RegExpExecArray | null;

  while ((match = regex.exec(lineText)) !== null) {
    const methodName = match[2];
    // match[0] is always 'self.<role>.' + methodName (same accounting as batch 86: the start
    // comes from suffix arithmetic, not indexOf -- a like-shaped substring of 'self' would
    // misalign the method name)
    const nameStart = match.index + match[0].length - methodName.length;
    const nameEnd = nameStart + methodName.length;
    if (character < nameStart || character > nameEnd) {
      continue;
    }
    const receiver = match[1] as PythonReceiverCall['receiver'];
    const section = pythonReceiverSectionFor(callerFace, receiver);
    if (section === null) {
      return null; // the caller face has no such role attribute (AttributeError face): derive nothing
    }
    return {
      line: 0,
      character: nameStart,
      receiver,
      section,
      methodName,
      callerFace
    };
  }

  return null;
}

/** Whole-document receiver-call scan (the CodeLens face): one entry per self.<role>.<name> occurrence per line */
export function findPythonReceiverCalls(
  text: string,
  callerFace?: PythonCallerFace
): PythonReceiverCall[] {
  const calls: PythonReceiverCall[] = [];
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const regex = new RegExp(PYTHON_RECEIVER_CALL_PATTERN.source, 'g');
    let match: RegExpExecArray | null;

    while ((match = regex.exec(lines[index])) !== null) {
      const methodName = match[2];
      const receiver = match[1] as PythonReceiverCall['receiver'];
      const section = pythonReceiverSectionFor(callerFace, receiver);
      if (section === null) {
        continue; // the caller face has no such role attribute: excluded from the discovery face (a precondition for the diagnostics gate's legality ruling)
      }
      calls.push({
        line: index,
        character: match.index + match[0].length - methodName.length,
        receiver,
        section,
        methodName,
        callerFace
      });
    }
  }

  return calls;
}

export interface PythonReceiverCallArgumentSpan {
  /** Column of the argument's first character (0-based, leading whitespace skipped) */
  start: number;
  /** One past the argument's end (trailing whitespace trimmed; the inlay hint anchor) */
  end: number;
  /** The argument's raw text with whitespace trimmed (no derivation at all; used only for count alignment) */
  text: string;
}

export interface PythonReceiverCallWithArguments extends PythonReceiverCall {
  /**
   * Argument spans split at top-level commas under the single-line accounting; a
   * multiline call or unbalanced brackets -> an empty array (inlay offers no hint for
   * that call). Purely mechanical splitting, zero semantic derivation.
   */
  arguments: PythonReceiverCallArgumentSpan[];
}

const CALL_ARGUMENT_OPENERS = new Set(['(', '[', '{']);
const CALL_ARGUMENT_CLOSERS = new Set([')', ']', '}']);
const CALL_ARGUMENT_CLOSER_FOR: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

/**
 * Take the same-line arguments from the end of the method name: from the first '(' up to
 * the ')' at depth 0, with the content split at top-level commas (depth tracks ()[]{};
 * commas/brackets inside a ' " string do not count). No closing ')' on the line -> null
 * (a multiline call yields no argument table).
 */
export function parseSingleLineCallArguments(
  lineText: string,
  scanFrom: number
): PythonReceiverCallArgumentSpan[] | null {
  let openParen = -1;
  for (let index = scanFrom; index < lineText.length; index += 1) {
    if (lineText[index] === '(') {
      openParen = index;
      break;
    }
    if (!/\s/.test(lineText[index])) {
      // some other token appears between the method name and '(' (such as a trailing operator before a line break) -> not recognised
      return null;
    }
  }
  if (openParen === -1) {
    return null;
  }

  const spans: PythonReceiverCallArgumentSpan[] = [];
  const depth: string[] = [];
  let inString: string | null = null;
  let currentStart = -1;

  for (let index = openParen + 1; index < lineText.length; index += 1) {
    const ch = lineText[index];
    if (inString) {
      if (ch === '\\') {
        index += 1;
        continue;
      }
      if (ch === inString) {
        inString = null;
      }
      continue;
    }
    if (ch === '\'' || ch === '"') {
      inString = ch;
      if (depth.length === 0 && currentStart === -1) {
        currentStart = index;
      }
      continue;
    }
    if (depth.length === 0 && ch === ')') {
      if (currentStart !== -1) {
        spans.push(finishArgumentSpan(lineText, currentStart, index));
      }
      return spans;
    }
    if (depth.length === 0 && ch === ',') {
      if (currentStart !== -1) {
        spans.push(finishArgumentSpan(lineText, currentStart, index));
        currentStart = -1;
      }
      continue;
    }
    if (CALL_ARGUMENT_OPENERS.has(ch)) {
      if (depth.length === 0 && currentStart === -1) {
        currentStart = index;
      }
      depth.push(CALL_ARGUMENT_CLOSER_FOR[ch]);
      continue;
    }
    if (CALL_ARGUMENT_CLOSERS.has(ch) && depth.length > 0 && ch === depth[depth.length - 1]) {
      depth.pop();
    }
    if (depth.length === 0 && currentStart === -1 && !/\s/.test(ch)) {
      currentStart = index;
    }
  }

  // the brackets do not close on this line (a multiline call) -> no argument table at all
  return null;
}

function finishArgumentSpan(
  lineText: string,
  start: number,
  end: number
): PythonReceiverCallArgumentSpan {
  let lo = start;
  let hi = end;
  while (lo < hi && /\s/.test(lineText[lo])) {
    lo += 1;
  }
  while (hi > lo && /\s/.test(lineText[hi - 1])) {
    hi -= 1;
  }
  return { start: lo, end: hi, text: lineText.slice(lo, hi) };
}

/** Whole-document receiver-call argument scan (the inlay parameter-hint face): the call plus its same-line argument spans */
export function findPythonReceiverCallArguments(
  text: string,
  callerFace?: PythonCallerFace
): PythonReceiverCallWithArguments[] {
  return findPythonReceiverCalls(text, callerFace).map(call => {
    const lineText = text.split(/\r?\n/)[call.line] ?? '';
    const nameEnd = call.character + call.methodName.length;
    const arguments_ = parseSingleLineCallArguments(lineText, nameEnd);
    return { ...call, arguments: arguments_ ?? [] };
  });
}

export function getPythonSelfSymbolAtPosition(lineText: string, character: number): string | null {
  const access = getPythonSelfAccessAtPosition(lineText, character);
  return access ? access.rootSymbol : null;
}

export function getPythonSelfCompletionContext(lineText: string): PythonSelfCompletionContext | null {
  const match = lineText.match(/\bself\.(\w+(?:\.\w+)*)?\.?$/);
  if (!match) {
    return null;
  }

  const accessPath = match[1] || '';
  const endsWithDot = lineText.endsWith('.');
  const segments = accessPath ? accessPath.split('.') : [];

  if (endsWithDot) {
    return {
      rootSymbol: segments.length > 0 ? segments[0] : null,
      parentPath: accessPath,
      fullPath: accessPath,
      partialSymbol: ''
    };
  }

  // Unreachable (the batch 65 verdict): reaching here requires "the regex matched and the
  // line does not end with '.'" -- when group 1 does not match, the matched string can only
  // be 'self.'/'self..' (a double dot is likewise swallowed by `\.?`), both ending with '.'
  // and thus early-exited at endsWithDot above; when group 1 matches, accessPath contains
  // at least one \w segment, so segments is never empty. Both conditionals always take the
  // true arm, and the ''/null fallbacks have no triggering path. The statements and branch
  // entries are removed from the denominator together with the region (the denominator
  // accounting in TESTING.md is recorded as-is); tests/pythonLanguageUtils.test.ts additionally
  // pins the input shapes that reach here with 'self..' (a double dot still takes the early
  // exit) and 'self.a..' (a failed anchor maps to null).
  /* istanbul ignore start */
  const partialSymbol = segments.length > 0 ? segments[segments.length - 1] : '';
  const rootSymbol = segments.length > 0 ? segments[0] : null;
  /* istanbul ignore stop */
  const parentPath = segments.length > 1 ? segments.slice(0, -1).join('.') : '';

  return {
    rootSymbol,
    parentPath,
    fullPath: accessPath,
    partialSymbol
  };
}

export interface PythonMemberAccess {
  /** Receiver name (not self: object names such as avatar/monster) */
  receiverName: string;
  /** The member name under the cursor (the method-name segment) */
  memberName: string;
  /** Full access path: receiver.member */
  fullPath: string;
}

/**
 * Member access resolution at the cursor (batch 158, user order 2026-10-26): the call
 * shape for a non-self receiver, avatar.SendErrorInfo("err", 1). Only the "call shape"
 * is recognised -- what follows the member name (whitespace allowed) must be '('; an
 * attribute read or a passed method reference does not go through this layer. self.*
 * has its own pipeline (getPythonSelfAccessAtPosition) and is skipped here to avoid a
 * double pipeline. The cursor must sit on the member-name segment (the same accounting
 * as receiver calls: the start comes from suffix arithmetic, not indexOf -- a
 * like-shaped substring of the receiver would misalign the member name); sitting on the
 * receiver segment is not recognised (the receiver word is owned by other faces).
 */
export function getPythonMemberAccessAtPosition(
  lineText: string,
  character: number
): PythonMemberAccess | null {
  const regex = /\b([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(lineText)) !== null) {
    const receiverName = match[1];
    const memberName = match[2];
    if (receiverName === 'self') {
      continue;
    }
    const nameStart = match.index + match[0].length - memberName.length;
    const nameEnd = nameStart + memberName.length;
    if (character < nameStart || character > nameEnd) {
      continue;
    }
    let scan = nameEnd;
    while (scan < lineText.length && /\s/.test(lineText[scan])) {
      scan += 1;
    }
    if (lineText[scan] !== '(') {
      continue;
    }
    return {
      receiverName,
      memberName,
      fullPath: `${receiverName}.${memberName}`
    };
  }

  return null;
}

export interface PythonCallAtPosition {
  /** Receiver: 'self' or an object variable name (avatar etc.) */
  receiverName: string;
  /** The method name being called */
  methodName: string;
  /** The def method section of the receiver section (the same accounting as
   *  PythonReceiverCall.section, the basis for the section gate); no section (undefined) */
  section?: PythonReceiverSection;
  /** Index of the argument under the cursor (split at top-level commas, 0-based) */
  activeArgument: number;
}

/**
 * Call resolution at the cursor (the batch 159 signature-help face): covers both shapes,
 * self.base/cell/client.X(...) and an object call avatar.X(...); the cursor must fall
 * "between the method name and '(' or inside the argument table" (the argument table
 * counts top-level commas with string-aware depth, the same accounting as the inlay
 * argument split). An attribute read (no '(' after the name) is not recognised; nor is a
 * position inside no call's argument table.
 */
export function getPythonCallAtPosition(
  lineText: string,
  character: number
): PythonCallAtPosition | null {
  const regex = /\b(self\.(?:base|cell|client)|[A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)[ \t]*\(/g;
  const candidates: Array<PythonCallAtPosition & { callOpen: number }> = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(lineText)) !== null) {
    const receiverToken = match[1];
    const methodName = match[2];
    const callOpen = match.index + match[0].length - 1; // the column of '('
    // The cursor must fall within '(' and its argument table; the method name does not count (signature help is not triggered here)
    if (character < callOpen) {
      continue;
    }
    // String-aware depth scan of the argument table: top-level commas fix the active argument, and the closing bracket is found along the way
    let depth = 0;
    let inString: string | null = null;
    let activeArgument = 0;
    let closed = false;
    let closeIndex = -1;
    for (let i = callOpen; i < lineText.length; i += 1) {
      const ch = lineText[i];
      if (inString) {
        if (ch === '\\') {
          i += 1;
        } else if (ch === inString) {
          inString = null;
        }
        continue;
      }
      if (ch === '\'' || ch === '"') {
        inString = ch;
        continue;
      }
      if (ch === '(' || ch === '[' || ch === '{') {
        depth += 1;
      } else if (ch === ')' || ch === ']' || ch === '}') {
        depth -= 1;
        if (depth === 0) {
          closed = true;
          closeIndex = i;
          break;
        }
      } else if (ch === ',' && depth === 1 && i < character) {
        activeArgument += 1;
      }
    }
    // Ownership test: a closed call requires the cursor not to pass its closing bracket (several
    // calls on one line must not swallow each other); an unclosed one (mid-typing while
    // asking for help) is treated as extending to end of line, and a cursor past it counts.
    if (closed && closeIndex < character) {
      continue;
    }
    const isReceiver = receiverToken.startsWith('self.');
    candidates.push({
      receiverName: isReceiver ? 'self' : receiverToken,
      methodName,
      section: isReceiver
        ? PYTHON_RECEIVER_SECTIONS[receiverToken.split('.')[1] as PythonReceiverCall['receiver']]
        : undefined,
      activeArgument,
      callOpen
    });
  }

  // When nested or adjacent, take the one with the latest start (the call most tightly containing the cursor; match order is already ascending by callOpen)
  return candidates.length > 0 ? candidates[candidates.length - 1] : null;
}
