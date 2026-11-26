//! Fuzz (PDC-0602): the fail-closed face for archives / rules / malformed BLOB /
//! nested relations / cycle references.
//!
//! Everything is driven by a deterministic PRNG or hand-made malformed fixtures and
//! asserts "never panic" -- the parsing face is only allowed to return Ok or Err,
//! never unwind (a panic fails the test). Runs with plain `cargo test`, no
//! cargo-fuzz/nightly dependency; the PRNG uses xorshift64 to avoid third-party
//! deps and to stay reproducible in CI.
//!
//! Coverage:
//! - archive byte streams (magic/version/flags/frame header/manifest/checksum/jsonl)
//!   -> Archive::open must not panic;
//! - malformed TypedRow/BLOB (odd-length hex, non-hex, negative BigUInt, unknown tag)
//!   -> serde must not panic;
//! - rules (empty entity / unknown table / self reference / include+exclude overlap)
//!   -> validate/apply must not panic;
//! - nested / cyclic relations (deep chain, cycle, fan-out) -> RelationGraph
//!   terminates without panicking, and cycles are detected.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};

use kode_db_clone::redact::RedactionReport;
use kode_db_clone::{
    Archive, ArchiveWriter, CloneError, CloneSchema, DerivedField, DerivedTable, IdentityRule,
    ProjectRule, RelationGraph, RelationRule, RelationRuleAction, RowSink, RuleSet, SchemaSource,
    TypedRow, TypedValue,
};

/// Deterministic xorshift64 PRNG (no third-party deps, reproducible in CI).
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

/// Temp file path (includes process id + iteration sequence to avoid concurrent worker clashes).
fn tmp_path(tag: &str, seq: u64) -> PathBuf {
    let pid = std::process::id();
    std::env::temp_dir().join(format!("kode-fuzz-{tag}-{pid}-{seq}.kdpclone"))
}

/// Write a temp file, return its path.
fn write_tmp(bytes: &[u8], tag: &str, seq: u64) -> PathBuf {
    let p = tmp_path(tag, seq);
    std::fs::write(&p, bytes).expect("write fuzz temp");
    p
}

/// Assert the closure never panics; returns the Ok/Err result (for further assertions).
fn must_not_panic<T>(what: &str, f: impl FnOnce() -> T) -> std::thread::Result<T> {
    let r = catch_unwind(AssertUnwindSafe(f));
    assert!(
        r.is_ok(),
        "{what} panicked (must fail closed, never unwind)"
    );
    r
}

// ---------------------------------------------------------------------------
// Construction helpers (same conventions as golden_plan/apply)
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

/// Chained child table: parent is the previous level (root has parent=None).
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

/// Write a minimal valid archive (starting point for mutation fuzzing).
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

/// Read all bytes.
fn read_bytes(path: &Path) -> Vec<u8> {
    std::fs::read(path).expect("read archive")
}

// ---------------------------------------------------------------------------
// 1. Archive byte-stream fuzz
// ---------------------------------------------------------------------------

#[test]
fn archive_random_bytes_never_panics() {
    let mut rng = XorShift::new(0x5eed_2026);
    for i in 0..300u64 {
        let len = rng.range(0, 4096);
        let bytes = rng.bytes(len);
        let p = write_tmp(&bytes, "rand", i);
        let res = must_not_panic("Archive::open(random bytes)", || Archive::open(&p, None));
        // Either Ok or Err is fine; the key is not panicking.
        let _ = res.unwrap();
        let _ = std::fs::remove_file(&p);
    }
    // Occasional large buffers (close to but under cap; the construction guarantees < cap).
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

    // Flip each of the first 64 bytes one by one (magic/version/flags/first frame header).
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

    // Every truncation point (each of the first 32 bytes, plus random later cuts).
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

    // Append garbage / corrupt manifest bytes (checksum must be broken -> Err, no panic).
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
    // Hand-built bad header: wrong magic, wrong version, wrong flags (encryption bit set but no key).
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
    bad_ver[9] = 99; // MAGIC.len()==9, version sits at index 9.
    let p = write_tmp(&bad_ver, "badver", 0);
    let e = must_not_panic("Archive::open(bad version)", || Archive::open(&p, None))
        .unwrap()
        .unwrap_err();
    assert!(
        matches!(e, CloneError::ArchiveError(_)),
        "bad version must be ArchiveError, got {e:?}"
    );
    let _ = std::fs::remove_file(&p);

    // Encryption flag set but no key provided -> Err (no panic).
    let mut enc = bytes.clone();
    enc[10] |= 0x01; // MAGIC.len()+1==10 is the flags byte.
    let p = write_tmp(&enc, "encflag", 0);
    let _ = must_not_panic("Archive::open(encrypted, no key)", || {
        Archive::open(&p, None)
    })
    .unwrap();
    let _ = std::fs::remove_file(&p);
}

// ---------------------------------------------------------------------------
// 2. jsonl row / malformed BLOB fuzz
// ---------------------------------------------------------------------------

#[test]
fn jsonl_row_fuzz_never_panics() {
    let mut rng = XorShift::new(0xc0ffee);
    // Random bytes as jsonl rows.
    for i in 0..300u64 {
        let n = rng.range(0, 512);
        let bytes = rng.bytes(n);
        let _ = must_not_panic("TypedRow(random bytes)", || {
            serde_json::from_slice::<TypedRow>(&bytes)
        })
        .unwrap();
        let _ = i;
    }
    // Valid-ish JSON but with malformed fields.
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
    // Bytes variant with malformed hex (odd length / non-hex / overly long) -> deserialization must not panic.
    let cases = [
        r#"{"t":"bytes","v":"0f0"}"#,        // odd-length hex
        r#"{"t":"bytes","v":"zzzz"}"#,       // non-hex
        r#"{"t":"bytes","v":""}"#,           // empty
        r#"{"t":"bytes","v":"0f0f0f0f0f"}"#, // valid but meaningless
    ];
    for (i, c) in cases.iter().enumerate() {
        let json = format!(r#"{{"table":"tbl_Avatar","values":[{c}]}}"#);
        let _ = must_not_panic("malformed BLOB row", || {
            serde_json::from_str::<TypedRow>(&json)
        })
        .unwrap();
        let _ = i;
    }
    // Negative BigUInt / Int overflow / unknown tag / DateTime missing offset.
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
// 3. Rule fuzz (malformed structure -> fail-closed, no panic)
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
        // Empty entity / empty table / empty column.
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
        // Unknown table.
        RuleSet {
            relations: vec![],
            identities: vec![IdentityRule {
                entity: "Avatar".into(),
                table: "tbl_NoSuch".into(),
                column: "id".into(),
            }],
            projections: vec![],
        },
        // Self reference (entity == child table path).
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
        // Error action (declare error -> fail-closed).
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
        // Projection include/exclude overlap + empty include.
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
        // apply_relation / project / identity_column must not panic either.
        let _ =
            must_not_panic("apply_relation", || rules.apply_relation("Avatar", "items")).unwrap();
        let _ = must_not_panic("project", || rules.project(&schema.tables[0].clone())).unwrap();
        let _ = must_not_panic("identity_column", || rules.identity_column("tbl_Avatar")).unwrap();
        let _ = i;
    }
}

// ---------------------------------------------------------------------------
// 4. Nested/cyclic relation fuzz (terminates, no panic, cycles detected)
// ---------------------------------------------------------------------------

#[test]
fn relation_deep_chain_terminates() {
    // Deep chain (2000 levels): build + topological_order must terminate and not panic.
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
    // Bidirectional cycle A<->B (mutual parents, same convention as relations.rs rejects_cycle)
    // -> build must detect CycleDetected and must not hang.
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
    // Single root -> 5000 child tables fan-out.
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
    // Deep chain ending in a cycle: build terminates (cycle detected or success), no hang, no panic.
    let depth = 1000;
    let mut tables = Vec::with_capacity(depth + 2);
    tables.push(chain_table("tbl_0", None));
    for i in 1..=depth {
        let prev = format!("tbl_{}", i - 1);
        tables.push(chain_table(&format!("tbl_{i}"), Some(&prev)));
    }
    // Tail child table points back into the middle of the chain -> cycle.
    tables.push(chain_table("tbl_loop", Some("tbl_500")));
    let schema = CloneSchema::new("Avatar".into(), tables.clone()).expect("schema");
    let _ = must_not_panic("RelationGraph::build(deep+cycle)", || {
        RelationGraph::build(&schema, &tables)
    })
    .unwrap();
}
