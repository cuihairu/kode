//! references 语义分类 golden 重生成比对(RUST-138 批 2;Rust 侧真值;
//! TS 侧 tests/kodeReferencesSemanticParity.test.ts 用 defParser 原语复算
//! 同一 golden,形成双向对拍,references 批 1 同构)。

use kode_server::dump_references_semantic_golden;

fn repo_root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .canonicalize()
        .expect("repo root")
}

#[test]
fn references_semantic_golden_matches_regenerated_dump() {
    let regenerated = dump_references_semantic_golden(&repo_root());
    let golden_path = repo_root().join(kode_server::references::SEMANTIC_GOLDEN_REL_PATH);
    let committed = std::fs::read_to_string(&golden_path)
        .expect("golden 文件缺失: crates/kode-server/tests/golden/references-semantic-parity.json");
    let committed = committed.trim_end_matches('\n');
    if regenerated != committed {
        let diff_at = regenerated
            .char_indices()
            .zip(committed.char_indices())
            .find(|((_, a), (_, b))| a != b)
            .map(|((i, _), _)| i)
            .unwrap_or(0);
        panic!(
            "references semantic golden 与重生成不一致(偏移 {diff_at})。\n重新运行:\n  cargo run -p kode-server --bin dump-references-semantic-golden -- . > crates/kode-server/tests/golden/references-semantic-parity.json"
        );
    }
    assert!(committed.contains("\"siteCount\":"));
    assert!(committed.contains("dump-references-semantic-golden"));
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Dump {
    #[allow(dead_code)]
    file_count: usize,
    reference_count: usize,
    probe_count: usize,
    site_count: usize,
    class_counts: std::collections::BTreeMap<String, usize>,
    files: Vec<GoldenFile>,
}

#[derive(serde::Deserialize)]
struct GoldenFile {
    #[allow(dead_code)]
    file: String,
    #[serde(default)]
    references: Vec<serde_json::Value>,
}

#[test]
fn references_semantic_golden_structure_is_complete() {
    let committed =
        std::fs::read_to_string(repo_root().join(kode_server::references::SEMANTIC_GOLDEN_REL_PATH))
            .expect("golden");
    let value: Dump =
        serde_json::from_str(committed.trim_end_matches('\n')).expect("golden JSON 合法");
    assert!(
        value.reference_count > 0,
        "semantic golden 为空:语料上应有带站点的引用位"
    );
    assert!(
        value.probe_count >= value.reference_count,
        "全集探针数不得小于入档条目数"
    );
    let total: usize = value.files.iter().map(|f| f.references.len()).sum();
    assert_eq!(
        total, value.reference_count,
        "referenceCount 与逐文件和不一致"
    );
    // 三分类计数守恒:class_counts 之和 == siteCount;且语料上三分类里
    // 至少 semantic 与 shadow 双双在场(跨语料同名实体是真分布,分类面
    // 退化成恒 semantic 会在此红)。
    let counted: usize = value.class_counts.values().sum();
    assert_eq!(counted, value.site_count, "classCounts 与 siteCount 不守恒");
    assert!(
        value.class_counts.get("semantic").copied().unwrap_or(0) > 0,
        "语料上应有真实语义引用位"
    );
    assert!(
        value.class_counts.get("shadow").copied().unwrap_or(0) > 0,
        "语料上应有跨 root 同名(Shadow)站点——分类面区分度失效"
    );
    // 站点键形:uri/line/start/end + semantic ∈ {semantic,shadow,dangling}。
    const CLASSES: &[&str] = &["semantic", "shadow", "dangling"];
    for file in &value.files {
        for reference in &file.references {
            assert!(
                reference["target"]["kind"].is_string() && reference["target"]["name"].is_string(),
                "引用缺 target 键形: {reference}"
            );
            let sites = &reference["sites"];
            assert!(sites.is_array(), "引用缺 sites: {reference}");
            for site in sites.as_array().expect("array") {
                assert!(site["uri"].is_string(), "站点缺 uri: {site}");
                assert!(
                    site["line"].is_u64() && site["start"].is_u64() && site["end"].is_u64(),
                    "站点区间键形不对: {site}"
                );
                let semantic = site["semantic"].as_str().expect("semantic str");
                assert!(
                    CLASSES.contains(&semantic),
                    "semantic 分类越界: {semantic}"
                );
                if semantic == "dangling" {
                    assert!(
                        site["evidence"].is_null(),
                        "Dangling 无证据(不猜): {site}"
                    );
                } else {
                    assert!(
                        site["evidence"].is_string(),
                        "Semantic/Shadow 必须带声明路径证据: {site}"
                    );
                }
            }
        }
    }
}
