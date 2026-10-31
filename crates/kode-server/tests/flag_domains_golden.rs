//! flag→domain golden 重生成比对(Rust 侧真值;TS 侧 tests/flagDomainsParity.test.ts
//! 复算同一 golden + src/generated/flagDomains.ts 派生镜像对拍,双向门禁)。

use kode_server::{dump_flag_domains_golden, GOLDEN_REL_PATH};

fn repo_root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .canonicalize()
        .expect("repo root")
}

#[test]
fn flag_domains_golden_matches_regenerated_dump() {
    let regenerated = dump_flag_domains_golden();
    let golden_path = repo_root().join(GOLDEN_REL_PATH);
    let committed = std::fs::read_to_string(&golden_path)
        .expect("golden 文件缺失: crates/kode-server/tests/golden/flag-domains-parity.json");
    // 尾部换行由重定向/dump println! 引入,不参与比对
    let committed = committed.trim_end_matches('\n');
    assert_eq!(
        regenerated, committed,
        "flag-domains golden 与重生成不一致。\n重新运行:\n  cargo run -p kode-server --bin dump-flag-domains-golden > crates/kode-server/tests/golden/flag-domains-parity.json"
    );
    assert!(committed.contains("flagDomains"));
    assert!(committed.contains("normalize_flag_tokens"));
}

#[test]
fn flag_domains_golden_covers_all_canonical_tokens() {
    let value: serde_json::Value =
        serde_json::from_str(dump_flag_domains_golden().as_str()).expect("golden JSON 合法");
    let map = value["flagDomains"].as_object().expect("flagDomains map");
    assert_eq!(
        map.len(),
        kode_server::CANONICAL.len(),
        "flagDomains 覆盖数应等于规范 token 数"
    );
    // 三域位映射至少出现 base/cell/client 各一次(真值表完整性)。
    let mut all: Vec<&str> = Vec::new();
    for v in map.values() {
        for s in v.as_array().expect("domain list") {
            all.push(s.as_str().expect("domain string"));
        }
    }
    assert!(all.contains(&"base"));
    assert!(all.contains(&"cell"));
    assert!(all.contains(&"client"));
    // CELL 别名归一面在 golden 里明确给出。
    assert_eq!(value["alias"]["CELL"], "CELL_PUBLIC");
}
