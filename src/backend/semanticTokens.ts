// SemanticTokens decision core (RUST-144 batch 3, a new face): python file
// structural symbol semantics — class/method/module-level function declaration
// names, def parameter names, decorator names, 5 token types in total (syntax
// keywords/string literals are left to the TextMate grammar, without overlapping
// it). Pure functions (text input, zero vscode/engine dependencies); parsing
// reuses pythonParser (parsePythonFile/pythonCodeLines/pythonStatements) and
// defParamInlayHints (the same def line scan via parseDefLine/splitParams, the
// same ruling). The honest boundary: self.X attribute access and the local
// variable face are not done (high conflict with Pylance + requires self scope
// analysis; later batches decide via the RUST-148 conflict matrix); parameters of
// multi-line defs are not extracted (the same single-line gate as inlay).
import { parsePythonFile, pythonCodeLines, pythonStatements } from './pythonParser';
import { parseDefSignature } from '../defParamInlayHints';

/** The legend order is the encoded typeIndex (the same order as the Rust semantic_tokens.rs; do not reorder) */
export const SEMANTIC_TOKEN_TYPES = ['class', 'function', 'method', 'parameter', 'macro'] as const;

export const SEMANTIC_TOKEN_MODIFIERS = ['declaration', 'async'] as const;

export type SemanticTokenType = (typeof SEMANTIC_TOKEN_TYPES)[number];

export interface SemanticTokenSpan {
  /** 0-based line */
  line: number;
  /** 0-based UTF-16 column within the line */
  startCharacter: number;
  length: number;
  type: SemanticTokenType;
  /** 'declaration' the declaration site; 'async' async def (both declaration names and parameters may carry it) */
  modifiers: string[];
}

/** Decorator line: @ name (dotted allowed, the full expression span is taken) */
const DECORATOR_RE = /^\s*@\s*([A-Za-z_][\w.]*)/;
const CLASS_NAME_RE = /^\s*class\s+([A-Za-z_]\w*)/;
const DEF_HEAD_RE = /^\s*(async\s+)?def\s+([A-Za-z_]\w*)/;

/**
 * Extract structural symbol spans (ascending by line/column, no dedup — the same
 * token is only ever produced by a single rule). Emitted for any python file
 * (language-level structural semantics, no entity section gate); an empty file /
 * a file without symbols returns an empty array.
 */
export function buildSemanticTokenSpans(text: string): SemanticTokenSpan[] {
  const maskedLines = pythonCodeLines(text);
  const parsed = parsePythonFile(text, 'semantic-tokens-synthetic.py');
  const spans: SemanticTokenSpan[] = [];

  // Class declaration names (the name after class on the masked line; masked
  // positions are unchanged, so columns align with the raw text)
  for (const cls of parsed.classes) {
    const lineText = maskedLines[cls.startLine] ?? '';
    const match = CLASS_NAME_RE.exec(lineText);
    if (!match) {
      continue;
    }
    const name = match[1];
    const start = lineText.indexOf(name, match[0].length - name.length);
    spans.push({
      line: cls.startLine,
      startCharacter: start,
      length: name.length,
      type: 'class',
      modifiers: ['declaration']
    });
  }

  // Method declaration names (the parsePythonFile methods table, line/column used directly; async judged from the masked line)
  const classBoundDefLines = new Set<number>();
  for (const cls of parsed.classes) {
    for (const [methodName, location] of cls.methods) {
      classBoundDefLines.add(location.line);
      const modifiers = ['declaration'];
      if (/^\s*async\s+def\s/.test(maskedLines[location.line] ?? '')) {
        modifiers.push('async');
      }
      spans.push({
        line: location.line,
        startCharacter: location.character,
        length: methodName.length,
        type: 'method',
        modifiers
      });
    }
  }

  // Statement face: module-level def (function) / decorators (macro)
  const statements = pythonStatements(text);
  for (const statement of statements) {
    const defMatch = DEF_HEAD_RE.exec(statement.text);
    if (defMatch && !classBoundDefLines.has(statement.line)) {
      const methodName = defMatch[2];
      const modifiers = ['declaration'];
      if (defMatch[1]) {
        modifiers.push('async');
      }
      // statement.text is the merged text, the first line's column matches the original line; the name column = before the match's tail
      const start = statement.text.indexOf(methodName, defMatch[0].length - methodName.length);
      spans.push({
        line: statement.line,
        startCharacter: start,
        length: methodName.length,
        type: 'function',
        modifiers
      });
      collectParameterSpans(
        maskedLines,
        statement.line,
        methodName,
        start,
        spans,
        defMatch[1] ? ['declaration', 'async'] : ['declaration']
      );
      continue;
    }
    const decoratorMatch = DECORATOR_RE.exec(statement.text);
    if (decoratorMatch) {
      const name = decoratorMatch[1];
      const start = statement.text.indexOf(name, decoratorMatch[0].length - name.length);
      spans.push({
        line: statement.line,
        startCharacter: start,
        length: name.length,
        type: 'macro',
        modifiers: []
      });
    }
  }

  // Parameters: class method def lines (the line/column the parsePythonFile table gives)
  for (const cls of parsed.classes) {
    for (const [methodName, location] of cls.methods) {
      collectParameterSpans(
        maskedLines,
        location.line,
        methodName,
        location.character,
        spans,
        /^\s*async\s+def\s/.test(maskedLines[location.line] ?? '')
          ? ['declaration', 'async']
          : ['declaration']
      );
    }
  }

  return spans.sort((a, b) => a.line - b.line || a.startCharacter - b.startCharacter);
}

/**
 * def parameter spans (parseDefSignature, the same unified source of truth as
 * inlay = the masked line domain; since KODE-SYN-004 a signature may cross lines,
 * and the span lands on the line of the parameter name). Parameters carry
 * declaration + async modifiers by themselves.
 */
function collectParameterSpans(
  maskedLines: readonly string[],
  line: number,
  methodName: string,
  nameCharacter: number,
  spans: SemanticTokenSpan[],
  modifiers: string[]
): void {
  // Parameter splitting shares the inlay implementation: parseDefSignature's
  // site.params has already stripped the leading self/cls (this extension's
  // parameter semantics = RPC parameters, the receiver is not a parameter, the
  // same ruling as inlay/the signature formatter); an unclosed signature
  // (mid-edit) emits nothing.
  const site = parseDefSignature(maskedLines, line, methodName, nameCharacter, 'ClientMethods');
  if (!site) {
    return;
  }
  for (const param of site.params) {
    spans.push({
      line: param.line,
      startCharacter: param.start,
      length: param.end - param.start,
      type: 'parameter',
      modifiers: [...modifiers]
    });
  }
}

/**
 * LSP relative encoding: [deltaLine, deltaStartChar, length, typeIndex,
 * modifierBitmask]. Spans must already be ascending by line/column (guaranteed by
 * this module's output); legend indexes are defined by
 * SEMANTIC_TOKEN_TYPES/MODIFIERS; an unknown type throws (a wiring-face bug
 * explodes early).
 */
export function encodeSemanticTokens(spans: SemanticTokenSpan[]): number[] {
  const data: number[] = [];
  let prevLine = 0;
  let prevStart = 0;
  for (const span of spans) {
    const typeIndex = (SEMANTIC_TOKEN_TYPES as readonly string[]).indexOf(span.type);
    if (typeIndex < 0) {
      throw new Error(`unknown semantic token type: ${span.type}`);
    }
    let modifierMask = 0;
    for (const modifier of span.modifiers) {
      const bit = (SEMANTIC_TOKEN_MODIFIERS as readonly string[]).indexOf(modifier);
      if (bit >= 0) {
        modifierMask |= 1 << bit;
      }
    }
    const deltaLine = span.line - prevLine;
    const deltaStart = deltaLine === 0 ? span.startCharacter - prevStart : span.startCharacter;
    data.push(deltaLine, deltaStart, span.length, typeIndex, modifierMask);
    prevLine = span.line;
    prevStart = span.startCharacter;
  }
  return data;
}
