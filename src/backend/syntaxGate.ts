/**
 * INDEX-DISCIPLINE-001 (3): the python index input syntax gate — the TS side
 * (Rust primary path + TS fallback, following the ruffLint precedent pattern).
 *
 * The Rust side `$/kode/syntax/gate` (kode-server syntax_gate.rs) is the primary
 * pre-check path: bracket/quote balancing plus a coarse indentation consistency
 * check (single-pass scanner, microsecond scale, zero subprocesses).
 * This file:
 * - `syntaxGateCheck`: the TS mirror core (the fallback when Rust is unavailable,
 *   semantics isomorphic with Rust; the vitest contract cases run on both faces);
 * - `checkSyntaxGate`: the main entry — takes Rust when the Rust gate exists, and
 *   falls back to TS when there is no gate or the request fails (degradation with
 *   unchanged behavior: the gate always has an answer, the consumer face does not
 *   branch).
 *
 * Consumption discipline (user order 2026-11-18): not passing -> skip indexing and
 * binding of symbols, and the index keeps the symbols of the last healthy version;
 * the diagnostics face keeps reporting syntax errors through the existing
 * diagnostics chain, this gate produces no diagnostics and only gates.
 * Zero vscode imports (pure core; configuration reading is injected by the caller).
 */

import { getKodeCoreShadowGate } from './kodeCoreShadowFaces';

/** Pre-check result: when `ok=false`, reasons carry line-number location (for the log/observation face, not fed into diagnostics). */
export interface SyntaxGateResult {
  ok: boolean;
  reasons: string[];
}

/** Segment scan: bracket balancing plus unterminated-string location (indentation judging is not on this face). */
function scanSegment(
  segment: string,
  lineNo: number,
  brackets: Array<{ open: string; line: number }>,
  reasons: string[]
): boolean {
  let i = 0;
  while (i < segment.length) {
    const b = segment[i];
    if (b === '#') { return false; }
    if (b === '\\') { i += 2; continue; }
    if (b === "'" || b === '"') {
      const triple = segment[i + 1] === b && segment[i + 2] === b;
      if (triple) { return true; }
      let probe = i + 1;
      let closed = false;
      while (probe < segment.length) {
        if (segment[probe] === '\\') { probe += 2; continue; }
        if (segment[probe] === b) { closed = true; break; }
        probe += 1;
      }
      if (!closed) {
        reasons.push(`unterminated-string at line ${lineNo}`);
        return false;
      }
      i = probe + 1;
      continue;
    }
    if (b === '(' || b === '[' || b === '{') {
      brackets.push({ open: b, line: lineNo });
      i += 1;
      continue;
    }
    if (b === ')' || b === ']' || b === '}') {
      const expect = b === ')' ? '(' : b === ']' ? '[' : '{';
      const top = brackets[brackets.length - 1];
      if (top && top.open === expect) {
        brackets.pop();
      } else if (top) {
        const want = top.open === '(' ? ')' : top.open === '[' ? ']' : '}';
        reasons.push(`unbalanced-bracket at line ${lineNo} (expected '${want}' for line ${top.line})`);
        brackets.pop();
      } else {
        reasons.push(`unbalanced-bracket at line ${lineNo}`);
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return false;
}

/** Find the closing triple quote within a line (honoring escapes); returns the start index, null = no closer on this line. */
function findCloseTriple(line: string): number | null {
  let i = 0;
  while (i < line.length) {
    if (line[i] === '\\') { i += 2; continue; }
    if (line[i] === "'" && line[i + 1] === "'" && line[i + 2] === "'") { return i; }
    if (line[i] === '"' && line[i + 1] === '"' && line[i + 2] === '"') { return i; }
    i += 1;
  }
  return null;
}

/**
 * TS mirror core: a single-pass scan pre-check isomorphic with the Rust
 * `syntax_gate`. Rather miss than wrong: only block the "definitely broken"
 * (an explicit break mid-edit); a false OK is acceptable (the real diagnostics
 * chain still reports the error), a false NO is not (the index would starve).
 * Continuation lines (trailing backslash) / newlines inside brackets /
 * indentation inside a triple-quoted string body are never judged.
 */
export function syntaxGateCheck(text: string): SyntaxGateResult {
  const reasons: string[] = [];
  const brackets: Array<{ open: string; line: number }> = [];
  const levels: string[] = [];
  let indentChar: string | null = null;
  let inTripleString = false;
  let physicalLine = 0;
  let pending: string | null = null;

  for (const raw of text.split('\n')) {
    physicalLine += 1;
    const line: string = (pending ?? '') + (raw.endsWith('\r') ? raw.slice(0, -1) : raw);
    pending = null;
    const lineNo = physicalLine;

    // Inside a triple-quoted string body: only look for the closing quotes (indentation/brackets are never judged)
    if (inTripleString) {
      const closeCol = findCloseTriple(line);
      if (closeCol !== null) {
        inTripleString = false;
        if (scanSegment(line.slice(closeCol + 3), lineNo, brackets, reasons)) {
          inTripleString = true;
        }
      }
      continue;
    }

    // Continuation line (trailing backslash): merge first, then scan — otherwise a continuing string such as `'abc \ would be misjudged.
    if (line.endsWith('\\')) {
      pending = line.slice(0, -1);
      continue;
    }

    const trimmedStart = line.length - (line.replace(/^[ \t]+/, '').length);
    const indent = line.slice(0, trimmedStart);
    const rest = line.slice(trimmedStart);
    const isBlank = rest.length === 0;
    const isComment = rest.startsWith('#');
    const inBrackets = brackets.length > 0;
    if (!isBlank && !isComment && !inBrackets && indent.length > 0) {
      const hasSpace = indent.includes(' ');
      const hasTab = indent.includes('\t');
      if (hasSpace && hasTab) {
        reasons.push(`mixed-indent at line ${lineNo}`);
      } else {
        const thisChar = hasTab ? '\t' : ' ';
        if (indentChar === null) {
          indentChar = thisChar;
        } else if (indentChar !== thisChar) {
          reasons.push(`mixed-indent at line ${lineNo}`);
        }
      }
      if (!levels.some(lvl => lvl === indent)) {
        const deepest = levels.length > 0 ? levels[levels.length - 1].length : 0;
        if (indent.length < deepest) {
          reasons.push(`inconsistent-dedent at line ${lineNo}`);
        } else {
          levels.push(indent);
        }
      } else {
        while (levels.length > 0 && levels[levels.length - 1] !== indent) {
          levels.pop();
        }
      }
    } else if (!isBlank && !isComment && !inBrackets && indent.length === 0 && levels.length > 0) {
      levels.length = 0;
    }
    if (!isBlank && !isComment) {
      if (scanSegment(rest, lineNo, brackets, reasons)) {
        inTripleString = true;
      }
    }
  }

  if (inTripleString) {
    reasons.push('unterminated-string at EOF');
  }
  for (const bracket of brackets) {
    reasons.push(`unclosed-bracket '${bracket.open}' from line ${bracket.line}`);
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * Main entry: the Rust gate (`$/kode/syntax/gate`) is the primary path; no gate /
 * request failure / malformed response -> fall back to the TS mirror (the
 * "degradation with unchanged behavior" ruling from the ruffLint precedent: the
 * gate always has an answer).
 */
export async function checkSyntaxGate(text: string): Promise<SyntaxGateResult> {
  const gate = getKodeCoreShadowGate();
  if (gate) {
    try {
      const response = await gate.runInRust('$/kode/syntax/gate', { text });
      if (response.ok) {
        const record = response.result as { ok?: unknown; reasons?: unknown } | null;
        if (record && typeof record === 'object' && typeof record.ok === 'boolean' &&
            Array.isArray(record.reasons)) {
          return { ok: record.ok, reasons: record.reasons as string[] };
        }
      }
    } catch {
      // The gate throws -> fall back to the TS mirror (neither pretend, nor swallow into ok)
    }
  }
  return syntaxGateCheck(text);
}
