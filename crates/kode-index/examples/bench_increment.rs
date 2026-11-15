//! 索引增量/热更新墙钟基准(RUST-102 旧 SYNTAX-006 余项:release 实测,
//! 禁止 debug build 结论)。
//!
//! 运行:`cargo run -p kode-index --release --example bench_increment`
//! 五块:①N 文件首扫全量 ②热更新形态(单文件编辑→增量重建耗时分布)
//! ③同文本零重建证明 ④rename/delete 增量面 ⑤根级失效 vs 单文件增量。
//! 热更新形态=编辑器真实接入形态:文档改一版→update 一次→观测该次墙钟。

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

/// 真实形态实体 def:entity 声明 + Parent + 属性 + 三分面方法。
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
    // 语料:2000 文件,每个 64 属性 + 12 方法;继承链每 8 文件一环。
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

    // ① 首扫全量:update_batch 一次提交
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

    // ② 热更新形态:单文件编辑→update,300 次(每次真实修改文本→必重建),
    //    观测单次增量重建墙钟。这是编辑器接入的稳态交互形态。
    let (hot_key, _) = corpus[0].clone();
    let base_text = &corpus[0].1;
    let mut hot: Vec<u128> = Vec::with_capacity(300);
    for round in 0..300 {
        let mut text = base_text.clone();
        // 真实编辑:改一个属性 flags(第 round 处),文本必变→指纹必失配。
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

    // ③ 同文本零重建:未变文档 update 必 cache-hit(不 bump generation)。
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

    // ④ rename/delete 增量面:remove+update(rename 语义)与纯 remove。
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

    // ⑤ 根级失效 vs 单文件:invalidate_root 全根重扫(2000 文件)必须仍线性可控,
    //    且与首扫同数量级(同一实现路径,无隐藏超线性)。
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

    // ⑥ 巨型单文件:2 万属性 def 首插/重解析(热更新最坏单文件形态)。
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
