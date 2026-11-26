import type { EntityMapping } from '../entityMapping';
import { l10nText } from '../nlsRuntime';
import {
  findPythonReceiverCalls,
  parseSingleLineCallArguments,
  type PythonCallerFace,
  type PythonReceiverCall,
  type PythonReceiverSection
} from './pythonLanguageUtils';
import { maskPythonNonCode } from './pythonLexicalMask';

/**
 * RPC argument serialization-type compatibility lint (RUST-176/KBE-PY-009b
 * diagnostic face, pure core, zero vscode): when a
 * `self.base/cell/client.<method>(...)` call-site argument is **decidable as a
 * literal shape**, it is reconciled against the <Arg> serialization type family
 * declared for the section the call belongs to; only a clear incompatibility
 * reports a Warning.
 *
 * Engine true-source anchors (evidence taken item by item from the local kbengine
 * kbe/src tree):
 * - declaration type-read path: the Arg's first child node must be direct text
 *   (`<Arg> STRING </Arg>`); getValStr only accepts text nodes
 *   (xml.cpp:121-127, an element's ToText() = NULL → empty string); the element
 *   shape `<Arg><Type>STRING</Type></Arg>` has an element as its first child →
 *   dataType[] not found → engine startup aborts (entitydef.cpp:1629-1643,
 *   client loader, base/cell isomorphic). The parser (parseMethods) shares the
 *   same contract of accepting direct text only; empty text = undeclared.
 * - The loading face only checks type-registration existence; an unknown type
 *   aborts startup (entitydef.cpp:1639-1643) — that face is covered by the
 *   unknown-type lint (KBE-DEF-001,
 *   lint/rules.rs UnknownTypeReferenceRule walk_all over the whole document's
 *   <Type>); this core does not duplicate it.
 * - The packing face (datatype addToStream, the path where an argument actually
 *   goes on the wire) by type family:
 *   · Integer family INT8/16/32/64, UINT8/16/32/64 (IntType<T> datatype.h:
 *     875-898; UInt64Type datatype.cpp:199-225, UInt32Type:324-341,
 *     Int64Type:440-468 isomorphic): PyLong_AsLong → AsUnsignedLong falls back
 *     step by step; all failing → a TypeError printed + **v=0 written to the
 *     stream and continues** — no abort, silently packs 0; bool is a legal
 *     PyLong subclass.
 *   · FLOAT/DOUBLE (FloatType datatype.cpp:540-549, DoubleType:630-641): the
 *     PyFloat_Check gate failing → a TypeError printed + **return without
 *     writing the stream** — the field goes missing, the remote side reads
 *     misaligned bytes at fixed width; int is not accepted by PyFloat_Check.
 *   · STRING/UNICODE (StringType datatype.cpp:1050-1062, UnicodeType:
 *     1129-1141): PyUnicode_AsUTF8AndSize; bytes fails the same way
 *     (OUT_TYPE_ERROR + return without writing the stream).
 *   · BLOB (BlobType datatype.cpp:1448-1468): objects other than PyBytes_Check
 *     are cast unchecked into PyMemoryStream (undefined bytes) — only bytes is
 *     a supported shape.
 *   · VECTOR2/3/4 (Vector3Type datatype.cpp:841-856, 2/4 isomorphic):
 *     per-component PySequence_GetItem + PyFloat_AsDouble — list/tuple is
 *     structurally feasible (each component only needs to be float-convertible);
 *     str converts component-wise into garbage values; a non-sequence fails
 *     outright.
 *   · PYTHON (datatype.cpp:1225-1230) and PY_DICT/PY_TUPLE/PY_LIST (inheriting
 *     PythonType pickle): pickle accepts everything, never claims.
 * - Faceting: the receiver segment (self.client/base/cell) decides the def
 *   block, declarations are filtered by the section the call belongs to, the
 *   same contract as rpcArgCount (inconsistent across sources → unknown, no
 *   report).
 *
 * Honest boundaries: non-literal shapes (names/expressions/calls other than
 * f-strings) cannot be inferred → no report; non-builtin types (types.xml
 * aliases/ARRAY/FIXED_DICT/ENTITYCALL) never claim; cross-line calls with
 * unknown slot text → no report; count mismatches are rpcArgCount's
 * (KBE-PY-009) responsibility, not duplicated here.
 */

/** Stable diagnostic code (B-7 discipline) */
export const RPC_ARG_TYPE_DIAGNOSTIC_CODE = 'kbengine.rpcArgType';

/** Switch default (same family as rpcArgCount: on by default) */
export const RPC_ARG_TYPE_DIAGNOSTICS_ENABLED_DEFAULT = true;

export type RpcArgLiteralKind =
  | 'int' | 'float' | 'str' | 'bytes' | 'bool' | 'none'
  | 'list' | 'dict' | 'set' | 'tuple'
  | 'vector2' | 'vector3' | 'vector4';

export interface RpcArgTypeFinding {
  /** Line (0-based, the line of the method-name token) */
  line: number;
  /** Column (0-based, at the argument segment start) */
  character: number;
  /** Argument segment length (raw-text bytes, the same raw-text coordinate system as character) */
  length: number;
  methodName: string;
  receiver: PythonReceiverCall['receiver'];
  /** The def block the call belongs to (client/base/cell faceted presentation) */
  section: PythonReceiverSection;
  /** Argument slot (1-based) */
  argIndex: number;
  /** The def <Arg> direct text (verbatim, aliases not expanded) */
  declaredType: string;
  /** The call-site argument's inferred literal kind */
  inferredKind: RpcArgLiteralKind;
  message: string;
}

type RpcArgFamily = 'int' | 'float' | 'str' | 'bytes' | 'vector'
  | 'any' | 'pickle' | 'entitycall';

/** Builtin type-family registry (same source as the datatypes.cpp:56-72 registry; anchor = the addToStream implementation site) */
const BUILTIN_ARG_TYPES: ReadonlyMap<string, { family: RpcArgFamily; anchor: string }> = new Map([
  ['INT8', { family: 'int', anchor: 'datatype.h:875-898' }],
  ['INT16', { family: 'int', anchor: 'datatype.h:875-898' }],
  ['INT32', { family: 'int', anchor: 'datatype.h:875-898' }],
  ['INT64', { family: 'int', anchor: 'datatype.cpp:440-468' }],
  ['UINT8', { family: 'int', anchor: 'datatype.h:875-898' }],
  ['UINT16', { family: 'int', anchor: 'datatype.h:875-898' }],
  ['UINT32', { family: 'int', anchor: 'datatype.cpp:324-341' }],
  ['UINT64', { family: 'int', anchor: 'datatype.cpp:199-225' }],
  ['FLOAT', { family: 'float', anchor: 'datatype.cpp:540-549' }],
  ['DOUBLE', { family: 'float', anchor: 'datatype.cpp:630-641' }],
  ['STRING', { family: 'str', anchor: 'datatype.cpp:1050-1062' }],
  ['UNICODE', { family: 'str', anchor: 'datatype.cpp:1129-1141' }],
  ['BLOB', { family: 'bytes', anchor: 'datatype.cpp:1448-1468' }],
  ['VECTOR2', { family: 'vector', anchor: 'datatype.cpp:737-745' }],
  ['VECTOR3', { family: 'vector', anchor: 'datatype.cpp:841-856' }],
  ['VECTOR4', { family: 'vector', anchor: 'datatype.cpp:946-961' }],
  ['PYTHON', { family: 'any', anchor: 'datatype.cpp:1225-1230' }],
  ['PY_DICT', { family: 'pickle', anchor: 'datatype.cpp:1248' }],
  ['PY_TUPLE', { family: 'pickle', anchor: 'datatype.cpp:1248' }],
  ['PY_LIST', { family: 'pickle', anchor: 'datatype.cpp:1248' }],
  ['ENTITYCALL', { family: 'entitycall', anchor: 'datatype.cpp:1512' }]
]);

/** Per-family "clearly compatible" literal decision sets (family → decision set; a kind in neither set = unknown, no claim) */
const FAMILY_OK: Record<RpcArgFamily, ReadonlySet<RpcArgLiteralKind> | null> = {
  int: new Set<RpcArgLiteralKind>(['int', 'bool']),
  float: new Set<RpcArgLiteralKind>(['float']),
  str: new Set<RpcArgLiteralKind>(['str']),
  bytes: new Set<RpcArgLiteralKind>(['bytes']),
  vector: new Set<RpcArgLiteralKind>(['vector2', 'vector3', 'vector4']),
  // pickle accepts everything (PYTHON/PY_DICT/PY_TUPLE/PY_LIST): never claims
  any: null,
  pickle: null,
  entitycall: null
};

/** Per-family 'clearly incompatible' literal decision sets; VECTOR's list/tuple is structurally feasible → left unknown */
const FAMILY_MISMATCH: Record<string, ReadonlySet<RpcArgLiteralKind>> = {
  int: new Set<RpcArgLiteralKind>(['float', 'str', 'bytes', 'none', 'list', 'dict', 'set', 'tuple', 'vector2', 'vector3', 'vector4']),
  float: new Set<RpcArgLiteralKind>(['int', 'bool', 'str', 'bytes', 'none', 'list', 'dict', 'set', 'tuple', 'vector2', 'vector3', 'vector4']),
  str: new Set<RpcArgLiteralKind>(['bytes', 'int', 'bool', 'float', 'none', 'list', 'dict', 'set', 'tuple', 'vector2', 'vector3', 'vector4']),
  bytes: new Set<RpcArgLiteralKind>(['str', 'int', 'bool', 'float', 'none', 'list', 'dict', 'set', 'tuple', 'vector2', 'vector3', 'vector4']),
  vector: new Set<RpcArgLiteralKind>(['str', 'int', 'bool', 'float', 'bytes', 'none', 'dict', 'set'])
};

/** Per-family engine consequence corpus (l10n key = the en source string; float and str share one key for "return without writing the stream") */
const CONSEQUENCE_KEYS: Record<'int' | 'float' | 'bytes' | 'vector', string> = {
  int: '{receiver}.{method} argument {index} ({literal}) cannot serialize as the declared {type}: the engine logs a TypeError and packs 0 for this argument ({anchor})',
  float: '{receiver}.{method} argument {index} ({literal}) cannot serialize as the declared {type}: the engine logs a TypeError and leaves this argument out of the stream, so the remote side reads misaligned bytes ({anchor})',
  bytes: '{receiver}.{method} argument {index} ({literal}) is not a supported BLOB shape: only bytes is accepted, other objects are cast unchecked and produce undefined bytes ({anchor})',
  vector: '{receiver}.{method} argument {index} ({literal}) cannot be read as the declared {type}: the engine reads components through the sequence protocol and float-converts each; this argument fails the read and garbage goes on the wire ({anchor})'
};

const STRING_CONSEQUENCE_KEY = CONSEQUENCE_KEYS.float; // STRING/UNICODE isomorphic to FLOAT/DOUBLE (return without writing the stream)

/** Depth-0, out-of-string colon/comma probe (distinguishes dict/set and tuple/parenthesized expression) */
function hasTopLevelChar(text: string, target: ':' | ','): boolean {
  const depth: string[] = [];
  const closerFor: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  let inString: string | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    if (inString) {
      if (ch === '\\') { index += 1; continue; }
      if (ch === inString) { inString = null; }
      continue;
    }
    if (ch === '\'' || ch === '"') { inString = ch; continue; }
    if (ch in closerFor) { depth.push(closerFor[ch]); continue; }
    if (depth.length > 0 && ch === depth[depth.length - 1]) { depth.pop(); continue; }
    if (depth.length === 0 && ch === target) { return true; }
  }
  return false;
}

/**
 * Argument literal-shape decision: only concludes for statically decidable
 * shapes; names/plain calls/stars/derived shapes are always null (honestly
 * unknown, no guessing).
 */
export function inferArgumentLiteralKind(text: string): RpcArgLiteralKind | null {
  const t = text.trim();
  if (!t || t.startsWith('*')) { return null; }
  if (t === 'True' || t === 'False') { return 'bool'; }
  if (t === 'None') { return 'none'; }
  if (/^[+-]?0[xXoObB][0-9a-fA-F_]+$/.test(t)) { return 'int'; }
  if (/^[+-]?\d[\d_]*$/.test(t)) { return 'int'; }
  // float: 1.5 / 1. / .5 / 1e3 / 1.5e-3 (pure integers were already taken by the previous arm)
  if (/^[+-]?(?:\d[\d_]*\.\d[\d_]*(?:[eE][+-]?\d+)?|\d[\d_]*[eE][+-]?\d+|\.\d[\d_]*(?:[eE][+-]?\d+)?|\d[\d_]*\.)$/.test(t)) {
    return 'float';
  }
  // string literal: optional prefix (r/b/u/f combinations, case-insensitive) + matching end quotes
  const stringMatch = /^([rRbBuUfF]{0,2})(['"])([\s\S]*)\2$/.exec(t);
  if (stringMatch) {
    const prefix = stringMatch[1].toLowerCase();
    return prefix.includes('b') && !prefix.includes('f') ? 'bytes' : 'str';
  }
  if (t[0] === '[' && t.endsWith(']')) { return 'list'; }
  if (t[0] === '{' && t.endsWith('}')) {
    // depth 0 = inside the container (strip the outer braces before scanning,
    // otherwise the outermost braces push the inner depth to 1); empty {} is an
    // empty dict (Python semantics), not an empty set
    if (t === '{}') { return 'dict'; }
    return hasTopLevelChar(t.slice(1, -1), ':') ? 'dict' : 'set';
  }
  if (t[0] === '(' && t.endsWith(')')) {
    return hasTopLevelChar(t.slice(1, -1), ',') ? 'tuple' : null; // a pure parenthesized expression is not guessed
  }
  const ctor = /^(?:KBEngine\.)?Vector([234])\([\s\S]*\)$/.exec(t);
  if (ctor) { return ('vector' + ctor[1]) as RpcArgLiteralKind; }
  return null;
}

/** Declaration side: the per-slot <Arg> types for the section the call belongs to (inconsistent across sources → null) */
export function resolveDeclaredArgTypes(
  declarations: readonly { section: string; declaredArgs?: string[] }[],
  expectedSection: string
): string[] | null {
  const matching = declarations.filter(d => d.section === expectedSection);
  if (matching.length === 0) {
    return null; // no declaration in this section: the section-mismatch face handles it, unknown here
  }
  let declared: string[] | null = null;
  for (const declaration of matching) {
    if (declaration.declaredArgs === undefined || declaration.declaredArgs.length === 0) {
      return null; // declaration not ready (no Arg info): unknown
    }
    if (declaration.declaredArgs.some(arg => arg.trim().startsWith('*'))) {
      return null; // the declaration has a star parameter: types cannot be aligned
    }
    if (declared === null) {
      declared = [...declaration.declaredArgs];
    } else if (declared.join('\u0000') !== declaration.declaredArgs.join('\u0000')) {
      return null; // multiple sources in the same section disagree on types: ambiguous, unknown
    }
  }
  return declared;
}

/**
 * Full computation: a Warning for literal arguments clearly incompatible with
 * the .def <Arg> serialization type. Pure function (text + in-memory mapping
 * snapshot); the discovery face runs on the lexical mask (removing fake calls
 * in strings/comments), the slot-text face runs on raw text (the argument
 * literal decision needs the raw string, the mask would hollow it out) — the
 * same two-stream discovery/count division of labor as rpcArgCount.
 */
export function computeRpcArgTypeCompatFindings(
  text: string,
  mapping?: EntityMapping,
  callerFace?: PythonCallerFace
): RpcArgTypeFinding[] {
  if (!mapping?.methods) { return []; }
  const masked = maskPythonNonCode(text);
  const calls = findPythonReceiverCalls(masked, callerFace);
  if (calls.length === 0) { return []; }
  const rawLines = text.split(/\r?\n/);
  const findings: RpcArgTypeFinding[] = [];
  for (const call of calls) {
    const declarations = mapping.methods[call.methodName];
    if (!declarations || declarations.length === 0) {
      continue; // declaration not ready: unknown, not reported
    }
    // The slot-text face runs on raw text (the mask would hollow out string
    // arguments; cross-line / unclosed parens → null, no claim)
    const spans = parseSingleLineCallArguments(
      rawLines[call.line] ?? '',
      call.character + call.methodName.length
    );
    if (!spans || spans.length === 0) {
      continue; // cross-line / no arguments: slot shape unknown (the count face reconciles separately)
    }
    const declared = resolveDeclaredArgTypes(declarations, call.section);
    if (!declared) {
      continue;
    }
    for (let index = 0; index < spans.length; index += 1) {
      if (index >= declared.length) {
        continue; // beyond the declared slots: count mismatch is rpcArgCount's job, not duplicated here
      }
      const builtin = BUILTIN_ARG_TYPES.get(declared[index].trim());
      if (!builtin || FAMILY_OK[builtin.family] === null) {
        continue; // non-builtin types (aliases/ARRAY/FIXED_DICT) and never-claim families: unknown
      }
      const kind = inferArgumentLiteralKind(spans[index].text);
      if (!kind) {
        continue; // the literal shape cannot be inferred: honestly unknown
      }
      if (FAMILY_MISMATCH[builtin.family]?.has(kind) !== true) {
        continue; // compatible or structurally doubtful (list/tuple vs VECTOR): not reported
      }
      const key = builtin.family === 'str' ? STRING_CONSEQUENCE_KEY : CONSEQUENCE_KEYS[builtin.family as 'int' | 'float' | 'bytes' | 'vector'];
      findings.push({
        line: call.line,
        character: spans[index].start,
        length: spans[index].end - spans[index].start,
        methodName: call.methodName,
        receiver: call.receiver,
        section: call.section,
        argIndex: index + 1,
        declaredType: declared[index].trim(),
        inferredKind: kind,
        message: l10nText(key, {
          receiver: call.receiver,
          method: call.methodName,
          index: String(index + 1),
          literal: spans[index].text,
          type: declared[index].trim(),
          anchor: builtin.anchor
        })
      });
    }
  }
  return findings;
}
