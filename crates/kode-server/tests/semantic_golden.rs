//! 语义 fixture 金标对拍(RUST-116):重放 demo-assets 语料全量语义事实,
//! 与 frozen golden 逐字节相等;差异必须先入分类账
//! (docs/review/2026-11-16-rust-116-semantic-golden.md)人工审查,不得
//! 静默再生成吞掉。
//!
//! golden 再生成(仅语料夹具或面语义变更,且分类账已裁决后):
//!   cargo run -p kode-server --bin dump-semantics-golden \
//!     > crates/kode-server/tests/golden/semantics-facts.json

use std::path::Path;

use kode_server::semantics_golden::{dump_semantics_golden, GOLDEN_REL_PATH};

fn repo_root() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .unwrap_or_else(|| Path::new("."))
}

#[test]
fn semantics_golden_matches_regenerated_dump() {
    let regenerated = dump_semantics_golden(repo_root());
    let golden_path = repo_root().join(GOLDEN_REL_PATH);
    let committed = std::fs::read_to_string(&golden_path).unwrap_or_else(|_| {
        panic!(
            "golden 缺失: {GOLDEN_REL_PATH}(生成: cargo run -p kode-server --bin dump-semantics-golden > crates/kode-server/tests/golden/semantics-facts.json)"
        )
    });
    assert_eq!(
        regenerated.trim_end_matches('\n'),
        committed.trim_end_matches('\n'),
        "语义金标与重放不一致——差异必须先入分类账人工审查(docs/review/2026-11-16-rust-116-semantic-golden.md),确认裁决后再再生成"
    );
}

#[test]
fn semantics_golden_covers_anchor_faces() {
    let golden_path = repo_root().join(GOLDEN_REL_PATH);
    let committed = std::fs::read_to_string(&golden_path).expect("golden 在案(上一测已断言)");
    let value: serde_json::Value = serde_json::from_str(&committed).expect("golden JSON 合法");
    // 覆盖锚:语料规模 / Avatar 三段导航链 / 忽略账 / 内建·生成物探针。
    assert!(value["corpusCount"].as_u64().expect("corpusCount") > 20);
    let nav = value["nav"].as_array().expect("nav");
    let avatar = nav
        .iter()
        .find(|e| e["entity"] == "Avatar")
        .expect("Avatar 在案");
    let py_facets: Vec<&str> = avatar["python"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["facet"].as_str().unwrap())
        .collect();
    assert!(
        py_facets.contains(&"base") && py_facets.contains(&"cell") && py_facets.contains(&"client"),
        "Avatar 三腿齐"
    );
    assert!(value["navIgnored"]
        .as_array()
        .expect("ignored")
        .iter()
        .any(|r| r["reason"] == "entity-not-registered"));
    let rename = value["renameOwnership"].as_array().expect("rename");
    assert!(rename
        .iter()
        .any(|r| r["probe"] == "builtin-api" && r["owner"] == "engine-builtin"));
    assert!(rename
        .iter()
        .any(|r| r["probe"] == "generated-stub" && r["owner"] == "generated"));
}
