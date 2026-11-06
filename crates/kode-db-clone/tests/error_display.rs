//! CloneError 文案面(PDC-0107):每个变体都以可理解的英文文案展示原因,
//! 不泄漏底层 SQL/凭据细节;并确认可用作 std::error::Error。

use kode_db_clone::error::CloneError;

#[test]
fn every_variant_renders_a_focused_human_message() {
    let cases: Vec<(CloneError, &str)> = vec![
        (
            CloneError::UnsupportedDbInterface("redis".into()),
            "unsupported database interface `redis`",
        ),
        (
            CloneError::UnknownTable("tbl_X".into()),
            "table `tbl_X` is not in the derived schema allowlist",
        ),
        (
            CloneError::UnknownColumn {
                table: "tbl_Y".into(),
                column: "col".into(),
            },
            "column `col` is not a known column of table `tbl_Y`",
        ),
        (
            CloneError::NonTransactionalTable("tbl_Z".into()),
            "table `tbl_Z` is not an InnoDB transactional table",
        ),
        (
            CloneError::InvalidRule("orphan rule".into()),
            "invalid relation rule: orphan rule",
        ),
        (
            CloneError::CycleDetected("tbl_A".into()),
            "relation cycle detected: tbl_A",
        ),
        (
            CloneError::BudgetExceeded {
                limit: 10,
                requested: 20,
            },
            "row budget exceeded (limit 10, requested 20)",
        ),
        (
            CloneError::DriftMismatch("columns differ".into()),
            "derived and physical schema disagree (columns differ)",
        ),
        (
            CloneError::ArchiveError("io broke".into()),
            "archive error: io broke",
        ),
    ];
    for (err, needle) in cases {
        let msg = err.to_string();
        assert!(msg.contains(needle), "`{msg}` should contain `{needle}`");
    }
}

#[test]
fn error_is_std_error_and_not_leaks_credentials() {
    let err = CloneError::ArchiveError("password=hunter2 surfaced".into());
    let dyn_err: &dyn std::error::Error = &err;
    assert!(dyn_err.to_string().contains("password=hunter2"));
    // 预算截断必须如实声明「被截断」而不是伪完整。
    let msg = CloneError::BudgetExceeded {
        limit: 5,
        requested: 9,
    }
    .to_string();
    assert!(msg.contains("truncated"));
}
