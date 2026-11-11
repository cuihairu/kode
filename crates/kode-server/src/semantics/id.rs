//! BAS-03 语义身份。
//!
//! 稳定身份 = 资源根 × 种类 × 名字 × 分面,四元组结构相等:
//! - 同名跨工程(不同资源根)→ 不相等(隔离);
//! - 同一实体 Base 方法面与 Cell 方法面 → 不相等(角色不串联);
//! - 同一工程内同名不同 kind(实体/类型/别名)→ 不相等。
//!
//! 资源根复用 [`kode_vfs::store::RootId`](kode_vfs::RootId)(workspace 根
//! 的身份,由 vfs 分配),不另造工程身份。运行实例与静态声明的区分不在
//! 本 ID(静态声明),见 [`Facet`] 与 snapshot 的运行实例标注。

use kode_vfs::store::RootId;

/// 语义声明种类。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SemKind {
    Entity,
    Property,
    Method,
    Type,
    Alias,
    Component,
}

impl SemKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            SemKind::Entity => "entity",
            SemKind::Property => "property",
            SemKind::Method => "method",
            SemKind::Type => "type",
            SemKind::Alias => "alias",
            SemKind::Component => "component",
        }
    }
}

/// 角色分面(方法表归属;实体属性/类型无分面 = None)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Facet {
    Base,
    Cell,
    Client,
}

impl Facet {
    pub fn as_str(&self) -> &'static str {
        match self {
            Facet::Base => "base",
            Facet::Cell => "cell",
            Facet::Client => "client",
        }
    }
}

/// 稳定语义 ID(四元组;结构相等即身份相等)。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SemId {
    pub root: RootId,
    pub kind: SemKind,
    pub name: String,
    /// None = 无分面(实体/类型/别名);Some = Base/Cell/Client 方法面。
    pub facet: Option<Facet>,
}

impl SemId {
    pub fn new(root: RootId, kind: SemKind, name: impl Into<String>, facet: Option<Facet>) -> Self {
        Self { root, kind, name: name.into(), facet }
    }

    pub fn entity(root: RootId, name: impl Into<String>) -> Self {
        Self::new(root, SemKind::Entity, name, None)
    }

    pub fn method(root: RootId, name: impl Into<String>, facet: Facet) -> Self {
        Self::new(root, SemKind::Method, name, Some(facet))
    }

    /// 人类可读描述(诊断/证据用;非身份键)。
    pub fn display(&self) -> String {
        match self.facet {
            Some(f) => format!("{}/{}.{}", self.kind.as_str(), f.as_str(), self.name),
            None => format!("{}/{}", self.kind.as_str(), self.name),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kode_vfs::store::{DocumentKey, RootId};

    fn root(n: u32) -> RootId {
        RootId(n)
    }

    #[test]
    fn same_name_cross_root_not_equal() {
        let a = SemId::entity(root(1), "Avatar");
        let b = SemId::entity(root(2), "Avatar");
        assert_ne!(a, b, "同名跨工程必须不串联(BAS-03)");
    }

    #[test]
    fn base_cell_not_equal() {
        let r = root(1);
        let base = SemId::method(r, "teleport", Facet::Base);
        let cell = SemId::method(r, "teleport", Facet::Cell);
        assert_ne!(base, cell, "Base/Cell 同名方法必须不串联(BAS-03)");
    }

    #[test]
    fn kind_isolation() {
        let r = root(1);
        assert_ne!(SemId::entity(r, "Foo"), SemId::new(r, SemKind::Type, "Foo", None));
        assert_ne!(SemId::entity(r, "Foo"), SemId::new(r, SemKind::Alias, "Foo", None));
    }

    #[test]
    fn same_signature_equals() {
        let r = root(7);
        assert_eq!(SemId::method(r, "tick", Facet::Cell), SemId::method(r, "tick", Facet::Cell));
    }

    #[test]
    fn root_id_compatible_with_vfs_key() {
        // RootId 来自 kode_vfs,DocumentKey 含 root——同身份面可比较。
        let r = RootId(3);
        let uri = kode_vfs::uri::CanonicalUri::from_path("defs/avatar.def");
        let _k = DocumentKey::new(r, uri);
        let id = SemId::entity(r, "Avatar");
        assert_eq!(id.kind, SemKind::Entity);
    }
}
