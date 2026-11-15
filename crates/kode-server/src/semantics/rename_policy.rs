//! KSEM-RENAME(RUST-114,旧 SEM-012)symbol 名称重命名策略(纯库面,
//! 无 RPC/无 TS 消费;编辑执行面归 defRenamer(TS)与 RUST-131/131-W
//! 清理链接线,本面只做策略判定)。
//!
//! 三分归属([`classify_symbol_owner`]):
//! - [`SymbolOwner::EngineBuiltin`]:名称命中 [`super::engine_meta`]
//!   (RUST-113)任一类别(或指定类别)——引擎 API/回调/内建对象/常量
//!   名是引擎调用/注册点固定契约(**不可直接改**;用户实现与引擎耦合,
//!   改名须连引擎契约面,锚点出处随 detail 携带);
//! - [`SymbolOwner::Generated`]:路径落在托管生成物 `<managed_dir>/stubs/`
//!   下(TS managedDir 口径,目录名消费方供给默认 `.kbengine`)——生成物
//!   直接改会被下次生成覆盖(**不可直接改**,零覆盖铁律;变更走
//!   `kbengine.python.resetStubs` 显式命令或生成源),且路径判定优先于
//!   引擎元数据命中(生成物里的内建名同样是生成物);
//! - [`SymbolOwner::UserCode`]:assets 语料(doclass [`DocClass`] 同口径:
//!   Python 实体/组件脚本、def 三池、entities.xml 等已知 XML)——**可改**,走重命名闭包
//!   (冲突预检见下);
//! - 查无归类 = [`SymbolOwner::Unknown`](诚实不猜)。
//!
//! 冲突预检([`conflict_precheck`]):同名类别空间复用 RUST-111
//! [`super::roots::MultiRootRegistry`] 消解面——新名同 kind 已有登记即冲突
//! (winner+shadowed 全携带);跨 kind 同名不冲突(roots 类别隔离同口径);
//! 旧名未登记 = 事实照报不 deny(消费方裁量);old==new = no-op 旗标。
//! def 成员级(同段方法/属性段/组件域/继承闭包)冲突已由 TS defRenamer
//! (IDE-NAV-008/IDE-AUD-061)覆盖,本面不重复建模。

use kode_vfs::DocumentKey;

use super::doclass::{classify_document, DocClass};
use super::engine_meta::{EngineMetaLayer, MetaCategory};
use super::roots::{NameKind, RootEntry};

/// 重命名目标归属(策略三分 + 诚实未知)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SymbolOwner {
    UserCode,
    EngineBuiltin,
    Generated,
    Unknown,
}

/// 归类依据(provenance;锚点出处随 detail)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OwnerSource {
    /// 引擎元数据命中(RUST-113 seed 或外部覆盖)。
    EngineMeta,
    /// 托管生成物路径(`<managed_dir>/stubs/`)。
    GeneratedPath,
    /// assets 脚本/def/语料布局。
    AssetLayout,
    None,
}

/// 归类结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnerClassification {
    pub owner: SymbolOwner,
    pub source: OwnerSource,
    /// 命中细节(引擎锚点出处/生成物路径依据);Unknown 时为 None。
    pub detail: Option<String>,
}

/// symbol 归属归类。判定序:生成物路径 → 引擎元数据 → assets 布局 →
/// Unknown。`category` = None 时扫全部四类别(任一命中即内建);
/// `version` 透传引擎元层(未声明版本不猜,RUST-113 同口径)。
pub fn classify_symbol_owner(
    meta: &EngineMetaLayer,
    path: &str,
    name: &str,
    category: Option<MetaCategory>,
    version: Option<&str>,
    managed_dir: &str,
) -> OwnerClassification {
    if is_generated_path(path, managed_dir) {
        return OwnerClassification {
            owner: SymbolOwner::Generated,
            source: OwnerSource::GeneratedPath,
            detail: Some(format!("托管生成物路径:{path}")),
        };
    }
    let hit = match category {
        Some(c) => meta.resolve(c, name, version),
        None => ALL_CATEGORIES
            .into_iter()
            .find_map(|c| meta.resolve(c, name, version)),
    };
    if let Some(r) = hit {
        return OwnerClassification {
            owner: SymbolOwner::EngineBuiltin,
            source: OwnerSource::EngineMeta,
            detail: Some(format!(
                "引擎契约锚 {}(category={})",
                r.entry.source,
                r.entry.category.as_str()
            )),
        };
    }
    if is_asset_layout(path) {
        return OwnerClassification {
            owner: SymbolOwner::UserCode,
            source: OwnerSource::AssetLayout,
            detail: None,
        };
    }
    OwnerClassification {
        owner: SymbolOwner::Unknown,
        source: OwnerSource::None,
        detail: None,
    }
}

/// 全类别确定性扫描序(枚举声明序)。
const ALL_CATEGORIES: [MetaCategory; 4] = [
    MetaCategory::Api,
    MetaCategory::Callback,
    MetaCategory::BuiltinObject,
    MetaCategory::Constant,
];

/// 托管生成物路径判定:路径含 `<managed_dir>/stubs/` 段(段级匹配防前缀
/// 误伤;managed_dir 名消费方供给,默认 `.kbengine`)。
fn is_generated_path(path: &str, managed_dir: &str) -> bool {
    let dir = managed_dir.trim_matches('/');
    if dir.is_empty() {
        return false;
    }
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    let dir_segs: Vec<&str> = dir.split('/').filter(|s| !s.is_empty()).collect();
    if segments.len() <= dir_segs.len() {
        return false;
    }
    let n = dir_segs.len();
    for i in 0..=(segments.len() - n - 1) {
        if segments[i..i + n] == dir_segs[..] && segments[i + n] == "stubs" {
            return true;
        }
    }
    false
}

/// assets 布局判定(doclass 单一真源同口径:Python 实体/组件脚本、def
/// 三池、已知语料 XML;非布局 py 不算用户代码)。
fn is_asset_layout(path: &str) -> bool {
    let key = DocumentKey::new(
        kode_vfs::store::RootId(1),
        kode_vfs::uri::CanonicalUri::from_path(path),
    );
    !matches!(classify_document(&key), DocClass::Other)
}

/// 旧名登记态(事实,不 deny)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OldNameStatus {
    /// 旧名在册(winner 携带)。
    Registered(RootEntry),
    /// 旧名未登记(诚实事实;消费方裁量是否继续)。
    NotRegistered,
}

/// 冲突预检报告。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConflictReport {
    /// old==new(本名重命名,no-op)。
    pub noop: bool,
    pub old_status: OldNameStatus,
    /// 新名同 kind 占用事实(winner+shadowed 全携带;空 = 无冲突)。
    pub conflicts: Vec<RootEntry>,
}

/// 重命名冲突预检(同名类别空间;跨 kind 同名不冲突 = roots 类别隔离
/// 同口径)。`registry` = 消费方喂的名称登记面(RUST-111)。
pub fn conflict_precheck(
    registry: &super::roots::MultiRootRegistry,
    kind: NameKind,
    old_name: &str,
    new_name: &str,
) -> ConflictReport {
    let noop = old_name == new_name;
    let old_status = match registry.resolve(kind, old_name).winner {
        Some(w) => OldNameStatus::Registered(w),
        None => OldNameStatus::NotRegistered,
    };
    let resolution = registry.resolve(kind, new_name);
    let mut conflicts = Vec::new();
    if !noop {
        if let Some(winner) = resolution.winner {
            conflicts.push(winner);
        }
    }
    conflicts.extend(resolution.shadowed);
    ConflictReport {
        noop,
        old_status,
        conflicts,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::semantics::engine_meta::OverrideSet;
    use crate::semantics::roots::MultiRootRegistry;

    #[test]
    fn engine_builtin_classified_with_anchor_detail() {
        let meta = EngineMetaLayer::new();
        for (name, cat) in [
            ("createEntity", Some(MetaCategory::Api)),
            ("onTimer", Some(MetaCategory::Callback)),
            ("KBEngine.Entity", Some(MetaCategory::BuiltinObject)),
            ("KBEngine.component", Some(MetaCategory::Constant)),
        ] {
            let c = classify_symbol_owner(
                &meta,
                "/proj/scripts/base/Avatar.py",
                name,
                cat,
                None,
                ".kbengine",
            );
            assert_eq!(c.owner, SymbolOwner::EngineBuiltin, "{name}");
            assert_eq!(c.source, OwnerSource::EngineMeta);
            let d = c.detail.expect("锚点 detail");
            assert!(d.contains("引擎契约锚"), "{d}");
        }
    }

    #[test]
    fn category_none_scans_all_categories() {
        let meta = EngineMetaLayer::new();
        let c = classify_symbol_owner(
            &meta,
            "/proj/scripts/Avatar.py",
            "onGetCell",
            None,
            None,
            ".kbengine",
        );
        assert_eq!(c.owner, SymbolOwner::EngineBuiltin);
        assert!(c.detail.unwrap().contains("category=callback"));
    }

    #[test]
    fn generated_path_takes_precedence_over_builtin_name() {
        let meta = EngineMetaLayer::new();
        let c = classify_symbol_owner(
            &meta,
            "/proj/.kbengine/stubs/KBEngine.pyi",
            "createEntity",
            None,
            None,
            ".kbengine",
        );
        assert_eq!(c.owner, SymbolOwner::Generated, "生成物路径优先于内建名");
        assert_eq!(c.source, OwnerSource::GeneratedPath);
        // 嵌套 managed_dir 与自定义目录名(段级匹配)。
        let nested = classify_symbol_owner(
            &meta,
            "/ws/.kbengine/stubs/x/Entity.pyi",
            "Entity",
            None,
            None,
            ".kbengine",
        );
        assert_eq!(nested.owner, SymbolOwner::Generated);
        let custom = classify_symbol_owner(
            &meta,
            "/proj/kbengine-meta/stubs/KBEngine.pyi",
            "createEntity",
            None,
            None,
            "kbengine-meta",
        );
        assert_eq!(custom.owner, SymbolOwner::Generated);
        // 伪前缀不误伤(段级)。
        let fake = classify_symbol_owner(
            &meta,
            "/proj/notkbengine/stubs/KBEngine.pyi",
            "createEntity",
            None,
            None,
            ".kbengine",
        );
        assert_ne!(fake.owner, SymbolOwner::Generated);
    }

    #[test]
    fn user_code_classified_by_asset_layout() {
        let meta = EngineMetaLayer::new();
        for path in [
            "/proj/scripts/Avatar.py",
            "/proj/scripts/cell/Monster.py",
            "/proj/scripts/entity_defs/Avatar.def",
            "/proj/scripts/entity_defs/interfaces/HasHP.def",
            "/proj/scripts/entities.xml",
        ] {
            let c = classify_symbol_owner(&meta, path, "Avatar", None, None, ".kbengine");
            assert_eq!(c.owner, SymbolOwner::UserCode, "{path}");
            assert_eq!(c.source, OwnerSource::AssetLayout);
        }
        // 组件脚本 layout(app 侧 components)也算用户代码。
        let comp = classify_symbol_owner(
            &meta,
            "/proj/scripts/base/components/Bag.py",
            "Bag",
            None,
            None,
            ".kbengine",
        );
        assert_eq!(comp.owner, SymbolOwner::UserCode);
    }

    #[test]
    fn unknown_path_and_name_stay_unknown() {
        let meta = EngineMetaLayer::new();
        let c = classify_symbol_owner(
            &meta,
            "/proj/notes/readme.txt",
            "Foo",
            None,
            None,
            ".kbengine",
        );
        assert_eq!(c.owner, SymbolOwner::Unknown);
        assert_eq!(c.source, OwnerSource::None);
        assert!(c.detail.is_none());
        // 非实体布局的 py 也不产 UserCode(诚实)。
        let plain =
            classify_symbol_owner(&meta, "/proj/tools/gen.py", "Foo", None, None, ".kbengine");
        assert_eq!(plain.owner, SymbolOwner::Unknown);
    }

    #[test]
    fn override_hit_counts_as_builtin() {
        let mut meta = EngineMetaLayer::new();
        meta.add_override(OverrideSet {
            versions: vec![],
            entries: vec![crate::semantics::engine_meta::MetaEntry::new(
                "forkOnlyApi",
                crate::semantics::engine_meta::MetaCategory::Api,
                &["baseapp"],
                "fork/extra.cpp:7",
                None,
            )],
        });
        let c = classify_symbol_owner(
            &meta,
            "/proj/scripts/Avatar.py",
            "forkOnlyApi",
            None,
            Some("9.9.9"),
            ".kbengine",
        );
        assert_eq!(c.owner, SymbolOwner::EngineBuiltin);
        assert!(c.detail.unwrap().contains("fork/extra.cpp:7"));
    }

    fn registry() -> MultiRootRegistry {
        let mut reg = MultiRootRegistry::default();
        reg.add_root("root-a");
        reg.add_root("root-b");
        reg.register(
            "root-a",
            NameKind::Entity,
            "Monster",
            "a/Monster.def",
            Some(3),
        );
        reg.register(
            "root-b",
            NameKind::Entity,
            "Monster",
            "b/Monster.def",
            Some(1),
        );
        reg.register("root-a", NameKind::Entity, "Solo", "a/Solo.def", None);
        reg.register("root-a", NameKind::Type, "Monster", "a/types.xml", None);
        reg
    }

    #[test]
    fn conflict_precheck_reports_same_kind_holder_and_shadowed() {
        let reg = registry();
        let r = conflict_precheck(&reg, NameKind::Entity, "Solo", "Monster");
        assert!(!r.noop);
        assert_eq!(
            r.old_status,
            OldNameStatus::Registered(RootEntry {
                root: "root-a".into(),
                kind: NameKind::Entity,
                name: "Solo".into(),
                file: "a/Solo.def".into(),
                line: None,
            })
        );
        assert_eq!(r.conflicts.len(), 2, "winner + shadowed 全携带");
        assert_eq!(r.conflicts[0].root, "root-a", "显式序 winner 在首");
        assert_eq!(r.conflicts[0].line, Some(3));
        assert_eq!(r.conflicts[1].root, "root-b");
    }

    #[test]
    fn conflict_precheck_clean_and_noop_and_old_missing() {
        let reg = registry();
        let clean = conflict_precheck(&reg, NameKind::Entity, "Solo", "Ghost");
        assert!(clean.conflicts.is_empty());
        assert_eq!(
            clean.old_status,
            OldNameStatus::Registered(RootEntry {
                root: "root-a".into(),
                kind: NameKind::Entity,
                name: "Solo".into(),
                file: "a/Solo.def".into(),
                line: None,
            })
        );
        let noop = conflict_precheck(&reg, NameKind::Entity, "Solo", "Solo");
        assert!(noop.noop);
        assert!(
            noop.conflicts.is_empty(),
            "本名重命名不与自身判冲突(noop 旗标)"
        );
        let missing = conflict_precheck(&reg, NameKind::Entity, "Ghost", "Other");
        assert_eq!(missing.old_status, OldNameStatus::NotRegistered);
    }

    #[test]
    fn cross_kind_same_name_no_conflict() {
        let reg = registry();
        // Type kind 已占 "Monster",但 Entity kind 改名到 "Monster" 的冲突
        // 判定只看 Entity kind(类别隔离)。
        let r = conflict_precheck(&reg, NameKind::Entity, "Solo", "Monster");
        let entity_roots: Vec<&str> = r.conflicts.iter().map(|e| e.root.as_str()).collect();
        assert_eq!(entity_roots, ["root-a", "root-b"], "只含 Entity kind 命中");
        let t = conflict_precheck(&reg, NameKind::Type, "ITEM", "Monster");
        assert_eq!(t.conflicts.len(), 1, "Type kind 只见自己的命中");
        assert_eq!(t.conflicts[0].root, "root-a");
    }
}
