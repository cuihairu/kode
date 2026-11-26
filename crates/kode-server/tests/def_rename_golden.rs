//! def 重命名对拍 golden 重生成比对(Rust 侧真值;TS 侧
//! tests/kodeDefRenameParity.test.ts import 生产 defRenamer 函数复算同一
//! golden,双向对拍,python-call-at golden 同构)。

use kode_server::dump_def_rename_golden;

fn repo_root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .canonicalize()
        .expect("repo root")
}

#[test]
fn def_rename_golden_matches_regenerated_dump() {
    let regenerated = dump_def_rename_golden(&repo_root());
    let golden_path = repo_root().join(kode_server::def_rename::DEF_RENAME_GOLDEN_REL_PATH);
    let committed = std::fs::read_to_string(&golden_path)
        .expect("golden 文件缺失: crates/kode-server/tests/golden/def-rename-parity.json");
    let committed = committed.trim_end_matches('\n');
    if regenerated != committed {
        let diff_at = regenerated
            .char_indices()
            .zip(committed.char_indices())
            .find(|((_, a), (_, b))| a != b)
            .map(|((i, _), _)| i)
            .unwrap_or(0);
        panic!(
            "def rename golden 与重生成不一致(偏移 {diff_at})。\n重新运行:\n  cargo run -p kode-server --bin dump-def-rename-golden -- . > crates/kode-server/tests/golden/def-rename-parity.json"
        );
    }
    assert!(committed.contains("\"symbolHitCount\":"));
    assert!(committed.contains("dump-def-rename-golden"));
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Dump {
    workspace_count: usize,
    def_file_count: usize,
    symbol_hit_count: usize,
    analysis_count: usize,
    closure_check_count: usize,
    workspaces: Vec<GoldenWorkspace>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoldenWorkspace {
    #[allow(dead_code)]
    root: Option<String>,
    files: Vec<GoldenFileEntry>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoldenFileEntry {
    #[allow(dead_code)]
    file: String,
    probe_count: usize,
    symbol_hits: Vec<serde_json::Value>,
    analyses: Vec<serde_json::Value>,
}

#[test]
fn def_rename_golden_structure_is_complete() {
    let committed = std::fs::read_to_string(
        repo_root().join(kode_server::def_rename::DEF_RENAME_GOLDEN_REL_PATH),
    )
    .expect("golden");
    let value: Dump =
        serde_json::from_str(committed.trim_end_matches('\n')).expect("golden JSON 合法");
    assert!(value.workspace_count >= 1, "语料应产出至少一个工作区根");
    assert!(value.def_file_count >= 1, "语料应含 .def 文件");
    assert!(
        value.symbol_hit_count > 0,
        "symbolHitCount 为空:语料上应有可重命名符号"
    );
    assert!(
        value.analysis_count > 0,
        "analysisCount 为空:语料上应有符号分析"
    );
    assert!(
        value.closure_check_count > 0,
        "closureCheckCount 为空:语料上应跑过闭包候选"
    );
    let total_files: usize = value.workspaces.iter().map(|w| w.files.len()).sum();
    assert_eq!(
        total_files, value.def_file_count,
        "文件数与逐工作区和不一致"
    );
    let total_probes: usize = value
        .workspaces
        .iter()
        .map(|w| w.files.iter().map(|f| f.probe_count).sum::<usize>())
        .sum();
    assert!(total_probes > 0, "probeCount 全零");
    let total_hits: usize = value
        .workspaces
        .iter()
        .map(|w| w.files.iter().map(|f| f.symbol_hits.len()).sum::<usize>())
        .sum();
    assert_eq!(
        total_hits, value.symbol_hit_count,
        "symbolHitCount 与逐文件和不一致"
    );
    let total_analyses: usize = value
        .workspaces
        .iter()
        .map(|w| w.files.iter().map(|f| f.analyses.len()).sum::<usize>())
        .sum();
    assert_eq!(
        total_analyses, value.analysis_count,
        "analysisCount 与逐文件和不一致"
    );
    let total_closure: usize = value
        .workspaces
        .iter()
        .map(|w| {
            w.files
                .iter()
                .map(|f| {
                    f.analyses
                        .iter()
                        .map(|a| a["closureChecks"].as_array().map(Vec::len).unwrap_or(0))
                        .sum::<usize>()
                })
                .sum::<usize>()
        })
        .sum();
    assert_eq!(
        total_closure, value.closure_check_count,
        "closureCheckCount 与逐条目和不一致"
    );
    for workspace in &value.workspaces {
        for file in &workspace.files {
            assert!(file.probe_count > 0, "probeCount 为零: {}", file.file);
            for hit in &file.symbol_hits {
                assert!(hit["offset"].is_u64(), "命中缺 offset: {hit}");
                assert!(
                    hit["kind"] == "property" || hit["kind"] == "method",
                    "命中 kind 非法: {hit}"
                );
                assert!(
                    hit["section"].is_null() || hit["section"].is_string(),
                    "命中 section 既非 null 也非字符串: {hit}"
                );
                assert!(hit["name"].is_string(), "命中缺 name: {hit}");
                assert!(
                    hit["wordStart"].is_u64() && hit["wordEnd"].is_u64(),
                    "命中缺词区间: {hit}"
                );
            }
            for analysis in &file.analyses {
                assert!(
                    analysis["conflictChecks"].is_array(),
                    "分析缺 conflictChecks: {analysis}"
                );
                assert!(analysis["edits"].is_array(), "分析缺 edits: {analysis}");
                assert!(
                    analysis["closureChecks"].is_array(),
                    "分析缺 closureChecks: {analysis}"
                );
                for edit in analysis["edits"].as_array().unwrap() {
                    assert!(edit["file"].is_string(), "编辑缺 file: {edit}");
                    assert!(
                        edit["ranges"].is_array() && !edit["ranges"].as_array().unwrap().is_empty(),
                        "编辑缺区间: {edit}"
                    );
                }
            }
        }
    }
}
