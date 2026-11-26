//! PDC-0605 cross-platform verification (plan doc Phase 6): Windows/Linux/macOS
//! file paths, key storage.
//!
//! Path handling all goes through PathBuf/.join (the source has no hardcoded `/`
//! string concatenation, already verified); this file adds cross-platform edge
//! tests from the public API: sanitization of key ids containing Windows
//! separators / drive letters / spaces / Unicode, and path roundtrips. The CLI
//! binary is stated in §8 as "examples are not commands that exist now" and is not
//! implemented; the current delivery face = command palette entry + Rust RPC; this
//! file does not fabricate a CLI.

use std::path::PathBuf;

use kode_db_clone::archive::{relations_from_plan, write_archive};
use kode_db_clone::keystore::{FileKeyStore, KeyStore};
use kode_db_clone::planner::{PlanFilter, PlannedQuery, QueryPlan};
use kode_db_clone::reader::{ExportBudget, ExportControl, ReadOnlyExecutor, SqlValue};
use kode_db_clone::redact::SensitivityPolicy;

fn temp_dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("kdp-plat-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

// ---------------------------------------------------------------------------
// 1. Key id sanitization: Windows separators / drive letters / space payloads are
// flattened without exception, guarding against path traversal.
// ---------------------------------------------------------------------------

#[test]
fn key_id_windows_separators_and_drive_are_sanitized() {
    let dir = temp_dir("win-id");
    let store = FileKeyStore::new(&dir);
    // Windows traversal payloads: backslash separators, drive letters, mixed
    // separators, spaces (common on Windows).
    for (id, expect_file) in [
        (r"..\escape", "___escape.key"),
        (r"..\..\x", "______x.key"),
        (r"C:\Users\player", "C__Users_player.key"),
        (r"a b\c", "a_b_c.key"),
        (r"..\..\..\etc\passwd", "_________etc_passwd.key"),
    ] {
        store.get_or_create(id).unwrap();
        assert!(dir.join(expect_file).exists(), "`{id}` → {expect_file}");
    }
    // Truly no out-of-bounds files under the root (after sanitization only
    // alnum/-/_ are allowed).
    for entry in std::fs::read_dir(&dir).unwrap() {
        let name = entry.unwrap().file_name().into_string().unwrap();
        assert!(
            name.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.'),
            "out-of-bounds filename: {name}"
        );
    }
    let _ = std::fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------------------
// 2. Key roots / archive paths with spaces + Unicode (common on Windows/macOS).
// ---------------------------------------------------------------------------

#[test]
fn key_root_with_spaces_and_unicode_works() {
    let base = temp_dir("unicode-key");
    let root = base.join("密钥 目录 with space");
    let store = FileKeyStore::new(&root);
    let key = store.get_or_create("角色-导出").unwrap();
    assert_eq!(key.len(), 32);
    assert!(store.exists("角色-导出"));
    let _ = std::fs::remove_dir_all(&base);
}

struct OneRowExec {
    rows: Vec<Vec<Option<String>>>,
}

impl ReadOnlyExecutor for OneRowExec {
    fn query(
        &self,
        _sql: &str,
        _params: &[SqlValue],
    ) -> kode_db_clone::CloneResult<Vec<Vec<Option<String>>>> {
        Ok(self.rows.clone())
    }
    fn execute(&self, _sql: &str) -> kode_db_clone::CloneResult<()> {
        Ok(())
    }
}

fn one_row_plan() -> QueryPlan {
    QueryPlan {
        entity_name: "Avatar".into(),
        row_budget: u64::MAX,
        queries: vec![PlannedQuery {
            sequence: 0,
            table: "tbl_Avatar".into(),
            parent_table: None,
            filter: PlanFilter::RootId,
            columns: vec!["id".into(), "sm_name".into()],
            column_types: vec!["bigint unsigned".into(), "varchar".into()],
            select_sql: "SELECT `id`, `sm_name` FROM `tbl_Avatar` WHERE `id` = ?".into(),
            estimated_rows: Some(1),
        }],
        denied: vec![],
        missing: vec![],
        identity: None,
        estimated_rows_total: Some(1),
    }
}

#[test]
fn archive_roundtrip_on_space_and_unicode_path() {
    let base = temp_dir("unicode-arch");
    let archive_path = base.join("玩家 克隆 归档 😀.kdp");
    let plan = one_row_plan();
    let exec = OneRowExec {
        rows: vec![vec![Some("7".into()), Some("Alice".into())]],
    };
    let relations = relations_from_plan(&plan);
    let meta = write_archive(
        &archive_path,
        &plan,
        &relations,
        7,
        &exec,
        &SensitivityPolicy::default(),
        None,
        &ExportBudget::unlimited(),
        &ExportControl::new(),
    )
    .unwrap();
    assert_eq!(meta.entity, "Avatar");
    assert_eq!(meta.total_rows, 1);
    assert!(!meta.encrypted);
    // Reopen verification: the same path (with spaces/Unicode) roundtrips.
    let reopened = kode_db_clone::archive::Archive::inspect(&archive_path, None).unwrap();
    assert_eq!(reopened.entity, "Avatar");
    assert_eq!(reopened.total_rows, 1);
    assert_eq!(reopened.tables[0].rows, 1);
    // The file really exists and is non-empty.
    let len = std::fs::metadata(&archive_path).unwrap().len();
    assert!(len > 0, "archive file is non-empty");
    let _ = std::fs::remove_dir_all(&base);
}
