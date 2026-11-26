/**
 * KSEM-SER-10: JSON dumps/loads chain propagation (pure core, zero vscode dependency).
 *
 * Acceptance convention (todo.md SEM-026, formerly KSEM-SER-10): propagate
 * dumps/loads chain structures only with a binding or a provable source;
 * handle JSON key/tuple/number conversions; unknown source → unknown.
 *
 * Consumer contract (SER-08 design §4, docs/review/2026-11-14-ksem-ser-08-project-
 * schema-design.md):
 *  - dumps(obj) propagates only with a provable source (SER-09 dictFormatDerivation /
 *    chain-face loads result / dict literal argument); unproven source → unknown;
 *  - loads(path) yields a structure only on a schema binding hit; parsing of
 *    .kbengine/serialization.json is parseSerializationSchema (scalar family
 *    source of truth = CELL-08 SCALAR_FAMILIES, src/backend/scalarFamilies.ts);
 *  - JSON semantic conversion: dumps direction tuple→list; key is always str
 *    (non-string keys are dynamic keys inside the SER-09 model → open universe,
 *    so the string-key face holds naturally); int/float and bool/None keep
 *    their types through the Python json round trip, no fabricated conversion;
 *  - no schema / binding miss / unproven source → zero claims (unknown is not a
 *    diagnostic, silence is honesty, SER-08 §3 three prohibitions; schema
 *    validation failure details return via errors, diagnostic wiring belongs
 *    to the configContract lane, this core emits no diagnostics).
 *
 * Derivation model (module scope v1, line-order flow sensitive):
 *  - chain state advances in line order: carrier (dumps product, JSON string) /
 *    value (loads product or alias) / dead; any other assignment / augmented
 *    write / conditional-body assignment → dead (the body may not run, no
 *    claim); def/class bodies never fold in (SER-09 same rule);
 *  - only import evidence binds call shapes: `import json`/`import json as X`
 *    → `X.dumps/loads`; `from json import dumps as D, loads` → bare names
 *    (including the parenthesized continuation shape); a rebound binding name dies;
 *  - call arguments tightened in v1: single argument (top-level comma =
 *    keyword/multi-argument shape → unknown), closing paren on the same line,
 *    suffix after the call (method chain/ternary) → unknown;
 *  - dumps argument resolution: bare name checks chain state (value passes,
 *    carrier is a string and does not) → SER-09 map fallback (code-fact side,
 *    flow-insensitive v1); `{` dict literal argument (multi-line included,
 *    matchDictBraces pairing) goes through classifyValue; non-dict top level
 *    (string/list/tuple literal, call) claims nothing -- this map carries only
 *    the dict structure face;
 *  - loads argument resolution: quoted string literal → schema binding
 *    fnmatch (Python fnmatch semantics, `*` crosses directories); claim only
 *    on exactly one hit, ambiguity/zero hits → unknown; bare name → chain
 *    carrier; the rest (f-string/concatenation/call) → unknown.
 *
 * raw/masked dual-line convention, same family as SER-04/05/06/09: shape
 * detection runs on masked lines (comment/string positions never match),
 * string argument contents come from the raw line (masking erases quotes to
 * '_'), column-aligned.
 */

import { pythonCodeLines } from './pythonParser';
import { matchDictBraces } from './fixedDictConstructCheck';
import {
  deriveDictFormats,
  classifyValue,
  isQuotedLiteral,
  type DictFormat,
  type DictValueKind
} from './dictFormatDerivation';
import { SCALAR_FAMILIES } from './scalarFamilies';

// ── schema file (.kbengine/serialization.json, SER-08 design §2.1)──

/** Field type: scalar family name (SCALAR_FAMILIES) / [element type] array / type reference. */
export type SchemaFieldType =
  | { kind: 'scalar'; family: string }
  | { kind: 'list'; element: SchemaFieldType }
  | { kind: 'ref'; type: string };

/** Parsed schema: types (type id → field table) + json.loads/json.load binding tables. */
export interface SerializationSchema {
  /** schema_version (maintained by the project author; missing/non-integer → null, display only, no inference). */
  version: number | null;
  types: ReadonlyMap<string, ReadonlyMap<string, SchemaFieldType>>;
  loadsBindings: ReadonlyArray<{ path: string; type: string }>;
  /** json.load(open(...)) face bindings (key 'json.load'; consumed since KSEM-CFG-07). */
  loadBindings: ReadonlyArray<{ path: string; type: string }>;
}

export interface SchemaParseResult {
  /** null = no schema available (not JSON / bad top-level shape; zero claims).
   * When some fields fail validation the schema still carries the valid part;
   * failure details are in errors (shown on the diagnostic lane). */
  schema: SerializationSchema | null;
  errors: string[];
}

/** Schema parsing (validation failure details in errors; the wiring face should record diagnostics, this core emits none). */
export function parseSerializationSchema(text: string): SchemaParseResult {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { schema: null, errors: ['schema is not valid JSON'] };
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return { schema: null, errors: ['schema top level must be an object'] };
  }
  const root = doc as Record<string, unknown>;
  const errors: string[] = [];
  const sv = root['schema_version'];
  const version = typeof sv === 'number' && Number.isInteger(sv) ? sv : null;
  if (version === null) {
    errors.push('schema_version must be an integer');
  }
  // Collect all type ids first (references may be forward; cycle detection runs uniformly after the field tables are built)
  const rawTypes = root['types'];
  const knownTypes = new Set<string>();
  if (rawTypes !== undefined &&
      (rawTypes === null || typeof rawTypes !== 'object' || Array.isArray(rawTypes))) {
    errors.push('types must be an object');
  } else if (rawTypes !== undefined) {
    for (const id of Object.keys(rawTypes as Record<string, unknown>)) {
      knownTypes.add(id);
    }
  }
  const fieldsOf = new Map<string, Map<string, SchemaFieldType>>();
  if (rawTypes !== undefined && typeof rawTypes === 'object' && !Array.isArray(rawTypes)) {
    for (const [id, entry] of Object.entries(rawTypes as Record<string, unknown>)) {
      const fieldsRaw = entry !== null && typeof entry === 'object' && !Array.isArray(entry)
        ? (entry as Record<string, unknown>)['fields']
        : undefined;
      if (fieldsRaw === undefined || fieldsRaw === null ||
          typeof fieldsRaw !== 'object' || Array.isArray(fieldsRaw)) {
        errors.push(`type ${id}: fields must be an object`);
        continue;
      }
      const fields = new Map<string, SchemaFieldType>();
      for (const [fname, spec] of Object.entries(fieldsRaw as Record<string, unknown>)) {
        const resolved = schemaFieldTypeFrom(spec, knownTypes, `type ${id} field ${fname}`, errors);
        if (resolved !== null) {
          fields.set(fname, resolved);
        }
      }
      fieldsOf.set(id, fields);
    }
  }
  // Cycles: a type whose ref closure contains a cycle cannot build a closed
  // literal, so the whole type is dropped (cascade: types referencing it fail
  // field resolution → zero claims on the consumer face)
  const wellFounded = wellFoundedTypes(fieldsOf);
  for (const id of [...fieldsOf.keys()]) {
    if (!wellFounded.has(id)) {
      errors.push(`type ${id}: cyclic or unresolved type reference`);
      fieldsOf.delete(id);
    }
  }
  // bindings: two keys, 'json.loads' (SER-10) and 'json.load' (consumed since
  // KSEM-CFG-07, paired with open(string) on the loading face); entry shape and
  // validation are isomorphic; other keys stay reserved -- no error, not consumed.
  const rawBindings = root['bindings'];
  const loadsBindings: Array<{ path: string; type: string }> = [];
  const loadBindings: Array<{ path: string; type: string }> = [];
  if (rawBindings !== undefined &&
      (rawBindings === null || typeof rawBindings !== 'object' || Array.isArray(rawBindings))) {
    errors.push('bindings must be an object');
  } else if (rawBindings !== undefined) {
    const tables: Array<{
      key: 'json.loads' | 'json.load';
      into: Array<{ path: string; type: string }>;
    }> = [
      { key: 'json.loads', into: loadsBindings },
      { key: 'json.load', into: loadBindings }
    ];
    for (const { key, into } of tables) {
      const raw = (rawBindings as Record<string, unknown>)[key];
      if (raw === undefined) {
        continue;
      }
      if (!Array.isArray(raw)) {
        errors.push(`bindings["${key}"] must be an array`);
        continue;
      }
      const seen = new Set<string>();
      for (const item of raw) {
        const path = item !== null && typeof item === 'object' && !Array.isArray(item)
          ? (item as Record<string, unknown>)['path'] : undefined;
        const type = item !== null && typeof item === 'object' && !Array.isArray(item)
          ? (item as Record<string, unknown>)['type'] : undefined;
        if (typeof path !== 'string' || path.length === 0 || typeof type !== 'string') {
          errors.push('binding entry must be {path, type}');
          continue;
        }
        if (!fieldsOf.has(type)) {
          errors.push(`binding ${path}: unknown type ${type}`);
          continue;
        }
        const dupKey = `${path}\u0000${type}`;
        if (seen.has(dupKey)) {
          continue; // exact-duplicate entries dedupe (same path + same type is not ambiguity)
        }
        seen.add(dupKey);
        into.push({ path, type });
      }
    }
  }
  return {
    schema: { version, types: fieldsOf, loadsBindings, loadBindings },
    errors
  };
}

/** Field type resolution (scalar family name → SCALAR_FAMILIES; other strings → type reference). */
function schemaFieldTypeFrom(
  spec: unknown,
  knownTypes: ReadonlySet<string>,
  where: string,
  errors: string[]
): SchemaFieldType | null {
  if (typeof spec === 'string') {
    if (SCALAR_FAMILIES.has(spec)) {
      return { kind: 'scalar', family: spec };
    }
    if (knownTypes.has(spec)) {
      return { kind: 'ref', type: spec };
    }
    errors.push(`${where}: unknown type name ${spec}`);
    return null;
  }
  if (Array.isArray(spec)) {
    if (spec.length !== 1) {
      errors.push(`${where}: list spec must be [type]`);
      return null;
    }
    const element = schemaFieldTypeFrom(spec[0], knownTypes, `${where}[]`, errors);
    return element !== null ? { kind: 'list', element } : null;
  }
  errors.push(`${where}: field spec must be a string or [type]`);
  return null;
}

/** Fixpoint: only types whose refs all land on well-founded types can build a closed literal. */
function wellFoundedTypes(
  fieldsOf: ReadonlyMap<string, ReadonlyMap<string, SchemaFieldType>>
): Set<string> {
  const valid = new Set<string>();
  let changed = true;
  const refsValid = (fields: ReadonlyMap<string, SchemaFieldType>): boolean => {
    for (const ft of fields.values()) {
      let probe: SchemaFieldType | null = ft;
      while (probe !== null && probe.kind === 'list') {
        probe = probe.element;
      }
      if (probe !== null && probe.kind === 'ref' && !valid.has(probe.type)) {
        return false;
      }
    }
    return true;
  };
  while (changed) {
    changed = false;
    for (const [id, fields] of fieldsOf) {
      if (!valid.has(id) && refsValid(fields)) {
        valid.add(id);
        changed = true;
      }
    }
  }
  return valid;
}

// ── chain propagation derivation ──

/** Chain state: carrier = dumps product (JSON string, value structure fmt);
 * value = loads product/alias (dict structure fmt); dead = unprovable. */
type ChainState =
  | { kind: 'carrier'; fmt: DictFormat }
  | { kind: 'value'; fmt: DictFormat; /** schema binding type id (since KSEM-CFG-07; absent on the SER-09 derivation face) */ typeId?: string | null }
  | { kind: 'dead' };

interface BindingFlags {
  from: number;
  killed: boolean;
}

/**
 * JSON chain structure derivation entry: module-scope variables → a dict
 * structure map (provable loads products/aliases only; the carrier is a JSON
 * string, claims no dict, stays out of the map).
 */
function walkJsonChains(
  text: string,
  schema: SerializationSchema | null,
  interestLines?: ReadonlyArray<number>
): {
  states: ReadonlyMap<string, ChainState>;
  /** pre-line snapshot (state as of before the line runs; line ≥ total lines → final state); unrequested lines have no entry */
  snapshots: Map<number, ReadonlyMap<string, ChainState>>;
} {
  const masked = pythonCodeLines(text);
  const realLines = text.split(/\r?\n/);
  const dictFormats = deriveDictFormats(text);
  const states = new Map<string, ChainState>();
  const snapshots = new Map<number, ReadonlyMap<string, ChainState>>();
  const interest = interestLines !== undefined ? new Set(interestLines) : null;
  const attrJson = new Map<string, BindingFlags>();   // import json [as X]
  const bareDumps = new Map<string, BindingFlags>();  // from json import dumps [as X]
  const bareLoads = new Map<string, BindingFlags>();
  const bareLoad = new Map<string, BindingFlags>();   // from json import load [as X]
  const scopeIndents: number[] = [];
  const blockIndents: number[] = [];
  const bound = (
    table: ReadonlyMap<string, BindingFlags>,
    name: string,
    line: number
  ): boolean => {
    const flag = table.get(name);
    return flag !== undefined && !flag.killed && flag.from <= line;
  };
  const killName = (name: string): void => {
    states.set(name, { kind: 'dead' });
    const a = attrJson.get(name);
    if (a) {
      a.killed = true;
    }
    const d = bareDumps.get(name);
    if (d) {
      d.killed = true;
    }
    const l = bareLoads.get(name);
    if (l) {
      l.killed = true;
    }
    const f = bareLoad.get(name);
    if (f) {
      f.killed = true;
    }
  };
  const killTargets = (targetText: string): void => {
    for (const piece of targetText.split(',')) {
      const name = /^([A-Za-z_]\w*)$/.exec(piece.trim());
      if (name) {
        killName(name[1]);
      }
    }
  };
  /** dumps argument → structure: bare name (value passes / SER-09 fallback) or
   * dict literal (multi-line included); the rest (string literal/call/non-dict
   * top level) → null, no claim. */
  const dumpsArgFormat = (argMaskedTrim: string, line: number): DictFormat | null => {
    if (/^[A-Za-z_]\w*$/.test(argMaskedTrim)) {
      const state = states.get(argMaskedTrim);
      if (state && state.kind === 'value') {
        return state.fmt; // loads product/alias passes
      }
      return dictFormats.get(argMaskedTrim) ?? null; // SER-09 code-fact side
    }
    if (!argMaskedTrim.startsWith('{')) {
      return null; // string literal/call/other → non-dict top level or unprovable
    }
    const real = realLines[line] ?? '';
    const realIndent = real.length - real.trimStart().length;
    const braceAt = realIndent + real.trim().indexOf('{');
    const matched = matchDictBraces(realLines, line, braceAt);
    if (!matched) {
      return null;
    }
    const literal = sliceLines(realLines, line, braceAt, matched.endLine, matched.endColumn);
    const classified = classifyValue(literal);
    return classified.kind === 'dict' ? classified.dict : null; // non-dict top level claims nothing
  };

  let line = 0;
  while (line < masked.length) {
    if (interest !== null && interest.has(line)) {
      snapshots.set(line, new Map(states)); // pre-line snapshot: the line's own assignment has not run yet
    }
    const m = masked[line] ?? '';
    if (m.trim().length === 0) {
      line += 1;
      continue;
    }
    const indent = m.length - m.trimStart().length;
    while (scopeIndents.length > 0 && scopeIndents[scopeIndents.length - 1] >= indent) {
      scopeIndents.pop();
    }
    while (blockIndents.length > 0 && blockIndents[blockIndents.length - 1] >= indent) {
      blockIndents.pop();
    }
    const trimmed = m.trim();
    if (/^(async\s+)?(def|class)\s/.test(trimmed)) {
      scopeIndents.push(indent);
      line += 1;
      continue;
    }
    if (/^(if|elif|else|for|while|try|except|finally|with)\b/.test(trimmed)) {
      if (scopeIndents.length === 0) {
        blockIndents.push(indent);
      }
      line += 1;
      continue;
    }
    if (scopeIndents.length > 0) {
      line += 1; // function body: stays out of the module chain face (merging same-name cross-scope states would be a false report)
      continue;
    }
    const conditional = blockIndents.length > 0;

    // ── import evidence (including try:import inside branch bodies -- if it is used, it is necessarily imported)──
    const impAttr = /^import\s+json(?:\s+as\s+([A-Za-z_]\w*))?$/.exec(trimmed);
    if (impAttr) {
      attrJson.set(impAttr[1] ?? 'json', { from: line, killed: false });
      line += 1;
      continue;
    }
    const impFrom = /^from\s+json\s+import\s+(.+)$/.exec(trimmed);
    if (impFrom) {
      let itemsText = impFrom[1];
      let endLine = line;
      if (itemsText.includes('(') && !itemsText.includes(')')) {
        // parenthesized continuation: gather up to the closing-paren line (bounded to 8 lines; unclosed → honestly no binding)
        let closed = false;
        while (!closed && endLine - line < 8) {
          endLine += 1;
          const nextLine = masked[endLine] ?? '';
          itemsText += ` ${nextLine.trim()}`;
          if (nextLine.includes(')')) {
            closed = true;
          }
        }
        if (!closed) {
          line += 1;
          continue;
        }
        itemsText = itemsText.slice(itemsText.indexOf('(') + 1, itemsText.lastIndexOf(')'));
      }
      for (const itemRaw of itemsText.split(',')) {
        const item = /^([A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?$/.exec(itemRaw.trim());
        if (!item) {
          continue;
        }
        const boundName = item[2] ?? item[1];
        if (item[1] === 'dumps') {
          bareDumps.set(boundName, { from: line, killed: false });
        } else if (item[1] === 'loads') {
          bareLoads.set(boundName, { from: line, killed: false });
        } else if (item[1] === 'load') {
          bareLoad.set(boundName, { from: line, killed: false });
        }
      }
      line = endLine + 1;
      continue;
    }

    // ── NAME = call (json.loads/dumps/load attribute form or bound bare name;
    // any other call = unprovable write point → kill)──
    const callAssign =
      /^([A-Za-z_]\w*)\s*(?::[^=]*?)?=(?![=>])\s*(?:([A-Za-z_]\w*)\s*\.\s*)?([A-Za-z_]\w*)\s*\(/.exec(trimmed);
    if (callAssign) {
      const [, name, attr, fn] = callAssign;
      const parenAt = callAssign[0].length - 1;
      const argSpan = topLevelParenSpan(trimmed, parenAt);
      // binding detection decoupled from argument shape (multi-line arguments still need the dumps/loads/load role recognized first)
      let role: 'loads' | 'dumps' | 'load' | null = null;
      if (attr !== undefined) {
        if (fn === 'loads' && bound(attrJson, attr, line)) {
          role = 'loads';
        } else if (fn === 'dumps' && bound(attrJson, attr, line)) {
          role = 'dumps';
        } else if (fn === 'load' && bound(attrJson, attr, line)) {
          role = 'load';
        }
      } else if (bound(bareLoads, fn, line)) {
        role = 'loads';
      } else if (bound(bareDumps, fn, line)) {
        role = 'dumps';
      } else if (bound(bareLoad, fn, line)) {
        role = 'load';
      }
      if (role === null) {
        killName(name); // binding does not hold: write point killed
        line += 1;
        continue;
      }
      if (argSpan !== null && trimmed.slice(argSpan.end + 1).trim().length !== 0) {
        killName(name); // call has a suffix (method chain/ternary): write point killed
        line += 1;
        continue;
      }
      if (argSpan === null) {
        // multi-line call: only dumps unfolds a multi-line dict literal argument
        // (matchDictBraces pairing, closing paren must sit on the literal's last
        // line); other multi-line shapes are v1 unknown
        if (role !== 'dumps') {
          killName(name);
          line += 1;
          continue;
        }
        const real = realLines[line] ?? '';
        const realIndent = real.length - real.trimStart().length;
        const relBrace = real.trim().indexOf('{', parenAt);
        const matched = relBrace >= 0
          ? matchDictBraces(realLines, line, realIndent + relBrace)
          : null;
        const tailOk = matched !== null &&
          /^\)\s*;?\s*$/.test((masked[matched.endLine] ?? '').slice(matched.endColumn).trim());
        const literal = matched !== null && tailOk
          ? sliceLines(realLines, line, realIndent + relBrace, matched.endLine, matched.endColumn)
          : null;
        const classified = literal !== null ? classifyValue(literal) : null;
        const fmt = classified !== null && classified.kind === 'dict' ? classified.dict : null;
        if (conditional || fmt === null) {
          killName(name);
        } else {
          states.set(name, { kind: 'carrier', fmt: jsonFormat(fmt) });
        }
        line = matched !== null && tailOk ? matched.endLine + 1 : line + 1;
        continue;
      }
      const argMaskedTrim = trimmed.slice(argSpan.start + 1, argSpan.end).trim();
      if (role === 'loads' || role === 'load') {
        let fmt: DictFormat | null = null;
        let typeId: string | null = null;
        if (role === 'loads') {
          if (argMaskedTrim.startsWith('_')) {
            // string literal argument: a leading '_' on the masked line marks a quote position, path contents come from the raw line
            const argRealTrim = (realLines[line] ?? '').trim().slice(argSpan.start + 1, argSpan.end);
            if (isQuotedLiteral(argRealTrim.trim())) {
              const hit = schemaPathBinding(argRealTrim.trim().slice(1, -1), schema, 'json.loads');
              fmt = hit.fmt;
              typeId = hit.typeId;
            }
          } else if (/^[A-Za-z_]\w*$/.test(argMaskedTrim)) {
            // chain carrier (loads only takes strings; value/dict names are not JSON strings, do not pass)
            const state = states.get(argMaskedTrim);
            fmt = state && state.kind === 'carrier' ? state.fmt : null;
          }
        } else {
          // json.load(open(string literal)): binds only on a quoted-string
          // first open argument; other shapes (variable path / non-open
          // argument) are unprovable
          const argRealTrim = (realLines[line] ?? '').trim().slice(argSpan.start + 1, argSpan.end);
          const hit = loadOpenPath(argMaskedTrim, argRealTrim, schema);
          fmt = hit.fmt;
          typeId = hit.typeId;
        }
        if (conditional || fmt === null) {
          killName(name);
        } else {
          states.set(name, { kind: 'value', fmt, typeId });
        }
      } else {
        // single-argument tightening: top-level comma = keyword/multi-argument shape → unknown
        const hasKwargs = topLevelHasComma(argMaskedTrim);
        const fmt = hasKwargs ? null : dumpsArgFormat(argMaskedTrim, line);
        if (conditional || fmt === null) {
          killName(name);
        } else {
          states.set(name, { kind: 'carrier', fmt: jsonFormat(fmt) }); // dumps-direction conversion
        }
      }
      line += 1;
      continue;
    }

    // ── NAME = bare name (alias passthrough; a carrier's alias is still a carrier)──
    const alias = /^([A-Za-z_]\w*)\s*(?::[^=]*?)?=(?![=>])\s*([A-Za-z_]\w*)$/.exec(trimmed);
    if (alias) {
      const [, name, of] = alias;
      const state = states.get(of);
      if (conditional) {
        killName(name);
      } else if (state && state.kind !== 'dead') {
        states.set(name, state);
      } else if (dictFormats.has(of)) {
        states.set(name, { kind: 'value', fmt: dictFormats.get(of) as DictFormat });
      } else {
        killName(name);
      }
      line += 1;
      continue;
    }

    // ── other assignments/write points/deletes: targets are killed unconditionally ──
    const generic = /^([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*(?::[^=]*?)?=(?![=>])/.exec(trimmed);
    if (generic) {
      killTargets(generic[1]);
      line += 1;
      continue;
    }
    const aug = /^([A-Za-z_]\w*)\s*(?:\+|-|\*|\/|%|\||&|\^|>>|<<|\/\/|\*\*)=(?!=)/.exec(trimmed);
    if (aug) {
      killName(aug[1]);
      line += 1;
      continue;
    }
    const subWrite = /^([A-Za-z_]\w*)\s*\[.*\]\s*=(?![=>])/.exec(trimmed);
    if (subWrite) {
      killName(subWrite[1]);
      line += 1;
      continue;
    }
    const mutate = /^([A-Za-z_]\w*)\s*\.\s*(update|setdefault|append|add)\s*\(/.exec(trimmed);
    if (mutate) {
      killName(mutate[1]);
      line += 1;
      continue;
    }
    const delLine = /^del\s+([A-Za-z_]\w*)/.exec(trimmed);
    if (delLine) {
      killName(delLine[1]);
      line += 1;
      continue;
    }
    line += 1;
  }
  // snapshot completion: skipped regions (middle of dumps/import multi-line
  // literals) carry the previous snapshot forward (no assignment is processed
  // there, state unchanged); line ≥ the file's last line → final state
  if (interest !== null) {
    for (const want of interest) {
      if (!snapshots.has(want)) {
        if (want >= masked.length) {
          snapshots.set(want, new Map(states));
          continue;
        }
        let prev = want;
        while (prev >= 0 && !snapshots.has(prev)) {
          prev -= 1;
        }
        snapshots.set(want, prev >= 0 ? snapshots.get(prev) as ReadonlyMap<string, ChainState> : new Map(states));
      }
    }
  }
  return { states, snapshots };
}

/** SER-10 contract face: module-scope variables → a dict structure map
 * (provable loads products/aliases only; the carrier is a JSON string, claims
 * no dict, stays out of the map). */
export function deriveJsonChainStructures(
  text: string,
  schema: SerializationSchema | null
): Map<string, DictFormat> {
  const { states } = walkJsonChains(text, schema);
  const out = new Map<string, DictFormat>();
  for (const [name, state] of states) {
    if (state.kind === 'value') {
      out.set(name, state.fmt);
    }
  }
  return out;
}

/** CFG-07 field-access face chain-state supply: value states carry the schema
 * binding type id; pre-line snapshots of the requested lines (the line's own
 * assignment not yet executed; def body lines = state at body entry; line ≥
 * last line = final state). */
export interface JsonChainTypedValue {
  fmt: DictFormat;
  /** schema binding type id (present only on schema-bound loads/load products; SER-09 derivation / chain alias = null) */
  typeId: string | null;
}

export function deriveJsonChainTypedValues(
  text: string,
  schema: SerializationSchema | null,
  interestLines: ReadonlyArray<number>
): Map<number, ReadonlyMap<string, JsonChainTypedValue>> {
  const { snapshots } = walkJsonChains(text, schema, interestLines);
  const out = new Map<number, ReadonlyMap<string, JsonChainTypedValue>>();
  for (const [line, states] of snapshots) {
    const typed = new Map<string, JsonChainTypedValue>();
    for (const [name, state] of states) {
      if (state.kind === 'value') {
        typed.set(name, { fmt: state.fmt, typeId: state.typeId ?? null });
      }
    }
    out.set(line, typed);
  }
  return out;
}

/** Schema binding hit: exactly one fnmatch hit → type id + closed literal
 * structure; zero hits/ambiguity → double null, zero claims (three
 * prohibitions: never infer from names/paths). */
interface SchemaPathHit {
  fmt: DictFormat | null;
  typeId: string | null;
}

function schemaPathBinding(
  path: string,
  schema: SerializationSchema | null,
  loader: 'json.loads' | 'json.load'
): SchemaPathHit {
  if (schema === null) {
    return { fmt: null, typeId: null };
  }
  const table = loader === 'json.loads' ? schema.loadsBindings : schema.loadBindings;
  let hit: string | null = null;
  for (const binding of table) {
    if (fnmatchToRegExp(binding.path).test(path)) {
      if (hit !== null) {
        return { fmt: null, typeId: null }; // ambiguity: take neither the first entry nor the longest glob (SER-08 §2.2)
      }
      hit = binding.type;
    }
  }
  if (hit === null) {
    return { fmt: null, typeId: null };
  }
  return { fmt: schemaTypeFormat(hit, schema, new Set()), typeId: hit };
}

/** json.load(open(...)) argument face: open's first argument as a quoted
 * string literal → path binding; open's other arguments (encoding etc.) are
 * tolerated without validation; variable path / non-quoted-string / non-open
 * shapes → double null, unprovable. Masked and raw lines share columns. */
function loadOpenPath(
  argMaskedTrim: string,
  argRealTrim: string,
  schema: SerializationSchema | null
): SchemaPathHit {
  const openParen = argMaskedTrim.indexOf('(');
  if (!/^open\s*\(/.test(argMaskedTrim) || openParen < 0 || !argMaskedTrim.endsWith(')')) {
    return { fmt: null, typeId: null };
  }
  const innerStart = openParen + 1;
  let depth = 0;
  let end = -1;
  for (let i = innerStart; i < argMaskedTrim.length; i += 1) {
    const ch = argMaskedTrim[i];
    if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
    } else if (ch === ')' && depth === 0) {
      end = i;
      break;
    } else if (ch === ')') {
      depth -= 1;
    } else if (ch === ',' && depth === 0) {
      end = i;
      break;
    }
  }
  if (end < 0) {
    return { fmt: null, typeId: null };
  }
  const firstMasked = argMaskedTrim.slice(innerStart, end).trim();
  if (!/^_+$/.test(firstMasked)) {
    return { fmt: null, typeId: null }; // variable path / empty / keyword shape → unprovable
  }
  const firstReal = argRealTrim.slice(innerStart, innerStart + (end - innerStart)).trim();
  if (!isQuotedLiteral(firstReal)) {
    return { fmt: null, typeId: null };
  }
  return schemaPathBinding(firstReal.slice(1, -1), schema, 'json.load');
}

/** schema type → closed literal format (all fields required; cycle/undefined → null, zero claims). */
function schemaTypeFormat(
  typeId: string,
  schema: SerializationSchema,
  visiting: ReadonlySet<string>
): DictFormat | null {
  const fields = schema.types.get(typeId);
  if (!fields || visiting.has(typeId)) {
    return null;
  }
  const next = new Set(visiting);
  next.add(typeId);
  const required = new Map<string, DictValueKind>();
  for (const [fname, ft] of fields) {
    const kind = schemaFieldKind(ft, schema, next);
    if (kind === null) {
      return null; // field resolution failed → the whole type claims zero (no half claims)
    }
    required.set(fname, kind);
  }
  return { kind: 'literal', required, optional: new Map() };
}

function schemaFieldKind(
  ft: SchemaFieldType,
  schema: SerializationSchema,
  visiting: ReadonlySet<string>
): DictValueKind | null {
  if (ft.kind === 'scalar') {
    return scalarFamilyKind(ft.family);
  }
  if (ft.kind === 'list') {
    const element = ft.element.kind === 'scalar'
      ? scalarFamilyKind(ft.element.family)
      : ft.element.kind === 'ref'
        ? refFieldKind(ft.element.type, schema, visiting)
        : null;
    return { kind: 'list', element }; // null = open element universe, the list itself is still true
  }
  return refFieldKind(ft.type, schema, visiting);
}

function refFieldKind(
  typeId: string,
  schema: SerializationSchema,
  visiting: ReadonlySet<string>
): DictValueKind | null {
  const inner = schemaTypeFormat(typeId, schema, visiting);
  return inner !== null ? { kind: 'dict', dict: inner } : null;
}

/** Scalar family → JSON value face (bytes is not a JSON value, no claim;
 * vector is a numeric sequence, fixed-length/element face unclaimed -- an
 * integer mixed in is not falsely reported as float). */
function scalarFamilyKind(family: string): DictValueKind | null {
  const familyEntry = SCALAR_FAMILIES.get(family);
  if (!familyEntry) {
    return null;
  }
  switch (familyEntry.kind) {
    case 'integer':
      return { kind: 'scalar', scalar: 'int' };
    case 'float':
      return { kind: 'scalar', scalar: 'float' };
    case 'str':
      return { kind: 'scalar', scalar: 'str' };
    case 'bytes':
      return { kind: 'unknown' };
    case 'vector':
      return { kind: 'list', element: null };
  }
}

/** dumps-direction JSON semantic conversion: tuple→list; list/dict recurse;
 * scalars keep their type (int→int/float→float/bool/None/str; the Python json
 * round trip does not fabricate conversions); key is always str, which holds
 * naturally in the model (SER-09 non-string key = dynamic key → open universe). */
function jsonFormat(fmt: DictFormat): DictFormat {
  if (fmt.kind === 'literal') {
    return {
      kind: 'literal',
      required: mapValues(fmt.required, jsonValueKind),
      optional: mapValues(fmt.optional, jsonValueKind)
    };
  }
  if (fmt.kind === 'open') {
    return { kind: 'open', observed: mapValues(fmt.observed, jsonValueKind) };
  }
  return fmt;
}

function jsonValueKind(kind: DictValueKind): DictValueKind {
  if (kind.kind === 'tuple') {
    return { kind: 'list', element: kind.element !== null ? jsonValueKind(kind.element) : null };
  }
  if (kind.kind === 'list') {
    return { kind: 'list', element: kind.element !== null ? jsonValueKind(kind.element) : null };
  }
  if (kind.kind === 'dict') {
    return { kind: 'dict', dict: jsonFormat(kind.dict) };
  }
  return kind;
}

function mapValues<K, V, R>(
  source: ReadonlyMap<K, V>,
  transform: (value: V) => R
): Map<K, R> {
  const out = new Map<K, R>();
  for (const [key, value] of source) {
    out.set(key, transform(value));
  }
  return out;
}

/** Top-level comma in argument text (masked lines blank out string contents,
 * so a depth scan suffices; keyword/multi-argument shape → true). */
function topLevelHasComma(text: string): boolean {
  let depth = 0;
  for (const ch of text) {
    if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
    } else if (ch === ',' && depth === 0) {
      return true;
    }
  }
  return false;
}

/** Position of the top-level closing paren from parenAt in the trimmed text
 * (masked lines blank out string contents, parens inside quotes do not count;
 * unclosed → null). */
function topLevelParenSpan(
  trimmed: string,
  parenAt: number
): { start: number; end: number } | null {
  let depth = 0;
  for (let i = parenAt; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return ch === ')' ? { start: parenAt, end: i } : null;
      }
    }
  }
  return null;
}

/** Multi-line literal slice (from startLine/startColumn to endLine/endColumn,
 * lines joined with '\n' -- the line-number convention of classifyValue). */
function sliceLines(
  realLines: readonly string[],
  startLine: number,
  startColumn: number,
  endLine: number,
  endColumn: number
): string {
  if (endLine === startLine) {
    return realLines[startLine].slice(startColumn, endColumn);
  }
  const parts = [realLines[startLine].slice(startColumn)];
  for (let i = startLine + 1; i < endLine; i += 1) {
    parts.push(realLines[i]);
  }
  parts.push(realLines[endLine].slice(0, endColumn));
  return parts.join('\n');
}

// ── Python fnmatch semantics (design §5: path glob agrees with the existing
// .kbengine/ usage; `*` crosses directories, no path semantics)──

const fnmatchCache = new Map<string, RegExp>();

function fnmatchToRegExp(pattern: string): RegExp {
  const cached = fnmatchCache.get(pattern);
  if (cached) {
    return cached;
  }
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*') {
      out += '.*';
    } else if (ch === '?') {
      out += '.';
    } else if (ch === '[') {
      const close = pattern.indexOf(']', i + 1);
      if (close < 0) {
        out += '\\[';
        continue;
      }
      let cls = pattern.slice(i + 1, close);
      i = close;
      if (cls.startsWith('!')) {
        cls = '^' + cls.slice(1);
      }
      out += cls.length > 0 ? `[${cls}]` : '\\[\\]';
    } else {
      out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  const re = new RegExp(`^${out}$`);
  fnmatchCache.set(pattern, re);
  return re;
}

/** Binding glob (SER-08 fnmatch semantics) matched against a concrete path
 * (shared with the CFG-08 structure registry; the RegExp cache is shared). */
export function schemaGlobMatches(pattern: string, path: string): boolean {
  return fnmatchToRegExp(pattern).test(path);
}
