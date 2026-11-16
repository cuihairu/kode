//! SemanticTokens 决策核 golden 重生成比对(Rust 侧真值;TS 侧
//! tests/kodeSemanticTokensParity.test.ts 读 corpus+probes 驱动生产函数
//! 复算对拍 outcomes,双向门禁)。

use kode_server::dump_semantic_tokens_golden;

fn repo_root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .canonicalize()
        .expect("repo root")
}

#[test]
fn semantic_tokens_golden_matches_regenerated_dump() {
    let regenerated = dump_semantic_tokens_golden();
    let golden_path = repo_root().join(kode_server::semantic_tokens::GOLDEN_REL_PATH);
    let committed = std::fs::read_to_string(&golden_path)
        .expect("golden 文件缺失: crates/kode-server/tests/golden/semantic-tokens-parity.json");
    let committed = committed.trim_end_matches('\n');
    if regenerated != committed {
        let diff_at = regenerated
            .char_indices()
            .zip(committed.char_indices())
            .find(|((_, a), (_, b))| a != b)
            .map(|((i, _), _)| i)
            .unwrap_or(0);
        panic!(
            "semantic tokens golden 与重生成不一致(偏移 {diff_at})。\n重新运行:\n  cargo run -p kode-server --bin dump-semantic-tokens-golden > crates/kode-server/tests/golden/semantic-tokens-parity.json"
        );
    }
    assert!(committed.contains("\"generator\":\"dump-semantic-tokens-golden\""));
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
fn semantic_tokens_golden_structure_is_complete() {
    let committed = std::fs::read_to_string(
        repo_root().join(kode_server::semantic_tokens::GOLDEN_REL_PATH),
    )
    .expect("golden");
    let value: Golden =
        serde_json::from_str(committed.trim_end_matches('\n')).expect("golden JSON 合法");
    assert!(value.corpus.len() >= 8, "语料应覆盖边界形态族");
    for entry in &value.corpus {
        assert!(
            entry["name"].is_string() && entry["text"].is_string(),
            "语料条目形: {entry}"
        );
    }
    assert_eq!(value.probes.len(), value.outcomes.len(), "探测数与产出数一致");
    assert!(value.probes.len() >= 16, "探测面规模(8 spans + 8 encoded)");
    let mut lit = std::collections::BTreeSet::new();
    for probe in &value.probes {
        lit.insert(probe["face"].as_str().expect("probe face").to_string());
    }
    for face in ["spans", "encoded"] {
        assert!(lit.contains(face), "探测面 {face} 未被覆盖");
    }
    // 产出形态+分布:spans 升序+encoded 长度 5 倍数+type/modifier 合法
    let types = ["class", "function", "method", "parameter", "macro"];
    let mut spans_hit = 0usize;
    let mut encoded_hit = 0usize;
    for outcome in &value.outcomes {
        match outcome["face"].as_str().expect("outcome face") {
            "spans" => {
                let spans = outcome["spans"].as_array().expect("spans 数组");
                if !spans.is_empty() {
                    spans_hit += 1;
                }
                let mut prev = (0usize, 0usize);
                for span in spans {
                    assert!(
                        types.contains(&span["type"].as_str().expect("token type")),
                        "未知 token type: {span}"
                    );
                    let line = span["line"].as_u64().expect("line") as usize;
                    let start = span["startCharacter"].as_u64().expect("startCharacter") as usize;
                    assert!(
                        (line, start) >= prev,
                        "spans 应按行/列升序: {span}"
                    );
                    prev = (line, start);
                    let length = span["length"].as_u64().expect("length");
                    assert!(length > 0, "span 长度应正: {span}");
                    for modifier in span["modifiers"].as_array().expect("modifiers") {
                        assert!(
                            ["declaration", "async"].contains(&modifier.as_str().expect("modifier")),
                            "未知 modifier: {modifier}"
                        );
                    }
                }
            }
            "encoded" => {
                let data = outcome["data"].as_array().expect("data 数组");
                if !data.is_empty() {
                    encoded_hit += 1;
                }
                assert_eq!(data.len() % 5, 0, "编码应为 5 元组: {data:?}");
                for unit in data {
                    assert!(unit.is_u64() && unit.as_u64().unwrap() <= u32::MAX as u64);
                }
            }
            other => panic!("未知 outcome face: {other}"),
        }
    }
    assert!(spans_hit > 0, "spans 面应有非空产出(防全空对拍空转)");
    assert!(encoded_hit > 0, "encoded 面应有非空产出");
}
