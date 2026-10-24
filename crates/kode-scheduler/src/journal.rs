//! 崩溃恢复台账(书 §4 CORE-015 面 + 调度器「不永久 pending」恢复语义)。
//!
//! - 写入:临时文件 + 原子 rename(IDX-010 崩溃写入护栏);行格式自描述,
//!   首列 magic `SCHEDJ1` 防误读旧/异构文件;
//! - 读取:逐行容错解析——损坏/未知行跳过并计数,绝不因单行坏数据丢弃整账;
//! - 恢复:按「当前版本」过滤过期记录(版本落后即丢弃,与在线 stale 面同规),
//!   其余重新入队,失败不缓存假象。

use std::collections::HashMap;
use std::fs;
use std::io;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::model::{priority, TaskKind};
use crate::scheduler::{RunFn, Scheduler};

/// 单条待恢复任务记录(queued 任务的持久投影)。
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

/// 行格式:`SCHEDJ1\t<kind>\t<priority>\t<file|->\t<version|->\t<target|->`
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

/// 容错解析一行;无法解析返回 None(计入损坏行)。
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

/// 写台账:临时文件 + 原子 rename;返回写入记录数。
pub fn write_journal(path: &Path, records: &[TaskRecord]) -> io::Result<usize> {
    let tmp: PathBuf = path.with_extension(format!(
        "{}{JOURNAL_TMP_SUFFIX}",
        path.extension().and_then(|e| e.to_str()).unwrap_or("")
    ));
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

/// 读台账:返回 (可恢复记录, 损坏行数)。文件不存在 = 空账(冷启动)。
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

/// 恢复回执。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct RecoveryReport {
    /// 重新入队的任务数(含在线合并的记录)。
    pub recovered: usize,
    /// 版本落后于当前版本被丢弃的记录数(计 stale)。
    pub stale_dropped: usize,
}

impl Scheduler {
    /// 从台账恢复:过期记录按当前版本丢弃,其余重新入队。
    /// `current_versions`:file → 当前已知最新版本(didChange 已到达的版本)。
    /// `make_run`:为每条恢复记录构造任务体。
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
