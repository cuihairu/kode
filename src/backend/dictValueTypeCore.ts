// KODE-DICTTYPE-001: ordinary dict literal key→value type inference (pure
// core, zero vscode / zero IO; conventions follow fileModifiedLens).
//
// The GLOBDATA-002 face (globalDataIndexCore) only covers KBEngine.* global
// dicts. This module adds the same style of inference for ordinary dict
// containers so that a key written once reads as its written type everywhere:
//   ① module-level NAME = {...} (incl. annotated NAME: dict[str, int] = {...})
//     — the game-config scenario;
//   ② self.<attr> = {...} inside a class body (class-scoped, merged across
//     methods of the same class);
//   ③ function-local name = {...} (merged only within the same function).
//
// Reuse over rewrite (single judgment chain): value typing goes through
// inferDataDictValueType and key signatures through normalizeKeySignature,
// both from globalDataIndexCore; access spans reuse the exact subscript/.get
// parsers the KBEngine face uses (exported there for this module).
//
// Case sensitivity is a hard rule: key signatures are compared exactly as
// normalizeKeySignature produced them. No toLowerCase/toUpperCase/
// localeCompare anywhere in this module (pinned by a source-level test).
//
// frozen (config read-only): a container with exactly one literal init and
// zero later mutations in the SAME file (subscript writes, deletes, re-
// assignments to non-literals). Cross-file mutation faces (import + mutate)
// are out of scope for this batch — reads resolve inside the defining file
// only; that boundary is documented, not guessed.
//
// prove-red anchors (tests/dictValueType.test.ts header):
//   R1 container-literal recognition removed → single-init case fails.
//   R2 union merge reduced to last-write-wins → multi-write case fails.
//   R3 case-insensitive key folding → case-sensitivity case fails.
import {
  IDENTIFIER_PATTERN,
  buildPythonCodeMask,
  extractModuleConstantBindings,
  inferDataDictValueType,
  normalizeKeySignature,
  parseGetAccess,
  parseSubscriptAccess,
  type AccessSpan,
  type SubscriptParse
} from './globalDataIndexCore';

/** One inferable value write of a key (per-type provenance face). */
export interface DictValueSiteRecord {
  file: string;
  /** 0-based line */
  line: number;
  kind: 'init' | 'write';
  type: string;
}

/** All inference knowledge for one exact key of one container. */
export interface DictKeyEntry {
  /** Exact key signature (case sensitive; never folded). */
  key: string;
  /** Distinct inferred types, first-seen order preserved. */
  types: string[];
  /** Typed write sites backing {@link types} (union provenance). */
  sites: DictValueSiteRecord[];
  /** Write points whose RHS type could not be inferred (honest count). */
  untypedWrites: number;
  /** `del CONTAINER[key]` points for this key. */
  deletes: number;
}

/** One ordinary dict container discovered in a file. */
export interface DictContainerEntry {
  /** Scope-qualified identity (see containerId). */
  id: string;
  /** Receiver source form: `CONFIG`, `self.config` or a local name. */
  name: string;
  scope: 'module' | 'self' | 'local';
  /** `''` (module) / class name (self) / `name@defline` (local). */
  scopeId: string;
  /** First literal-init line (0-based). */
  defLine: number;
  keys: Map<string, DictKeyEntry>;
  /** One nesting level: top key → subkey entries (`CONFIG['a']['b']`). */
  nested: Map<string, Map<string, DictKeyEntry>>;
  initCount: number;
  /** Re-assigned to a non-literal RHS: container identity uncertain → all
   * queries honestly null (the literal facts no longer describe it). */
  tainted: boolean;
  subscriptWrites: number;
  /** `[dynamicExpr] = ...` writes: key identity unknown. */
  unknownKeyWrites: number;
  deletes: number;
  /** Computed at end: single init, zero mutations in this file. */
  frozen: boolean;
}

export interface DictValueTypeAnalysis {
  file: string;
  containers: Map<string, DictContainerEntry>;
  /** Analysis internals reused by the position query face (avoids a second
   * masking pass per query). Not meaningful to consumers. */
  mask: Uint8Array;
  lineStarts: number[];
  /** Nearest enclosing class name per line (null outside classes). */
  classAtLine: Array<string | null>;
  /** Nearest enclosing function scope id per line (null at module level). */
  functionAtLine: Array<string | null>;
}

export interface DictValueTypeQuery {
  container: DictContainerEntry;
  entry: DictKeyEntry;
  /** Set when resolved through one nested level (`['a']['b']`). */
  nestedKey: string | null;
  /** Entry types (may be empty → callers must not show). */
  types: string[];
  frozen: boolean;
}

export interface DictValueAccessHit {
  line: number;
  kind: 'read' | 'write' | 'delete';
  container: DictContainerEntry;
  /** Matched key segments (1 = first level, 2 = one nested level). */
  segments: Array<{ signature: string | null; keyStart: number; keyEnd: number; exprEnd: number }>;
  /** Resolved read facts for the deepest segment (reads only; null when the
   * key has no inferable writes or the chain goes deeper than one level). */
  query: DictValueTypeQuery | null;
}

interface ScopeFrame {
  kind: 'class' | 'function';
  name: string;
  scopeId: string;
  indent: number;
}

interface TextSpan {
  start: number;
  end: number;
}

/** 全文每行起始偏移(按 `\n` 切分,兼容 `\r\n`;与 globalDataIndexCore 同款) */
function lineStartOffsets(text: string): number[] {
  const starts: number[] = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') {
      starts.push(index + 1);
    }
  }
  return starts;
}

/** `[start,start+length)` 全段是否代码(掩码全 0) */
function spanIsCode(mask: Uint8Array, start: number, length: number): boolean {
  for (let index = start; index < start + length; index += 1) {
    if (mask[index] !== 0) {
      return false;
    }
  }
  return true;
}

/** First column whose char is code (mask 0); -1 for blank / comment-only. */
function firstCodeColumn(lineText: string, lineOffset: number, mask: Uint8Array): number {
  for (let column = 0; column < lineText.length; column += 1) {
    const ch = lineText[column];
    if (ch !== ' ' && ch !== '\t') {
      return mask[lineOffset + column] === 0 ? column : -1;
    }
  }
  return -1;
}

/** Skip inline whitespace after a column. */
function skipWhitespace(lineText: string, from: number): number {
  let index = from;
  while (index < lineText.length && /[ \t]/.test(lineText[index])) {
    index += 1;
  }
  return index;
}

/** Line index of an absolute offset (parsers walk forward, linear is fine). */
function lineOfOffset(lineStarts: number[], offset: number): number {
  let line = 0;
  for (let index = 1; index < lineStarts.length; index += 1) {
    if (lineStarts[index] <= offset) {
      line = index;
    } else {
      break;
    }
  }
  return line;
}

function trimTextSpan(text: string, start: number, end: number): TextSpan | null {
  let lo = start;
  let hi = end;
  while (lo < hi && /\s/.test(text[lo])) {
    lo += 1;
  }
  while (hi > lo && /\s/.test(text[hi - 1])) {
    hi -= 1;
  }
  if (lo >= hi) {
    return null;
  }
  return { start: lo, end: hi };
}

/** Line text of an out-of-string `#`; -1 when none (in-string `#` is data). */
function findLineCommentIndexStatic(lineText: string, from: number): number {
  let inString: string | null = null;
  for (let index = from; index < lineText.length; index += 1) {
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
    if (ch === "'" || ch === '"') {
      inString = ch;
      continue;
    }
    if (ch === '#') {
      return index;
    }
  }
  return -1;
}

/** Key starts after an out-of-string `#` → comment pseudo-access, skip. */
function isKeyInsideLineCommentStatic(lineText: string, keyStart: number): boolean {
  const commentAt = findLineCommentIndexStatic(lineText, 0);
  return commentAt !== -1 && commentAt < keyStart;
}

export interface DictLiteralEntrySpan {
  keyRaw: string;
  keyStart: number;
  colon: number;
  valueStart: number;
  valueEnd: number;
  /** Absolute offset of `{` when the value itself is a dict/set literal. */
  valueBrace: number | null;
  line: number;
}

export interface DictLiteralParse {
  close: number;
  entries: DictLiteralEntrySpan[];
  /** `{}` or at least one `k: v` entry → dict; `{1, 2}` → set (not indexed). */
  isDict: boolean;
}

/**
 * Mask-aware dict-literal parser over the full document text (multi-line
 * literals are the norm for config dicts). Splits top-level (depth 0 inside
 * the braces) entries on `,`, locates each entry's first top-level `:`
 * key/value separator, and reports dict-ness (any `k: v` entry, or empty
 * `{}`) as opposed to a set literal. Strings/comments are masked and never
 * carry structure; f-string interpolation bodies are inside strings.
 */
export function parseDictLiteral(
  text: string,
  mask: Uint8Array,
  openBrace: number
): DictLiteralParse | null {
  let depth = 0;
  let close = -1;
  let entryStart = openBrace + 1;
  let currentColon = -1;
  const entrySpans: DictLiteralEntrySpan[] = [];
  const pushEntry = (end: number): void => {
    const finish = (): void => {
      entryStart = end + 1;
      currentColon = -1;
    };
    if (end <= entryStart) {
      finish(); // empty entry (trailing comma): nothing to record
      return;
    }
    const keyEndRaw = currentColon >= 0 ? currentColon : end;
    const keySpan = trimTextSpan(text, entryStart, keyEndRaw);
    if (!keySpan) {
      finish();
      return;
    }
    let valueStart = entryStart;
    let valueEnd = end;
    if (currentColon >= 0) {
      const span = trimTextSpan(text, currentColon + 1, end);
      if (span) {
        valueStart = span.start;
        valueEnd = span.end;
      }
    }
    entrySpans.push({
      keyRaw: text.slice(keySpan.start, keySpan.end),
      keyStart: keySpan.start,
      colon: currentColon,
      valueStart,
      valueEnd,
      valueBrace: currentColon >= 0 && text[valueStart] === '{' ? valueStart : null,
      line: 0
    });
    finish();
  };
  let index = openBrace + 1;
  while (index < text.length) {
    if (mask[index] !== 0) {
      index += 1;
      continue;
    }
    const ch = text[index];
    if (ch === '{' || ch === '[' || ch === '(') {
      depth += 1;
    } else if (ch === '}') {
      if (depth === 0) {
        close = index;
        pushEntry(index);
        break;
      }
      depth -= 1;
      if (depth < 0) {
        return null;
      }
    } else if (ch === ']' || ch === ')') {
      depth -= 1;
      if (depth < 0) {
        return null;
      }
    } else if (ch === ',' && depth === 0) {
      pushEntry(index);
    } else if (ch === ':' && depth === 0 && currentColon < 0) {
      currentColon = index;
    }
    index += 1;
  }
  if (close < 0) {
    return null;
  }
  let hasColonEntry = false;
  const starts = lineStartOffsets(text);
  for (const entry of entrySpans) {
    entry.line = lineOfOffset(starts, entry.keyStart);
    if (entry.colon >= 0) {
      hasColonEntry = true;
    }
  }
  return { close, entries: entrySpans, isDict: entrySpans.length === 0 || hasColonEntry };
}

function containerId(scope: DictContainerEntry['scope'], scopeId: string, name: string): string {
  return `${scope}:${scopeId}:${name}`;
}

const EMPTY_BINDINGS: ReadonlyMap<string, string | null> = new Map();

/** Bare-identifier key resolved through module constant bindings (KSEM-DATA-02
 * same semantics as the KBEngine face): static constant → its bound literal. */
function resolveKeySignature(
  keyRaw: string,
  bindings: ReadonlyMap<string, string | null>
): string | null {
  const signature = normalizeKeySignature(keyRaw);
  if (signature === null) {
    return null;
  }
  if (IDENTIFIER_PATTERN.test(keyRaw.trim())) {
    return bindings.get(signature) ?? signature;
  }
  return signature;
}

/** Union merge: distinct types in first-seen order (never folded case-wise). */
function mergeType(types: string[], candidate: string): boolean {
  if (!types.includes(candidate)) {
    types.push(candidate);
    return true;
  }
  return false;
}

function entryFor(container: DictContainerEntry, key: string): DictKeyEntry {
  let entry = container.keys.get(key);
  if (!entry) {
    entry = { key, types: [], sites: [], untypedWrites: 0, deletes: 0 };
    container.keys.set(key, entry);
  }
  return entry;
}

function nestedEntryFor(
  container: DictContainerEntry,
  topKey: string,
  subKey: string
): DictKeyEntry {
  let map = container.nested.get(topKey);
  if (!map) {
    map = new Map<string, DictKeyEntry>();
    container.nested.set(topKey, map);
  }
  let entry = map.get(subKey);
  if (!entry) {
    entry = { key: subKey, types: [], sites: [], untypedWrites: 0, deletes: 0 };
    map.set(subKey, entry);
  }
  return entry;
}

/** Container assignment statement heads (init or taint). Annotation groups
 * exclude `#` so a trailing comment never ends up inside the annotation. */
const MODULE_ASSIGN_PATTERN = /^([A-Za-z_]\w*)(?:\s*:\s*[^=#]+)?\s*=(?!=)\s*/;
const SELF_ASSIGN_PATTERN = /^self\.([A-Za-z_]\w*)(?:\s*:\s*[^=#]+)?\s*=(?!=)\s*/;
const HEADER_PATTERN = /^(class|def)\s+([A-Za-z_]\w*)/;
const KBENGINE_DICT_RECEIVER = /^\w+\.(?:globalData|baseAppData|cellAppData)$/;
const RECEIVER_ACCESS_PATTERN =
  /(?<![\w.])(self\.[A-Za-z_]\w*|[A-Za-z_]\w*)[ \t]*(\[|\.get[ \t]*\()/g;
const DELETE_PREFIX_PATTERN = /(?:^|[^\w])del[ \t]+$/;
/** Augmented assignment ops (longest first, mirrors globalDataIndexCore). */
const AUGMENTED_ASSIGN_OPS = [
  '**=', '//=', '<<=', '>>=',
  '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '@='
];

/**
 * Analyze one python file into ordinary-dict container facts. Synchronous and
 * linear; consumers cache by document version (dictValueTypes store).
 */
export function analyzeDictValueTypeFile(text: string, file: string): DictValueTypeAnalysis {
  const mask = buildPythonCodeMask(text);
  const lines = text.split(/\r?\n/);
  const lineStarts = lineStartOffsets(text);
  const bindings = extractModuleConstantBindings(text);
  const analysis: DictValueTypeAnalysis = {
    file,
    containers: new Map(),
    mask,
    lineStarts,
    classAtLine: new Array<string | null>(lines.length).fill(null),
    functionAtLine: new Array<string | null>(lines.length).fill(null)
  };
  const frames: ScopeFrame[] = [];

  for (let line = 0; line < lines.length; line += 1) {
    const lineText = lines[line];
    const lineOffset = lineStarts[line] ?? 0;
    const codeCol = firstCodeColumn(lineText, lineOffset, mask);
    if (codeCol < 0) {
      // blank / comment-only line: scope frames unchanged
      const classFrame = [...frames].reverse().find(frame => frame.kind === 'class');
      const functionFrame = [...frames].reverse().find(frame => frame.kind === 'function');
      analysis.classAtLine[line] = classFrame?.name ?? null;
      analysis.functionAtLine[line] = functionFrame?.scopeId ?? null;
      continue;
    }
    while (frames.length > 0 && frames[frames.length - 1].indent >= codeCol) {
      frames.pop();
    }
    const header = HEADER_PATTERN.exec(lineText.slice(codeCol));
    if (header) {
      const kind = header[1] === 'class' ? 'class' : 'function';
      const name = header[2];
      frames.push({
        kind,
        name,
        scopeId: kind === 'function' ? `${name}@${line}` : name,
        indent: codeCol
      });
    }
    const classFrame = [...frames].reverse().find(frame => frame.kind === 'class');
    const functionFrame = [...frames].reverse().find(frame => frame.kind === 'function');
    analysis.classAtLine[line] = classFrame?.name ?? null;
    analysis.functionAtLine[line] = functionFrame?.scopeId ?? null;

    const bodyText = lineText.slice(codeCol);
    const selfAssign = SELF_ASSIGN_PATTERN.exec(bodyText);
    const bareAssign = selfAssign ? null : MODULE_ASSIGN_PATTERN.exec(bodyText);
    const assign = selfAssign ?? bareAssign;
    if (assign) {
      const name = selfAssign ? `self.${selfAssign[1]}` : bareAssign![1];
      const rhsOffset = lineOffset + codeCol + assign.index + assign[0].length;
      const isModuleScope = codeCol === 0;
      const scope: DictContainerEntry['scope'] | null = selfAssign
        ? classFrame
          ? 'self'
          : null // self outside any class: meaningless, never indexed
        : isModuleScope
          ? 'module'
          : functionFrame
            ? 'local'
            : null; // class-body bare NAME: not reachable via bare reads (Python scoping) → skip
      const scopeId =
        scope === 'self' ? classFrame!.name : scope === 'local' ? functionFrame!.scopeId : '';
      if (scope) {
        const id = containerId(scope, scopeId, name);
        const existing = analysis.containers.get(id);
        const braceOffset = skipWhitespace(text, rhsOffset);
        const literal = text[braceOffset] === '{' ? parseDictLiteral(text, mask, braceOffset) : null;
        if (literal && literal.isDict) {
          const container: DictContainerEntry = existing ?? {
            id,
            name,
            scope,
            scopeId,
            defLine: line,
            keys: new Map(),
            nested: new Map(),
            initCount: 0,
            tainted: false,
            subscriptWrites: 0,
            unknownKeyWrites: 0,
            deletes: 0,
            frozen: false
          };
          container.initCount += 1;
          recordLiteralEntries(container, text, mask, literal, file, bindings);
          analysis.containers.set(id, container);
          continue;
        }
        if (existing) {
          // non-literal RHS (call, name, set literal, ...): container identity
          // is no longer described by its earlier literal facts → tainted
          existing.tainted = true;
        }
        continue;
      }
      // scope === null: fall through — the line may still carry accesses
    }

    findDictValueAccessesOnLine(analysis, lineText, line, bindings, true);
  }

  for (const container of analysis.containers.values()) {
    container.frozen =
      container.initCount === 1 &&
      !container.tainted &&
      container.subscriptWrites === 0 &&
      container.deletes === 0;
  }
  return analysis;
}

/** Merge one parsed literal's entries (and their nested dict values, one
 * level deep) into the container's key facts. */
function recordLiteralEntries(
  container: DictContainerEntry,
  text: string,
  mask: Uint8Array,
  literal: DictLiteralParse,
  file: string,
  bindings: ReadonlyMap<string, string | null>
): void {
  for (const span of literal.entries) {
    const signature = resolveKeySignature(span.keyRaw, bindings);
    if (signature === null) {
      continue; // computed key: not indexed, not guessed
    }
    if (span.colon >= 0) {
      const valueText = text.slice(span.valueStart, span.valueEnd);
      const type = inferDataDictValueType(valueText);
      // the key IS known even when its type is not: completion still offers it,
      // reads honestly resolve to null (types.length === 0)
      const entry = entryFor(container, signature);
      if (type !== null) {
        mergeType(entry.types, type);
        entry.sites.push({ file, line: span.line, kind: 'init', type });
      } else {
        entry.untypedWrites += 1;
      }
    }
    if (span.valueBrace !== null) {
      const nested = parseDictLiteral(text, mask, span.valueBrace);
      if (nested && nested.isDict) {
        for (const sub of nested.entries) {
          const subSignature = resolveKeySignature(sub.keyRaw, bindings);
          if (subSignature === null || sub.colon < 0) {
            continue;
          }
          const subType = inferDataDictValueType(text.slice(sub.valueStart, sub.valueEnd));
          const entry = nestedEntryFor(container, signature, subSignature);
          if (subType !== null) {
            mergeType(entry.types, subType);
            entry.sites.push({ file, line: sub.line, kind: 'init', type: subType });
          } else {
            entry.untypedWrites += 1;
          }
        }
      }
    }
  }
}

function resolveContainerAtLine(
  analysis: DictValueTypeAnalysis,
  receiver: string,
  line: number
): DictContainerEntry | null {
  if (receiver.startsWith('self.')) {
    const className = analysis.classAtLine[line];
    if (!className) {
      return null;
    }
    return analysis.containers.get(containerId('self', className, receiver)) ?? null;
  }
  const functionScope = analysis.functionAtLine[line];
  if (functionScope) {
    const local = analysis.containers.get(containerId('local', functionScope, receiver));
    if (local) {
      return local; // local binding shadows any same-named module container
    }
  }
  return analysis.containers.get(containerId('module', '', receiver)) ?? null;
}

/** Resolve the read facts for a chain (honest null on unknown keys / too deep). */
function buildReadQuery(
  container: DictContainerEntry,
  firstSignature: string | null,
  secondSignature: string | null,
  chainTooDeep: boolean
): DictValueTypeQuery | null {
  if (chainTooDeep || firstSignature === null) {
    return null;
  }
  if (secondSignature !== null) {
    const entry = container.nested.get(firstSignature)?.get(secondSignature);
    if (!entry || entry.types.length === 0) {
      return null;
    }
    return {
      container,
      entry,
      nestedKey: secondSignature,
      types: entry.types,
      frozen: container.frozen
    };
  }
  const entry = container.keys.get(firstSignature);
  if (!entry || entry.types.length === 0) {
    return null;
  }
  return { container, entry, nestedKey: null, types: entry.types, frozen: container.frozen };
}

/** Record a first-level write/delete fact into the container. */
function recordFirstLevelMutation(
  analysis: DictValueTypeAnalysis,
  container: DictContainerEntry,
  kind: 'write' | 'delete',
  signature: string | null,
  valueText: string | null,
  line: number
): void {
  if (kind === 'delete') {
    container.deletes += 1;
    if (signature !== null) {
      entryFor(container, signature).deletes += 1;
    }
    return;
  }
  container.subscriptWrites += 1;
  if (signature === null) {
    container.unknownKeyWrites += 1;
    return;
  }
  const entry = entryFor(container, signature);
  const type = inferDataDictValueType(valueText);
  if (type !== null) {
    mergeType(entry.types, type);
    entry.sites.push({ file: analysis.file, line, kind: 'write', type });
  } else {
    entry.untypedWrites += 1;
  }
}

/** Record a nested-level (chain tail) write/delete fact. */
function recordNestedMutation(
  analysis: DictValueTypeAnalysis,
  container: DictContainerEntry,
  kind: 'write' | 'delete',
  firstSignature: string | null,
  secondSignature: string | null,
  valueText: string | null,
  line: number
): void {
  void firstSignature;
  if (kind === 'delete') {
    container.deletes += 1;
    if (secondSignature !== null && firstSignature !== null) {
      nestedEntryFor(container, firstSignature, secondSignature).deletes += 1;
    }
    return;
  }
  container.subscriptWrites += 1;
  if (secondSignature === null) {
    container.unknownKeyWrites += 1;
    return;
  }
  if (firstSignature === null) {
    return; // unknown top key: nested identity unreachable
  }
  const entry = nestedEntryFor(container, firstSignature, secondSignature);
  const type = inferDataDictValueType(valueText);
  if (type !== null) {
    mergeType(entry.types, type);
    entry.sites.push({ file: analysis.file, line, kind: 'write', type });
  } else {
    entry.untypedWrites += 1;
  }
}

/** RHS text after a nested chain tail `=` (comment stripped, trimmed). */
function nestedWriteValueText(lineText: string, equalsCol: number): string | null {
  const raw = lineText.slice(equalsCol + 1);
  const commentAt = findLineCommentIndexStatic(raw, 0);
  const body = (commentAt >= 0 ? raw.slice(0, commentAt) : raw).trim();
  return body || null;
}

/**
 * Scan one line for ordinary-dict accesses against a file analysis. Read
 * chains carry resolved queries; write/delete facts are returned as hits and
 * — when {@link recordMutations} is set (analysis walk) — folded into the
 * container (union members, frozen breakers). Query face passes false so a
 * mere hover/completion never mutates analysis facts.
 */
export function findDictValueAccessesOnLine(
  analysis: DictValueTypeAnalysis,
  lineText: string,
  line: number,
  bindings?: ReadonlyMap<string, string | null>,
  recordMutations = false
): DictValueAccessHit[] {
  const resolvedBindings = bindings ?? EMPTY_BINDINGS;
  const hits: DictValueAccessHit[] = [];
  const lineOffset = analysis.lineStarts[line] ?? 0;
  RECEIVER_ACCESS_PATTERN.lastIndex = 0;
  let access: RegExpExecArray | null;
  while ((access = RECEIVER_ACCESS_PATTERN.exec(lineText)) !== null) {
    const receiver = access[1];
    if (KBENGINE_DICT_RECEIVER.test(receiver)) {
      continue; // KBEngine.* face owns these (GLOBDATA-002)
    }
    const receiverStart = access.index;
    const tail = access[2];
    const receiverEnd = receiverStart + receiver.length;
    if (!spanIsCode(analysis.mask, lineOffset + receiverStart, receiver.length + tail.length)) {
      continue; // comment / string pseudo-access
    }
    const container = resolveContainerAtLine(analysis, receiver, line);
    if (!container) {
      continue;
    }
    const isDelete = DELETE_PREFIX_PATTERN.test(lineText.slice(0, receiverStart)) && tail === '[';
    const firstSpan: SubscriptParse | AccessSpan | null =
      tail === '['
        ? parseSubscriptAccess(lineText, receiverEnd)
        : parseGetAccess(lineText, receiverEnd);
    if (!firstSpan || isKeyInsideLineCommentStatic(lineText, firstSpan.keyStart)) {
      continue;
    }
    // .get spans are always reads and carry no value text; only subscript
    // spans can be writes
    const firstKind: 'read' | 'write' =
      'kind' in firstSpan ? firstSpan.kind : 'read';
    const firstValueText: string | null =
      'valueText' in firstSpan ? firstSpan.valueText : null;
    const signature = resolveKeySignature(firstSpan.keyRaw, resolvedBindings);
    const firstSegment = {
      signature,
      keyStart: firstSpan.keyStart,
      keyEnd: firstSpan.keyEnd,
      exprEnd: firstSpan.exprEnd
    };
    if (isDelete || firstKind === 'write') {
      const kind = isDelete ? 'delete' : 'write';
      if (recordMutations) {
        recordFirstLevelMutation(analysis, container, kind, signature, firstValueText, line);
      }
      hits.push({ line, kind, container, segments: [firstSegment], query: null });
      continue;
    }
    // read: extend the chain one nested level (`['a']['b']`), detect a chain
    // tail write/delete (`CONFIG['a']['b'] = x` is a nested write, not a read)
    const segments: DictValueAccessHit['segments'] = [firstSegment];
    let secondSignature: string | null = null;
    let chainTooDeep = false;
    let chainKind: 'read' | 'write' | 'delete' = 'read';
    let chainValueText: string | null = null;
    if (signature !== null) {
      const afterFirst = skipWhitespace(lineText, firstSpan.exprEnd);
      if (lineText[afterFirst] === '[') {
        const secondSpan = parseSubscriptAccess(lineText, afterFirst);
        if (secondSpan) {
          secondSignature = resolveKeySignature(secondSpan.keyRaw, resolvedBindings);
          segments.push({
            signature: secondSignature,
            keyStart: secondSpan.keyStart,
            keyEnd: secondSpan.keyEnd,
            exprEnd: secondSpan.exprEnd
          });
          const afterSecond = skipWhitespace(lineText, secondSpan.exprEnd);
          const tailChar = lineText[afterSecond];
          if (tailChar === '[') {
            chainTooDeep = true;
          } else if (tailChar === '=' && lineText[afterSecond + 1] !== '=') {
            chainKind = 'write';
            chainValueText = nestedWriteValueText(lineText, afterSecond);
          } else if (tailChar !== undefined && AUGMENTED_ASSIGN_OPS.some(op => lineText.startsWith(op, afterSecond))) {
            chainKind = 'write';
            chainValueText = null;
          }
        }
      }
    }
    if (chainKind !== 'read' && recordMutations) {
      recordNestedMutation(
        analysis,
        container,
        chainKind,
        signature,
        secondSignature,
        chainValueText,
        line
      );
    }
    hits.push({
      line,
      kind: chainKind,
      container,
      segments,
      query:
        chainKind === 'read'
          ? buildReadQuery(container, signature, secondSignature, chainTooDeep)
          : null
    });
  }
  return hits;
}

/**
 * Position query face: resolve the read at (line, character) to container
 * facts. The character must sit inside a key segment of a read access.
 * Unknown keys / dynamic keys / untypeable values → null (honest, falls back
 * to the ordinary chain — same contract as GLOBDATA-002).
 */
export function queryDictValueTypeAtPosition(
  analysis: DictValueTypeAnalysis,
  lineText: string,
  line: number,
  character: number,
  bindings?: ReadonlyMap<string, string | null>
): DictValueTypeQuery | null {
  for (const hit of findDictValueAccessesOnLine(analysis, lineText, line, bindings)) {
    if (hit.kind !== 'read') {
      continue;
    }
    for (const segment of hit.segments) {
      if (character >= segment.keyStart && character <= segment.keyEnd) {
        return hit.query;
      }
    }
  }
  return null;
}

export interface DictValueKeyCompletionContext {
  receiver: string;
  partial: string;
  replaceStart: number;
  viaGet: boolean;
  /** 0-based line of the cursor: self receivers resolve against the class
   * enclosing this line, never against a file-wide guess. */
  line: number;
}

const COMPLETION_QUOTED_TAIL_PATTERN =
  /(?<![\w.])(self\.[A-Za-z_]\w*|[A-Za-z_]\w*)[ \t]*(?:\[|\.get[ \t]*\()[ \t]*(["'])([^'"\\]*)$/;
const COMPLETION_BARE_TAIL_PATTERN =
  /(?<![\w.])(self\.[A-Za-z_]\w*|[A-Za-z_]\w*)[ \t]*(\[|\.get[ \t]*\()[ \t]*$/;

/**
 * Completion context: cursor inside a string-key position of a receiver
 * subscript/.get (`CONFIG["par` / `CONFIG[` / `self.config.get("`), matching
 * the GLOBDATA completion detector shape. KBEngine dict receivers excluded
 * (that face owns them). Pure text detection; the provider resolves the
 * receiver against the document analysis.
 */
export function dictValueKeyCompletionContext(
  lineText: string,
  character: number,
  line: number
): DictValueKeyCompletionContext | null {
  const text = lineText.slice(0, character);
  const quoted = COMPLETION_QUOTED_TAIL_PATTERN.exec(text);
  if (quoted && !KBENGINE_DICT_RECEIVER.test(quoted[1])) {
    return {
      receiver: quoted[1],
      partial: quoted[3],
      replaceStart: character - quoted[3].length,
      viaGet: /\.get[ \t]*\(/.test(text.slice(quoted.index + quoted[1].length)),
      line
    };
  }
  const bare = COMPLETION_BARE_TAIL_PATTERN.exec(text);
  if (bare && !KBENGINE_DICT_RECEIVER.test(bare[1])) {
    return {
      receiver: bare[1],
      partial: '',
      replaceStart: character,
      viaGet: bare[2].includes('.get'),
      line
    };
  }
  return null;
}
