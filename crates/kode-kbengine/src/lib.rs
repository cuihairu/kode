//! kode2 KBEngine CLI(todo PA-004 Phase 3;bin `kode-kbengine`)。
//!
//! 验收原文:`schema validate/build/diff/inspect、decode --hex、capture
//! analyze(支持 stdin pcap 流式);PCAP 输入层先复用 TShark 成熟能力`。
//!
//! 模块边界:
//! - [`cli`]:手写参数解析(零 clap,仓库第三方面不扩大);
//! - [`records`]:解码记录 + 异常记录(解局面 → 分析面的唯一数据形状,
//!   PA-005 分析引擎消费同一形状的 JSON);
//! - [`tshark`]:PCAP 输入层(复用 TShark;stdin 流式喂 pcap 字节);
//! - `commands`:子命令实现。
//!
//! 解析引擎 = kode-kbengine-protocol(PA-003 session,每 Flow 独立消息表 +
//! 握手/动态导入副作用);schema 面 = kode-kbengine-schema(PA-002 IR)。

pub mod cli;
pub mod commands;
pub mod records;
pub mod tshark;

pub use cli::{parse_args, Args, Command, Parsed, USAGE};
pub use records::{Anomaly, Record};
