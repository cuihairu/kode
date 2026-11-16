//! python call-at 对拍 golden 重生成比对(Rust 侧真值;TS 侧
//! tests/kodePythonCallAtParity.test.ts import 生产函数复算同一 golden,
//! 双向对拍,document symbols golden 同构)。

use kode_server::dump_python_call_at_golden;

fn repo_root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .canonicalize()
        .expect("repo root")
}

#[test]
fn python_call_at_golden_matches_regenerated_dump() {
    let regenerated = dump_python_call_at_golden(&repo_root());
    let golden_path = repo_root().join(kode_server::python_call_at::PYTHON_CALL_AT_GOLDEN_REL_PATH);
    let committed = std::fs::read_to_string(&golden_path)
        .expect("golden 文件缺失: crates/kode-server/tests/golden/python-call-at-parity.json");
    let committed = committed.trim_end_matches('\n');
    if regenerated != committed {
        let diff_at = regenerated
            .char_indices()
            .zip(committed.char_indices())
            .find(|((_, a), (_, b))| a != b)
            .map(|((i, _), _)| i)
            .unwrap_or(0);
        panic!(
            "python call-at golden 与重生成不一致(偏移 {diff_at})。\n重新运行:\n  cargo run -p kode-server --bin dump-python-call-at-golden -- . > crates/kode-server/tests/golden/python-call-at-parity.json"
        );
    }
    assert!(committed.contains("\"hitCount\":"));
    assert!(committed.contains("dump-python-call-at-golden"));
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Dump {
    #[allow(dead_code)]
    file_count: usize,
    probe_count: usize,
    hit_count: usize,
    files: Vec<GoldenFile>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoldenFile {
    #[allow(dead_code)]
    file: String,
    probe_count: usize,
    #[serde(default)]
    hits: Vec<serde_json::Value>,
}

#[test]
fn python_call_at_golden_structure_is_complete() {
    let committed = std::fs::read_to_string(
        repo_root().join(kode_server::python_call_at::PYTHON_CALL_AT_GOLDEN_REL_PATH),
    )
    .expect("golden");
    let value: Dump = serde_json::from_str(committed.trim_end_matches('\n')).expect("golden JSON 合法");
    assert!(value.probe_count > 0, "probeCount 为空:语料上应探测过");
    assert!(value.hit_count > 0, "hitCount 为空:语料上应有调用命中");
    let total_probes: usize = value.files.iter().map(|f| f.probe_count).sum();
    assert_eq!(total_probes, value.probe_count, "probeCount 与逐文件和不一致");
    let total_hits: usize = value.files.iter().map(|f| f.hits.len()).sum();
    assert_eq!(total_hits, value.hit_count, "hitCount 与逐文件和不一致");
    for file in &value.files {
        for hit in &file.hits {
            assert!(hit["line"].is_u64() && hit["character"].is_u64(), "命中缺行/列: {hit}");
            assert!(hit["receiverName"].is_string(), "命中缺 receiverName: {hit}");
            assert!(hit["methodName"].is_string(), "命中缺 methodName: {hit}");
            assert!(
                hit["section"].is_null() || hit["section"].is_string(),
                "命中 section 既非 null 也非字符串: {hit}"
            );
            assert!(hit["activeArgument"].is_u64(), "命中缺 activeArgument: {hit}");
        }
    }
}
