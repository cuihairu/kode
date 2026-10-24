//! kode2 PR-008 —— KBEngine 类型图 IR(书 §6.2 SEM-002/004/005/013 基础版)。
//!
//! 四类输入(types.xml / alias.xml / *.def / entities.xml,由 kode-parser 解析)
//! 归一成一张有向类型图:
//! - 节点 [`TypeNode`]:别名(重定向)、数组、FixedDict、用户类型(实体);
//!   引擎内建标量不建节点,只作引用终点(见 [`builtin`])。变体集与 SEM-002
//!   的 IR 清单(Builtin/Alias/Array/FixedDict/UserType/EntityRef/Component/
//!   Unknown/Error)对齐:Builtin 以引用终点表示,EntityRef/Component 为边种
//!   (见 [`EdgeKind`]),Unknown/Error 以 [`TypeClass::Unknown`] + 理由保留
//!   (SEM-013,不借用任意类型掩盖缺失)。
//! - 边 [`TypeEdge`]:别名指向 / 数组元素 / FixedDict 字段 / 属性类型引用 /
//!   组件归属 / 实体继承。
//! - 链求值:[`TypeGraph::resolve_alias_chain`](SEM-004 别名链+循环诊断)、
//!   [`TypeGraph::resolve_inheritance`](实体继承链)——环显式诊断、有限截断,
//!   绝不死循环(与 IDX-005 同一保障)。
//! - 全图环检测:[`TypeGraph::find_cycles`] 对全部命名边做迭代式三色 DFS,
//!   每个回边报告一条环路径。
//!
//! 对拍 golden(只写不读)在 [`golden`]:TS 侧 `tests/kodeTypesParity.test.ts`
//! 用现有 defParser/compositionRoots 原语复算同一语料,双向门禁与 PR-005/007
//! 同构。fixture 驱动,按 ARCH-012 不做性能对比。

pub mod builtin;
pub mod golden;
pub mod graph;

pub use builtin::{is_builtin, is_container_directive, is_known_terminal, BUILTIN_TYPES};
pub use graph::{ChainStatus, EdgeKind, TypeClass, TypeEdge, TypeGraph, TypeId, TypeNode};
