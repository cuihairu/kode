//! kode2 KBEngine schema engine(todo PA-002 Phase 1)。
//!
//! 从真实 KBEngine 项目生成完整协议 Schema:项目资产(scripts/entities.xml +
//! entity_defs/**/*.def + types.xml/alias.xml)+ 引擎固定消息表
//! (messages_fixed_defaults.xml + 项目 messages_fixed.xml)→
//! [`Schema`](schema::Schema) IR(canonical JSON + SHA-256 摘要 + 版本兼容检查)。
//!
//! 设计边界(验收原文):
//! - 「Wire Type Layout 独立于现有类型图」:`wire`/`layout` 自带求值,
//!   不消费 `kode_types::graph`(类型图 = 脚本语义;本 crate = 网络序列化规则,
//!   取证依据 docs/kbengine-wire-protocol.md,PA-001)。
//! - 复用 kode-parser(xml/model)/kode-types(builtin 分类)/kode-vfs(磁盘读缓存)。
//! - 未知类型不猜测:落 `WireType::Unresolved`,解码端 Raw 保留。
//!
//! 线上完整消息表的三段模型(静态默认 + 项目覆盖 + 登录动态导入):本 crate
//! 承载前两段;动态导入(§5.2 onImportClientMessages)由 kode-kbengine-protocol
//! (PA-003)在流上解析。

pub mod builder;
pub mod compat;
pub mod layout;
pub mod messages;
pub mod schema;
pub mod wire;

pub use builder::{build_schema_from_project, BuildError, BuildOptions};
pub use compat::{check, Change, CompatReport};
pub use messages::{MessageEntry, MessageLength, MessageTable};
pub use schema::{EntityMethodWire, EntityPropertyWire, EntityWireInfo, Schema};
pub use wire::{DictField, WireType};
