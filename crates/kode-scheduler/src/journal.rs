//! Crash-recovery ledger (book §4 CORE-015 surface + the scheduler's "never permanently pending"
//! recovery semantics).
//!
//! - Writing: temporary file + atomic rename (IDX-010 crash-write guard); the line format is
//!   self-describing, and the leading magic column `SCHEDJ1` prevents misreading old or
//!   heterogeneous files;
//! - Reading: per-line tolerant parsing — corrupt/unknown lines are skipped and counted, and a
//!   single bad line never discards the whole ledger;
//! - Recovery: stale records are filtered out by "current version" (a lagging version is dropped,
//!   same rule as the online stale surface), the rest are re-enqueued, and failures are never
//!   cached as false reassurance.

use std::collections::HashMap;
use std::fs;
use std::io;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::model::{priority, TaskKind};
use crate::scheduler::{RunFn, Scheduler};

/// A single pending-recovery task record (the persistent projection of a queued task).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskRecord {
    pub kind: String,
    pub priority: u8,
    pub file: Option<String>,
    pub version: Option<u64>,
    pub target: Option<String>,
}

const JOURNAL_MAGIC: &str = "SCHEDJ1";
const JOURNAL_TMP_SUFFIX: &str = ".tmp";

fn escape_field(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('\t', "\\t")
        .replace('\n', "\\n")
}

fn unescape_field(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('t') => out.push('\t'),
                Some('n') => out.push('\n'),
                Some('\\') => out.push('\\'),
                Some(other) => {
                    out.push('\\');
                    out.push(other);
                }
                None => out.push('\\'),
            }
        } else {
            out.push(c);
        }
    }
    out
}

fn opt_field(v: &Option<String>) -> String {
    match v {
        Some(s) => escape_field(s),
        None => "-".to_string(),
    }
}

fn parse_opt_field(s: &str) -> Option<String> {
    if s == "-" {
        None
    } else {
        Some(unescape_field(s))
    }
}

/// Line format: `SCHEDJ1\t<kind>\t<priority>\t<file|->\t<version|->\t<target|->`
fn encode_record(rec: &TaskRecord) -> String {
    format!(
        "{}\t{}\t{}\t{}\t{}\t{}\n",
        JOURNAL_MAGIC,
        rec.kind,
        rec.priority,
        opt_field(&rec.file),
        rec.version
            .map(|v| v.to_string())
            .unwrap_or_else(|| "-".to_string()),
        opt_field(&rec.target)
    )
}

/// Tolerantly parse one line; return None if it cannot be parsed (counted as a corrupt line).
fn decode_record(line: &str) -> Option<TaskRecord> {
    let fields: Vec<&str> = line.split('\t').collect();
    if fields.len() != 6 || fields[0] != JOURNAL_MAGIC {
        return None;
    }
    let _ = TaskKind::parse(fields[1])?;
    let priority: u8 = fields[2].parse().ok()?;
    if priority > priority::NON_INTERACTIVE {
        return None;
    }
    let version = if fields[4] == "-" {
        None
    } else {
        Some(fields[4].parse::<u64>().ok()?)
    };
    Some(TaskRecord {
        kind: fields[1].to_string(),
        priority,
        file: parse_opt_field(fields[3]),
        version,
        target: parse_opt_field(fields[5]),
    })
}

/// Ledger temporary name = full path + ".tmp" (KR-AUD-24: the old implementation spliced it
/// with `with_extension`, which produced the double-dot `journal..tmp` shape for paths without
/// an extension).
#[doc(hidden)]
pub fn journal_tmp_path(path: &Path) -> PathBuf {
    let mut s = path.as_os_str().to_os_string();
    s.push(JOURNAL_TMP_SUFFIX);
    PathBuf::from(s)
}

/// Write the ledger: temporary file + atomic rename; returns the number of records written.
pub fn write_journal(path: &Path, records: &[TaskRecord]) -> io::Result<usize> {
    let tmp = journal_tmp_path(path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    {
        let mut file = fs::File::create(&tmp)?;
        for rec in records {
            file.write_all(encode_record(rec).as_bytes())?;
        }
        file.flush()?;
        file.sync_all()?;
    }
    fs::rename(&tmp, path)?;
    Ok(records.len())
}

/// Read the ledger: returns (recoverable records, number of corrupt lines). A missing file = an
/// empty ledger (cold start).
pub fn load_journal(path: &Path) -> io::Result<(Vec<TaskRecord>, usize)> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok((Vec::new(), 0)),
        Err(e) => return Err(e),
    };
    let mut records = Vec::new();
    let mut corrupt = 0usize;
    for line in text.lines() {
        if line.is_empty() {
            continue;
        }
        match decode_record(line) {
            Some(rec) => records.push(rec),
            None => corrupt += 1,
        }
    }
    Ok((records, corrupt))
}

/// Recovery receipt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct RecoveryReport {
    /// Number of tasks re-enqueued (including records merged online).
    pub recovered: usize,
    /// Number of records dropped for lagging behind the current version (counted as stale).
    pub stale_dropped: usize,
}

impl Scheduler {
    /// Recover from the ledger: stale records are dropped by current version, the rest are
    /// re-enqueued.
    /// `current_versions`: file → currently known latest version (the version didChange already
    /// reached).
    /// `make_run`: builds the task body for each recovered record.
    pub fn recover(
        &mut self,
        records: Vec<TaskRecord>,
        current_versions: &HashMap<String, u64>,
        mut make_run: impl FnMut(&TaskRecord) -> Box<RunFn>,
    ) -> RecoveryReport {
        let mut report = RecoveryReport::default();
        for rec in records {
            let stale = match (&rec.file, rec.version) {
                (Some(file), Some(record_version)) => current_versions
                    .get(file)
                    .is_some_and(|&current| current > record_version),
                _ => false,
            };
            if stale {
                self.metrics.stale_dropped += 1;
                report.stale_dropped += 1;
                continue;
            }
            let kind = TaskKind::parse(&rec.kind).unwrap_or(TaskKind::SingleFileUpdate);
            let spec = crate::scheduler::TaskSpec {
                kind,
                priority: rec.priority,
                file: rec.file.clone(),
                version: rec.version,
                target: rec.target.clone(),
                run: make_run(&rec),
            };
            self.enqueue(spec);
            self.metrics.recoveries += 1;
            report.recovered += 1;
        }
        report
    }
}
