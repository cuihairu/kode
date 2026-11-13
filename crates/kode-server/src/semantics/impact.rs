//! RPC 修改影响查询(KSEM-RPC-09)。
//!
//! 方法/Arg 变更后,消费方带着自己的调用点索引来问「谁受影响」。本模块
//! 只做三件事,全部确定性可测:
//!
//! 1. **分诊**:把索引条目分成确定调用点(方法名字面量命中 + 接收者已
//!    绑定到目标类 + 引用形态已解析)、不确定候选(动态方法名/接收者未知/
//!    引用未解析/实参动态展开)与不受影响(名字不同类或解析到别的类),
//!    绝不把不确定项静默丢进「不受影响」;
//! 2. **覆盖声明**:索引覆盖态由消费方显式给出(Complete/Partial/Missing)
//!    ——Partial/Missing 时报告**不构成零影响结论**;
//! 3. **零影响红线**:[`ImpactReport::no_impact_claim`] 只在「覆盖完备 ∧
//!    两列表皆空」时才产结论——索引缺失/不全时拿不到「零影响」这个话,
//!    误报防线在 API 形状上,不靠调用方自觉。
//!
//! 分类是**过近似**纪律:宁可进不确定候选,不可漏报;方向可达性等深判定
//! 归 RPC-05 已有面,本批不重复裁。

use super::id::Facet;

/// 变更描述。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RpcChange {
    /// 方法级变更(重命名/删除/签名整体变动)。
    MethodChanged {
        /// 目标实体类(def 模块名)。
        class: String,
        /// 声明所在段(报告元数据;分类不按方向裁剪,宁可过近似)。
        facet: Facet,
        method: String,
    },
    /// Arg 位变更(类型变化/增删位)。
    ArgChanged {
        class: String,
        facet: Facet,
        method: String,
        /// 变更的声明位(0 基)。
        position: usize,
    },
}

impl RpcChange {
    /// 目标方法名(两态共用)。
    pub fn method(&self) -> &str {
        match self {
            RpcChange::MethodChanged { method, .. } | RpcChange::ArgChanged { method, .. } => method,
        }
    }

    /// 目标类(两态共用)。
    pub fn class(&self) -> &str {
        match self {
            RpcChange::MethodChanged { class, .. } | RpcChange::ArgChanged { class, .. } => class,
        }
    }
}

/// 调用点索引条目(消费方从索引转述;解析事实按字段给,不知道 = None/false)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RpcUsageSite {
    /// 调用所在文件(报告用)。
    pub file: String,
    /// 调用所在行(报告用)。
    pub line: usize,
    /// 调用的方法名;None = 动态拼接(getattr/字符串组装),运行时才知。
    pub method_name: Option<String>,
    /// 接收者绑定的实体类(def 模块名);None = 接收者类未知。
    /// 组件广播面的查找落在组件 def 模块,此处填**组件类名**。
    pub receiver_class: Option<String>,
    /// 引用形态是否已解析(RPC-01..03 消费面产出);false = 链路未解析。
    pub reference_resolved: bool,
    /// 是否广播面(allClients/otherClients)。
    pub is_broadcast: bool,
    /// 实参是否含动态展开(*args/**kwargs,RPC-06 红线同源)。
    pub has_dynamic_args: bool,
}

/// 索引覆盖态(消费方显式声明,不由本模块推断)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IndexCoverage {
    /// 索引覆盖全部相关源码。
    Complete,
    /// 只覆盖列出范围之外的部分;`uncovered` = 未覆盖范围描述
    /// (未打开文件/未索引目录/索引构建失败原因等)。
    Partial { uncovered: Vec<String> },
    /// 索引缺失/未构建——本批查询对调用点**一无所知**。
    Missing,
}

/// 影响查询报告。
#[derive(Debug, Clone, PartialEq)]
pub struct ImpactReport {
    pub change: RpcChange,
    /// 确定调用点:字面量命中目标方法 ∧ 引用已解析 ∧ 接收者绑定目标类
    /// (ArgChanged 时实参不含动态展开——展开位数不可知则降不确定)。
    pub definite: Vec<RpcUsageSite>,
    /// 不确定候选:可能受影响但解析不全(动态方法名/接收者未知/引用未解析/
    /// 动态展开);**绝不静默归入不受影响**。
    pub uncertain: Vec<RpcUsageSite>,
    /// 索引覆盖态(Partial/Missing 时两列表不构成零影响依据)。
    pub coverage: IndexCoverage,
}

impl ImpactReport {
    /// 「零影响」结论:**只有**索引覆盖完备且确定/不确定两列表皆空才成立,
    /// 返回结论文本;否则 None(调用方拿不到「零影响」这句话)。
    pub fn no_impact_claim(&self) -> Option<String> {
        if self.coverage != IndexCoverage::Complete {
            return None;
        }
        if self.definite.is_empty() && self.uncertain.is_empty() {
            return Some(format!(
                "索引覆盖完备,未发现调用 {}::{} 的调用点",
                self.change.class(),
                self.change.method()
            ));
        }
        None
    }

    /// 覆盖缺口的显式说明(Partial/Missing 时必有,Complete 时 None)。
    pub fn coverage_notice(&self) -> Option<String> {
        match &self.coverage {
            IndexCoverage::Complete => None,
            IndexCoverage::Missing => Some(format!(
                "调用点索引缺失:本次查询对调用 {}::{} 的位置一无所知,以下列表(空也罢)不构成零影响结论",
                self.change.class(),
                self.change.method()
            )),
            IndexCoverage::Partial { uncovered } => Some(format!(
                "调用点索引不完整,未覆盖:{};以下列表不构成零影响结论",
                uncovered.join("、")
            )),
        }
    }
}

/// 单条目分诊(报告构建的原子判定)。
///
/// 判定次序(过近似纪律:先漏报防线后误报防线):
/// 1. 方法名动态(None)→ 不确定候选;
/// 2. 方法名字面量不同 → 不受影响(不进任何列表);
/// 3. 引用形态未解析 → 不确定候选(类名即使给了也不可信);
/// 4. 接收者类未知 → 不确定候选;
/// 5. 接收者绑定到别的类 → 不受影响(同名方法归别家变更管);
/// 6. 类命中 → ArgChanged 且实参动态展开则降不确定,否则确定调用点。
fn classify_site(change: &RpcChange, site: &RpcUsageSite) -> Option<SiteVerdict> {
    // 1. 动态方法名:运行时才知落点,保持候选。
    let Some(name) = &site.method_name else {
        return Some(SiteVerdict::Uncertain);
    };
    // 2. 名字不同:字面量已排除。
    if name != change.method() {
        return None;
    }
    // 3. 引用未解析:链路不完整,候选。
    if !site.reference_resolved {
        return Some(SiteVerdict::Uncertain);
    }
    // 4. 接收者未知:同类名方法可能在别家,候选。
    let Some(class) = &site.receiver_class else {
        return Some(SiteVerdict::Uncertain);
    };
    // 5. 绑定到别的类:同名方法不受本次变更影响。
    if class != change.class() {
        return None;
    }
    // 6. 类命中:Arg 变更遇动态展开降级(位数不可知,该位是否被传不明)。
    match change {
        RpcChange::MethodChanged { .. } => Some(SiteVerdict::Definite),
        RpcChange::ArgChanged { .. } if site.has_dynamic_args => Some(SiteVerdict::Uncertain),
        RpcChange::ArgChanged { .. } => Some(SiteVerdict::Definite),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SiteVerdict {
    Definite,
    Uncertain,
}

/// 构建影响报告(分诊 + 覆盖声明)。
pub fn impact_query(change: RpcChange, sites: &[RpcUsageSite], coverage: IndexCoverage) -> ImpactReport {
    let mut definite = Vec::new();
    let mut uncertain = Vec::new();
    for site in sites {
        match classify_site(&change, site) {
            Some(SiteVerdict::Definite) => definite.push(site.clone()),
            Some(SiteVerdict::Uncertain) => uncertain.push(site.clone()),
            None => {}
        }
    }
    ImpactReport {
        change,
        definite,
        uncertain,
        coverage,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn site(method: Option<&str>, class: Option<&str>, resolved: bool) -> RpcUsageSite {
        RpcUsageSite {
            file: "scripts/cell/Avatar.py".to_string(),
            line: 10,
            method_name: method.map(|s| s.to_string()),
            receiver_class: class.map(|s| s.to_string()),
            reference_resolved: resolved,
            is_broadcast: false,
            has_dynamic_args: false,
        }
    }

    fn change() -> RpcChange {
        RpcChange::MethodChanged {
            class: "Avatar".to_string(),
            facet: Facet::Cell,
            method: "attack".to_string(),
        }
    }

    #[test]
    fn literal_name_bound_class_is_definite() {
        let report = impact_query(
            change(),
            &[site(Some("attack"), Some("Avatar"), true)],
            IndexCoverage::Complete,
        );
        assert_eq!(report.definite.len(), 1);
        assert!(report.uncertain.is_empty());
    }

    #[test]
    fn dynamic_method_name_is_uncertain_never_dropped() {
        let report = impact_query(
            change(),
            &[site(None, Some("Avatar"), true)],
            IndexCoverage::Complete,
        );
        assert!(report.definite.is_empty());
        assert_eq!(report.uncertain.len(), 1);
    }

    #[test]
    fn different_literal_name_is_excluded_from_both_lists() {
        let report = impact_query(
            change(),
            &[site(Some("heal"), Some("Avatar"), true)],
            IndexCoverage::Complete,
        );
        assert!(report.definite.is_empty());
        assert!(report.uncertain.is_empty());
    }

    #[test]
    fn unresolved_reference_stays_uncertain_even_with_class() {
        let report = impact_query(
            change(),
            &[site(Some("attack"), Some("Avatar"), false)],
            IndexCoverage::Complete,
        );
        assert!(report.definite.is_empty());
        assert_eq!(report.uncertain.len(), 1);
    }

    #[test]
    fn unknown_receiver_is_uncertain() {
        let report = impact_query(
            change(),
            &[site(Some("attack"), None, true)],
            IndexCoverage::Complete,
        );
        assert_eq!(report.uncertain.len(), 1);
    }

    #[test]
    fn receiver_bound_to_other_class_is_excluded() {
        let report = impact_query(
            change(),
            &[site(Some("attack"), Some("Monster"), true)],
            IndexCoverage::Complete,
        );
        assert!(report.definite.is_empty());
        assert!(report.uncertain.is_empty());
    }

    #[test]
    fn broadcast_site_resolves_by_lookup_class() {
        // 广播面条目按查找类转述(组件广播=组件类名),命中同样确定。
        let mut b = site(Some("attack"), Some("Avatar"), true);
        b.is_broadcast = true;
        let report = impact_query(change(), &[b], IndexCoverage::Complete);
        assert_eq!(report.definite.len(), 1);
    }

    #[test]
    fn arg_change_demotes_dynamic_args_to_uncertain() {
        // Arg 位变更遇 *args/**kwargs:该位是否被传不可知,降不确定。
        let arg_change = RpcChange::ArgChanged {
            class: "Avatar".to_string(),
            facet: Facet::Cell,
            method: "attack".to_string(),
            position: 1,
        };
        let mut spread = site(Some("attack"), Some("Avatar"), true);
        spread.has_dynamic_args = true;
        let plain = site(Some("attack"), Some("Avatar"), true);
        let report = impact_query(arg_change, &[spread, plain.clone()], IndexCoverage::Complete);
        assert_eq!(report.definite.len(), 1);
        assert_eq!(report.uncertain.len(), 1);
        assert!(report.definite[0].file == plain.file && !report.definite[0].has_dynamic_args);
    }

    #[test]
    fn method_change_keeps_dynamic_args_site_definite() {
        // 方法级变更不按实参位数裁:展开与否都命中该方法本体。
        let mut spread = site(Some("attack"), Some("Avatar"), true);
        spread.has_dynamic_args = true;
        let report = impact_query(change(), &[spread], IndexCoverage::Complete);
        assert_eq!(report.definite.len(), 1);
    }

    #[test]
    fn missing_index_never_yields_zero_impact_claim() {
        // 验收红线:索引缺失时,空列表**不是**零影响——结论不可得,说明必有。
        let report = impact_query(change(), &[], IndexCoverage::Missing);
        assert!(report.definite.is_empty());
        assert!(report.uncertain.is_empty());
        assert!(report.no_impact_claim().is_none());
        let notice = report.coverage_notice().unwrap();
        assert!(notice.contains("索引缺失"));
    }

    #[test]
    fn partial_coverage_notices_uncovered_scopes() {
        let report = impact_query(
            change(),
            &[site(Some("attack"), Some("Avatar"), true)],
            IndexCoverage::Partial {
                uncovered: vec!["scripts/bot/ 未索引".to_string()],
            },
        );
        assert_eq!(report.definite.len(), 1);
        let notice = report.coverage_notice().unwrap();
        assert!(notice.contains("scripts/bot/"));
        assert!(report.no_impact_claim().is_none());
    }

    #[test]
    fn complete_index_with_no_sites_yields_zero_impact_claim() {
        let report = impact_query(change(), &[], IndexCoverage::Complete);
        assert!(report.no_impact_claim().is_some());
        assert!(report.coverage_notice().is_none());
    }

    #[test]
    fn uncertain_sites_block_zero_impact_claim_even_if_complete() {
        let report = impact_query(
            change(),
            &[site(None, Some("Avatar"), true)],
            IndexCoverage::Complete,
        );
        assert!(report.no_impact_claim().is_none());
    }

    #[test]
    fn mixed_sites_partition_into_three_buckets() {
        let sites = vec![
            site(Some("attack"), Some("Avatar"), true),    // 确定
            site(None, Some("Avatar"), true),              // 动态名 → 候选
            site(Some("attack"), Some("Avatar"), false),   // 未解析 → 候选
            site(Some("heal"), Some("Avatar"), true),      // 异名 → 不受影响
            site(Some("attack"), Some("Monster"), true),   // 别类 → 不受影响
        ];
        let report = impact_query(change(), &sites, IndexCoverage::Complete);
        assert_eq!(report.definite.len(), 1);
        assert_eq!(report.uncertain.len(), 2);
    }
}
