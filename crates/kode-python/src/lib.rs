//! kode-python: AST integration layer for KBEngine Python scripts (kode2 C-20).
//!
//! Responsibilities (kode2 C-20; the delivery surface is in
//! docs/kode2/KODE_2_COMPLETE_TODO.md):
//! - [`parse`] Python source -> ruff AST (ruff_python_parser, no reinventing the wheel) +
//!   line locations;
//! - [`symbols`] AST -> symbol tables (four tables: classes / methods / attributes / imports,
//!   degradable to [`kode_corpus::PythonModule`] for C-19 consistency checks and wt/parity reuse);
//! - [`callgraph`] method-level call graph + KBEngine-specialized edges (allClients/baseClients
//!   broadcast edges, cell/base cross-process edges, process-ownership interplay C-17);
//! - [`dataflow`] intra-procedural def-use dataflow (MVP: straight-line approximation, does not
//!   merge control-flow branches);
//! - [`graph`] call-graph aggregation + reverse index (callee file -> set of caller files) for
//!   the kode-scheduler invalidation DAG to consume.
//!
//! Boundary: inter-procedural dataflow / pointer analysis is out of scope this phase (MVP does
//! only intra-procedural straight-line approximation).
//! Dependencies: this crate is the only module in the repo that explicitly introduces a third-party
//! parser (ruff); all other crates keep zero third-party dependencies (see the note at the crate
//! root `Cargo.toml`).

pub mod callgraph;
pub mod cancel;
pub mod dataflow;
pub mod graph;
pub mod local_return;
pub mod model;
pub mod parse;
pub mod self_flow;

pub mod return_annotations;
pub mod symbols;
pub mod user_type_contract;

pub use callgraph::{extract_call_graph_detailed, DetailedCallEdge};
pub use dataflow::{dataflow_for_module, MethodDataflow};
pub use graph::{uncertain_cross_process_files, CallReverseIndex, PyCallGraph};
pub use model::{
    AstAttribute, AstClass, AstFunction, AstImport, AstMethod, AstSymbols, CallEdge,
    DataflowResult, DefUseChain, EdgeKind,
};
pub use parse::ParsedAst;
pub use symbols::{method_params, parse_ast_symbols, AstExtraction};
