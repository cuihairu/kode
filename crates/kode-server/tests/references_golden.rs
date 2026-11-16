//! references 对拍 golden 重生成比对(Rust 侧真值;TS 侧
//! tests/kodeReferencesParity.test.ts 用现有 defParser 原语复算同一 golden,
//! 形成双向对拍,definition/completion/hover golden 同构)。

use kode_server::dump_references_golden;

fn repo_root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .canonicalize()
        .expect("repo root")
}

#[test]
fn references_golden_matches_regenerated_dump() {
    let regenerated = dump_references_golden(&repo_root());
    let golden_path = repo_root().join(kode_server::references::GOLDEN_REL_PATH);
    let committed = std::fs::read_to_string(&golden_path)
        .expect("golden 文件缺失: crates/kode-server/tests/golden/references-parity.json");
    let committed = committed.trim_end_matches('\n');
    if regenerated != committed {
        let diff_at = regenerated
            .char_indices()
            .zip(committed.char_indices())
            .find(|((_, a), (_, b))| a != b)
            .map(|((i, _), _)| i)
            .unwrap_or(0);
        panic!(
            "references golden 与重生成不一致(偏移 {diff_at})。\n重新运行:\n  cargo run -p kode-server --bin dump-references-golden -- . > crates/kode-server/tests/golden/references-parity.json"
        );
    }
    assert!(committed.contains("\"referenceCount\":"));
    assert!(committed.contains("dump-references-golden"));
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Dump {
    #[allow(dead_code)]
    file_count: usize,
    reference_count: usize,
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
fn references_golden_structure_is_complete() {
    let committed =
        std::fs::read_to_string(repo_root().join(kode_server::references::GOLDEN_REL_PATH))
            .expect("golden");
    let value: Dump =
        serde_json::from_str(committed.trim_end_matches('\n')).expect("golden JSON 合法");
    assert!(
        value.reference_count > 0,
        "references golden 为空:语料上应有引用位"
    );
    let total: usize = value.files.iter().map(|f| f.references.len()).sum();
    assert_eq!(
        total, value.reference_count,
        "referenceCount 与逐文件和不一致"
    );
    // 落点键形:LSP Location(uri + range.start/end 的 line/character)。
    for file in &value.files {
        for reference in &file.references {
            let locations = &reference["locations"];
            assert!(locations.is_array(), "引用缺 locations: {reference}");
            for location in locations.as_array().expect("array") {
                assert!(location["uri"].is_string(), "落点缺 uri: {location}");
                assert!(
                    location["range"]["start"]["line"].is_u64()
                        && location["range"]["start"]["character"].is_u64()
                        && location["range"]["end"]["line"].is_u64()
                        && location["range"]["end"]["character"].is_u64(),
                    "落点区间键形不对: {location}"
                );
            }
        }
    }
}
