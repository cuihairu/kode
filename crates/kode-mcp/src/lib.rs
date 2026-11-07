//! kode-mcp:把 def 知识库暴露给 AI agent(MCP-001)。

pub mod explain;
pub mod kb;
pub mod server;

pub use kb::{AssetKnowledge, ParsedDef};
pub use server::{run_stdio, KodeMcpServer};
