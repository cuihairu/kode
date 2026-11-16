//! kode-server 库入口:分派状态机、hover 响应链、completion 请求链与
//! Phase2 定义/诊断面供 bin 与集成测试共用(bin 只是 stdio 泵)。

pub mod api_docs;
pub mod attribute_none;
pub mod client_sdk;
pub mod completion;
pub mod config_rpc;
pub mod database_schema;
pub mod db_clone;
pub mod def_md5;
pub mod definition;
pub mod document_symbols;
pub mod dependency_graph;
pub mod diagnostics;
pub mod executor;
pub mod flag_domains;
pub(crate) mod golden_corpus;
pub mod hover;
pub mod index_queue;
pub mod lint;
pub mod local_return;
pub mod message_table;
pub mod post_destroy;
pub mod process_topology;
pub mod property_direction;
pub mod python_call_at;
pub mod python_callgraph;
pub mod python_lexical_mask;
pub mod python_process;
pub mod readonly_write;
pub mod receiver_none;
pub mod references;
pub mod return_annotations;
pub mod role_misuse;
pub mod root_lifecycle;
pub mod rpc;
pub mod rpc_arg_count;
pub mod ruff_lint;
pub mod self_attribute_flow;
pub mod semantics;
pub mod semantics_golden;
pub mod semantics_rpc;
pub mod server;
pub mod space_nav;
pub mod trap_lints;
pub mod user_type_contract;
pub mod warm_gate;
pub mod wire_codec;
pub mod workspace_discovery;

pub use completion::{
    dump_completion_golden, resolve_item, to_lsp_items, CompletionContextFace, CompletionItemFace,
    CompletionResponse,
};
pub use definition::{dump_definition_golden, DefinitionLocation, LspPosition, LspRange};
pub use document_symbols::{dump_document_symbols_golden, DocumentSymbolFace};
pub use python_call_at::dump_python_call_at_golden;
pub use references::dump_references_golden;
pub use diagnostics::{
    dump_diagnostics_golden, DiagnosticFace, SEVERITY_ERROR, SEVERITY_INFORMATION, SEVERITY_WARNING,
};
pub use flag_domains::{dump_flag_domains_golden, CANONICAL, GOLDEN_REL_PATH};
pub use hover::{dump_hover_golden, render_markdown, HoverEngine, HoverFace, HoverResponse};
pub use server::{
    cancel_target, handle_message, handle_message_with_poll, CancelRegistry, Outgoing, ServerState,
    SERVER_NAME,
};
