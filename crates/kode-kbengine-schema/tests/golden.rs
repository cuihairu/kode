//! PA-002 Golden 测试:真实 fixture 项目的完整 Schema 快照对拍。
//!
//! golden 文件 = Schema canonical JSON(字节级)。重生成:
//!   KODE_SCHEMA_GOLDEN_BLESS=1 cargo test -p kode-kbengine-schema

use std::path::PathBuf;

use kode_kbengine_schema::{build_schema_from_project, BuildOptions};

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap()
}

const GOLDEN_REL: &str = "crates/kode-kbengine-schema/tests/golden/schema-demo-assets.json";

fn schema_json() -> String {
    let engine_defaults = std::fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/messages_fixed_defaults.xml"),
    )
    .unwrap();
    let schema = build_schema_from_project(
        &repo_root().join("tests/fixtures/kbengine-demo-assets"),
        Some(&engine_defaults),
        &BuildOptions::default(),
    )
    .expect("schema build over demo-assets fixture");
    schema.to_canonical_json()
}

#[test]
fn golden_schema_matches_snapshot() {
    let golden_path = repo_root().join(GOLDEN_REL);
    let actual = schema_json();
    if std::env::var("KODE_SCHEMA_GOLDEN_BLESS").is_ok() {
        std::fs::create_dir_all(golden_path.parent().unwrap()).unwrap();
        std::fs::write(&golden_path, &actual).unwrap();
    }
    let expected = std::fs::read_to_string(&golden_path).expect(
        "golden file missing - run KODE_SCHEMA_GOLDEN_BLESS=1 cargo test -p kode-kbengine-schema",
    );
    assert_eq!(actual, expected, "schema IR drifted from golden snapshot");
}
