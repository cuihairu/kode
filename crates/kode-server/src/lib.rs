//! kode-server 库入口:分派状态机、hover 响应链、completion 请求链与
//! Phase2 定义/诊断面供 bin 与集成测试共用(bin 只是 stdio 泵)。

pub mod completion;
pub mod definition;
pub mod diagnostics;
pub mod flag_domains;
pub mod hover;
pub mod server;

pub use completion::{
    dump_completion_golden, to_lsp_items, CompletionContextFace, CompletionItemFace,
    CompletionResponse,
};
pub use definition::{dump_definition_golden, DefinitionLocation, LspPosition, LspRange};
pub use diagnostics::{
    dump_diagnostics_golden, DiagnosticFace, SEVERITY_ERROR, SEVERITY_INFORMATION, SEVERITY_WARNING,
};
pub use flag_domains::{dump_flag_domains_golden, CANONICAL, GOLDEN_REL_PATH};
pub use hover::{dump_hover_golden, render_markdown, HoverEngine, HoverFace, HoverResponse};
pub use server::{
    cancel_target, handle_message, handle_message_with_poll, CancelRegistry, Outgoing, ServerState,
    SERVER_NAME,
};
