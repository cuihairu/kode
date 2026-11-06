//! 玩家数据归档(PDC-0204/0206/0207):帧式容器 + 清单 + SHA-256 完整性 + 临时文件原子提交。
//!
//! 格式:11 字节头(魔数 `KDPCLONE1` + 格式版本 + 标志位,bit0=加密),其后为帧序列。
//! 每帧:`u32` 名长 + 名 + [12 字节 nonce(加密时)] + `u64` 载荷长 + 32 字节
//! SHA-256(明文) + 载荷(明文或 chacha20poly1305 密文,头部整体作 AEAD 关联数据)。
//! 逻辑文件:`manifest.json`(索引,最后写入——截断即缺清单)、`data/<表>.rows.jsonl`
//! (逐行类型化值)、`relations.json`、`redaction-report.json`、`checksums.json`。
//!
//! 写入面:[`ArchiveWriter`] 是行汇,行先按表缓冲(预算已在上游约束),`finalize`
//! 落盘全部帧;全程写临时文件,`sync_all` 后原子 rename,中断/Drop 清理,目标路径
//! 永不出现半成品。读取面:[`Archive::open`] 校验魔数/格式版本/大小上限/解密/
//! 逐帧 SHA-256/清单与帧集一致/逐表与逐文件校验和互核,任一不符 fail-closed。
//! 加密开关(PDC-0205):传密钥即逐帧 AEAD;密钥经 keystore.rs 独立存储,绝不入档。
//! 脱敏开关(PDC-0205):[`write_archive`] 经 RedactingSink 按策略默认脱敏并出报告。

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Nonce};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{CloneError, CloneResult};
use crate::planner::QueryPlan;
use crate::reader::{ExportBudget, ExportControl, ReadOnlyExecutor, RowSink, SourceReader};
use crate::redact::{RedactingSink, RedactionReport, SensitivityPolicy};
use crate::relations::{Relation, RelationKind};
use crate::value::{hex_encode, TypedRow};

/// 魔数(9 字节)。
const MAGIC: &[u8; 9] = b"KDPCLONE1";
/// 归档格式版本(读取面只认这一版;升级须新版本号+迁移读取)。
const FORMAT_VERSION: u8 = 1;
/// 标志位:bit0 = 帧经 chacha20poly1305 加密。
const FLAG_ENCRYPTED: u8 = 0x01;
/// 头长:魔数 9 + 版本 1 + 标志 1。
const HEADER_LEN: usize = MAGIC.len() + 2;
/// 归档大小上限:开档与写档都按此拒绝(防解压/拼接攻击与失控导出)。
pub const MAX_ARCHIVE_SIZE: u64 = 4 * 1024 * 1024 * 1024;
/// chacha20poly1305 认证标签长:帧头记的是**明文字节长**,加密时密文=明文+本值。
const AEAD_TAG_LEN: usize = 16;
/// 清单里的格式名。
const FORMAT_NAME: &str = "kdpclone";

/// 大小上限检查(开档按文件长度,写档按累计字节数)。
fn enforce_size_cap(limit: u64, len: u64) -> CloneResult<()> {
    if len > limit {
        return Err(CloneError::ArchiveError(format!(
            "archive size {len} exceeds the {limit}-byte limit"
        )));
    }
    Ok(())
}

/// 归档清单(manifest.json):索引 + 逐表计数/字节/校验和。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArchiveMeta {
    pub format: String,
    pub version: u8,
    /// 克隆的实体名(如 Avatar)。
    pub entity: String,
    /// 生成时刻(Unix 秒;不依赖本地时区表述)。
    pub created_at_unix: u64,
    pub encrypted: bool,
    pub total_rows: u64,
    /// 数据帧明文字节合计(不含容器开销)。
    pub total_bytes: u64,
    pub tables: Vec<TableMeta>,
    /// 全部逻辑文件名(含 manifest.json 自身)。
    pub files: Vec<String>,
}

/// 单表归档摘要。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableMeta {
    pub name: String,
    pub rows: u64,
    pub bytes: u64,
    /// 数据帧明文的 SHA-256(小写十六进制)。
    pub sha256: String,
}

/// 归档写入器:行汇 + 帧序列化 + 临时文件原子提交。
#[derive(Debug)]
pub struct ArchiveWriter {
    target: PathBuf,
    tmp: PathBuf,
    file: Option<BufWriter<File>>,
    key: Option<ArchiveKey>,
    encrypted: bool,
    /// 已写字节(含头),用于大小上限记账。
    written: u64,
    entity: String,
    /// 表 → 已编码行(jsonl 字节;finalize 时落帧)。
    pending: BTreeMap<String, Vec<u8>>,
    /// 表 → 已流入行数。
    pending_rows: BTreeMap<String, u64>,
    /// 表 → end_table 累计计数(与流入数互核,防计数漂移)。
    touched: BTreeMap<String, u64>,
    /// 已落帧的逻辑文件名 → 明文 SHA-256(生成 checksums.json)。
    files_sha: BTreeMap<String, String>,
    committed: bool,
}

/// 32 字节归档密钥(见 keystore.rs)。
type ArchiveKey = [u8; 32];

/// 同目录唯一临时名(`.{name}.tmp-{pid}-{seq}`;rename 原子性要求同文件系统)。
fn temp_path(target: &Path) -> PathBuf {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "archive.kdp".into());
    let dir = target.parent().unwrap_or_else(|| Path::new("."));
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    dir.join(format!(".{name}.tmp-{}-{seq:08x}", std::process::id()))
}

impl ArchiveWriter {
    /// 建写入器并落格式头;传密钥即逐帧加密(PDC-0205 开关)。
    pub fn new(target: &Path, key: Option<ArchiveKey>, entity: &str) -> CloneResult<Self> {
        let tmp = temp_path(target);
        let f = File::create(&tmp).map_err(|e| {
            CloneError::ArchiveError(format!("create temp archive `{}`: {e}", tmp.display()))
        })?;
        let mut file = BufWriter::new(f);
        let mut head = Vec::with_capacity(HEADER_LEN);
        head.extend_from_slice(MAGIC);
        head.push(FORMAT_VERSION);
        head.push(if key.is_some() { FLAG_ENCRYPTED } else { 0 });
        file.write_all(&head)
            .map_err(|e| CloneError::ArchiveError(format!("write archive header: {e}")))?;
        Ok(Self {
            target: target.to_path_buf(),
            tmp,
            file: Some(file),
            key,
            encrypted: key.is_some(),
            written: HEADER_LEN as u64,
            entity: entity.to_string(),
            pending: BTreeMap::new(),
            pending_rows: BTreeMap::new(),
            touched: BTreeMap::new(),
            files_sha: BTreeMap::new(),
            committed: false,
        })
    }

    /// 写一帧:SHA-256(明文)入头,加密时头部整体作 AEAD 关联数据。
    fn write_frame(&mut self, name: &str, plaintext: &[u8]) -> CloneResult<()> {
        if self.files_sha.contains_key(name) {
            return Err(CloneError::ArchiveError(format!(
                "duplicate archive frame `{name}`"
            )));
        }
        let name_bytes = name.as_bytes();
        if name_bytes.is_empty() || name_bytes.len() > 255 {
            return Err(CloneError::ArchiveError(format!(
                "archive frame name `{name}` must be 1..=255 bytes"
            )));
        }
        let sha: [u8; 32] = Sha256::digest(plaintext).into();
        let nonce = if self.encrypted {
            let mut n = [0u8; 12];
            getrandom::getrandom(&mut n)
                .map_err(|e| CloneError::ArchiveError(format!("generate nonce: {e}")))?;
            Some(n)
        } else {
            None
        };
        let mut header = Vec::with_capacity(4 + name_bytes.len() + 8 + 32 + 12);
        header.extend_from_slice(&(name_bytes.len() as u32).to_le_bytes());
        header.extend_from_slice(name_bytes);
        if let Some(n) = &nonce {
            header.extend_from_slice(n);
        }
        header.extend_from_slice(&(plaintext.len() as u64).to_le_bytes());
        header.extend_from_slice(&sha);
        let payload = match (&self.key, nonce) {
            (Some(k), Some(n)) => aead_seal(k, &n, plaintext, &header)?,
            (None, None) => plaintext.to_vec(),
            _ => {
                return Err(CloneError::ArchiveError(
                    "encryption flag and key disagree".into(),
                ))
            }
        };
        let frame_len = (header.len() + payload.len()) as u64;
        enforce_size_cap(MAX_ARCHIVE_SIZE, self.written + frame_len)?;
        {
            let f = self.file.as_mut().ok_or_else(|| {
                CloneError::ArchiveError("archive writer already finished".into())
            })?;
            f.write_all(&header)
                .map_err(|e| CloneError::ArchiveError(format!("write frame header: {e}")))?;
            f.write_all(&payload)
                .map_err(|e| CloneError::ArchiveError(format!("write frame payload: {e}")))?;
        }
        self.written += frame_len;
        self.files_sha
            .insert(name.to_string(), hex_encode(sha.as_slice()));
        Ok(())
    }

    /// 落盘全部帧并原子提交:数据帧 → relations → 脱敏报告 → 校验和 → 清单
    /// (清单最后写入,截断的归档必然缺清单而被拒绝)。成功前目标路径不存在。
    pub fn finalize(
        mut self,
        relations: &[Relation],
        report: &RedactionReport,
    ) -> CloneResult<ArchiveMeta> {
        // 计数互核:每表 end_table 累计必须等于实际流入行数(防静默丢行)。
        for (table, counted) in &self.touched {
            let streamed = self.pending_rows.get(table).copied().unwrap_or(0);
            if *counted != streamed {
                return Err(CloneError::ArchiveError(format!(
                    "table `{table}` row count mismatch: sink counted {counted}, streamed {streamed}"
                )));
            }
        }
        for table in self.pending_rows.keys() {
            if !self.touched.contains_key(table) {
                return Err(CloneError::ArchiveError(format!(
                    "table `{table}` has streamed rows but end_table was never called"
                )));
            }
        }

        let rel_bytes = serde_json::to_vec_pretty(relations)
            .map_err(|e| CloneError::ArchiveError(format!("encode relations: {e}")))?;
        self.write_frame("relations.json", &rel_bytes)?;
        let rep_bytes = serde_json::to_vec_pretty(report)
            .map_err(|e| CloneError::ArchiveError(format!("encode redaction report: {e}")))?;
        self.write_frame("redaction-report.json", &rep_bytes)?;

        // 数据帧:一表一文件(缓冲在本地,避免借用冲突)。
        let mut pending = std::mem::take(&mut self.pending);
        let mut names: BTreeSet<String> = pending.keys().cloned().collect();
        names.extend(self.touched.keys().cloned());
        let mut tables = Vec::new();
        let mut total_rows = 0u64;
        let mut total_bytes = 0u64;
        for name in names {
            let buf = pending.remove(&name).unwrap_or_default();
            let fname = format!("data/{name}.rows.jsonl");
            let sha = hex_encode(Sha256::digest(&buf).as_slice());
            let rows = self.pending_rows.get(&name).copied().unwrap_or(0);
            let bytes = buf.len() as u64;
            self.write_frame(&fname, &buf)?;
            total_rows += rows;
            total_bytes += bytes;
            tables.push(TableMeta {
                name,
                rows,
                bytes,
                sha256: sha,
            });
        }

        let sum_bytes = serde_json::to_vec_pretty(&self.files_sha)
            .map_err(|e| CloneError::ArchiveError(format!("encode checksums: {e}")))?;
        self.write_frame("checksums.json", &sum_bytes)?;

        // 此刻 files_sha 已含 data/*、relations.json、redaction-report.json、checksums.json;
        // manifest 即将写入,追加其名即成完整帧集(无重复)。
        let mut files: Vec<String> = self.files_sha.keys().cloned().collect();
        files.push("manifest.json".into());
        files.sort();
        let created_at_unix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let meta = ArchiveMeta {
            format: FORMAT_NAME.into(),
            version: FORMAT_VERSION,
            entity: self.entity.clone(),
            created_at_unix,
            encrypted: self.encrypted,
            total_rows,
            total_bytes,
            tables,
            files,
        };
        let manifest_bytes = serde_json::to_vec_pretty(&meta)
            .map_err(|e| CloneError::ArchiveError(format!("encode manifest: {e}")))?;
        self.write_frame("manifest.json", &manifest_bytes)?;

        // 原子提交:刷盘 + fsync + rename(同目录临时文件保证同文件系统)。
        let mut f = self
            .file
            .take()
            .ok_or_else(|| CloneError::ArchiveError("archive writer already finished".into()))?;
        f.flush()
            .map_err(|e| CloneError::ArchiveError(format!("flush archive: {e}")))?;
        f.get_ref()
            .sync_all()
            .map_err(|e| CloneError::ArchiveError(format!("fsync archive: {e}")))?;
        drop(f);
        fs::rename(&self.tmp, &self.target)
            .map_err(|e| CloneError::ArchiveError(format!("commit archive: {e}")))?;
        // 目录 fsync 尽力而为(部分平台不支持打开目录)。
        if let Some(dir) = self.target.parent() {
            if let Ok(d) = File::open(dir) {
                let _ = d.sync_all();
            }
        }
        self.committed = true;
        Ok(meta)
    }
}

impl RowSink for ArchiveWriter {
    fn write_row(&mut self, table: &str, row: &TypedRow) -> CloneResult<u64> {
        if row.table != table {
            return Err(CloneError::ArchiveError(format!(
                "row claims table `{}` but was streamed as `{table}`",
                row.table
            )));
        }
        let mut line = serde_json::to_vec(row)
            .map_err(|e| CloneError::ArchiveError(format!("encode row for `{table}`: {e}")))?;
        line.push(b'\n');
        let len = line.len() as u64;
        self.pending
            .entry(table.to_string())
            .or_default()
            .extend_from_slice(&line);
        *self.pending_rows.entry(table.to_string()).or_insert(0) += 1;
        Ok(len)
    }

    fn end_table(&mut self, table: &str, count: u64) -> CloneResult<()> {
        // walk 每轮父行递归都会回调;此处只累计,帧统一在 finalize 落盘。
        *self.touched.entry(table.to_string()).or_insert(0) += count;
        Ok(())
    }
}

impl Drop for ArchiveWriter {
    fn drop(&mut self) {
        // 未提交(中断/取消/出错)→ 清理临时文件,目标路径永不出现半成品。
        if !self.committed {
            let _ = fs::remove_file(&self.tmp);
        }
    }
}

/// 已验证归档:帧名 → 明文。`open` 已完成全部完整性校验。
#[derive(Debug)]
pub struct Archive {
    files: BTreeMap<String, Vec<u8>>,
    meta: ArchiveMeta,
}

impl Archive {
    /// 开档并做全部校验:魔数/格式版本/大小上限/加密旗标与密钥匹配/逐帧
    /// SHA-256/帧集与清单一致/逐表与逐文件校验和互核。任一不符即拒绝。
    pub fn open(path: &Path, key: Option<&ArchiveKey>) -> CloneResult<Self> {
        let file =
            File::open(path).map_err(|e| CloneError::ArchiveError(format!("open archive: {e}")))?;
        let file_len = file
            .metadata()
            .map_err(|e| CloneError::ArchiveError(format!("stat archive: {e}")))?
            .len();
        enforce_size_cap(MAX_ARCHIVE_SIZE, file_len)?;
        let mut r = BufReader::new(file);
        let mut head = [0u8; HEADER_LEN];
        r.read_exact(&mut head)
            .map_err(|_| CloneError::ArchiveError("archive is smaller than its header".into()))?;
        if &head[0..MAGIC.len()] != MAGIC {
            return Err(CloneError::ArchiveError(
                "not a kode player clone archive (bad magic)".into(),
            ));
        }
        let version = head[MAGIC.len()];
        if version != FORMAT_VERSION {
            return Err(CloneError::ArchiveError(format!(
                "unsupported archive version {version} (expected {FORMAT_VERSION}); refusing to guess"
            )));
        }
        let encrypted = head[MAGIC.len() + 1] & FLAG_ENCRYPTED != 0;
        match (encrypted, key) {
            (true, None) => {
                return Err(CloneError::ArchiveError(
                    "archive is encrypted; its key is required to open it".into(),
                ))
            }
            (false, Some(_)) => {
                return Err(CloneError::ArchiveError(
                    "a key was supplied but the archive is not encrypted".into(),
                ))
            }
            _ => {}
        }
        let files = read_frames(&mut r, encrypted, key)?;
        Self::verify(files, encrypted)
    }

    /// 检视:开档校验后仅返回清单(调用方拿到已验证的索引,不加载逐行解析)。
    pub fn inspect(path: &Path, key: Option<&ArchiveKey>) -> CloneResult<ArchiveMeta> {
        Archive::open(path, key).map(|a| a.meta)
    }

    fn verify(files: BTreeMap<String, Vec<u8>>, encrypted: bool) -> CloneResult<Self> {
        let manifest_bytes = files.get("manifest.json").ok_or_else(|| {
            CloneError::ArchiveError("archive has no manifest.json frame (truncated?)".into())
        })?;
        let meta: ArchiveMeta = serde_json::from_slice(manifest_bytes)
            .map_err(|e| CloneError::ArchiveError(format!("manifest.json is not valid: {e}")))?;
        if meta.format != FORMAT_NAME {
            return Err(CloneError::ArchiveError(format!(
                "manifest format `{}` is not `{FORMAT_NAME}`",
                meta.format
            )));
        }
        if meta.encrypted != encrypted {
            return Err(CloneError::ArchiveError(
                "manifest encrypted flag disagrees with the archive header".into(),
            ));
        }
        // 帧集必须与清单文件清单完全一致(多帧=外来内容,缺帧=截断)。
        if files.len() != meta.files.len()
            || files.keys().any(|k| !meta.files.iter().any(|f| f == k))
            || meta.files.iter().any(|f| !files.contains_key(f))
        {
            return Err(CloneError::ArchiveError(
                "archive frames do not match the manifest file list".into(),
            ));
        }
        // checksums.json 与实际帧逐项互核。
        let sum_bytes = files.get("checksums.json").ok_or_else(|| {
            CloneError::ArchiveError("archive has no checksums.json frame".into())
        })?;
        let checksums: BTreeMap<String, String> = serde_json::from_slice(sum_bytes)
            .map_err(|e| CloneError::ArchiveError(format!("checksums.json is not valid: {e}")))?;
        for (name, want) in &checksums {
            let data = files.get(name).ok_or_else(|| {
                CloneError::ArchiveError(format!("checksums.json lists missing file `{name}`"))
            })?;
            let got = hex_encode(Sha256::digest(data).as_slice());
            if got != *want {
                return Err(CloneError::ArchiveError(format!(
                    "checksum mismatch for `{name}`; archive is corrupted"
                )));
            }
        }
        // 逐表互核:数据帧存在、SHA 与清单一致、计数与字节合计一致。
        let mut rows_sum = 0u64;
        let mut bytes_sum = 0u64;
        for t in &meta.tables {
            let fname = format!("data/{}.rows.jsonl", t.name);
            let data = files.get(&fname).ok_or_else(|| {
                CloneError::ArchiveError(format!(
                    "manifest lists table `{}` with no data frame",
                    t.name
                ))
            })?;
            let got = hex_encode(Sha256::digest(data).as_slice());
            if got != t.sha256 {
                return Err(CloneError::ArchiveError(format!(
                    "sha256 mismatch for table `{}`; archive is corrupted",
                    t.name
                )));
            }
            rows_sum += t.rows;
            bytes_sum += t.bytes;
        }
        if rows_sum != meta.total_rows || bytes_sum != meta.total_bytes {
            return Err(CloneError::ArchiveError(
                "manifest totals disagree with its table entries".into(),
            ));
        }
        Ok(Self { files, meta })
    }

    /// 已验证清单。
    pub fn meta(&self) -> &ArchiveMeta {
        &self.meta
    }

    /// 逻辑文件内容(明文)。
    pub fn file(&self, name: &str) -> Option<&[u8]> {
        self.files.get(name).map(|v| v.as_slice())
    }

    /// 读一张表的类型化行(jsonl 逐行解析;行内表名与文件名互核)。
    pub fn table_rows(&self, table: &str) -> CloneResult<Vec<TypedRow>> {
        let fname = format!("data/{table}.rows.jsonl");
        let data = self
            .files
            .get(&fname)
            .ok_or_else(|| CloneError::UnknownTable(table.to_string()))?;
        let mut out = Vec::new();
        for line in data.split(|b| *b == b'\n') {
            if line.is_empty() {
                continue;
            }
            let row: TypedRow = serde_json::from_slice(line)
                .map_err(|e| CloneError::ArchiveError(format!("bad row in `{fname}`: {e}")))?;
            if row.table != table {
                return Err(CloneError::ArchiveError(format!(
                    "row claims table `{}` inside `{fname}`",
                    row.table
                )));
            }
            out.push(row);
        }
        Ok(out)
    }
}

/// 帧序列读取:逐帧重建头部作 AEAD 关联数据,明文 SHA-256 逐帧核对。
fn read_frames(
    r: &mut dyn Read,
    encrypted: bool,
    key: Option<&ArchiveKey>,
) -> CloneResult<BTreeMap<String, Vec<u8>>> {
    let mut files = BTreeMap::new();
    while let Some(name_len) = read_u32_or_eof(r)? {
        if name_len == 0 || name_len > 255 {
            return Err(CloneError::ArchiveError(format!(
                "archive frame name length {name_len} is out of range"
            )));
        }
        let mut name_buf = vec![0u8; name_len as usize];
        r.read_exact(&mut name_buf)
            .map_err(|e| CloneError::ArchiveError(format!("read frame name: {e}")))?;
        let name = String::from_utf8(name_buf)
            .map_err(|_| CloneError::ArchiveError("frame name is not UTF-8".into()))?;
        let mut nonce = [0u8; 12];
        if encrypted {
            r.read_exact(&mut nonce)
                .map_err(|e| CloneError::ArchiveError(format!("read frame nonce: {e}")))?;
        }
        let mut len8 = [0u8; 8];
        r.read_exact(&mut len8)
            .map_err(|e| CloneError::ArchiveError(format!("read frame length: {e}")))?;
        let data_len = u64::from_le_bytes(len8);
        enforce_size_cap(MAX_ARCHIVE_SIZE, data_len)?;
        let mut sha = [0u8; 32];
        r.read_exact(&mut sha)
            .map_err(|e| CloneError::ArchiveError(format!("read frame checksum: {e}")))?;
        // 帧头 data_len 为明文字节长;加密时密文多出认证标签长。
        let payload_len = usize::try_from(if encrypted {
            data_len
                .checked_add(AEAD_TAG_LEN as u64)
                .ok_or_else(|| CloneError::ArchiveError("frame length overflow".into()))?
        } else {
            data_len
        })
        .map_err(|_| CloneError::ArchiveError("frame too large for this platform".into()))?;
        let mut payload = vec![0u8; payload_len];
        r.read_exact(&mut payload)
            .map_err(|e| CloneError::ArchiveError(format!("read frame `{name}`: {e}")))?;
        let mut aad = Vec::with_capacity(4 + name.len() + 8 + 32 + 12);
        aad.extend_from_slice(&(name.len() as u32).to_le_bytes());
        aad.extend_from_slice(name.as_bytes());
        if encrypted {
            aad.extend_from_slice(&nonce);
        }
        aad.extend_from_slice(&len8);
        aad.extend_from_slice(&sha);
        let plaintext = if encrypted {
            let Some(k) = key else {
                return Err(CloneError::ArchiveError(
                    "archive is encrypted; its key is required to open it".into(),
                ));
            };
            aead_open(k, &nonce, &payload, &aad)?
        } else {
            payload
        };
        if Sha256::digest(&plaintext).as_slice() != sha {
            return Err(CloneError::ArchiveError(format!(
                "sha256 mismatch in frame `{name}`; archive is corrupted"
            )));
        }
        if files.insert(name.clone(), plaintext).is_some() {
            return Err(CloneError::ArchiveError(format!(
                "duplicate archive frame `{name}`"
            )));
        }
    }
    Ok(files)
}

/// 帧边界读取 `u32`:干净 EOF 返回 None(帧序列自然结束),半头即截断错误。
fn read_u32_or_eof(r: &mut dyn Read) -> CloneResult<Option<u32>> {
    let mut buf = [0u8; 4];
    let mut filled = 0;
    while filled < buf.len() {
        let n = r
            .read(&mut buf[filled..])
            .map_err(|e| CloneError::ArchiveError(format!("read archive: {e}")))?;
        if n == 0 {
            if filled == 0 {
                return Ok(None);
            }
            return Err(CloneError::ArchiveError(
                "truncated archive (partial frame header)".into(),
            ));
        }
        filled += n;
    }
    Ok(Some(u32::from_le_bytes(buf)))
}

fn aead_seal(
    key: &ArchiveKey,
    nonce: &[u8; 12],
    plaintext: &[u8],
    aad: &[u8],
) -> CloneResult<Vec<u8>> {
    let cipher = ChaCha20Poly1305::new_from_slice(key)
        .map_err(|_| CloneError::ArchiveError("archive key must be 32 bytes".into()))?;
    cipher
        .encrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| CloneError::ArchiveError("frame encryption failed".into()))
}

fn aead_open(
    key: &ArchiveKey,
    nonce: &[u8; 12],
    ciphertext: &[u8],
    aad: &[u8],
) -> CloneResult<Vec<u8>> {
    let cipher = ChaCha20Poly1305::new_from_slice(key)
        .map_err(|_| CloneError::ArchiveError("archive key must be 32 bytes".into()))?;
    cipher
        .decrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: ciphertext,
                aad,
            },
        )
        .map_err(|_| {
            CloneError::ArchiveError(
                "frame authentication failed (wrong key or corrupted archive)".into(),
            )
        })
}

/// 由计划收集关系记录(归档 relations.json 的内容;子表 → 父表 parentID 关系)。
pub fn relations_from_plan(plan: &QueryPlan) -> Vec<Relation> {
    plan.queries
        .iter()
        .filter_map(|q| {
            q.parent_table.as_ref().map(|parent| Relation {
                child_table: q.table.clone(),
                parent_table: parent.clone(),
                kind: RelationKind::EngineGenerated,
                via_property: None,
                payload_columns: Vec::new(),
            })
        })
        .collect()
}

/// 一站式导出:只读源库 → 按策略脱敏 → 归档落盘(PDC-0201/0202/0204/0205/0206)。
/// 取消/超时不产档:临时产物随 Drop 清理,目标路径永不出现半成品。
#[allow(clippy::too_many_arguments)]
pub fn write_archive(
    path: &Path,
    plan: &QueryPlan,
    relations: &[Relation],
    root_id: u64,
    executor: &dyn ReadOnlyExecutor,
    policy: &SensitivityPolicy,
    key: Option<ArchiveKey>,
    budget: &ExportBudget,
    control: &ExportControl,
) -> CloneResult<ArchiveMeta> {
    let mut writer = ArchiveWriter::new(path, key, &plan.entity_name)?;
    let mut redacting = RedactingSink::new(&mut writer, policy, plan);
    let outcome =
        SourceReader::new(executor).export(plan, root_id, &mut redacting, budget, control)?;
    if outcome.cancelled {
        return Err(CloneError::ArchiveError(
            "export cancelled or timed out before completion; no archive was written".into(),
        ));
    }
    let report = redacting.report();
    writer.finalize(relations, &report)
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;
    use crate::planner::{PlanFilter, PlannedQuery};
    use crate::reader::SqlValue;
    use crate::value::TypedValue;

    fn test_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("kdp-arch-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn relation_fixture() -> Relation {
        Relation {
            child_table: "tbl_Bag".into(),
            parent_table: "tbl_Avatar".into(),
            kind: RelationKind::EngineGenerated,
            via_property: None,
            payload_columns: Vec::new(),
        }
    }

    fn avatar_row(id: u64, name: &str) -> TypedRow {
        TypedRow {
            table: "tbl_Avatar".into(),
            values: vec![TypedValue::BigUInt(id), TypedValue::Text(name.into())],
        }
    }

    #[test]
    fn round_trip_inspect_and_read_rows() {
        let dir = test_dir("roundtrip");
        let path = dir.join("clone.kdp");
        let mut w = ArchiveWriter::new(&path, None, "Avatar").unwrap();
        let row = avatar_row(1001, "Alice");
        w.write_row("tbl_Avatar", &row).unwrap();
        w.end_table("tbl_Avatar", 1).unwrap();
        // 零行表:end_table 只有无行回调也须出档并计数 0。
        w.end_table("tbl_Empty", 0).unwrap();
        let meta = w
            .finalize(&[relation_fixture()], &RedactionReport { entries: vec![] })
            .unwrap();
        assert_eq!(meta.entity, "Avatar");
        assert!(!meta.encrypted);
        assert_eq!(meta.total_rows, 1);
        assert_eq!(meta.tables.len(), 2);

        let arc = Archive::open(&path, None).unwrap();
        assert_eq!(arc.table_rows("tbl_Avatar").unwrap(), vec![row]);
        assert!(arc.table_rows("tbl_Empty").unwrap().is_empty());
        assert_eq!(arc.meta().tables.len(), 2);
        assert!(arc.meta().files.contains(&"manifest.json".to_string()));
        assert!(arc.file("relations.json").is_some());
        assert!(arc.file("redaction-report.json").is_some());
        assert!(arc.table_rows("tbl_NoSuch").is_err());

        let meta2 = Archive::inspect(&path, None).unwrap();
        assert_eq!(meta2.total_rows, 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn encrypted_archive_requires_its_key() {
        let dir = test_dir("encrypted");
        let path = dir.join("secret.kdp");
        let key: ArchiveKey = [7u8; 32];
        let mut w = ArchiveWriter::new(&path, Some(key), "Avatar").unwrap();
        let row = avatar_row(1002, "Bob");
        w.write_row("tbl_Avatar", &row).unwrap();
        w.end_table("tbl_Avatar", 1).unwrap();
        let meta = w
            .finalize(&[], &RedactionReport { entries: vec![] })
            .unwrap();
        assert!(meta.encrypted);

        // 无钥/错钥一律拒绝;对钥才可读,明文与原行一致。
        assert!(Archive::open(&path, None).is_err());
        assert!(Archive::open(&path, Some(&[9u8; 32])).is_err());
        let arc = Archive::open(&path, Some(&key)).unwrap();
        assert_eq!(arc.table_rows("tbl_Avatar").unwrap(), vec![row.clone()]);

        // 明文归档配钥 = 用法错误,拒绝。
        let plain = dir.join("plain.kdp");
        let mut w = ArchiveWriter::new(&plain, None, "Avatar").unwrap();
        w.write_row("tbl_Avatar", &row).unwrap();
        w.end_table("tbl_Avatar", 1).unwrap();
        w.finalize(&[], &RedactionReport { entries: vec![] })
            .unwrap();
        assert!(Archive::open(&plain, Some(&key)).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupted_truncated_and_wrong_version_are_refused() {
        let dir = test_dir("corrupt");
        let path = dir.join("clone.kdp");
        let mut w = ArchiveWriter::new(&path, None, "Avatar").unwrap();
        w.write_row("tbl_Avatar", &avatar_row(1, "A")).unwrap();
        w.end_table("tbl_Avatar", 1).unwrap();
        w.finalize(&[], &RedactionReport { entries: vec![] })
            .unwrap();
        let bytes = fs::read(&path).unwrap();

        // 翻转末字节(清单载荷)→ SHA 不符。
        let mut bad = bytes.clone();
        let last = bad.len() - 1;
        bad[last] ^= 0xff;
        let bad_path = dir.join("bad.kdp");
        fs::write(&bad_path, &bad).unwrap();
        assert!(Archive::open(&bad_path, None).is_err());

        // 截断 → 帧残缺。
        let mut cut = bytes.clone();
        cut.truncate(cut.len() - 6);
        let cut_path = dir.join("cut.kdp");
        fs::write(&cut_path, &cut).unwrap();
        assert!(Archive::open(&cut_path, None).is_err());

        // 版本闸:未知版本拒绝,不猜测。
        let mut ver = bytes;
        ver[9] = 42;
        let ver_path = dir.join("ver.kdp");
        fs::write(&ver_path, &ver).unwrap();
        match Archive::open(&ver_path, None) {
            Err(CloneError::ArchiveError(m)) => assert!(m.contains("version"), "{m}"),
            other => panic!("expected version error, got {other:?}"),
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn size_cap_is_enforced() {
        assert!(enforce_size_cap(100, 99).is_ok());
        assert!(enforce_size_cap(100, 101).is_err());
        assert!(enforce_size_cap(MAX_ARCHIVE_SIZE, MAX_ARCHIVE_SIZE).is_ok());
        assert!(enforce_size_cap(MAX_ARCHIVE_SIZE, MAX_ARCHIVE_SIZE + 1).is_err());
    }

    #[test]
    fn count_mismatch_is_refused() {
        let dir = test_dir("countmismatch");
        let path = dir.join("liar.kdp");
        let mut w = ArchiveWriter::new(&path, None, "Avatar").unwrap();
        w.write_row("tbl_Avatar", &avatar_row(1, "A")).unwrap();
        w.end_table("tbl_Avatar", 5).unwrap();
        assert!(w
            .finalize(&[], &RedactionReport { entries: vec![] })
            .is_err());
        // 目标路径不存在(finalize 未到 rename),临时文件被 Drop 清理。
        assert!(!path.exists());
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn interrupted_write_leaves_no_artifact() {
        let dir = test_dir("interrupt");
        let path = dir.join("half.kdp");
        {
            let mut w = ArchiveWriter::new(&path, None, "Avatar").unwrap();
            w.write_row("tbl_Avatar", &avatar_row(1, "A")).unwrap();
            // 不 finalize:模拟中断,Drop 必须清场。
        }
        assert!(!path.exists());
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);

        // 取消的导出经 write_archive:报错且不产档。
        let plan = plan_fixture();
        let db = FakeDb::new();
        let control = ExportControl::new();
        control.cancel();
        let result = write_archive(
            &path,
            &plan,
            &relations_from_plan(&plan),
            1001,
            &db,
            &SensitivityPolicy::default(),
            None,
            &ExportBudget::unlimited(),
            &control,
        );
        assert!(result.is_err());
        assert!(!path.exists());
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn frame_names_are_guarded() {
        let dir = test_dir("framename");
        let path = dir.join("a.kdp");
        let mut w = ArchiveWriter::new(&path, None, "Avatar").unwrap();
        w.write_frame("relations.json", b"{}").unwrap();
        // 重复帧名拒绝。
        assert!(w.write_frame("relations.json", b"{}").is_err());
        // 空名/超长名拒绝。
        assert!(w.write_frame("", b"{}").is_err());
        let long = "x".repeat(256);
        assert!(w.write_frame(&long, b"{}").is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn internal_writer_states_are_refused() {
        let dir = test_dir("writerstate");
        let path = dir.join("a.kdp");
        // 加密旗标与密钥不一致 → 写帧拒绝。
        let mut w = ArchiveWriter::new(&path, None, "Avatar").unwrap();
        w.encrypted = true;
        w.key = None;
        assert!(w.write_frame("x.json", b"{}").is_err());
        drop(w);
        // 已收口的写入器(重复 finalize)再写帧 → 拒绝。
        let path2 = dir.join("b.kdp");
        let mut w = ArchiveWriter::new(&path2, None, "Avatar").unwrap();
        w.file = None;
        assert!(w.write_frame("x.json", b"{}").is_err());
        drop(w);
        // 临时目录建不出来的目标路径 → new 报 ArchiveError。
        let bad = dir.join("no-such-dir").join("c.kdp");
        assert!(matches!(
            ArchiveWriter::new(&bad, None, "Avatar"),
            Err(CloneError::ArchiveError(_))
        ));
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn finalize_and_sink_guards_are_enforced() {
        let dir = test_dir("sinkguard");
        let path = dir.join("a.kdp");
        // 流入行但从未 end_table → finalize 拒绝且不产档。
        {
            let mut w = ArchiveWriter::new(&path, None, "Avatar").unwrap();
            w.write_row("tbl_Avatar", &avatar_row(1, "A")).unwrap();
            assert!(w
                .finalize(&[], &RedactionReport { entries: vec![] })
                .is_err());
        }
        assert!(!path.exists());
        // 行声称的表与流入表不一致 → write_row 拒绝。
        let mut w = ArchiveWriter::new(&path, None, "Avatar").unwrap();
        let mut liar = avatar_row(2, "B");
        liar.table = "tbl_Other".into();
        assert!(w.write_row("tbl_Avatar", &liar).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_frames_rejects_malformed_frame_stream() {
        use std::io::Cursor;
        // 帧名长度越界(0 / >255)。
        let mut bad = Vec::new();
        bad.extend_from_slice(&0u32.to_le_bytes());
        assert!(read_frames(&mut Cursor::new(&bad), false, None).is_err());
        let mut big = Vec::new();
        big.extend_from_slice(&300u32.to_le_bytes());
        assert!(read_frames(&mut Cursor::new(&big), false, None).is_err());
        // 半个帧头 = 截断,不猜测。
        let partial = [1u8, 2];
        match read_frames(&mut Cursor::new(&partial), false, None) {
            Err(CloneError::ArchiveError(m)) => assert!(m.contains("truncated"), "{m}"),
            other => panic!("expected truncation, got {other:?}"),
        }
        // 帧长溢出(u64 顶格 + AEAD 标签)。
        let name = b"f.json";
        let mut overflow = Vec::new();
        overflow.extend_from_slice(&(name.len() as u32).to_le_bytes());
        overflow.extend_from_slice(name);
        overflow.extend_from_slice(&u64::MAX.to_le_bytes());
        overflow.extend_from_slice(&[0u8; 32]);
        assert!(read_frames(&mut Cursor::new(&overflow), false, None).is_err());
        // 重复帧名。
        let sha: [u8; 32] = Sha256::digest(b"payload").into();
        let mut dup = Vec::new();
        for _ in 0..2 {
            dup.extend_from_slice(&(name.len() as u32).to_le_bytes());
            dup.extend_from_slice(name);
            dup.extend_from_slice(&(7u64).to_le_bytes());
            dup.extend_from_slice(&sha);
            dup.extend_from_slice(b"payload");
        }
        assert!(read_frames(&mut Cursor::new(&dup), false, None).is_err());
        // 加密帧流但未提供密钥。
        let mut enc = Vec::new();
        enc.extend_from_slice(&(name.len() as u32).to_le_bytes());
        enc.extend_from_slice(name);
        enc.extend_from_slice(&[0u8; 12]); // nonce
        enc.extend_from_slice(&16u64.to_le_bytes());
        enc.extend_from_slice(&sha);
        enc.extend_from_slice(&[0u8; 32]); // 密文 = 明文 16 + 标签 16
        assert!(read_frames(&mut Cursor::new(&enc), true, None).is_err());
    }

    #[test]
    fn open_rejects_bad_magic_and_verify_rejects_tampered_manifests() {
        let dir = test_dir("verify");
        // 坏魔数。
        let bad_magic = dir.join("magic.kdp");
        fs::write(&bad_magic, b"NOTAKODE!0000").unwrap();
        match Archive::open(&bad_magic, None) {
            Err(CloneError::ArchiveError(m)) => assert!(m.contains("magic"), "{m}"),
            other => panic!("expected bad magic, got {other:?}"),
        }

        let data = serde_json::to_vec(&TypedRow {
            table: "tbl_A".into(),
            values: vec![TypedValue::Text("x".into())],
        })
        .unwrap();
        let sha = hex_encode(Sha256::digest(&data).as_slice());
        let frame = ("data/tbl_A.rows.jsonl", data.as_slice());
        let manifest =
            |files: &[&str], tables: serde_json::Value, rows: u64, bytes: u64, fmt: &str| {
                serde_json::json!({
                    "format": fmt,
                    "version": 1,
                    "entity": "Avatar",
                    "created_at_unix": 0,
                    "encrypted": false,
                    "total_rows": rows,
                    "total_bytes": bytes,
                    "tables": tables,
                    "files": files,
                })
                .to_string()
                .into_bytes()
            };
        let good_list = [frame.0, "checksums.json", "manifest.json"];
        let tables =
            serde_json::json!([{"name": "tbl_A", "rows": 1, "bytes": data.len(), "sha256": sha}]);
        let checksums = format!("{{\"{}\": \"{}\"}}", frame.0, sha).into_bytes();

        let build = |extra: &[(&str, Vec<u8>)]| {
            let mut files = BTreeMap::new();
            files.insert(frame.0.to_string(), data.to_vec());
            files.insert("checksums.json".to_string(), checksums.clone());
            for (n, b) in extra {
                files.insert(n.to_string(), b.clone());
            }
            files
        };

        // 1) 缺 manifest。
        match Archive::verify(build(&[]), false) {
            Err(CloneError::ArchiveError(m)) => assert!(m.contains("manifest"), "{m}"),
            other => panic!("expected missing manifest, got {other:?}"),
        }
        // 2) manifest 不是 JSON。
        match Archive::verify(build(&[("manifest.json", b"not json".to_vec())]), false) {
            Err(CloneError::ArchiveError(m)) => assert!(m.contains("not valid"), "{m}"),
            other => panic!("expected invalid manifest, got {other:?}"),
        }
        // 3) format 名不符。
        let wrong_fmt_files = build(&[(
            "manifest.json",
            manifest(&good_list, tables.clone(), 1, data.len() as u64, "other"),
        )]);
        match Archive::verify(wrong_fmt_files, false) {
            Err(CloneError::ArchiveError(m)) => assert!(m.contains("format"), "{m}"),
            other => panic!("expected format mismatch, got {other:?}"),
        }
        // 4) manifest 加密旗标与帧流不符。
        let mut enc_files = build(&[(
            "manifest.json",
            manifest(&good_list, tables.clone(), 1, data.len() as u64, "kdpclone"),
        )]);
        // 重写 manifest 置 encrypted: true(直接构造,避免 helper 只出 false)。
        enc_files.insert(
            "manifest.json".to_string(),
            serde_json::json!({
                "format": "kdpclone", "version": 1, "entity": "Avatar",
                "created_at_unix": 0, "encrypted": true,
                "total_rows": 1, "total_bytes": data.len(),
                "tables": tables, "files": good_list,
            })
            .to_string()
            .into_bytes(),
        );
        match Archive::verify(enc_files, false) {
            Err(CloneError::ArchiveError(m)) => assert!(m.contains("encrypted"), "{m}"),
            other => panic!("expected encrypted flag mismatch, got {other:?}"),
        }
        // 5) 帧集与清单不一致(多帧)。
        let extra = build(&[
            (
                "manifest.json",
                manifest(&good_list, tables.clone(), 1, data.len() as u64, "kdpclone"),
            ),
            ("sneaky.json", b"x".to_vec()),
        ]);
        match Archive::verify(extra, false) {
            Err(CloneError::ArchiveError(m)) => assert!(m.contains("do not match"), "{m}"),
            other => panic!("expected frame list mismatch, got {other:?}"),
        }
        // 6) 缺 checksums.json(帧集与清单都不含它 → 文件清单比对通过,查 checksums 时失败)。
        let short_list = [frame.0, "manifest.json"];
        let no_sum: BTreeMap<String, Vec<u8>> = [
            (frame.0.to_string(), data.to_vec()),
            (
                "manifest.json".to_string(),
                manifest(
                    &short_list,
                    tables.clone(),
                    1,
                    data.len() as u64,
                    "kdpclone",
                ),
            ),
        ]
        .into_iter()
        .collect();
        match Archive::verify(no_sum, false) {
            Err(CloneError::ArchiveError(m)) => assert!(m.contains("checksums.json"), "{m}"),
            other => panic!("expected missing checksums, got {other:?}"),
        }
        // 7) checksums.json 引用不存在的文件。
        let ghost = format!(
            "{{\"{}\": \"{}\", \"data/tbl_Ghost.rows.jsonl\": \"{}\"}}",
            frame.0,
            sha,
            hex_encode(Sha256::digest(b"g").as_slice())
        )
        .into_bytes();
        match Archive::verify(
            build(&[
                (
                    "manifest.json",
                    manifest(&good_list, tables.clone(), 1, data.len() as u64, "kdpclone"),
                ),
                ("checksums.json", ghost),
            ]),
            false,
        ) {
            Err(CloneError::ArchiveError(m)) => assert!(m.contains("tbl_Ghost"), "{m}"),
            other => panic!("expected ghost checksum entry, got {other:?}"),
        }
        // 8) 校验和不符。
        let bad_sum = format!(
            "{{\"{}\": \"{}\"}}",
            frame.0,
            hex_encode(Sha256::digest(b"tampered").as_slice())
        )
        .into_bytes();
        match Archive::verify(
            build(&[
                (
                    "manifest.json",
                    manifest(&good_list, tables.clone(), 1, data.len() as u64, "kdpclone"),
                ),
                ("checksums.json", bad_sum),
            ]),
            false,
        ) {
            Err(CloneError::ArchiveError(m)) => assert!(m.contains("checksum mismatch"), "{m}"),
            other => panic!("expected checksum mismatch, got {other:?}"),
        }
        // 9) 清单里的表缺数据帧。
        let ghost_table = serde_json::json!([
            {"name": "tbl_A", "rows": 1, "bytes": data.len(), "sha256": sha},
            {"name": "tbl_B", "rows": 0, "bytes": 0, "sha256": hex_encode(Sha256::digest(b"").as_slice())},
        ]);
        match Archive::verify(
            build(&[(
                "manifest.json",
                manifest(&good_list, ghost_table, 1, data.len() as u64, "kdpclone"),
            )]),
            false,
        ) {
            Err(CloneError::ArchiveError(m)) => assert!(m.contains("tbl_B"), "{m}"),
            other => panic!("expected missing table frame, got {other:?}"),
        }
        // 10) 表 SHA 不符 + 行声称的表与文件名互核。
        let wrong_sha = serde_json::json!([
            {"name": "tbl_A", "rows": 1, "bytes": data.len(), "sha256": hex_encode(Sha256::digest(b"other").as_slice())},
        ]);
        match Archive::verify(
            build(&[(
                "manifest.json",
                manifest(&good_list, wrong_sha, 1, data.len() as u64, "kdpclone"),
            )]),
            false,
        ) {
            Err(CloneError::ArchiveError(m)) => assert!(m.contains("sha256 mismatch"), "{m}"),
            other => panic!("expected table sha mismatch, got {other:?}"),
        }
        // 11) 清单合计与表条目不符。
        match Archive::verify(
            build(&[(
                "manifest.json",
                manifest(
                    &good_list,
                    tables.clone(),
                    99,
                    data.len() as u64,
                    "kdpclone",
                ),
            )]),
            false,
        ) {
            Err(CloneError::ArchiveError(m)) => assert!(m.contains("totals disagree"), "{m}"),
            other => panic!("expected totals mismatch, got {other:?}"),
        }
        // 12) 合法构造通过 + 行表名与文件名互核(table_rows)。
        let ok_files = build(&[(
            "manifest.json",
            manifest(&good_list, tables, 1, data.len() as u64, "kdpclone"),
        )]);
        let arc = Archive::verify(ok_files, false).unwrap();
        assert_eq!(arc.meta().entity, "Avatar");
        assert_eq!(arc.table_rows("tbl_A").unwrap().len(), 1);
        // 行内 table 与文件名不符 → 拒绝。
        let liar_row = b"{\"table\":\"tbl_Liar\",\"values\":[]}\n";
        let liar_sha = hex_encode(Sha256::digest(liar_row).as_slice());
        let liar_frame = ("data/tbl_A.rows.jsonl", liar_row);
        let liar_tables = serde_json::json!([
            {"name": "tbl_A", "rows": 1, "bytes": liar_row.len(), "sha256": liar_sha},
        ]);
        let liar_files: BTreeMap<String, Vec<u8>> = [
            (frame.0.to_string(), liar_row.to_vec()),
            (
                "checksums.json".to_string(),
                format!("{{\"{}\": \"{}\"}}", liar_frame.0, liar_sha).into_bytes(),
            ),
            (
                "manifest.json".to_string(),
                manifest(
                    &good_list,
                    liar_tables,
                    1,
                    liar_row.len() as u64,
                    "kdpclone",
                ),
            ),
        ]
        .into_iter()
        .collect();
        match Archive::verify(liar_files, false)
            .unwrap()
            .table_rows("tbl_A")
        {
            Err(CloneError::ArchiveError(m)) => assert!(m.contains("tbl_Liar"), "{m}"),
            other => panic!("expected liar row, got {other:?}"),
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn crafted_manifest_helpers_match_real_writer_shape() {
        // 交叉验证:真实 writer 的 checksums.json/manifest 形状可被 verify 接受,
        // 防止上面手工构造的清单与实现漂移。
        let dir = test_dir("shape");
        let path = dir.join("shape.kdp");
        let mut w = ArchiveWriter::new(&path, None, "Shape").unwrap();
        let row = TypedRow {
            table: "tbl_Shape".into(),
            values: vec![TypedValue::Text("S".into())],
        };
        w.write_row("tbl_Shape", &row).unwrap();
        w.end_table("tbl_Shape", 1).unwrap();
        w.finalize(&[], &RedactionReport { entries: vec![] })
            .unwrap();
        let arc = Archive::open(&path, None).unwrap();
        assert!(arc.meta().files.contains(&"manifest.json".to_string()));
        assert_eq!(arc.table_rows("tbl_Shape").unwrap(), vec![row]);
        let _ = fs::remove_dir_all(&dir);
    }

    fn plan_fixture() -> QueryPlan {
        QueryPlan {
            entity_name: "Avatar".into(),
            row_budget: 10_000,
            queries: vec![
                PlannedQuery {
                    sequence: 0,
                    table: "tbl_Avatar".into(),
                    parent_table: None,
                    filter: PlanFilter::RootId,
                    columns: vec!["id".into(), "sm_name".into()],
                    column_types: vec!["bigint unsigned".into(), "varchar".into()],
                    select_sql: "SELECT `id`, `sm_name` FROM `tbl_Avatar` WHERE `id` = ?".into(),
                    estimated_rows: None,
                },
                PlannedQuery {
                    sequence: 1,
                    table: "tbl_Bag".into(),
                    parent_table: Some("tbl_Avatar".into()),
                    filter: PlanFilter::ParentId,
                    columns: vec!["id".into(), "parentID".into(), "count".into()],
                    column_types: vec![
                        "bigint unsigned".into(),
                        "bigint unsigned".into(),
                        "int".into(),
                    ],
                    select_sql:
                        "SELECT `id`, `parentID`, `count` FROM `tbl_Bag` WHERE `parentID` = ?"
                            .into(),
                    estimated_rows: None,
                },
            ],
            denied: vec![],
            missing: vec![],
            identity: None,
            estimated_rows_total: None,
        }
    }

    /// 假源库:记录每条语句,按表回固定行。
    struct FakeDb {
        calls: RefCell<Vec<String>>,
    }

    impl FakeDb {
        fn new() -> Self {
            Self {
                calls: RefCell::new(Vec::new()),
            }
        }
    }

    impl ReadOnlyExecutor for FakeDb {
        fn query(&self, sql: &str, params: &[SqlValue]) -> CloneResult<Vec<Vec<Option<String>>>> {
            self.calls.borrow_mut().push(sql.to_string());
            if sql.contains("tbl_Avatar") {
                Ok(vec![
                    vec![Some("1001".into()), Some("Alice".into())],
                    vec![Some("1002".into()), Some("Bob".into())],
                ])
            } else if sql.contains("tbl_Bag") {
                if matches!(params.first(), Some(SqlValue::U64(1001))) {
                    Ok(vec![vec![
                        Some("2001".into()),
                        Some("1001".into()),
                        Some("3".into()),
                    ]])
                } else {
                    Ok(vec![])
                }
            } else {
                Ok(vec![])
            }
        }

        fn execute(&self, sql: &str) -> CloneResult<()> {
            self.calls.borrow_mut().push(sql.to_string());
            Ok(())
        }
    }

    #[test]
    fn export_writes_verified_archive() {
        let dir = test_dir("export");
        let path = dir.join("clone.kdp");
        let plan = plan_fixture();
        let db = FakeDb::new();
        let meta = write_archive(
            &path,
            &plan,
            &relations_from_plan(&plan),
            1001,
            &db,
            &SensitivityPolicy::default(),
            None,
            &ExportBudget::unlimited(),
            &ExportControl::new(),
        )
        .unwrap();
        // 2 根行(第二个根无子行)+ 1 背包行。
        assert_eq!(meta.total_rows, 3);
        assert_eq!(meta.tables.len(), 2);

        let arc = Archive::open(&path, None).unwrap();
        let avatars = arc.table_rows("tbl_Avatar").unwrap();
        assert_eq!(avatars.len(), 2);
        assert_eq!(avatars[0].values[0], TypedValue::BigUInt(1001));
        assert_eq!(avatars[0].values[1], TypedValue::Text("Alice".into()));
        let bags = arc.table_rows("tbl_Bag").unwrap();
        assert_eq!(bags.len(), 1);
        assert_eq!(bags[0].values[2], TypedValue::Int(3));

        // 关系记录进了档。
        let rels: Vec<Relation> =
            serde_json::from_slice(arc.file("relations.json").unwrap()).unwrap();
        assert_eq!(rels.len(), 1);
        assert_eq!(rels[0].child_table, "tbl_Bag");
        assert_eq!(rels[0].parent_table, "tbl_Avatar");

        // 只读证据:会话只读 + 快照事务 + 提交,且每条语句过只读白名单。
        let calls = db.calls.borrow();
        assert_eq!(calls[0], "SET SESSION TRANSACTION READ ONLY");
        assert!(calls.iter().any(|c| c.starts_with("START TRANSACTION")));
        assert_eq!(calls.last().unwrap(), "COMMIT");
        assert!(
            calls
                .iter()
                .all(|c| crate::reader::validate_readonly(c).is_ok()),
            "every executed statement must pass the read-only whitelist"
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
