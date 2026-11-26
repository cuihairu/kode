//! Crash-recovery ledger gate (PR-009: the SCHED-021 surface; book §4 CORE-015 surface + the
//! IDX-010 crash-write guard).

use std::collections::HashMap;

use kode_scheduler::{load_journal, write_journal, TaskKind};

fn temp_dir(name: &str) -> std::path::PathBuf {
    // Sequence-number suffix: the cases inside one test process share the same pid, and
    // same-named directories would remove_dir_all each other (under parallel threads,
    // write_journal hits a mid-run NotFound) — every call must be unique.
    static DIR_SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let seq = DIR_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "kode-sched-journal-{name}-{seq}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn record(
    kind: TaskKind,
    priority: u8,
    file: Option<&str>,
    version: Option<u64>,
) -> kode_scheduler::TaskRecord {
    kode_scheduler::TaskRecord {
        kind: kind.as_str().to_string(),
        priority,
        file: file.map(str::to_string),
        version,
        target: None,
    }
}

#[test]
fn journal_roundtrip_with_field_escaping() {
    let dir = temp_dir("roundtrip");
    let path = dir.join("sched.journal");
    let records = vec![
        record(TaskKind::SingleFileUpdate, 0, Some("/a\tb\\c.def"), Some(3)),
        record(TaskKind::InitialScan, 3, None, None),
    ];
    assert_eq!(write_journal(&path, &records).unwrap(), 2);
    let (loaded, corrupt) = load_journal(&path).unwrap();
    assert_eq!(corrupt, 0);
    assert_eq!(loaded, records);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn journal_skips_corrupt_lines_without_losing_good_ones() {
    let dir = temp_dir("corrupt");
    let path = dir.join("sched.journal");
    let mut body = String::new();
    body.push_str(&format!(
        "{}\n",
        crate_line(&record(
            TaskKind::SingleFileUpdate,
            1,
            Some("/ok.def"),
            Some(2)
        ))
    ));
    body.push_str("GARBAGE LINE\n");
    body.push_str("SCHEDJ1\tbogus-kind\t1\t-\t-\t-\n");
    body.push_str("SCHEDJ1\tsingle-file-update\t99\t-\t-\t-\n"); // invalid priority
    body.push_str(&format!(
        "{}\n",
        crate_line(&record(TaskKind::FullReindex, 3, None, None))
    ));
    std::fs::write(&path, body).unwrap();
    let (loaded, corrupt) = load_journal(&path).unwrap();
    assert_eq!(corrupt, 3);
    assert_eq!(loaded.len(), 2);
    assert_eq!(loaded[0].file.as_deref(), Some("/ok.def"));
    let _ = std::fs::remove_dir_all(&dir);
}

fn crate_line(rec: &kode_scheduler::TaskRecord) -> String {
    // Matches the journal.rs line format (lets the corrupt-line tests build a legal line).
    let file = rec.file.clone().unwrap_or_else(|| "-".to_string());
    let version = rec
        .version
        .map(|v| v.to_string())
        .unwrap_or_else(|| "-".to_string());
    format!(
        "SCHEDJ1\t{}\t{}\t{}\t{}\t-",
        rec.kind, rec.priority, file, version
    )
}

#[test]
fn journal_write_is_atomic_replacement() {
    let dir = temp_dir("atomic");
    let path = dir.join("sched.journal");
    std::fs::write(&path, "STALE OLD CONTENT\n").unwrap();
    write_journal(
        &path,
        &[record(TaskKind::DeleteCleanup, 2, Some("/gone.def"), None)],
    )
    .unwrap();
    let text = std::fs::read_to_string(&path).unwrap();
    assert!(!text.contains("STALE OLD CONTENT"));
    // No temporary file lingers.
    let leftovers: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().is_some_and(|x| x == "tmp"))
        .collect();
    assert!(leftovers.is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn crash_recovery_replays_pending_and_drops_stale() {
    // Before the crash: 3 queued tasks (1 interactive + 2 background).
    let mut before = kode_scheduler::Scheduler::default();
    before.enqueue(kode_scheduler::TaskSpec {
        kind: TaskKind::SingleFileUpdate,
        priority: 0,
        file: Some("/open.def".to_string()),
        version: Some(7),
        target: None,
        run: Box::new(|_| Ok(())),
    });
    before.enqueue(kode_scheduler::TaskSpec {
        kind: TaskKind::FullReindex,
        priority: 3,
        file: Some("/stale.def".to_string()),
        version: Some(2),
        target: None,
        run: Box::new(|_| Ok(())),
    });
    before.enqueue(kode_scheduler::TaskSpec {
        kind: TaskKind::FullReindex,
        priority: 3,
        file: None,
        version: None,
        target: None,
        run: Box::new(|_| Ok(())),
    });
    let pending = before.pending_records();
    assert_eq!(pending.len(), 3);

    let dir = temp_dir("recovery");
    let path = dir.join("sched.journal");
    write_journal(&path, &pending).unwrap();
    // —— "the crash": do not reuse `before`; rebuild the scheduler from the ledger ——

    let mut after = kode_scheduler::Scheduler::default();
    let (records, corrupt) = load_journal(&path).unwrap();
    assert_eq!(corrupt, 0);
    // /stale.def was already edited to v9 during the crash: the v2 recovery record is stale and
    // is dropped.
    let mut current = HashMap::new();
    current.insert("/stale.def".to_string(), 9u64);
    let report = after.recover(records, &current, |rec| {
        let file = rec.file.clone();
        Box::new(move |_| {
            let _ = file;
            Ok(())
        })
    });
    assert_eq!(report.stale_dropped, 1);
    assert_eq!(report.recovered, 2);
    assert_eq!(after.status().metrics.stale_dropped, 1);
    assert_eq!(after.status().metrics.recoveries, 2);
    after.drain(200);
    assert_eq!(after.status().completed, 2);
    assert!(after.status().keyed_tasks.is_empty());
    assert_eq!(after.status().queued, 0);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn journal_unescapes_newline_roundtrip() {
    // Newline escaping: a file containing a real `\n` → still a single line when encoded, restored
    // on decode.
    let dir = temp_dir("newline");
    let path = dir.join("sched.journal");
    let rec = record(TaskKind::SingleFileUpdate, 1, Some("/a\nb.def"), None);
    write_journal(&path, std::slice::from_ref(&rec)).unwrap();
    let (loaded, corrupt) = load_journal(&path).unwrap();
    assert_eq!(corrupt, 0);
    assert_eq!(loaded, vec![rec]);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn journal_tolerates_unknown_escape_and_trailing_backslash() {
    // Crash-recovery tolerance: an unknown escape sequence and a lone `\` at field end are kept
    // literally, not counted as corruption.
    let dir = temp_dir("unknown-esc");
    let path = dir.join("sched.journal");
    std::fs::write(
        &path,
        "SCHEDJ1\tsingle-file-update\t1\t/a\\xb.def\\\t-\t-\n",
    )
    .unwrap();
    let (loaded, corrupt) = load_journal(&path).unwrap();
    assert_eq!(corrupt, 0);
    assert_eq!(loaded.len(), 1);
    assert_eq!(loaded[0].file.as_deref(), Some("/a\\xb.def\\"));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn journal_write_creates_nested_parent_dirs() {
    // Write the ledger to a nonexistent deep parent directory: create directories first
    // (idempotent), then land atomically.
    let dir = temp_dir("nested");
    let path = dir.join("deep").join("sub").join("sched.journal");
    assert_eq!(
        write_journal(&path, &[record(TaskKind::DeleteCleanup, 2, None, None)]).unwrap(),
        1
    );
    let (loaded, corrupt) = load_journal(&path).unwrap();
    assert_eq!(corrupt, 0);
    assert_eq!(loaded.len(), 1);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn journal_load_missing_file_is_empty_and_non_file_path_errors() {
    let dir = temp_dir("load-errors");
    // Cold start: a missing file = an empty ledger, not an error.
    let missing = dir.join("no-such.journal");
    let (records, corrupt) = load_journal(&missing).unwrap();
    assert!(records.is_empty());
    assert_eq!(corrupt, 0);
    // The path is a directory: a non-NotFound IO error is surfaced truthfully, not swallowed.
    let err = load_journal(&dir).unwrap_err();
    assert_ne!(err.kind(), std::io::ErrorKind::NotFound);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn journal_blank_lines_are_ignored() {
    let dir = temp_dir("blank");
    let path = dir.join("sched.journal");
    let mut body = String::new();
    body.push_str(&format!(
        "{}\n",
        crate_line(&record(
            TaskKind::SingleFileUpdate,
            1,
            Some("/a.def"),
            Some(2)
        ))
    ));
    body.push('\n'); // blank line: skipped, not counted as corruption
    body.push_str(&format!(
        "{}\n",
        crate_line(&record(TaskKind::FullReindex, 3, None, None))
    ));
    std::fs::write(&path, body).unwrap();
    let (loaded, corrupt) = load_journal(&path).unwrap();
    assert_eq!(corrupt, 0, "空行不算损坏");
    assert_eq!(loaded.len(), 2);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn journal_tmp_name_has_no_double_dot_kraud24() {
    // The old implementation spliced the temp name with with_extension; measured, an extensionless
    // path produced `journal..tmp` (a double dot).
    // After the fix, the temp name = full path + ".tmp".
    let no_ext = std::path::Path::new("/run/kbe/journal");
    let tmp = kode_scheduler::journal::journal_tmp_path(no_ext);
    assert_eq!(tmp, std::path::Path::new("/run/kbe/journal.tmp"));
    assert!(!tmp.to_string_lossy().contains(".."));
    // A path with an extension: the temp name keeps its unique suffix and does not overwrite the
    // ledger itself.
    let with_ext = std::path::Path::new("/run/kbe/sched.bin");
    let tmp2 = kode_scheduler::journal::journal_tmp_path(with_ext);
    assert_eq!(tmp2, std::path::Path::new("/run/kbe/sched.bin.tmp"));
    assert_ne!(tmp2, with_ext);
}

#[test]
fn write_journal_creates_missing_parent_dirs() {
    let dir = temp_dir("nested");
    let nested = dir.join("a/b/c/journal.log");
    let records = vec![record(
        TaskKind::DependencyUpdate,
        2,
        Some("/x.def"),
        Some(1),
    )];
    assert_eq!(write_journal(&nested, &records).unwrap(), 1);
    let (back, _skipped) = load_journal(&nested).expect("回读应成功");
    assert_eq!(back.len(), 1, "落盘记录数一致");
}

#[test]
fn write_journal_errors_when_parent_blocked_by_file() {
    // The parent chain is blocked by a plain file: create_dir_all fails → the early-exit error
    // arm must hand the Err back truthfully (without leaving a half-written file behind).
    let dir = temp_dir("blocked");
    let blocker = dir.join("blocker");
    std::fs::write(&blocker, b"not a dir").unwrap();
    let target = blocker.join("sub/journal.log");
    let records = vec![record(
        TaskKind::DependencyUpdate,
        2,
        Some("/x.def"),
        Some(1),
    )];
    assert!(
        write_journal(&target, &records).is_err(),
        "父目录不可创建应报错"
    );
}

#[test]
fn write_journal_empty_path_errors_without_dir_setup() {
    // An empty path: parent() == None, the directory-preparation section is skipped entirely and
    // the landing section errors; the error must be handed back truthfully rather than panicking.
    let records = vec![record(
        TaskKind::DependencyUpdate,
        2,
        Some("/x.def"),
        Some(1),
    )];
    let out = std::panic::catch_unwind(|| write_journal(std::path::Path::new(""), &records));
    match out {
        Ok(res) => assert!(res.is_err(), "空路径应报错"),
        Err(_) => panic!("空路径不得 panic"),
    }
}
