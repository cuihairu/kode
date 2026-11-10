//! kode-mcp:把 def 知识库暴露给 AI agent(MCP-001)。

mod bounded_scan;
pub mod code_index;
pub mod config_catalog;
pub mod config_qa;
pub mod docs_index;
pub mod explain;
pub mod extract;
pub mod fts;
pub mod git_state;
pub mod kb;
pub mod kb_index;
pub mod nodes;
pub mod protocol_frame;
pub mod read_node;
pub mod semantic_model;
pub mod server;
pub mod store;

pub use kb::{AssetKnowledge, ParsedDef};
pub use server::{run_stdio, KodeMcpServer};
