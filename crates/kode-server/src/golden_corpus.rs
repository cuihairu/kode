//! 对拍 golden 语料的根注册(KBUG-ROOT)。
//!
//! 缺陷:golden 生成器曾把全部语料文件统一按 [`RootId::UNROOTED`] 入库,
//! 四个语料工程(各自是独立 fixture 项目)的同名实体在引擎视图里混成
//! 一个根,首见借用跨工程串路径。生产语义是每工作区根隔离(VFS-009),
//! 这里按同口径把 `PARITY_CORPORA` 每个语料工程注册为独立资源根,
//! 入库/查询键 = 各自工程根。

use kode_vfs::store::{DocumentKey, RootRegistry};

/// 注册全部对播音料工程;注册顺序 = [`kode_parser::json::PARITY_CORPORA`] 顺序。
pub(crate) fn corpus_registry() -> RootRegistry {
    let mut registry = RootRegistry::new();
    for corpus in kode_parser::json::PARITY_CORPORA {
        registry.register(corpus);
    }
    registry
}

/// 语料文件的入库/查询键:根 = 文件所属语料工程(最长前缀归属)。
pub(crate) fn corpus_key(registry: &RootRegistry, rel_path: &str) -> DocumentKey {
    let uri = kode_vfs::uri::CanonicalUri::from_path(rel_path);
    DocumentKey::new(registry.root_for(&uri), uri)
}
