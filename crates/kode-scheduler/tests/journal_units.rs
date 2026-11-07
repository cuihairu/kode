//! 崩溃恢复台账门禁(PR-009:SCHED-021 面;书 §4 CORE-015 面 + IDX-010 崩溃写入护栏)。

use std::collections::HashMap;

use kode_scheduler::{load_journal, write_journal, TaskKind};

fn temp_dir(name: &str) -> std::path::PathBuf {
    let dir =
        std::env::temp_dir().join(format!("kode-sched-journal-{name}-{}", std::process::id()));
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
    body.push_str("SCHEDJ1\tsingle-file-update\t99\t-\t-\t-\n"); // 非法优先级
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
    // 与 journal.rs 行格式一致(供损坏行测试构造合法行)。
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
    // 临时文件不残留。
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
    // 崩溃前:3 个 queued 任务(1 个交互 + 2 个后台)。
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
    // ——「崩溃」:不复用 before,从台账重建调度器 ——

    let mut after = kode_scheduler::Scheduler::default();
    let (records, corrupt) = load_journal(&path).unwrap();
    assert_eq!(corrupt, 0);
    // /stale.def 在崩溃期间已被编辑到 v9:v2 的恢复记录过期,丢弃。
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
    // 换行转义:file 含真实 `\n` → 编码仍单行,解码还原。
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
    // 崩溃恢复容错:未知转义序列与字段末孤立 `\` 按字面保留,不算损坏。
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
    // 写台账到不存在的深层父目录:先建目录(幂等),再原子落盘。
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
    // 冷启动:文件不存在 = 空账,不算错误。
    let missing = dir.join("no-such.journal");
    let (records, corrupt) = load_journal(&missing).unwrap();
    assert!(records.is_empty());
    assert_eq!(corrupt, 0);
    // 路径是目录:非 NotFound IO 错误如实上抛,不吞。
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
    body.push('\n'); // 空行:跳过,不算损坏
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
    // 旧实现 with_extension 拼临时名,无扩展名路径实测产出 `journal..tmp`(双点)。
    // 修复后临时名 = 完整路径 + ".tmp"。
    let no_ext = std::path::Path::new("/run/kbe/journal");
    let tmp = kode_scheduler::journal::journal_tmp_path(no_ext);
    assert_eq!(tmp, std::path::Path::new("/run/kbe/journal.tmp"));
    assert!(!tmp.to_string_lossy().contains(".."));
    // 带扩展名路径:临时名保持唯一后缀,不覆盖台账本体。
    let with_ext = std::path::Path::new("/run/kbe/sched.bin");
    let tmp2 = kode_scheduler::journal::journal_tmp_path(with_ext);
    assert_eq!(tmp2, std::path::Path::new("/run/kbe/sched.bin.tmp"));
    assert_ne!(tmp2, with_ext);
}
