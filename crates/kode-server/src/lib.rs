//! kode-server 库入口:分派状态机与 hover 响应链供 bin 与集成测试共用
//! (bin 只是 stdio 泵)。

pub mod hover;
pub mod server;

pub use hover::{dump_hover_golden, render_markdown, HoverEngine, HoverResponse};
pub use server::{
    cancel_target, handle_message, handle_message_with_poll, CancelRegistry, Outgoing, ServerState,
    SERVER_NAME,
};
