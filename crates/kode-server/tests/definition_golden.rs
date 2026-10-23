//! definition 对拍 golden 重生成比对(Rust 侧真值;TS 侧
//! tests/kodeDefinitionParity.test.ts 用现有 defParser 原语复算同一 golden,
//! 形成双向对拍,PR-005/007/008/010 同构)。

use kode_server::dump_definition_golden;

fn repo_root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .canonicalize()
        .expect("repo root")
}

#[test]
fn definition_golden_matches_regenerated_dump() {
    let regenerated = dump_definition_golden(&repo_root());
    let golden_path = repo_root().join(kode_server::definition::GOLDEN_REL_PATH);
    let committed = std::fs::read_to_string(&golden_path)
        .expect("golden 文件缺失: crates/kode-server/tests/golden/definition-parity.json");
    let committed = committed.trim_end_matches('\n');
    if regenerated != committed {
        let diff_at = regenerated
            .char_indices()
            .zip(committed.char_indices())
            .find(|((_, a), (_, b))| a != b)
            .map(|((i, _), _)| i)
            .unwrap_or(0);
        panic!(
            "definition golden 与重生成不一致(偏移 {diff_at})。\n重新运行:\n  cargo run -p kode-server --bin dump-definition-golden -- . > crates/kode-server/tests/golden/definition-parity.json"
        );
    }
    assert!(committed.contains("\"definitionCount\":"));
    assert!(committed.contains("dump-definition-golden"));
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Dump {
    #[allow(dead_code)]
    file_count: usize,
    definition_count: usize,
    files: Vec<GoldenFile>,
}

#[derive(serde::Deserialize)]
struct GoldenFile {
    #[allow(dead_code)]
    file: String,
    #[serde(default)]
    definitions: Vec<serde_json::Value>,
}

#[test]
fn definition_golden_structure_is_complete() {
    let committed =
        std::fs::read_to_string(repo_root().join(kode_server::definition::GOLDEN_REL_PATH))
            .expect("golden");
    let value: Dump =
        serde_json::from_str(committed.trim_end_matches('\n')).expect("golden JSON 合法");
    assert!(
        value.definition_count > 0,
        "definition golden 为空:语料上应有声明落点"
    );
    let total: usize = value.files.iter().map(|f| f.definitions.len()).sum();
    assert_eq!(
        total, value.definition_count,
        "definitionCount 与逐文件和不一致"
    );
    // 落点键形:LSP Location(uri + range.start/end 的 line/character)。
    for file in &value.files {
        for definition in &file.definitions {
            let location = &definition["definition"];
            assert!(location["uri"].is_string(), "落点缺 uri: {definition}");
            assert!(
                location["range"]["start"]["line"].is_u64()
                    && location["range"]["start"]["character"].is_u64()
                    && location["range"]["end"]["line"].is_u64()
                    && location["range"]["end"]["character"].is_u64(),
                "落点区间键形不对: {definition}"
            );
        }
    }
}
