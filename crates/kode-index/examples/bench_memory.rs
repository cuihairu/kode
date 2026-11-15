//! 索引内存占用实测(RUST-129 旧 IDX-012:内存索引结构评测)。
//!
//! 目标不是测速,是把「50k 文件内存爆炸」命题落到数字上,并为
//! interning / arena / small vectors 三个候选结构给出实测收益上限:
//!
//! - **分层归因**:`--layer parse`(仅 ParseRegistry:解析树缓存 + 引用正/反表)
//!   与 `--layer full`(完整 SymbolIndex = 解析层 + 符号层)同规模各测一次 RSS,
//!   符号层 = full − parse。
//! - **线性检验**:5k / 10k / 25k / 50k 四档,bytes/file 与 bytes/symbol 应
//!   平稳(爬升 = 有超线性结构)。
//! - **interning 潜力**:`--layer ratio` 小语料实测「名字总字节 / 去重后字节」,
//!   得出符号 name 字符串层 intern 后的可省比例(上限,实际还要扣表结构开销)。
//! - **RSS 口径**:读 /proc/self/status VmRSS(Linux;拿不到则跳过内存面只打
//!   符号计数)。基线在本轮构建**之前**、上一轮 drop **之后**采样,故 delta
//!   是保守下界(分配器可能不把上轮释放页还给 OS);四个档位同进程升序跑,
//!   若 bytes/symbol 出现爬升,用 `--layer`/`--files` 单独重跑该档复核。
//!   RSS 采样时结构必须存活(持引用采,采完才 drop)。
//!
//! 语料形态与 bench_increment 同族:每文件 64 属性 + 12 方法,属性/方法名
//! 全工程共享(贴真实项目 hp/level/onLogin 类高频重名形态),实体名取文件
//! stem 全工程唯一 → 每文件 77 符号,其中重名面占 76。
//!
//! 复现:`cargo run -p kode-index --release --example bench_memory`
//!   (单档:`-- --layer parse|full --files 25000`;只测去重率:`-- --layer ratio`)

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

/// /proc/self/status 的 VmRSS(kB);非 Linux 或读取失败返回 None。
fn rss_kb() -> Option<u64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let line = status.lines().find(|l| l.starts_with("VmRSS:"))?;
    let kb = line["VmRSS:".len()..].trim().split(' ').next()?;
    kb.parse::<u64>().ok()
}

fn rss_label(kb: Option<u64>) -> String {
    kb.map(|v| v.to_string()).unwrap_or_else(|| "n/a".into())
}

/// 仅解析层:ParseRegistry(解析树缓存 + 引用正/反表),不建符号表。
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

/// 完整索引:逐文件喂入(文本即用即弃,避免语料本体驻留污染归因)。
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
    // 结构必须在 RSS 采样时存活(采样后才 drop)。
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

/// 名字去重率(intering 潜力):小语料逐符号收集 name,测「总字节 / 去重字节」。
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
            // 升序扫档:ratio(小语料) → parse/full 各四档。
            name_ratio(1_000, &def_text());
            for files in [5_000usize, 10_000, 25_000, 50_000] {
                run_layer("parse", files);
                run_layer("full", files);
            }
        }
        other => panic!("未知 layer {other}"),
    }
}
