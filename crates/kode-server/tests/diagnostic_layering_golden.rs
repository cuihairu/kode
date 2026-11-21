//! 诊断分级装配 golden 重生成比对(RUST-142 批 2;Rust 侧真值;TS 侧
//! tests/kodeDiagnosticLayeringParity.test.ts 复算决策表/合流序/production
//! seam 对拍,diagnostic-pipeline 同构)。

use kode_server::diagnostic_layering::{CHECK_CODES, DIAGNOSTIC_LAYERING_GOLDEN_REL_PATH};
use kode_server::dump_diagnostic_layering_golden;

fn repo_root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .canonicalize()
        .expect("repo root")
}

#[test]
fn diagnostic_layering_golden_matches_regenerated_dump() {
    let regenerated = dump_diagnostic_layering_golden(&repo_root());
    let golden_path = repo_root().join(DIAGNOSTIC_LAYERING_GOLDEN_REL_PATH);
    let committed = std::fs::read_to_string(&golden_path)
        .expect("golden 文件缺失: crates/kode-server/tests/golden/diagnostic-layering-parity.json");
    let committed = committed.trim_end_matches('\n');
    if regenerated != committed {
        let diff_at = regenerated
            .char_indices()
            .zip(committed.char_indices())
            .find(|((_, a), (_, b))| a != b)
            .map(|((i, _), _)| i)
            .unwrap_or(0);
        panic!(
            "diagnostic layering golden 与重生成不一致(偏移 {diff_at})。\n重新运行:\n  cargo run -p kode-server --bin dump-diagnostic-layering-golden -- . > crates/kode-server/tests/golden/diagnostic-layering-parity.json"
        );
    }
    assert!(committed.contains("\"findingCount\":"));
    assert!(committed.contains("dump-diagnostic-layering-golden"));
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Dump {
    #[allow(dead_code)]
    generator: String,
    file_count: usize,
    finding_count: usize,
    check_counts: std::collections::BTreeMap<String, usize>,
    layer_counts: std::collections::BTreeMap<String, usize>,
    layer_for_check: std::collections::BTreeMap<String, String>,
    merged_publish_order: Vec<String>,
    replay_stats: Vec<GoldenStats>,
    files: Vec<GoldenFile>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoldenStats {
    layer: String,
    requested: u64,
    published: u64,
    skipped_current_version: u64,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoldenFile {
    #[allow(dead_code)]
    file: String,
    finding_count: usize,
    findings: Vec<GoldenFinding>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoldenFinding {
    check: String,
    severity: String,
    line: usize,
    #[allow(dead_code)]
    offset: usize,
    #[allow(dead_code)]
    length: usize,
    #[allow(dead_code)]
    message: String,
}

/// lint 侧 severity 词表(rules.rs 系 "error"/"warning"/"info";非 LSP
/// 词表——LSP 映射是接线批 TS 薄壳的事)。
const SEVERITIES: &[&str] = &["error", "warning", "info"];
const LAYERS: &[&str] = &["localSyntax", "semantic", "engineCompat", "runtimeConfig"];

#[test]
fn diagnostic_layering_golden_structure_is_complete() {
    let committed = std::fs::read_to_string(repo_root().join(DIAGNOSTIC_LAYERING_GOLDEN_REL_PATH))
        .expect("golden");
    let value: Dump = serde_json::from_str(committed.trim_end_matches('\n')).expect("golden JSON");

    // 计数守恒四面对账:findingCount = 逐文件和 = checkCounts 和 = layerCounts 和。
    let file_sum: usize = value.files.iter().map(|f| f.finding_count).sum();
    let check_sum: usize = value.check_counts.values().sum();
    let layer_sum: usize = value.layer_counts.values().sum();
    let findings_len: usize = value.files.iter().map(|f| f.findings.len()).sum();
    assert_eq!(value.finding_count, file_sum, "findingCount 与逐文件和对账");
    assert_eq!(
        value.finding_count, findings_len,
        "findingCount 与逐条目和对账"
    );
    assert_eq!(
        value.finding_count, check_sum,
        "findingCount 与 checkCounts 和对账"
    );
    assert_eq!(
        value.finding_count, layer_sum,
        "findingCount 与 layerCounts 和对账"
    );
    assert!(value.finding_count > 0, "语料应有真实命中分布");
    assert!(
        value.file_count > 0 && value.file_count < engine_corpus_defs_floor(),
        "fileCount < 全 def 数(部分文件零命中)"
    );

    // 决策表:逐条 finding 的 check ∈ 在役税表,层 == 表值,层值域四名。
    for file in &value.files {
        for finding in &file.findings {
            assert!(
                CHECK_CODES.contains(&finding.check.as_str()),
                "税表外 check: {}",
                finding.check
            );
            let layer = value
                .layer_for_check
                .get(&finding.check)
                .expect("决策表逐码在场");
            assert!(LAYERS.contains(&layer.as_str()), "层值越界: {layer}");
        }
        for (check, layer) in &value.layer_for_check {
            assert!(LAYERS.contains(&layer.as_str()));
            assert!(
                CHECK_CODES.contains(&check.as_str()),
                "决策表码越界: {check}"
            );
        }
        for finding in &file.findings {
            assert!(
                SEVERITIES.contains(&finding.severity.as_str()),
                "severity 越界"
            );
            assert!(finding.line >= 1, "行号 1-based");
        }
    }

    // 合流序 = 批 1 golden 同款字节序(逐字节钉)。
    assert_eq!(
        value.merged_publish_order,
        vec!["engineCompat", "localSyntax", "runtimeConfig", "semantic"]
    );

    // 逐层独立回放记账:每层「命中文件数」= 该层至少一条 finding 的文件数;
    // 立即通道每命中文件一请求一发布(批 3a 真占员:localSyntax/semantic
    // 各按其命中文件计,engineCompat/runtimeConfig 语料无占员零请求)。
    let mut by_layer = std::collections::BTreeMap::new();
    for stats in &value.replay_stats {
        by_layer.insert(stats.layer.as_str(), stats);
        assert!(LAYERS.contains(&stats.layer.as_str()));
    }
    assert_eq!(by_layer.len(), 4, "四层记账齐");
    let mut hit_files: std::collections::BTreeMap<&str, std::collections::BTreeSet<&str>> =
        std::collections::BTreeMap::new();
    for file in &value.files {
        for finding in &file.findings {
            let layer = value
                .layer_for_check
                .get(&finding.check)
                .expect("决策表逐码在场");
            hit_files.entry(layer.as_str()).or_default().insert(&file.file);
        }
    }
    for stats in &value.replay_stats {
        let expected = hit_files.get(stats.layer.as_str()).map_or(0, |s| s.len());
        assert_eq!(
            stats.requested as usize, expected,
            "{} 命中文件数(每命中文件一请求)",
            stats.layer
        );
        assert_eq!(
            stats.published, stats.requested,
            "{} 立即通道逐请求发布",
            stats.layer
        );
        assert_eq!(
            stats.skipped_current_version, 0,
            "{} 回放每次独立核无同版跳过",
            stats.layer
        );
    }

    // 真分布钉:≥2 个 check 家族在场(分类面退化成单码会红)。
    assert!(value.check_counts.len() >= 2, "语料应命中多家族");
}

/// 语料 def 总量下界探测(防 fileCount 恒等全集的退化;真值由 dump 侧
/// corpus_defs 决定,这里只锁「有跳过」的事实)。
fn engine_corpus_defs_floor() -> usize {
    40
}
