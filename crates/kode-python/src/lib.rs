//! kode-python:KBEngine Python 脚本的 AST 集成层(kode2 C-20)。
//!
//! 职责(kode2 C-20,交付面见 docs/kode2/KODE_2_COMPLETE_TODO.md):
//! - [`parse`] Python 源 → ruff AST(ruff_python_parser,不造轮子)+ 行定位;
//! - [`symbols`] AST → 符号表(类/方法/属性/导入四表,可降级为
//!   [`kode_corpus::PythonModule`] 供 C-19 一致性检查与 wt/parity 复用);
//! - [`callgraph`] 方法级调用图 + KBEngine 特化边(allClients/baseClients 广播边、
//!   cell/base 跨进程边,进程归属联动 C-17);
//! - [`dataflow`] 过程内 def-use 数据流(MVP:直线近似,不合并控制流分支);
//! - [`graph`] 调用图聚合 + 供 kode-scheduler 失效 DAG 消费的反向索引
//!   (被调方文件 → 调用方文件集)。
//!
//! 边界:过程间数据流/指针分析不在本期(MVP 只做过程内直线近似)。
//! 依赖:本 crate 是仓库唯一显式引入第三方解析器(ruff)的模块,其余 crate
//! 保持零第三方依赖(见 crate 根 `Cargo.toml` 注)。

pub mod callgraph;
pub mod dataflow;
pub mod graph;
pub mod model;
pub mod parse;
pub mod symbols;

pub use callgraph::{extract_call_graph_detailed, DetailedCallEdge};
pub use dataflow::{dataflow_for_module, MethodDataflow};
pub use graph::{uncertain_cross_process_files, CallReverseIndex, PyCallGraph};
pub use model::{
    AstAttribute, AstClass, AstFunction, AstImport, AstMethod, AstSymbols, CallEdge,
    DataflowResult, DefUseChain, EdgeKind,
};
pub use parse::ParsedAst;
pub use symbols::{method_params, parse_ast_symbols, AstExtraction};
