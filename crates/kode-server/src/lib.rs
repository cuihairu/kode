//! kode-server 库入口:分派状态机、hover 响应链与 completion 请求链供 bin 与
//! 集成测试共用(bin 只是 stdio 泵)。

pub mod completion;
pub mod hover;
pub mod server;

pub use completion::{
    dump_completion_golden, to_lsp_items, CompletionContextFace, CompletionItemFace,
    CompletionResponse,
};
pub use hover::{dump_hover_golden, render_markdown, HoverEngine, HoverResponse};
pub use server::{
    cancel_target, handle_message, handle_message_with_poll, CancelRegistry, Outgoing, ServerState,
    SERVER_NAME,
};
