//! kode-server 库入口:分派状态机供 bin 与集成测试共用(bin 只是 stdio 泵)。

pub mod server;

pub use server::{
    cancel_target, handle_message, handle_message_with_poll, CancelRegistry, Document, Outgoing,
    ServerState, SERVER_NAME,
};
