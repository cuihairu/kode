//! 诊断分级装配决策核(RUST-142 批 2;TS 生产四族装配批的纯库半边)。
//!
//! 批 1(diagnostic_pipeline.rs)交付了 12 计数器调度状态机回放核 +
//! 四族层模型(layer_for_family)。本批把**真实 lint 家族税表**接入四层:
//! `lint::Finding.check` 的 15 个在役 check 码 → 四层路由(现状全部
//! LocalSyntax——生产 TS 层枚举仍 local|semantic,诊断面 rust 服务腿
//! (observeRustDefFindings/mergeRustDefFindings)把这些 findings 当本地
//! def 校验并集;semantic/engineCompat/runtimeConfig 三个座位是目标设计
//! 面,家族迁移时由 TS 装配批翻表,本面只锁「表 + 路由 + 合流序」)。
//!
//! 合流序 = 批 1 golden 同款层名字节序(engineCompat < localSyntax <
//! runtimeConfig < semantic);逐层独立 DiagnosticSchedulerCore(request
//! 立即通道,version 同版跳过等语义全部继承批 1 回放核)。
//!
//! 诚实边界(登记,不冒充):分级现状是**全 LocalSyntax 常表**——四层
//! 路由的可观察面(异层落桶/合流交错)在语料上不可分辨,由合成钉 +
//! merged_publish 手工桶钉闭环;engineCompat 座位的真实占员(def md5
//! 兼容面)与 runtimeConfig 座位(TS configContract 族)归各自车道接线
//! 时入表。didChange 生产接线 + LSP publishDiagnostics 留接线批,本批
//! 零接 server.rs 纯库不变。

use std::collections::BTreeMap;

use serde::Serialize;

use crate::diagnostic_pipeline::{
    DiagnosticLayer, DiagnosticSchedulerCore, PublishRecord, TaskSpec,
};
use crate::hover::HoverEngine;
use crate::lint::{analyze_def_with_python, Finding, InheritedNames, PythonParityInput};

/// 在役 lint check 码全表(lint/rules.rs 15 规则;新增规则双侧同步——
/// 本表是四族装配的家族税源,TS 镜像 tests/kodeDiagnosticLayeringParity
/// 同表对拍)。
pub const CHECK_CODES: &[&str] = &[
    "def-method-missing-in-python",
    "duplicate-definition",
    "duplicate-type-tag",
    "engine-limited-name",
    "heavy-sync-broadcast",
    "inherited-name-collision",
    "invalid-identifier",
    "method-property-collision",
    "missing-flags",
    "missing-type",
    "phantom-type",
    "redundant-detail-level",
    "unknown-detail-level",
    "unknown-flag-value",
    "unknown-type-reference",
];

/// 家族 → 层决策表(现状:全 LocalSyntax——生产把这些 findings 并进
/// 本地 def 校验诊断;未知 check 码保守路由 LocalSyntax,不丢产出)。
pub fn layer_for_check(_check: &str) -> DiagnosticLayer {
    DiagnosticLayer::LocalSyntax
}

/// 四层名合流序 = 批 1 golden 同款字节序(publishLog 拼接口径)。
pub const MERGED_PUBLISH_ORDER: &[&str] =
    &["engineCompat", "localSyntax", "runtimeConfig", "semantic"];

/// 逐层路由桶(保序;route_findings 产出,merged_publish 消费)。
#[derive(Debug, Default, Clone)]
pub struct LayeredFindings {
    pub local_syntax: Vec<Finding>,
    pub semantic: Vec<Finding>,
    pub engine_compat: Vec<Finding>,
    pub runtime_config: Vec<Finding>,
}

impl LayeredFindings {
    pub fn bucket(&self, layer: DiagnosticLayer) -> &Vec<Finding> {
        match layer {
            DiagnosticLayer::LocalSyntax => &self.local_syntax,
            DiagnosticLayer::Semantic => &self.semantic,
            DiagnosticLayer::EngineCompat => &self.engine_compat,
            DiagnosticLayer::RuntimeConfig => &self.runtime_config,
        }
    }

    pub fn bucket_mut(&mut self, layer: DiagnosticLayer) -> &mut Vec<Finding> {
        match layer {
            DiagnosticLayer::LocalSyntax => &mut self.local_syntax,
            DiagnosticLayer::Semantic => &mut self.semantic,
            DiagnosticLayer::EngineCompat => &mut self.engine_compat,
            DiagnosticLayer::RuntimeConfig => &mut self.runtime_config,
        }
    }
}

/// 全量 findings 按决策表路由(保序入桶)。
pub fn route_findings(findings: Vec<Finding>) -> LayeredFindings {
    let mut out = LayeredFindings::default();
    for finding in findings {
        let layer = layer_for_check(finding.check);
        out.bucket_mut(layer).push(finding);
    }
    out
}

/// 逐层调度核组(独立节流语义 = 批 1 回放核,四层互不影响)。
#[derive(Debug)]
pub struct LayeredSchedulers {
    pub local_syntax: DiagnosticSchedulerCore,
    pub semantic: DiagnosticSchedulerCore,
    pub engine_compat: DiagnosticSchedulerCore,
    pub runtime_config: DiagnosticSchedulerCore,
}

impl LayeredSchedulers {
    pub fn new() -> LayeredSchedulers {
        LayeredSchedulers {
            local_syntax: DiagnosticSchedulerCore::new(DiagnosticLayer::LocalSyntax),
            semantic: DiagnosticSchedulerCore::new(DiagnosticLayer::Semantic),
            engine_compat: DiagnosticSchedulerCore::new(DiagnosticLayer::EngineCompat),
            runtime_config: DiagnosticSchedulerCore::new(DiagnosticLayer::RuntimeConfig),
        }
    }

    pub fn core(&mut self, layer: DiagnosticLayer) -> &mut DiagnosticSchedulerCore {
        match layer {
            DiagnosticLayer::LocalSyntax => &mut self.local_syntax,
            DiagnosticLayer::Semantic => &mut self.semantic,
            DiagnosticLayer::EngineCompat => &mut self.engine_compat,
            DiagnosticLayer::RuntimeConfig => &mut self.runtime_config,
        }
    }

    /// 合流发布面:四层 sink 按层名字节序拼接(publishLog 拼接口径)。
    pub fn merged_publish(&self) -> Vec<&PublishRecord> {
        let mut out = Vec::new();
        for name in MERGED_PUBLISH_ORDER {
            let layer = DiagnosticLayer::parse(name).expect("layer name");
            let sink = match layer {
                DiagnosticLayer::LocalSyntax => &self.local_syntax.sink(),
                DiagnosticLayer::Semantic => &self.semantic.sink(),
                DiagnosticLayer::EngineCompat => &self.engine_compat.sink(),
                DiagnosticLayer::RuntimeConfig => &self.runtime_config.sink(),
            };
            out.extend(sink.iter());
        }
        out
    }
}

impl Default for LayeredSchedulers {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// golden 第四面(语料真分布 + 决策表快照 + 逐层独立回放)
// ---------------------------------------------------------------------------

pub const DIAGNOSTIC_LAYERING_GOLDEN_REL_PATH: &str =
    "crates/kode-server/tests/golden/diagnostic-layering-parity.json";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GoldenFinding {
    check: String,
    severity: String,
    line: usize,
    offset: usize,
    length: usize,
    message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GoldenFile {
    file: String,
    finding_count: usize,
    findings: Vec<GoldenFinding>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GoldenStats {
    layer: &'static str,
    requested: u64,
    published: u64,
    skipped_current_version: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GoldenDump {
    generator: &'static str,
    file_count: usize,
    finding_count: usize,
    check_counts: BTreeMap<String, usize>,
    layer_counts: BTreeMap<&'static str, usize>,
    layer_for_check: BTreeMap<String, &'static str>,
    merged_publish_order: &'static [&'static str],
    replay_stats: Vec<GoldenStats>,
    files: Vec<GoldenFile>,
}

/// 语料分级装配快照:逐 def 文件跑全量 lint(production-shape knownTypes =
/// 引擎 type_context 实体名 + types.xml 自定义类型;inheritedNames 缺省 =
/// parity 规则零产出,诚实边界)、按决策表路由、逐层独立调度核回放
/// (request 立即通道,version=Some(1))。
pub fn dump_diagnostic_layering_golden(repo_root: &std::path::Path) -> String {
    use kode_parser::json::{collect_corpus, PARITY_CORPORA};

    let files = collect_corpus(repo_root, PARITY_CORPORA);
    let registry = crate::golden_corpus::corpus_registry();
    let mut engine = HoverEngine::new();
    for (path, (_kind, text)) in &files {
        engine.update(crate::golden_corpus::corpus_key(&registry, path), text);
    }
    let type_ctx = engine.type_context();
    let known: Vec<&str> = type_ctx
        .entity_types
        .iter()
        .chain(type_ctx.custom_types.iter())
        .map(|s| s.as_str())
        .collect();
    let mut dump = GoldenDump {
        generator: "kode-server dump-diagnostic-layering-golden",
        file_count: 0,
        finding_count: 0,
        check_counts: BTreeMap::new(),
        layer_counts: BTreeMap::new(),
        layer_for_check: BTreeMap::new(),
        merged_publish_order: MERGED_PUBLISH_ORDER,
        replay_stats: Vec::new(),
        files: Vec::new(),
    };
    let mut schedulers = LayeredSchedulers::new();
    for path in engine.corpus_defs.iter() {
        let Some(text) = engine.corpus_text(path) else {
            continue;
        };
        let findings = analyze_def_with_python(
            text,
            &InheritedNames::default(),
            &known,
            PythonParityInput::default(),
        )
        .expect("lint analyze");
        if findings.is_empty() {
            continue;
        }
        dump.file_count += 1;
        let mut golden_file = GoldenFile {
            file: path.clone(),
            finding_count: findings.len(),
            findings: Vec::new(),
        };
        let routed = route_findings(findings);
        for layer in DiagnosticLayer::ALL {
            let bucket = routed.bucket(layer);
            if bucket.is_empty() {
                continue;
            }
            let uri = format!("corpus://{path}");
            let items: Vec<u32> = (0..bucket.len() as u32).collect();
            schedulers.core(layer).request(
                &uri,
                Some(1),
                TaskSpec {
                    items,
                    async_id: None,
                    side_effects: Vec::new(),
                },
            );
            *dump.layer_counts.entry(layer.as_str()).or_insert(0) += bucket.len();
            for finding in bucket {
                *dump
                    .check_counts
                    .entry(finding.check.to_string())
                    .or_insert(0) += 1;
                dump.layer_for_check.insert(
                    finding.check.to_string(),
                    layer_for_check(finding.check).as_str(),
                );
                dump.finding_count += 1;
                golden_file.findings.push(GoldenFinding {
                    check: finding.check.to_string(),
                    severity: finding.severity.to_string(),
                    line: finding.line,
                    offset: finding.offset,
                    length: finding.length,
                    message: finding.message.clone(),
                });
            }
        }
        dump.files.push(golden_file);
    }
    for layer in DiagnosticLayer::ALL {
        let core = schedulers.core(layer);
        let stats = core.stats();
        dump.replay_stats.push(GoldenStats {
            layer: layer.as_str(),
            requested: stats.requested,
            published: stats.published,
            skipped_current_version: stats.skipped_current_version,
        });
    }
    serde_json::to_string_pretty(&dump).expect("golden JSON")
}

// ---------------------------------------------------------------------------
// 单元钉
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn finding(check: &'static str) -> Finding {
        Finding {
            check,
            code: check,
            severity: "error",
            line: 1,
            offset: 0,
            length: 1,
            name: None,
            message: format!("msg:{check}"),
            range: crate::lint::RangeFace {
                offset: 0,
                length: 1,
            },
            related: None,
        }
    }

    /// 决策表覆盖面:CHECK_CODES 全表可路由(现役 15 码 → LocalSyntax);
    /// 未知码保守路由 LocalSyntax(不丢产出)。
    #[test]
    fn layer_table_is_total_and_failsafe() {
        assert_eq!(
            CHECK_CODES.len(),
            15,
            "税表与 lint 规则数同步(新增规则双侧同表)"
        );
        for check in CHECK_CODES {
            assert_eq!(
                layer_for_check(check),
                DiagnosticLayer::LocalSyntax,
                "现状全本地语法层(家族迁移由 TS 装配批翻表)"
            );
        }
        assert_eq!(
            layer_for_check("not-a-real-check"),
            DiagnosticLayer::LocalSyntax
        );
    }

    /// 路由保序 + 桶隔离:同层 findings 顺序保持,不跨桶漂移。
    #[test]
    fn routing_preserves_order_within_buckets() {
        let findings = vec![
            finding("missing-type"),
            finding("phantom-type"),
            finding("missing-flags"),
        ];
        let routed = route_findings(findings);
        assert_eq!(routed.local_syntax.len(), 3);
        assert_eq!(routed.local_syntax[0].check, "missing-type");
        assert_eq!(routed.local_syntax[2].check, "missing-flags");
        assert!(
            routed.semantic.is_empty()
                && routed.engine_compat.is_empty()
                && routed.runtime_config.is_empty()
        );
    }

    /// 合流序:层名字节序(engineCompat < localSyntax < runtimeConfig <
    /// semantic);空层不产段。手工桶构造(决策表现役全 local,异层桶
    /// 只有手工可造——诚实边界)。
    #[test]
    fn merged_publish_concatenates_in_byte_order() {
        let mut schedulers = LayeredSchedulers::new();
        let task_for = |n: u32| TaskSpec {
            items: vec![n],
            async_id: None,
            side_effects: Vec::new(),
        };
        // 插入顺序故意反字节序:semantic → localSyntax → runtimeConfig。
        schedulers.semantic.request("u", Some(1), task_for(1));
        schedulers.local_syntax.request("u", Some(1), task_for(2));
        schedulers.runtime_config.request("u", Some(1), task_for(3));
        let merged = schedulers.merged_publish();
        let layers: Vec<&'static str> = merged
            .iter()
            .map(|record| match record {
                PublishRecord::Publish { layer, .. } => layer.as_str(),
                PublishRecord::ClearAll { .. } => unreachable!("无 clear 事件"),
            })
            .collect();
        assert_eq!(
            layers,
            vec!["localSyntax", "runtimeConfig", "semantic"],
            "字节序合流,engineCompat 空层不产段"
        );
        // 引擎兼容座位占位:手工占员后合流第一位。
        schedulers.engine_compat.request("u", Some(1), task_for(4));
        let merged = schedulers.merged_publish();
        let layers: Vec<&'static str> = merged
            .iter()
            .map(|record| match record {
                PublishRecord::Publish { layer, .. } => layer.as_str(),
                PublishRecord::ClearAll { .. } => unreachable!("无 clear 事件"),
            })
            .collect();
        assert_eq!(
            layers.first(),
            Some(&"engineCompat"),
            "engineCompat 字节序最前"
        );
    }

    /// 逐层独立节流(批 1 语义继承):同层同版跳过,跨层互不影响;
    /// stats 分层记账。
    #[test]
    fn per_layer_schedulers_are_independent() {
        let mut schedulers = LayeredSchedulers::new();
        let task = || TaskSpec {
            items: vec![0],
            async_id: None,
            side_effects: Vec::new(),
        };
        schedulers.local_syntax.request("a.def", Some(1), task());
        schedulers.local_syntax.request("a.def", Some(1), task());
        assert_eq!(
            schedulers.local_syntax.stats().skipped_current_version,
            1,
            "同层同版跳过"
        );
        assert_eq!(schedulers.local_syntax.stats().published, 1);
        // 跨层同 uri 同版本不受影响(local 已发布,semantic 首发照发布)。
        schedulers.semantic.request("a.def", Some(1), task());
        assert_eq!(schedulers.semantic.stats().published, 1, "层间独立节流");
        assert_eq!(schedulers.local_syntax.stats().published, 1);
        // 关一层不影响其余层。
        schedulers.runtime_config.set_enabled(false);
        schedulers.runtime_config.request("a.def", Some(1), task());
        assert_eq!(schedulers.runtime_config.stats().disabled_skipped, 1);
        schedulers.engine_compat.request("a.def", Some(1), task());
        assert_eq!(schedulers.engine_compat.stats().published, 1);
    }

    /// RUST-149 横切(stale 替位,装配面级):同层同 uri 版本换代即换发布
    /// (旧版不虚报);cancel/cold 对同步纯面 N-A 如实登记。
    #[test]
    fn version_bump_replaces_published_items() {
        let mut schedulers = LayeredSchedulers::new();
        schedulers.local_syntax.request(
            "a.def",
            Some(1),
            TaskSpec {
                items: vec![1, 2, 3],
                async_id: None,
                side_effects: Vec::new(),
            },
        );
        schedulers.local_syntax.request(
            "a.def",
            Some(2),
            TaskSpec {
                items: vec![9],
                async_id: None,
                side_effects: Vec::new(),
            },
        );
        let sink = schedulers.local_syntax.sink();
        assert_eq!(sink.len(), 2);
        let latest = match sink.last().expect("有发布") {
            PublishRecord::Publish { items, .. } => items.clone(),
            PublishRecord::ClearAll { .. } => unreachable!(),
        };
        assert_eq!(latest, vec![9], "换代后旧 items 不虚报");
    }
}
