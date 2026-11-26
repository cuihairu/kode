//! kode2 PR-008 —— KBEngine type graph IR (book §6.2 SEM-002/004/005/013
//! baseline).
//!
//! Four input kinds (types.xml / alias.xml / *.def / entities.xml, parsed by
//! kode-parser) are normalized into one directed type graph:
//! - Nodes [`TypeNode`]: alias (redirect), array, FixedDict, user type
//!   (entity), Unknown/Error (RUST-104-W opt-in forms); engine builtin scalars
//!   build no node and serve only as reference terminals (see [`builtin`]).
//!   The variant set aligns with SEM-002's IR list (Builtin/Alias/
//!   Array/FixedDict/UserType/EntityRef/Component/Unknown/Error): Builtin is
//!   expressed as a reference terminal, EntityRef/Component as edge kinds (see
//!   [`EdgeKind`]), and Unknown/Error as explicit node variants (the builder
//!   never materializes them automatically; classification stays
//!   [`TypeClass::Unknown`], and SEM-013 does not borrow some arbitrary type to
//!   hide the absence); Optional is the slot face [`OptionalSlot`] — the engine
//!   has no Optional type node, and optionality only appears in
//!   implementedBy/<of> slots, where the two meanings are distinct (engine
//!   optional vs engine rejection).
//! - Edges [`TypeEdge`]: alias target / array element / FixedDict field /
//!   property type reference / component ownership / entity inheritance.
//! - Chain evaluation: [`TypeGraph::resolve_alias_chain`] (SEM-004 alias
//!   chain + cycle diagnosis), [`TypeGraph::resolve_inheritance`] (entity
//!   inheritance chain) — cycles are diagnosed explicitly and truncated at a
//!   bound, never looping forever (the same guarantee as IDX-005).
//! - Whole-graph cycle detection: [`TypeGraph::find_cycles`] runs an iterative
//!   three-color DFS over all named edges, reporting one cycle path per back
//!   edge.
//!
//! The parity golden (write-only, never read) lives in [`golden`]: the TS side
//! `tests/kodeTypesParity.test.ts` recomputes the same corpus with the existing
//! defParser/compositionRoots primitives — a bidirectional gate isomorphic to
//! PR-005/007. Fixture driven; per ARCH-012 no performance comparison.

pub mod builtin;
pub mod golden;
pub mod graph;
pub mod methods;
pub mod provenance;

pub use builtin::{is_builtin, is_container_directive, is_known_terminal, BUILTIN_TYPES};
pub use graph::{
    ChainStatus, ConformanceReport, EdgeKind, OptionalFace, OptionalSlot, TypeClass, TypeEdge,
    TypeErrorReason, TypeGraph, TypeId, TypeNode,
};
pub use methods::{MethodArg, MethodFacet, MethodMeta};
pub use provenance::{
    GenerationKind, GenerationTarget, IngestContext, TypeOrigin, TypeRefSite, TypeSourceKind,
};
