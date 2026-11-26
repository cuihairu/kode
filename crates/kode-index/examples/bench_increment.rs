//! Index increment/hot-update wall-clock benchmark (the RUST-102 leftover of the old
//! SYNTAX-006 item: measured in release, debug build conclusions are forbidden).
//!
//! Run: `cargo run -p kode-index --release --example bench_increment`
//! Five blocks: (1) first full scan of N files (2) the hot-update shape (single-file edit ->
//! incremental rebuild latency distribution) (3) proof of zero rebuilds for identical text
//! (4) the rename/delete increment face (5) root-level invalidation vs single-file increment.
//! The hot-update shape is the real editor integration shape: the document changes one
//! revision -> one update -> observe that update's wall clock.

use std::time::Instant;

use kode_index::SymbolIndex;
use kode_vfs::store::{DocumentKey, RootId};
use kode_vfs::uri::CanonicalUri;

fn percentile(samples: &mut [u128], p: f64) -> u128 {
    samples.sort_unstable();
    let idx = (((samples.len() as f64) * p).ceil() as usize)
        .saturating_sub(1)
        .min(samples.len() - 1);
    samples[idx]
}

/// A real-shape entity def: entity declaration + Parent + properties + three facet methods.
fn gen_entity_def(name: &str, parent: Option<&str>, props: usize) -> String {
    let mut s = format!("<root>\n\t<Entity>\n\t\t<EntityName>{name}</EntityName>\n");
    if let Some(p) = parent {
        s.push_str(&format!("\t\t<Parent>{p}</Parent>\n"));
    }
    s.push_str("\t</Entity>\n\t<Properties>\n");
    for i in 0..props {
        s.push_str(&format!(
            "\t\t<prop{i}>\n\t\t\t<Type>UINT32</Type>\n\t\t\t<Flags>ALL_CLIENTS</Flags>\n\t\t</prop{i}>\n"
        ));
    }
    s.push_str("\t</Properties>\n\t<BaseMethods>\n");
    for i in 0..4 {
        s.push_str(&format!(
            "\t\t<onBase{i}>\n\t\t\t<Arg>UINT32</Arg>\n\t\t\t<Arg>STRING</Arg>\n\t\t\t<Reliable>1</Reliable>\n\t\t</onBase{i}>\n"
        ));
    }
    s.push_str("\t</BaseMethods>\n\t<CellMethods>\n");
    for i in 0..4 {
        s.push_str(&format!(
            "\t\t<onCell{i}>\n\t\t\t<Arg>UINT32</Arg>\n\t\t\t<Reliable>1</Reliable>\n\t\t</onCell{i}>\n"
        ));
    }
    s.push_str("\t</CellMethods>\n\t<ClientMethods>\n");
    for i in 0..4 {
        s.push_str(&format!(
            "\t\t<onClient{i}>\n\t\t\t<Arg>UINT32</Arg>\n\t\t\t<Reliable>1</Reliable>\n\t\t</onClient{i}>\n"
        ));
    }
    s.push_str("\t</ClientMethods>\n</root>\n");
    s
}

fn key(idx: usize) -> DocumentKey {
    DocumentKey::new(
        RootId(1),
        CanonicalUri::from_path(&format!("/bench/entities/Avatar_{idx:04}.def")),
    )
}

fn main() {
    // Corpus: 2000 files, each with 64 properties + 12 methods; the inheritance chain is
    // one link per 8 files.
    let corpus: Vec<(DocumentKey, String)> = (0..2000)
        .map(|i| {
            let parent = if i % 8 == 7 {
                Some(format!("Avatar_{}", i - 7))
            } else {
                None
            };
            (
                key(i),
                gen_entity_def(&format!("Avatar_{i}"), parent.as_deref(), 64),
            )
        })
        .collect();
    let total_bytes: usize = corpus.iter().map(|(_, t)| t.len()).sum();
    println!(
        "== 语料: {} 文件, {} bytes(均 {} bytes/文件) ==",
        corpus.len(),
        total_bytes,
        total_bytes / corpus.len()
    );

    // (1) First full scan: a single update_batch submission
    let mut index = SymbolIndex::new();
    let t0 = Instant::now();
    let batch: Vec<(DocumentKey, String)> =
        corpus.iter().map(|(k, t)| (k.clone(), t.clone())).collect();
    let receipt = index.update_batch(&batch);
    let full = t0.elapsed();
    println!(
        "== 首扫全量: rebuilds={} symbols={} gen={} 总耗时 {:.1}ms,吞吐 {:.1} MB/s ==",
        receipt.rebuilds,
        index.symbol_count(),
        index.generation(),
        full.as_secs_f64() * 1000.0,
        total_bytes as f64 / 1024.0 / 1024.0 / full.as_secs_f64()
    );

    // (2) Hot-update shape: single-file edit -> update, 300 rounds (each round genuinely
    //    modifies the text -> a rebuild is mandatory), observing the wall clock of one
    //    incremental rebuild. This is the steady-state interactive shape of the editor
    //    integration.
    let (hot_key, _) = corpus[0].clone();
    let base_text = &corpus[0].1;
    let mut hot: Vec<u128> = Vec::with_capacity(300);
    for round in 0..300 {
        let mut text = base_text.clone();
        // A genuine edit: change one property's flags (at the `round`th one), so the text
        // must change -> the fingerprint must miss.
        let needle = format!("prop{}", round % 64);
        if let Some(pos) = text.find(&needle) {
            let at = text[pos..]
                .find("ALL_CLIENTS")
                .map(|r| pos + r)
                .unwrap_or(pos);
            text.replace_range(at..at + 11, "ALL_CLIENTS ");
        }
        let t0 = Instant::now();
        let report = index.update(hot_key.clone(), &text);
        let dt = t0.elapsed();
        assert!(report.rebuilt, "热更新 round={round} 必须重建(文本已变)");
        if round >= 5 {
            hot.push(dt.as_micros());
        }
    }
    let n = hot.len();
    println!(
        "== 热更新单文件增量重建: P50={}us P95={}us P99={}us max={}us (n={n}) ==",
        percentile(&mut hot, 0.50),
        percentile(&mut hot, 0.95),
        percentile(&mut hot, 0.99),
        hot.iter().copied().max().unwrap_or(0),
    );

    // (3) Zero rebuilds for identical text: updating an unchanged document must always be a
    // cache hit (no generation bump).
    let gen_before = index.generation();
    let t0 = Instant::now();
    for _ in 0..1000 {
        let report = index.update(corpus[3].0.clone(), &corpus[3].1);
        assert!(!report.rebuilt, "同文本必须零重建");
    }
    let idle = t0.elapsed();
    assert_eq!(index.generation(), gen_before, "零重建不得 bump generation");
    println!(
        "== 同文本零重建: 1000 次 update 全 cache-hit,共 {:.1}ms({:.1}us/次),gen 不变 ==",
        idle.as_secs_f64() * 1000.0,
        idle.as_micros() as f64 / 1000.0
    );

    // (4) The rename/delete increment face: remove+update (rename semantics) and plain remove.
    let t0 = Instant::now();
    for i in 0..50 {
        let k = key(3000 + i);
        assert_eq!(index.remove(&k), 0, "未注册文件 remove 无副作用");
    }
    let remove_miss = t0.elapsed();
    let t0 = Instant::now();
    for i in 0..50 {
        let old = key(4000 + i);
        let text = gen_entity_def(&format!("Renamed_{i}"), None, 16);
        let receipt = index.update_batch(&[(old.clone(), text.clone())]);
        assert_eq!(receipt.rebuilds, 1);
        let new = DocumentKey::new(
            RootId(1),
            CanonicalUri::from_path(&format!("/bench/entities/Renamed_{i}.def")),
        );
        assert!(index.remove(&old) > 0, "rename 前段应移除该文件全部符号");
        let report = index.update(new, &text);
        assert!(report.rebuilt);
    }
    let rename = t0.elapsed();
    println!(
        "== rename(50 次 remove+update): 共 {:.1}ms({:.0}us/次);未注册 remove 50 次共 {:.1}ms ==",
        rename.as_secs_f64() * 1000.0,
        rename.as_micros() as f64 / 50.0,
        remove_miss.as_secs_f64() * 1000.0
    );

    // (5) Root-level invalidation vs single file: invalidate_root rescanning the whole root
    //    (2000 files) must still be linear and controllable, and within the same order of
    //    magnitude as the first scan (the same implementation path, no hidden
    //    super-linearity).
    let t0 = Instant::now();
    let touched = index.invalidate_root(RootId(1));
    let root_inv = t0.elapsed();
    let t1 = Instant::now();
    let receipt = index.update_batch(&batch);
    let rescan = t1.elapsed();
    println!(
        "== 根级失效: invalidate_root 清除 {} 符号({:.1}ms)→全量重扫 {:.1}ms(首扫 {:.1}ms,同路径同量级) ==",
        touched,
        root_inv.as_secs_f64() * 1000.0,
        rescan.as_secs_f64() * 1000.0,
        full.as_secs_f64() * 1000.0
    );
    assert_eq!(receipt.rebuilds, corpus.len() as u64, "根级失效后全量重扫");

    // (6) A giant single file: a def with 20,000 properties, first insertion/reparse (the
    // worst single-file shape for hot updates).
    let mega = gen_entity_def("MEGA", None, 20_000);
    let mega_key = DocumentKey::new(
        RootId(1),
        CanonicalUri::from_path("/bench/entities/MEGA.def"),
    );
    let t0 = Instant::now();
    index.update(mega_key.clone(), &mega);
    let mega_first = t0.elapsed();
    let mut text = mega.clone();
    let at = text.find("ALL_CLIENTS").unwrap_or(0);
    text.replace_range(at..at + 11, "ALL_CLIENTS ");
    let t0 = Instant::now();
    index.update(mega_key, &text);
    let mega_hot = t0.elapsed();
    println!(
        "== 巨型单文件(2 万属性 {} bytes): 首插 {:.1}ms / 热更新重解析 {:.1}ms ==",
        mega.len(),
        mega_first.as_secs_f64() * 1000.0,
        mega_hot.as_secs_f64() * 1000.0
    );
    println!("bench ok");
}
