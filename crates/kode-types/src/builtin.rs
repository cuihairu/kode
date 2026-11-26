//! Engine builtin type table (aligned with the engine `DataTypes::getDataType`
//! registration names; the TS side `tests/kodeTypesParity.test.ts` holds a copy
//! of the same list — parity comparison only holds when both sides agree).
//!
//! Semantics source: src/databaseSchema.ts `SIMPLE_DB_TYPE_LABELS` + VECTOR2/3/4.
//! `ARRAY`/`FIXED_DICT` are container directive words, not builtin scalars, and
//! are recognized separately by [`is_container_directive`]; an alias chain
//! terminal landing on either (or on a node inside the graph) counts as
//! "known" (see [`is_known_terminal`]).

/// Engine builtin type names (all uppercase; the lookup side is
/// case-sensitive, matching the engine registration names).
pub const BUILTIN_TYPES: &[&str] = &[
    "INT8",
    "INT16",
    "INT32",
    "INT64",
    "UINT8",
    "UINT16",
    "UINT32",
    "UINT64",
    "FLOAT",
    "DOUBLE",
    "STRING",
    "UNICODE",
    "PYTHON",
    "PY_DICT",
    "PY_TUPLE",
    "PY_LIST",
    "BLOB",
    "ENTITYCALL",
    "VECTOR2",
    "VECTOR3",
    "VECTOR4",
];

/// Container directive words (ARRAY / FIXED_DICT in .def/types.xml `<Type>` text).
pub const CONTAINER_DIRECTIVES: &[&str] = &["ARRAY", "FIXED_DICT"];

pub fn is_builtin(name: &str) -> bool {
    BUILTIN_TYPES.contains(&name)
}

pub fn is_container_directive(name: &str) -> bool {
    CONTAINER_DIRECTIVES.contains(&name)
}

/// Whether the terminal of an alias chain is "known": a builtin scalar, a
/// container directive, or a named node inside the graph (looked up by the
/// caller). Any other name is treated as unknown (SEM-013: the reason is kept
/// intact rather than masquerading as a builtin).
pub fn is_known_terminal(name: &str) -> bool {
    is_builtin(name) || is_container_directive(name)
}
