//! PDC-0605 跨平台验证(计划书 Phase 6):Windows/Linux/macOS 文件路径、密钥存储。
//!
//! 路径处理全经 PathBuf/.join(源码无硬编码 `/` 字符串拼接,已核),本文件从
//! 公开 API 补跨平台边界测试:Windows 分隔符/盘符/空格/Unicode 的密钥 id 消毒
//! 与路径 roundtrip。CLI 二进制 §8 明示"示例不等于现在存在的命令",未实现,
//! 当前交付面=命令面板入口+Rust RPC;本文件不虚报 CLI。

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
// 1. 密钥 id 消毒:Windows 分隔符/盘符/空格载荷一律拍平,防路径穿越。
// ---------------------------------------------------------------------------

#[test]
fn key_id_windows_separators_and_drive_are_sanitized() {
    let dir = temp_dir("win-id");
    let store = FileKeyStore::new(&dir);
    // Windows 遍历载荷:反斜杠分隔、盘符、混合分隔、空格(Windows 常见)。
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
    // 根下确无越界文件(消毒后仅允许 alnum/-/_)。
    for entry in std::fs::read_dir(&dir).unwrap() {
        let name = entry.unwrap().file_name().into_string().unwrap();
        assert!(
            name.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.'),
            "越界文件名: {name}"
        );
    }
    let _ = std::fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------------------
// 2. 密钥根/归档路径带空格+Unicode(Windows/macOS 常见)。
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
    // 重开核验:同一路径(含空格/Unicode)roundtrip 成功。
    let reopened = kode_db_clone::archive::Archive::inspect(&archive_path, None).unwrap();
    assert_eq!(reopened.entity, "Avatar");
    assert_eq!(reopened.total_rows, 1);
    assert_eq!(reopened.tables[0].rows, 1);
    // 文件真实存在且非空。
    let len = std::fs::metadata(&archive_path).unwrap().len();
    assert!(len > 0, "归档文件非空");
    let _ = std::fs::remove_dir_all(&base);
}
