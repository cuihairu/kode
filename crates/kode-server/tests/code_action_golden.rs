//! CodeAction 决策核 golden 重生成比对(Rust 侧真值;TS 侧
//! tests/kodeCodeActionParity.test.ts 读 corpus+probes 驱动生产函数复算
//! 对拍 outcomes,双向门禁)。

use kode_server::dump_code_action_golden;

fn repo_root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .canonicalize()
        .expect("repo root")
}

#[test]
fn code_action_golden_matches_regenerated_dump() {
    let regenerated = dump_code_action_golden();
    let golden_path = repo_root().join(kode_server::code_action::CODE_ACTION_GOLDEN_REL_PATH);
    let committed = std::fs::read_to_string(&golden_path)
        .expect("golden 文件缺失: crates/kode-server/tests/golden/code-action-parity.json");
    let committed = committed.trim_end_matches('\n');
    if regenerated != committed {
        let diff_at = regenerated
            .char_indices()
            .zip(committed.char_indices())
            .find(|((_, a), (_, b))| a != b)
            .map(|((i, _), _)| i)
            .unwrap_or(0);
        panic!(
            "code action golden 与重生成不一致(偏移 {diff_at})。\n重新运行:\n  cargo run -p kode-server --bin dump-code-action-golden > crates/kode-server/tests/golden/code-action-parity.json"
        );
    }
    assert!(committed.contains("\"generator\":\"dump-code-action-golden\""));
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
fn code_action_golden_structure_is_complete() {
    let committed = std::fs::read_to_string(
        repo_root().join(kode_server::code_action::CODE_ACTION_GOLDEN_REL_PATH),
    )
    .expect("golden");
    let value: Golden = serde_json::from_str(committed.trim_end_matches('\n')).expect("golden JSON 合法");
    // 语料规模与自含性
    assert!(value.corpus.len() >= 10, "语料应覆盖边界形态族");
    for entry in &value.corpus {
        assert!(entry["name"].is_string() && entry["text"].is_string(), "语料条目形: {entry}");
    }
    assert_eq!(value.probes.len(), value.outcomes.len(), "探测数与产出数一致");
    assert!(value.probes.len() >= 300, "探测面规模(逐行×receiver×滑窗)");
    // 七面全覆盖审计
    let faces = ["insertion", "stub", "suggestions", "receiverFace", "guardEdit", "wrapEdit", "fdEdit"];
    let mut lit = std::collections::BTreeSet::new();
    for probe in &value.probes {
        lit.insert(probe["face"].as_str().expect("probe face").to_string());
    }
    for face in faces {
        assert!(lit.contains(face), "探测面 {face} 未被覆盖");
    }
    // 产出形态:七面 tag 同形,可空结果合法
    for outcome in &value.outcomes {
        let face = outcome["face"].as_str().expect("outcome face");
        match face {
            "insertion" => {
                let result = &outcome["result"];
                if !result.is_null() {
                    assert!(result["line"].is_u64() && result["blankPrefix"].is_boolean());
                }
            }
            "stub" => assert!(outcome["code"].is_string(), "stub 产出形"),
            "suggestions" => assert!(outcome["hits"].is_array(), "suggestions 产出形"),
            "receiverFace" => {
                let receiver = &outcome["receiver"];
                assert!(receiver.is_null() || receiver.is_string(), "receiverFace 产出形");
            }
            "guardEdit" => {
                let edit = &outcome["edit"];
                if !edit.is_null() {
                    assert!(edit["line"].is_u64() && edit["text"].is_string(), "guard 形: {edit}");
                }
            }
            "wrapEdit" => {
                let edit = &outcome["edit"];
                if !edit.is_null() {
                    assert!(
                        edit["startLine"].is_u64() && edit["endLine"].is_u64() && edit["text"].is_string(),
                        "wrap 形: {edit}"
                    );
                    assert!(
                        edit["endLine"].as_u64().unwrap() > edit["startLine"].as_u64().unwrap(),
                        "wrap 块非空: {edit}"
                    );
                }
            }
            "fdEdit" => {
                let edit = &outcome["edit"];
                if !edit.is_null() {
                    assert!(
                        edit["startLine"].is_u64() && edit["endLine"].is_u64() && edit["text"].is_string(),
                        "fd 形: {edit}"
                    );
                    // 习语三行:_fd = / _fd..= / self.. = _fd
                    let text = edit["text"].as_str().unwrap();
                    assert_eq!(text.lines().count(), 3, "fd 习语三行: {text}");
                }
            }
            other => panic!("产出面非法: {other}"),
        }
    }
}
