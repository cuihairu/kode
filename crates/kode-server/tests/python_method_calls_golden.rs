//! python 方法调用层次决策核 golden 重生成比对(Rust 侧真值;TS 侧
//! tests/kodePythonMethodCallsParity.test.ts 读 corpus+probes 驱动生产函数
//! 复算对拍 outcomes,双向门禁)。

use kode_server::python_method_calls;

fn repo_root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .canonicalize()
        .expect("repo root")
}

#[test]
fn python_method_calls_golden_matches_regenerated_dump() {
    let regenerated = python_method_calls::dump_python_method_calls_golden();
    let golden_path = repo_root().join(python_method_calls::GOLDEN_REL_PATH);
    let committed = std::fs::read_to_string(&golden_path)
        .expect("golden 文件缺失: crates/kode-server/tests/golden/python-method-calls-parity.json");
    let committed = committed.trim_end_matches('\n');
    if regenerated != committed {
        let diff_at = regenerated
            .char_indices()
            .zip(committed.char_indices())
            .find(|((_, a), (_, b))| a != b)
            .map(|((i, _), _)| i)
            .unwrap_or(0);
        panic!(
            "python method calls golden 与重生成不一致(偏移 {diff_at})。\n重新运行:\n  cargo run -p kode-server --bin dump-python-method-calls-golden > crates/kode-server/tests/golden/python-method-calls-parity.json"
        );
    }
    assert!(committed.contains("\"generator\":\"dump-python-method-calls-golden\""));
    assert!(committed.contains("\"probes\":["));
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Golden {
    #[allow(dead_code)]
    generator: String,
    corpus: Vec<serde_json::Value>,
    probes: Vec<serde_json::Value>,
    outcomes: Vec<serde_json::Value>,
}

#[test]
fn python_method_calls_golden_structure_is_complete() {
    let committed = std::fs::read_to_string(repo_root().join(python_method_calls::GOLDEN_REL_PATH))
        .expect("golden");
    let value: Golden =
        serde_json::from_str(committed.trim_end_matches('\n')).expect("golden JSON 合法");
    assert!(value.corpus.len() >= 8, "语料应覆盖三进程同构/盲区/边界族");
    let mut indexed = 0;
    for entry in &value.corpus {
        assert!(
            entry["name"].is_string() && entry["text"].is_string() && entry["fsPath"].is_string(),
            "语料条目形: {entry}"
        );
        assert!(
            entry["inIndex"].is_boolean(),
            "语料条目须标 inIndex: {entry}"
        );
        if entry["inIndex"].as_bool().unwrap_or(false) {
            indexed += 1;
        }
    }
    assert!(indexed >= 6, "索引语料规模");
    assert_eq!(
        value.probes.len(),
        value.outcomes.len(),
        "探测数与产出数一致"
    );
    assert!(
        value.probes.len() >= 12,
        "探测面规模(outgoing 8 + incoming 4)"
    );
    let mut lit = std::collections::BTreeSet::new();
    for probe in &value.probes {
        lit.insert(probe["face"].as_str().expect("probe face").to_string());
    }
    for face in ["outgoing", "incoming"] {
        assert!(lit.contains(face), "探测面 {face} 未被覆盖");
    }
    for outcome in &value.outcomes {
        let face = outcome["face"].as_str().expect("outcome face");
        if face == "outgoing" {
            assert!(
                outcome["references"].is_array(),
                "outgoing 产出形: {outcome}"
            );
        } else if face == "incoming" {
            assert!(outcome["incoming"].is_array(), "incoming 产出形: {outcome}");
            for hit in outcome["incoming"].as_array().expect("array") {
                assert!(
                    hit["caller"]["filePath"].is_string(),
                    "incoming 命中形: {hit}"
                );
                assert!(hit["callLine"].is_u64(), "incoming 调用行: {hit}");
            }
        } else {
            panic!("未知产出面: {face}");
        }
    }
}
