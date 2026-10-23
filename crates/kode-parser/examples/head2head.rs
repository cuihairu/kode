//! parser 级 TS↔Rust head-to-head 基准(ARCH-012 解禁后对照口径,docs/perf/2026-parser-head2head.md)。
//!
//! 与 scripts/parser-head2head-ts.mjs 同语料同口径(全量/单文件/增量三口径 + VmHWM):
//! 运行:`cargo run -p kode-parser --release --example head2head -- <corpus_dir> [<corpus_dir>...]"
//! 语料收集规则与 json::collect_corpus 一致(*.def + entities/types/alias.xml,排序遍历)。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Instant;

use kode_parser::dep::{key_for, ParseRegistry};
use kode_parser::model::{parse_alias, parse_def, parse_entities, parse_types};
use kode_vfs::parse_cache::content_fingerprint;
use kode_vfs::store::RootId;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Def,
    Entities,
    Types,
    Alias,
}

fn kind_of(name: &str) -> Option<Kind> {
    if name.ends_with(".def") {
        Some(Kind::Def)
    } else if name == "entities.xml" {
        Some(Kind::Entities)
    } else if name == "types.xml" {
        Some(Kind::Types)
    } else if name == "alias.xml" {
        Some(Kind::Alias)
    } else {
        None
    }
}

/// 与 kode_parser::json::collect_corpus 同规则:排序遍历、种类按文件名、读为 UTF-8 文本。
fn collect(dir: &Path, rel_prefix: &str, out: &mut BTreeMap<String, (Kind, String)>) {
    let mut entries: Vec<PathBuf> = match std::fs::read_dir(dir) {
        Ok(rd) => rd.filter_map(|e| e.ok()).map(|e| e.path()).collect(),
        Err(_) => return,
    };
    entries.sort();
    for path in entries {
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default();
        let rel = format!("{rel_prefix}/{name}");
        if path.is_dir() {
            collect(&path, &rel, out);
            continue;
        }
        let Some(kind) = kind_of(name) else { continue };
        if let Ok(text) = std::fs::read_to_string(&path) {
            out.insert(rel, (kind, text));
        }
    }
}

fn parse_once(kind: Kind, text: &str) {
    match kind {
        Kind::Def => {
            std::hint::black_box(parse_def(text));
        }
        Kind::Entities => {
            std::hint::black_box(parse_entities(text));
        }
        Kind::Types => {
            std::hint::black_box(parse_types(text));
        }
        Kind::Alias => {
            std::hint::black_box(parse_alias(text));
        }
    }
}

fn percentile(samples: &mut [u128], p: f64) -> u128 {
    if samples.is_empty() {
        return 0;
    }
    samples.sort_unstable();
    let idx = (((samples.len() as f64) * p).ceil() as usize)
        .saturating_sub(1)
        .min(samples.len() - 1);
    samples[idx]
}

fn median_f64(samples: &[f64]) -> f64 {
    if samples.is_empty() {
        return 0.0;
    }
    let mut v = samples.to_vec();
    v.sort_by(|a, b| a.total_cmp(b));
    v[v.len() / 2]
}

fn vm_hwm_kib() -> u64 {
    std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|s| {
            s.lines()
                .find(|l| l.starts_with("VmHWM:"))
                .and_then(|l| l.split_whitespace().nth(1).and_then(|v| v.parse::<u64>().ok()))
        })
        .unwrap_or(0)
}

fn main() {
    let corpora: Vec<String> = std::env::args().skip(1).collect();
    assert!(!corpora.is_empty(), "usage: head2head <corpus_dir> [...]");
    let mut files: BTreeMap<String, (Kind, String)> = BTreeMap::new();
    for dir in &corpora {
        let root = Path::new(dir);
        let label = root.file_name().and_then(|n| n.to_str()).unwrap_or(dir);
        collect(root, label, &mut files);
    }
    let total_bytes: usize = files.values().map(|(_, t)| t.len()).sum();
    println!(
        "H2H files={} bytes={} corpora={}",
        files.len(),
        total_bytes,
        corpora.join(",")
    );

    if files.is_empty() {
        eprintln!("H2H: empty corpus (no *.def / entities.xml / types.xml / alias.xml)");
        std::process::exit(2);
    }

    // ① 全量口径:整册逐文件解析,20 轮(前 2 轮预热不计),吞吐取中位轮。
    let full_rounds_ms: Vec<f64> = {
        let mut rounds = Vec::new();
        for round in 0..20 {
            let t0 = Instant::now();
            for (kind, text) in files.values() {
                parse_once(*kind, text);
            }
            let ms = t0.elapsed().as_secs_f64() * 1000.0;
            if round >= 2 {
                rounds.push(ms);
            }
        }
        rounds
    };
    let mut sorted_rounds = full_rounds_ms.clone();
    sorted_rounds.sort_by(|a, b| a.total_cmp(b));
    let median = sorted_rounds[sorted_rounds.len() / 2];
    println!(
        "FULL rounds={} median_ms={median:.3} min_ms={:.3} max_ms={:.3} throughput_MBps={:.2}",
        full_rounds_ms.len(),
        sorted_rounds.first().copied().unwrap_or(0.0),
        sorted_rounds.last().copied().unwrap_or(0.0),
        total_bytes as f64 / 1024.0 / 1024.0 * 1000.0 / median,
    );

    // 语义面校验:两侧同一 .def 语料必须数出同样的 props/methods(防「少干活所以快」)。
    let mut nprops = 0usize;
    let mut nmethods = 0usize;
    for (kind, text) in files.values() {
        if *kind == Kind::Def {
            let d = parse_def(text);
            nprops += d.properties.len();
            nmethods += d.base_methods.len() + d.cell_methods.len() + d.client_methods.len();
        }
    }
    println!("SURFACE props={nprops} methods={nmethods}");

    // ② 单文件口径:30 轮(前 3 轮预热),全部逐文件样本进分布;另留每文件最小值。
    let mut all: Vec<u128> = Vec::new();
    let mut per_file_median: BTreeMap<String, u128> = BTreeMap::new();
    for round in 0..30 {
        for (path, (kind, text)) in &files {
            let t0 = Instant::now();
            parse_once(*kind, text);
            let us = t0.elapsed().as_micros();
            if round >= 3 {
                all.push(us);
                let e = per_file_median.entry(path.clone()).or_default();
                *e = if *e == 0 { us } else { (*e).min(us) };
            }
        }
    }
    let p50 = percentile(&mut all, 0.50);
    let p95 = percentile(&mut all, 0.95);
    let p99 = percentile(&mut all, 0.99);
    let max = all.iter().copied().max().unwrap_or(0);
    println!(
        "SINGLE n={} P50_us={p50} P95_us={p95} P99_us={p99} max_us={max}",
        all.len()
    );
    let mut worst: Vec<_> = per_file_median.iter().collect();
    worst.sort_by_key(|(_, v)| **v);
    for (p, v) in worst.iter().rev().take(3) {
        println!("SLOWEST min_us={v} file={p}");
    }

    // ③ 增量口径:ParseRegistry 两扫 × 5 次重复(每次新注册表),首扫全 rebuild,二扫零重建;
    //    fp_only 只跑内容指纹(不解析),用于把指纹成本与解析成本拆开。
    let keys: Vec<(String, _)> = files
        .keys()
        .cloned()
        .map(|rel| (rel.clone(), key_for(RootId(7), &format!("/h2h/{rel}"))))
        .collect();
    let mut scan1s: Vec<f64> = Vec::new();
    let mut scan2s: Vec<f64> = Vec::new();
    let mut fponly: Vec<f64> = Vec::new();
    for _ in 0..5 {
        let t0 = Instant::now();
        for (rel, _) in &keys {
            std::hint::black_box(content_fingerprint(&files[rel].1));
        }
        fponly.push(t0.elapsed().as_secs_f64() * 1000.0);

        let mut reg = ParseRegistry::new();
        let t0 = Instant::now();
        for (rel, key) in &keys {
            let (report, unit) = reg.update(key.clone(), &files[rel].1);
            assert!(report.rebuilt && unit.is_some(), "首扫必须重建: {rel}");
        }
        scan1s.push(t0.elapsed().as_secs_f64() * 1000.0);
        assert_eq!(reg.stats.rebuilds as usize, files.len());

        let t0 = Instant::now();
        for (rel, key) in &keys {
            let (report, unit) = reg.update(key.clone(), &files[rel].1);
            assert!(!report.rebuilt && unit.is_some(), "二扫必须零重建: {rel}");
        }
        scan2s.push(t0.elapsed().as_secs_f64() * 1000.0);
        assert_eq!(reg.stats.cache_hits as usize, files.len());
    }
    println!(
        "INCR repeats=5 scan1_rebuilds={} scan2_rebuilds=0 scan2_cache_hits={} scan1_ms={:.3} scan2_ms={:.3} fp_only_ms={:.3}",
        files.len(),
        files.len(),
        median_f64(&scan1s),
        median_f64(&scan2s),
        median_f64(&fponly),
    );

    println!("MEM vmhwm_kib={}", vm_hwm_kib());
    println!("bench ok");
}
