//! Diagnostic-tiering assembly decision core (RUST-142 batch 2; the pure-library half of the TS production four-family assembly batch).
//!
//! Batch 1 (diagnostic_pipeline.rs) delivered the 12-counter scheduling state-machine replay core plus
//! the four-family layer model (layer_for_family). This batch wires the **real lint family tax table** into the four layers:
//! the 15 active check codes of `lint::Finding.check` -> four-layer routing (currently all
//! LocalSyntax -- the production TS layer enum is still local|semantic, and the diagnostic face's rust serving leg
//! (observeRustDefFindings/mergeRustDefFindings) treats these findings as local
//! def-validation union; the semantic/engineCompat/runtimeConfig three seats are the target design
//! faces; the family migration hands the table flip to the TS assembly batch, while this face locks only "table + routing + merge order").
//!
//! Merge order = batch 1 golden's same layer-name byte order (engineCompat < localSyntax <
//! runtimeConfig < semantic); each layer has an independent DiagnosticSchedulerCore (request
//! immediate channel, version-same-skip semantics all inherited from the batch 1 replay core).
//!
//! Honest boundary (registered, not disguised): the current tiering is an **all-LocalSyntax constant table** -- the observable face of
//! four-layer routing (cross-layer bucket placement / merge interleaving) is indistinguishable on the corpus, closed by synthetic pins +
//! merged_publish manual-bucket pins; the real occupants of the engineCompat seat (the def md5
//! compat face) and of the runtimeConfig seat (the TS configContract family) belong to their own lanes' wiring
//! when they are wired in. The didChange production wiring + LSP publishDiagnostics stay with the wiring batch; this batch
//! touches zero of server.rs -- the pure library stays unchanged.

use std::collections::BTreeMap;

use serde::Serialize;

use crate::diagnostic_pipeline::{
    DiagnosticLayer, DiagnosticSchedulerCore, PublishRecord, TaskSpec,
};
use crate::hover::HoverEngine;
use crate::lint::{analyze_def_with_python, Finding, InheritedNames, PythonParityInput};

/// Full table of active lint check codes (lint/rules.rs, 15 rules; new rules synced on both sides --
/// this table is the family tax source for the four-family assembly; the TS mirror tests/kodeDiagnosticLayeringParity
/// compares on the same table).
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

/// Family -> layer decision table (RUST-142 batch 3a: the four families' real occupants enter the table -- layered by "the check's computational dependency"
/// not by message semantics: the layer = the working domain / cadence needed to recompute that diagnostic, throttled independently).
///
/// - LocalSyntax: single-def self-contained, cheap, per-keystroke recomputable structure/vocabulary/scope checks
///   (12 codes: duplicate tag / duplicate definition / keyword name / missing Type / missing Flags / flag and detail vocabularies /
///   redundant DetailLevel / ALL_CLIENTS + large payload combination / method and property name collision / engine-restricted names /
///   engine-unregistered phantom types -- although the last two codes carry "engine rejects it" semantics, their judgement is a static
///   vocabulary with zero index and zero engine version, so by computational domain they belong to the local layer);
/// - Semantic: checks needing workspace resolution (index / types.xml registry / inheritance chain / Python parity)
///   (3 codes: def-method-missing-in-python / inherited-name-collision /
///   unknown-type-reference);
/// - EngineCompat / RuntimeConfig: no occupants in this table -- per the batch 2 honest boundary, the two seats
///   belong to their own lanes (engineCompat = the def md5 compat face, runtimeConfig =
///   the configContract family), entering the table when the family migrates.
///
/// Unknown check codes route conservatively to LocalSyntax (no output lost).
pub fn layer_for_check(check: &str) -> DiagnosticLayer {
    match check {
        // Needs workspace resolution (types.xml registry / inheritance chain / Python parity).
        "def-method-missing-in-python" | "inherited-name-collision" | "unknown-type-reference" => {
            DiagnosticLayer::Semantic
        }
        // All other active codes are single-def self-contained static judgements -> the local syntax layer.
        _ => DiagnosticLayer::LocalSyntax,
    }
}

/// Four-layer name merge order = batch 1 golden's same byte order (the publishLog concatenation stance).
pub const MERGED_PUBLISH_ORDER: &[&str] =
    &["engineCompat", "localSyntax", "runtimeConfig", "semantic"];

/// Per-layer routing buckets (order-preserving; produced by route_findings, consumed by merged_publish).
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

/// Route all findings through the decision table (order-preserving bucket insertion).
pub fn route_findings(findings: Vec<Finding>) -> LayeredFindings {
    let mut out = LayeredFindings::default();
    for finding in findings {
        let layer = layer_for_check(finding.check);
        out.bucket_mut(layer).push(finding);
    }
    out
}

/// Per-layer scheduler core group (independent throttling semantics = the batch 1 replay core; the four layers do not affect each other).
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

    /// Merged publish face: the four layer sinks are concatenated in layer-name byte order (the publishLog concatenation stance).
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
// golden fourth face (real corpus distribution + decision-table snapshot + per-layer independent replay)
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

/// Corpus tiering-assembly snapshot: run full lint per def file (production-shape knownTypes =
/// engine type_context entity names + types.xml custom types; inheritedNames defaults to
/// zero output from the parity rule, honest boundary), route by the decision table, and replay per-layer independent scheduler cores
/// (request immediate channel, version=Some(1)).
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
// Unit pins
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

    /// Decision-table coverage: the full CHECK_CODES table is routable (batch 3a real occupants: 12 local +
    /// 3 semantic; the engineCompat/runtimeConfig two seats belong to the def-md5/configContract
    /// lanes); unknown codes route conservatively to LocalSyntax (no output lost).
    #[test]
    fn layer_table_is_total_and_failsafe() {
        assert_eq!(
            CHECK_CODES.len(),
            15,
            "税表与 lint 规则数同步(新增规则双侧同表)"
        );
        const SEMANTIC_CODES: &[&str] = &[
            "def-method-missing-in-python",
            "inherited-name-collision",
            "unknown-type-reference",
        ];
        for check in CHECK_CODES {
            let expected = if SEMANTIC_CODES.contains(check) {
                DiagnosticLayer::Semantic
            } else {
                DiagnosticLayer::LocalSyntax
            };
            assert_eq!(
                layer_for_check(check),
                expected,
                "码 {check} 应按计算域分层(语义=需工作区解析,其余本地)"
            );
        }
        assert_eq!(
            layer_for_check("not-a-real-check"),
            DiagnosticLayer::LocalSyntax
        );
    }

    /// Order-preserving routing + bucket isolation: same-layer findings keep their order, no cross-bucket drift.
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

    /// Merge order: layer-name byte order (engineCompat < localSyntax < runtimeConfig <
    /// semantic); empty layers produce no segment. Buckets built by hand (the decision table's active codes are all local, so cross-layer buckets
    /// can only be built by hand -- honest boundary).
    #[test]
    fn merged_publish_concatenates_in_byte_order() {
        let mut schedulers = LayeredSchedulers::new();
        let task_for = |n: u32| TaskSpec {
            items: vec![n],
            async_id: None,
            side_effects: Vec::new(),
        };
        // Insertion order deliberately reversed from byte order: semantic -> localSyntax -> runtimeConfig.
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
        // Engine-compat seat occupancy: after a manual occupant it merges first.
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

    /// Per-layer independent throttling (batch 1 semantics inherited): same-layer same-version skips, cross-layer independence;
    /// stats is accounted per layer.
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
        // Same uri same version across layers is unaffected (local already published; semantic still publishes its first).
        schedulers.semantic.request("a.def", Some(1), task());
        assert_eq!(schedulers.semantic.stats().published, 1, "层间独立节流");
        assert_eq!(schedulers.local_syntax.stats().published, 1);
        // Closing one layer does not affect the other layers.
        schedulers.runtime_config.set_enabled(false);
        schedulers.runtime_config.request("a.def", Some(1), task());
        assert_eq!(schedulers.runtime_config.stats().disabled_skipped, 1);
        schedulers.engine_compat.request("a.def", Some(1), task());
        assert_eq!(schedulers.engine_compat.stats().published, 1);
    }

    /// RUST-149 cross-cutting (stale replacement, at the assembly-face level): same-layer same-uri version change means a new publish
    /// (the old version is never falsely reported); cancel/cold are honestly registered as N-A for this synchronous pure face.
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
