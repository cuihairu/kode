//! def-md5 黄金对拍重生成比对:重放器(规范推导=引擎 EntityDef::md5 字节序
//! 镜像)重算全部样本,与 frozen golden 逐字节相等;golden 内含最小锚点
//! (手推字节流)与双夹具(demo-assets 回归锁 + parity-project)。
//!
//! golden 再生成(仅样本表/算法变更时):
//!   cargo run -p kode-server --bin dump-def-md5-golden \
//!     > crates/kode-server/tests/golden/def-md5-parity.json

use std::path::Path;

use kode_server::def_md5::{dump_def_md5_golden, GOLDEN_REL_PATH};

fn repo_root() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .unwrap_or_else(|| Path::new("."))
}

#[test]
fn def_md5_golden_matches_regenerated_dump() {
    let regenerated = dump_def_md5_golden(repo_root());
    let golden_path = repo_root().join(GOLDEN_REL_PATH);
    let committed = std::fs::read_to_string(&golden_path)
        .expect("golden 缺失: crates/kode-server/tests/golden/def-md5-parity.json");
    let committed = committed.trim_end_matches('\n');
    assert_eq!(
        regenerated, committed,
        "def-md5 golden 与重生成不一致。重新生成:\n  cargo run -p kode-server --bin dump-def-md5-golden > crates/kode-server/tests/golden/def-md5-parity.json"
    );
}

#[test]
fn def_md5_golden_covers_anchor_and_fixtures() {
    let value: serde_json::Value =
        serde_json::from_str(dump_def_md5_golden(repo_root()).as_str()).expect("golden JSON 合法");
    let samples = value["samples"].as_array().expect("samples array");
    let names: Vec<&str> = samples
        .iter()
        .map(|s| s["name"].as_str().expect("name"))
        .collect();
    assert!(names.contains(&"minimal-single-entity"), "锚点样本");
    assert!(names.contains(&"kbengine-demo-assets"), "回归锁样本");
    assert!(names.contains(&"parity-project"), "对拍样本");
    for s in samples {
        let md5 = s["md5"].as_str().expect("md5");
        assert_eq!(md5.len(), 32, "{}: 32 hex", s["name"]);
        assert!(md5.chars().all(|c| c.is_ascii_hexdigit()));
        let stream = s["streamHex"].as_str().expect("streamHex");
        assert_eq!(stream.len() % 2, 0, "{}: even hex", s["name"]);
        // md5 必须等于 streamHex 对应字节的 MD5(自洽性)。
        let bytes: Vec<u8> = (0..stream.len() / 2)
            .map(|i| u8::from_str_radix(&stream[i * 2..i * 2 + 2], 16).unwrap())
            .collect();
        let mut m = kode_server::def_md5::Md5::new();
        m.update(&bytes);
        let calc = m.finalize();
        let calc_hex: String = calc.iter().map(|b| format!("{:02X}", b)).collect();
        assert_eq!(calc_hex, md5, "{}: md5 自洽", s["name"]);
    }
}
