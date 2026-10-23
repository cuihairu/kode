//! diagnostics 对拍 golden 重生成比对(Rust 侧真值;TS 侧
//! tests/kodeDiagnosticsParity.test.ts 复算同一 golden,双向门禁同构)。

use kode_server::dump_diagnostics_golden;

fn repo_root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .canonicalize()
        .expect("repo root")
}

#[test]
fn diagnostics_golden_matches_regenerated_dump() {
    let regenerated = dump_diagnostics_golden(&repo_root());
    let golden_path = repo_root().join(kode_server::diagnostics::GOLDEN_REL_PATH);
    let committed = std::fs::read_to_string(&golden_path)
        .expect("golden 文件缺失: crates/kode-server/tests/golden/diagnostics-parity.json");
    let committed = committed.trim_end_matches('\n');
    if regenerated != committed {
        let diff_at = regenerated
            .char_indices()
            .zip(committed.char_indices())
            .find(|((_, a), (_, b))| a != b)
            .map(|((i, _), _)| i)
            .unwrap_or(0);
        panic!(
            "diagnostics golden 与重生成不一致(偏移 {diff_at})。\n重新运行:\n  cargo run -p kode-server --bin dump-diagnostics-golden -- . > crates/kode-server/tests/golden/diagnostics-parity.json"
        );
    }
    assert!(committed.contains("\"diagnosticCount\":"));
    assert!(committed.contains("dump-diagnostics-golden"));
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Dump {
    #[allow(dead_code)]
    file_count: usize,
    diagnostic_count: usize,
    files: Vec<GoldenFile>,
}

#[derive(serde::Deserialize)]
struct GoldenFile {
    #[allow(dead_code)]
    file: String,
    diagnostics: Vec<serde_json::Value>,
}

#[test]
fn diagnostics_golden_structure_is_complete() {
    let committed =
        std::fs::read_to_string(repo_root().join(kode_server::diagnostics::GOLDEN_REL_PATH))
            .expect("golden");
    let value: Dump =
        serde_json::from_str(committed.trim_end_matches('\n')).expect("golden JSON 合法");
    let total: usize = value.files.iter().map(|f| f.diagnostics.len()).sum();
    assert_eq!(
        total, value.diagnostic_count,
        "diagnosticCount 与逐文件和不一致"
    );
    // 键形:range(start/end line/character) + severity(1..3) + message。
    for file in &value.files {
        for diagnostic in &file.diagnostics {
            assert!(
                diagnostic["range"]["start"]["line"].is_u64(),
                "区间键形: {diagnostic}"
            );
            let severity = diagnostic["severity"].as_u64().expect("severity");
            assert!((1..=3).contains(&severity), "severity 越界: {diagnostic}");
            assert!(
                diagnostic["message"].is_string(),
                "message 键形: {diagnostic}"
            );
        }
    }
}
