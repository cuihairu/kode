//! hover 对拍 golden 重生成比对(Rust 侧真值;TS 侧 tests/kodeHoverParity.test.ts
//! 用现有 defParser/compositionRoots/buildDefChain 复算同一 golden,形成双向
//! 对拍,PR-005/007/008 同构)。

use kode_server::dump_hover_golden;

fn repo_root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .canonicalize()
        .expect("repo root")
}

#[test]
fn hover_golden_matches_regenerated_dump() {
    let regenerated = dump_hover_golden(&repo_root());
    let golden_path = repo_root().join(kode_server::hover::GOLDEN_REL_PATH);
    let committed = std::fs::read_to_string(&golden_path)
        .expect("golden 文件缺失: crates/kode-server/tests/golden/hover-parity.json");
    // 尾部换行由重定向/dump println! 引入,不参与比对
    let committed = committed.trim_end_matches('\n');
    if regenerated != committed {
        let diff_at = regenerated
            .char_indices()
            .zip(committed.char_indices())
            .find(|((_, a), (_, b))| a != b)
            .map(|((i, _), _)| i)
            .unwrap_or(0);
        panic!(
            "hover golden 与重生成不一致(偏移 {diff_at})。\n重新运行:\n  cargo run -p kode-server --bin dump-hover-golden -- . > crates/kode-server/tests/golden/hover-parity.json\nRust 重生成:…{}",
            &regenerated[diff_at.saturating_sub(120)..(diff_at + 160).min(regenerated.len())],
        );
    }
    assert!(committed.contains("\"hoverCount\":"));
    assert!(committed.contains("dump-hover-golden"));
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Dump {
    file_count: usize,
    hover_count: usize,
    files: Vec<GoldenFile>,
}

#[derive(serde::Deserialize)]
struct GoldenFile {
    #[allow(dead_code)]
    file: String,
    hovers: Vec<serde_json::Value>,
}

#[test]
fn hover_golden_structure_is_complete() {
    let committed = std::fs::read_to_string(repo_root().join(kode_server::hover::GOLDEN_REL_PATH))
        .expect("golden");
    let value: Dump =
        serde_json::from_str(committed.trim_end_matches('\n')).expect("golden JSON 合法");
    assert!(
        value.file_count >= 25,
        "语料文件数异常: {}",
        value.file_count
    );
    assert_eq!(
        value.hover_count,
        value.files.iter().map(|f| f.hovers.len()).sum::<usize>(),
        "hoverCount 与实际不符"
    );
    // def 实体悬停必须带继承链面(HOVER 继承成员面在语料上非空)。
    let entity_hovers: Vec<&serde_json::Value> = value
        .files
        .iter()
        .flat_map(|f| f.hovers.iter())
        .filter(|h| h["hover"]["symbol"]["kind"] == "entity")
        .collect();
    assert!(
        entity_hovers.len() >= 10,
        "实体悬停过少: {}",
        entity_hovers.len()
    );
    let with_chain = entity_hovers
        .iter()
        .filter(|h| h["hover"]["inherited"].is_object())
        .count();
    assert!(with_chain >= entity_hovers.len() / 2, "带链面实体悬停过少");
    // 继承链面在语料上至少出现一次非空 parent 链(demo-assets 三级链)。
    let nonempty_chain = value.files.iter().flat_map(|f| f.hovers.iter()).any(|h| {
        h["hover"]["inherited"]["parentChain"]
            .as_array()
            .map(|c| !c.is_empty())
            .unwrap_or(false)
    });
    assert!(nonempty_chain, "语料缺少非空 parent 链");
}
