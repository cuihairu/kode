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
//!   别名重绑定失效;同行按列序);
//! - [`store`] BAS-08 带版本查询快照(文档 overlay + 工程代数;过期构建
//!   不覆盖新版本;删除/重开清理事实;工程视图 = fold 确定性折叠);
//!   [`ProjectDefResolver`] 为工程级 def 解析(文件名字根 = 类型名);
//! - [`deps`] BAS-09 增量依赖边(def/types/Python/config → 消费文件反向
//!   依赖;单文件变更只失效相关项;级联失效有界 BFS,删除对称清理);
//! - [`query`] BAS-10 共享查询契约(Rust 事实查询与 TS/LSP 消费边界;
//!   同一结构供 hover/completion/definition/diagnostics;缺服务降级)。
//! - [`cell`] CELL-01/02 cellData 字段集与引擎内建键(有效 Cell 属性表,
//!   继承/接口展开复用 BAS-05;缺 Cell 脚本/无 Cell 部件分状态;内建键
//!   position/direction 独立引擎来源封闭表;组件槽展开归 CELL-03)。
//! - [`refs`] RPC-01..03 角色化引用类型/self 角色绑定/引用别名传播(
//!   EntityCall<类,调用类型> 与本地 Entity 区分;七种调用类型的目标面表
//!   归属/自名闸/面跳全矩阵;ENTITYCALL 字段取值接受=EntityCall/None/Entity
//!   按源码;类未知保持未知不猜;`bind_self_role` 逐面逐属性绑定
//!   self.base/cell/client——cellapp 的 self.client=CLIENT_VIA_BASE 陷阱钉死,
//!   转发链=绑定+面跳复合;`AliasTable` 别名传播——重绑定即遮蔽不回落旧引用、
//!   合流异值成候选不任取、未知不按同名方法猜;方法/组件槽落点归 RPC-04)。

pub mod cell;
pub mod refs;
pub mod deps;
pub mod expr;
pub mod facts;
pub mod id;
pub mod query;
pub mod snapshot;
pub mod store;
pub mod types;

pub use id::{Facet, SemId, SemKind};
pub use types::{FieldDef, SemType};
