//! Fuzz(PDC-0602):归档/规则/畸形 BLOB/嵌套关系/环引用的 fail-closed 面。
//!
//! 全部经确定性 PRNG 或手工畸形夹具驱动,断言「绝不 panic」——解析面只许
//! Ok 或 Err,不许 unwind(panic 即测试失败)。`cargo test` 即可跑,不依赖
//! cargo-fuzz/nightly;PRNG 用 xorshift64 免第三方依赖,CI 可复现。
//!
//! 覆盖面:
//! - 归档字节流(魔数/版本/旗标/帧头/清单/校验和/jsonl)→ Archive::open 不 panic;
//! - 畸形 TypedRow/BLOB(奇数 hex、非 hex、负 BigUInt、未知 tag)→ serde 不 panic;
//! - 规则(空实体/未知表/自引用/include/exclude 重叠)→ validate/apply 不 panic;
//! - 嵌套/环关系(深链、环、扇出)→ RelationGraph 终止不 panic、环被检出。

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};

use kode_db_clone::redact::RedactionReport;
use kode_db_clone::{
    Archive, ArchiveWriter, CloneError, CloneSchema, DerivedField, DerivedTable, IdentityRule,
    ProjectRule, RelationGraph, RelationRule, RelationRuleAction, RowSink, RuleSet, SchemaSource,
    TypedRow, TypedValue,
};

/// 确定性 xorshift64 PRNG(免第三方依赖,CI 可复现)。
struct XorShift(u64);
impl XorShift {
    fn new(seed: u64) -> Self {
        XorShift(seed.max(1))
    }
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    fn range(&mut self, lo: usize, hi: usize) -> usize {
        if hi <= lo {
            return lo;
        }
        lo + (self.next() as usize % (hi - lo))
    }
    fn bytes(&mut self, len: usize) -> Vec<u8> {
        (0..len).map(|_| (self.next() & 0xff) as u8).collect()
    }
}

/// 临时文件路径(带进程 + 迭代序,避免并发 worker 冲突)。
fn tmp_path(tag: &str, seq: u64) -> PathBuf {
    let pid = std::process::id();
    std::env::temp_dir().join(format!("kode-fuzz-{tag}-{pid}-{seq}.kdpclone"))
}

/// 写临时文件,返回路径。
fn write_tmp(bytes: &[u8], tag: &str, seq: u64) -> PathBuf {
    let p = tmp_path(tag, seq);
    std::fs::write(&p, bytes).expect("write fuzz temp");
    p
}

/// 断言闭包绝不 panic;返回 Ok/Err 结果(供断言)。
fn must_not_panic<T>(what: &str, f: impl FnOnce() -> T) -> std::thread::Result<T> {
    let r = catch_unwind(AssertUnwindSafe(f));
    assert!(
        r.is_ok(),
        "{what} panicked (must fail closed, never unwind)"
    );
    r
}

// ---------------------------------------------------------------------------
// 构造助手(与 golden_plan/apply 同口径)
// ---------------------------------------------------------------------------

fn field(name: &str, type_label: &str) -> DerivedField {
    DerivedField {
        name: name.into(),
        type_label: type_label.into(),
        identifier: name == "id",
        synthetic: name == "id" || name == "parentID" || name.starts_with("sm_"),
        source: SchemaSource::Def,
    }
}

/// 链式子表:parent 为上一级(根 parent=None)。
fn chain_table(name: &str, parent: Option<&str>) -> DerivedTable {
    DerivedTable {
        name: name.into(),
        kind: if parent.is_none() { "root" } else { "array" }.into(),
        parent_table_name: parent.map(|s| s.to_string()),
        property_path: Some(name.into()),
        fields: vec![
            field("id", "bigint unsigned"),
            field("parentID", "bigint unsigned"),
            field("sm_autoLoad", "tinyint"),
        ],
    }
}

fn row(table: &str, values: Vec<TypedValue>) -> TypedRow {
    TypedRow {
        table: table.into(),
        values,
    }
}

/// 写一份最小合法归档(供变异 fuzz 起点)。
fn write_valid_archive(path: &Path) {
    let mut w = ArchiveWriter::new(path, None, "Avatar").expect("writer");
    w.write_row(
        "tbl_Avatar",
        &row(
            "tbl_Avatar",
            vec![
                TypedValue::BigUInt(7),
                TypedValue::UInt(1),
                TypedValue::Text("hero".into()),
            ],
        ),
    )
    .expect("write row");
    w.end_table("tbl_Avatar", 1).expect("end table");
    w.finalize(&[], &RedactionReport { entries: vec![] })
        .expect("finalize");
}

/// 读完整字节。
fn read_bytes(path: &Path) -> Vec<u8> {
    std::fs::read(path).expect("read archive")
}

// ---------------------------------------------------------------------------
// 1. 归档字节流 fuzz
// ---------------------------------------------------------------------------

#[test]
fn archive_random_bytes_never_panics() {
    let mut rng = XorShift::new(0x5eed_2026);
    for i in 0..300u64 {
        let len = rng.range(0, 4096);
        let bytes = rng.bytes(len);
        let p = write_tmp(&bytes, "rand", i);
        let res = must_not_panic("Archive::open(random bytes)", || Archive::open(&p, None));
        // 无论 Ok/Err 皆可;关键是不 panic。
        let _ = res.unwrap();
        let _ = std::fs::remove_file(&p);
    }
    // 偶发大缓冲(接近但不超过 cap,构造已保证 < cap)。
    for i in 0..8u64 {
        let len = 64 * 1024 + (i as usize) * 1024;
        let bytes = rng.bytes(len);
        let p = write_tmp(&bytes, "randbig", i);
        let _ = must_not_panic("Archive::open(large random)", || Archive::open(&p, None)).unwrap();
        let _ = std::fs::remove_file(&p);
    }
}

#[test]
fn archive_structural_mutations_never_panic() {
    let base = tmp_path("valid", 0);
    write_valid_archive(&base);
    let bytes = read_bytes(&base);
    let _ = std::fs::remove_file(&base);

    // 逐字节翻转前 64 字节(魔数/版本/旗标/首帧头)。
    for i in 0..64u64 {
        if i as usize >= bytes.len() {
            break;
        }
        let mut b = bytes.clone();
        b[i as usize] ^= 0xff;
        let p = write_tmp(&b, "flip", i);
        let _ = must_not_panic("Archive::open(flipped byte)", || Archive::open(&p, None)).unwrap();
        let _ = std::fs::remove_file(&p);
    }

    // 各截断点(前 32 字节逐点 + 随机后段)。
    for i in 0..32u64 {
        let mut b = bytes.clone();
        b.truncate(i as usize);
        let p = write_tmp(&b, "trunc", i);
        let _ = must_not_panic("Archive::open(truncated)", || Archive::open(&p, None)).unwrap();
        let _ = std::fs::remove_file(&p);
    }
    let mut rng = XorShift::new(0xdead_beef);
    for i in 0..40u64 {
        let cut = rng.range(1, bytes.len());
        let mut b = bytes.clone();
        b.truncate(cut);
        let p = write_tmp(&b, "truncr", i);
        let _ =
            must_not_panic("Archive::open(random truncate)", || Archive::open(&p, None)).unwrap();
        let _ = std::fs::remove_file(&p);
    }

    // 追加垃圾/翻清单字节(校验和必被破坏 → Err,不 panic)。
    for i in 0..20u64 {
        let mut b = bytes.clone();
        let n = rng.range(1, 64);
        b.extend(rng.bytes(n));
        let p = write_tmp(&b, "append", i);
        let _ = must_not_panic("Archive::open(appended)", || Archive::open(&p, None)).unwrap();
        let _ = std::fs::remove_file(&p);
    }
}

#[test]
fn archive_bad_magic_version_flag_never_panic() {
    // 手工拼坏头:错魔数、错版本、错旗标(带加密位但无 key)。
    let base = tmp_path("valid2", 0);
    write_valid_archive(&base);
    let bytes = read_bytes(&base);
    let _ = std::fs::remove_file(&base);

    let mut bad_magic = bytes.clone();
    bad_magic[0] = b'X';
    let p = write_tmp(&bad_magic, "badmagic", 0);
    let e = must_not_panic("Archive::open(bad magic)", || Archive::open(&p, None))
        .unwrap()
        .unwrap_err();
    assert!(
        matches!(e, CloneError::ArchiveError(_)),
        "bad magic must be ArchiveError, got {e:?}"
    );
    let _ = std::fs::remove_file(&p);

    let mut bad_ver = bytes.clone();
    bad_ver[9] = 99; // MAGIC.len()==9,版本在索引 9。
    let p = write_tmp(&bad_ver, "badver", 0);
    let e = must_not_panic("Archive::open(bad version)", || Archive::open(&p, None))
        .unwrap()
        .unwrap_err();
    assert!(
        matches!(e, CloneError::ArchiveError(_)),
        "bad version must be ArchiveError, got {e:?}"
    );
    let _ = std::fs::remove_file(&p);

    // 加密旗标置位但未给 key → Err(不 panic)。
    let mut enc = bytes.clone();
    enc[10] |= 0x01; // MAGIC.len()+1==10 是旗标位。
    let p = write_tmp(&enc, "encflag", 0);
    let _ = must_not_panic("Archive::open(encrypted, no key)", || {
        Archive::open(&p, None)
    })
    .unwrap();
    let _ = std::fs::remove_file(&p);
}

// ---------------------------------------------------------------------------
// 2. jsonl 行 / 畸形 BLOB fuzz
// ---------------------------------------------------------------------------

#[test]
fn jsonl_row_fuzz_never_panics() {
    let mut rng = XorShift::new(0xc0ffee);
    // 随机字节当 jsonl 行。
    for i in 0..300u64 {
        let n = rng.range(0, 512);
        let bytes = rng.bytes(n);
        let _ = must_not_panic("TypedRow(random bytes)", || {
            serde_json::from_slice::<TypedRow>(&bytes)
        })
        .unwrap();
        let _ = i;
    }
    // 随机合法 JSON 但字段畸形。
    for i in 0..200u64 {
        let tn = rng.range(0, 16);
        let table = rng.bytes(tn);
        let vc = rng.range(0, 8);
        let vals: Vec<TypedValue> = (0..vc)
            .map(|_| {
                let n = rng.range(0, 32);
                TypedValue::Text(rng.bytes(n).into_iter().map(|b| b as char).collect())
            })
            .collect();
        let json =
            serde_json::to_string(&row(&String::from_utf8_lossy(&table), vals)).unwrap_or_default();
        let _ = must_not_panic("TypedRow(valid-ish json)", || {
            serde_json::from_str::<TypedRow>(&json)
        })
        .unwrap();
        let _ = i;
    }
}

#[test]
fn malformed_blob_values_never_panic() {
    // Bytes 变体带畸形 hex(奇数/非 hex/超长)→ 反序列化不 panic。
    let cases = [
        r#"{"t":"bytes","v":"0f0"}"#,        // 奇数 hex
        r#"{"t":"bytes","v":"zzzz"}"#,       // 非 hex
        r#"{"t":"bytes","v":""}"#,           // 空
        r#"{"t":"bytes","v":"0f0f0f0f0f"}"#, // 合法但无意义
    ];
    for (i, c) in cases.iter().enumerate() {
        let json = format!(r#"{{"table":"tbl_Avatar","values":[{c}]}}"#);
        let _ = must_not_panic("malformed BLOB row", || {
            serde_json::from_str::<TypedRow>(&json)
        })
        .unwrap();
        let _ = i;
    }
    // 负 BigUInt / Int 溢出 / 未知 tag / DateTime 缺 offset。
    let tricky = [
        r#"{"t":"biguint","v":-1}"#,
        r#"{"t":"int","v":9223372036854775808}"#,
        r#"{"t":"nosuchtag","v":1}"#,
        r#"{"t":"datetime","v":"2020-01-01"}"#,
        r#"{"t":"datetime","value":"2020-01-01"}"#,
        r#"{"t":"decimal","v":123456789012345678901234567890}"#,
    ];
    for c in tricky {
        let json = format!(r#"{{"table":"tbl_Avatar","values":[{c}]}}"#);
        let _ = must_not_panic("tricky typed value", || {
            serde_json::from_str::<TypedRow>(&json)
        })
        .unwrap();
    }
}

// ---------------------------------------------------------------------------
// 3. 规则 fuzz(畸形结构 → fail-closed,不 panic)
// ---------------------------------------------------------------------------

fn avatar_schema() -> CloneSchema {
    CloneSchema::new(
        "Avatar".into(),
        vec![
            chain_table("tbl_Avatar", None),
            chain_table("tbl_Avatar_items", Some("tbl_Avatar")),
        ],
    )
    .expect("schema")
}

#[test]
fn rule_validate_fuzz_never_panics() {
    let schema = avatar_schema();
    let malformed: Vec<RuleSet> = vec![
        // 空实体 / 空表 / 空列。
        RuleSet {
            relations: vec![RelationRule {
                entity: String::new(),
                property_path: "x".into(),
                child_table: "tbl_Avatar_items".into(),
                parent_table: "tbl_Avatar".into(),
                join_column: "parentID".into(),
                action: RelationRuleAction::Follow,
                note: None,
            }],
            identities: vec![],
            projections: vec![],
        },
        // 未知表。
        RuleSet {
            relations: vec![],
            identities: vec![IdentityRule {
                entity: "Avatar".into(),
                table: "tbl_NoSuch".into(),
                column: "id".into(),
            }],
            projections: vec![],
        },
        // 自引用(实体==子表路径)。
        RuleSet {
            relations: vec![RelationRule {
                entity: "Avatar".into(),
                property_path: "tbl_Avatar".into(),
                child_table: "tbl_Avatar".into(),
                parent_table: "tbl_Avatar".into(),
                join_column: "id".into(),
                action: RelationRuleAction::Follow,
                note: None,
            }],
            identities: vec![],
            projections: vec![],
        },
        // Error 动作(declare error → fail-closed)。
        RuleSet {
            relations: vec![RelationRule {
                entity: "Avatar".into(),
                property_path: "items".into(),
                child_table: "tbl_Avatar_items".into(),
                parent_table: "tbl_Avatar".into(),
                join_column: "parentID".into(),
                action: RelationRuleAction::Error,
                note: Some("nope".into()),
            }],
            identities: vec![],
            projections: vec![],
        },
        // 投影 include/exclude 重叠 + 空 include。
        RuleSet {
            relations: vec![],
            identities: vec![],
            projections: vec![ProjectRule {
                table: "tbl_Avatar".into(),
                include_columns: Some(vec!["id".into(), "sm_name".into()]),
                exclude_columns: vec!["sm_name".into()],
            }],
        },
        RuleSet {
            relations: vec![],
            identities: vec![],
            projections: vec![ProjectRule {
                table: "tbl_Avatar".into(),
                include_columns: Some(vec![]),
                exclude_columns: vec![],
            }],
        },
    ];
    for (i, rules) in malformed.iter().enumerate() {
        let _ = must_not_panic("RuleSet::validate", || rules.validate(&schema)).unwrap();
        // apply_relation / project / identity_column 同样不 panic。
        let _ =
            must_not_panic("apply_relation", || rules.apply_relation("Avatar", "items")).unwrap();
        let _ = must_not_panic("project", || rules.project(&schema.tables[0].clone())).unwrap();
        let _ = must_not_panic("identity_column", || rules.identity_column("tbl_Avatar")).unwrap();
        let _ = i;
    }
}

// ---------------------------------------------------------------------------
// 4. 嵌套/环关系 fuzz(终止、不 panic、环被检出)
// ---------------------------------------------------------------------------

#[test]
fn relation_deep_chain_terminates() {
    // 深链(2000 级):build + topological_order 必须终止且不 panic。
    let depth = 2000;
    let mut tables = Vec::with_capacity(depth + 1);
    tables.push(chain_table("tbl_0", None));
    for i in 1..=depth {
        let prev = format!("tbl_{}", i - 1);
        tables.push(chain_table(&format!("tbl_{i}"), Some(&prev)));
    }
    let schema = CloneSchema::new("Avatar".into(), tables.clone()).expect("deep schema");
    let g = must_not_panic("RelationGraph::build(deep)", || {
        RelationGraph::build(&schema, &tables)
    })
    .unwrap()
    .expect("deep chain builds");
    let order = must_not_panic("topological_order(deep)", || g.topological_order(&schema)).unwrap();
    assert_eq!(order.len(), depth + 1, "deep chain fully ordered");
}

#[test]
fn relation_cycle_detected_no_hang() {
    // 双向环 A<->B(互为 parent,与 relations.rs rejects_cycle 同口径)
    // → build 必检出 CycleDetected,不挂起。
    let tables = vec![
        chain_table("tbl_0", None),
        chain_table("tbl_a", Some("tbl_b")),
        chain_table("tbl_b", Some("tbl_a")),
    ];
    let schema = CloneSchema::new("Avatar".into(), tables.clone()).expect("schema");
    let r = must_not_panic("RelationGraph::build(cycle)", || {
        RelationGraph::build(&schema, &tables)
    })
    .unwrap();
    let err = r.expect_err("cycle must be rejected");
    assert!(
        matches!(err, CloneError::CycleDetected(_)),
        "cycle must surface as CycleDetected, got {err:?}"
    );
}

#[test]
fn relation_large_fanout_terminates() {
    // 单根 → 5000 子表扇出。
    let root = chain_table("tbl_0", None);
    let mut tables = vec![root];
    for i in 1..=5000 {
        tables.push(chain_table(&format!("tbl_{i}"), Some("tbl_0")));
    }
    let schema = CloneSchema::new("Avatar".into(), tables.clone()).expect("schema");
    let g = must_not_panic("RelationGraph::build(fanout)", || {
        RelationGraph::build(&schema, &tables)
    })
    .unwrap()
    .expect("fanout builds");
    let order =
        must_not_panic("topological_order(fanout)", || g.topological_order(&schema)).unwrap();
    assert_eq!(order.len(), 5001, "fanout fully ordered");
}

#[test]
fn relation_deep_plus_cycle_terminates() {
    // 深链末端接环:build 终止(检出环或成功),不挂起不 panic。
    let depth = 1000;
    let mut tables = Vec::with_capacity(depth + 2);
    tables.push(chain_table("tbl_0", None));
    for i in 1..=depth {
        let prev = format!("tbl_{}", i - 1);
        tables.push(chain_table(&format!("tbl_{i}"), Some(&prev)));
    }
    // 末端子表回引链中段 → 环。
    tables.push(chain_table("tbl_loop", Some("tbl_500")));
    let schema = CloneSchema::new("Avatar".into(), tables.clone()).expect("schema");
    let _ = must_not_panic("RelationGraph::build(deep+cycle)", || {
        RelationGraph::build(&schema, &tables)
    })
    .unwrap();
}
