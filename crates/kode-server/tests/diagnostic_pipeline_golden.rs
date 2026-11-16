//! 诊断调度状态机回放 golden 重生成比对(Rust 侧真值;TS 侧
//! tests/kodeDiagnosticPipelineParity.test.ts 读 golden traces 驱动生产
//! DiagnosticScheduler 复算对拍 outcomes,双向门禁)。

use kode_server::dump_diagnostic_pipeline_golden;

fn repo_root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .canonicalize()
        .expect("repo root")
}

#[test]
fn diagnostic_pipeline_golden_matches_regenerated_dump() {
    let regenerated = dump_diagnostic_pipeline_golden();
    let golden_path = repo_root().join(kode_server::diagnostic_pipeline::DIAGNOSTIC_PIPELINE_GOLDEN_REL_PATH);
    let committed = std::fs::read_to_string(&golden_path)
        .expect("golden 文件缺失: crates/kode-server/tests/golden/diagnostic-pipeline-parity.json");
    let committed = committed.trim_end_matches('\n');
    if regenerated != committed {
        let diff_at = regenerated
            .char_indices()
            .zip(committed.char_indices())
            .find(|((_, a), (_, b))| a != b)
            .map(|((i, _), _)| i)
            .unwrap_or(0);
        panic!(
            "diagnostic pipeline golden 与重生成不一致(偏移 {diff_at})。\n重新运行:\n  cargo run -p kode-server --bin dump-diagnostic-pipeline-golden > crates/kode-server/tests/golden/diagnostic-pipeline-parity.json"
        );
    }
    assert!(committed.contains("\"traceCount\":"));
    assert!(committed.contains("dump-diagnostic-pipeline-golden"));
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Golden {
    #[allow(dead_code)]
    generator: String,
    trace_count: usize,
    traces: Vec<serde_json::Value>,
    outcomes: Vec<serde_json::Value>,
}

#[test]
fn diagnostic_pipeline_golden_structure_is_complete() {
    let committed = std::fs::read_to_string(
        repo_root().join(kode_server::diagnostic_pipeline::DIAGNOSTIC_PIPELINE_GOLDEN_REL_PATH),
    )
    .expect("golden");
    let value: Golden = serde_json::from_str(committed.trim_end_matches('\n')).expect("golden JSON 合法");
    assert!(value.trace_count >= 12, "语料应覆盖全部 12 计数器与管线面");
    assert_eq!(value.traces.len(), value.trace_count, "迹数与 traceCount 一致");
    assert_eq!(value.outcomes.len(), value.trace_count, "产出数与 traceCount 一致");
    let layer_keys = ["localSyntax", "semantic", "engineCompat", "runtimeConfig"];
    // 12 计数器覆盖审计:全部计数器在语料里至少被点亮一次
    let counter_keys = [
        "requested",
        "computed",
        "published",
        "coalescedStale",
        "staleDropped",
        "releasedDropped",
        "skippedCurrentVersion",
        "disabledSkipped",
        "disabledAsyncDropped",
        "staleGenerationDropped",
        "errored",
        "cleared",
    ];
    let mut lit = std::collections::BTreeSet::new();
    for outcome in &value.outcomes {
        let stats = outcome["stats"].as_object().expect("stats object");
        assert_eq!(stats.len(), 4, "四层管线统计齐备");
        for (layer, per) in stats {
            assert!(
                layer_keys.contains(&layer.as_str()),
                "层名非法: {layer}"
            );
            for key in counter_keys {
                if per[key].as_u64().unwrap_or(0) > 0 {
                    lit.insert(key);
                }
            }
        }
        // 每条产出:发布记录层名合法、workload 四层齐备
        for record in outcome["publishLog"].as_array().expect("publishLog") {
            let op = record["op"].as_str().expect("record op");
            assert!(op == "publish" || op == "clearAll", "发布记录 op 非法: {op}");
            if op == "publish" {
                let layer = record["layer"].as_str().expect("layer");
                assert!(layer_keys.contains(&layer), "发布层名非法: {layer}");
                assert!(record["items"].is_array(), "发布缺 items: {record}");
                assert!(record["uri"].is_string(), "发布缺 uri: {record}");
            }
        }
        let workload = outcome["workload"].as_object().expect("workload");
        assert_eq!(workload.len(), 4, "四层残留量规齐备");
        for (layer, per) in workload {
            assert!(layer_keys.contains(&layer.as_str()), "量规层名非法: {layer}");
            assert!(per["queued"].is_u64() && per["inFlight"].is_u64(), "量规字段缺: {per}");
        }
    }
    for key in counter_keys {
        assert!(lit.contains(key), "计数器 {key} 未被任何迹点亮");
    }
}
