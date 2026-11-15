//! KSEM-CAP(RUST-117,旧 SEM-015)引擎版本差异 capability profile(纯库
//! 面,无 RPC/无 TS 消费)。
//!
//! 纪律(todo 原句):引擎版本差异经 capability profile 决定,**不用
//! `if version` 散落调用方**——调用方只在装配点用项目声明版本解析一次
//! [`CapabilityProfile`],此后逐能力问 [`CapabilityProfile::capability`]/
//! [`CapabilityProfile::is_supported`],分支只落在能力态上,调用点不见
//! 版本串比较。
//!
//! 能力事实承 RUST-113 [`EngineMetaLayer`] 版本覆盖机器(`MetaCategory::
//! Capability`,键约定:`cap/<id>` = 能力在,`cap/no/<id>` = 实证缺席,
//! 两键都无 = [`CapabilityState::Unknown`] 不猜);seed = 本地引擎树
//! 2.5.10 实证基线,其它版本差异由 `OverrideSet` 外部版本覆盖供给——
//! 「外部版本可覆盖」对能力差同样成立。未声明版本:版本域 override 不
//! 生效(不猜),seed 基线照常。
//!
//! 与 RUST-113 边界:113 供给逐条引擎事实(API/回调/内建对象/常量),
//! 本面把**能力差**(版本相关的行为差异)收敛成单点 profile 供消费方
//! 分支;真实差异裁决归消费方,本面不猜版本兼容性。

use std::collections::BTreeMap;

use crate::semantics::engine_meta::{EngineMetaLayer, MetaCategory};

/// 能力态。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CapabilityState {
    /// 能力在(实证锚随行)。
    Supported { source: String },
    /// 能力缺(实证缺席,锚随行;不是 Unknown——缺席也是实证事实)。
    Unsupported { source: String },
    /// 无证据(不猜;调用方保守处理)。
    Unknown,
}

impl CapabilityState {
    pub fn as_str(&self) -> &'static str {
        match self {
            CapabilityState::Supported { .. } => "supported",
            CapabilityState::Unsupported { .. } => "unsupported",
            CapabilityState::Unknown => "unknown",
        }
    }
}

/// 单个声明版本的能力 profile(解析一次,逐能力查询;构造后不可变)。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CapabilityProfile {
    /// 声明版本(原样;`None` = 项目未声明,seed 基线照常,版本域
    /// override 不生效——RUST-113 同口径)。
    pub version: Option<String>,
    caps: BTreeMap<String, CapabilityState>,
}

impl CapabilityProfile {
    /// 以声明版本解析能力 profile(meta.entries 全表过滤 Capability 类别;
    /// `cap/no/` 前缀 = Unsupported,`cap/` 前缀 = Supported;键序
    /// BTreeMap 确定)。
    pub fn resolve(meta: &EngineMetaLayer, version: Option<&str>) -> Self {
        let mut caps: BTreeMap<String, CapabilityState> = BTreeMap::new();
        for r in meta.entries(version) {
            if r.entry.category != MetaCategory::Capability {
                continue;
            }
            if let Some(id) = r.entry.name.strip_prefix("cap/no/") {
                caps.insert(
                    id.to_string(),
                    CapabilityState::Unsupported {
                        source: r.entry.source.clone(),
                    },
                );
            } else if let Some(id) = r.entry.name.strip_prefix("cap/") {
                caps.insert(
                    id.to_string(),
                    CapabilityState::Supported {
                        source: r.entry.source.clone(),
                    },
                );
            }
        }
        CapabilityProfile {
            version: version.map(|v| v.to_string()),
            caps,
        }
    }

    /// 逐能力查询(查无 = Unknown,不猜)。
    pub fn capability(&self, id: &str) -> &CapabilityState {
        self.caps.get(id).unwrap_or(&CapabilityState::Unknown)
    }

    /// 仅 Supported 为真(Unknown/Unsupported 均假——保守口径)。
    pub fn is_supported(&self, id: &str) -> bool {
        matches!(self.capability(id), CapabilityState::Supported { .. })
    }

    /// 已登记能力 id(键序确定;不含 Unknown 占位——Unknown 是查询产物
    /// 不入表)。
    pub fn ids(&self) -> impl Iterator<Item = &str> {
        self.caps.keys().map(|s| s.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::semantics::engine_meta::{MetaEntry, OverrideSet};

    #[test]
    fn baseline_seed_capabilities_resolved() {
        let meta = EngineMetaLayer::new();
        let p = CapabilityProfile::resolve(&meta, Some("2.5.10"));
        assert_eq!(p.version.as_deref(), Some("2.5.10"));
        let math = p.capability("math-module-vectors");
        let CapabilityState::Supported { source } = math else {
            panic!("math 向量能力在,得 {math:?}");
        };
        assert_eq!(source, "math.cpp:17-21, script.cpp:291");
        let no_etc = p.capability("entitycall-type-python-constants");
        let CapabilityState::Unsupported { source } = no_etc else {
            panic!("ENTITYCALL_TYPE 常量实证缺席,得 {no_etc:?}");
        };
        assert_eq!(source, "common.h:283-292");
        // 基线未声明版本同 seed(基线 = 全版本事实,override 才看版本)。
        let p0 = CapabilityProfile::resolve(&meta, None);
        assert_eq!(
            p0.capability("component-string-constant"),
            p.capability("component-string-constant")
        );
    }

    #[test]
    fn is_supported_strict_and_unknown_not_guessed() {
        let meta = EngineMetaLayer::new();
        let p = CapabilityProfile::resolve(&meta, None);
        assert!(p.is_supported("component-string-constant"));
        assert!(
            !p.is_supported("entitycall-type-python-constants"),
            "缺席≠支持"
        );
        assert_eq!(p.capability("ghost-cap"), &CapabilityState::Unknown);
        assert!(!p.is_supported("ghost-cap"), "查无不猜支持");
    }

    #[test]
    fn version_scoped_override_flips_capability_only_at_scope() {
        let mut meta = EngineMetaLayer::new();
        meta.add_override(OverrideSet {
            versions: vec!["3.7.3".into()],
            entries: vec![MetaEntry::new(
                "cap/no/math-module-vectors",
                MetaCategory::Capability,
                &[],
                "fork3x/math.cpp(2026-11-16 假设登记,真实 fork 证据随登记)",
                Some("fork 3.x 移除 Math 模块 = 能力缺"),
            )],
        });
        let at = CapabilityProfile::resolve(&meta, Some("3.7.3"));
        let CapabilityState::Unsupported { source } = at.capability("math-module-vectors") else {
            panic!(
                "版本域覆盖生效,得 {:?}",
                at.capability("math-module-vectors")
            );
        };
        assert!(source.starts_with("fork3x/"));
        // 同键两事实(cap 在 + cap/no 缺)并存时,entries 全表过滤会双登记
        // ——后者(cap/no 排序在后)胜;此处语义 = fork 覆盖 seed。
        let other = CapabilityProfile::resolve(&meta, Some("2.5.10"));
        assert!(
            other.is_supported("math-module-vectors"),
            "域外 seed 基线不变"
        );
    }

    #[test]
    fn override_adds_capability_only_for_declared_version() {
        let mut meta = EngineMetaLayer::new();
        meta.add_override(OverrideSet {
            versions: vec!["9.9.9-fork".into()],
            entries: vec![MetaEntry::new(
                "cap/fork-only-hot-api",
                MetaCategory::Capability,
                &[],
                "fork/extra.cpp:7",
                None,
            )],
        });
        let at = CapabilityProfile::resolve(&meta, Some("9.9.9-fork"));
        assert!(at.is_supported("fork-only-hot-api"));
        let none = CapabilityProfile::resolve(&meta, None);
        assert_eq!(
            none.capability("fork-only-hot-api"),
            &CapabilityState::Unknown,
            "未声明版本不入 override 专有能力(不猜)"
        );
    }

    #[test]
    fn unversioned_override_applies_to_all() {
        let mut meta = EngineMetaLayer::new();
        meta.add_override(OverrideSet {
            versions: vec![],
            entries: vec![MetaEntry::new(
                "cap/no/component-string-constant",
                MetaCategory::Capability,
                &[],
                "stub-build/script.cpp(桩环境无进程注册)",
                None,
            )],
        });
        for v in [None, Some("2.5.10"), Some("3.7.3")] {
            let p = CapabilityProfile::resolve(&meta, v);
            let CapabilityState::Unsupported { .. } = p.capability("component-string-constant")
            else {
                panic!(
                    "全版本覆盖生效,得 {v:?} → {:?}",
                    p.capability("component-string-constant")
                );
            };
        }
    }

    #[test]
    fn profile_consume_shape_no_version_at_call_site() {
        let meta = EngineMetaLayer::new();
        // 消费形态钉:装配点解析一次,调用点只问能力,不见版本串比较。
        let profile = CapabilityProfile::resolve(&meta, Some("2.5.10"));
        let can_vectors = profile.is_supported("math-module-vectors");
        let can_etc = profile.is_supported("entitycall-type-python-constants");
        assert!(can_vectors && !can_etc);
        assert_eq!(
            profile.capability("math-module-vectors").as_str(),
            "supported"
        );
        assert_eq!(
            profile
                .capability("entitycall-type-python-constants")
                .as_str(),
            "unsupported"
        );
    }

    #[test]
    fn ids_enumeration_sorted_and_capability_only() {
        let meta = EngineMetaLayer::new();
        let p = CapabilityProfile::resolve(&meta, None);
        let ids: Vec<&str> = p.ids().collect();
        let mut sorted = ids.clone();
        sorted.sort_unstable();
        assert_eq!(ids, sorted, "键序确定");
        assert_eq!(ids.len(), 3, "seed 三条能力差;非能力类别不入表");
        assert!(ids.contains(&"math-module-vectors"));
        assert!(ids.contains(&"component-string-constant"));
        assert!(ids.contains(&"entitycall-type-python-constants"));
    }

    #[test]
    fn namespaced_keys_do_not_leak_into_rename_scan() {
        // 能力键名空间化:语料符号名(Avatar)不被能力事实误判内建。
        let meta = EngineMetaLayer::new();
        let c = crate::semantics::rename_policy::classify_symbol_owner(
            &meta,
            "/proj/scripts/Avatar.py",
            "Avatar",
            None,
            None,
            ".kbengine",
        );
        assert_eq!(
            c.owner,
            crate::semantics::rename_policy::SymbolOwner::UserCode
        );
        // 能力键本身按 meta 契约命中(内建事实)——一致口径。
        let k = crate::semantics::rename_policy::classify_symbol_owner(
            &meta,
            "/proj/scripts/Avatar.py",
            "cap/math-module-vectors",
            None,
            None,
            ".kbengine",
        );
        assert_eq!(
            k.owner,
            crate::semantics::rename_policy::SymbolOwner::EngineBuiltin
        );
    }

    #[test]
    fn double_registered_key_absent_form_wins_deterministically() {
        // cap/<id> 与 cap/no/<id> 并存(fork 覆盖 seed):entries 键序
        // BTreeMap 中 "cap/math-module-vectors" < "cap/no/…",后写胜 = 缺席
        // 覆盖在。确定性钉。
        let mut meta = EngineMetaLayer::new();
        meta.add_override(OverrideSet {
            versions: vec!["3.7.3".into()],
            entries: vec![
                MetaEntry::new(
                    "cap/math-module-vectors",
                    MetaCategory::Capability,
                    &[],
                    "fork3x/math-restored.cpp:1",
                    None,
                ),
                MetaEntry::new(
                    "cap/no/math-module-vectors",
                    MetaCategory::Capability,
                    &[],
                    "fork3x/math-removed.cpp:2",
                    None,
                ),
            ],
        });
        let p = CapabilityProfile::resolve(&meta, Some("3.7.3"));
        assert_eq!(
            p.capability("math-module-vectors"),
            &CapabilityState::Unsupported {
                source: "fork3x/math-removed.cpp:2".into()
            },
            "同 id 两形态并存:cap/no 后写胜(键序确定)"
        );
    }
}
