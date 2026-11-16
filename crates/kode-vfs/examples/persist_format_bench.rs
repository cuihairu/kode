//! 持久化格式候选基准(RUST-128 旧 IDX-011:cold start / 读写放大 / 文件数)。
//!
//! 四候选(RUST-128 行逐名 + 文件数轴的家族内细分):
//! - `persist-store` = 生产面 [`kode_vfs::PersistStore`](file-per-entry 自定义
//!   帧,每写 fsync+原子 rename,RUST-127 协议);
//! - `sqlite-durable` = rusqlite(WAL + synchronous=FULL,每条目独立事务,
//!   与 persist-store 同级耐久性);
//! - `sqlite-relaxed` = synchronous=OFF + 单事务(缓存语义的耐久性下限参考:
//!   掉电丢整批,靠 miss 重建);
//! - `redb` = 纯 Rust 嵌入式 B-tree,默认耐久性(每次 commit fsync);
//! - `packed-log` = 自定义单文件追加日志([key16][len][payload][checksum],
//!   批量 fsync,开库全扫建索引,撕裂尾按校验和截断)——「文件数」轴的
//!   家族内答案;
//! - `mmap-snapshot`(RUST-290 行逐名)= 单文件快照([u32 count][索引
//!   high/low/offset/len ×count][记录区]),写=单文件就地重建+单次 fsync,
//!   冷启动=只读索引建映射(记录区零读,mmap 惰性),随机读=映射内切片
//!   拷出(fmmap 安全 API,workspace 禁 unsafe,底层 memmap2)。
//!
//! 口径(诚实边界):
//! - **暖缓存 cold start**:非 root 无法 drop caches;测得是页缓存命中下的
//!   重建墙钟。LSP 重启场景 OS 页缓存大概率仍热(上会话刚写过),该口径
//!   对主要场景有代表性;真冷盘数字需 root 落盘后另行补测。
//! - **写放大**:/proc/self/io `write_bytes` 增量 ÷ payload 字节(内核实际
//!   下盘字节,含 fsync 逼出的页)。
//! - **空间放大**:落盘文件总字节 ÷ payload 字节。
//! - **随机读**:LCG 采样 1000 键单键查找 P50/P95(各候选走自己的生产
//!   读取路径:persist-store/packed 含校验和验证,sqlite/redb 引擎自查)。
//! - payload 用 LCG 非零字节(零页去压/去重会失真);正确性闸 = read-all
//!   逐条目字节全等断言。
//!
//! 复现:`cargo run -p kode-vfs --release --example persist_format_bench`
//!   (裁矩阵:`-- --sizes 32768 --counts 1000 --random 500`)

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Instant;

use kode_vfs::persist_key::{persist_cache_key, PersistKeyFactors};
use kode_vfs::PersistStore;

const FACTORS: PersistKeyFactors<'static> = PersistKeyFactors {
    core_schema: "bench-schema-1",
    engine_profile: "bench-profile",
    root_identity: "/bench-root",
    workspace_config: "bench-cfg",
    parser_version: "0.0.0-bench",
};

/// 确定性 LCG(非 rand 依赖;payload 非零字节防零页失真)。
struct Lcg(u64);

impl Lcg {
    fn next_u64(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        self.0
    }
}

fn payload_bytes(seed: u64, len: usize) -> Vec<u8> {
    let mut rng = Lcg(seed ^ 0x9e37_79b9_7f4a_7c15);
    let mut bytes = Vec::with_capacity(len);
    for chunk in 0..len.div_ceil(8) {
        let v = rng.next_u64().to_le_bytes();
        let take = 8.min(len - chunk * 8);
        bytes.extend_from_slice(&v[..take]);
    }
    bytes
}

fn key_for(i: usize) -> kode_vfs::persist_key::PersistCacheKey {
    persist_cache_key(&FACTORS, &format!("/bench-root/entities/E{i}.def"))
}

#[derive(Debug, Clone)]
struct Scenario {
    size: usize,
    count: usize,
}

struct BenchResult {
    name: &'static str,
    write_ms: f64,
    read_all_ms: f64,
    random_p50_us: f64,
    random_p95_us: f64,
    disk_bytes: u64,
    payload_bytes: u64,
    file_count: usize,
    io_write_bytes: u64,
}

impl BenchResult {
    fn space_amp(&self) -> f64 {
        self.disk_bytes as f64 / self.payload_bytes.max(1) as f64
    }

    fn write_amp(&self) -> f64 {
        self.io_write_bytes as f64 / self.payload_bytes.max(1) as f64
    }

    fn print(&self) {
        println!(
            "| {:<15} | {:>9.1} | {:>9.1} | {:>8.1} | {:>8.1} | {:>9.2} | {:>6.2} | {:>7} |",
            self.name,
            self.write_ms,
            self.read_all_ms,
            self.random_p50_us,
            self.random_p95_us,
            self.space_amp(),
            self.write_amp(),
            self.file_count,
        );
    }
}

fn fresh_dir(tag: &str, base: &Path) -> PathBuf {
    let dir = base.join(format!(
        "kode-vfs-persist-bench-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn read_proc_io_write_bytes() -> u64 {
    std::fs::read_to_string("/proc/self/io")
        .ok()
        .and_then(|text| {
            text.lines()
                .find(|l| l.starts_with("write_bytes:"))
                .and_then(|l| l.split(':').nth(1))
                .and_then(|v| v.trim().parse::<u64>().ok())
        })
        .unwrap_or(0)
}

fn dir_stats(dir: &Path) -> (u64, usize) {
    let mut bytes = 0u64;
    let mut files = 0usize;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&d) else {
            continue;
        };
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                stack.push(p);
            } else {
                bytes += entry.metadata().map(|m| m.len()).unwrap_or(0);
                files += 1;
            }
        }
    }
    (bytes, files)
}

/// LCG 无放回采样 `n` 个键索引(确定性;范围 0..count)。
fn sample_indices(count: usize, n: usize) -> Vec<usize> {
    let mut rng = Lcg(0xb10c_a7ed_ba11_2026);
    let n = n.min(count);
    let mut seen = std::collections::HashSet::with_capacity(n);
    let mut out = Vec::with_capacity(n);
    while out.len() < n {
        let idx = (rng.next_u64() % count as u64) as usize;
        if seen.insert(idx) {
            out.push(idx);
        }
    }
    out
}

fn percentiles(mut us: Vec<f64>) -> (f64, f64) {
    us.sort_by(|a, b| a.total_cmp(b));
    let p50 = us[us.len() / 2];
    let p95 = us[(us.len() as f64 * 0.95) as usize % us.len()];
    (p50, p95)
}

// ---------- 候选 1:persist-store(生产面) ----------

fn bench_persist_store(
    dir: &Path,
    keys: &[kode_vfs::persist_key::PersistCacheKey],
    payloads: &[Vec<u8>],
    sample: &[usize],
) -> BenchResult {
    let io0 = read_proc_io_write_bytes();
    let store = PersistStore::open(dir).unwrap();
    let t0 = Instant::now();
    for (key, payload) in keys.iter().zip(payloads.iter()) {
        store.write(key, payload).unwrap();
    }
    let write_ms = t0.elapsed().as_secs_f64() * 1000.0;
    let io1 = read_proc_io_write_bytes();

    let t1 = Instant::now();
    for (key, payload) in keys.iter().zip(payloads.iter()) {
        let got = store.read(key).unwrap();
        assert_eq!(
            got.as_deref(),
            Some(payload.as_slice()),
            "persist-store 字节全等闸"
        );
    }
    let read_all_ms = t1.elapsed().as_secs_f64() * 1000.0;

    let mut us = Vec::with_capacity(sample.len());
    for &i in sample {
        let t = Instant::now();
        let got = store.read(&keys[i]).unwrap();
        assert_eq!(got.as_deref(), Some(payloads[i].as_slice()));
        us.push(t.elapsed().as_secs_f64() * 1e6);
    }
    let (p50, p95) = percentiles(us);
    let (disk, files) = dir_stats(dir);
    BenchResult {
        name: "persist-store",
        write_ms,
        read_all_ms,
        random_p50_us: p50,
        random_p95_us: p95,
        disk_bytes: disk,
        payload_bytes: payloads.iter().map(|p| p.len() as u64).sum(),
        file_count: files,
        io_write_bytes: io1.saturating_sub(io0),
    }
}

// ---------- 候选 2/3:sqlite(durable / relaxed) ----------

fn bench_sqlite(
    dir: &Path,
    keys: &[kode_vfs::persist_key::PersistCacheKey],
    payloads: &[Vec<u8>],
    sample: &[usize],
    durable: bool,
) -> BenchResult {
    use rusqlite::Connection;
    let path = dir.join("cache.sqlite3");
    let conn = Connection::open(&path).unwrap();
    if durable {
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        conn.pragma_update(None, "synchronous", "FULL").unwrap();
    } else {
        conn.pragma_update(None, "journal_mode", "OFF").unwrap();
        conn.pragma_update(None, "synchronous", "OFF").unwrap();
    }
    conn.execute_batch("CREATE TABLE cache(key BLOB PRIMARY KEY, payload BLOB NOT NULL)")
        .unwrap();
    let io0 = read_proc_io_write_bytes();
    let t0 = Instant::now();
    if durable {
        // 每条目独立事务:与 persist-store 每写 fsync 同级耐久性。
        let mut stmt = conn
            .prepare("INSERT INTO cache(key, payload) VALUES (?1, ?2)")
            .unwrap();
        for (key, payload) in keys.iter().zip(payloads.iter()) {
            let key_bytes = key_high_low_bytes(key);
            stmt.execute(rusqlite::params![key_bytes, payload]).unwrap();
        }
    } else {
        let mut stmt = conn
            .prepare("INSERT INTO cache(key, payload) VALUES (?1, ?2)")
            .unwrap();
        for (key, payload) in keys.iter().zip(payloads.iter()) {
            stmt.execute(rusqlite::params![key_high_low_bytes(key), payload])
                .unwrap();
        }
    }
    let write_ms = t0.elapsed().as_secs_f64() * 1000.0;
    let io1 = read_proc_io_write_bytes();

    let t1 = Instant::now();
    {
        let mut stmt = conn.prepare("SELECT key, payload FROM cache").unwrap();
        let mut rows = stmt.query([]).unwrap();
        let mut got_map: HashMap<Vec<u8>, Vec<u8>> = HashMap::with_capacity(keys.len());
        while let Some(row) = rows.next().unwrap() {
            let k: Vec<u8> = row.get(0).unwrap();
            let v: Vec<u8> = row.get(1).unwrap();
            got_map.insert(k, v);
        }
        for (key, payload) in keys.iter().zip(payloads.iter()) {
            assert_eq!(
                got_map.get(&key_high_low_bytes(key)).map(|v| v.as_slice()),
                Some(payload.as_slice()),
                "sqlite 字节全等闸"
            );
        }
    }
    let read_all_ms = t1.elapsed().as_secs_f64() * 1000.0;

    let mut us = Vec::with_capacity(sample.len());
    {
        let mut stmt = conn
            .prepare("SELECT payload FROM cache WHERE key = ?1")
            .unwrap();
        for &i in sample {
            let t = Instant::now();
            let got: Option<Vec<u8>> = stmt
                .query_row(rusqlite::params![key_high_low_bytes(&keys[i])], |r| {
                    r.get(0)
                })
                .unwrap();
            assert_eq!(got.as_deref(), Some(payloads[i].as_slice()));
            us.push(t.elapsed().as_secs_f64() * 1e6);
        }
    }
    let (p50, p95) = percentiles(us);
    drop(conn);
    let (disk, files) = dir_stats(dir);
    BenchResult {
        name: if durable {
            "sqlite-durable"
        } else {
            "sqlite-relaxed"
        },
        write_ms,
        read_all_ms,
        random_p50_us: p50,
        random_p95_us: p95,
        disk_bytes: disk,
        payload_bytes: payloads.iter().map(|p| p.len() as u64).sum(),
        file_count: files,
        io_write_bytes: io1.saturating_sub(io0),
    }
}

fn key_high_low_bytes(key: &kode_vfs::persist_key::PersistCacheKey) -> Vec<u8> {
    let mut v = Vec::with_capacity(16);
    v.extend_from_slice(&key.high.to_le_bytes());
    v.extend_from_slice(&key.low.to_le_bytes());
    v
}

// ---------- 候选 4:redb ----------

use redb::ReadableTable;

const REDB_TABLE: redb::TableDefinition<'static, u128, &[u8]> = redb::TableDefinition::new("cache");

fn bench_redb(
    dir: &Path,
    keys: &[kode_vfs::persist_key::PersistCacheKey],
    payloads: &[Vec<u8>],
    sample: &[usize],
) -> BenchResult {
    let path = dir.join("cache.redb");
    let db = redb::Database::create(&path).unwrap();
    let io0 = read_proc_io_write_bytes();
    let t0 = Instant::now();
    for (key, payload) in keys.iter().zip(payloads.iter()) {
        // 默认耐久性:每次 commit 落盘(fsync)。
        let txn = db.begin_write().unwrap();
        {
            let mut table = txn.open_table(REDB_TABLE).unwrap();
            table.insert(redb_key(key), payload.as_slice()).unwrap();
        }
        txn.commit().unwrap();
    }
    let write_ms = t0.elapsed().as_secs_f64() * 1000.0;
    let io1 = read_proc_io_write_bytes();

    let t1 = Instant::now();
    {
        let txn = db.begin_read().unwrap();
        let table = txn.open_table(REDB_TABLE).unwrap();
        let mut got_map: HashMap<u128, Vec<u8>> = HashMap::with_capacity(keys.len());
        for row in table.iter().unwrap() {
            let (k, v) = row.unwrap();
            got_map.insert(k.value(), v.value().to_vec());
        }
        for (key, payload) in keys.iter().zip(payloads.iter()) {
            assert_eq!(
                got_map.get(&redb_key(key)).map(|v| v.as_slice()),
                Some(payload.as_slice()),
                "redb 字节全等闸"
            );
        }
    }
    let read_all_ms = t1.elapsed().as_secs_f64() * 1000.0;

    let mut us = Vec::with_capacity(sample.len());
    for &i in sample {
        let t = Instant::now();
        let txn = db.begin_read().unwrap();
        let table = txn.open_table(REDB_TABLE).unwrap();
        let got = table
            .get(redb_key(&keys[i]))
            .unwrap()
            .map(|g| g.value().to_vec());
        assert_eq!(got.as_deref(), Some(payloads[i].as_slice()));
        us.push(t.elapsed().as_secs_f64() * 1e6);
    }
    let (p50, p95) = percentiles(us);
    let (disk, files) = dir_stats(dir);
    BenchResult {
        name: "redb",
        write_ms,
        read_all_ms,
        random_p50_us: p50,
        random_p95_us: p95,
        disk_bytes: disk,
        payload_bytes: payloads.iter().map(|p| p.len() as u64).sum(),
        file_count: files,
        io_write_bytes: io1.saturating_sub(io0),
    }
}

fn redb_key(key: &kode_vfs::persist_key::PersistCacheKey) -> u128 {
    ((key.high as u128) << 64) | key.low as u128
}

// ---------- 候选 5:packed-log(自定义单文件) ----------

const PACKED_OVERHEAD: usize = 16 + 4 + 8; // key16 + len4 + checksum8

struct PackedLog {
    file: std::fs::File,
    index: HashMap<(u64, u64), (u64, u32)>,
    size: u64,
}

impl PackedLog {
    /// 开库全扫建索引;`collect` = 同时顺序收集各键最新 payload
    /// (生产冷启动形态:单遍顺序读回全部条目进内存缓存)。
    fn open_with(path: &Path, mut collect: Option<&mut HashMap<(u64, u64), Vec<u8>>>) -> PackedLog {
        let mut file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)
            .unwrap();
        let mut index = HashMap::new();
        let mut size = 0u64;
        use std::io::{Seek, SeekFrom};
        file.seek(SeekFrom::Start(0)).unwrap();
        let mut len_buf = [0u8; 4];
        let mut key_buf = [0u8; 16];
        let mut sum_buf = [0u8; 8];
        loop {
            let mut header = [0u8; 16 + 4];
            match read_exact_or_eof(&mut file, &mut header) {
                Ok(true) => {}
                _ => break, // EOF 或撕裂头:截断点在 size。
            }
            key_buf.copy_from_slice(&header[..16]);
            len_buf.copy_from_slice(&header[16..]);
            let len = u32::from_le_bytes(len_buf) as usize;
            let mut payload = vec![0u8; len];
            if !matches!(read_exact_or_eof(&mut file, &mut payload), Ok(true)) {
                break;
            }
            if !matches!(read_exact_or_eof(&mut file, &mut sum_buf), Ok(true)) {
                break;
            }
            let stored = u64::from_le_bytes(sum_buf);
            if kode_vfs::content_fingerprint_bytes(&payload) != stored {
                break; // 校验不过 = 撕裂尾:截断点停在上一好记录。
            }
            let key = (
                u64::from_le_bytes(key_buf[..8].try_into().unwrap()),
                u64::from_le_bytes(key_buf[8..].try_into().unwrap()),
            );
            let offset = size;
            index.insert(key, (offset, len as u32));
            if let Some(map) = collect.as_deref_mut() {
                map.insert(key, payload);
            }
            size += (PACKED_OVERHEAD + len) as u64;
        }
        // 撕裂尾截断:丢弃最后一个坏记录起的所有字节。
        file.set_len(size).unwrap();
        PackedLog { file, index, size }
    }

    fn open(path: &Path) -> PackedLog {
        PackedLog::open_with(path, None)
    }

    fn append(&mut self, key: &kode_vfs::persist_key::PersistCacheKey, payload: &[u8]) {
        use std::io::{Seek, SeekFrom, Write};
        self.file.seek(SeekFrom::Start(self.size)).unwrap();
        let mut record = Vec::with_capacity(PACKED_OVERHEAD + payload.len());
        record.extend_from_slice(&key.high.to_le_bytes());
        record.extend_from_slice(&key.low.to_le_bytes());
        record.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        record.extend_from_slice(payload);
        record.extend_from_slice(&kode_vfs::content_fingerprint_bytes(payload).to_le_bytes());
        self.file.write_all(&record).unwrap();
        self.index
            .insert((key.high, key.low), (self.size, payload.len() as u32));
        self.size += record.len() as u64;
    }

    /// 批量耐久性:写阶段尾部统一 fsync(单写全量下盘)。
    fn sync(&mut self) {
        use std::io::Write;
        self.file.flush().unwrap();
        self.file.sync_all().unwrap();
    }

    fn get(&self, key: &kode_vfs::persist_key::PersistCacheKey) -> Option<Vec<u8>> {
        use std::io::{Read, Seek, SeekFrom};
        let (offset, len) = *self.index.get(&(key.high, key.low))?;
        let mut file = self.file.try_clone().ok()?;
        file.seek(SeekFrom::Start(offset + 16 + 4)).ok()?;
        let mut payload = vec![0u8; len as usize];
        file.read_exact(&mut payload).ok()?;
        let mut sum_buf = [0u8; 8];
        file.read_exact(&mut sum_buf).ok()?;
        assert_eq!(
            kode_vfs::content_fingerprint_bytes(&payload),
            u64::from_le_bytes(sum_buf),
            "packed-log 随机读校验和闸"
        );
        Some(payload)
    }
}

fn read_exact_or_eof(file: &mut std::fs::File, buf: &mut [u8]) -> std::io::Result<bool> {
    use std::io::Read;
    let mut filled = 0;
    while filled < buf.len() {
        match file.read(&mut buf[filled..]) {
            Ok(0) => return Ok(false),
            Ok(n) => filled += n,
            Err(e) => return Err(e),
        }
    }
    Ok(true)
}

fn bench_packed_log(
    dir: &Path,
    keys: &[kode_vfs::persist_key::PersistCacheKey],
    payloads: &[Vec<u8>],
    sample: &[usize],
) -> BenchResult {
    let path = dir.join("cache.pack");
    let io0 = read_proc_io_write_bytes();
    let t0 = Instant::now();
    {
        let mut log = PackedLog::open(&path);
        for (key, payload) in keys.iter().zip(payloads.iter()) {
            log.append(key, payload);
        }
        log.sync();
    }
    let write_ms = t0.elapsed().as_secs_f64() * 1000.0;
    let io1 = read_proc_io_write_bytes();

    // 冷启动 = 开库全扫建索引 + 单遍顺序收集全部条目(生产冷启动形态)。
    let t1 = Instant::now();
    {
        let mut collected: HashMap<(u64, u64), Vec<u8>> = HashMap::with_capacity(keys.len());
        let log = PackedLog::open_with(&path, Some(&mut collected));
        for (key, payload) in keys.iter().zip(payloads.iter()) {
            let got = collected.get(&(key.high, key.low)).unwrap();
            assert_eq!(got, payload, "packed-log 字节全等闸");
        }
        let scan_ms = t1.elapsed().as_secs_f64() * 1000.0;
        let mut us = Vec::with_capacity(sample.len());
        for &i in sample {
            let t = Instant::now();
            let got = log.get(&keys[i]).unwrap();
            assert_eq!(got, payloads[i]);
            us.push(t.elapsed().as_secs_f64() * 1e6);
        }
        let (p50, p95) = percentiles(us);
        let (disk, files) = dir_stats(dir);
        BenchResult {
            name: "packed-log",
            write_ms,
            read_all_ms: scan_ms,
            random_p50_us: p50,
            random_p95_us: p95,
            disk_bytes: disk,
            payload_bytes: payloads.iter().map(|p| p.len() as u64).sum(),
            file_count: files,
            io_write_bytes: io1.saturating_sub(io0),
        }
    }
}

// ---------- 候选 6:mmap-snapshot(RUST-290 行逐名) ----------

const MMAP_INDEX_ENTRY: usize = 8 + 8 + 8 + 4;

fn bench_mmap_snapshot(
    dir: &Path,
    keys: &[kode_vfs::persist_key::PersistCacheKey],
    payloads: &[Vec<u8>],
    sample: &[usize],
) -> BenchResult {
    use fmmap::sync::MmapFile;
    use fmmap::MmapFileExt;
    use std::io::{Seek, SeekFrom, Write};

    let path = dir.join("cache.mmap");
    let io0 = read_proc_io_write_bytes();
    let t0 = Instant::now();
    {
        let mut file = std::fs::File::create(&path).unwrap();
        let records_start = (4 + MMAP_INDEX_ENTRY * keys.len()) as u64;
        // 头部+索引占位一次写(计数已知,记录区 offset 前向可定)。
        let mut head = Vec::with_capacity(records_start as usize);
        head.extend_from_slice(&(keys.len() as u32).to_le_bytes());
        head.resize(records_start as usize, 0);
        file.write_all(&head).unwrap();
        // 记录区顺序追加,offset 记内存索引。
        let mut offsets: Vec<(u64, u64, u64, u32)> = Vec::with_capacity(keys.len());
        let mut pos = records_start;
        {
            let mut w = std::io::BufWriter::new(&file);
            for (key, payload) in keys.iter().zip(payloads.iter()) {
                w.write_all(payload).unwrap();
                offsets.push((key.high, key.low, pos, payload.len() as u32));
                pos += payload.len() as u64;
            }
            w.flush().unwrap();
        }
        // 回填真实索引(单次写)+ 单次 fsync——快照语义:整文件一次成形。
        let mut idx = Vec::with_capacity(MMAP_INDEX_ENTRY * keys.len());
        for (h, l, off, len) in &offsets {
            idx.extend_from_slice(&h.to_le_bytes());
            idx.extend_from_slice(&l.to_le_bytes());
            idx.extend_from_slice(&off.to_le_bytes());
            idx.extend_from_slice(&len.to_le_bytes());
        }
        file.seek(SeekFrom::Start(4)).unwrap();
        file.write_all(&idx).unwrap();
        file.sync_all().unwrap();
    }
    let write_ms = t0.elapsed().as_secs_f64() * 1000.0;
    let io1 = read_proc_io_write_bytes();

    // 冷启动 = mmap 整文件 + 读头部索引建映射 + 全量取回(记录区零读建库,
    // 惰性按页进;与 packed-log「开库全扫+收集」同口径计时)。
    let t1 = Instant::now();
    let file = MmapFile::open(&path).unwrap();
    let count = u32::from_le_bytes({
        let mut b = [0u8; 4];
        file.read_exact(&mut b, 0).unwrap();
        b
    }) as usize;
    assert_eq!(count, keys.len(), "mmap 头部计数闸");
    let mut index: HashMap<(u64, u64), (u64, u32)> = HashMap::with_capacity(count);
    {
        let mut raw = vec![0u8; MMAP_INDEX_ENTRY * count];
        file.read_exact(&mut raw, 4).unwrap();
        for slot in raw.as_chunks::<MMAP_INDEX_ENTRY>().0 {
            let high = u64::from_le_bytes(slot[0..8].try_into().unwrap());
            let low = u64::from_le_bytes(slot[8..16].try_into().unwrap());
            let off = u64::from_le_bytes(slot[16..24].try_into().unwrap());
            let len = u32::from_le_bytes(slot[24..28].try_into().unwrap());
            index.insert((high, low), (off, len));
        }
    }
    let open_ms = t1.elapsed().as_secs_f64() * 1000.0;
    println!(
        "    mmap open(索引建映射,记录区零读)={open_ms:.1}ms(口径附录:下表冷读=开库+全量取回)",
    );

    let mut us = Vec::with_capacity(sample.len());
    {
        let mut buf = Vec::with_capacity(payloads.iter().map(|p| p.len()).max().unwrap_or(0));
        for (key, payload) in keys.iter().zip(payloads.iter()) {
            let (off, len) = index.get(&(key.high, key.low)).copied().unwrap();
            buf.resize(len as usize, 0);
            file.read_exact(&mut buf, off as usize).unwrap();
            assert_eq!(&buf[..], payload, "mmap-snapshot 字节全等闸");
        }
        let read_all_ms = t1.elapsed().as_secs_f64() * 1000.0;
        for &i in sample {
            let t = Instant::now();
            let (off, len) = index.get(&(keys[i].high, keys[i].low)).copied().unwrap();
            buf.resize(len as usize, 0);
            file.read_exact(&mut buf, off as usize).unwrap();
            assert_eq!(&buf[..], payloads[i]);
            us.push(t.elapsed().as_secs_f64() * 1e6);
        }
        let (p50, p95) = percentiles(us);
        let (disk, files) = dir_stats(dir);
        BenchResult {
            name: "mmap-snapshot",
            write_ms,
            read_all_ms,
            random_p50_us: p50,
            random_p95_us: p95,
            disk_bytes: disk,
            payload_bytes: payloads.iter().map(|p| p.len() as u64).sum(),
            file_count: files,
            io_write_bytes: io1.saturating_sub(io0),
        }
    }
}

fn run_scenario(scenario: &Scenario, base: &Path) {
    let count = scenario.count;
    let size = scenario.size;
    println!("\n=== 场景:{} 条目 × {} KiB/条 ===", count, size / 1024);
    println!(
        "| 候选            |    写全量ms | 冷读全量ms | 随机P50us | 随机P95us | 空间放大 | 写放大 | 文件数 |"
    );
    println!(
        "|-----------------|------------:|-----------:|----------:|----------:|---------:|-------:|-------:|"
    );
    let keys: Vec<_> = (0..count).map(key_for).collect();
    let payloads: Vec<Vec<u8>> = (0..count).map(|i| payload_bytes(i as u64, size)).collect();
    let sample = sample_indices(count, 1000);

    let dir = fresh_dir("persist", base);
    bench_persist_store(&dir, &keys, &payloads, &sample).print();
    std::fs::remove_dir_all(dir).unwrap();

    let dir = fresh_dir("sqlite-d", base);
    bench_sqlite(&dir, &keys, &payloads, &sample, true).print();
    std::fs::remove_dir_all(dir).unwrap();

    let dir = fresh_dir("sqlite-r", base);
    bench_sqlite(&dir, &keys, &payloads, &sample, false).print();
    std::fs::remove_dir_all(dir).unwrap();

    let dir = fresh_dir("redb", base);
    bench_redb(&dir, &keys, &payloads, &sample).print();
    std::fs::remove_dir_all(dir).unwrap();

    let dir = fresh_dir("packed", base);
    bench_packed_log(&dir, &keys, &payloads, &sample).print();
    std::fs::remove_dir_all(dir).unwrap();

    let dir = fresh_dir("mmap", base);
    bench_mmap_snapshot(&dir, &keys, &payloads, &sample).print();
    std::fs::remove_dir_all(dir).unwrap();
}

fn parse_num_list(arg: &str) -> Vec<usize> {
    arg.split(',').map(|s| s.trim().parse().unwrap()).collect()
}

fn main() {
    let mut sizes = vec![8 * 1024, 32 * 1024];
    let mut counts = vec![1000, 5000];
    let mut random = 1000usize;
    let mut base = std::env::temp_dir();
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--sizes" => sizes = parse_num_list(&args.next().unwrap()),
            "--counts" => counts = parse_num_list(&args.next().unwrap()),
            "--random" => random = args.next().unwrap().parse().unwrap(),
            // /tmp 常为 tmpfs(io 计数不上块层,写放大恒 0);盘载口径传
            // 磁盘路径,如 --base-dir /var/tmp/kode-persist-bench。
            "--base-dir" => base = PathBuf::from(args.next().unwrap()),
            other => panic!("unknown arg: {other}"),
        }
    }
    println!(
        "persist format bench(RUST-128/RUST-290):sizes={sizes:?} counts={counts:?} random={random}"
    );
    println!("口径:暖缓存 cold start(非 root 无 drop_caches)/ write_bytes 真实下盘 / LCG 非零 payload / read-all 字节全等闸");
    let mut scenarios = Vec::new();
    for &size in &sizes {
        for &count in &counts {
            scenarios.push(Scenario { size, count });
        }
    }
    println!(
        "base-dir={} fs={}",
        base.display(),
        if base.starts_with("/tmp") {
            "tmpfs?"
        } else {
            "disk"
        }
    );
    for scenario in &scenarios {
        run_scenario(scenario, &base);
    }
}
