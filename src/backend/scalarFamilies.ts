/**
 * Engine scalar family source of truth (KSEM-SER-10, extracted from CELL-08
 * cellDataWriteCheck into a pure module).
 *
 * Data source = the datatypes.cpp `DataTypes::initialize` registry, the same source
 * as kbengineMetadata: integer scalars are ranged by bandwidth and signedness;
 * FLOAT/DOUBLE numbers; STRING/UNICODE strings; BLOB byte streams; VECTOR2/3/4
 * fixed-length numeric vectors; PYTHON and PY_DICT/PY_TUPLE/PY_LIST/ENTITYCALL
 * accept Python objects so no check; ARRAY/FIXED_DICT/types.xml custom aliases
 * have unknown structure -> no check (honest).
 *
 * Zero vscode dependencies (cellDataWriteCheck depends on vscode indirectly via
 * nlsRuntime; the pure core of the serialization schema lane SER-08/SER-10 must not
 * drag that dependency graph, so the table lives here and consumers import it
 * themselves; CELL-08 behavior unchanged).
 */

/** Engine scalar families (the datatypes.cpp registry; range = the closed interval from bandwidth and signedness). */
export interface ScalarFamily {
  /** Value class: integer scalar (int/bool admitted) / float scalar / string / byte stream / fixed-length vector. */
  kind: 'integer' | 'float' | 'str' | 'bytes' | 'vector';
  /** integer family range (exact BigInt bounds; defaults to unbounded). */
  min?: bigint;
  max?: bigint;
  /** vector family arity. */
  arity?: number;
  /** The expectation segment in the hint text (`UINT16 (int 0..65535)`). */
  label: string;
}

/** Engine scalar type table; types not in the table (the PYTHON family, ARRAY, FIXED_DICT, custom aliases) are not checked. */
// Range bounds always via BigInt() (tsconfig target < ES2020 forbids the 0n
// literal; 64-bit bounds enter as strings to preserve precision), and written
// values are likewise parsed exactly with BigInt — no double rounding dead zone in
// boundary decisions.
export const SCALAR_FAMILIES: ReadonlyMap<string, ScalarFamily> = new Map([
  ['UINT8', { kind: 'integer', min: BigInt(0), max: BigInt(255), label: 'UINT8 (int 0..255)' }],
  ['UINT16', { kind: 'integer', min: BigInt(0), max: BigInt(65535), label: 'UINT16 (int 0..65535)' }],
  ['UINT32', { kind: 'integer', min: BigInt(0), max: BigInt(4294967295), label: 'UINT32 (int 0..4294967295)' }],
  ['UINT64', { kind: 'integer', min: BigInt(0), max: BigInt('18446744073709551615'), label: 'UINT64 (int 0..2^64-1)' }],
  ['INT8', { kind: 'integer', min: BigInt(-128), max: BigInt(127), label: 'INT8 (int -128..127)' }],
  ['INT16', { kind: 'integer', min: BigInt(-32768), max: BigInt(32767), label: 'INT16 (int -32768..32767)' }],
  ['INT32', { kind: 'integer', min: BigInt(-2147483648), max: BigInt(2147483647), label: 'INT32 (int -2^31..2^31-1)' }],
  ['INT64', { kind: 'integer', min: BigInt('-9223372036854775808'), max: BigInt('9223372036854775807'), label: 'INT64 (int -2^63..2^63-1)' }],
  ['FLOAT', { kind: 'float', label: 'FLOAT (number)' }],
  ['DOUBLE', { kind: 'float', label: 'DOUBLE (number)' }],
  ['STRING', { kind: 'str', label: 'STRING (str)' }],
  ['UNICODE', { kind: 'str', label: 'UNICODE (str)' }],
  ['BLOB', { kind: 'bytes', label: 'BLOB (bytes)' }],
  ['VECTOR2', { kind: 'vector', arity: 2, label: 'VECTOR2 (2-number sequence)' }],
  ['VECTOR3', { kind: 'vector', arity: 3, label: 'VECTOR3 (3-number sequence)' }],
  ['VECTOR4', { kind: 'vector', arity: 4, label: 'VECTOR4 (4-number sequence)' }]
]);
