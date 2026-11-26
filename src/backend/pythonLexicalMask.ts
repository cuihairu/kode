/**
 * Python lexical mask (IDE-LINT-005): one full-text scan replacing comments and
 * string literals (plain / triple-quoted / raw / byte-prefixed) with whitespace of
 * the same length, keeping the `{...}` expression parts of an f-string visible as
 * code while masking its literal parts. The mask preserves length and lines
 * (newlines are not masked), so every column offset is unchanged -- receiver lint's
 * call discovery and guard analysis both run on the masked text and are therefore
 * never misled by string/comment contents (quotes or colons inside conditions,
 * a return inside a literal, etc.). It is called once per diagnostics pass (the
 * counter is for the test face to check), never re-scanned per hit.
 */

let maskPassCount = 0;

/** Test face: number of full-text mask scans (exactly 1 per compute pass, independent of the hit count) */
export function getPythonMaskPassCountForTests(): number {
  return maskPassCount;
}

export function resetPythonMaskPassCountForTests(): void {
  maskPassCount = 0;
}

const isQuote = (char: string): boolean => char === '"' || char === "'";

/** String prefix preceding the quote (e.g. r/f/rb/fr); returns empty for a non-prefix letter run (such as an identifier) */
const stringPrefixBefore = (text: string, quoteIndex: number): string => {
  let start = quoteIndex;
  while (start > 0 && /\w/.test(text[start - 1])) { start -= 1; }
  const run = text.slice(start, quoteIndex);
  return /^[rbfu]{0,2}$/i.test(run) ? run : '';
};

/**
 * Mask one string literal (including its quotes) starting at text[start..] and
 * return the index after it.
 * f-string: the literal parts are masked; hitting `{` (not `{{`) enters the
 * expression section -- that section stays visible, nested strings/comments are
 * masked recursively, and the matching `}` returns to the literal section.
 */
function maskStringAt(text: string, out: string[], start: number): number {
  const n = text.length;
  const quote = text[start];
  const fstring = /f/i.test(stringPrefixBefore(text, start));
  const triple = text.slice(start, start + 3) === quote.repeat(3);
  const openLen = triple ? 3 : 1;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < n; k += 1) {
      if (text[k] !== '\n' && text[k] !== '\r') { out[k] = ' '; }
    }
  };
  blank(start, start + openLen);
  let i = start + openLen;
  let fexprDepth = 0; // >0: inside an f-string expression section (code stays visible)
  while (i < n) {
    const char = text[i];
    if (fexprDepth > 0) {
      if (char === '{') { fexprDepth += 1; i += 1; continue; }
      if (char === '}') { fexprDepth -= 1; i += 1; continue; }
      if (char === '#') { i = maskCommentAt(text, out, i); continue; }
      if (isQuote(char)) { i = maskStringAt(text, out, i); continue; }
      i += 1; continue; // expression code stays visible
    }
    if (fstring) {
      // f-string literal section: masked; the `{{` escape is masked with the section, `{` enters the expression section
      if (char === quote && (!triple || text.slice(i, i + 3) === quote.repeat(3))) {
        const closeLen = triple ? 3 : 1;
        blank(i, i + closeLen);
        return i + closeLen;
      }
      if (char === '{' && text[i + 1] === '{') { blank(i, i + 2); i += 2; continue; }
      if (char === '{') { fexprDepth = 1; i += 1; continue; }
      if (char === '\\') { blank(i, i + 2); i += 2; continue; }
      blank(i, i + 1);
      i += 1;
      continue;
    }
    // plain string: mask up to the closing quote / end of line (escape pairs are skipped together)
    if (char === '\\') { blank(i, i + 2); i += 2; continue; }
    if (char === quote) {
      if (triple && text.slice(i, i + 3) !== quote.repeat(3)) { blank(i, i + 1); i += 1; continue; }
      blank(i, i + openLen);
      return i + openLen;
    }
    if (!triple && (char === '\n' || char === '\r')) { return i; }
    blank(i, i + 1);
    i += 1;
  }
  return n;
}

/** Mask a single-line comment (up to end of line) within a top-level code section */
function maskCommentAt(text: string, out: string[], start: number): number {
  const n = text.length;
  let j = start;
  while (j < n && text[j] !== '\n' && text[j] !== '\r') {
    out[j] = ' ';
    j += 1;
  }
  return j;
}

/**
 * One full-text scan produces the masked text (same length as the input, newlines
 * preserved as-is):
 * - comments -> whitespace; string literals (including quotes and non-prefix
 *   content) -> whitespace;
 * - f-string `{...}` expression sections stay visible, while nested strings/comments
 *   inside them are still masked;
 * - `{{`/`}}` are literal braces and are masked along with the literal section.
 */
export function maskPythonNonCode(text: string): string {
  maskPassCount += 1;
  const out = text.split('');
  const n = text.length;
  let i = 0;
  let fexprDepth = 0;
  while (i < n) {
    const char = text[i];
    if (fexprDepth > 0) {
      // f-string expression section: code stays visible, braces tracked as depth, nested strings/comments masked as usual
      if (char === '{') { fexprDepth += 1; i += 1; continue; }
      if (char === '}') { fexprDepth -= 1; i += 1; continue; }
      if (char === '#') { i = maskCommentAt(text, out, i); continue; }
      if (isQuote(char)) { i = maskStringAt(text, out, i); continue; }
      i += 1;
      continue;
    }
    if (char === '#') { i = maskCommentAt(text, out, i); continue; }
    if (isQuote(char)) { i = maskStringAt(text, out, i); continue; }
    i += 1;
  }
  return out.join('');
}
