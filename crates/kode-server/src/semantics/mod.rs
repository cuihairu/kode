//! KBEngine 共同语义模型(KSEM-BAS,设计
//! docs/design/kbengine-semantic-precision-and-process-flow.md §4)。
//!
//! 落地位置=现有 crate 边界内(kode-server,已依赖 kode-types/kode-index/
//! kode-parser/kode-python,不另起解析器)。Rust 负责语义事实与查询,
//! TS 负责文档/工作区输入、交互与呈现(消费边界见 [`query`])。
//!
//! 模块与 todo.md 原子任务对应:
//! - [`id`] BAS-03 语义身份(工程/资源根/实体/角色/组件/声明稳定 ID,
//!   同名跨工程与 Base/Cell 不串联);
//! - [`types`] BAS-04 结构类型表达式(标量/范围/别名/数组/固定字典/组件/
//!   实体引用/可空/联合/未知;字段名/声明序/源码位置保留);
//! - [`snapshot`] BAS-05 有效实体声明快照(Parent/Interfaces/组件展开,
//!   覆盖与冲突记录;缺失/环/多候选不任取一个);
//! - [`facts`] BAS-06 事实与诊断证据(声明事实/代码推导/未知/冲突 +
//!   来源路径;未知不自动转错误);
//! - [`expr`] BAS-07 Python 表达式来源(Ruff AST 属性/下标/调用/局部赋值;
//!   别名重绑定失效;同行按列序);**在途门控**(见下);
//! - [`store`] BAS-08 带版本查询快照(文档 overlay + 工程代数;过期构建
//!   不覆盖新版本;删除/重开清理事实);
//! - [`deps`] BAS-09 增量依赖边(def/types/Python/config → 消费文件反向
//!   依赖;单文件变更只失效相关项);
//! - [`query`] BAS-10 共享查询契约(Rust 事实查询与 TS/LSP 消费边界;
//!   同一结构供 hover/completion/definition/diagnostics;缺服务降级)。

pub mod deps;
// pub mod expr; // BAS-07 在途:AST 变体名/生命周期未对齐 ruff 0.0.20,
// 编译不通过(32 错),门控至 BAS-07 批次修复接线;文件保留勿删。
pub mod facts;
pub mod id;
pub mod query;
pub mod snapshot;
pub mod store;
pub mod types;

pub use id::{Facet, SemId, SemKind};
pub use types::{FieldDef, SemType};
