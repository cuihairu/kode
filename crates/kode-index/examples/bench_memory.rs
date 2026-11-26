//! Measured index memory footprint (RUST-129, old IDX-012: memory index structure evaluation).
//!
//! The goal is not to measure speed but to put numbers on the "50k files memory blowup"
//! proposition, and to give a measured upper bound on the gains of three candidate
//! structures — interning / arena / small vectors:
//!
//! - **Layered attribution**: `--layer parse` (ParseRegistry only: parse tree cache +
//!   reference forward/reverse tables) and `--layer full` (full SymbolIndex = parse layer
//!   + symbol layer) each measure RSS at the same scale, and the symbol layer = full − parse.
//! - **Linearity check**: four tiers 5k / 10k / 25k / 50k; bytes/file and bytes/symbol
//!   should stay flat (a climb = a super-linear structure).
//! - **Interning potential**: `--layer ratio` measures "total name bytes / deduplicated
//!   bytes" on a small corpus, yielding the fraction saved by interning the symbol name
//!   string layer (an upper bound; real savings must further deduct table overhead).
//! - **RSS semantics**: reads VmRSS from /proc/self/status (Linux; if unavailable, skip
//!   the memory face and only print symbol counts). The baseline is sampled **before** this
//!   round's build and **after** the previous round's drop, so the delta is a conservative
//!   lower bound (the allocator may not return the previous round's freed pages to the
//!   OS); the four tiers run ascending in the same process, and if bytes/symbol climbs,
//!   rerun that tier alone with `--layer`/`--files` to cross-check.
//!   The structure must stay alive while RSS is sampled (sample while holding a reference,
//!   drop only afterwards).
//!
//! The corpus shape is the same family as bench_increment: 64 properties + 12 methods per
//! file, with property/method names shared project-wide (mirroring the high-frequency
//! same-name shape of real projects like hp/level/onLogin), and the entity name taken from
//! the file stem is project-wide unique -> 77 symbols per file, of which 76 are on the
//! same-name face.
//!
//! Reproduce: `cargo run -p kode-index --release --example bench_memory`
//!   (single tier: `-- --layer parse|full --files 25000`; dedup rate only: `-- --layer ratio`)

use kode_index::{DocumentKey, RootId, SymbolIndex};
use kode_parser::dep::ParseRegistry;
use kode_vfs::uri::CanonicalUri;

const PROPS: usize = 64;
const METHODS: usize = 12;
const SYMBOLS_PER_FILE: usize = 1 + PROPS + METHODS;

fn key(i: usize) -> DocumentKey {
    DocumentKey::new(
        RootId(1),
        CanonicalUri::from_path(&format!("/proj/entities/E{i}.def")),
    )
}

fn def_text() -> String {
    let mut s = String::from("<root>\n  <Properties>\n");
    for i in 0..PROPS {
        s.push_str(&format!(
            "    <prop{i}>\n      <Type>UINT32</Type>\n      <Flags>BASE</Flags>\n    </prop{i}>\n"
        ));
    }
    s.push_str("  </Properties>\n  <BaseMethods>\n");
    for i in 0..METHODS {
        s.push_str(&format!(
            "    <m{i}>\n      <Arg>UINT32</Arg>\n    </m{i}>\n"
        ));
    }
    s.push_str("  </BaseMethods>\n</root>\n");
    s
}

/// VmRSS (kB) from /proc/self/status; returns None on non-Linux or a read failure.
fn rss_kb() -> Option<u64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let line = status.lines().find(|l| l.starts_with("VmRSS:"))?;
    let kb = line["VmRSS:".len()..].trim().split(' ').next()?;
    kb.parse::<u64>().ok()
}

fn rss_label(kb: Option<u64>) -> String {
    kb.map(|v| v.to_string()).unwrap_or_else(|| "n/a".into())
}

/// Parse layer only: ParseRegistry (parse tree cache + reference forward/reverse tables),
/// without building the symbol table.
fn feed_parse(files: usize, text: &str) -> ParseRegistry {
    let mut registry = ParseRegistry::new();
    for i in 0..files {
        let _ = registry.update(key(i), text);
    }
    assert_eq!(
        registry.stats.rebuilds, files as u64,
        "每个文件必须真实重建"
    );
    println!(
        "MEM layer=parse files={files} rebuilds={}",
        registry.stats.rebuilds
    );
    registry
}

/// Full index: fed in file by file (text is used and discarded immediately, so the corpus
/// body itself does not stay resident and pollute the attribution).
fn feed_full(files: usize, text: &str) -> SymbolIndex {
    let mut index = SymbolIndex::new();
    let mut added_total = 0usize;
    for i in 0..files {
        let report = index.update(key(i), text);
        added_total += report.added;
    }
    assert_eq!(index.stats.rebuilds, files as u64, "每个文件必须真实重建");
    assert_eq!(
        added_total,
        files * SYMBOLS_PER_FILE,
        "每文件必须产出 77 符号(实体 1 + 属性 64 + 方法 12)"
    );
    println!(
        "MEM layer=full files={files} symbols={added_total} rebuilds={}",
        index.stats.rebuilds
    );
    index
}

fn run_layer(layer: &str, files: usize) {
    let text = def_text();
    let before = rss_kb();
    // The structure must still be alive when RSS is sampled (drop only after sampling).
    let after = match layer {
        "parse" => {
            let registry = feed_parse(files, &text);
            let after = rss_kb();
            drop(registry);
            after
        }
        _ => {
            let index = feed_full(files, &text);
            let after = rss_kb();
            drop(index);
            after
        }
    };
    match (before, after) {
        (Some(before), Some(after)) => {
            let delta = after.saturating_sub(before);
            println!(
                "MEM-RSS layer={layer} files={files} before_kb={} after_kb={after} delta_kb={delta} bytes_per_file={}",
                before,
                delta * 1024 / files.max(1) as u64
            );
        }
        _ => println!(
            "MEM-RSS layer={layer} files={files} before_kb={} after_kb={} delta_kb=n/a",
            rss_label(before),
            rss_label(after)
        ),
    }
}

/// Name deduplication rate (interning potential): collect name symbol by symbol on a small
/// corpus and measure "total bytes / deduplicated bytes".
fn name_ratio(files: usize, text: &str) {
    let mut index = SymbolIndex::new();
    for i in 0..files {
        index.update(key(i), text);
    }
    let mut total_names = 0usize;
    let mut total_bytes = 0usize;
    let mut unique = std::collections::HashSet::new();
    let mut unique_bytes = 0usize;
    for i in 0..files {
        for symbol in index.symbols_in_file(&key(i)) {
            total_names += 1;
            total_bytes += symbol.name.len();
            if unique.insert(symbol.name.clone()) {
                unique_bytes += symbol.name.len();
            }
        }
    }
    let ratio = if total_bytes > 0 {
        total_bytes as f64 / unique_bytes.max(1) as f64
    } else {
        0.0
    };
    println!(
        "MEM layer=ratio files={files} symbols={total_names} name_bytes_total={total_bytes} \
name_bytes_unique={unique_bytes} interning_upper_bound={ratio:.2}x"
    );
}

fn main() {
    let mut layer = String::from("all");
    let mut files_arg: Option<usize> = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--layer" => layer = args.next().unwrap_or_else(|| "all".into()),
            "--files" => {
                files_arg = args.next().and_then(|v| v.parse::<usize>().ok());
            }
            other => panic!("未知参数 {other}(支持 --layer parse|full|ratio|all 与 --files N)"),
        }
    }

    match layer.as_str() {
        "ratio" => name_ratio(files_arg.unwrap_or(1_000), &def_text()),
        "parse" | "full" => run_layer(&layer, files_arg.unwrap_or(50_000)),
        "all" => {
            // Ascending tier sweep: ratio (small corpus) -> parse/full four tiers each.
            name_ratio(1_000, &def_text());
            for files in [5_000usize, 10_000, 25_000, 50_000] {
                run_layer("parse", files);
                run_layer("full", files);
            }
        }
        other => panic!("未知 layer {other}"),
    }
}
