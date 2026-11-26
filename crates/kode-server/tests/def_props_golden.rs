//! defPropsInlayHints 决策核 golden 重生成比对(Rust 侧真值;TS 侧
//! tests/kodeDefPropsParity.test.ts 读 corpus+probes 驱动生产函数复算
//! 对拍 outcomes,双向门禁)。

use kode_server::dump_def_props_golden;

fn repo_root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .canonicalize()
        .expect("repo root")
}

#[test]
fn def_props_golden_matches_regenerated_dump() {
    let regenerated = dump_def_props_golden();
    let golden_path = repo_root().join(kode_server::def_props_hints::DEF_PROPS_GOLDEN_REL_PATH);
    let committed = std::fs::read_to_string(&golden_path)
        .expect("golden 文件缺失: crates/kode-server/tests/golden/def-props-parity.json");
    let committed = committed.trim_end_matches('\n');
    if regenerated != committed {
        let diff_at = regenerated
            .char_indices()
            .zip(committed.char_indices())
            .find(|((_, a), (_, b))| a != b)
            .map(|((i, _), _)| i)
            .unwrap_or(0);
        panic!(
            "def props golden 与重生成不一致(偏移 {diff_at})。\n重新运行:\n  cargo run -p kode-server --bin dump-def-props-golden > crates/kode-server/tests/golden/def-props-parity.json"
        );
    }
    assert!(committed.contains("\"generator\":\"dump-def-props-golden\""));
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
fn def_props_golden_structure_is_complete() {
    let committed = std::fs::read_to_string(
        repo_root().join(kode_server::def_props_hints::DEF_PROPS_GOLDEN_REL_PATH),
    )
    .expect("golden");
    let value: Golden =
        serde_json::from_str(committed.trim_end_matches('\n')).expect("golden JSON 合法");
    assert!(value.corpus.len() >= 8, "语料应覆盖边界形态族");
    for entry in &value.corpus {
        assert!(
            entry["name"].is_string()
                && entry["text"].is_string()
                && entry["properties"].is_array(),
            "语料条目形: {entry}"
        );
    }
    assert_eq!(
        value.probes.len(),
        value.outcomes.len(),
        "探测数与产出数一致"
    );
    assert!(value.probes.len() >= 14, "探测面规模(8 锚面 + 逐锚组装)");
    let mut lit = std::collections::BTreeSet::new();
    for probe in &value.probes {
        lit.insert(probe["face"].as_str().expect("probe face").to_string());
    }
    for face in ["anchors", "items"] {
        assert!(lit.contains(face), "探测面 {face} 未被覆盖");
    }
    // 产出形态+非空分布
    let mut items_hit = 0usize;
    let mut anchors_hit = 0usize;
    for outcome in &value.outcomes {
        match outcome["face"].as_str().expect("outcome face") {
            "anchors" => {
                let sites = outcome["sites"].as_array().expect("sites 数组");
                if !sites.is_empty() {
                    anchors_hit += 1;
                }
                for site in sites {
                    assert!(
                        site["line"].is_u64() && site["character"].is_u64(),
                        "锚形: {site}"
                    );
                }
            }
            "items" => {
                let item = &outcome["item"];
                if !item.is_null() {
                    items_hit += 1;
                    let position = &item["position"];
                    assert!(
                        position["line"].is_u64() && position["character"].is_u64(),
                        "位置形: {item}"
                    );
                    assert_eq!(item["kind"], "Type", "kind 恒 Type: {item}");
                    let parts = item["parts"].as_array().expect("parts 数组");
                    assert!(parts.len() >= 2, "头部段+至少一属性段: {item}");
                    // 奇数 index=属性段(text 非分隔),偶数 index>0=间隔段
                    for (index, part) in parts.iter().enumerate() {
                        assert!(part["text"].is_string(), "段文本: {part}");
                        if index % 2 == 1 {
                            assert!(part["text"] != " · ", "奇数 index=属性段: {part}");
                        } else if index > 0 {
                            assert_eq!(part["text"], " · ", "偶数 index>0=间隔段: {part}");
                        }
                    }
                }
            }
            other => panic!("产出面非法: {other}"),
        }
    }
    assert!(
        anchors_hit > 0 && items_hit > 0,
        "两面非空产出分布(防全空对拍空转)"
    );
}
