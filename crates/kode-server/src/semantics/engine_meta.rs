//! KSEM-EMETA(RUST-113,旧 SEM-011)引擎关键 API/回调/内建对象/常量
//! 版本化 metadata layer(纯库面,无 RPC/无 TS 消费)。
//!
//! 四类 seed 表([`seed_entries`]):关键 API(模块级方法)/实体回调/内建对象
//! (脚本类)/常量,逐条携带进程面(引擎组件名)与引擎出处(文件:行)。
//! 锚点全部实证于本地引擎树(2.5.10,kbe/src/lib/common/kbeversion.h);
//! 完整成员普查归 pyi 静态模板车道(docs/design/kbengine-pyi-compiled-module-plan.md,
//! 定稿=typings 静态模板),本表为**代表性登记非全量**。
//!
//! 版本层语义:
//! - 版本串 = 项目声明口径(TS `kbengine.engineVersion` 设置,Rust 侧不猜
//!   默认——未声明 = `None`);
//! - 版本匹配 = **精确字符串**(引擎/fork 版本串任意定义,不做 semver 推测;
//!   PRESETS 归一化属 TS 消费面,接线归各域账行);
//! - 外部覆盖 = [`OverrideSet`](版本域列表,空 = 全版本适用),**后登记者
//!   优先**;被覆盖的 seed/更早 override 进 `shadowed` 事实(不删除),
//!   provenance 逐条携带;
//! - 未声明版本:版本域 override 一律不生效(不猜),全版本 override 照常
//!   生效;
//! - `resolve` 查无 = `None`,绝不硬造。
//!
//! 与 RUST-117(capability profile)边界:本面只做「按版本供给引擎事实」,
//! 消费方不散落 `if version`;差异行为建模归 RUST-117 另面。

use std::collections::{BTreeMap, BTreeSet};

/// 引擎元数据类别(关键 API/回调/内建对象/常量;派生 Ord,BTreeMap 键直用)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum MetaCategory {
    Api,
    Callback,
    BuiltinObject,
    Constant,
}

impl MetaCategory {
    pub fn as_str(&self) -> &'static str {
        match self {
            MetaCategory::Api => "api",
            MetaCategory::Callback => "callback",
            MetaCategory::BuiltinObject => "builtin-object",
            MetaCategory::Constant => "constant",
        }
    }
}

/// 一条引擎元数据事实。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MetaEntry {
    /// 名称(方法/回调名;内建对象带宿主前缀如 `KBEngine.Entity`/`Math.Vector3`)。
    pub name: String,
    pub category: MetaCategory,
    /// 进程面(引擎组件名);空 = 脚本库面全进程共有。
    pub faces: Vec<String>,
    /// 引擎出处(文件:行,本树 2.5.10 实证)。
    pub source: String,
    pub note: Option<String>,
}

impl MetaEntry {
    pub fn new(
        name: &str,
        category: MetaCategory,
        faces: &[&str],
        source: &str,
        note: Option<&str>,
    ) -> Self {
        MetaEntry {
            name: name.to_string(),
            category,
            faces: faces.iter().map(|f| f.to_string()).collect(),
            source: source.to_string(),
            note: note.map(|n| n.to_string()),
        }
    }
}

/// 外部版本覆盖集(版本域精确匹配;空 `versions` = 全版本适用)。
#[derive(Debug, Clone)]
pub struct OverrideSet {
    pub versions: Vec<String>,
    pub entries: Vec<MetaEntry>,
}

/// 命中条目的来源(provenance)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    Seed,
    ExternalOverride,
}

/// 解析命中:生效条目 + 来源 + 被遮蔽事实(不删除,只记录)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedEntry {
    pub entry: MetaEntry,
    pub origin: Origin,
    /// 被本条遮蔽的更早 override / seed(遮蔽序 = 登记序新→旧)。
    pub shadowed: Vec<(Origin, MetaEntry)>,
}

/// 引擎元数据层:seed 表 + 外部覆盖(后登记者优先)。查询迭代序 =
/// BTreeMap 键序,确定性。
#[derive(Debug)]
pub struct EngineMetaLayer {
    seed: BTreeMap<(MetaCategory, String), MetaEntry>,
    overrides: Vec<OverrideSet>,
}

/// seed 表(代表性登记;锚点 = 本地引擎树 2.5.10 实证,逐条文件:行)。
pub fn seed_entries() -> Vec<MetaEntry> {
    vec![
        // ---- 关键 API(KBEngine 模块级方法)----
        MetaEntry::new(
            "time",
            MetaCategory::Api,
            &["baseapp", "cellapp"],
            "baseapp.cpp:430, cellapp.cpp:173",
            None,
        ),
        MetaEntry::new(
            "createEntity",
            MetaCategory::Api,
            &["baseapp", "cellapp"],
            "baseapp.cpp:431, cellapp.cpp:174",
            None,
        ),
        MetaEntry::new(
            "createEntityLocally",
            MetaCategory::Api,
            &["baseapp"],
            "baseapp.cpp:432",
            Some("同步返回=本地实体(create_api.rs SyncReturn 面)"),
        ),
        MetaEntry::new(
            "createEntityAnywhere",
            MetaCategory::Api,
            &["baseapp"],
            "baseapp.cpp:433",
            None,
        ),
        MetaEntry::new(
            "createEntityRemotely",
            MetaCategory::Api,
            &["baseapp"],
            "baseapp.cpp:434",
            None,
        ),
        MetaEntry::new(
            "createEntityFromDBID",
            MetaCategory::Api,
            &["baseapp"],
            "baseapp.cpp:435",
            Some("回调三参 = 可空实体+dbid+wasActive(create_api.rs)"),
        ),
        MetaEntry::new(
            "createEntityAnywhereFromDBID",
            MetaCategory::Api,
            &["baseapp"],
            "baseapp.cpp:436",
            None,
        ),
        MetaEntry::new(
            "createEntityRemotelyFromDBID",
            MetaCategory::Api,
            &["baseapp"],
            "baseapp.cpp:437",
            None,
        ),
        MetaEntry::new(
            "executeRawDatabaseCommand",
            MetaCategory::Api,
            &["baseapp", "cellapp"],
            "baseapp.cpp:438, cellapp.cpp:175",
            None,
        ),
        MetaEntry::new(
            "quantumPassedPercent",
            MetaCategory::Api,
            &["baseapp"],
            "baseapp.cpp:439",
            None,
        ),
        MetaEntry::new(
            "reloadScript",
            MetaCategory::Api,
            &["cellapp"],
            "cellapp.cpp:176",
            Some("热更触发面(HOT 泳道消费)"),
        ),
        MetaEntry::new(
            "setSpaceData",
            MetaCategory::Api,
            &["cellapp"],
            "cellapp.cpp:183",
            None,
        ),
        MetaEntry::new(
            "getSpaceData",
            MetaCategory::Api,
            &["cellapp"],
            "cellapp.cpp:184",
            None,
        ),
        // ---- 实体回调(引擎调用点锚)----
        MetaEntry::new(
            "onClientEnabled",
            MetaCategory::Callback,
            &["baseapp"],
            "proxy.cpp:174, 178",
            None,
        ),
        MetaEntry::new(
            "onTimer",
            MetaCategory::Callback,
            &["cellapp"],
            "cellapp/entity.cpp:4358",
            Some("各进程均有计时器,本锚 = cellapp 实证"),
        ),
        MetaEntry::new(
            "onDestroy",
            MetaCategory::Callback,
            &["baseapp", "cellapp"],
            "baseapp/entity.cpp:169, cellapp/entity.cpp:211",
            None,
        ),
        MetaEntry::new(
            "onGetCell",
            MetaCategory::Callback,
            &["baseapp"],
            "baseapp/entity.cpp:1032",
            None,
        ),
        MetaEntry::new(
            "onLoseCell",
            MetaCategory::Callback,
            &["baseapp"],
            "baseapp/entity.cpp:1065",
            None,
        ),
        MetaEntry::new(
            "onInit",
            MetaCategory::Callback,
            &["baseapp", "cellapp"],
            "baseapp.cpp:3701, cellapp/initprogress_handler.cpp:138",
            None,
        ),
        // ---- 内建对象(脚本类;host 模块名前缀)----
        MetaEntry::new(
            "KBEngine.Entity",
            MetaCategory::BuiltinObject,
            &["baseapp", "cellapp"],
            "baseapp.cpp:407, cellapp.cpp:153",
            None,
        ),
        MetaEntry::new(
            "KBEngine.Proxy",
            MetaCategory::BuiltinObject,
            &["baseapp"],
            "baseapp.cpp:408",
            None,
        ),
        MetaEntry::new(
            "KBEngine.Space",
            MetaCategory::BuiltinObject,
            &["baseapp", "cellapp"],
            "baseapp.cpp:409, cellapp.cpp:154",
            None,
        ),
        MetaEntry::new(
            "KBEngine.EntityComponent",
            MetaCategory::BuiltinObject,
            &["baseapp", "cellapp"],
            "baseapp.cpp:410, cellapp.cpp:155",
            None,
        ),
        MetaEntry::new(
            "KBEngine.GlobalDataClient",
            MetaCategory::BuiltinObject,
            &["baseapp", "cellapp"],
            "baseapp.cpp:411, cellapp.cpp:156",
            None,
        ),
        MetaEntry::new(
            "Math.Vector2",
            MetaCategory::BuiltinObject,
            &[],
            "math.cpp:17, script.cpp:291",
            Some("宿主模块名 Math(script.cpp:291);空 faces = 全进程共有"),
        ),
        MetaEntry::new(
            "Math.Vector3",
            MetaCategory::BuiltinObject,
            &[],
            "math.cpp:19, script.cpp:291",
            None,
        ),
        MetaEntry::new(
            "Math.Vector4",
            MetaCategory::BuiltinObject,
            &[],
            "math.cpp:21, script.cpp:291",
            None,
        ),
        MetaEntry::new(
            "KBEngine.EntityCall",
            MetaCategory::BuiltinObject,
            &[],
            "entity_call.cpp:34-35",
            Some("entitydef 库面脚本类型,构造锚;远端句柄语义归 refs.rs"),
        ),
        // ---- 常量 ----
        MetaEntry::new(
            "KBEngine.component",
            MetaCategory::Constant,
            &[],
            "script.cpp:248",
            Some("进程组件名常量(Script::install 每进程注册)"),
        ),
    ]
}

impl EngineMetaLayer {
    /// 以 seed 表构建(覆盖外部版本用 [`add_override`] 追加)。
    pub fn new() -> Self {
        let seed: BTreeMap<(MetaCategory, String), MetaEntry> = seed_entries()
            .into_iter()
            .map(|e| ((e.category, e.name.clone()), e))
            .collect();
        EngineMetaLayer {
            seed,
            overrides: Vec::new(),
        }
    }

    /// 追加外部版本覆盖集(后登记者优先)。
    pub fn add_override(&mut self, set: OverrideSet) {
        self.overrides.push(set);
    }

    /// 当前版本适用的 override(登记序新→旧;未声明版本只适用全版本集)。
    fn matching_overrides(&self, version: Option<&str>) -> Vec<&OverrideSet> {
        self.overrides
            .iter()
            .rev()
            .filter(|set| {
                set.versions.is_empty()
                    || version
                        .map(|v| set.versions.iter().any(|sv| sv == v))
                        .unwrap_or(false)
            })
            .collect()
    }

    /// 逐类别逐名解析:最新适用 override 命中 → ExternalOverride(被遮蔽
    /// 的更早 override + seed 进 shadowed);否则 seed;查无 → None(绝不
    /// 硬造)。
    pub fn resolve(
        &self,
        category: MetaCategory,
        name: &str,
        version: Option<&str>,
    ) -> Option<ResolvedEntry> {
        let matching = self.matching_overrides(version);
        let hit = matching.iter().position(|set| {
            set.entries
                .iter()
                .any(|e| e.category == category && e.name == name)
        });
        if let Some(pos) = hit {
            let winner = matching[pos]
                .entries
                .iter()
                .find(|e| e.category == category && e.name == name)
                .expect("position 已命中");
            let mut shadowed = Vec::new();
            for older in &matching[pos + 1..] {
                if let Some(oe) = older
                    .entries
                    .iter()
                    .find(|e| e.category == category && e.name == name)
                {
                    shadowed.push((Origin::ExternalOverride, oe.clone()));
                }
            }
            if let Some(se) = self.seed.get(&(category, name.to_string())) {
                shadowed.push((Origin::Seed, se.clone()));
            }
            return Some(ResolvedEntry {
                entry: winner.clone(),
                origin: Origin::ExternalOverride,
                shadowed,
            });
        }
        self.seed
            .get(&(category, name.to_string()))
            .map(|se| ResolvedEntry {
                entry: se.clone(),
                origin: Origin::Seed,
                shadowed: Vec::new(),
            })
    }

    /// 当前版本生效的全表(键序 = (category, name) BTreeMap 序;override 专
    /// 有键只在版本适用时出现——未声明版本不猜)。
    pub fn entries(&self, version: Option<&str>) -> Vec<ResolvedEntry> {
        let mut keys: BTreeSet<(MetaCategory, String)> = self.seed.keys().cloned().collect();
        for set in self.matching_overrides(version) {
            for e in &set.entries {
                keys.insert((e.category, e.name.clone()));
            }
        }
        keys.into_iter()
            .filter_map(|(c, n)| self.resolve(c, &n, version))
            .collect()
    }
}

impl Default for EngineMetaLayer {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seed_table_representative_four_categories() {
        let table = seed_entries();
        assert_eq!(table.len(), 29, "seed 表代表性登记数(漂移即钉)");
        // 四类各验一条锚点。
        let layer = EngineMetaLayer::new();
        let time = layer
            .resolve(MetaCategory::Api, "time", None)
            .expect("seed 命中");
        assert_eq!(time.origin, Origin::Seed);
        assert_eq!(time.entry.faces, ["baseapp", "cellapp"]);
        assert_eq!(time.entry.source, "baseapp.cpp:430, cellapp.cpp:173");
        let cb = layer
            .resolve(MetaCategory::Callback, "onClientEnabled", None)
            .expect("seed 命中");
        assert_eq!(cb.entry.source, "proxy.cpp:174, 178");
        let obj = layer
            .resolve(MetaCategory::BuiltinObject, "Math.Vector3", None)
            .expect("seed 命中");
        assert!(obj.entry.faces.is_empty(), "库面全进程共有");
        let konst = layer
            .resolve(MetaCategory::Constant, "KBEngine.component", None)
            .expect("seed 命中");
        assert_eq!(konst.entry.source, "script.cpp:248");
    }

    #[test]
    fn version_scoped_override_wins_and_shadowed() {
        let mut layer = EngineMetaLayer::new();
        layer.add_override(OverrideSet {
            versions: vec!["3.7.3".into()],
            entries: vec![MetaEntry::new(
                "createEntity",
                MetaCategory::Api,
                &["baseapp"],
                "fork/baseapp.cpp:500",
                Some("fork 语义覆盖"),
            )],
        });
        let r = layer
            .resolve(MetaCategory::Api, "createEntity", Some("3.7.3"))
            .expect("override 命中");
        assert_eq!(r.origin, Origin::ExternalOverride);
        assert_eq!(r.entry.source, "fork/baseapp.cpp:500");
        assert_eq!(r.shadowed.len(), 1);
        assert_eq!(r.shadowed[0].0, Origin::Seed);
        assert_eq!(r.shadowed[0].1.source, "baseapp.cpp:431, cellapp.cpp:174");
        // 其他版本不适用 → seed 胜。
        let other = layer
            .resolve(MetaCategory::Api, "createEntity", Some("2.5.10"))
            .expect("seed 命中");
        assert_eq!(other.origin, Origin::Seed);
        assert!(other.shadowed.is_empty());
    }

    #[test]
    fn override_for_unrelated_version_ignored() {
        let mut layer = EngineMetaLayer::new();
        layer.add_override(OverrideSet {
            versions: vec!["9.9.9".into()],
            entries: vec![MetaEntry::new(
                "time",
                MetaCategory::Api,
                &["baseapp"],
                "fork/time.cpp:1",
                None,
            )],
        });
        let r = layer
            .resolve(MetaCategory::Api, "time", Some("3.7.3"))
            .expect("seed 命中");
        assert_eq!(r.origin, Origin::Seed);
        assert_eq!(r.entry.source, "baseapp.cpp:430, cellapp.cpp:173");
    }

    #[test]
    fn unversioned_override_applies_regardless() {
        let mut layer = EngineMetaLayer::new();
        layer.add_override(OverrideSet {
            versions: vec![],
            entries: vec![MetaEntry::new(
                "onTimer",
                MetaCategory::Callback,
                &["baseapp"],
                "fork/timer.cpp:10",
                None,
            )],
        });
        for v in [None, Some("3.7.3"), Some("2.5.10")] {
            let r = layer
                .resolve(MetaCategory::Callback, "onTimer", v)
                .expect("全版本 override 命中");
            assert_eq!(r.origin, Origin::ExternalOverride);
            assert_eq!(r.entry.source, "fork/timer.cpp:10");
        }
    }

    #[test]
    fn no_version_declared_versioned_override_not_applied() {
        let mut layer = EngineMetaLayer::new();
        layer.add_override(OverrideSet {
            versions: vec!["3.7.3".into()],
            entries: vec![MetaEntry::new(
                "onGetCell",
                MetaCategory::Callback,
                &["baseapp"],
                "fork/cell.cpp:1",
                None,
            )],
        });
        let r = layer
            .resolve(MetaCategory::Callback, "onGetCell", None)
            .expect("未声明版本 → seed(不猜)");
        assert_eq!(r.origin, Origin::Seed);
        assert_eq!(r.entry.source, "baseapp/entity.cpp:1032");
        assert!(r.shadowed.is_empty());
    }

    #[test]
    fn override_adds_entry_absent_from_seed() {
        let mut layer = EngineMetaLayer::new();
        assert!(layer
            .resolve(MetaCategory::Api, "forkOnlyApi", Some("9.9.9"))
            .is_none());
        layer.add_override(OverrideSet {
            versions: vec!["9.9.9".into()],
            entries: vec![MetaEntry::new(
                "forkOnlyApi",
                MetaCategory::Api,
                &["baseapp"],
                "fork/extra.cpp:7",
                None,
            )],
        });
        let r = layer
            .resolve(MetaCategory::Api, "forkOnlyApi", Some("9.9.9"))
            .expect("override 专有键命中");
        assert_eq!(r.origin, Origin::ExternalOverride);
        assert!(r.shadowed.is_empty(), "seed 无此键,无遮蔽事实");
    }

    #[test]
    fn unknown_name_resolves_none() {
        let layer = EngineMetaLayer::new();
        assert!(layer.resolve(MetaCategory::Api, "ghost", None).is_none());
        assert!(layer
            .resolve(
                MetaCategory::Constant,
                "KBEngine.ENTITYCALL_TYPE_CELL",
                None
            )
            .is_none());
        assert_eq!(layer.entries(Some("3.7.3")).len(), 29);
        assert!(layer
            .entries(Some("3.7.3"))
            .iter()
            .all(|r| r.entry.name != "ghost"));
    }

    #[test]
    fn later_override_wins_between_overrides() {
        let mut layer = EngineMetaLayer::new();
        layer.add_override(OverrideSet {
            versions: vec!["3.7.3".into()],
            entries: vec![MetaEntry::new(
                "KBEngine.component",
                MetaCategory::Constant,
                &[],
                "fork/first.cpp:1",
                None,
            )],
        });
        layer.add_override(OverrideSet {
            versions: vec![],
            entries: vec![MetaEntry::new(
                "KBEngine.component",
                MetaCategory::Constant,
                &[],
                "fork/second.cpp:2",
                None,
            )],
        });
        let r = layer
            .resolve(MetaCategory::Constant, "KBEngine.component", Some("3.7.3"))
            .expect("命中");
        assert_eq!(r.entry.source, "fork/second.cpp:2", "后登记者优先");
        assert_eq!(r.shadowed.len(), 2);
        assert_eq!(r.shadowed[0].0, Origin::ExternalOverride);
        assert_eq!(r.shadowed[0].1.source, "fork/first.cpp:1");
        assert_eq!(r.shadowed[1].0, Origin::Seed);
    }

    #[test]
    fn entries_audit_sorted_with_provenance() {
        let mut layer = EngineMetaLayer::new();
        layer.add_override(OverrideSet {
            versions: vec!["9.9.9".into()],
            entries: vec![MetaEntry::new(
                "forkOnlyApi",
                MetaCategory::Api,
                &["baseapp"],
                "fork/extra.cpp:7",
                None,
            )],
        });
        let at = layer.entries(Some("9.9.9"));
        assert_eq!(at.len(), 30, "seed 29 + override 专有 1");
        let pairs: Vec<(MetaCategory, &str)> = at
            .iter()
            .map(|r| (r.entry.category, r.entry.name.as_str()))
            .collect();
        let mut expect: Vec<(MetaCategory, &str)> = pairs.clone();
        expect.sort();
        assert_eq!(pairs, expect, "键序确定性(BTreeSet 迭代序)");
        let forked = at
            .iter()
            .find(|r| r.entry.name == "forkOnlyApi")
            .expect("override 专有键入表");
        assert_eq!(forked.origin, Origin::ExternalOverride);
        // 未声明版本:override 专有键不入表(不猜)。
        assert_eq!(layer.entries(None).len(), 29);
        assert!(layer
            .entries(None)
            .iter()
            .all(|r| r.entry.name != "forkOnlyApi"));
    }
}
