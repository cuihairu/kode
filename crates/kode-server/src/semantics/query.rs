//! BAS-10 共享查询契约(骨架;接线在对应批次)。
//!
//! 目标(todo.md KSEM-BAS-10):明确 Rust 事实查询与 TS/LSP 消费边界;
//! 同一结构供 hover/completion/definition/diagnostics 使用,缺服务可降级。
//! 本文件目前只占模块位,保证 [`crate::semantics`] 模块树可编译;
//! 实现批次落地时替换。
