//! kode-index:符号索引(kode2 PR-007,书 §7 IDX 基础版/§17 PR-007)。
//!
//! 模块:
//! - [`symbol`]:六类符号模型(实体/属性/方法/类型/别名/组件)+ 纯函数抽取;
//! - [`index`]:[`SymbolIndex`] 名称倒排 + 文件级增量(指纹零重建)+ 原子
//!   generation + 删除/根级失效清理 + 继承链环终止;
//! - [`golden`]:与 TS symbolIndex 能力面对拍 golden 序列化(fixture 驱动,
//!   非 ARCH-012 性能对比)。
//!
//! 铁律:零第三方 crate(仅依赖 workspace 内 kode-parser/kode-vfs)。

pub mod golden;
pub mod index;
pub mod symbol;

pub use index::{BatchReceipt, IndexStats, IndexUpdateReport, SymbolIndex};
pub use symbol::{
    def_entity_name, extract_records, MethodFacet, Symbol, SymbolId, SymbolKind, SymbolRecord,
};

pub use kode_parser::diag::Diagnostic;
pub use kode_parser::model::ChainNode;
pub use kode_vfs::store::{DocumentKey, RootId};
