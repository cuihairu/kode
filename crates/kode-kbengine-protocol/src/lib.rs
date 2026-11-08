//! kode2 KBEngine 协议引擎(todo PA-003 Phase 2)。
//!
//! 完全脱离 Wireshark 的 KBEngine 协议解析库;MVP = Client↔Server。
//! 模块边界(验收原文):
//! - `cursor`:零拷贝边界检查读取(引擎字符串语义逐条对齐,PA-001 §3.1);
//! - `framing`:三种长度形状 + TCP 粘包/拆包(packet_reader.cpp:31-250 状态机);
//! - `messages`:message ID 静态段 + 动态导入段(onImportClientMessages,§5.2);
//! - `codec`:基础类型 + ARRAY/FIXED_DICT containers;
//! - `entity`:实体方法载荷解码(属性同步流 TODO-3 未取证 → Raw 保留不编造);
//! - `session`:每 Flow(loginapp/baseapp)独立表 + 握手阶段观察;
//! - `cache`:schema hash → 编译产物缓存。
//!
//! 红线(验收原文,全部有测试):失败不 panic / 不越界 / 内存有上限
//! ([`codec::DecodeLimits`] + `FramingConfig::max_message_len`)/ 递归类型有界
//! (深度上限)/ 未知类型 Raw 保留。
//!
//! 取证依据:docs/kbengine-wire-protocol.md(PA-001,引擎基准 bf1a9cd6 / v2.5.10)。

pub mod cache;
pub mod codec;
pub mod cursor;
pub mod entity;
pub mod error;
pub mod framing;
pub mod messages;
pub mod session;

pub use codec::{decode_spans, DecodeLimits, SpanKind, ValueSpan};
pub use error::{DecodeError, DecodeErrorKind};
pub use framing::{Frame, FrameParser, FramingConfig, LengthSpec};
pub use messages::{ImportSummary, MessageMap, MessageSpec};
pub use session::{ComponentRole, DecodedMessage, Direction, Flow, Phase, Session};
