//! defParamInlayHints 决策核 golden 重生成比对(Rust 侧真值;TS 侧
//! tests/kodeDefParamHintsParity.test.ts 读 corpus+probes 驱动生产函数复算
//! 对拍 outcomes,双向门禁)。

use kode_server::dump_def_param_hints_golden;

fn repo_root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .canonicalize()
        .expect("repo root")
}

#[test]
fn def_param_hints_golden_matches_regenerated_dump() {
    let regenerated = dump_def_param_hints_golden();
    let golden_path = repo_root().join(kode_server::def_param_hints::GOLDEN_REL_PATH);
    let committed = std::fs::read_to_string(&golden_path)
        .expect("golden 文件缺失: crates/kode-server/tests/golden/def-param-hints-parity.json");
    let committed = committed.trim_end_matches('\n');
    if regenerated != committed {
        let diff_at = regenerated
            .char_indices()
            .zip(committed.char_indices())
            .find(|((_, a), (_, b))| a != b)
            .map(|((i, _), _)| i)
            .unwrap_or(0);
        panic!(
            "def param hints golden 与重生成不一致(偏移 {diff_at})。\n重新运行:\n  cargo run -p kode-server --bin dump-def-param-hints-golden > crates/kode-server/tests/golden/def-param-hints-parity.json"
        );
    }
    assert!(committed.contains("\"generator\":\"dump-def-param-hints-golden\""));
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
fn def_param_hints_golden_structure_is_complete() {
    let committed =
        std::fs::read_to_string(repo_root().join(kode_server::def_param_hints::GOLDEN_REL_PATH))
            .expect("golden");
    let value: Golden =
        serde_json::from_str(committed.trim_end_matches('\n')).expect("golden JSON 合法");
    // 语料规模与自含性(name/path/text 三元)
    assert!(value.corpus.len() >= 10, "语料应覆盖边界形态族");
    for entry in &value.corpus {
        assert!(
            entry["name"].is_string() && entry["path"].is_string() && entry["text"].is_string(),
            "语料条目形: {entry}"
        );
    }
    assert_eq!(
        value.probes.len(),
        value.outcomes.len(),
        "探测数与产出数一致"
    );
    assert!(
        value.probes.len() >= 30,
        "探测面规模(12 语料站点面 + 声明配对面)"
    );
    // 两面全覆盖审计
    let mut lit = std::collections::BTreeSet::new();
    for probe in &value.probes {
        lit.insert(probe["face"].as_str().expect("probe face").to_string());
    }
    for face in ["sites", "items"] {
        assert!(lit.contains(face), "探测面 {face} 未被覆盖");
    }
    // 产出形态:sites 站点字段齐;items 形态+非空分布(防全空对拍空转)
    let mut items_hit = 0usize;
    for outcome in &value.outcomes {
        match outcome["face"].as_str().expect("outcome face") {
            "sites" => {
                for site in outcome["sites"].as_array().expect("sites 数组") {
                    assert!(site["line"].is_u64(), "site 行: {site}");
                    assert!(site["methodName"].is_string(), "site 方法名: {site}");
                    assert!(site["section"].is_string(), "site 段: {site}");
                    assert!(
                        site["closeParenCharacter"].is_u64(),
                        "site 闭括号列: {site}"
                    );
                    // KODE-SYN-004:跨行行位字段随模型一并钉形
                    assert!(site["closeParenLine"].is_u64(), "site 闭括号行: {site}");
                    for param in site["params"].as_array().expect("params 数组") {
                        assert!(
                            param["start"].is_u64()
                                && param["end"].is_u64()
                                && param["line"].is_u64()
                                && param["name"].is_string()
                                && param["hasAnnotation"].is_boolean()
                                && param["isStar"].is_boolean(),
                            "param 形: {param}"
                        );
                    }
                }
            }
            "items" => {
                let items = outcome["items"].as_array().expect("items 数组");
                if !items.is_empty() {
                    items_hit += 1;
                }
                for item in items {
                    let position = &item["position"];
                    assert!(
                        position["line"].is_u64() && position["character"].is_u64(),
                        "位置形: {item}"
                    );
                    assert!(item["text"].is_string(), "text 形: {item}");
                    let kind = item["kind"].as_str().expect("kind");
                    assert!(kind == "Parameter" || kind == "Type", "kind 形: {item}");
                }
            }
            other => panic!("产出面非法: {other}"),
        }
    }
    assert!(items_hit > 0, "items 非空产出分布(防全空对拍空转)");
}
