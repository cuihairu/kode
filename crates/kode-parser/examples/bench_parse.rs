//! 解析基准(SYNTAX-006:release 实测,禁止 debug 结论)。
//!
//! 运行:`cargo run -p kode-parser --release --example bench_parse`
//! 三块:①fixture 语料逐文件延迟(P50/P95/max);②合成大样本吞吐
//! (2k 文件 + 5MB 巨型 def);③增量注册表零重建验证(同内容二扫)。

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Instant;

use kode_parser::dep::{key_for, ParseRegistry};
use kode_parser::json::collect_corpus;
use kode_parser::model::parse_def;
use kode_vfs::store::RootId;

fn percentile(samples: &mut [u128], p: f64) -> u128 {
    samples.sort_unstable();
    let idx = (((samples.len() as f64) * p).ceil() as usize)
        .saturating_sub(1)
        .min(samples.len() - 1);
    samples[idx]
}

fn gen_def(name: &str, props: usize) -> String {
    let mut s = String::from("<root>\n\t<Properties>\n");
    for i in 0..props {
        s.push_str(&format!(
            "\t<p{i}>\n\t\t<Type> UINT32 </Type>\n\t\t<Flags> ALL_CLIENTS </Flags>\n\t</p{i}>\n"
        ));
    }
    let _ = name;
    s.push_str("\t</Properties>\n</root>\n");
    s
}

fn main() {
    let repo_root: PathBuf = std::env::args()
        .nth(1)
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::Path::new(".").to_path_buf());
    let corpus: Vec<(String, String)> =
        collect_corpus(&repo_root, kode_parser::json::PARITY_CORPORA)
            .into_iter()
            .map(|(k, (_, v))| (k, v))
            .collect();
    let total_bytes: usize = corpus.iter().map(|(_, t)| t.len()).sum();
    println!(
        "== fixture 语料: {} 文件, {} bytes ==",
        corpus.len(),
        total_bytes
    );

    // ① 逐文件延迟(50 轮取稳态)
    let mut per_file: BTreeMap<String, u128> = BTreeMap::new();
    let mut all: Vec<u128> = Vec::new();
    for round in 0..50 {
        for (path, text) in &corpus {
            let t0 = Instant::now();
            let def = parse_def(text);
            let dt = t0.elapsed().as_micros();
            std::hint::black_box(&def);
            if round >= 5 {
                all.push(dt);
                *per_file.entry(path.clone()).or_insert(0) =
                    dt.max(per_file.get(path).copied().unwrap_or(0));
            }
        }
    }
    let n = all.len();
    println!(
        "解析延迟(us): P50={} P95={} P99={} max={} (n={n})",
        percentile(&mut all, 0.50),
        percentile(&mut all, 0.95),
        percentile(&mut all, 0.99),
        all.iter().copied().max().unwrap_or(0),
    );
    let mut worst: Vec<_> = per_file.iter().collect();
    worst.sort_by_key(|(_, v)| **v);
    for (p, v) in worst.iter().rev().take(3) {
        println!("  最慢: {v}us {p}");
    }

    // ② 合成大样本:2000 文件 × 64 属性 + 单个 2 万属性巨型 def
    let mut big = String::new();
    for i in 0..2000 {
        big.push_str(&gen_def(&format!("E{i}"), 64));
    }
    let mega = gen_def("MEGA", 20_000);
    let big_bytes = big.len() + mega.len();
    let t0 = Instant::now();
    let mut parsed = 0usize;
    for chunk in big.split("<root>") {
        if chunk.len() < 10 {
            continue;
        }
        let text = format!("<root>{chunk}");
        std::hint::black_box(parse_def(&text));
        parsed += 1;
    }
    std::hint::black_box(parse_def(&mega));
    parsed += 1;
    let dt = t0.elapsed();
    println!(
        "== 大样本: {parsed} 文件 {big_bytes} bytes,总耗时 {:.1}ms,吞吐 {:.1} MB/s ==",
        dt.as_secs_f64() * 1000.0,
        big_bytes as f64 / 1024.0 / 1024.0 / dt.as_secs_f64()
    );

    // ③ 增量注册表:全语料两遍,第二遍必须零重建
    let mut reg = ParseRegistry::new();
    let t0 = Instant::now();
    for i in 0..2 {
        for (idx, (_, text)) in corpus.iter().enumerate() {
            let k = key_for(RootId(7), &format!("/bench/f{idx}.def"));
            let _ = reg.update(k, text);
        }
        if i == 0 {
            assert_eq!(reg.stats.rebuilds as usize, corpus.len());
        }
    }
    let dt = t0.elapsed();
    assert_eq!(
        reg.stats.rebuilds as usize,
        corpus.len(),
        "第二遍必须零重建"
    );
    assert_eq!(reg.stats.cache_hits as usize, corpus.len());
    println!(
        "== 增量: 首扫重建 {} 文件,二扫零重建(cache_hits={}),双扫共 {:.1}ms ==",
        reg.stats.rebuilds,
        reg.stats.cache_hits,
        dt.as_secs_f64() * 1000.0
    );
    println!("bench ok");
}
