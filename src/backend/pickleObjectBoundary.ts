/**
 * KSEM-SER-11: the pickle/PYTHON boundary (pure core, zero vscode dependencies, zero execution).
 *
 * Engine accounting (SER-01 section 3 / SER-02 section 3 / wire golden): the four families
 * PYTHON/PY_DICT/PY_TUPLE/PY_LIST pass through as raw CPython pickle bytes (datatype.cpp
 * :1225-1242/:1288-1296/:1344-1352/:1400-1408, the DB stores a BLOB column
 * entity_table_mysql.cpp:699-711) -- the pickle bucket is opaque, with no field structure to
 * unfold statically.
 *
 * Three acceptance criteria (todo.md):
 * 1. evidence that existing object types can be passed through: the boundary gate passes every
 *    implementedBy object type (STRUCT-07: in-memory form = the implementing class) and every
 *    non-impl FIXED_DICT/FixedArray key-position surface through fully; GEN-DEF-1c <Default>
 *    literal refinement (def declared, evaluated by the engine with Py_eval_input) passes
 *    through via pickleObjectEvidence -- this is the pickle bucket's only legitimate
 *    structural-side evidence, and the evidence comes from the def registration declaration,
 *    not from a runtime deserialization product.
 * 2. never treat a bare PYTHON as a FIXED_DICT: the engine family name takes precedence over a
 *    same-named custom type registration, and the pickle bucket always claims zero
 *    fields/keys (the structureClaimGate iron face).
 * 3. never execute deserialization of untrusted data to infer: scanPickleDeserialization is a
 *    purely static recognition of project-code pickle.loads/cPickle.loads call forms (import
 *    evidence binding, masked lines, the same discipline as the json chain); structural claims
 *    are always empty and impossible to produce at the type level (never[]) -- pickle has no
 *    schema-binding mechanism, in contrast to json.loads (SER-10: a claim is made only after
 *    hitting a .kbengine/serialization.json binding); this module has zero subprocesses and
 *    zero dynamic evaluation, so no deserialization execution exists.
 */

import type { CustomTypeInfo } from '../definitionWorkspace';
import { FIXED_DICT_TYPE_NAME } from './kbengineMetadata';
import { SCALAR_FAMILIES } from './scalarFamilies';
import { PYTHON_FAMILY_BASE, inferPythonLiteralAnnotation } from './pythonLiteralTypes';
import { pythonCodeLines } from './pythonParser';

// ---------------------------------------------------------------------------
// registry of the pickle bucket's in-memory forms (SER-02 section 3 decode product; the single
// source of truth is the GEN-DEF-1c base-class table)
// ---------------------------------------------------------------------------

/** the pickle bucket's in-memory form: PYTHON=any PyObject, PY_DICT/PY_TUPLE/PY_LIST=dict/tuple/list. */
export type PickleMemoryForm = 'any' | 'dict' | 'tuple' | 'list';

/** base-class annotation string -> in-memory form (a PYTHON_FAMILY_BASE value-range
 * normalization; no second family table is invented). */
const MEMORY_FORM_BY_ANNOTATION: Readonly<Record<string, PickleMemoryForm>> = {
  Any: 'any',
  dict: 'dict',
  tuple: 'tuple',
  list: 'list'
};

/** engine pickle family name -> in-memory form; a non-family name (different case / unregistered) -> null. */
export function pickleFamilyMemoryFormOf(typeName: string): PickleMemoryForm | null {
  const base = PYTHON_FAMILY_BASE[typeName];
  return base === undefined ? null : (MEMORY_FORM_BY_ANNOTATION[base] ?? null);
}

// ---------------------------------------------------------------------------
// pickle bucket object evidence (GEN-DEF-1c declaration refinement pass-through, acceptance 1)
// ---------------------------------------------------------------------------

/** pickle bucket object evidence: in-memory form + def-declaration refinement annotation +
 * a zero-field-claim marker. */
export interface PickleObjectEvidence {
  kind: 'pickleOpaque';
  memoryForm: PickleMemoryForm;
  /** GEN-DEF-1c: no Default/parse failure/None/base-form mismatch -> the base annotation
   * (Any/dict/tuple/list); a legal literal -> the precise annotation. Existing faces pass
   * through unchanged. */
  declaredAnnotation: string;
  /** the field-structure claim: always none -- the pickle bucket has no key-position face
   * (acceptance 2). */
  fieldClaims: 'none';
}

/** only the pickle bucket families return evidence; a non-family name -> null (the gate routes
 * it to another evidence face). */
export function pickleObjectEvidence(
  typeName: string,
  defaultValue?: string
): PickleObjectEvidence | null {
  const memoryForm = pickleFamilyMemoryFormOf(typeName);
  if (memoryForm === null) {
    return null;
  }
  return {
    kind: 'pickleOpaque',
    memoryForm,
    declaredAnnotation: inferPythonLiteralAnnotation(defaultValue, typeName),
    fieldClaims: 'none'
  };
}

// ---------------------------------------------------------------------------
// the structure-claim boundary gate (acceptance 2 iron face: a bare PYTHON never lands in a
// FIXED_DICT-class claim)
// ---------------------------------------------------------------------------

/** a def property type label -> the claim faces it is allowed. Every face runs through the gate
 * first; the pickle bucket always claims zero. */
export type StructureClaimGate =
  | { kind: 'pickleOpaque'; memoryForm: PickleMemoryForm; fieldClaims: 'none' }
  | { kind: 'object'; info: CustomTypeInfo }
  | { kind: 'fixedDict'; info: CustomTypeInfo }
  | { kind: 'array'; element: CustomTypeInfo | null }
  | { kind: 'scalar' }
  | { kind: 'unknown' };

const FIXED_ARRAY_ANNOTATION = /^FixedArray\[(.+)\]$/;

/**
 * The boundary gate: typeLabel (the def property <Type> text or a code annotation name) +
 * the custom type registry -> the claim faces this type is allowed. The determination order:
 * 1. an engine pickle family name first -- a same-named custom type registration cannot give
 *    the pickle bucket structure (acceptance 2);
 * 2. a FIXED_DICT alias: implementedBy -> object (STRUCT-07: in-memory form = the implementing
 *    class, the Properties key positions = the transmission form, the object-contract face is
 *    passed); non-impl -> fixedDict (the key-position face takes over);
 * 3. FixedArray[X]: the element must be a non-impl FD for it to get element structure (the same
 *    accounting as fixedDictSubscript.chainStateFromAnnotation); otherwise element is null (the
 *    container is an array, and the element face is honestly broken);
 * 4. an engine scalar (SCALAR_FAMILIES, the single source of truth) -> scalar;
 * 5. the rest (VECTOR/BLOB/ENTITYCALL/unregistered/malformed) -> unknown: this gate makes zero
 *    claims, and each lane (VISUAL/pyi/call-graph) has its own face.
 */
export function structureClaimGate(
  typeLabel: string,
  customTypes: readonly CustomTypeInfo[]
): StructureClaimGate {
  const trimmed = typeLabel.trim();
  const memoryForm = pickleFamilyMemoryFormOf(trimmed);
  if (memoryForm !== null) {
    return { kind: 'pickleOpaque', memoryForm, fieldClaims: 'none' };
  }
  const info = customTypes.find(candidate => candidate.name === trimmed);
  if (info && info.aliasType === FIXED_DICT_TYPE_NAME) {
    return info.implementedBy
      ? { kind: 'object', info }
      : { kind: 'fixedDict', info };
  }
  const array = FIXED_ARRAY_ANNOTATION.exec(trimmed);
  if (array) {
    const element = customTypes.find(
      candidate =>
        candidate.name === array[1] &&
        candidate.aliasType === FIXED_DICT_TYPE_NAME &&
        !candidate.implementedBy
    ) ?? null;
    return { kind: 'array', element };
  }
  if (SCALAR_FAMILIES.has(trimmed)) {
    return { kind: 'scalar' };
  }
  return { kind: 'unknown' };
}

// ---------------------------------------------------------------------------
// project-code pickle deserialization zero-claim scanning (acceptance 3: recognize the form,
// claims stay zero)
// ---------------------------------------------------------------------------

/** the deserialization direct call sites recognized (import evidence holds, module scope,
 * masked lines). */
export interface PickleDeserializationScan {
  /** the count face: top-level direct call forms in the module face (`alias.loads(…)` /
   * a bound bare name or alias `loads(…)`, subscript-target assignment forms or statement
   * forms). The count only proves that the "form is recognizable while claims stay zero"
 * pairing; references/callbacks (`map(pickle.loads, xs)`), calls inside a function body,
   * unbound receivers (`obj.loads`), the serialization direction (`dumps`), attribute targets/
   * incremental assignment forms (`self.x = loads(…)` / `s += loads(…)`, the json chain has the
   * same boundary) are not deserialization call sites. */
  recognizedCalls: number;
  /** the structure claim: always empty, impossible to produce at the type level (never[]) --
   * pickle has no schema-binding mechanism; call sites are countable but structure is not
   * inferable (contrast json.loads: SER-10, a claim is made only on an schema hit). */
  readonly structureClaims: readonly never[];
}

interface BindingFlags {
  from: number;
  killed: boolean;
}

/**
 * A purely static scan of project code for the pickle deserialization call form (the json
 * chain's discipline: masked lines, import-evidence binding, a rebound binding name is dead, a
 * def/class body does not enter the module face). Zero execution: it does not run Python, read
 * pickle bytes, or evaluate any expression -- the number of call sites comes out, and the
 * structure never does.
 */
export function scanPickleDeserialization(text: string): PickleDeserializationScan {
  const masked = pythonCodeLines(text);
  const attrModules = new Map<string, BindingFlags>(); // import pickle/cPickle [as X]
  const bareLoads = new Map<string, BindingFlags>(); // from pickle/cPickle import … loads [as X]
  const bound = (
    table: ReadonlyMap<string, BindingFlags>,
    name: string,
    line: number
  ): boolean => {
    const flag = table.get(name);
    return flag !== undefined && !flag.killed && flag.from <= line;
  };
  let recognizedCalls = 0;
  let line = 0;
  while (line < masked.length) {
    const m = masked[line] ?? '';
    if (m.trim().length === 0) {
      line += 1;
      continue;
    }
    const trimmed = m.trim();
    if (/^(async\s+)?(def|class)\s/.test(trimmed)) {
      line += 1;
      continue;
    }
    // -- import evidence (module face; an import inside a function body does not enter) --
    const impAttr = /^import\s+(pickle|cPickle)(?:\s+as\s+([A-Za-z_]\w*))?$/.exec(trimmed);
    if (impAttr) {
      attrModules.set(impAttr[2] ?? impAttr[1], { from: line, killed: false });
      line += 1;
      continue;
    }
    const impFrom = /^from\s+(pickle|cPickle)\s+import\s+(.+)$/.exec(trimmed);
    if (impFrom) {
      let itemsText = impFrom[2];
      let endLine = line;
      if (itemsText.includes('(') && !itemsText.includes(')')) {
        // a parenthesized continuation: collect through to the closing paren line (bounded to 8
        // lines; unclosed -> no binding, honest)
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
        if (item[1] === 'loads') {
          bareLoads.set(item[2] ?? 'loads', { from: line, killed: false });
        }
      }
      line = endLine + 1;
      continue;
    }
    // -- a rebound binding name is dead (the binding evidence no longer holds; multiple targets together) --
    const assignHead =
      /^([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*(?::[^=]*?)?=(?![=>])/.exec(trimmed);
    if (assignHead) {
      for (const piece of assignHead[1].split(',')) {
        const name = piece.trim();
        const a = attrModules.get(name);
        if (a) {
          a.killed = true;
        }
        const b = bareLoads.get(name);
        if (b) {
          b.killed = true;
        }
      }
    }
    // -- call recognition (the top-level assignment form / statement form; the count is unaffected by the argument shape) --
    const callAt =
      /^(?:([A-Za-z_]\w*(?:\s*\[[^\]=]*\])?)\s*(?::[^=]*?)?=\s*(?![=>]))?(?:([A-Za-z_]\w*)\s*\.\s*)?([A-Za-z_]\w*)\s*\(/.exec(
        trimmed
      );
    if (callAt) {
      const [, , attr, fn] = callAt;
      const isDeserialization =
        attr !== undefined
          ? fn === 'loads' && bound(attrModules, attr, line)
          : bound(bareLoads, fn, line);
      if (isDeserialization) {
        recognizedCalls += 1;
      }
    }
    line += 1;
  }
  return { recognizedCalls, structureClaims: [] };
}
